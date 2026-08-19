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
 * The sig acts as a cheap stale-state checksum, not an auth token. Telegram
 * authenticates the callback origin upstream (the bot only sees callbacks
 * that came through Telegram's signed delivery to its bot identity), and the
 * `chatId !== ALLOWED_CHAT` gate filters non-allowed chats before reaching
 * here. The 32-bit truncated HMAC's job is to reject "old button clicked
 * after batch rotation" — when idx N now maps to a different job, the sig
 * recomputed against the new viewjobUrl won't match. 32 bits is overkill
 * for that purpose; we'd be safe at 24.
 *
 * Action codes:
 *   s    save (job idx)
 *   a    applied (job idx)
 *   w    why (job idx)
 *   k    skip-company (job idx — we look up company from callback table)
 *   b    batch nav: idx encodes page (e.g. "b:3" → page 3)
 *   bf   batch filter: e.g. "bf:saved" or "bf:all"
 *   h    history nav: idx is page
 *   sv   saved-jobs nav: idx is page
 *   cfg  settings toggle: idx is dot-path key index in settings table
 *   diag diagnose-supply (idx unused)
 *   uni  uninstall confirmation (idx 0=cancel, 1=pause, 2=wipe)
 *   noop dummy (for the page-counter button)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './profile-store.mjs';
import { atomicWriteJson } from './io-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// v1.0 E5: callbacks live per-profile so a /profile switch picks up the
// right table. paths() resolves to data/profiles/<active>/last-batch-callbacks.json.
const callbacksPath = () => paths().lastBatchCallbacks;
const CALLBACK_TTL_DAYS = 7;

// Whitelist of action codes the router will sign or verify. Callbacks with
// any other action are rejected without reaching the HMAC compute. Defense
// against stale builds with old action codes (deprecated routes silently
// passing verify against the wrong handler).
const KNOWN_ACTIONS = new Set([
  's', 'a', 'w', 'k',          // job-targeted
  'b', 'bf', 'h', 'sv',        // pagination / filter
  'cfg', 'diag', 'uni', 'noop' // control
]);
// Job-targeted actions look up viewjobUrl from the callbacks table; nav/
// control actions don't.
const JOB_ACTIONS = new Set(['s', 'a', 'w', 'k']);

// HMAC keying material is mandatory. The previous fallback to the literal
// string 'no-token' was a defense-in-depth concern: in any future code path
// that bypassed the bot's startup TG_TOKEN gate, every callback would sign +
// verify against a known string, defeating the stale-state check entirely.
function requireToken(token) {
  if (!token || typeof token !== 'string' || token.length < 10) {
    throw new Error('callback-router: TG_TOKEN required (length >= 10)');
  }
  return token;
}

// Constant-time string compare for the sig check. The practical risk of a
// timing oracle here is essentially nil (Telegram routes callbacks; an
// attacker can't time bot replies with sub-microsecond precision over the
// network), but using `===` for a cryptographic primitive is the kind of
// thing audits flag. Use the right primitive.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

// Sign + format a callback_data string. Stable across the bot's lifetime
// (token doesn't change), so a button minted today is verifiable next week
// — until it rolls out of the callback table on batch rotation.
export function makeCallback(action, idx, viewjobUrl, token) {
  if (!KNOWN_ACTIONS.has(action)) {
    throw new Error(`callback-router: unknown action "${action}"`);
  }
  const sig = crypto
    .createHmac('sha256', requireToken(token))
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

  // Whitelist gate before anything else. Saves an HMAC compute on garbage
  // and prevents stale-build action codes from sneaking past verify.
  if (!KNOWN_ACTIONS.has(action)) return { action, idx: null, ok: false };

  const idx = parseInt(idxStr, 10);
  if (isNaN(idx)) return { action, idx: null, ok: false };

  // Without a token we can't verify anything — surface that as not-ok rather
  // than silently treating signature as valid.
  if (!token || typeof token !== 'string' || token.length < 10) {
    return { action, idx, ok: false };
  }

  if (JOB_ACTIONS.has(action)) {
    const item = lookupItem(idx);
    if (!item) return { action, idx, ok: false, expired: true };
    const expected = makeCallback(action, idx, item.url, token).split(':')[2];
    return { action, idx, ok: safeEqual(sig, expected), item };
  }

  // Nav/control actions: no item to look up.
  const expected = makeNavCallback(action, idx, token).split(':')[2];
  return { action, idx, ok: safeEqual(sig, expected) };
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
      location: i.location || '',
      directUrl: i.directUrl || '',
      matchPct: i.matchPct ?? 0,
      score: i.score ?? 0,
      yoe: i.yoe ?? null,
      q: i.q || ''
    }))
  };
  atomicWriteJson(callbacksPath(), tbl);
  return callbacksPath();
}

export function readCallbackTable() {
  try { return JSON.parse(fs.readFileSync(callbacksPath(), 'utf8')); }
  catch { return null; }
}
