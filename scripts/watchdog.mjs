#!/usr/bin/env node
/**
 * Out-of-process watchdog for the Telegram bot.
 *
 * Runs every 5 minutes via Task Scheduler entry `munyun-watchdog`. Reads
 * data/heartbeat.json (written by telegram-bot.mjs every poll iteration).
 * If stale > STALE_THRESHOLD_MS, the bot is dead or hung — kill it, restart
 * the scheduled task, and ping Telegram.
 *
 * Why out-of-process and not an in-bot timer:
 * If the bot OOMs, libuv-asserts, or the Node process disappears from the
 * OS, an in-process child dies with it. An external watcher is the only
 * architecture that catches "bot vanished from the OS" failures.
 *
 * The Telegram alert goes through scripts/telegram-send.mjs as an
 * independent Node process — does NOT import bot code. A corrupt bot
 * module can't take the alerter down with it.
 *
 * Throttling: track restart attempts in data/watchdog-state.json. If
 * 3+ attempts in the last hour, stop trying and send a single "give up,
 * human needed" alert. Don't burn 100 restarts/hour on an unfixable env.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { IS_WIN32, POWERSHELL, runScheduledTask } from './os-paths.mjs';
import { atomicWriteJson } from './io-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const HEARTBEAT_FILE     = path.join(ROOT, 'data', 'heartbeat.json');
const STATE_FILE         = path.join(ROOT, 'data', 'watchdog-state.json');
const SELF_HEARTBEAT     = path.join(ROOT, 'data', 'watchdog-heartbeat.json');
const LOG_FILE           = path.join(ROOT, 'data', 'watchdog.log');
const TELEGRAM_SEND      = path.join(__dirname, 'telegram-send.mjs');

const STALE_THRESHOLD_MS = 10 * 60 * 1000;        // bot heartbeat older than this → dead
const RESTART_WINDOW_MS  = 60 * 60 * 1000;        // sliding window for restart attempts
const MAX_RESTARTS       = 3;                      // before giving up

function log(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, msg + '\n');
  } catch { /* fall through — never let log writes crash the watchdog */ }
}

function writeSelfHeartbeat(extra = {}) {
  try {
    atomicWriteJson(SELF_HEARTBEAT, {
      ts: new Date().toISOString(),
      pid: process.pid,
      ...extra
    });
  } catch { /* ignore */ }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { restarts: [], gaveUpAt: null }; }
}
function writeState(s) {
  try {
    atomicWriteJson(STATE_FILE, s);
  } catch (e) { log(`state write failed: ${e.message}`); }
}

function readHeartbeat() {
  try { return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8')); }
  catch { return null; }
}

// Send a Telegram alert via independent process. Fire-and-forget — we don't
// care about the response; if Telegram itself is down, we'll surface again
// next watchdog tick.
function alertTelegram(text) {
  try {
    const r = spawnSync(process.execPath, [TELEGRAM_SEND, text], {
      stdio: 'ignore',
      timeout: 15000,
      windowsHide: true
    });
    if (r.status !== 0) log(`telegram-send.mjs exit=${r.status}`);
  } catch (e) {
    log(`alertTelegram threw: ${e.message}`);
  }
}

// Kill any running bot process. We try the heartbeat-recorded PID first
// (cleanest), then fall back to a command-line match (handles the case where
// heartbeat is gone or stale-process PID).
function killBot(hb) {
  if (!IS_WIN32) {
    if (!hb?.pid) return;
    try {
      process.kill(hb.pid, 'SIGTERM');
      log(`kill PID ${hb.pid}: SIGTERM sent`);
    } catch (e) {
      if (e.code !== 'ESRCH') log(`kill PID ${hb.pid} failed: ${e.message}`);
    }
    return;
  }

  // Try precise PID kill via PowerShell if heartbeat had one and process exists
  if (hb?.pid) {
    const r = spawnSync(POWERSHELL, [
      '-NoProfile', '-Command',
      `Stop-Process -Id ${hb.pid} -Force -ErrorAction SilentlyContinue`
    ], { stdio: 'ignore', timeout: 10000, windowsHide: true });
    log(`kill PID ${hb.pid} → exit ${r.status}`);
  }

  // Belt-and-suspenders: kill any remaining node process running telegram-bot.mjs.
  // Win32 wmic-style command-line filter via Get-CimInstance.
  // Anchor the match to the actual script filename — bare 'telegram-bot' would
  // also match e.g. an editor process whose CLI happens to include the string
  // (rare in production, but the substring match was unanchored).
  //
  // v1.2: also kill orphaned AMM.exe wrapper processes (whose node child died
  // but the wrapper somehow didn't notice). The wrapper's supervisor should
  // normally handle this, but the watchdog is the last line of defense.
  const cmd = `Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine; if ($cl -match 'telegram-bot\\.mjs' -or $_.ProcessName -eq 'AMM') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } }`;
  const r2 = spawnSync(POWERSHELL, ['-NoProfile', '-Command', cmd], {
    stdio: 'ignore', timeout: 10000, windowsHide: true
  });
  log(`kill orphans → exit ${r2.status}`);
}

function startBot() {
  const scheduled = runScheduledTask('bot');
  const r = { status: scheduled.code };
  log(`scheduler run bot → exit ${r.status}`);
  return scheduled.ok;
}

function pruneRestarts(restarts) {
  const cutoff = Date.now() - RESTART_WINDOW_MS;
  return restarts.filter(t => t > cutoff);
}

// Refactored to an exported tick() so tests can drive the logic without
// running a real PowerShell spawn or hitting the live filesystem layout.
// The CLI behavior at the bottom of the file matches the prior IIFE.
//
// Tests can override the four side-effecting helpers via setHooks():
//   readHeartbeatFn, killBotFn, startBotFn, alertTelegramFn
// — letting them assert the right calls happen in the right order without
// needing to actually fork PowerShell.
let _hooks = {
  readHeartbeat,
  killBot,
  startBot,
  alertTelegram,
  // Sleep is also injectable so the cross-test 2 s pause can collapse to 0.
  sleep: (ms) => new Promise(r => setTimeout(r, ms))
};
export function setHooks(overrides) {
  Object.assign(_hooks, overrides);
}
export function resetHooks() {
  _hooks = { readHeartbeat, killBot, startBot, alertTelegram,
             sleep: (ms) => new Promise(r => setTimeout(r, ms)) };
}

export async function tick() {
  writeSelfHeartbeat({ phase: 'starting' });
  log('--- watchdog tick ---');

  const hb = _hooks.readHeartbeat();
  const now = Date.now();

  if (!hb) {
    log('No heartbeat file. Bot has never run, or data/ was wiped.');
    writeSelfHeartbeat({ phase: 'no-heartbeat-skipping' });
    return { phase: 'no-heartbeat' };
  }

  const hbAge = now - new Date(hb.ts).getTime();
  log(`heartbeat ts=${hb.ts} age=${Math.round(hbAge / 1000)}s pid=${hb.pid} pollOk=${hb.lastPollOk}`);

  if (hbAge < STALE_THRESHOLD_MS) {
    log('healthy — exiting');
    writeSelfHeartbeat({ phase: 'healthy', botHeartbeatAgeMs: hbAge });
    return { phase: 'healthy', hbAge };
  }

  // Stale — bot is dead or hung.
  const state = readState();
  state.restarts = pruneRestarts(state.restarts || []);

  if (state.restarts.length >= MAX_RESTARTS) {
    log(`MAX_RESTARTS reached (${state.restarts.length} in last hour). Holding off.`);
    if (!state.gaveUpAt || (now - new Date(state.gaveUpAt).getTime()) > RESTART_WINDOW_MS) {
      _hooks.alertTelegram(`⛔ Watchdog: bot has crashed ${state.restarts.length}× in the last hour and won't auto-restart again. Check data/telegram-bot.log + data/watchdog.log on the host.`);
      state.gaveUpAt = new Date().toISOString();
      writeState(state);
    }
    writeSelfHeartbeat({ phase: 'gave-up', restarts: state.restarts.length });
    return { phase: 'gave-up', restarts: state.restarts.length };
  }

  log(`restart attempt ${state.restarts.length + 1}/${MAX_RESTARTS}`);
  writeSelfHeartbeat({ phase: 'restarting', attempt: state.restarts.length + 1 });

  _hooks.killBot(hb);
  await _hooks.sleep(2000);
  const started = _hooks.startBot();

  // F-M7: only count successful restart attempts toward MAX_RESTARTS.
  if (started) {
    state.restarts.push(now);
    state.gaveUpAt = null;
  }
  writeState(state);

  const hbAgeMin = Math.round(hbAge / 60000);
  if (started) {
    _hooks.alertTelegram(`📶 Bot recovered after ~${hbAgeMin}m offline. Watchdog restarted munyun-bot. Send /status to verify.`);
  } else {
    _hooks.alertTelegram(`⚠️ Watchdog tried to restart the bot (heartbeat ${hbAgeMin}m stale) but the scheduler call failed. Check the platform's task scheduler manually.`);
  }
  writeSelfHeartbeat({ phase: 'restart-issued', startedTask: started });
  log('done');
  return { phase: 'restart-issued', startedTask: started, restarts: state.restarts.length };
}

// Internals exported for tests.
export { pruneRestarts, readState, writeState, RESTART_WINDOW_MS, MAX_RESTARTS, STALE_THRESHOLD_MS };

// CLI entrypoint — only fires when invoked directly, not on import.
const _thisFile = fileURLToPath(import.meta.url);
const _invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(_thisFile) === _invokedFile) {
  tick().catch(err => { log(`tick failed: ${err.message}`); process.exit(1); });
}
