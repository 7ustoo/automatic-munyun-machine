#!/usr/bin/env node
/**
 * System-browser resolution for the Playwright launch sites (v2.0.1).
 *
 * AMM used to require Playwright's bundled Chromium — a ~150 MB download
 * during install that was the single slowest (and most hang-prone) setup
 * step. But playwright-core can drive any installed Chromium-family
 * browser via the `channel` launch option, and every Windows machine
 * ships with Edge. So: prefer the user's Chrome, then Edge, then the
 * bundled Chromium (if it was ever downloaded), and only error — with
 * instructions — when none of those exist.
 *
 * IMPORTANT: this only borrows the browser BINARY. All launch sites keep
 * using AMM's own persistent profile (data/browser-profile), so the
 * user's personal tabs/cookies/sessions are never touched, and AMM runs
 * fine while their own Chrome is open. (Unlike v0.1's CDP-attach
 * approach, no debug port and no shared profile are involved.)
 *
 * Config override (per-profile, config.json):
 *   "browser": { "channel": "auto" | "chrome" | "msedge",
 *                "executablePath": "C:\\path\\to\\any\\chromium.exe" }
 *
 * Used by: daily-batch.mjs, job-action.mjs, login-once.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Candidate install locations per platform. Detection is exists()-based
// (not registry/PATH) so it's fast, dependency-free, and unit-testable.
function chromeCandidates(platform, env) {
  if (platform === 'win32') {
    return [
      env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
}

function edgeCandidates(platform, env) {
  if (platform === 'win32') {
    return [
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  return ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
}

// Linux distro chromium has no Playwright channel name — drive it via
// executablePath instead.
function linuxChromiumCandidates() {
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

/**
 * Decide which browser to launch. Pure given its inputs — tests inject
 * exists/platform/env/bundledPath.
 *
 * @returns {{kind:'channel',channel:string,label:string}
 *         | {kind:'executablePath',path:string,label:string}
 *         | {kind:'bundled',label:string}
 *         | null}  null = nothing usable found
 */
export function detectBrowser({
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
  bundledPath = null,
  cfg = {}
} = {}) {
  // 1. Explicit executable wins (Brave, distro chromium, portable installs).
  if (cfg.executablePath) {
    if (exists(cfg.executablePath)) {
      return { kind: 'executablePath', path: cfg.executablePath, label: `custom (${cfg.executablePath})` };
    }
    // Configured but missing — fall through to auto rather than hard-fail,
    // the scraper erroring on a typo'd path helps nobody at 7am.
  }

  // 2. Forced channel — trust the user, Playwright errors clearly if absent.
  if (cfg.channel && cfg.channel !== 'auto') {
    return { kind: 'channel', channel: cfg.channel, label: `forced channel "${cfg.channel}"` };
  }

  // 3. Auto: Chrome → Edge → (Linux) distro chromium → bundled Chromium.
  if (chromeCandidates(platform, env).some(p => exists(p))) {
    return { kind: 'channel', channel: 'chrome', label: 'installed Google Chrome' };
  }
  if (edgeCandidates(platform, env).some(p => exists(p))) {
    return { kind: 'channel', channel: 'msedge', label: 'installed Microsoft Edge' };
  }
  if (platform === 'linux') {
    const p = linuxChromiumCandidates().find(c => exists(c));
    if (p) return { kind: 'executablePath', path: p, label: `distro chromium (${p})` };
  }
  if (bundledPath && exists(bundledPath)) {
    return { kind: 'bundled', label: "Playwright's downloaded Chromium" };
  }
  return null;
}

// Launch-option fragment for a detection result — spread into
// launchPersistentContext options.
export function browserLaunchOptions(detection) {
  if (!detection || detection.kind === 'bundled') return {};
  if (detection.kind === 'channel') return { channel: detection.channel };
  return { executablePath: detection.path };
}

// Where Playwright would look for its own downloaded Chromium. Throws in
// some playwright-core versions when the registry is unhappy — treat any
// failure as "not available."
function bundledChromiumPath() {
  try {
    const p = chromium.executablePath();
    return p || null;
  } catch {
    return null;
  }
}

// Read the active profile's browser config without forcing every caller
// to know about profile-store. Missing/legacy/broken config → {}.
async function readBrowserCfg() {
  try {
    const { readActiveConfig } = await import('./profile-store.mjs');
    return readActiveConfig().browser || {};
  } catch {
    return {};
  }
}

/**
 * Resolve the browser for a launch site. Returns
 *   { launchOptions, label, detection }
 * or throws a user-actionable Error when no browser exists at all.
 */
export async function resolveBrowser() {
  const cfg = await readBrowserCfg();
  const detection = detectBrowser({ cfg, bundledPath: bundledChromiumPath() });
  if (!detection) {
    throw new Error(
      'No usable browser found. AMM needs Google Chrome or Microsoft Edge installed ' +
      '(it uses its own separate profile — your browsing is untouched), or Playwright\'s ' +
      'Chromium: npx playwright install chromium'
    );
  }
  return { launchOptions: browserLaunchOptions(detection), label: detection.label, detection };
}
