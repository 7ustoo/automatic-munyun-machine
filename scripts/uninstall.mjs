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
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { IS_WIN32, IS_DARWIN, IS_LINUX, POWERSHELL, SCHTASKS } from './os-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Logical task names — same set on every platform; runtime maps these
// through deleteScheduledTask() for the actual scheduler call. Listed
// here just for the loop-summary log.
const TASKS = ['bot', 'daily', 'watchdog', 'batch-missed'];

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
// then a belt-and-suspenders cmdline match for orphans. Cross-platform.
function killBot() {
  const heartbeat = path.join(ROOT, 'data', 'heartbeat.json');
  let pid = null;
  try { pid = JSON.parse(fs.readFileSync(heartbeat, 'utf8')).pid; } catch {}
  if (pid) {
    if (IS_WIN32) {
      spawnSync(POWERSHELL, ['-NoProfile', '-Command',
        `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
        { stdio: 'ignore', timeout: 10000, windowsHide: true });
    } else {
      // POSIX: kill -9 idempotently
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
    console.log(`  killed PID ${pid}`);
  }
  // Cmdline-match cleanup, branched per platform. v1.2: also kill the
  // AMM.exe / amm-tray wrapper if it's running so uninstall fully cleans up.
  if (IS_WIN32) {
    const cmd = `Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine; if ($cl -match 'telegram-bot\\.mjs|watchdog\\.mjs|batch-missed-watcher\\.mjs|daily-batch\\.mjs' -or $_.ProcessName -eq 'AMM') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } }`;
    spawnSync(POWERSHELL, ['-NoProfile', '-Command', cmd], {
      stdio: 'ignore', timeout: 10000, windowsHide: true
    });
  } else {
    // POSIX: pgrep -f matches the cmdline; pipe to xargs kill. AMM-darwin-*
    // and amm-tray binaries are matched by their basename.
    spawnSync('/bin/sh', ['-c',
      `pgrep -f 'telegram-bot\\.mjs|watchdog\\.mjs|batch-missed-watcher\\.mjs|daily-batch\\.mjs|AMM-darwin|amm-tray' | xargs -r kill -9 2>/dev/null || true`
    ], { stdio: 'ignore', timeout: 10000 });
  }
  console.log('  cleaned bot orphans (incl. tray wrapper)');
}

// 2. Unregister all four scheduler entries — Win32 schtasks, Mac launchd,
// Linux systemd. All idempotent: missing entry is fine.
function unregisterTasks() {
  if (IS_WIN32) {
    const win32Names = ['munyun-bot', 'munyun-daily-batch', 'munyun-watchdog', 'munyun-batch-missed'];
    for (const name of win32Names) {
      const r = spawnSync(SCHTASKS, ['/delete', '/tn', name, '/f'], {
        stdio: 'pipe', timeout: 10000, windowsHide: true
      });
      if (r.status === 0) console.log(`  unregistered: ${name}`);
      else console.log(`  ${name}: not registered (skip)`);
    }
    return;
  }
  if (IS_DARWIN) {
    const labels = ['com.amm.bot', 'com.amm.daily', 'com.amm.watchdog', 'com.amm.batch-missed'];
    const uid = process.getuid?.();
    for (const label of labels) {
      // bootout from gui session
      spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], {
        stdio: 'ignore', timeout: 8000
      });
      // remove plist
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      try { fs.unlinkSync(plist); console.log(`  unregistered: ${label}`); }
      catch (e) {
        if (e.code === 'ENOENT') console.log(`  ${label}: not registered (skip)`);
        else console.log(`  ${label}: ${e.message}`);
      }
    }
    return;
  }
  if (IS_LINUX) {
    const units = ['munyun-bot.service',
                   'munyun-daily.service', 'munyun-daily.timer',
                   'munyun-watchdog.service', 'munyun-watchdog.timer',
                   'munyun-batch-missed.service', 'munyun-batch-missed.timer'];
    for (const unit of units) {
      spawnSync('systemctl', ['--user', 'disable', '--now', unit], {
        stdio: 'ignore', timeout: 8000
      });
      const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', unit);
      try { fs.unlinkSync(unitPath); console.log(`  unregistered: ${unit}`); }
      catch (e) {
        if (e.code === 'ENOENT') console.log(`  ${unit}: not registered (skip)`);
        else console.log(`  ${unit}: ${e.message}`);
      }
    }
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 8000 });
    return;
  }
  console.log(`  Unsupported platform: ${process.platform}`);
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
