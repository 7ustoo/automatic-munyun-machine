// v7.3: single source of truth for "is this machine signed in to Dice?" —
// the exact hcafe-session.mjs pattern applied to dice.com.
//
// Signing in to Dice is OPTIONAL (search scraping works anonymously). What it
// buys the user: dice.com apply links open already signed in, so Easy Apply
// and Dice's own saved/applied tracking work when they or their VA click
// through. The probe + cache mirror hcafe-session so every surface (scraper,
// dashboard API, System page card) shares one file and one schema.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './io-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Probe the signed-in state on an already-open Playwright page. /home-feed is
// login-gated: anonymous visitors get redirected to /dashboard/login (same
// trick as hiring.cafe's /saved). ~5s. Caller keeps ownership of the page.
export async function isDiceSignedIn(page) {
  await page.goto('https://www.dice.com/home-feed', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  return !page.url().includes('/login');
}

// Cache lives beside hcafe-auth.json — shared browser profile, not per-persona.
export const DICE_AUTH_CACHE = path.join(ROOT, 'data', 'dice-auth.json');

export function writeDiceAuthCache(authed) {
  try {
    fs.mkdirSync(path.dirname(DICE_AUTH_CACHE), { recursive: true });
    atomicWriteJson(DICE_AUTH_CACHE, { authed: !!authed, checkedAt: new Date().toISOString() });
  } catch { /* best-effort — never fail the caller over a cache write */ }
}

// Missing/unreadable cache → authed:null so the UI shows "unknown", not a
// misleading "signed out".
export function readDiceAuthCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(DICE_AUTH_CACHE, 'utf8'));
    return { authed: !!raw.authed, checkedAt: raw.checkedAt || null };
  } catch {
    return { authed: null, checkedAt: null };
  }
}
