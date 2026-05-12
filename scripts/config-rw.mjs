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
import { atomicWriteText, lockedUpdateJsonSync } from './io-helpers.mjs';

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

// Atomic + cross-process-locked write. The proper-lockfile advisory lock
// in io-helpers serializes concurrent writers (bot + scrape both touching
// config.json) — without it, two readers could each compute a divergent
// new state and the loser's write disappears. The atomic-rename retry loop
// handles NTFS transient EPERM/EACCES/EBUSY.
function atomicWrite(obj) {
  // The lockedUpdateJsonSync wrapper takes a mutator that returns the
  // new state. We've already computed the new state in the caller (set,
  // appendUnique, etc.) — pass through.
  lockedUpdateJsonSync(CFG_PATH, () => obj);
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

// dot-path setter: set('user.salaryFloorUsd', 90000). Read-modify-write
// runs inside the file lock so concurrent writers serialize.
export function set(dotPath, value) {
  migrateIfNeeded();
  return lockedUpdateJsonSync(CFG_PATH, (raw) => {
    if (!raw) raw = {};
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
    return raw;
  });
}

// dot-path getter
export function get(dotPath, fallback = undefined) {
  const view = read();
  return dotPath.split('.').reduce((o, k) => (o == null ? o : o[k]), view) ?? fallback;
}

// array append (no duplicates by .toLowerCase). Lock-and-update.
export function appendUnique(dotPath, item) {
  migrateIfNeeded();
  let result = { added: false, list: [] };
  lockedUpdateJsonSync(CFG_PATH, (raw) => {
    if (!raw) raw = {};
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
    if (!exists) cur[last].push(item);
    result = { added: !exists, list: cur[last] };
    return raw;
  });
  return result;
}

// array remove (case-insensitive match for strings). Lock-and-update.
export function removeFromArray(dotPath, predicateOrValue) {
  migrateIfNeeded();
  let result = { removed: 0, list: [] };
  lockedUpdateJsonSync(CFG_PATH, (raw) => {
    if (!raw) return undefined; // no file → nothing to remove, skip write
    const fullPath = resolveDotPath(dotPath, raw);
    const keys = fullPath.split('.');
    let cur = raw;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!cur[keys[i]]) { result = { removed: 0, list: [] }; return undefined; }
      cur = cur[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (!Array.isArray(cur[last])) { result = { removed: 0, list: [] }; return undefined; }
    const before = cur[last].length;
    const pred = typeof predicateOrValue === 'function'
      ? predicateOrValue
      : (item) => {
          if (typeof item === 'string' && typeof predicateOrValue === 'string') {
            return item.toLowerCase() === predicateOrValue.toLowerCase();
          }
          if (item && typeof item === 'object' && typeof predicateOrValue === 'string') {
            return (item.term || '').toLowerCase() === predicateOrValue.toLowerCase();
          }
          return JSON.stringify(item) === JSON.stringify(predicateOrValue);
        };
    cur[last] = cur[last].filter(x => !pred(x));
    result = { removed: before - cur[last].length, list: cur[last] };
    return raw;
  });
  return result;
}
