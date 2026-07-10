#!/usr/bin/env node
/**
 * Atomic write + file-lock helpers (v1.1).
 *
 * Three concerns:
 *   1. Atomic JSON / text writes — temp file + rename, with retry on
 *      transient Windows EPERM/EACCES/EBUSY (NTFS rename-over-existing
 *      isn't atomic w.r.t. concurrent open handles).
 *   2. Advisory file locks via `proper-lockfile` — used to serialize
 *      read-modify-write of config.json and per-profile JSON files when
 *      bot + scrape may both touch them.
 *   3. A safe-default `withFileLock(path, fn)` wrapper that the rest of
 *      the codebase calls — handles ENOENT (file doesn't exist yet),
 *      stale-lock cleanup, and unlock-on-throw.
 *
 * Why this lives in its own module (and not in config-rw or profile-store):
 *   - Multiple callers (config-rw, profile-store, daily-batch's seen-jobs
 *     write, telegram-bot's /forget last) all need the same primitive.
 *   - Tests can exercise the primitives without spinning up the full bot.
 *
 * proper-lockfile makes a `<path>.lock` directory; `mkdir(O_EXCL)` is
 * atomic-create-or-fail across all major filesystems including NTFS,
 * APFS, ext4. Stale-lock detection by mtime + readiness probe.
 */

import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

// Codes that indicate "transient — retry might succeed."
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Synchronous backoff loop. atomicWrite needs to stay sync because most of
// our callers (config-rw.set, etc.) are sync by contract.
function syncBackoff(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/**
 * Atomic write of arbitrary text. Caller passes the final string; we handle
 * temp-file + rename with retry. Throws after 5 attempts.
 *
 * @param {string} filePath  Absolute path to write.
 * @param {string} content   String content (JSON or otherwise).
 */
export function atomicWriteText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, content);
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (e) {
      lastErr = e;
      if (!RETRY_CODES.has(e.code)) break;
      syncBackoff(50 * (i + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* tmp may already be gone */ }
  throw lastErr;
}

/**
 * Atomic write of a JSON-serializable value.
 *
 * @param {string} filePath  Absolute path to write.
 * @param {unknown} obj      Anything JSON.stringify can handle.
 * @param {{indent?: number}} [opts]
 */
export function atomicWriteJson(filePath, obj, opts = {}) {
  const indent = opts.indent ?? 2;
  atomicWriteText(filePath, JSON.stringify(obj, null, indent));
}

/**
 * Atomic update — read existing JSON, mutate via callback, write back.
 * The callback receives the parsed object (or `null` if file is missing).
 * Returns whatever the callback returns. The mutation runs WITHOUT a
 * lock — for serialized cross-process updates use withFileLock.
 *
 * @param {string} filePath
 * @param {(prev: any) => any} mutator   Receives parsed JSON or null;
 *                                        return the new value to write,
 *                                        or undefined to skip the write.
 */
export function atomicUpdateJson(filePath, mutator) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { /* missing or corrupt — start fresh */ }
  const next = mutator(prev);
  if (next !== undefined) atomicWriteJson(filePath, next);
  return next;
}

/**
 * Run an async function while holding an advisory lock on `filePath`.
 *
 * Implementation detail: proper-lockfile creates a `<filePath>.lock`
 * directory. If the target file doesn't exist yet (e.g. seen-jobs.json
 * before the first scrape), we create an empty file first so lockfile
 * has something to attach to.
 *
 * Stale-lock policy: 30 seconds. After 30s of no liveness signal from
 * the lock holder, we steal the lock. Realistic write windows for AMM
 * are < 100 ms; 30 s is paranoid headroom.
 *
 * @param {string} filePath
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withFileLock(filePath, fn) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '');

  let release;
  try {
    release = await lockfile.lock(filePath, {
      stale: 30000,           // 30s stale-lock ceiling
      retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
      realpath: false         // tolerate the file being a symlink target
    });
  } catch (e) {
    throw new Error(`io-helpers: could not acquire lock on ${filePath}: ${e.message}`);
  }

  try {
    return await fn();
  } finally {
    try { await release(); }
    catch { /* unlock failure — proper-lockfile will GC the stale lock */ }
  }
}

/**
 * Lock-and-update convenience: combines withFileLock + atomicUpdateJson.
 * The mutator runs INSIDE the lock so concurrent writers serialize.
 *
 * @param {string} filePath
 * @param {(prev: any) => any} mutator
 * @returns {Promise<any>} whatever mutator returned
 */
export async function lockedUpdateJson(filePath, mutator) {
  return withFileLock(filePath, () => {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { /* missing or corrupt */ }
    const next = mutator(prev);
    if (next !== undefined) atomicWriteJson(filePath, next);
    return next;
  });
}

// Sync variant for callers that genuinely cannot await — uses
// proper-lockfile's sync API. Prefer the async lockedUpdateJson where
// possible; the sync variant exists for compatibility with existing
// sync hot paths in config-rw.mjs / profile-store.mjs.
export function lockedUpdateJsonSync(filePath, mutator) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '');

  // proper-lockfile's lockSync API does not accept a `retries` option (it's
  // sync — there's no async sleep to back off with). Implement our own
  // bounded busy-retry: 30 attempts x ~80 ms = up to ~2.4 s total wait.
  // The previous ~1 s ceiling was flaky with three concurrent writers on
  // slower Windows disks and under full-suite CPU contention.
  let release;
  let lastErr;
  const MAX_ATTEMPTS = 30;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      release = lockfile.lockSync(filePath, { stale: 30000, realpath: false });
      break;
    } catch (e) {
      lastErr = e;
      // Spin-wait briefly. proper-lockfile errors with .code === 'ELOCKED'
      // when another holder owns the lock; treat any error as retryable
      // until attempts exhaust.
      const end = Date.now() + 80;
      while (Date.now() < end) { /* spin */ }
    }
  }
  if (!release) {
    throw new Error(`io-helpers: could not acquire lock on ${filePath}: ${lastErr?.message || 'unknown'}`);
  }

  try {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { /* missing or corrupt */ }
    const next = mutator(prev);
    if (next !== undefined) atomicWriteJson(filePath, next);
    return next;
  } finally {
    try { release(); }
    catch { /* unlock failure — proper-lockfile will GC */ }
  }
}
