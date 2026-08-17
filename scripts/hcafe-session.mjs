// v4.3: single source of truth for "is this machine signed in to hiring.cafe?"
//
// Extracted from job-action.mjs (the sign-in probe) and dashboard-api.mjs (the
// data/hcafe-auth.json cache) so the scraper, the job actioner, and the
// dashboard API all share one probe and one cache. Signed-in state is what
// gates account-based Saved/Applied filtering. Viewed is deliberately excluded
// so ranking a description cannot hide a job AMM never delivered.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './io-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// hiring.cafe button text varies; keep every known sign-in affordance here.
export const SIGNIN_SELECTOR =
  'button:has-text("Sign in"), button:has-text("Log in"), a:has-text("Sign in"):not(:has-text("Sign in with"))';

// Probe the signed-in state on an already-open Playwright page. Navigates to
// /saved (login-gated) and checks whether a sign-in button is still visible.
// ~5s. The caller keeps ownership of the page — we just navigate it.
export async function isSignedIn(page) {
  await page.goto('https://hiring.cafe/saved', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  if (!page.url().includes('/saved')) return false;
  const signInVisible = await page.locator(SIGNIN_SELECTOR).first().isVisible().catch(() => false);
  return !signInVisible;
}

// The dashboard's "signed into hiring.cafe?" pill reads this cache instantly
// instead of spinning up Playwright on every /api/status poll. Auth is a
// single shared browser profile (data/browser-profile), NOT per-persona, so
// the cache lives at the repo-level data/ dir, not inside a profile.
export const HCAFE_AUTH_CACHE = path.join(ROOT, 'data', 'hcafe-auth.json');

export function writeHcafeAuthCache(authed) {
  try {
    fs.mkdirSync(path.dirname(HCAFE_AUTH_CACHE), { recursive: true });
    atomicWriteJson(HCAFE_AUTH_CACHE, { authed: !!authed, checkedAt: new Date().toISOString() });
  } catch { /* cache write is best-effort — never fail the caller over it */ }
}

// Read the cached status without a browser spawn. Missing/unreadable cache →
// null so callers can show "unknown" rather than a misleading "signed out".
export function readHcafeAuthCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(HCAFE_AUTH_CACHE, 'utf8'));
    return { authed: !!raw.authed, checkedAt: raw.checkedAt || null };
  } catch {
    return { authed: null, checkedAt: null };
  }
}

// v4.3: the single dedup-mode decision. Batch messages, the jobs(date).txt
// header, and /diagnose all render which dedup is in effect — each with its own
// wording, but the *branching* must stay identical, or one surface tells the
// user they're synced while another nags them to sign in. `authed` is
// tri-state: true (signed in), false (confirmed signed out), null/undefined
// (unknown — cache missing). `enabled` is scoring.accountDedup (default on):
// when off, account dedup never runs regardless of sign-in, so the mode is
// 'local-disabled' and no surface should nag the user to sign in.
export function dedupMode({ authed, enabled = true } = {}) {
  if (enabled === false) return 'local-disabled';
  if (authed === true) return 'account';
  if (authed === false) return 'signed-out';
  return 'unknown';
}
