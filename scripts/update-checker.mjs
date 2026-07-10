#!/usr/bin/env node
// Lightweight update checker.
//
// Polls the GitHub Releases API for the repo's latest tag, compares it
// against the local package.json version, and reports whether an update
// is available. Pure outbound HTTP, no telemetry, no auth required.
//
// Used by:
//   - telegram-bot.mjs at startup + once per day
//   - the /update command for explicit re-checks
//
// Persistence: data/update-state.json holds the user's "skipped" version
// so we don't re-nag about a release they already declined.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './io-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'data', 'update-state.json');
const REPO = '7ustoo/automatic-munyun-machine';

// Read the bot's current version from package.json. Single source of truth.
export function currentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

// Compare two semver-ish strings (e.g. "0.5.0" > "0.4.1"). No pre-release
// support — keep it simple. Returns true iff `a` is strictly greater than `b`.
export function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { dismissedVersion: null, lastCheckedAt: null, lastSeenLatest: null }; }
}

function writeState(s) {
  atomicWriteJson(STATE_PATH, s);
}

// Mark a version as "skip this one" — we won't notify about it again,
// but newer versions still alert.
export function dismissVersion(version) {
  const s = readState();
  s.dismissedVersion = String(version).replace(/^v/, '');
  writeState(s);
  return s;
}

export function getDismissed() {
  return readState().dismissedVersion;
}

// Hits GitHub Releases API. Returns null on any failure (network, 404, etc.)
// — caller should treat null as "couldn't check, try again later" rather
// than as "no update available."
//
// Strategy: /releases/latest excludes pre-releases. We want pre-releases too,
// so we hit /releases (returns all, sorted newest-first) and pick the first.
// Falls back to /tags if no GitHub Release has been published yet.
async function ghJson(pathSuffix, current) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${pathSuffix}`, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': `automatic-munyun-machine/${current}`,
      'Accept': 'application/vnd.github+json'
    }
  });
  if (!r.ok) return null;
  return r.json();
}

// 5-minute in-memory cache so a user spamming /version, /update check,
// /update notes etc. doesn't burn through GitHub rate limit. Force-refresh
// is available via checkForUpdate({ force: true }) for /update check.
let _cached = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function checkForUpdate({ force = false } = {}) {
  if (!force && _cached && (Date.now() - _cachedAt) < CACHE_TTL_MS) {
    return _cached;
  }
  const current = currentVersion();
  try {
    // Try /releases first — gets pre-releases too. Take the newest.
    let latestTag = '';
    let releaseNotes = '';
    let releaseUrl = '';
    let publishedAt = '';

    const releases = await ghJson('/releases?per_page=10', current);
    if (Array.isArray(releases) && releases.length) {
      const r0 = releases[0];
      latestTag = String(r0.tag_name || '');
      releaseNotes = String(r0.body || '').trim();
      releaseUrl = String(r0.html_url || '');
      publishedAt = String(r0.published_at || '');
    } else {
      // Fall back to /tags — useful for repos that tag but don't cut Releases.
      const tags = await ghJson('/tags?per_page=10', current);
      if (Array.isArray(tags) && tags.length) {
        // Tags API returns most-recent-first by default
        latestTag = String(tags[0].name || '');
        releaseUrl = `https://github.com/${REPO}/releases`;
      }
    }

    const latest = latestTag.replace(/^v/, '');
    if (!latest) return null;

    const state = readState();
    state.lastCheckedAt = new Date().toISOString();
    state.lastSeenLatest = latest;
    writeState(state);

    const result = {
      current,
      latest,
      hasUpdate: semverGt(latest, current),
      dismissed: state.dismissedVersion === latest,
      releaseNotes,
      releaseUrl: releaseUrl || `https://github.com/${REPO}/releases`,
      publishedAt
    };
    _cached = result;
    _cachedAt = Date.now();
    return result;
  } catch {
    return null;
  }
}

// Mark that an update is in progress. Bot reads this on next startup to
// confirm the update succeeded and message the user accordingly.
export function markUpdating(fromVersion, toVersion) {
  const flag = path.join(ROOT, 'data', '.updating');
  atomicWriteJson(flag, {
    from: fromVersion,
    to: toVersion,
    startedAt: new Date().toISOString()
  });
}

// Read + clear the post-update flag. Called by bot at startup. Returns the
// flag contents (or null if not present). Caller uses this to send the
// "✅ Updated to vX.Y.Z" confirmation.
//
// Guard against false positives: if the flag claims we updated TO version X
// but the running bot is NOT version X, the upgrade didn't actually take —
// markUpdating ran but git pull/npm install failed before exit, or restart
// happened from a stale code path. Silently consume the flag without
// notifying so the user doesn't see a confusing "Updated to vX.Y.Z" when
// they're actually still on the old version.
export function consumePostUpdateFlag() {
  const flag = path.join(ROOT, 'data', '.updating');
  if (!fs.existsSync(flag)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(flag, 'utf8'));
    fs.unlinkSync(flag);
    if (data && data.to && data.to !== currentVersion()) {
      // Claimed upgrade didn't actually land. Don't lie to the user.
      return null;
    }
    return data;
  } catch {
    try { fs.unlinkSync(flag); } catch {}
    return null;
  }
}
