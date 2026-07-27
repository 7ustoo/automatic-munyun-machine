#!/usr/bin/env node
/**
 * Dice sign-in probe (v7.3) — headless check of the persistent profile.
 *
 * The dice.com counterpart of job-action.mjs's `auth` action: launches the
 * shared browser profile headless, asks dice-session.mjs whether /home-feed
 * survives without a login redirect, refreshes data/dice-auth.json, and exits
 * 0 (signed in) or 1 (signed out / error). Spawned by dashboard-api's
 * dice-login-status and dice-auth-check.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowser } from './browser-launcher.mjs';
import { isDiceSignedIn, writeDiceAuthCache } from './dice-session.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const profileDir = path.join(ROOT, 'data', 'browser-profile');

let ctx;
try {
  const browser = await resolveBrowser();
  ctx = await chromium.launchPersistentContext(profileDir, {
    ...browser.launchOptions,
    // v7.8: headful-but-off-screen instead of headless. Headless Chrome puts
    // "HeadlessChrome" in its own user agent, and the old fix for that was a
    // hardcoded UA that then contradicted Chrome's Sec-CH-UA client hints —
    // two bot signals stacked. Parking the window at 10000,10000 (the same
    // trick daily-batch uses for unattended scrapes) keeps the probe invisible
    // while the browser stays completely ordinary.
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-position=10000,10000',
      '--window-size=1280,800'
    ],
    viewport: { width: 1280, height: 800 }
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const authed = await isDiceSignedIn(page);
  writeDiceAuthCache(authed);
  console.log(authed ? 'dice: signed in' : 'dice: signed out');
  await ctx.close().catch(() => {});
  process.exit(authed ? 0 : 1);
} catch (e) {
  writeDiceAuthCache(false);
  console.error('dice probe failed:', String(e?.message || e));
  try { await ctx?.close(); } catch {}
  process.exit(1);
}
