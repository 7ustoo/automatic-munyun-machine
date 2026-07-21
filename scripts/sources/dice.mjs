/**
 * Dice.com search adapter (v7.3).
 *
 * Dice is a search-driven job board (like hiring.cafe), not a per-company ATS
 * feed — so unlike greenhouse/lever/ashby it reuses the user's configured
 * search terms instead of board tokens. Always-on since v7.4 — routing is
 * decided by search.scrapeSources + per-term engines (query-engines.mjs).
 *
 * No API key, no Playwright: dice.com's search and job-detail pages are
 * server-rendered Next.js (App Router). The full result set rides in the
 * page's React flight payload (`self.__next_f.push([1,"…"])` chunks) as
 * structured JSON per job: guid, title, companyName, jobLocation.displayName,
 * salary (real ranges!), postedDate, workplaceTypes, isRemote, easyApply and
 * a ~500-char JD summary. The detail page carries the FULL description as a
 * flight text chunk (`"description":"$4b"` → `4b:T<hexlen>,<text>`), which we
 * use to enrich the top cards per query so JD-pass scoring sees real text.
 *
 * All parsers are pure and fixture-tested; fetchDice() is best-effort (any
 * failure yields [] for that query, never throws) per the sources contract.
 */

import { normalizeCard } from './normalize.mjs';

export const DICE_SEARCH_URL = 'https://www.dice.com/jobs';
export const DICE_JD_TOP = 12;       // detail-page JD fetches per query (cap)
const JD_CONCURRENCY = 3;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---- flight payload helpers (pure) ----

// Join + unescape every self.__next_f.push([1,"…"]) string chunk. The chunks
// are JS string literals: unescape \" \n \\ (enough for JSON scanning; other
// escapes are left alone rather than risking a lossy transform).
export function extractFlightPayload(html) {
  const chunks = [...String(html || '').matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)]
    .map(m => m[1]);
  return chunks.join('')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
}

// Balanced-brace scan: return the JSON object literal starting at `start`
// (which must point at '{'), or null if unbalanced/too long.
function sliceBalanced(s, start, maxLen = 20000) {
  let depth = 0, inStr = false, esc = false;
  const end = Math.min(s.length, start + maxLen);
  for (let i = start; i < end; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// Every job object in the flight payload carries "guid" + "detailsPageUrl".
// Objects appear in result lists AND "similar jobs" rails — dedup by guid,
// first occurrence wins (result list renders first in the payload).
export function parseDiceJobs(html) {
  const flight = extractFlightPayload(html);
  const out = [];
  const seen = new Set();
  const rx = /"guid":"([0-9a-f-]{36})"/g;
  let m;
  while ((m = rx.exec(flight))) {
    if (seen.has(m[1])) continue;
    // walk back to the enclosing '{' (the guid key sits near the object head)
    const head = flight.lastIndexOf('{', m.index);
    if (head < 0) continue;
    const lit = sliceBalanced(flight, head);
    if (!lit) continue;
    try {
      const job = JSON.parse(lit);
      if (job && job.guid && job.title && job.detailsPageUrl) {
        seen.add(job.guid);
        out.push(job);
      }
    } catch { /* partial/nested object — skip */ }
  }
  return out;
}

// Resolve a flight text-chunk reference (e.g. description "$4b") to its text:
// chunks look like `4b:T1f83,<raw text…>` where 1f83 is the hex byte length.
export function extractFlightText(html, refId) {
  const flight = extractFlightPayload(html);
  const marker = new RegExp(`(?:^|\\n)${refId}:T([0-9a-f]+),`);
  const m = marker.exec(flight);
  if (!m) return '';
  const start = m.index + m[0].length;
  const len = parseInt(m[1], 16);
  return flight.slice(start, start + len);
}

// Full JD from a job-detail page: find `"description":"$XX"` then resolve $XX.
// Flight text chunks carry \uXXXX escapes (e.g. < for '<') — decode them
// first or the tag-stripper never sees the tags.
export function parseDiceDetailJD(html) {
  const flight = extractFlightPayload(html);
  const ref = /"description":"\$([0-9a-f]+)"/.exec(flight);
  if (!ref) return '';
  return extractFlightText(html, ref[1])
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- normalization (pure) ----

export function normalizeDice(job) {
  if (!job || !job.title || !job.detailsPageUrl) return null;
  const workplace = Array.isArray(job.workplaceTypes) && job.workplaceTypes.length
    ? String(job.workplaceTypes[0]).toLowerCase().replace('on-site', 'onsite')
    : (job.isRemote ? 'remote' : '');
  // Real salary ranges ride the structured field — append to the JD text so
  // the existing salary extractor (parseSalaryK over job text) picks them up.
  const salary = String(job.salary || '');
  const salaryNote = /\d/.test(salary) ? ` Salary: ${salary}.` : '';
  return normalizeCard({
    source: 'dice',
    title: job.title,
    company: job.companyName || '',
    location: job.jobLocation?.displayName || '',
    url: job.detailsPageUrl,
    jd: String(job.summary || '') + salaryNote,
    postedAt: job.postedDate || '',
    workplaceType: workplace
  });
}

// ---- search URL (pure) ----

// v7.5: mirror the user's filters into Dice's own search params so page 1 is
// already the RIGHT page 1. Without these, results come back nationwide and
// all-workplace-types, and the client-side workplace filter guts them (the
// "Dice only returned 2 jobs" bug — 3 remote jobs in 35 unfiltered results).
// Params verified live: filters.workplaceTypes=Remote|Hybrid|On-Site (pipe-
// joined), location=<display>&radius=30&radiusUnit=mi, filters.postedDate=
// ONE|THREE|SEVEN, page=N. Dice bleeds a little across filters — the client
// filter stays as backstop.
export function buildDiceSearchUrl(q, { page = 1, workplaceTypes = [], location = '', maxAgeDays = null } = {}) {
  const p = new URLSearchParams({ q: String(q || '').trim() });
  const wt = (Array.isArray(workplaceTypes) ? workplaceTypes : [])
    .map(w => ({ remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-Site' })[String(w).toLowerCase()])
    .filter(Boolean);
  // A subset selection filters; all three (or none) means "no preference".
  if (wt.length && wt.length < 3) p.set('filters.workplaceTypes', wt.join('|'));
  // Location only helps when the user wants local (non-remote-only) results.
  const loc = String(location || '').trim();
  if (loc && wt.some(w => w !== 'Remote')) {
    p.set('location', loc);
    p.set('radius', '30');
    p.set('radiusUnit', 'mi');
  }
  if (Number.isFinite(maxAgeDays)) {
    const posted = maxAgeDays <= 1 ? 'ONE' : maxAgeDays <= 3 ? 'THREE' : maxAgeDays <= 7 ? 'SEVEN' : '';
    if (posted) p.set('filters.postedDate', posted);
  }
  if (page > 1) p.set('page', String(page));
  return `${DICE_SEARCH_URL}?${p.toString()}`;
}

// ---- network (best-effort) ----

async function get(url, fetchImpl, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html' }
    });
    if (!res.ok) return '';
    return await res.text();
  } catch { return ''; }
  finally { clearTimeout(t); }
}

// Fetch one search query from Dice. Enriches the top `jdTop` cards with the
// full JD from their detail pages (small concurrency, best-effort — a failed
// detail fetch leaves the card's summary text in place).
// v7.6: walk EVERY result page, not a fixed count. The loop stops itself when
// a page yields no new jobs (Dice repeats results past the end) or comes back
// empty; the cap is a runaway guard, not a target (~30 jobs/page ≈ 600 jobs).
export const DICE_MAX_PAGES = 20;

export async function fetchDice(query, { fetchImpl = fetch, pages = DICE_MAX_PAGES, jdTop = DICE_JD_TOP, filters = {}, onPage } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const seen = new Set();
  const cards = [];
  for (let p = 1; p <= Math.max(1, Math.min(DICE_MAX_PAGES, pages)); p++) {
    const url = buildDiceSearchUrl(q, { ...filters, page: p });
    // v7.5: watch-mode hook — daily-batch mirrors this URL in a visible
    // browser page so "Watch" shows exactly what Dice is being asked.
    try { await onPage?.(url, q, p); } catch { /* watch is cosmetic — never break the fetch */ }
    const html = await get(url, fetchImpl);
    if (!html) break;
    const jobs = parseDiceJobs(html);
    let fresh = 0;
    for (const j of jobs) {
      if (seen.has(j.guid)) continue;
      seen.add(j.guid);
      const card = normalizeDice(j);
      if (card) { cards.push(card); fresh++; }
    }
    if (!fresh) break; // exhausted — this page added nothing new
  }
  // JD enrichment: Dice relevance-sorts results, so the head of the list is
  // where full-JD scoring pays off most.
  const targets = cards.slice(0, Math.max(0, jdTop));
  for (let i = 0; i < targets.length; i += JD_CONCURRENCY) {
    await Promise.all(targets.slice(i, i + JD_CONCURRENCY).map(async card => {
      const html = await get(card.href, fetchImpl);
      if (!html) return;
      const jd = parseDiceDetailJD(html);
      if (jd) {
        const salaryNote = / Salary: [^]*$/.exec(card.jdText)?.[0] || '';
        card.jdText = (jd.slice(0, 8000 - salaryNote.length) + salaryNote).trim();
      }
    }));
  }
  return cards;
}
