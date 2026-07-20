// v7.1: guards against the update-wipes-settings bug class.
//
// History: CI's npm-test step creates config.json in the checkout (config-rw
// copies the example on first read). The Windows installer packaged the repo
// root without excluding config.json, so — with Inno's ignoreversion — every
// update OVERWROTE the user's real config.json with the pristine example:
// blocked companies, API key, schedule, email settings all reset. These tests
// pin every layer of the fix so it can't silently regress.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickLatestSnapshot } from '../config-rw.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('installer excludes the root config.json from the payload', () => {
  const iss = fs.readFileSync(path.join(ROOT, 'installer', 'amm.iss'), 'utf8');
  const excludesLine = iss.split('\n').find(l => /^\s*Excludes:/.test(l));
  assert.ok(excludesLine, 'amm.iss must have an Excludes: line');
  // Leading backslash = payload-root-only, so node_modules deps that ship
  // their own config.json are unaffected.
  assert.ok(excludesLine.includes('\\config.json'), 'Excludes must contain \\config.json — without it every update resets user settings');
  assert.ok(excludesLine.includes('data\\*'), 'Excludes must keep data\\*');
  assert.ok(excludesLine.includes('.env'), 'Excludes must keep .env');
});

test('release workflow scrubs user-state files before packaging the installer', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const scrubIdx = yml.indexOf('Scrub user-state files');
  const buildIdx = yml.indexOf('Build .exe via Inno Setup');
  assert.ok(scrubIdx !== -1, 'release.yml must have the scrub step');
  assert.ok(buildIdx !== -1, 'release.yml must build the installer');
  assert.ok(scrubIdx < buildIdx, 'scrub must run BEFORE the installer is built');
});

test('self-update snapshots config before handing off to the installer', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'self-update.mjs'), 'utf8');
  assert.ok(src.includes("snapshotConfig('pre-update')"), 'apply() must snapshot config before the update');
  // The snapshot must happen before the detached updater spawns.
  assert.ok(src.indexOf("snapshotConfig('pre-update')") < src.indexOf('amm-update-'), 'snapshot precedes the updater script');
});

test('pickLatestSnapshot picks the newest valid config snapshot', () => {
  assert.equal(pickLatestSnapshot([]), null);
  assert.equal(pickLatestSnapshot(null), null);
  assert.equal(pickLatestSnapshot(['junk.txt', 'notes.md']), null);
  const names = [
    'config-2026-07-01T07-00-00-000Z-pre-setup.json',
    'config-2026-07-20T09-30-00-000Z-pre-update.json',
    'config-2026-07-13T12-00-00-000Z-pre-delete.json',
    'README.txt', // non-snapshot noise must be ignored
  ];
  assert.equal(pickLatestSnapshot(names), 'config-2026-07-20T09-30-00-000Z-pre-update.json');
});
