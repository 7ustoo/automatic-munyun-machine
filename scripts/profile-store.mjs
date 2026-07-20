#!/usr/bin/env node
/**
 * v1.0 E5: multi-profile store.
 *
 * One install, multiple personas (e.g. "iam-ic" + "swe-manager"). Each profile
 * has its own CV, queries, filters, scoring, and seen-jobs memory. Browser
 * profile (data/browser-profile/) and bot heartbeat are SHARED across personas
 * — one hiring.cafe account, one bot process.
 *
 * Layout:
 *   config.json              { active_profile, profiles: { <slug>: {...} } }
 *   data/profiles/<slug>/
 *     cv-parsed.json
 *     seen-jobs.json
 *     last-batch.json
 *     last-batch-callbacks.json
 *     applications.md
 *     query-stats.json
 *
 * Migration: on first import after upgrade, if config has the v0.x flat shape
 * (top-level user/queries/filters/...) but no `profiles` field, we wrap it
 * into profiles.default and move existing data files into data/profiles/default/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, lockedUpdateJsonSync } from './io-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config.json');
const CFG_EXAMPLE = path.join(ROOT, 'config.example.json');
const PROFILES_DIR = path.join(ROOT, 'data', 'profiles');

// Fields that live "inside" a profile vs at config top level.
const PROFILE_FIELDS = ['user', 'queries', 'filters', 'scoring', 'weather', 'schedule', 'telegram', 'email', 'display', 'search', 'sources'];

// Per-profile data files (relocated under data/profiles/<slug>/ on migration).
const PROFILE_DATA_FILES = [
  'cv-parsed.json',
  'seen-jobs.json',
  'last-batch.json',
  'last-batch-callbacks.json',
  'applications.md',
  'query-stats.json'
];

function readRawConfig() {
  if (!fs.existsSync(CFG_PATH)) {
    if (fs.existsSync(CFG_EXAMPLE)) fs.copyFileSync(CFG_EXAMPLE, CFG_PATH);
    else throw new Error('config.json not found and no example to copy from');
  }
  return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
}

function atomicWriteConfig(obj) {
  // Delegated to io-helpers for the lock + retry semantics. Safe even when
  // the caller is already holding the lock indirectly through the same
  // path — proper-lockfile is process-aware (it tags the lock with PID).
  atomicWriteJson(CFG_PATH, obj);
}

// Idempotent. Safe to call from any script entrypoint.
export function migrateIfNeeded() {
  const raw = readRawConfig();
  if (raw.profiles && raw.active_profile) {
    // v5.0: reconcile orphaned top-level keys that BECAME profile-scoped in a
    // later version (e.g. 'search', 'sources'). Earlier migration left them at
    // top level, where set() writes but read() (active-profile view) can't see
    // them — so a saved setting silently reverted. Move each into the active
    // profile iff it isn't already there. One-time, idempotent, defensive.
    const slug = raw.active_profile;
    const prof = raw.profiles[slug];
    if (prof) {
      const orphans = Object.keys(raw).filter(k => PROFILE_FIELDS.includes(k) && prof[k] === undefined);
      if (orphans.length) {
        for (const k of orphans) { prof[k] = raw[k]; delete raw[k]; }
        atomicWriteConfig(raw);
        return { migrated: true, reconciled: orphans };
      }
    }
    return { migrated: false };
  }

  // Wrap flat shape into profiles.default.
  const newCfg = {
    active_profile: 'default',
    profiles: { default: {} }
  };
  for (const key of Object.keys(raw)) {
    if (PROFILE_FIELDS.includes(key)) {
      newCfg.profiles.default[key] = raw[key];
    } else if (key !== '_comment') {
      // Preserve any other top-level non-profile keys defensively
      newCfg[key] = raw[key];
    }
  }
  atomicWriteConfig(newCfg);

  // Relocate per-profile data files under data/profiles/default/
  const targetDir = path.join(PROFILES_DIR, 'default');
  fs.mkdirSync(targetDir, { recursive: true });
  let moved = 0;
  for (const f of PROFILE_DATA_FILES) {
    const oldPath = path.join(ROOT, 'data', f);
    const newPath = path.join(targetDir, f);
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      try { fs.renameSync(oldPath, newPath); moved++; }
      catch (e) {
        // Surface the failure — silent swallow used to leave stranded
        // files in the v0.x location, and later code expecting v1.0
        // paths would silently see "no data" instead of "migration broke."
        console.error(`profile-store: migration rename failed for ${f}: ${e.message}`);
      }
    }
  }
  return { migrated: true, profile: 'default', dataFilesMoved: moved };
}

// Active-profile slug. After migrateIfNeeded() this is always defined.
export function getActiveProfile() {
  migrateIfNeeded();
  const raw = readRawConfig();
  return raw.active_profile || 'default';
}

// All profile slugs.
export function listProfiles() {
  migrateIfNeeded();
  const raw = readRawConfig();
  return Object.keys(raw.profiles || {});
}

// Path object for a given profile (defaults to active).
export function paths(slug) {
  const profile = slug || getActiveProfile();
  const dir = path.join(PROFILES_DIR, profile);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    cvParsed:           path.join(dir, 'cv-parsed.json'),
    seenJobs:           path.join(dir, 'seen-jobs.json'),
    lastBatch:          path.join(dir, 'last-batch.json'),
    lastBatchCallbacks: path.join(dir, 'last-batch-callbacks.json'),
    applications:       path.join(dir, 'applications.md'),
    queryStats:         path.join(dir, 'query-stats.json'),
    batchHistory:       path.join(dir, 'batch-history.json'), // v4.6: daily snapshots for Trends
    batchArchiveDir:    path.join(dir, 'batch-archive')       // v7.2: full per-scrape snapshots (30-day retention)
  };
}

// Add a new profile. Optionally clones config from another (default: copy
// from active so a freshly added profile inherits queries / filters / etc.).
//
// F-H9: also clone cv-parsed.json from the source profile if present, so a
// newly-created persona can score jobs immediately. The caller can override
// with a fresh /resume upload later. Without this, the first batch on the
// new profile drops every job below the match floor and the user gets a
// confusing "0 fresh jobs" outcome.
export function addProfile(slug, opts = {}) {
  if (!/^[a-z0-9_-]{1,32}$/i.test(slug)) {
    throw new Error('Profile slug must be 1-32 chars: letters, digits, dash, underscore.');
  }
  const raw = readRawConfig();
  if (!raw.profiles) throw new Error('Run migrateIfNeeded() before addProfile().');
  if (raw.profiles[slug]) throw new Error(`Profile "${slug}" already exists.`);

  const cloneFrom = opts.cloneFrom || raw.active_profile;
  const source = raw.profiles[cloneFrom] || {};
  raw.profiles[slug] = JSON.parse(JSON.stringify(source));
  atomicWriteConfig(raw);

  // Create the data dir
  const targetDir = path.join(PROFILES_DIR, slug);
  fs.mkdirSync(targetDir, { recursive: true });

  // Clone cv-parsed.json from source profile if it exists. cv-parsed.json
  // is the only per-profile data file worth carrying forward — applications,
  // saved, seen-jobs, last-batch should start fresh on a new persona.
  let cvCloned = false;
  if (cloneFrom && cloneFrom !== slug) {
    const srcCv = path.join(PROFILES_DIR, cloneFrom, 'cv-parsed.json');
    const dstCv = path.join(targetDir, 'cv-parsed.json');
    if (fs.existsSync(srcCv) && !fs.existsSync(dstCv)) {
      try { fs.copyFileSync(srcCv, dstCv); cvCloned = true; }
      catch (e) { console.error(`profile-store: cv clone failed: ${e.message}`); }
    }
  }
  return { slug, clonedFrom: cloneFrom, cvCloned };
}

// Switch the active profile. Subsequent reads/writes route through the new one.
export function setActiveProfile(slug) {
  const raw = readRawConfig();
  if (!raw.profiles?.[slug]) throw new Error(`Profile "${slug}" not found.`);
  raw.active_profile = slug;
  atomicWriteConfig(raw);
  return slug;
}

// Rename a profile. Renames the profiles[<slug>] key in config.json, moves
// data/profiles/<old>/ → data/profiles/<new>/, and updates active_profile
// if it was pointing at the renamed profile. Slug format matches addProfile.
// Fails cleanly if newSlug already exists or the source is missing.
export function renameProfile(oldSlug, newSlug) {
  if (!/^[a-z0-9_-]{1,32}$/i.test(newSlug)) {
    throw new Error('Profile slug must be 1-32 chars: letters, digits, dash, underscore.');
  }
  if (oldSlug === newSlug) return { renamed: oldSlug, dataMoved: false };
  const raw = readRawConfig();
  if (!raw.profiles) throw new Error('Run migrateIfNeeded() before renameProfile().');
  if (!raw.profiles[oldSlug]) throw new Error(`Profile "${oldSlug}" not found.`);
  if (raw.profiles[newSlug]) throw new Error(`Profile "${newSlug}" already exists.`);

  // Rebuild the profiles object preserving insertion order so the UI list
  // doesn't jump around after a rename. JSON key order isn't semantically
  // meaningful but users expect stability.
  const rebuilt = {};
  for (const k of Object.keys(raw.profiles)) {
    rebuilt[k === oldSlug ? newSlug : k] = raw.profiles[k];
  }
  raw.profiles = rebuilt;
  if (raw.active_profile === oldSlug) raw.active_profile = newSlug;
  atomicWriteConfig(raw);

  // Move the on-disk data dir. Same-filesystem rename is atomic; a cross-
  // device fallback isn't worth it here — data/profiles/ lives next to
  // config.json which we just wrote to.
  let dataMoved = false;
  const oldDir = path.join(PROFILES_DIR, oldSlug);
  const newDir = path.join(PROFILES_DIR, newSlug);
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    try { fs.renameSync(oldDir, newDir); dataMoved = true; }
    catch (e) { console.error(`profile-store: data dir rename failed: ${e.message}`); }
  }
  return { renamed: newSlug, from: oldSlug, dataMoved };
}

// Delete a profile. Cannot delete the active one. Optionally wipes data dir.
export function deleteProfile(slug, opts = {}) {
  const raw = readRawConfig();
  if (!raw.profiles?.[slug]) throw new Error(`Profile "${slug}" not found.`);
  if (raw.active_profile === slug) throw new Error(`Can't delete active profile. Switch first.`);
  if (Object.keys(raw.profiles).length <= 1) throw new Error(`Can't delete the only profile.`);

  delete raw.profiles[slug];
  atomicWriteConfig(raw);

  if (opts.wipeData) {
    const dir = path.join(PROFILES_DIR, slug);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { deleted: slug, dataWiped: !!opts.wipeData };
}

// Read the active profile's effective config — returns a flattened view
// where the profile's user/queries/filters/etc. appear at the top level
// for backward compat with existing consumers (cfg.user.salaryFloorUsd
// still works after migration).
export function readActiveConfig() {
  const raw = readRawConfig();
  if (!raw.profiles) {
    // Pre-migration — return as is for transitional safety.
    return raw;
  }
  const slug = raw.active_profile || 'default';
  const profile = raw.profiles[slug] || {};
  return {
    ...profile,
    _activeProfile: slug,
    _profiles: raw.profiles,
    _raw: raw
  };
}

export const _internals = { readRawConfig, atomicWriteConfig, PROFILE_FIELDS, PROFILE_DATA_FILES };
