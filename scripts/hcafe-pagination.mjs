import { retryDelayMs } from './hcafe-apply-links.mjs';

// Read the rendered search grid, including company-card carousels. Never use
// account actions here: inspecting a candidate must not consume it.
export async function readGroupedPage(page, extract, onRows = () => {}, shouldStop = () => false, expandGroups = true) {
  const rows = new Map();
  const read = async () => {
    const extracted = await page.evaluate(extract);
    for (const row of extracted) rows.set(row.href, row);
    onRows(extracted);
  };
  await read();
  if (shouldStop() || !expandGroups) return [...rows.values()];
  const arrows = page.locator('.bg-white.rounded-xl button:not([data-testid]):has(svg path[d="m8.25 4.5 7.5 7.5-7.5 7.5"])');
  for (let turn = 0; turn < 1000; turn++) {
    let advanced = false;
    for (let i = 0, n = await arrows.count(); i < n; i++) {
      const arrow = arrows.nth(i);
      if (!await arrow.isEnabled() || !await arrow.isVisible()) continue;
      const before = await page.evaluate(extract);
      await arrow.click({ timeout: 10000 });
      await page.waitForFunction(({ before }) => {
        const now = [...document.querySelectorAll('a[href^="/job/"]')].map(a => a.href);
        return now.some(h => !before.includes(h));
      }, { before: before.map(r => r.href) }, { timeout: 15000 });
      await read();
      if (shouldStop()) return [...rows.values()];
      advanced = true;
    }
    if (!advanced) return [...rows.values()];
  }
  throw new Error('grouped-card safety limit reached');
}

// Select a result-page URL, never a company carousel's "Next job" button.
// Numbered links also work when the site omits its dedicated Next page link.
export function selectNextSearchUrl(links, currentUrl, index) {
  const current = new URL(currentUrl);
  const candidates = [];
  for (const link of links || []) {
    if (link.disabled || !(/^next page$/i.test(link.label || '') || /^\d+$/.test(link.text || '') || link.rel === 'next')) continue;
    try {
      const target = new URL(link.href, current);
      if (target.protocol !== 'https:' || !['hiring.cafe', 'hiringcafe.com'].includes(target.hostname)
        || !['/', '/classic'].includes(target.pathname)
        || target.searchParams.get('searchState') !== current.searchParams.get('searchState')
        || Number(target.searchParams.get('page') || 0) !== index + 1) continue;
      candidates.push({ href: target.href, explicit: /^next page$/i.test(link.label || '') || link.rel === 'next' });
    } catch { /* Ignore malformed navigation. */ }
  }
  return candidates.find(c => c.explicit)?.href || candidates[0]?.href || '';
}

export async function readSearchNavigation(page, currentUrl, index) {
  const info = await page.evaluate(() => {
    const text = document.body.innerText;
    const count = /([\d,]+)\s+jobs\b/i.exec(text);
    const controls = [...document.querySelectorAll('a[href], button[aria-label="Next page" i]')];
    return {
      total: count ? Number(count[1].replace(/,/g, '')) : null,
      empty: /no jobs found|no results found/i.test(text),
      nextDisabled: controls.some(e => /^next page$/i.test(e.getAttribute('aria-label') || '')
        && (e.disabled || e.getAttribute('aria-disabled') === 'true')),
      links: controls.map(e => ({ href: e.getAttribute('href'), text: e.innerText.trim(),
        label: e.getAttribute('aria-label'), rel: e.getAttribute('rel'),
        disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true' })),
    };
  });
  return { ...info, nextUrl: selectNextSearchUrl(info.links, currentUrl, index) };
}

export async function crawlSearch({ page, url, extract, maxPages = 300, targetJobs = Infinity,
  jobKey = row => row.href, processPageRows = async () => {}, targetCount = null,
  expandGroups = true,
  beforeRequest = async () => {}, onThrottle = ms => page.waitForTimeout(ms),
  checkpoint = () => {}, log = () => {} }) {
  const rows = new Map();
  const coverage = { pages: 0, complete: false, targetReached: false, reason: '', nextPage: 0 };
  const signatures = new Set();
  let nextUrl = new URL(url);
  nextUrl.searchParams.set('page', '0');
  const addRows = partial => {
    for (const row of partial) {
      const key = jobKey(row);
      if (key) rows.set(key, row);
    }
  };
  const reachedTarget = () => (targetCount ? targetCount() : rows.size) >= targetJobs;
  for (let index = 0; index < maxPages; index++) {
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const target = new URL(nextUrl);
        await beforeRequest();
        const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if ([429, 503].includes(response?.status())) {
          await onThrottle(retryDelayMs(response.headers()['retry-after']));
          throw new Error(`search page HTTP ${response.status()}; waiting before retry`);
        }
        await page.waitForFunction(() => document.querySelector('a[href^="/job/"]')
          || /no jobs found|no results found/i.test(document.body.innerText), null, { timeout: 20000 });
        // Wait for the grid to stabilize, not just for its first card.
        let previous = '', stable = 0;
        for (let poll = 0; poll < 24; poll++) {
          const current = (await page.evaluate(extract)).map(r => r.href).join('\n');
          stable = current === previous ? stable + 1 : 0;
          previous = current;
          if (stable >= 3) break;
          await page.waitForTimeout(500);
          if (poll === 23) throw new Error('grid did not settle');
        }
        const base = await page.evaluate(extract);
        const signature = base.map(jobKey).filter(Boolean).sort().join('\n');
        if (index && (!base.length || signatures.has(signature))) throw new Error('page repeated or unexpectedly empty');
        const grouped = await readGroupedPage(page, extract, addRows, reachedTarget,
          typeof expandGroups === 'function' ? expandGroups(base) : expandGroups);
        await processPageRows(grouped);
        let navigation;
        for (let check = 0; check < 5; check++) {
          navigation = await readSearchNavigation(page, target.href, index);
          if (navigation.total !== null) coverage.reportedTotal = navigation.total;
          const exhausted = navigation.empty || (navigation.total !== null && rows.size >= navigation.total)
            || (navigation.nextDisabled && navigation.total === null);
          if (reachedTarget() || navigation.nextUrl || exhausted) {
            result = { grouped, signature, nextUrl: navigation.nextUrl, exhausted, targetReached: reachedTarget() };
            break;
          }
          if (check < 4) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1200 * (check + 1));
          }
        }
        if (!result) throw new Error('result-page navigation unavailable; end of results not verified');
        break;
      } catch (e) {
        coverage.reason = `page ${index + 1}: ${String(e.message).split('\n')[0]}`;
        log(`  retry ${attempt}/3 — ${coverage.reason}`);
      }
    }
    if (!result) break;
    signatures.add(result.signature);
    coverage.pages++;
    coverage.nextPage = result.targetReached ? index : index + 1;
    coverage.targetReached = result.targetReached;
    coverage.reason = result.targetReached ? 'requested job count reached'
      : result.nextUrl ? 'page safety limit reached' : 'end of results';
    coverage.complete = result.exhausted && !result.nextUrl;
    await checkpoint({ ...coverage, jobs: rows.size });
    log(`  page ${index + 1}: ${result.grouped.length} jobs including grouped cards (${rows.size} unique)`);
    if (coverage.complete || coverage.targetReached) break;
    nextUrl = new URL(result.nextUrl);
  }
  await checkpoint({ ...coverage, jobs: rows.size });
  return { rows: [...rows.values()], coverage };
}
