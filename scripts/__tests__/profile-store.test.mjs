// node --test scripts/__tests__/profile-store.test.mjs
// Smoke tests for the v1.0 E5 multi-profile store. Locks down the slug
// validation + path shape; doesn't mutate the real config (uses a fresh
// temp dir via NODE-side env override is too invasive — these tests only
// exercise pure functions / read-only paths).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, getActiveProfile, listProfiles, renameProfile, _internals } from '../profile-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

test('paths() returns the standard six per-profile file slots', () => {
  const p = paths();
  assert.ok(p.dir);
  assert.ok(p.cvParsed.endsWith('cv-parsed.json'));
  assert.ok(p.seenJobs.endsWith('seen-jobs.json'));
  assert.ok(p.lastBatch.endsWith('last-batch.json'));
  assert.ok(p.lastBatchCallbacks.endsWith('last-batch-callbacks.json'));
  assert.ok(p.applications.endsWith('applications.md'));
  assert.ok(p.queryStats.endsWith('query-stats.json'));
});

test('paths() resolves under data/profiles/<slug>/', () => {
  const p = paths('default');
  assert.ok(p.dir.replace(/\\/g, '/').includes('data/profiles/default'),
    `expected data/profiles/default in dir, got ${p.dir}`);
});

test('listProfiles() returns at least the active profile after migration', () => {
  // Either fresh install (just default) or post-migration (default + maybe more).
  const all = listProfiles();
  const active = getActiveProfile();
  assert.ok(all.includes(active), `active "${active}" should appear in listProfiles ${JSON.stringify(all)}`);
});

test('PROFILE_FIELDS is the expected set', () => {
  assert.deepEqual(
    [..._internals.PROFILE_FIELDS].sort(),
    ['display', 'email', 'filters', 'queries', 'schedule', 'scoring', 'telegram', 'user', 'weather']
  );
});

test('renameProfile() rejects invalid slugs before touching disk', () => {
  // Validation runs before readRawConfig(), so a bad slug throws without I/O.
  assert.throws(() => renameProfile('default', ''), /1-32 chars/);
  assert.throws(() => renameProfile('default', 'has spaces'), /1-32 chars/);
  assert.throws(() => renameProfile('default', 'x'.repeat(33)), /1-32 chars/);
  assert.throws(() => renameProfile('default', 'weird$char'), /1-32 chars/);
});

test('renameProfile() is a no-op when oldSlug === newSlug', () => {
  // Fast-path early return before any config read — safe to exercise against
  // the real config file.
  const r = renameProfile('default', 'default');
  assert.equal(r.renamed, 'default');
  assert.equal(r.dataMoved, false);
});

test('PROFILE_DATA_FILES enumerates per-profile data files only', () => {
  // These files MUST be per-profile. heartbeat / auth-state / bot-offset are
  // intentionally NOT here (machine-shared).
  for (const f of ['cv-parsed.json', 'seen-jobs.json', 'last-batch.json', 'applications.md']) {
    assert.ok(_internals.PROFILE_DATA_FILES.includes(f), `${f} should be per-profile`);
  }
  assert.ok(!_internals.PROFILE_DATA_FILES.includes('heartbeat.json'), 'heartbeat is shared');
  assert.ok(!_internals.PROFILE_DATA_FILES.includes('auth-state.json'), 'auth-state is shared');
});
