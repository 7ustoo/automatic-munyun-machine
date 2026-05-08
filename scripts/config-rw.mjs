#!/usr/bin/env node
/**
 * Atomic config.json read/write helper.
 *
 * Bot + scrape both touch config.json. We use a temp-file + rename pattern
 * so a torn write never lands. CAVEAT (Windows/NTFS): rename-over-existing-
 * destination is atomic for crash-consistency but can fail with
 * EPERM/EACCES/EBUSY if the destination has a transient lock (antivirus
 * scan, a concurrent reader's open handle). We mitigate with a short
 * retry loop. Phase 2 of v1.1 layers a `proper-lockfile` advisory lock on
 * top so concurrent writers serialize cleanly.
 *
 * Used by every Telegram /settings, /yoe, /salary, /clearance, /skip,
 * /jobs add, etc. command handler.
 *
 * v1.0 E5: profile-aware. After migration, dot-paths into profile-scoped
 * fields (user, queries, filters, scoring, weather, schedule, telegram) are
 * automatically rerouted under `profiles.<active_profile>.*`. `read()`
 * returns a flattened view of the active profile so existing consumers
 * (cfg.user.X, cfg.queries) keep working without modification.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateIfNeeded, readActiveConfig, _internals } from './profile-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config.json');
const CFG_EXAMPLE = path.join(ROOT, 'config.example.json');

// Profile-aware: ensure migration ran, then return a flattened view of the
// active profile's contents at the top level. Backward compat — consumers
// keep doing `cfg.user.salaryFloorUsd`.
export function read() {
  if (!fs.existsSync(CFG_PATH)) {
    if (fs.existsSync(CFG_EXAMPLE)) fs.copyFileSync(CFG_EXAMPLE, CFG_PATH);
    else throw new Error('config.json not found and no example to copy from');
  }
  migrateIfNeeded();
  return readActiveConfig();
}

// Raw structure for callers that need the full file (e.g. profile UIs).
export function readRaw() {
  migrateIfNeeded();
  return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
}

function atomicWrite(obj) {
  const tmp = CFG_PATH + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  // Retry on transient Windows lock errors. POSIX renames are atomic and
  // never raise these codes; on NTFS, an antivirus scan or another process's
  // open handle can briefly block the rename.
  const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, CFG_PATH);
      return;
    } catch (e) {
      lastErr = e;
      if (!RETRY_CODES.has(e.code)) break;
      // Synchronous backoff; this code path is sync by contract (callers
      // expect atomicWrite to return before they continue). 50, 100, 150, 200ms.
      const end = Date.now() + 50 * (i + 1);
      while (Date.now() < end) { /* spin */ }
    }
  }
  // All retries exhausted (or non-transient error) — clean up tmp and re-throw.
  try { fs.unlinkSync(tmp); } catch { /* tmp may already be gone */ }
  throw lastErr;
}

// Decide whether a dot-path is profile-scoped (lives inside profiles.<slug>)
// or top-level (e.g. active_profile itself).
function isProfileScoped(dotPath) {
  const head = dotPath.split('.')[0];
  return _internals.PROFILE_FIELDS.includes(head);
}

function resolveDotPath(dotPath, raw) {
  if (raw.profiles && isProfileScoped(dotPath)) {
    return `profiles.${raw.active_profile || 'default'}.${dotPath}`;
  }
  return dotPath;
}

// dot-path setter: set('user.salaryFloorUsd', 90000)
export function set(dotPath, value) {
  migrateIfNeeded();
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const fullPath = resolveDotPath(dotPath, raw);
  const keys = fullPath.split('.');
  let cur = raw;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined || cur[keys[i]] === null || typeof cur[keys[i]] !== 'object') {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  atomicWrite(raw);
  return raw;
}

// dot-path getter
export function get(dotPath, fallback = undefined) {
  const view = read();
  return dotPath.split('.').reduce((o, k) => (o == null ? o : o[k]), view) ?? fallback;
}

// array append (no duplicates by .toLowerCase)
export function appendUnique(dotPath, item) {
  migrateIfNeeded();
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const fullPath = resolveDotPath(dotPath, raw);
  const keys = fullPath.split('.');
  let cur = raw;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]]) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (!Array.isArray(cur[last])) cur[last] = [];
  const norm = (x) => (typeof x === 'string' ? x.toLowerCase() : JSON.stringify(x).toLowerCase());
  const exists = cur[last].some(x => norm(x) === norm(item));
  if (exists) { atomicWrite(raw); return { added: false, list: cur[last] }; }
  cur[last].push(item);
  atomicWrite(raw);
  return { added: true, list: cur[last] };
}

// array remove (case-insensitive match for strings)
export function removeFromArray(dotPath, predicateOrValue) {
  migrateIfNeeded();
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const fullPath = resolveDotPath(dotPath, raw);
  const keys = fullPath.split('.');
  let cur = raw;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]]) return { removed: 0, list: [] };
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (!Array.isArray(cur[last])) return { removed: 0, list: [] };
  const before = cur[last].length;
  const pred = typeof predicateOrValue === 'function'
    ? predicateOrValue
    : (item) => {
        if (typeof item === 'string' && typeof predicateOrValue === 'string') {
          return item.toLowerCase() === predicateOrValue.toLowerCase();
        }
        if (item && typeof item === 'object' && typeof predicateOrValue === 'string') {
          // for queries: { key, term } — match by term
          return (item.term || '').toLowerCase() === predicateOrValue.toLowerCase();
        }
        return JSON.stringify(item) === JSON.stringify(predicateOrValue);
      };
  cur[last] = cur[last].filter(x => !pred(x));
  atomicWrite(raw);
  return { removed: before - cur[last].length, list: cur[last] };
}
