import { keywordListingUrl, readJobApplyLink, createRequestPacer, retryDelayMs } from './hcafe-apply-links.mjs';

// Read only HiringCafe's requested posting. Search-card summaries are not JDs.
export async function readHiringCafeDescription(page, href, { beforeRequest = async () => {}, onThrottle = () => {} } = {}) {
  const url = keywordListingUrl(href);
  if (!url) throw new Error('HiringCafe listing link unavailable.');
  await beforeRequest();
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  if ([429, 503].includes(response?.status())) {
    onThrottle(retryDelayMs(response.headers()['retry-after']));
    throw new Error('HiringCafe asked us to slow down; description not collected.');
  }
  if (response && !response.ok()) throw new Error(`HiringCafe description unavailable (HTTP ${response.status()}).`);
  const link = await readJobApplyLink(page);
  if (link.status === 'expired') throw new Error('HiringCafe posting has expired.');
  await page.locator('#job-description').waitFor({ timeout: 6000 });
  const jdText = (await page.locator('#job-description').innerText()).trim().slice(0, 40000);
  if (!jdText) throw new Error('Full HiringCafe description unavailable.');
  return { jdText, directUrl: link.directUrl, descriptionQuality: 'full' };
}

export function collectedDescription(row) {
  return row?.descriptionQuality === 'full' || row?.__descriptionComplete
    ? String(row.description || row.jdText || row.__jd || '').trim().slice(0, 40000) : '';
}

// Reuse cached text, then read missing descriptions with a bounded browser pool.
// Collection never follows the employer link and never drops a job on JD failure.
export function createHiringCafeDescriptionCollector({ context, cache = {}, concurrency = 4,
  pacer = createRequestPacer({ intervalMs: 1200 }), read = readHiringCafeDescription,
  checkpoint = () => {}, log = () => {} }) {
  const stats = { full: 0, cached: 0, unavailable: 0, pending: 0 };
  let pool, throttled = false;
  const attach = (row, text) => Object.assign(row, { description: text, jdText: text,
    descriptionQuality: 'full', __descriptionComplete: true, descriptionError: '' });
  async function collect(rows, { fetchMissing = true } = {}) {
    const missing = [];
    for (const row of rows) {
      const text = collectedDescription(row);
      const listing = keywordListingUrl(row.viewjobUrl || row.href);
      const cached = cache[listing];
      if (text) { attach(row, text); stats.full++; }
      else if (cached?.jdText && cached.descriptionQuality === 'full' && Date.now() - cached.at < 86400000
        && (!cached.sourceVersion || !row.sourceVersion || cached.sourceVersion === row.sourceVersion)) {
        attach(row, cached.jdText); stats.cached++; stats.full++;
      } else if (listing && fetchMissing) missing.push({ row, listing });
      else if (listing) {
        row.descriptionQuality = 'missing'; row.descriptionError = 'Description queued for background loading.'; stats.pending++;
      }
      else { row.descriptionQuality = 'missing'; row.descriptionError = 'HiringCafe listing link unavailable.'; stats.unavailable++; }
    }
    if (missing.length) {
      pool ||= await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency, missing.length)) }, () => context.newPage()));
      let cursor = 0;
      await Promise.all(pool.map(async page => {
        while (cursor < missing.length) {
          const { row, listing } = missing[cursor++];
          try {
            if (throttled) throw new Error('HiringCafe rate limit interrupted description collection.');
            const result = await read(page, listing, { beforeRequest: pacer.wait,
              onThrottle: ms => { throttled = true; pacer.pause(ms); } });
            if (!result?.jdText || result.descriptionQuality !== 'full') throw new Error('Full HiringCafe description unavailable.');
            attach(row, result.jdText); stats.full++;
            cache[listing] = { ...result, sourceVersion: row.sourceVersion || '', at: Date.now() };
          } catch (error) {
            row.descriptionQuality = 'missing'; row.descriptionError = String(error.message).slice(0, 180); stats.unavailable++;
          }
        }
      }));
    }
    for (const key of Object.keys(cache)) if (!cache[key]?.jdText || Date.now() - cache[key].at >= 86400000) delete cache[key];
    for (const key of Object.keys(cache).slice(0, -5000)) delete cache[key];
    await checkpoint(cache);
    log(`  HiringCafe descriptions: ${stats.full} saved (${stats.cached} reused), ${stats.pending} pending, ${stats.unavailable} unavailable.`);
  }
  return { collect, stats, async close() { if (pool) await Promise.all(pool.map(page => page.close().catch(() => {}))); } };
}
