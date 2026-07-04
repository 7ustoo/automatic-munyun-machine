#!/usr/bin/env node
/**
 * Dashboard-driven self-update (v2.5).
 *
 * The dashboard's update banner execs this. Two subcommands, each prints ONE
 * line of JSON (the wrapper relays it):
 *
 *   info   → { ok, current, latest, hasUpdate, installerUrl, notes, canAutoUpdate }
 *   apply  → { ok, started, installer }   downloads + launches the installer
 *
 * Windows is the only platform with a seamless story: the release ships an
 * Inno Setup `amm-setup-<ver>.exe` that runs per-user (no UAC), stops the
 * running AMM, upgrades in place, and relaunches. `apply` downloads it and
 * spawns a DETACHED updater (a cmd script that survives AMM being killed):
 *   run the installer /VERYSILENT, then relaunch AMM.exe.
 *
 * macOS/Linux ship a .dmg/.deb/.AppImage with no silent-install convention,
 * so `apply` there just opens the releases page (canAutoUpdate:false) and the
 * banner links out instead of auto-installing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { currentVersion, semverGt } from './update-checker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REPO = '7ustoo/automatic-munyun-machine';
const IS_WIN = process.platform === 'win32';

function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

// The release asset that self-installs on THIS platform. Windows only, by
// design — see the file header.
function installerAssetFor(assets) {
  if (!IS_WIN) return null;
  return (assets || []).find(a => /^amm-setup-.*\.exe$/i.test(a.name)) || null;
}

async function fetchLatestRelease() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=5`, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': `amm/${currentVersion()}`, 'Accept': 'application/vnd.github+json' }
  });
  if (!r.ok) throw new Error('GitHub releases API HTTP ' + r.status);
  const rels = await r.json();
  if (!Array.isArray(rels) || !rels.length) return null;
  return rels[0];
}

async function info() {
  const current = currentVersion();
  let rel;
  try { rel = await fetchLatestRelease(); }
  catch (e) { return out({ ok: false, error: String(e.message || e), current }); }
  if (!rel) return out({ ok: true, current, latest: current, hasUpdate: false });
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const asset = installerAssetFor(rel.assets);
  out({
    ok: true,
    current,
    latest,
    hasUpdate: !!latest && semverGt(latest, current),
    installerUrl: asset ? asset.browser_download_url : '',
    installerName: asset ? asset.name : '',
    releaseUrl: rel.html_url || `https://github.com/${REPO}/releases`,
    notes: String(rel.body || '').slice(0, 1200),
    canAutoUpdate: IS_WIN && !!asset
  });
}

async function downloadTo(url, destPath) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180000), redirect: 'follow' });
  if (!r.ok) throw new Error('download HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100000) throw new Error('downloaded installer looks too small (' + buf.length + ' bytes)');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

async function apply() {
  const current = currentVersion();
  let rel;
  try { rel = await fetchLatestRelease(); }
  catch (e) { return out({ ok: false, error: 'Could not reach GitHub: ' + String(e.message || e) }); }
  const latest = rel ? String(rel.tag_name || '').replace(/^v/, '') : current;
  if (!rel || !semverGt(latest, current)) return out({ ok: false, error: 'Already on the latest version (v' + current + ').' });

  const asset = installerAssetFor(rel.assets);
  if (!IS_WIN || !asset) {
    // No silent installer on this platform — hand back the releases page.
    return out({ ok: false, canAutoUpdate: false, releaseUrl: rel.html_url, error: 'Automatic install is Windows-only. Download the update from the releases page.' });
  }

  const dest = path.join(ROOT, 'data', 'update', asset.name);
  try {
    const bytes = await downloadTo(asset.browser_download_url, dest);
    process.stderr.write(`downloaded ${bytes} bytes → ${dest}\n`);
  } catch (e) {
    return out({ ok: false, error: 'Download failed: ' + String(e.message || e) });
  }

  // Detached updater: a cmd script that OUTLIVES this process AND the AMM
  // wrapper the installer is about to kill. It waits a beat, runs the
  // installer silently (per-user, no UAC), then relaunches AMM. Written to
  // temp so it isn't clobbered by the in-place upgrade.
  const ammExe = path.join(ROOT, 'wrapper', 'dist', 'AMM.exe');
  const logPath = path.join(ROOT, 'data', 'update', 'update.log');
  const bat = [
    '@echo off',
    'echo [%date% %time%] AMM auto-update starting >> "' + logPath + '"',
    // Give the dashboard response + AMM a moment to settle before the
    // installer kills the running instance.
    'ping 127.0.0.1 -n 3 >nul',
    '"' + dest + '" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART >> "' + logPath + '" 2>&1',
    'echo [%date% %time%] installer exit %errorlevel% >> "' + logPath + '"',
    // Relaunch the freshly-installed AMM (foreground window, as if
    // double-clicked). The installer replaced AMM.exe in place.
    'ping 127.0.0.1 -n 2 >nul',
    'start "" "' + ammExe + '"',
    'echo [%date% %time%] relaunched AMM >> "' + logPath + '"'
  ].join('\r\n');
  const batPath = path.join(os.tmpdir(), 'amm-update-' + process.pid + '.cmd');
  fs.writeFileSync(batPath, bat);

  const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const child = spawn(path.join(SYS32, 'cmd.exe'), ['/c', batPath], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();

  out({ ok: true, started: true, installer: asset.name, from: current, to: latest });
}

const sub = process.argv[2];
(async () => {
  if (sub === 'info') return info();
  if (sub === 'apply') return apply();
  out({ ok: false, error: 'usage: self-update.mjs <info|apply>' });
  process.exit(2);
})().catch(e => { out({ ok: false, error: String(e.message || e) }); process.exit(1); });
