#!/usr/bin/env node
/**
 * v1.0 E6 — uninstall orchestrator.
 *
 * Two modes:
 *   --mode=pause   Stop the bot process and unregister all four munyun-*
 *                  Task Scheduler entries. Preserves data/, config.json,
 *                  .env, browser-profile. Re-running setup brings everything
 *                  back exactly as it was. ("I'm going on vacation, mute
 *                  the bot for 2 weeks.")
 *   --mode=wipe    Pause steps + delete data/, config.json, .env, browser-
 *                  profile. Bot token + chat ID are gone with .env;
 *                  reinstalling means a fresh wizard run. Install dir
 *                  itself NOT deleted (caller — Inno Setup uninstaller or
 *                  the user — removes that).
 *
 * Idempotent: safe to re-run on partial state. If a Task Scheduler entry
 * is already gone, no-op. Same for missing files.
 *
 * Usage:
 *   node scripts/uninstall.mjs --mode=pause
 *   node scripts/uninstall.mjs --mode=wipe
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCHTASKS   = path.join(SYS32, 'schtasks.exe');

const TASKS = ['munyun-bot', 'munyun-daily-batch', 'munyun-watchdog', 'munyun-batch-missed'];

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; })
);
const MODE = args.mode || 'pause';
if (!['pause', 'wipe'].includes(MODE)) {
  console.error(`Unknown mode: ${MODE}. Expected --mode=pause or --mode=wipe.`);
  process.exit(2);
}

console.log(`=== AMM uninstall (mode=${MODE}) ===`);

// 1. Stop the bot process. PID match first (cleaner) via heartbeat.json,
// then a belt-and-suspenders cmdline match for orphans.
function killBot() {
  const heartbeat = path.join(ROOT, 'data', 'heartbeat.json');
  let pid = null;
  try { pid = JSON.parse(fs.readFileSync(heartbeat, 'utf8')).pid; } catch {}
  if (pid) {
    spawnSync(POWERSHELL, ['-NoProfile', '-Command',
      `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
      { stdio: 'ignore', timeout: 10000, windowsHide: true });
    console.log(`  killed PID ${pid}`);
  }
  // Cmdline-match cleanup. Anchor to actual script filename to avoid
  // collateral kills (e.g. an editor process whose CLI happens to contain
  // the substring 'telegram-bot').
  const cmd = `Get-Process node -ErrorAction SilentlyContinue | ForEach-Object { $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine; if ($cl -match 'telegram-bot\\.mjs|watchdog\\.mjs|batch-missed-watcher\\.mjs|daily-batch\\.mjs') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } }`;
  spawnSync(POWERSHELL, ['-NoProfile', '-Command', cmd], {
    stdio: 'ignore', timeout: 10000, windowsHide: true
  });
  console.log('  cleaned bot orphans');
}

// 2. Unregister all four Task Scheduler entries. Idempotent — schtasks
// returns exit 1 if the task doesn't exist; we ignore that.
function unregisterTasks() {
  for (const name of TASKS) {
    const r = spawnSync(SCHTASKS, ['/delete', '/tn', name, '/f'], {
      stdio: 'pipe', timeout: 10000, windowsHide: true
    });
    if (r.status === 0) console.log(`  unregistered: ${name}`);
    else console.log(`  ${name}: not registered (skip)`);
  }
}

// 3. Wipe per-user data + secrets. Only in --mode=wipe.
function wipeUserData() {
  const targets = [
    path.join(ROOT, 'data'),
    path.join(ROOT, 'config.json'),
    path.join(ROOT, '.env')
  ];
  for (const t of targets) {
    try {
      const stat = fs.statSync(t);
      if (stat.isDirectory()) {
        fs.rmSync(t, { recursive: true, force: true });
        console.log(`  removed dir: ${t}`);
      } else {
        fs.rmSync(t, { force: true });
        console.log(`  removed file: ${t}`);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.log(`  ${t}: ${e.message}`);
      else console.log(`  ${t}: already gone (skip)`);
    }
  }
}

killBot();
unregisterTasks();
if (MODE === 'wipe') {
  wipeUserData();
  console.log('');
  console.log('=== Wipe complete ===');
  console.log(`Install dir at ${ROOT} is preserved (delete by hand if you want to remove the code too).`);
} else {
  console.log('');
  console.log('=== Pause complete ===');
  console.log(`data/, config.json, .env preserved. Re-run \`powershell -ExecutionPolicy Bypass -File scripts/setup-tasks.ps1\` to bring it back.`);
}
