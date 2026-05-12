#!/usr/bin/env node
/**
 * Cloudflare warmup for the daily-batch persistent profile.
 *
 * v1.0.x: replaced the Google sign-in dance with a passive Cloudflare
 * challenge clearance. Hiring.cafe lets you browse jobs without an account;
 * the only blocker for headless scrapes was Cloudflare's bot challenge,
 * which auto-resolves after ~20 seconds when a real browser visits the
 * page. We just open the page in a visible window, wait until job cards
 * render, and save the profile.
 *
 * No login required. No Google. The user is told to wait for cards and
 * close the window — that's it.
 *
 * Usage:
 *   node scripts/login-once.mjs
 *
 * If you ALSO want hiring.cafe-side bookmarking via /save and /applied,
 * sign into hiring.cafe (with whatever account method) inside the open
 * window before closing it. That's optional.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const profileDir = path.join(ROOT, 'data', 'browser-profile');
fs.mkdirSync(profileDir, { recursive: true });

const WARMUP_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS  = 2000;

console.log(`Opening Chromium with profile: ${profileDir}`);
console.log('Wait until you see job listings on hiring.cafe (~20–30 seconds), then');
console.log("close the window. The bot does NOT need you to log in — Cloudflare's");
console.log('bot challenge is what we are clearing here.');

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=100,100', '--window-size=1280,800'],
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 }
});

const page = ctx.pages()[0] || await ctx.newPage();
let cleared = false;
const start = Date.now();
try {
  await page.goto('https://hiring.cafe/', { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (e) {
  console.log('initial goto warning (often harmless under CF):', e.message);
}

// Poll until cards render OR the user closes the window OR timeout.
while (Date.now() - start < WARMUP_TIMEOUT_MS) {
  let count = 0;
  try { count = await page.locator('a[href*="viewjob"]').count(); } catch { /* nav in progress */ }
  if (count > 0) {
    console.log(`✓ Cloudflare cleared after ${Math.round((Date.now() - start)/1000)}s — ${count} job cards visible.`);
    cleared = true;
    break;
  }
  await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => {});
}

if (!cleared) {
  console.log(`⚠️  After ${WARMUP_TIMEOUT_MS/1000}s no cards rendered. Cloudflare may need more time, or your network is blocking. Leaving the window open — close it whenever ready and re-run if scraping still fails.`);
}

console.log('You can close the window now. Profile saved to disk.');
// Wait for user to close the window (or auto-close after another 60s if cleared)
await Promise.race([
  new Promise(resolve => ctx.on('close', resolve)),
  new Promise(resolve => setTimeout(resolve, cleared ? 60000 : 600000))
]);
try { await ctx.close(); } catch {}
console.log('Done. Profile persisted.');
process.exit(0);
