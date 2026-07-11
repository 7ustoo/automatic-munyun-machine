// node --test scripts/__tests__/setup-init.test.mjs
// v2.7: pure-function tests for the setup-init config builder. The file-write
// side effect (setupInit → atomicWriteJson → config.json) is intentionally
// untested — that'd mutate the developer's real config. buildInitConfig is
// pure and covers all the transformation logic that matters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInitConfig } from '../dashboard-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));

test('produces v1.0 profile shape: { active_profile, profiles.default }', () => {
  const cfg = buildInitConfig({
    user: { name: 'Justin', maxYoeAcceptable: 5, salaryFloorUsd: 90000 },
    weather: { city: 'Miami', lat: 25.7617, lon: -80.1918, timezone: 'America/New_York' },
    schedule: { time: '07:00', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    queries: ['IAM Engineer', 'Cloud Security'],
    filters: { filterClearance: true, applicationFormEase: 'all', maxJobAge: 'any' },
    search: { mode: 'titles' }
  }, EXAMPLE);
  assert.equal(cfg.active_profile, 'default');
  assert.ok(cfg.profiles);
  assert.ok(cfg.profiles.default);
  const p = cfg.profiles.default;
  assert.equal(p.user.name, 'Justin');
  assert.equal(p.user.salaryFloorUsd, 90000);
  assert.equal(p.weather.city, 'Miami');
  assert.equal(p.schedule.time, '07:00');
  assert.equal(p.filters.filterClearance, true);
});

test('user input overrides defaults, defaults fill the gaps', () => {
  // Only user.name provided — the other user fields must fall back to the
  // example. This is the "user changes one thing, other defaults are safe"
  // case that matters most on a real setup.
  const cfg = buildInitConfig({ user: { name: 'Alice' } }, EXAMPLE);
  const p = cfg.profiles.default;
  assert.equal(p.user.name, 'Alice');
  // Example ships with salaryFloorUsd + maxYoeAcceptable — those survive.
  assert.equal(p.user.salaryFloorUsd, EXAMPLE.user.salaryFloorUsd);
  assert.equal(p.user.maxYoeAcceptable, EXAMPLE.user.maxYoeAcceptable);
});

test('queries: strings become {key, term} pairs', () => {
  const cfg = buildInitConfig({ queries: ['Cloud Engineer', 'IAM'] }, EXAMPLE);
  const q = cfg.profiles.default.queries;
  assert.equal(q.length, 2);
  assert.equal(q[0].term, 'Cloud Engineer');
  // Key derivation: alphanumeric-only, ≤20 chars.
  assert.equal(q[0].key, 'CloudEngineer');
  assert.equal(q[1].term, 'IAM');
  assert.equal(q[1].key, 'IAM');
});

test('queries: empty stays empty — v5.0 never backfills someone else\'s field', () => {
  // v5.0: config.example ships with NO queries and buildInitConfig backfills
  // from it, so a user who skipped resume/suggestions gets an EMPTY query list
  // (the dashboard then prompts "add search terms") — never the old IAM/cloud
  // defaults that made every fresh install look like a security engineer's.
  const cfg = buildInitConfig({}, EXAMPLE);
  assert.equal(cfg.profiles.default.queries.length, 0);
  assert.equal(EXAMPLE.queries.length, 0, 'config.example.json must ship with no queries');
});

test('queries: blank strings are dropped', () => {
  const cfg = buildInitConfig({ queries: ['  ', '', 'Valid Term', null] }, EXAMPLE);
  const q = cfg.profiles.default.queries;
  assert.equal(q.length, 1);
  assert.equal(q[0].term, 'Valid Term');
});

test('queries: symbol-only string still gets a key (fallback qN)', () => {
  const cfg = buildInitConfig({ queries: ['+++', 'Normal'] }, EXAMPLE);
  const q = cfg.profiles.default.queries;
  assert.equal(q[0].term, '+++');
  // Alphanumeric strip → empty → falls back to `q${i}`.
  assert.equal(q[0].key, 'q0');
  assert.equal(q[1].key, 'Normal');
});

test('scoring block is preserved verbatim from defaults (never a user input)', () => {
  const cfg = buildInitConfig({ user: { name: 'X' } }, EXAMPLE);
  assert.deepEqual(cfg.profiles.default.scoring, EXAMPLE.scoring);
});

test('filters: user toggles override defaults (clearance off)', () => {
  const cfg = buildInitConfig({
    filters: { filterClearance: false, applicationFormEase: 'simple', maxJobAge: 'week' }
  }, EXAMPLE);
  const f = cfg.profiles.default.filters;
  assert.equal(f.filterClearance, false);
  assert.equal(f.applicationFormEase, 'simple');
  assert.equal(f.maxJobAge, 'week');
  // Skip lists survive since we're only patching user-toggle fields.
  assert.deepEqual(f.skipCompanies, EXAMPLE.filters.skipCompanies);
});

test('browser section survives merge (non-profile top-level default)', () => {
  const cfg = buildInitConfig({ user: { name: 'X' } }, EXAMPLE);
  assert.ok(cfg.browser, 'browser block should be preserved at top level');
  assert.equal(cfg.browser.channel, EXAMPLE.browser.channel);
});

test('empty defaults still produces valid shape (no example available)', () => {
  const cfg = buildInitConfig({ user: { name: 'X' } }, {});
  assert.equal(cfg.active_profile, 'default');
  assert.ok(cfg.profiles.default);
  assert.equal(cfg.profiles.default.user.name, 'X');
  assert.deepEqual(cfg.profiles.default.queries, []);
  assert.deepEqual(cfg.profiles.default.scoring, {});
});

test('_comment field on defaults is dropped from output profile', () => {
  const cfg = buildInitConfig({}, EXAMPLE);
  // The example ships with a top-level _comment; the config we write should
  // have its OWN _comment (v2.7 setup marker), not the example's.
  assert.ok(cfg._comment);
  assert.match(cfg._comment, /dashboard setup/);
  assert.notEqual(cfg._comment, EXAMPLE._comment);
});
