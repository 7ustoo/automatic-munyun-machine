#!/usr/bin/env node
/**
 * Cross-platform path + binary + scheduler abstraction (v1.1).
 *
 * Every spawn of a system binary, every scheduler call, and every
 * user-facing string that names a setup helper goes through this module.
 * Concrete platform branches are picked at module load via os.platform().
 *
 * Why this exists: v1.0 was Windows-only with ~25 source-code-level
 * couplings to PowerShell + cmd.exe + schtasks + System.Windows.Forms +
 * Inno Setup. v1.1's Mac launchd and Linux systemd ports needed a single
 * abstraction layer instead of 25 conditionals scattered across files.
 *
 * Usage:
 *   import { POWERSHELL, runScheduledTask, LOGIN_HELPER_DOC, npmCmd } from './os-paths.mjs';
 *
 * The Win32 helpers (POWERSHELL, CMD_EXE, SCHTASKS) are still exported on
 * non-Windows platforms — but as `null`. Code paths that need them must
 * gate on `IS_WIN32`, and code paths that should be platform-aware
 * automatically should call the helper functions (runScheduledTask etc.)
 * which internally branch.
 */

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PLATFORM = os.platform();
export const IS_WIN32 = PLATFORM === 'win32';
export const IS_DARWIN = PLATFORM === 'darwin';
export const IS_LINUX = PLATFORM === 'linux';

// ---------- Win32 system binary paths ----------
// Resolved from %SystemRoot% to dodge stripped-PATH installs (v0.4.1 + v0.5
// both shipped bugs from `spawn('powershell', ...)` failing on systems where
// System32 wasn't on PATH).
const SYS32 = IS_WIN32
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  : null;

export const POWERSHELL = IS_WIN32
  ? path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
export const CMD_EXE = IS_WIN32 ? path.join(SYS32, 'cmd.exe') : null;
export const SCHTASKS = IS_WIN32 ? path.join(SYS32, 'schtasks.exe') : null;
export const TIMEOUT_EXE = IS_WIN32 ? path.join(SYS32, 'timeout.exe') : null;

// ---------- POSIX equivalents ----------
// These resolve via PATH using `which`; falls back to common locations if
// `which` returns nothing (containers, minimal images).
function whichSync(binary) {
  try {
    const r = spawnSync(IS_WIN32 ? 'where' : 'which', [binary], {
      encoding: 'utf8', timeout: 2000
    });
    if (r.status === 0) return String(r.stdout).split(/\r?\n/)[0].trim() || null;
  } catch { /* fall through */ }
  return null;
}

const _bash = !IS_WIN32 ? (whichSync('bash') || '/bin/bash') : null;
const _launchctl = IS_DARWIN ? (whichSync('launchctl') || '/bin/launchctl') : null;
const _systemctl = IS_LINUX ? (whichSync('systemctl') || '/usr/bin/systemctl') : null;
const _osascript = IS_DARWIN ? (whichSync('osascript') || '/usr/bin/osascript') : null;
const _zenity = IS_LINUX ? whichSync('zenity') : null;
const _kdialog = IS_LINUX ? whichSync('kdialog') : null;

export const BASH = _bash;
export const LAUNCHCTL = _launchctl;
export const SYSTEMCTL = _systemctl;
export const OSASCRIPT = _osascript;
export const ZENITY = _zenity;
export const KDIALOG = _kdialog;

// ---------- npm / node binaries ----------
// On Windows, npm ships as npm.cmd (not npm.exe) and its location depends
// on the install method (winget, manual download, fnm, etc.). The bot
// historically used `process.platform === 'win32' ? 'npm.cmd' : 'npm'`
// which fails on stripped-PATH; resolve absolutely if possible.
export function npmCmd() {
  if (IS_WIN32) {
    // Try APPDATA first (manual nodejs install adds npm.cmd there), then PATH.
    const appdata = process.env.APPDATA;
    if (appdata) {
      const guess = path.join(appdata, 'npm', 'npm.cmd');
      try {
        const fs = require('node:fs');
        if (fs.existsSync(guess)) return guess;
      } catch {}
    }
    return whichSync('npm.cmd') || whichSync('npm') || 'npm.cmd';
  }
  return whichSync('npm') || 'npm';
}

export function nodeCmd() {
  return whichSync(IS_WIN32 ? 'node.exe' : 'node') || 'node';
}

// ---------- Scheduler abstractions ----------
// The four "munyun-*" jobs map to:
//   Win32:  schtasks /tn munyun-{bot,daily-batch,watchdog,batch-missed}
//   Mac:    launchd  com.amm.{bot,daily,watchdog,batch-missed}
//   Linux:  systemd  munyun-{bot,daily,watchdog,batch-missed}.{service,timer}

const TASK_NAMES = {
  win32: {
    bot: 'munyun-bot',
    daily: 'munyun-daily-batch',
    watchdog: 'munyun-watchdog',
    'batch-missed': 'munyun-batch-missed'
  },
  darwin: {
    bot: 'com.amm.bot',
    daily: 'com.amm.daily',
    watchdog: 'com.amm.watchdog',
    'batch-missed': 'com.amm.batch-missed'
  },
  linux: {
    bot: 'munyun-bot.service',
    daily: 'munyun-daily.timer',
    watchdog: 'munyun-watchdog.timer',
    'batch-missed': 'munyun-batch-missed.timer'
  }
};

// Resolve a logical task name (bot|daily|watchdog|batch-missed) to the
// platform-specific identifier the underlying scheduler expects.
export function taskName(logical) {
  const map = TASK_NAMES[PLATFORM];
  if (!map) throw new Error(`os-paths: unsupported platform ${PLATFORM}`);
  const name = map[logical];
  if (!name) throw new Error(`os-paths: unknown logical task "${logical}"`);
  return name;
}

// Trigger a scheduled task to run NOW. Returns { ok, code, output }.
export function runScheduledTask(logical) {
  const name = taskName(logical);
  if (IS_WIN32) {
    const r = spawnSync(SCHTASKS, ['/run', '/tn', name], {
      encoding: 'utf8', timeout: 15000, windowsHide: true
    });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  if (IS_DARWIN) {
    // launchctl kickstart -k gui/$UID/<label>  → re-runs the agent now
    const r = spawnSync(LAUNCHCTL, ['kickstart', '-k', `gui/${process.getuid()}/${name}`], {
      encoding: 'utf8', timeout: 15000
    });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  if (IS_LINUX) {
    // For .timer units, `systemctl --user start <unit>.service` runs once.
    const svcName = name.replace(/\.timer$/, '.service');
    const r = spawnSync(SYSTEMCTL, ['--user', 'start', svcName], {
      encoding: 'utf8', timeout: 15000
    });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  return { ok: false, code: -1, output: `Unsupported platform: ${PLATFORM}` };
}

// Disable a scheduled task (the morning-batch /pause flow).
export function disableScheduledTask(logical) {
  const name = taskName(logical);
  if (IS_WIN32) {
    const r = spawnSync(POWERSHELL, [
      '-NoProfile', '-Command',
      `Disable-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue`
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  if (IS_DARWIN) {
    const r = spawnSync(LAUNCHCTL, ['disable', `gui/${process.getuid()}/${name}`], {
      encoding: 'utf8', timeout: 15000
    });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  if (IS_LINUX) {
    const r = spawnSync(SYSTEMCTL, ['--user', 'disable', '--now', name], {
      encoding: 'utf8', timeout: 15000
    });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  return { ok: false, code: -1, output: `Unsupported platform: ${PLATFORM}` };
}

export function enableScheduledTask(logical) {
  const name = taskName(logical);
  if (IS_WIN32) {
    const r = spawnSync(POWERSHELL, [
      '-NoProfile', '-Command',
      `Enable-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue`
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  if (IS_DARWIN) {
    const r = spawnSync(LAUNCHCTL, ['enable', `gui/${process.getuid()}/${name}`], {
      encoding: 'utf8', timeout: 15000
    });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  if (IS_LINUX) {
    const r = spawnSync(SYSTEMCTL, ['--user', 'enable', '--now', name], {
      encoding: 'utf8', timeout: 15000
    });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  return { ok: false, code: -1, output: `Unsupported platform: ${PLATFORM}` };
}

// Delete (unregister) a scheduled task. Used by uninstall.
export function deleteScheduledTask(logical) {
  const name = taskName(logical);
  if (IS_WIN32) {
    const r = spawnSync(SCHTASKS, ['/delete', '/tn', name, '/f'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true
    });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  if (IS_DARWIN) {
    // launchctl bootout removes from session; plist file removed by uninstall.mjs
    const r = spawnSync(LAUNCHCTL, ['bootout', `gui/${process.getuid()}/${name}`], {
      encoding: 'utf8', timeout: 10000
    });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  if (IS_LINUX) {
    const r = spawnSync(SYSTEMCTL, ['--user', 'disable', '--now', name], {
      encoding: 'utf8', timeout: 10000
    });
    return { ok: r.status === 0, code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  return { ok: false, code: -1, output: `Unsupported platform: ${PLATFORM}` };
}

// Check whether a scheduled task is registered. Used by /status.
export function scheduledTaskExists(logical) {
  const name = taskName(logical);
  if (IS_WIN32) {
    const r = spawnSync(SCHTASKS, ['/query', '/tn', name, '/fo', 'CSV', '/nh'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true
    });
    return r.status === 0;
  }
  if (IS_DARWIN) {
    const r = spawnSync(LAUNCHCTL, ['print', `gui/${process.getuid()}/${name}`], {
      encoding: 'utf8', timeout: 8000
    });
    return r.status === 0;
  }
  if (IS_LINUX) {
    const r = spawnSync(SYSTEMCTL, ['--user', 'is-enabled', name], {
      encoding: 'utf8', timeout: 8000
    });
    return r.status === 0;
  }
  return false;
}

// ---------- User-facing helper-name strings ----------
// Telegram messages and console output reference setup helpers by name. Pick
// the right string for the running platform so a Mac install doesn't see
// "scripts\login-once.cmd" — which doesn't exist there.

export const LOGIN_HELPER_DOC = IS_WIN32
  ? 'scripts\\login-once.cmd'
  : 'bash scripts/login-once.sh';

export const SETUP_HELPER_DOC = IS_WIN32
  ? 'scripts\\setup-tasks.ps1'
  : (IS_DARWIN ? 'bash scripts/setup-tasks-mac.sh' : 'bash scripts/setup-tasks-linux.sh');

export const RESTART_HINT_DOC = IS_WIN32
  ? 'Re-run scripts\\setup-tasks.ps1 to restore'
  : (IS_DARWIN ? 'Re-run bash scripts/setup-tasks-mac.sh to restore'
                : 'Re-run bash scripts/setup-tasks-linux.sh to restore');

// "where AMM lives" string for the console banner / uninstall message.
// Win32 default is %LOCALAPPDATA%\automatic-munyun-machine.
// Mac/Linux default is ~/.local/share/automatic-munyun-machine (XDG-ish).
export const INSTALL_DIR_HINT = IS_WIN32
  ? '%LOCALAPPDATA%\\automatic-munyun-machine'
  : (IS_DARWIN ? '~/Library/Application Support/automatic-munyun-machine'
                : '~/.local/share/automatic-munyun-machine');

// Quick-verify export — useful for tests + a `node -e "import(...)"` sanity probe.
export function platformSummary() {
  return {
    platform: PLATFORM,
    isWin32: IS_WIN32, isDarwin: IS_DARWIN, isLinux: IS_LINUX,
    powershell: POWERSHELL, cmdExe: CMD_EXE, schtasks: SCHTASKS,
    bash: BASH, launchctl: LAUNCHCTL, systemctl: SYSTEMCTL,
    osascript: OSASCRIPT, zenity: ZENITY, kdialog: KDIALOG,
    npm: npmCmd(), node: nodeCmd(),
    loginHelper: LOGIN_HELPER_DOC, setupHelper: SETUP_HELPER_DOC,
    installDirHint: INSTALL_DIR_HINT
  };
}
