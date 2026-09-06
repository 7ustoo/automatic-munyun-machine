// Read the rendered search grid, including company-card carousels. Never use
// account actions here: inspecting a candidate must not consume it.
export async function readGroupedPage(page, extract, onRows = () => {}) {
  const rows = new Map();
  const read = async () => {
    const extracted = await page.evaluate(extract);
    for (const row of extracted) rows.set(row.href, row);
    onRows(extracted);
  };
  await read();
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
      advanced = true;
    }
    if (!advanced) return [...rows.values()];
  }
  throw new Error('grouped-card safety limit reached');
}

export async function crawlSearch({ page, url, extract, maxPages = 300, checkpoint = () => {}, log = () => {} }) {
  const rows = new Map();
  const coverage = { pages: 0, complete: false, reason: '', nextPage: 0 };
  const signatures = new Set();
  for (let index = 0; index < maxPages; index++) {
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const target = new URL(url);
        target.searchParams.set('page', String(index));
        await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
        const signature = base.map(r => r.href).sort().join('\n');
        if (index && (!base.length || signatures.has(signature))) throw new Error('page repeated or unexpectedly empty');
        const grouped = await readGroupedPage(page, extract, partial => {
          for (const r of partial) rows.set(r.href, r);
        });
        const next = page.locator('a[aria-label*="next" i], button[aria-label*="next" i]').first();
        let hasNext = false;
        for (let check = 0; check < 5; check++) {
          hasNext = await next.isVisible().catch(() => false) && await next.isEnabled().catch(() => false)
            && await next.getAttribute('aria-disabled') !== 'true';
          if (hasNext) break;
          if (check < 4) await page.waitForTimeout(1200 * (check + 1));
        }
        result = { grouped, signature, hasNext };
        break;
      } catch (e) {
        coverage.reason = `page ${index + 1}: ${String(e.message).split('\n')[0]}`;
        log(`  retry ${attempt}/3 — ${coverage.reason}`);
      }
    }
    if (!result) break;
    signatures.add(result.signature);
    for (const r of result.grouped) rows.set(r.href, r);
    coverage.pages++;
    coverage.nextPage = index + 1;
    coverage.reason = result.hasNext ? 'page safety limit reached' : 'end of results';
    coverage.complete = !result.hasNext;
    await checkpoint({ ...coverage, jobs: rows.size });
    log(`  page ${index + 1}: ${result.grouped.length} jobs including grouped cards (${rows.size} unique)`);
    if (coverage.complete) break;
  }
  await checkpoint({ ...coverage, jobs: rows.size });
  return { rows: [...rows.values()], coverage };
}
