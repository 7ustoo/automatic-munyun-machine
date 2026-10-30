import { isIP } from 'node:net';

export function keywordListingUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['hiring.cafe', 'hiringcafe.com'].includes(url.hostname)
      || !/^\/job\/[^/]+\/?$/.test(url.pathname)) return '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.href;
  } catch { return ''; }
}

export function keywordListingKey(row) {
  const href = keywordListingUrl(row?.href);
  return href ? new URL(href).pathname : '';
}

export function keywordCandidateKey(row) {
  return row?.embeddedApplyLink && typeof row.sourceId === 'string' && row.sourceId
    ? `hcafe:${row.sourceId}` : keywordListingKey(row);
}

// The public SSR search response includes the same employer apply_url as the
// detail page. Read actual result records only, excluding recommendations and
// alternate-location metadata nested inside an individual job.
export function embeddedSearchJobs(data) {
  const hits = data?.props?.pageProps?.ssrHits;
  if (!hits || typeof hits !== 'object') return null;
  const jobs = new Map();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.id && value.job_information && Object.hasOwn(value, 'apply_url')) {
      const info = value.job_information, processed = value.v5_processed_job_data || {};
      const directUrl = typeof value.apply_url === 'string' ? value.apply_url : '';
      jobs.set(String(value.id), { sourceId: String(value.id), source: 'hcafe', embeddedApplyLink: true,
        expired: value.is_expired === true, directUrl, href: directUrl || `hcafe-source:${value.id}`,
        title: String(info.title || processed.core_job_title || ''),
        company: String(processed.company_name || value.enriched_company_data?.name || ''),
        location: String(processed.formatted_workplace_location || ''), yoe: processed.min_industry_and_role_yoe ?? null });
      return;
    }
    for (const item of Object.values(value)) if (item && typeof item === 'object') visit(item);
  }
  visit(hits);
  return [...jobs.values()];
}

export function keywordSearchExtractor(fallback) {
  return `(() => {
    let data;
    try { data = JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || 'null'); } catch {}
    const rows = (${embeddedSearchJobs.toString()})(data);
    return rows?.length ? rows : (${fallback});
  })()`;
}

export function directApplyUrl(value) {
  if (typeof value !== 'string' || /[\s<>"'\\]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || /(^|\.)(hiring\.cafe|hiringcafe\.com|localhost|local)$/.test(url.hostname)
      || isIP(url.hostname) || !url.hostname.includes('.')) return '';
    return url.href;
  } catch { return ''; }
}

export function directApplyKey(value) {
  const valid = directApplyUrl(value);
  if (!valid) return '';
  const url = new URL(valid);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|source$|ref$|referrer$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  return url.href;
}

export function pruneApplyLinkCache(cache, now = Date.now()) {
  return Object.fromEntries(Object.entries(cache || {}).filter(([, value]) => value
    && now - value.at < 24 * 60 * 60 * 1000 && directApplyUrl(value.directUrl)).slice(-5000));
}

export function applyLinkFromJobData(data) {
  const job = data?.props?.pageProps?.job;
  if (!job || typeof job !== 'object') return { status: 'missing', directUrl: '' };
  if (job.is_expired === true) return { status: 'expired', directUrl: '' };
  const directUrl = directApplyUrl(job.apply_url);
  return { status: directUrl ? 'resolved' : 'missing', directUrl };
}

// Read only the requested job's record, never a similar-job URL elsewhere in
// the page. JSON.parse also decodes escaped query separators such as \u0026.
export async function readJobApplyLink(page) {
  const data = await page.evaluate(() => {
    try {
      const job = JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.job;
      return job ? { props: { pageProps: { job: { apply_url: job.apply_url, is_expired: job.is_expired } } } } : null;
    }
    catch { return null; }
  });
  return applyLinkFromJobData(data);
}

export function retryDelayMs(value, now = Date.now()) {
  const seconds = Number(value);
  if (value && Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(value || '');
  return Number.isFinite(date) ? Math.max(1000, date - now) : 60000;
}

export function createRequestPacer({ intervalMs = 1000, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let queue = Promise.resolve(), nextAt = 0, blockedUntil = 0;
  return {
    pause(ms) { blockedUntil = Math.max(blockedUntil, now() + ms); },
    wait() {
      const turn = queue.then(async () => {
        while (Math.max(nextAt, blockedUntil) > now()) await sleep(Math.min(60000, Math.max(nextAt, blockedUntil) - now()));
        nextAt = now() + intervalMs;
      });
      queue = turn.catch(() => {});
      return turn;
    },
  };
}

export async function resolveJobApplyLink(page, href, { beforeRequest = async () => {},
  onThrottle = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let throttled = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await beforeRequest();
      const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 25000 });
      if ([429, 503].includes(response?.status())) {
        throttled = true;
        await onThrottle(retryDelayMs(response.headers()['retry-after']));
        continue;
      }
      if (response && !response.ok()) throw new Error(`job page HTTP ${response.status()}`);
      await page.waitForFunction(() => {
        try { return !!JSON.parse(document.querySelector('#__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.job; }
        catch { return false; }
      }, null, { timeout: 15000 });
      return await readJobApplyLink(page);
    } catch { /* Retry an interrupted job page before moving to replacements. */ }
  }
  return { status: throttled ? 'throttled' : 'failed', directUrl: '' };
}

export function createApplyLinkCollector({ context, limit, concurrency = 3, log = () => {}, resolve = resolveJobApplyLink,
  cache = {}, checkpoint = () => {}, pacer = createRequestPacer() }) {
  const accepted = new Map();
  const checked = new Set();
  const stats = { attempted: 0, resolved: 0, embedded: 0, cached: 0, expired: 0, missing: 0, failed: 0, duplicates: 0 };
  let pool;
  const backoff = ms => {
    pacer.pause(ms);
    log(`  Site requested a pause; backing off for ${Math.ceil(ms / 1000)} seconds. Resolved links are retained.`);
  };
  const saveProgress = async () => {
    try { await checkpoint({ rows: [...accepted.values()], stats: { ...stats }, cache }); }
    catch { log('  Apply-link cache could not be saved; continuing with resolved links in memory.'); }
  };
  async function collect(rows) {
    const pending = rows.filter(row => keywordCandidateKey(row) && !checked.has(keywordCandidateKey(row)));
    if (!pending.length || accepted.size >= limit) return;
    pool ||= await Promise.all(Array.from({ length: concurrency }, () => context.newPage()));
    let cursor = 0, paused = false;
    await Promise.all(pool.map(async page => {
      while (!paused && cursor < pending.length && accepted.size < limit) {
        const row = pending[cursor++];
        const listing = keywordCandidateKey(row);
        if (checked.has(listing)) continue;
        checked.add(listing);
        const cached = cache[listing];
        const reusable = cached && Date.now() - cached.at < 24 * 60 * 60 * 1000 && directApplyUrl(cached.directUrl);
        const result = row.embeddedApplyLink ? { status: row.expired ? 'expired' : directApplyUrl(row.directUrl) ? 'resolved' : 'missing', directUrl: row.directUrl }
          : reusable ? { status: 'resolved', directUrl: cached.directUrl } : await resolve(page, row.href, {
          beforeRequest: pacer.wait,
          onThrottle: backoff,
        });
        stats.attempted++;
        if (row.embeddedApplyLink) stats.embedded++;
        else if (reusable) stats.cached++;
        if (result.status === 'throttled') { checked.delete(listing); paused = true; continue; }
        if (result.status !== 'resolved') { stats[result.status === 'expired' ? 'expired' : result.status === 'missing' ? 'missing' : 'failed']++; continue; }
        const key = directApplyKey(result.directUrl);
        if (!key) { stats.missing++; continue; }
        cache[listing] = { directUrl: directApplyUrl(result.directUrl), at: Date.now() };
        if (accepted.has(key)) { stats.duplicates++; continue; }
        if (accepted.size < limit) accepted.set(key, { ...row, directUrl: directApplyUrl(result.directUrl) });
        stats.resolved = accepted.size;
        if (accepted.size % 25 === 0) {
          log(`  Direct apply links resolved: ${accepted.size}/${limit}.`);
          await saveProgress();
        }
      }
    }));
    await saveProgress();
    log(`  Direct apply links: ${accepted.size}/${limit} (${stats.attempted} listings checked; ${stats.expired} expired, ${stats.missing} missing, ${stats.failed} failed, ${stats.duplicates} duplicates).`);
    if (paused) throw new Error(`site rate limit interrupted apply-link resolution; ${accepted.size} resolved links retained`);
  }
  return {
    collect, count: () => accepted.size, rows: () => [...accepted.values()], stats,
    beforeRequest: pacer.wait, backoff,
    async close() { if (pool) await Promise.all(pool.map(page => page.close().catch(() => {}))); },
  };
}
