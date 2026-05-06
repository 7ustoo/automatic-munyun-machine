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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config.json');
const CFG_EXAMPLE = path.join(ROOT, 'config.example.json');
const PROFILES_DIR = path.join(ROOT, 'data', 'profiles');

// Fields that live "inside" a profile vs at config top level.
const PROFILE_FIELDS = ['user', 'queries', 'filters', 'scoring', 'weather', 'schedule', 'telegram'];

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
  const tmp = CFG_PATH + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, CFG_PATH);
}

// Idempotent. Safe to call from any script entrypoint.
export function migrateIfNeeded() {
  const raw = readRawConfig();
  if (raw.profiles && raw.active_profile) return { migrated: false };

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
      try { fs.renameSync(oldPath, newPath); moved++; } catch {}
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
    queryStats:         path.join(dir, 'query-stats.json')
  };
}

// Add a new profile. Optionally clones config from another (default: copy
// from active so a freshly added profile inherits queries / filters / etc.).
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
  fs.mkdirSync(path.join(PROFILES_DIR, slug), { recursive: true });
  return { slug, clonedFrom: cloneFrom };
}

// Switch the active profile. Subsequent reads/writes route through the new one.
export function setActiveProfile(slug) {
  const raw = readRawConfig();
  if (!raw.profiles?.[slug]) throw new Error(`Profile "${slug}" not found.`);
  raw.active_profile = slug;
  atomicWriteConfig(raw);
  return slug;
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
