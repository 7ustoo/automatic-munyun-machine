import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Windows scheduled jobs route through GUI-subsystem AMM.exe', () => {
  const ps = read('scripts/setup-tasks.ps1');
  for (const task of ['daily', 'watchdog', 'batch-missed']) {
    assert.ok(ps.includes(`-Execute $WRAPPER_EXE -Argument '--scheduled-task=${task}'`),
      `${task} must launch through AMM.exe`);
  }
});

test('Windows upgrades silently rewrite legacy scheduled tasks', () => {
  const iss = read('installer/amm.iss');
  const migration = iss.slice(iss.indexOf('; v8.3: migrate existing Task Scheduler entries'));
  assert.ok(migration.includes('scripts\\setup-tasks.ps1'), 'upgrade must run task registration');
  assert.ok(migration.includes('Check: HasConfig'), 'fresh installs must wait for dashboard setup');
  assert.ok(migration.includes('Flags: runhidden waituntilterminated'), 'migration PowerShell must stay hidden');
});

test('browser sign-in launchers hide Node while leaving Chromium visible', () => {
  const dashboard = read('scripts/dashboard-api.mjs');
  assert.ok(!/login-once\.mjs[\s\S]{0,220}windowsHide:\s*false/.test(dashboard));
  assert.ok(!/dice-login\.mjs[\s\S]{0,220}windowsHide:\s*false/.test(dashboard));
  const telegram = read('scripts/telegram-bot.mjs');
  const reauth = telegram.slice(telegram.indexOf("if (/^\\/?reauth"), telegram.indexOf('// /save N'));
  assert.ok(reauth.includes('login-once.mjs'));
  assert.ok(reauth.includes('windowsHide: true'));
  assert.ok(!reauth.includes('login-once.cmd'));
});

test('Windows toast PowerShell receives CREATE_NO_WINDOW policy', () => {
  const notify = read('wrapper/notify.go');
  assert.match(notify, /exec\.Command\(pwsh,[\s\S]*applyChildHideWindow\(cmd\)[\s\S]*cmd\.Run\(\)/);
});
