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
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// v8.1 (macOS .app): the bundle ships its own Chromium at
// Contents/Resources/ms-playwright so AMM works on a Mac with only Safari
// installed. Playwright locates it through PLAYWRIGHT_BROWSERS_PATH, which
// nothing sets for a Finder launch or a launchd job — so set it here, the
// single chokepoint every Playwright launch already routes through, instead
// of plumbing the variable through the Go wrapper, launchd, and each helper
// script separately. A caller-supplied value always wins.
function useBundledBrowsersOnMac() {
  if (process.platform !== 'darwin' || process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // <bundle>/Contents/Resources/app/scripts
    const resources = path.resolve(here, '..', '..');          // <bundle>/Contents/Resources
    if (path.basename(resources) !== 'Resources') return;      // not a bundle — dev checkout
    const browsers = path.join(resources, 'ms-playwright');
    if (fs.existsSync(browsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  } catch { /* best-effort — fall back to Chrome/Edge detection below */ }
}
useBundledBrowsersOnMac();

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

// v7.8: Playwright launches Chrome with `--enable-automation` by default. That
// switch paints the "Chrome is being controlled by automated test software"
// infobar AND flips navigator.webdriver to true — both of which Cloudflare
// Turnstile reads directly. The result: hiring.cafe's "Verify you are human"
// checkbox spins forever and re-challenges no matter how many times the user
// clicks it, because the browser is self-identifying as a bot before the click
// is ever evaluated. Dropping the switch (alongside the
// --disable-blink-features=AutomationControlled every call site already passes)
// lets the challenge actually clear and persist into the profile.
//
// Every Playwright launch site spreads browserLaunchOptions(), so setting it
// here covers daily-batch, login-once, job-action, dice-login, and
// dice-auth-probe in one place — per the "all launches go through
// resolveBrowser()" rule in CLAUDE.md.
export const IGNORE_DEFAULT_ARGS = ['--enable-automation'];

// Launch-option fragment for a detection result — spread into
// launchPersistentContext options.
export function browserLaunchOptions(detection) {
  const base = { ignoreDefaultArgs: [...IGNORE_DEFAULT_ARGS] };
  if (!detection || detection.kind === 'bundled') return base;
  if (detection.kind === 'channel') return { ...base, channel: detection.channel };
  return { ...base, executablePath: detection.path };
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
    // v2.7: readActiveConfig() copies config.example.json → config.json when
    // the file is missing. During dashboard first-run setup (step 3 launches
    // login-once → resolveBrowser BEFORE setup-init writes the config), that
    // side effect would flip the wrapper's needsSetup mid-flow. No config =
    // no browser override; skip the read entirely.
    const { fileURLToPath } = await import('node:url');
    const cfgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');
    if (!fs.existsSync(cfgPath)) return {};
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
