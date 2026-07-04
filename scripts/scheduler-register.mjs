#!/usr/bin/env node
/**
 * v2.7: cross-platform scheduler registration.
 *
 * Extracted from setup-wizard.mjs so the dashboard-driven setup flow can
 * register scheduled tasks without going through the terminal wizard.
 * Both the wizard and dashboard-api's setup-finalize subcommand import from
 * here; the platform scripts themselves (setup-tasks.ps1 / setup-tasks-mac.sh /
 * setup-tasks-linux.sh) are unchanged.
 *
 * Returns { code, out } — code=0 on success, non-zero on failure.
 * Reads schedule.time + schedule.days from config.json itself (via each
 * platform script), so callers must have written config.json first.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IS_WIN32, IS_DARWIN, IS_LINUX, POWERSHELL } from './os-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

export function registerSchedulerForPlatform() {
  return new Promise((resolve) => {
    let cmd, args;
    if (IS_WIN32) {
      cmd = POWERSHELL;
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'setup-tasks.ps1')];
    } else if (IS_DARWIN) {
      cmd = 'bash';
      args = [path.join(__dirname, 'setup-tasks-mac.sh')];
    } else if (IS_LINUX) {
      cmd = 'bash';
      args = [path.join(__dirname, 'setup-tasks-linux.sh')];
    } else {
      return resolve({ code: -1, out: `Unsupported platform: ${process.platform}` });
    }
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('exit', code => resolve({ code, out }));
    child.on('error', e => resolve({ code: -1, out: 'spawn failed: ' + e.message }));
  });
}

// Pure selector — same platform branch as registerSchedulerForPlatform() but
// returns the command shape without spawning. Exported for testability: unit
// tests mock process.platform and confirm the correct target script is picked
// without invoking schtasks / launchctl / systemctl for real.
export function schedulerCommandForPlatform(platform = process.platform, powershell = POWERSHELL) {
  const scriptsDir = __dirname;
  if (platform === 'win32') {
    return {
      cmd: powershell,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsDir, 'setup-tasks.ps1')],
      target: 'setup-tasks.ps1'
    };
  }
  if (platform === 'darwin') {
    return { cmd: 'bash', args: [path.join(scriptsDir, 'setup-tasks-mac.sh')], target: 'setup-tasks-mac.sh' };
  }
  if (platform === 'linux') {
    return { cmd: 'bash', args: [path.join(scriptsDir, 'setup-tasks-linux.sh')], target: 'setup-tasks-linux.sh' };
  }
  return null;
}
