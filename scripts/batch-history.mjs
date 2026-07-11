/**
 * Batch history (v4.6) — daily snapshots powering the dashboard's Trends view
 * and search-term leaderboard.
 *
 * Every scrape, `last-batch.json` is OVERWRITTEN — so before v4.6 the app had
 * zero memory across days. This module appends one compact summary per day to
 * the active profile's `batch-history.json`:
 *
 *   { days: [ { date, generatedAt, sent, target, avgPct, strongCount,
 *               raw, keptAfterFilter, afterDedup,
 *               terms: { "<search term>": { count, avgPct, strong } } } ] }
 *
 * Re-running a scrape on the same date REPLACES that day's entry (last write
 * wins — same rule as last-batch.json itself). History is capped at
 * HISTORY_MAX_DAYS entries. Pure builders are exported for tests.
 */

import fs from 'node:fs';
import { atomicWriteJson } from './io-helpers.mjs';

export const HISTORY_MAX_DAYS = 90;

// Pure: one day's snapshot from the delivered jobs + funnel.
export function summarizeBatch({ date, generatedAt, jobs = [], funnel = {} }) {
  const pcts = jobs.map(j => j.matchPct || 0);
  const avgPct = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
  const terms = {};
  for (const j of jobs) {
    const q = (j.q || '').trim();
    if (!q) continue;
    const t = terms[q] || (terms[q] = { count: 0, pctSum: 0, strong: 0 });
    t.count++;
    t.pctSum += j.matchPct || 0;
    if ((j.matchPct || 0) >= 70) t.strong++;
  }
  for (const q of Object.keys(terms)) {
    const t = terms[q];
    terms[q] = { count: t.count, avgPct: Math.round(t.pctSum / t.count), strong: t.strong };
  }
  return {
    date,
    generatedAt,
    sent: jobs.length,
    target: funnel.targetJobsPerBatch ?? null,
    avgPct,
    strongCount: pcts.filter(p => p >= 70).length,
    raw: funnel.raw ?? null,
    keptAfterFilter: funnel.keptAfterFilter ?? null,
    afterDedup: funnel.afterDedup ?? null,
    terms
  };
}

// Pure: insert/replace by date, sort ascending, cap length.
export function mergeHistory(days, entry, maxDays = HISTORY_MAX_DAYS) {
  const out = (Array.isArray(days) ? days : []).filter(d => d && d.date && d.date !== entry.date);
  out.push(entry);
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return out.slice(-maxDays);
}

export function readHistory(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed.days) ? parsed.days : [];
  } catch { return []; }
}

// Read-merge-write one day's snapshot. Non-fatal by design — history is an
// analytics nicety, so a write failure must never break the batch (caller
// already wraps, but be defensive here too).
export function appendHistory(filePath, entry, maxDays = HISTORY_MAX_DAYS) {
  try {
    const days = mergeHistory(readHistory(filePath), entry, maxDays);
    atomicWriteJson(filePath, { lastUpdated: entry.generatedAt || null, days });
    return true;
  } catch { return false; }
}

// Pure: aggregate per-term stats across N days of history → leaderboard rows,
// best average match first (min 1 job). Powers the "which searches earn their
// keep" table; totals let the UI show share-of-batch.
export function termLeaderboard(days, { lastNDays = 30 } = {}) {
  const recent = (Array.isArray(days) ? days : []).slice(-lastNDays);
  const agg = {};
  let total = 0;
  for (const d of recent) {
    for (const [q, t] of Object.entries(d.terms || {})) {
      const a = agg[q] || (agg[q] = { term: q, count: 0, pctSum: 0, strong: 0 });
      a.count += t.count || 0;
      a.pctSum += (t.avgPct || 0) * (t.count || 0);
      a.strong += t.strong || 0;
      total += t.count || 0;
    }
  }
  const rows = Object.values(agg)
    .filter(a => a.count > 0)
    .map(a => ({
      term: a.term,
      count: a.count,
      avgPct: Math.round(a.pctSum / a.count),
      strong: a.strong,
      sharePct: total ? Math.round((a.count / total) * 100) : 0
    }));
  rows.sort((x, y) => y.avgPct - x.avgPct || y.count - x.count);
  return { rows, totalJobs: total, daysCovered: recent.length };
}
