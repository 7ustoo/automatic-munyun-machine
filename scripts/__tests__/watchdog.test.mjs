// Unit tests for scripts/watchdog.mjs — kill+restart flow, MAX_RESTARTS
// throttle, give-up alert, and the F-M7 fix where transient scheduler
// failures don't burn restart slots.
//
// We use the setHooks injection point in watchdog.mjs to mock killBot,
// startBot, alertTelegram, sleep, and readHeartbeat without spawning
// real PowerShell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

// We need to ensure the watchdog reads its STATE_FILE from a temp dir we
// control. The script resolves STATE_FILE = ROOT/data/watchdog-state.json,
// so we redirect by setting a per-test data dir AND backing up + restoring
// any pre-existing watchdog-state.json.

const STATE_PATH = path.join(ROOT, 'data', 'watchdog-state.json');

// Save and restore real state file so tests don't clobber a live install.
function backupState() {
  if (fs.existsSync(STATE_PATH)) {
    return fs.readFileSync(STATE_PATH);
  }
  return null;
}
function restoreState(buf) {
  if (buf == null) {
    try { fs.unlinkSync(STATE_PATH); } catch {}
  } else {
    fs.writeFileSync(STATE_PATH, buf);
  }
}

const wd = await import('../watchdog.mjs');

test('healthy heartbeat → no kill, no alert', async () => {
  const backup = backupState();
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ restarts: [], gaveUpAt: null }));

    let killed = false, started = false, alerted = false;
    wd.setHooks({
      readHeartbeat: () => ({ ts: new Date().toISOString(), pid: 1234, lastPollOk: true }),
      killBot: () => { killed = true; },
      startBot: () => { started = true; return true; },
      alertTelegram: () => { alerted = true; },
      sleep: () => Promise.resolve()
    });

    const r = await wd.tick();
    assert.equal(r.phase, 'healthy');
    assert.equal(killed, false);
    assert.equal(started, false);
    assert.equal(alerted, false);
  } finally {
    wd.resetHooks();
    restoreState(backup);
  }
});

test('stale heartbeat, restarts < MAX → kill + start + recovery alert', async () => {
  const backup = backupState();
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ restarts: [], gaveUpAt: null }));

    let killed = false, started = false;
    let alertText = '';
    wd.setHooks({
      readHeartbeat: () => ({
        ts: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        pid: 1234, lastPollOk: false
      }),
      killBot: () => { killed = true; },
      startBot: () => { started = true; return true; },
      alertTelegram: (msg) => { alertText = msg; },
      sleep: () => Promise.resolve()
    });

    const r = await wd.tick();
    assert.equal(r.phase, 'restart-issued');
    assert.equal(killed, true);
    assert.equal(started, true);
    assert.equal(r.startedTask, true);
    assert.match(alertText, /recovered/);

    // State should now have one entry in restarts[]
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    assert.equal(state.restarts.length, 1);
    assert.equal(state.gaveUpAt, null);
  } finally {
    wd.resetHooks();
    restoreState(backup);
  }
});

test('F-M7: failed startBot does NOT count toward MAX_RESTARTS', async () => {
  const backup = backupState();
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ restarts: [], gaveUpAt: null }));

    let alertText = '';
    wd.setHooks({
      readHeartbeat: () => ({
        ts: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        pid: 1234, lastPollOk: false
      }),
      killBot: () => {},
      startBot: () => false,            // ← scheduler call failed
      alertTelegram: (msg) => { alertText = msg; },
      sleep: () => Promise.resolve()
    });

    const r = await wd.tick();
    assert.equal(r.startedTask, false);
    // State.restarts MUST stay empty since the restart didn't actually happen.
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    assert.equal(state.restarts.length, 0);
    // But the failed-attempt alert must still fire.
    assert.match(alertText, /scheduler call failed/);
  } finally {
    wd.resetHooks();
    restoreState(backup);
  }
});

test('MAX_RESTARTS reached → no kill, give-up alert sent once', async () => {
  const backup = backupState();
  try {
    // Pre-populate state with 3 recent restart attempts
    const now = Date.now();
    const recent = [now - 10000, now - 20000, now - 30000];
    fs.writeFileSync(STATE_PATH, JSON.stringify({ restarts: recent, gaveUpAt: null }));

    let killed = false, started = false, alertText = '';
    wd.setHooks({
      readHeartbeat: () => ({
        ts: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        pid: 1234, lastPollOk: false
      }),
      killBot: () => { killed = true; },
      startBot: () => { started = true; return true; },
      alertTelegram: (msg) => { alertText = msg; },
      sleep: () => Promise.resolve()
    });

    const r = await wd.tick();
    assert.equal(r.phase, 'gave-up');
    assert.equal(killed, false);
    assert.equal(started, false);
    assert.match(alertText, /won't auto-restart/);
    // gaveUpAt timestamp written
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    assert.ok(state.gaveUpAt);
  } finally {
    wd.resetHooks();
    restoreState(backup);
  }
});

test('give-up alert is suppressed on second consecutive give-up within window', async () => {
  const backup = backupState();
  try {
    const now = Date.now();
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      restarts: [now - 1000, now - 2000, now - 3000],
      gaveUpAt: new Date(now - 60000).toISOString()  // 1 min ago, within 1h window
    }));

    let alertCalls = 0;
    wd.setHooks({
      readHeartbeat: () => ({
        ts: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        pid: 1234, lastPollOk: false
      }),
      killBot: () => {},
      startBot: () => true,
      alertTelegram: () => { alertCalls++; },
      sleep: () => Promise.resolve()
    });

    const r = await wd.tick();
    assert.equal(r.phase, 'gave-up');
    assert.equal(alertCalls, 0);    // suppressed
  } finally {
    wd.resetHooks();
    restoreState(backup);
  }
});

test('pruneRestarts drops timestamps older than RESTART_WINDOW_MS', () => {
  const now = Date.now();
  const old = now - wd.RESTART_WINDOW_MS - 1000;
  const recent = now - 1000;
  const pruned = wd.pruneRestarts([old, recent, old, recent]);
  assert.equal(pruned.length, 2);
  for (const t of pruned) assert.ok(t >= now - wd.RESTART_WINDOW_MS);
});

test('no heartbeat file → return early, no kill', async () => {
  const backup = backupState();
  try {
    let killed = false;
    wd.setHooks({
      readHeartbeat: () => null,
      killBot: () => { killed = true; },
      startBot: () => true,
      alertTelegram: () => {},
      sleep: () => Promise.resolve()
    });
    const r = await wd.tick();
    assert.equal(r.phase, 'no-heartbeat');
    assert.equal(killed, false);
  } finally {
    wd.resetHooks();
    restoreState(backup);
  }
});
