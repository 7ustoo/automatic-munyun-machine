#!/usr/bin/env node
/**
 * Opens a visible Chromium with the daily-batch persistent profile,
 * navigates to hiring.cafe, and waits for you to sign in.
 *
 * Usage:
 *   node scripts/login-once.mjs
 *
 * Sign in with Google. Once you're back on the hiring.cafe home page,
 * close the window. Your session is now stored in data/browser-profile/
 * and every future daily-batch run is logged in as you.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const profileDir = path.join(ROOT, 'data', 'browser-profile');
fs.mkdirSync(profileDir, { recursive: true });

console.log(`Opening visible Chromium with profile: ${profileDir}`);
console.log('Sign into hiring.cafe via Google SSO, then close the window.');

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: ['--no-sandbox'],
  viewport: { width: 1280, height: 800 }
});

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://hiring.cafe/', { waitUntil: 'domcontentloaded' });

// Wait until the user closes the browser
await new Promise(resolve => ctx.on('close', resolve));
console.log('Browser closed. Login session persisted.');
process.exit(0);
