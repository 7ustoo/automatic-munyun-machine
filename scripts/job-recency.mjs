#!/usr/bin/env node
/**
 * Job posting-age parsing + recency filtering (v2.5).
 *
 * hiring.cafe cards show a compact posted-age token like "5h", "3d", "2w",
 * "1mo", "1y". The scraper already reads this token (EXTRACT_FN in
 * daily-batch.mjs) to locate the title; v2.5 also captures it as
 * `postedAge` so we can filter by how recently a job was posted.
 *
 * We filter CLIENT-SIDE on the card's own age rather than trying to encode
 * a date filter into hiring.cafe's private searchState JSON — a wrong guess
 * there silently returns zero jobs (the failure mode we most want to avoid).
 *
 * Recency presets map to a max age in days:
 *   today → 1 · 3days → 3 · week → 7 · month → 31 · any → null (no filter)
 */

export const RECENCY_PRESETS = {
  today: 1,
  '3days': 3,
  week: 7,
  month: 31,
  any: null
};

// "5h" | "3d" | "2w" | "1mo" | "1y"  →  approximate age in days.
// Unknown / unparseable → null (caller treats null as "don't drop it" — we
// never hide a job just because we couldn't read its age).
export function parseAgeToDays(ageStr) {
  const s = String(ageStr || '').trim().toLowerCase();
  const m = s.match(/^(\d+)\s*(mo|[hdwy])$/); // 'mo' before the single-char class
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'h':  return n / 24;   // hours → fractional days (all < 1 day old)
    case 'd':  return n;
    case 'w':  return n * 7;
    case 'mo': return n * 30;
    case 'y':  return n * 365;
    default:   return null;
  }
}

// Normalize a config value (preset key OR a raw number of days) → max days,
// or null for "any". Tolerates legacy/freeform input.
export function recencyMaxDays(value) {
  if (value == null || value === '' || value === 'any') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? value : null;
  if (Object.prototype.hasOwnProperty.call(RECENCY_PRESETS, value)) return RECENCY_PRESETS[value];
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// True if a job with this postedAge should be KEPT under maxDays.
// Jobs with an unreadable/absent age are always kept (fail-open) — better to
// show a job of unknown age than to silently hide real results.
export function withinRecency(postedAge, maxDays) {
  if (maxDays == null) return true;
  const days = parseAgeToDays(postedAge);
  if (days == null) return true;
  return days <= maxDays;
}
