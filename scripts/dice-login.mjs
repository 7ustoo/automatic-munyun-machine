#!/usr/bin/env node
/**
 * Dice.com sign-in window (v7.3) — the login-once.mjs pattern for Dice.
 *
 * Opens the SAME persistent browser profile the scraper uses, lands on
 * dice.com's login page, and waits for the user to sign in and close the
 * window. Signing in is optional (scraping works anonymously) — it makes
 * dice.com apply links open already signed in, so Easy Apply and Dice's own
 * saved/applied tracking work for the user (or their VA).
 *
 * Auth verification happens AFTER this window closes (dice-auth-probe.mjs,
 * spawned by the dashboard's status poll) — never while the user is typing.
 *
 * Usage:
 *   node scripts/dice-login.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowser } from './browser-launcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const profileDir = path.join(ROOT, 'data', 'browser-profile');
fs.mkdirSync(profileDir, { recursive: true });

const browser = await resolveBrowser();

console.log(`Opening ${browser.label} with profile: ${profileDir}`);
console.log('Sign in to Dice in the window that opens, then close the window.');

const ctx = await chromium.launchPersistentContext(profileDir, {
  ...browser.launchOptions,
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=100,100', '--window-size=1280,800'],
  // v7.8: no UA override — see browser-launcher.mjs.
  viewport: { width: 1280, height: 800 }
});

const page = ctx.pages()[0] || await ctx.newPage();
try {
  await page.goto('https://www.dice.com/dashboard/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (e) {
  console.log('initial goto warning (often harmless):', e.message);
}

console.log('Waiting for you to sign in and close the window…');
// Wait for the user to close the window (10-minute cap, same as login-once).
await Promise.race([
  new Promise(resolve => ctx.on('close', resolve)),
  new Promise(resolve => setTimeout(resolve, 600000))
]);
try { await ctx.close(); } catch {}
console.log('Done. Profile persisted.');
process.exit(0);
