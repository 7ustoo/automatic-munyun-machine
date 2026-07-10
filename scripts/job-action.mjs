#!/usr/bin/env node
/**
 * Performs an action on a single hiring.cafe job using the bot's logged-in profile.
 *
 * Usage:
 *   node scripts/job-action.mjs save    https://hiring.cafe/viewjob/<id>
 *   node scripts/job-action.mjs applied https://hiring.cafe/viewjob/<id>
 *   node scripts/job-action.mjs auth     (just verifies login and reports)
 *
 * Exit code 0 on success. On failure prints a short reason to stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowser } from './browser-launcher.mjs';
import { isSignedIn } from './hcafe-session.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const [, , action, jobUrl] = process.argv;
if (!action || (action !== 'auth' && !jobUrl)) {
  console.error('usage: node job-action.mjs <save|applied|auth> [url]');
  process.exit(2);
}

const profileDir = path.join(ROOT, 'data', 'browser-profile');
// v2.0.1: user's installed Chrome/Edge preferred over bundled Chromium —
// same browser the scraper uses, same AMM-private profile dir.
const browser = await resolveBrowser();
const ctx = await chromium.launchPersistentContext(profileDir, {
  ...browser.launchOptions,
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--window-position=10000,10000',
    '--window-size=1280,800'
  ],
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
});
const page = ctx.pages()[0] || await ctx.newPage();

// v4.3: probe extracted to hcafe-session.mjs so the scraper shares it.
const checkAuth = () => isSignedIn(page);

try {
  if (action === 'auth') {
    const ok = await checkAuth();
    console.log(ok ? 'AUTH_OK' : 'AUTH_FAIL');
    process.exit(ok ? 0 : 1);
  }

  // v1.0.x: auth is OPTIONAL. If not signed into hiring.cafe, we exit with
  // a benign "skip" code so the bot can record the action locally without
  // failing loudly. Users who want hiring.cafe-side bookmarking run /reauth.
  if (!await checkAuth()) {
    console.log('AUTH_OPTIONAL not signed in — bot will record locally only');
    process.exit(7); // bot interprets 7 as "skip hiring.cafe action, succeed locally"
  }

  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Hiring.cafe button text varies. Try several selectors per action.
  const targets = action === 'save'
    ? ['button:has-text("Save")', 'button:has-text("Bookmark")', 'button[aria-label*="save" i]', 'button[aria-label*="bookmark" i]']
    : ['button:has-text("Mark Applied")', 'button:has-text("Mark as Applied")', 'button:has-text("Applied")', 'button[aria-label*="applied" i]'];

  let clicked = false;
  for (const sel of targets) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 5000 });
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    console.log(`SELECTOR_NOT_FOUND no ${action} button on page`);
    process.exit(3);
  }

  // Brief wait for the click to take effect server-side
  await page.waitForTimeout(1500);
  console.log('OK');
  process.exit(0);
} catch (e) {
  console.log('ERROR ' + (e.message || e));
  process.exit(4);
} finally {
  await ctx.close().catch(() => {});
}
