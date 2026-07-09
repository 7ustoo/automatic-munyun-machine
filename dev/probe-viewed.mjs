#!/usr/bin/env node
// R3.0 probe (v4.3) — does visiting a hiring.cafe job page while signed in
// mark it "Viewed", such that a search with hideJobTypes:["Viewed"] stops
// returning it? Uses the signed-in persistent profile. Dev-only; not part of
// any npm script.
//
//   node dev/probe-viewed.mjs ["search term"]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowser } from '../scripts/browser-launcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const profileDir = path.join(ROOT, 'data', 'browser-profile');

const TERM = process.argv[2] || 'security engineer';

function searchUrl(hideViewed) {
  const s = { searchQuery: TERM, workplaceTypes: ['Remote'] };
  if (hideViewed) s.hideJobTypes = ['Viewed'];
  return 'https://hiring.cafe/?searchState=' + encodeURIComponent(JSON.stringify(s));
}

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

async function checkAuth() {
  await page.goto('https://hiring.cafe/saved', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  if (!page.url().includes('/saved')) return false;
  const signInVisible = await page.locator('button:has-text("Sign in"), button:has-text("Log in"), a:has-text("Sign in"):not(:has-text("Sign in with"))').first().isVisible().catch(() => false);
  return !signInVisible;
}

async function collectJobHrefs(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('a[href^="/job/"]', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href^="/job/"]')) {
      if (!seen.has(a.href)) { seen.add(a.href); out.push(a.href); }
    }
    return out;
  });
}

try {
  console.log('== step 1: auth check ==');
  const authed = await checkAuth();
  console.log(authed ? 'AUTH_OK' : 'AUTH_FAIL');
  if (!authed) { console.log('VERDICT: ABORT — not signed in; sign in via npm run login first'); process.exit(1); }

  console.log('\n== step 2: search with hideJobTypes:["Viewed"] ==');
  const before = await collectJobHrefs(searchUrl(true));
  console.log(`cards: ${before.length}`);
  console.log(before.slice(0, 8).join('\n'));
  if (before.length < 3) { console.log('VERDICT: ABORT — too few cards to probe'); process.exit(1); }

  const targets = [before[0], before[1]];
  const control = before[2];

  console.log('\n== step 3: visit target job pages (capturing non-GET requests) ==');
  const captured = [];
  const onReq = (req) => {
    const m = req.method();
    if (m !== 'GET' && m !== 'HEAD') {
      captured.push({ method: m, url: req.url(), post: (req.postData() || '').slice(0, 500) });
    }
  };
  page.on('request', onReq);
  for (const t of targets) {
    console.log('visiting ' + t);
    await page.goto(t, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // settle like resolveOnePage
  }
  page.off('request', onReq);
  console.log(`captured ${captured.length} non-GET requests during visits:`);
  for (const c of captured) console.log(`  ${c.method} ${c.url}${c.post ? '  BODY: ' + c.post : ''}`);

  console.log('\n== step 4: reload hide-viewed search ==');
  const after = await collectJobHrefs(searchUrl(true));
  console.log(`cards: ${after.length}`);
  const afterSet = new Set(after);
  const gone = targets.filter(t => !afterSet.has(t));
  const controlStillThere = afterSet.has(control);
  console.log(`target 1 (${targets[0]}): ${afterSet.has(targets[0]) ? 'STILL PRESENT' : 'GONE'}`);
  console.log(`target 2 (${targets[1]}): ${afterSet.has(targets[1]) ? 'STILL PRESENT' : 'GONE'}`);
  console.log(`control  (${control}): ${controlStillThere ? 'still present (good)' : 'MISSING (bad — filter hiding everything?)'}`);

  console.log('\n== step 5: sanity — same search WITHOUT hideJobTypes ==');
  const noFilter = await collectJobHrefs(searchUrl(false));
  const nfSet = new Set(noFilter);
  console.log(`cards: ${noFilter.length}`);
  console.log(`target 1 in unfiltered search: ${nfSet.has(targets[0]) ? 'present' : 'absent'}`);
  console.log(`target 2 in unfiltered search: ${nfSet.has(targets[1]) ? 'present' : 'absent'}`);

  const pass = gone.length === 2 && controlStillThere;
  console.log('\nVERDICT: ' + (pass ? 'PASS — page visit marks Viewed; hideJobTypes filters it'
    : gone.length > 0 ? 'PARTIAL — ' + gone.length + '/2 targets hidden; inspect output'
    : 'FAIL — visits did not mark Viewed; use contingency (captured requests above)'));
} catch (e) {
  console.log('ERROR ' + (e.message || e));
  process.exit(4);
} finally {
  await ctx.close().catch(() => {});
}
