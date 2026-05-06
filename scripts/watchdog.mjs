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
import { spawn, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const HEARTBEAT_FILE     = path.join(ROOT, 'data', 'heartbeat.json');
const STATE_FILE         = path.join(ROOT, 'data', 'watchdog-state.json');
const SELF_HEARTBEAT     = path.join(ROOT, 'data', 'watchdog-heartbeat.json');
const LOG_FILE           = path.join(ROOT, 'data', 'watchdog.log');
const TELEGRAM_SEND      = path.join(__dirname, 'telegram-send.mjs');

const SYS32              = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL         = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCHTASKS           = path.join(SYS32, 'schtasks.exe');

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
    fs.writeFileSync(SELF_HEARTBEAT, JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...extra
    }, null, 2));
  } catch { /* ignore */ }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { restarts: [], gaveUpAt: null }; }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
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
    const r = spawnSync('node', [TELEGRAM_SEND, text], {
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
  const cmd = `Get-Process node -ErrorAction SilentlyContinue | ForEach-Object { $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine; if ($cl -match 'telegram-bot') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } }`;
  const r2 = spawnSync(POWERSHELL, ['-NoProfile', '-Command', cmd], {
    stdio: 'ignore', timeout: 10000, windowsHide: true
  });
  log(`kill orphans → exit ${r2.status}`);
}

function startBot() {
  const r = spawnSync(SCHTASKS, ['/run', '/tn', 'munyun-bot'], {
    stdio: 'pipe', timeout: 15000, windowsHide: true
  });
  log(`schtasks /run munyun-bot → exit ${r.status}`);
  return r.status === 0;
}

function pruneRestarts(restarts) {
  const cutoff = Date.now() - RESTART_WINDOW_MS;
  return restarts.filter(t => t > cutoff);
}

(async () => {
  writeSelfHeartbeat({ phase: 'starting' });
  log('--- watchdog tick ---');

  const hb = readHeartbeat();
  const now = Date.now();

  if (!hb) {
    log('No heartbeat file. Bot has never run, or data/ was wiped.');
    writeSelfHeartbeat({ phase: 'no-heartbeat-skipping' });
    return;
  }

  const hbAge = now - new Date(hb.ts).getTime();
  log(`heartbeat ts=${hb.ts} age=${Math.round(hbAge / 1000)}s pid=${hb.pid} pollOk=${hb.lastPollOk}`);

  if (hbAge < STALE_THRESHOLD_MS) {
    log('healthy — exiting');
    writeSelfHeartbeat({ phase: 'healthy', botHeartbeatAgeMs: hbAge });
    return;
  }

  // Stale — bot is dead or hung.
  const state = readState();
  state.restarts = pruneRestarts(state.restarts || []);

  if (state.restarts.length >= MAX_RESTARTS) {
    log(`MAX_RESTARTS reached (${state.restarts.length} in last hour). Holding off.`);
    if (!state.gaveUpAt || (now - new Date(state.gaveUpAt).getTime()) > RESTART_WINDOW_MS) {
      // First "give up" of this hour-window — alert once.
      alertTelegram(`⛔ Watchdog: bot has crashed ${state.restarts.length}× in the last hour and won't auto-restart again. Check data/telegram-bot.log + data/watchdog.log on the host.`);
      state.gaveUpAt = new Date().toISOString();
      writeState(state);
    }
    writeSelfHeartbeat({ phase: 'gave-up', restarts: state.restarts.length });
    return;
  }

  log(`restart attempt ${state.restarts.length + 1}/${MAX_RESTARTS}`);
  writeSelfHeartbeat({ phase: 'restarting', attempt: state.restarts.length + 1 });

  killBot(hb);
  // Brief pause so the OS can reap the killed process
  await new Promise(r => setTimeout(r, 2000));
  const started = startBot();

  state.restarts.push(now);
  state.gaveUpAt = null; // reset give-up flag on successful restart attempt
  writeState(state);

  const hbAgeMin = Math.round(hbAge / 60000);
  if (started) {
    alertTelegram(`📶 Bot recovered after ~${hbAgeMin}m offline. Watchdog restarted munyun-bot. Send /status to verify.`);
  } else {
    alertTelegram(`⚠️ Watchdog tried to restart the bot (heartbeat ${hbAgeMin}m stale) but <code>schtasks /run</code> failed. Check Task Scheduler manually.`);
  }
  writeSelfHeartbeat({ phase: 'restart-issued', startedTask: started });
  log('done');
})();
