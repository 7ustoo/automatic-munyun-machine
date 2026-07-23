/**
 * Batch exclusions (v7.7) — "don't send this one."
 *
 * The dashboard's ranked list gets an ✕ on every job: excluded jobs stay
 * visible (grayed, restorable) but are dropped from every outbound surface —
 * Export (txt/csv/xlsx), the Email send, Open All, and the Telegram /export.
 * Spot a duplicate or a job you don't want your VA to touch, click ✕, done —
 * no more downloading the file and hand-editing it.
 *
 * State lives in a per-profile sidecar, keyed to the batch it belongs to:
 *   data/profiles/<active>/batch-exclusions.json
 *   { batchGeneratedAt: "<last-batch generatedAt>", excluded: [idx, ...] }
 *
 * A new scrape produces a new generatedAt → stale exclusions are discarded
 * automatically (fresh batch starts clean). Pure helpers exported for tests;
 * IO is atomic via io-helpers.
 */

import fs from 'node:fs';
import { atomicWriteJson } from './io-helpers.mjs';

// Pure: parse a sidecar payload against the CURRENT batch stamp. Wrong or
// missing stamp → empty set (stale exclusions never leak across batches).
export function exclusionsFrom(raw, batchGeneratedAt) {
  if (!raw || raw.batchGeneratedAt !== batchGeneratedAt || !batchGeneratedAt) return new Set();
  return new Set((Array.isArray(raw.excluded) ? raw.excluded : [])
    .map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0));
}

// Pure: toggle one idx. Returns the new sorted array.
export function toggleIdx(excluded, idx, on) {
  const set = new Set(excluded);
  const n = parseInt(idx, 10);
  if (!Number.isInteger(n) || n <= 0) return [...set].sort((a, b) => a - b);
  if (on) set.add(n); else set.delete(n);
  return [...set].sort((a, b) => a - b);
}

export function readExclusions(filePath, batchGeneratedAt) {
  try {
    return exclusionsFrom(JSON.parse(fs.readFileSync(filePath, 'utf8')), batchGeneratedAt);
  } catch { return new Set(); }
}

// Toggle + persist. Returns the new array (sorted) for the API response.
export function writeExclusion(filePath, batchGeneratedAt, idx, on) {
  const current = readExclusions(filePath, batchGeneratedAt);
  const next = toggleIdx(current, idx, on);
  atomicWriteJson(filePath, { batchGeneratedAt, excluded: next });
  return next;
}
