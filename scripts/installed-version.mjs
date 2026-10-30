// Windows upgrades can copy package.json before replacing the running AMM.exe.
// If that final replacement fails, report the older executable version so the
// dashboard still offers the same release as a repair install.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentVersion, semverGt } from './update-checker.mjs';

export function installedVersion({ root, platform = process.platform, packageVersion = currentVersion(), execFile = execFileSync } = {}) {
  if (platform !== 'win32' || !root) return packageVersion;
  try {
    const exe = path.join(root, 'wrapper', 'dist', 'AMM.exe');
    const output = execFile(exe, ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const wrapperVersion = /AMM tray wrapper v(\d+\.\d+\.\d+)/.exec(String(output))?.[1];
    if (wrapperVersion && semverGt(packageVersion, wrapperVersion)) return wrapperVersion;
  } catch {
    // Source checkouts may not have a built wrapper. Keep package.json as the
    // version source in that case.
  }
  return packageVersion;
}
