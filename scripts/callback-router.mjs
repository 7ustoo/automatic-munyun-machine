#!/usr/bin/env node
/**
 * Telegram inline-callback router.
 *
 * Telegram callback_data is capped at 64 bytes per button. We use a compact
 * `<action>:<idx>:<sig>` scheme where:
 *   - action: 1-3 letter action code (s/a/w/k/b/h/cfg)
 *   - idx:    integer index into data/last-batch-callbacks.json (or other ctx)
 *   - sig:    8-hex-char HMAC of (action+idx+viewjobUrl) keyed by TG_TOKEN
 *
 * The sig is our defense against stale callbacks: when a new batch rotates
 * the callback table, an old button's idx may map to a NEW job — the sig
 * check rejects it so we never act on stale state. (Telegram callbacks
 * can't be forged by a user, but they can be CLICKED late.)
 *
 * Action codes:
 *   s    save (job idx)
 *   a    applied (job idx)
 *   w    why (job idx)
 *   k    skip-company (job idx — we look up company from callback table)
 *   b    batch nav: idx encodes page (e.g. "b:3" → page 3)
 *   bf   batch filter: e.g. "bf:saved" or "bf:all"
 *   h    history nav: idx is page
 *   cfg  settings toggle: idx is dot-path key index in settings table
 *   noop dummy (for the page-counter button)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './profile-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// v1.0 E5: callbacks live per-profile so a /profile switch picks up the
// right table. paths() resolves to data/profiles/<active>/last-batch-callbacks.json.
const callbacksPath = () => paths().lastBatchCallbacks;
const CALLBACK_TTL_DAYS = 7;

// Sign + format a callback_data string. Stable across the bot's lifetime
// (token doesn't change), so a button minted today is verifiable next week
// — until it rolls out of the callback table on batch rotation.
export function makeCallback(action, idx, viewjobUrl, token) {
  const sig = crypto
    .createHmac('sha256', token || 'no-token')
    .update(`${action}:${idx}:${viewjobUrl || ''}`)
    .digest('hex')
    .slice(0, 8);
  return `${action}:${idx}:${sig}`;
}

// Navigation/control buttons (no per-job context) — sig binds to the action
// + idx alone since there's no associated viewjobUrl.
export function makeNavCallback(action, idx, token) {
  return makeCallback(action, idx, '', token);
}

// Parse + verify in one shot. Returns { action, idx, ok, item } where item
// is the entry from last-batch-callbacks.json if action targets a job.
export function parseAndVerify(callbackData, token) {
  const parts = String(callbackData || '').split(':');
  if (parts.length !== 3) return { action: null, idx: null, ok: false };
  const [action, idxStr, sig] = parts;
  const idx = parseInt(idxStr, 10);
  if (isNaN(idx)) return { action, idx: null, ok: false };

  // Job-targeted actions: look up viewjobUrl from the callbacks table to
  // recompute sig.
  const jobActions = new Set(['s', 'a', 'w', 'k']);
  if (jobActions.has(action)) {
    const item = lookupItem(idx);
    if (!item) return { action, idx, ok: false, expired: true };
    const expected = makeCallback(action, idx, item.url, token).split(':')[2];
    return { action, idx, ok: sig === expected, item };
  }

  // Nav/control actions: no item to look up.
  const expected = makeNavCallback(action, idx, token).split(':')[2];
  return { action, idx, ok: sig === expected };
}

function lookupItem(idx) {
  try {
    const tbl = JSON.parse(fs.readFileSync(callbacksPath(), 'utf8'));
    if (tbl.expiresAt && new Date(tbl.expiresAt).getTime() < Date.now()) return null;
    return (tbl.items || []).find(i => i.idx === idx) || null;
  } catch {
    return null;
  }
}

// Write the per-batch callback table — invoked by daily-batch.mjs after a
// successful Telegram push so the bot can resolve incoming callbacks.
export function writeCallbackTable(items) {
  const expiresAt = new Date(Date.now() + CALLBACK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const tbl = {
    generatedAt: new Date().toISOString(),
    expiresAt,
    items: items.map(i => ({
      idx: i.idx,
      url: i.viewjobUrl || i.url,
      title: i.title || '',
      company: i.company || '',
      directUrl: i.directUrl || '',
      matchPct: i.matchPct ?? 0,
      score: i.score ?? 0,
      yoe: i.yoe ?? null,
      q: i.q || ''
    }))
  };
  fs.mkdirSync(path.dirname(callbacksPath()), { recursive: true });
  fs.writeFileSync(callbacksPath(), JSON.stringify(tbl, null, 2));
  return callbacksPath();
}

export function readCallbackTable() {
  try { return JSON.parse(fs.readFileSync(callbacksPath(), 'utf8')); }
  catch { return null; }
}
