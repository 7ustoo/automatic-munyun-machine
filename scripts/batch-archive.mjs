/**
 * Batch archive (v7.2) — full-batch snapshots so a re-scrape never loses jobs.
 *
 * `batch-history.mjs` (v4.6) keeps one compact SUMMARY per day for Trends;
 * the actual job list in `last-batch.json` is still overwritten by every
 * scrape. This module saves the complete batch on every run:
 *
 *   data/profiles/<active>/batch-archive/
 *     batch-2026-07-20T14-33-05.json   ← full last-batch.json snapshot
 *     index.json                       ← [{ id, date, generatedAt, sent,
 *                                          avgPct, strongCount }] newest first
 *
 * Every scrape gets its own file (unlike history's one-entry-per-day rule),
 * so running twice in a day keeps both. Archives older than
 * ARCHIVE_RETENTION_DAYS are pruned on each write. The dashboard lists the
 * index (GET /api/archive), shows a snapshot's jobs (GET /api/archive/batch)
 * and exports one via the existing export pipe (GET /api/export?archive=id).
 *
 * Ids are derived from generatedAt and validated by ARCHIVE_ID_RX everywhere
 * a caller passes one in (path-traversal guard). Pure builders exported for
 * tests; IO wrappers are non-fatal by design — archiving must never break a
 * scrape.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './io-helpers.mjs';

export const ARCHIVE_RETENTION_DAYS = 30;

// batch-2026-07-20T14-33-05 — date + time, filesystem-safe (no colons).
export const ARCHIVE_ID_RX = /^batch-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

// Pure: archive id from an ISO generatedAt timestamp.
export function archiveId(generatedAt) {
  const iso = new Date(generatedAt || Date.now()).toISOString(); // 2026-07-20T14:33:05.123Z
  return 'batch-' + iso.slice(0, 19).replace(/:/g, '-');
}

// Pure: one index entry from a full last-batch object.
export function entryFromBatch(lastBatch) {
  const jobs = Array.isArray(lastBatch?.jobs) ? lastBatch.jobs : [];
  const pcts = jobs.map(j => j.matchPct || 0);
  return {
    id: archiveId(lastBatch?.generatedAt),
    date: lastBatch?.date || String(lastBatch?.generatedAt || '').slice(0, 10),
    generatedAt: lastBatch?.generatedAt || null,
    sent: jobs.length,
    avgPct: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0,
    strongCount: pcts.filter(p => p >= 70).length
  };
}

// Pure: insert/replace by id, newest first, drop entries older than cutoff.
// `now` injectable for tests.
export function mergeIndex(entries, entry, { retentionDays = ARCHIVE_RETENTION_DAYS, now = Date.now() } = {}) {
  const cutoff = now - retentionDays * 86400_000;
  const keep = (Array.isArray(entries) ? entries : [])
    .filter(e => e && ARCHIVE_ID_RX.test(String(e.id)) && e.id !== entry.id)
    .filter(e => {
      const t = Date.parse(e.generatedAt || e.date || '');
      return Number.isFinite(t) ? t >= cutoff : false;
    });
  keep.push(entry);
  keep.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return keep;
}

export function readIndex(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    return Array.isArray(parsed.archives) ? parsed.archives : [];
  } catch { return []; }
}

// Full snapshot + index update + prune of expired archive files. Non-fatal:
// returns the entry on success, null on any failure.
export function archiveBatch(dir, lastBatch, opts = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const entry = entryFromBatch(lastBatch);
    atomicWriteJson(path.join(dir, entry.id + '.json'), lastBatch);
    const archives = mergeIndex(readIndex(dir), entry, opts);
    atomicWriteJson(path.join(dir, 'index.json'), { lastUpdated: entry.generatedAt, archives });
    // Delete snapshot files that fell out of the index (age prune). Never
    // touch anything that doesn't match the id pattern.
    const live = new Set(archives.map(e => e.id + '.json'));
    for (const f of fs.readdirSync(dir)) {
      if (f === 'index.json' || live.has(f)) continue;
      if (ARCHIVE_ID_RX.test(f.replace(/\.json$/, ''))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* non-fatal */ }
      }
    }
    return entry;
  } catch { return null; }
}

// List for the dashboard. Missing dir/index → empty list, never throws.
export function listArchives(dir) {
  return readIndex(dir);
}

// Read one archived batch by id. Invalid id or missing file → null.
export function readArchive(dir, id) {
  if (!ARCHIVE_ID_RX.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
  } catch { return null; }
}
