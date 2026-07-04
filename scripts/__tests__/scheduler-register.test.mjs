// node --test scripts/__tests__/scheduler-register.test.mjs
// v2.7: pure-function tests for the scheduler-register platform selector.
// Confirms the right script gets targeted per platform without actually
// spawning schtasks / launchctl / systemctl. registerSchedulerForPlatform()
// itself IS the spawn — untested here, tested end-to-end via the wizard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { schedulerCommandForPlatform } from '../scheduler-register.mjs';

test('Windows targets setup-tasks.ps1 with the expected PS flags', () => {
  const r = schedulerCommandForPlatform('win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(r, 'command shape should be non-null on win32');
  assert.equal(r.target, 'setup-tasks.ps1');
  assert.equal(r.cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(r.args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.ok(r.args[4].endsWith('setup-tasks.ps1'), `args should end in setup-tasks.ps1, got ${r.args[4]}`);
});

test('macOS targets setup-tasks-mac.sh via bash', () => {
  const r = schedulerCommandForPlatform('darwin');
  assert.ok(r);
  assert.equal(r.target, 'setup-tasks-mac.sh');
  assert.equal(r.cmd, 'bash');
  assert.equal(r.args.length, 1);
  assert.ok(r.args[0].endsWith('setup-tasks-mac.sh'));
});

test('Linux targets setup-tasks-linux.sh via bash', () => {
  const r = schedulerCommandForPlatform('linux');
  assert.ok(r);
  assert.equal(r.target, 'setup-tasks-linux.sh');
  assert.equal(r.cmd, 'bash');
  assert.equal(r.args.length, 1);
  assert.ok(r.args[0].endsWith('setup-tasks-linux.sh'));
});

test('Unknown platforms return null', () => {
  assert.equal(schedulerCommandForPlatform('freebsd'), null);
  assert.equal(schedulerCommandForPlatform('sunos'), null);
  assert.equal(schedulerCommandForPlatform(''), null);
});

test('Script paths are absolute (not relative to cwd)', () => {
  const r = schedulerCommandForPlatform('linux');
  // path.isAbsolute is the right primitive; a relative path would break
  // under a `spawn(..., { cwd: ROOT })` when ROOT differs from the caller's cwd.
  assert.ok(path.isAbsolute(r.args[0]), `path should be absolute: ${r.args[0]}`);
});
