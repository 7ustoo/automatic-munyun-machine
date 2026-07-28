/**
 * hiring.cafe search API adapter (v7.10).
 *
 * WHY THIS EXISTS
 * ---------------
 * The scrape used to read job cards out of the DOM and advance by clicking the
 * "Next" link. That capped what we could ever collect, because hiring.cafe
 * stops rendering a Next link long before the result set ends — measured on
 * `cloud security` (Remote): the site reports ~1,831 matches, Next-clicking
 * surfaced 869.
 *
 * hiring.cafe is a Next.js app, and its own UI pulls results from the page's
 * data endpoint:
 *
 *   /_next/data/<buildId>/index.json?searchState=<json>&page=<n>
 *
 * That endpoint is happy to serve any page number directly, and it answers
 * with far more than the DOM shows:
 *
 *   ssrHits         — the jobs (≈40-95 per page; the UI only paints 40)
 *   ssrTotalCount   — how many matches exist
 *   ssrIsLastPage   — an explicit end-of-results flag, so no more guessing
 *
 * Walking it collected 1,410 unique jobs for the same search (+62%), in
 * seconds rather than minutes, with no render races anywhere.
 *
 * The hits are also richer than a scraped card: real company names (the DOM
 * heuristic frequently produced ""), structured years-of-experience, real
 * salary ranges, publish dates, workplace type, and `apply_url` — the direct
 * ATS link, already resolved.
 *
 * HOW IT RUNS
 * -----------
 * Requests go through an already-open Playwright page via `page.evaluate` +
 * `fetch`, so they inherit the profile's Cloudflare clearance and same-origin
 * context. We never open a second browser or re-solve a challenge.
 *
 * normalizeHcafeHit() is pure and fixture-tested; the fetch loop is
 * best-effort and returns what it has on any failure, so daily-batch can fall
 * back to DOM scraping and a bad day degrades instead of breaking.
 */

// A hit's job page on hiring.cafe. daily-batch dedups on this, and the
// seen-jobs store is keyed by it, so the shape must stay stable.
export function hcafeJobUrl(id) {
  return 'https://hiring.cafe/job/' + String(id || '').trim();
}

// ISO timestamp → the age token the recency filter already speaks ("5h",
// "3d", "2w"). parseAgeToDays() in job-recency.mjs accepts h/d/w/mo/y, so we
// emit hours under a day and days otherwise — anything unparseable becomes ''
// which the filter treats as "unknown age, keep it".
export function publishDateToAgeToken(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const hours = Math.max(0, (now - t) / 3600000);
  if (hours < 24) return Math.max(1, Math.round(hours)) + 'h';
  const days = Math.round(hours / 24);
  if (days < 7) return days + 'd';
  if (days < 60) return Math.round(days / 7) + 'w';
  if (days < 365) return Math.round(days / 30) + 'mo';
  return Math.round(days / 365) + 'y';
}

// Build the text the keyword scorer reads. The DOM card gave us whatever
// happened to be rendered; here we can assemble the parts that actually carry
// signal — title, company, location, the requirements summary, the tool and
// certification lists — which is strictly better input for matching.
export function hitCardText(hit) {
  const v = hit?.v5_processed_job_data || {};
  const parts = [
    hit?.job_information?.title,
    v.company_name,
    v.formatted_workplace_location,
    v.seniority_level,
    Array.isArray(v.commitment) ? v.commitment.join(' ') : '',
    v.requirements_summary,
    Array.isArray(v.technical_tools) ? v.technical_tools.join(' ') : '',
    Array.isArray(v.licenses_or_certifications) ? v.licenses_or_certifications.join(' ') : '',
    Array.isArray(v.role_activities) ? v.role_activities.join(' ') : '',
    v.company_tagline
  ].filter(Boolean);
  return parts.join(' — ').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

// One API hit → the card shape daily-batch's pipeline already consumes
// ({href, title, yoe, postedAge, company, cardText}), plus the extras the API
// hands us for free. Returns null when a hit can't produce a usable card.
export function normalizeHcafeHit(hit, now = Date.now()) {
  if (!hit || !hit.id) return null;
  const info = hit.job_information || {};
  const v = hit.v5_processed_job_data || {};
  const title = String(info.title || info.job_title_raw || '').trim();
  if (!title) return null;
  const yoeRaw = v.min_industry_and_role_yoe;
  return {
    href: hcafeJobUrl(hit.id),
    title: title.slice(0, 80),
    // Structured, not regex-guessed off a card line.
    yoe: Number.isFinite(yoeRaw) ? yoeRaw : null,
    postedAge: publishDateToAgeToken(v.estimated_publish_date, now),
    company: String(v.company_name || hit.enriched_company_data?.name || '').trim(),
    cardText: hitCardText(hit),
    // --- extras the DOM never gave us ---
    // Already-resolved ATS link: the resolve pass can skip these entirely.
    directUrl: String(hit.apply_url || '').trim(),
    location: String(v.formatted_workplace_location || '').trim(),
    workplaceType: String(v.workplace_type || '').trim(),
    salaryMinK: Number.isFinite(v.yearly_min_compensation) ? Math.round(v.yearly_min_compensation / 1000) : 0,
    salaryMaxK: Number.isFinite(v.yearly_max_compensation) ? Math.round(v.yearly_max_compensation / 1000) : 0,
    seniority: String(v.seniority_level || '').trim(),
    isExpired: hit.is_expired === true
  };
}

// Pure: does this page's payload say we're done? Kept separate so the stop
// rule is unit-testable without a browser.
export function isLastPage(payload, hitsLen) {
  if (!payload) return true;
  if (payload.ssrIsLastPage === true) return true;
  return hitsLen === 0;
}

// Read the Next.js build id from the loaded page. It changes on every
// hiring.cafe deploy, so it must be read live rather than pinned.
export async function readBuildId(page) {
  return await page.evaluate(() => (window.__NEXT_DATA__ || {}).buildId || null).catch(() => null);
}

/**
 * Walk the search API for one searchState until hiring.cafe says it's the
 * last page. Runs inside the page so Cloudflare clearance applies.
 *
 * Returns { cards, totalCount, pages, stoppedBecause } — never throws.
 */
export async function fetchHcafeSearch(page, searchState, { maxPages = 300, log = () => {}, now = Date.now } = {}) {
  const buildId = await readBuildId(page);
  if (!buildId) return { cards: [], totalCount: null, pages: 0, stoppedBecause: 'no buildId on page (API unavailable)' };

  const seen = new Set();
  const cards = [];
  let totalCount = null;
  let pages = 0;
  let stoppedBecause = `hit the ${maxPages}-page guard`;

  for (let n = 1; n <= maxPages; n++) {
    let payload;
    try {
      payload = await page.evaluate(async ({ buildId, searchState, n }) => {
        const url = '/_next/data/' + buildId + '/index.json?searchState=' +
          encodeURIComponent(JSON.stringify(searchState)) + '&page=' + n;
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) return { __httpError: res.status };
        const json = await res.json();
        return json.pageProps || {};
      }, { buildId, searchState, n });
    } catch (e) {
      stoppedBecause = `page ${n} request failed: ${String(e.message || e).split('\n')[0]}`;
      break;
    }
    if (!payload || payload.__httpError) {
      stoppedBecause = `page ${n} returned HTTP ${payload?.__httpError ?? 'error'}`;
      break;
    }

    const hits = Array.isArray(payload.ssrHits) ? payload.ssrHits : [];
    if (totalCount == null && Number.isFinite(payload.ssrTotalCount)) totalCount = payload.ssrTotalCount;
    pages = n;

    let fresh = 0;
    for (const h of hits) {
      const card = normalizeHcafeHit(h, typeof now === 'function' ? now() : now);
      if (!card || seen.has(card.href)) continue;
      seen.add(card.href);
      cards.push(card);
      fresh++;
    }
    log(`  page ${n} → ${hits.length} hits (${fresh} new, running total: ${cards.length})`);

    if (isLastPage(payload, hits.length)) {
      stoppedBecause = payload.ssrIsLastPage === true
        ? 'hiring.cafe reported the last page'
        : 'page returned no hits';
      break;
    }
  }

  return { cards, totalCount, pages, stoppedBecause };
}
