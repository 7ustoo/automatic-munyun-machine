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
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
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
