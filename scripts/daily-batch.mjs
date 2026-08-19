#!/usr/bin/env node
/**
 * Daily ranked job batch (50–200 jobs, user-configurable).
 *   1. Launches a headless Chromium with the persistent profile (Cloudflare
 *      cookies live there); warmup probe verifies hiring.cafe is browsable.
 *   2. Runs EVERY configured hiring.cafe search, paginating
 *      each until its Next button is gone / no fresh cards (hard ceiling
 *      maxPagesPerQuery, default 300 — a runaway guard, not a target; v7.9
 *      retries every stop condition so a slow render never ends a query early).
 *      v2.3: full scan is the default —
 *      the old cross-query early stop (quit once fresh estimate ≥ 1.5 ×
 *      targetJobsPerBatch) only applies with scoring.searchAllQueries:false.
 *   3. Filters (clearance, skip-companies, drop-titles, max YOE), dedups,
 *      subtracts applied + previously-seen, scores against the parsed CV.
 *   4. Evaluates full descriptions in chunks until up to 200 jobs clear the
 *      user's final match floor or the candidate supply is exhausted.
 *   5. Resolves viewjob URLs to direct ATS URLs via a 5-page browser
 *      pool (Cloudflare blocks plain Node fetch; browser nav works).
 *   6. Pulls weather from open-meteo (lat/lon/city are user-configurable).
 *   7. Writes the local batch, then optionally sends Telegram/email handoffs.
 *      Persists seen-jobs after the run completes.
 *
 * Prereq: persistent Chromium profile (created on first run / login-once
 * warmup). No CDP, no remote debugging port. Local-first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { writeCallbackTable, makeNavCallback } from './callback-router.mjs';
import { migrateIfNeeded, paths as profilePaths, readActiveConfig } from './profile-store.mjs';
import { atomicWriteJson, atomicWriteText } from './io-helpers.mjs';
import { aiRerank, candidateBatches } from './ai-rerank.mjs';
import { telegramConfigured } from './telegram-config.mjs';
import { resolveBrowser } from './browser-launcher.mjs';
import { isSignedIn, writeHcafeAuthCache, readHcafeAuthCache, dedupMode } from './hcafe-session.mjs';
import { emailDeliveryConfigured, sendConfiguredEmail, renderSubject } from './email.mjs';
import { exportRows, buildExportCsv, buildExportXlsx } from './export-batch.mjs';
import { loadExport } from './export-batch.mjs';
import { clampBatchSize } from './batch-size.mjs';
import { summarizeBatch, appendHistory } from './batch-history.mjs';
import { archiveBatch } from './batch-archive.mjs';
import { splitQueriesByEngine } from './query-engines.mjs';
import { matchRequirements } from './requirement-matcher.mjs';
import { dedupeJobs, jobIdentity } from './job-deduper.mjs';
import { readAppliedLedger } from './application-ledger.mjs';
import { enrichParsedResume } from './resume-parser.mjs';
import { set as setConfig } from './config-rw.mjs';
import { scrubLegacyAiKeysFromSnapshots, setLocalSecret } from './secret-store.mjs';
import { fetchAllSources } from './sources/index.mjs';

// v4.3: dedup-line wording per mode (keys from dedupMode()). The Telegram
// message uses emoji/HTML-free prose; the jobs(date).txt header is plain ASCII.
// 'unknown' can't arise here (the scrape always has a fresh boolean), but map
// it defensively to the signed-out wording so a stray null never prints blank.
const DEDUP_NOTE = {
  account: '✓ Saved/applied jobs sync from hiring.cafe; delivered-job memory is local so unshown jobs stay available.',
  'local-disabled': 'Seen-job memory: local (account dedup disabled in settings).',
  'signed-out': '⚠ Not signed in to hiring.cafe — seen-job memory is local to this computer. Sign in from the dashboard (System page) to sync.',
  unknown: '⚠ Not signed in to hiring.cafe — seen-job memory is local to this computer. Sign in from the dashboard (System page) to sync.',
};
const DEDUP_TXT = {
  account: 'Dedup: hiring.cafe Saved/Applied + local delivered-only memory',
  'local-disabled': 'Dedup: local (account dedup disabled in settings)',
  'signed-out': 'Dedup: local only — sign in to hiring.cafe from the dashboard to sync across computers',
  unknown: 'Dedup: local only — sign in to hiring.cafe from the dashboard to sync across computers',
};

// v1.0 E5: ensure config + data layout are profile-aware before we read anything.
migrateIfNeeded();
const PP = profilePaths(); // resolved once at startup; switching profiles requires bot/batch restart

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATE = new Date().toISOString().slice(0, 10);

// CLI vs imported-as-module check. Used to gate side-effects (Playwright launch,
// Telegram send) so test files can import scoreJob/parseSalaryK without
// triggering a real scrape. v1.0 E3.
const _thisFile = fileURLToPath(import.meta.url);
const _invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
const IS_CLI = path.resolve(_thisFile) === _invokedFile;

// ---------- env ----------
// v2.1: Telegram is OPTIONAL. A missing .env (or one with no token) is no
// longer fatal — the batch still scrapes, scores, and writes to disk; the
// desktop dashboard is the delivery surface. Telegram sends are skipped when
// not configured (see TELEGRAM_ON below).
const ENV_PATH = path.join(ROOT, '.env');
const env = fs.existsSync(ENV_PATH)
  ? Object.fromEntries(
      fs.readFileSync(ENV_PATH, 'utf8')
        .split('\n')
        .filter(l => l && !l.startsWith('#') && l.includes('='))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    )
  : {};
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = env.TELEGRAM_CHAT_ID;
const TELEGRAM_ON = telegramConfigured(env);
// v4.3: optional email delivery (batch .txt → a VA/recipient via Gmail SMTP).
// "On" = usable Gmail creds in .env; the per-run decision also checks
// CFG.email.enabled + CFG.email.autoSend below.
const SMTP_PASS = env.SMTP_APP_PASSWORD;
const EMAIL_ON = emailDeliveryConfigured(env);

// Token scrubber for everything that lands in logs or user-visible error
// messages. Telegram URL is `…/bot<TOKEN>/sendMessage`; if a fetch failure
// surfaces the URL via `cause` chain, the token can leak into log files
// users routinely paste publicly when asking for help. Mirror the bot's
// pattern so the discipline is uniform across all entrypoints.
const SCRUB = (s) => {
  if (s == null) return '';
  let str = String(s);
  if (TG_TOKEN) str = str.split(TG_TOKEN).join('<TOKEN>');
  if (SMTP_PASS) str = str.split(SMTP_PASS).join('<APP_PASSWORD>');
  return str;
};

// ---------- config (profile-aware after v1.0 E5) ----------
// Returns the ACTIVE profile's contents flattened to top level (CFG.queries,
// CFG.weather, CFG.filters, ...) so consumers below don't need to know about
// the profiles wrapper. Without this, a raw read of config.json after the E5
// migration leaves CFG.queries undefined → fallback to 3 default queries +
// no weather + no filters. (Regression caught 2026-05-07.)
function loadConfig() {
  return readActiveConfig();
}
const CFG = loadConfig();
if (IS_CLI && CFG.scoring?.ai?.apiKey) {
  if (!env.AMM_AI_KEY) {
    setLocalSecret('AMM_AI_KEY', CFG.scoring.ai.apiKey);
    env.AMM_AI_KEY = CFG.scoring.ai.apiKey;
  }
  setConfig('scoring.ai.apiKey', '');
  scrubLegacyAiKeysFromSnapshots();
}

// ---------- parsed CV (per-profile, written by resume-parser.mjs) ----------
function loadParsedCV() {
  const p = PP.cvParsed;
  if (!fs.existsSync(p)) return { titles: [], certs: [], skills: [], compliance: [] };
  return enrichParsedResume(JSON.parse(fs.readFileSync(p, 'utf8')));
}
const CV = loadParsedCV();
const CV_DICTIONARY = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'cv-keywords.json'), 'utf8')); }
  catch { return {}; }
})();

// ---------- helpers ----------
function log(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${SCRUB(line)}`;
  console.log(msg);
  try {
    fs.appendFileSync(path.join(ROOT, 'data', `daily-batch-${DATE}.log`), msg + '\n');
  } catch { /* never let log writes crash the scrape */ }
}

async function tg(text, opts = {}) {
  if (!TELEGRAM_ON) return null; // v2.1: Telegram off — disk + dashboard are the delivery
  const body = { chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (opts.reply_markup) body.reply_markup = opts.reply_markup;
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (netErr) {
    // fetch-level error (DNS, connection, timeout). The error's cause chain
    // can include the full URL (with TOKEN) — scrub before re-throwing.
    throw new Error('Telegram fetch failed: ' + SCRUB(netErr.message || netErr));
  }
  const json = await res.json();
  if (!json.ok) throw new Error('Telegram error: ' + SCRUB(JSON.stringify(json)));
  return json.result.message_id;
}

async function tgDocument(filePath, caption) {
  if (!TELEGRAM_ON) return null; // v2.1: Telegram off
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('chat_id', TG_CHAT);
  if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
  fd.append('document', new Blob([buf]), path.basename(filePath));
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  } catch (netErr) {
    throw new Error('Telegram sendDocument fetch failed: ' + SCRUB(netErr.message || netErr));
  }
  const json = await res.json();
  if (!json.ok) throw new Error('Telegram sendDocument error: ' + SCRUB(JSON.stringify(json)));
  return json.result.message_id;
}

// Split a long message into <= max chunks, preferring blank-line boundaries.
// v2.0: a single block longer than max is hard-split on line boundaries —
// previously it was emitted as-is and Telegram rejects messages > 4096 chars,
// killing the whole batch send. Pure + exported for tests.
export function chunkMessage(message, max = 3900) {
  const blocks = String(message ?? '').split('\n\n');
  const chunks = [];
  let cur = '';
  const push = () => { if (cur) { chunks.push(cur); cur = ''; } };
  for (let block of blocks) {
    while (block.length > max) {
      push();
      let cut = block.lastIndexOf('\n', max);
      if (cut <= 0) cut = max;
      chunks.push(block.slice(0, cut));
      block = block.slice(cut).replace(/^\n/, '');
    }
    if ((cur + '\n\n' + block).length > max && cur) { push(); cur = block; }
    else cur = cur ? cur + '\n\n' + block : block;
  }
  push();
  return chunks;
}

async function tgChunked(message) {
  const chunks = chunkMessage(message);
  for (const c of chunks) await tg(c);
  return chunks.length;
}

// ---------- weather ----------
const WMO = { 0:'clear', 1:'mostly clear', 2:'partly cloudy', 3:'overcast', 45:'foggy', 48:'foggy', 51:'light drizzle', 53:'drizzle', 55:'heavy drizzle', 61:'light rain', 63:'rain', 65:'heavy rain', 71:'light snow', 73:'snow', 75:'heavy snow', 80:'showers', 81:'showers', 82:'heavy showers', 95:'thunderstorm', 96:'thunderstorm', 99:'thunderstorm' };
const WMO_EMOJI = { 0:'☀️', 1:'🌤', 2:'⛅', 3:'☁️', 45:'🌫', 48:'🌫', 51:'🌦', 53:'🌦', 55:'🌧', 61:'🌧', 63:'🌧', 65:'🌧', 71:'🌨', 73:'🌨', 75:'❄️', 80:'🌦', 81:'🌧', 82:'⛈', 95:'⛈', 96:'⛈', 99:'⛈' };

async function getWeather() {
  try {
    const w = CFG.weather;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${w.lat}&longitude=${w.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&temperature_unit=${w.tempUnit||'fahrenheit'}&timezone=${encodeURIComponent(w.timezone||'auto')}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const c = j.current, d = j.daily, code = c.weather_code;
    const unit = (w.tempUnit||'fahrenheit')==='celsius' ? '°C' : '°F';
    return `${WMO_EMOJI[code]||'🌤'} ${w.city||'Local'}: ${Math.round(c.temperature_2m)}${unit}, ${WMO[code]||'unknown'}, high ${Math.round(d.temperature_2m_max[0])}° / low ${Math.round(d.temperature_2m_min[0])}°`;
  } catch { return `🌴 ${CFG.weather?.city||'Local'}: weather unavailable`; }
}

// ---------- chrome ----------
// Queries come from config.json. Falls back to a sensible default if missing.
// v5.0: no configured queries → EMPTY (an honest empty batch), never a fallback
// to someone else's field. Setup fills queries from the user's own resume.
const QUERIES = (CFG.queries && CFG.queries.length)
  ? CFG.queries.map(q => [q.key, q.term])
  : [];
// v7.3: per-term engine routing (both/hcafe/dice) + the global scrape-source
// switch. HCAFE_QUERIES drives the hiring.cafe loop; DICE_QUERY_TERMS drives
// the Dice per-query fetch. QUERIES stays the full list for key→term lookups.
const { hcafe: HCAFE_QUERIES, dice: DICE_QUERY_TERMS } = splitQueriesByEngine(CFG.queries || [], CFG.search?.scrapeSources);
// v5.0: key→term lookup so a job's `q` (and the dashboard source pill /
// leaderboard) shows the human search TERM, not the mashed internal key
// (e.g. 'SeniorSecurityEngine').
const KEY_TO_TERM = Object.fromEntries(QUERIES.map(([k, t]) => [k, t]));

const EXTRACT_FN = `(() => {
  // Reject candidate titles that are actually metadata bleed (e.g. the line
  // "Full Time" or "Remote, US" got picked up because of a quirky card
  // layout). v1.0 E3 fix — was returning these as titles previously, which
  // poisoned scoring and made /why N's explanations confusing.
  const NON_TITLE_RX = /^(full[- ]?time|part[- ]?time|remote|hybrid|onsite|contract|w2|c2c|us only|usa|united states|saved|save|apply|applied|view|new|featured)$/i;
  const isPlausibleTitle = (s) => {
    if (!s || s.length < 3 || s.length > 100) return false;
    if (NON_TITLE_RX.test(s.trim())) return false;
    if (/^\\$|^\\d+\\+\\s*YOE|^[\\d,–—-]+$/.test(s)) return false;
    return true;
  };
  const seen = new Set(); const out = [];
  document.querySelectorAll('a[href^="/job/"]').forEach(a => {
    if (seen.has(a.href)) return; seen.add(a.href);
    const card = a.closest('.bg-white.rounded-xl') || a.parentElement.parentElement.parentElement;
    const cardText = card.innerText || '';
    const lines = cardText.split('\\n').map(l => l.trim()).filter(Boolean);
    const ageIdx = lines.findIndex(l => /^\\d+[wdhmoy]+$/.test(l));
    // v2.5: capture the posted-age token ("5h", "3d", "2w", "1mo") so the
    // batch can filter by recency. Kept raw; parsed to days in Node.
    const postedAge = ageIdx >= 0 ? lines[ageIdx] : '';
    // Try the post-age line, then the first line, then a heuristic search
    // — but validate each candidate before accepting.
    const candidates = [];
    if (ageIdx >= 0 && lines[ageIdx + 1]) candidates.push(lines[ageIdx + 1]);
    if (lines[0]) candidates.push(lines[0]);
    for (const l of lines) {
      if (l.length > 5 && !/Remote|Full Time|Contract|United States|YOE|\\$|Save|Apply|Hybrid|Onsite/.test(l)) {
        candidates.push(l);
      }
    }
    let title = candidates.find(isPlausibleTitle) || '';
    const yoeM = lines.find(l => /^\\d+\\+\\s*YOE/i.test(l));
    const yoe = yoeM ? parseInt(yoeM) : null;
    const compM = lines.find(l => /^[A-Z][^:]+:.{10,}/.test(l));
    out.push({
      href: a.href,
      title: title.substring(0, 80),
      yoe,
      postedAge,
      company: compM ? compM.split(':')[0] : '',
      cardText: cardText.substring(0, 1500)
    });
  });
  return out;
})()`;

async function launchBrowser() {
  const profileDir = path.join(ROOT, 'data', 'browser-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  // v2.0.1: prefer the user's installed Chrome/Edge over Playwright's
  // bundled Chromium (kills the ~150 MB install-time download). Still
  // AMM's own profile dir — the user's browsing is untouched.
  const browser = await resolveBrowser();
  log(`Browser: ${browser.label}`);
  // v2.9: "watch the scrape." The browser is always headful (headless:false),
  // but by default we park it off-screen (10000,10000) so the daily 7am run
  // never steals focus or covers the user's desktop. When the dashboard's
  // "Watch" checkbox fires a scrape, the wrapper sets AMM_SHOW_BROWSER=1 and we
  // place the window on-screen so the user can watch it drive hiring.cafe.
  const showBrowser = process.env.AMM_SHOW_BROWSER === '1';
  const windowPosition = showBrowser ? '--window-position=60,60' : '--window-position=10000,10000';
  if (showBrowser) log('👁  Visible browser mode — the scrape window will be on-screen.');
  return chromium.launchPersistentContext(profileDir, {
    ...browser.launchOptions,
    headless: false,
    timeout: 30000,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      windowPosition,
      '--window-size=1280,800'
    ],
    viewport: { width: 1280, height: 800 }
    // v7.8: no userAgent override. A hardcoded UA string goes stale as Chrome
    // updates, and modern Chrome also sends Sec-CH-UA client-hint headers built
    // from the real binary — so a pinned UA disagrees with its own headers,
    // which is exactly the mismatch Cloudflare flags as a bot. The launch is
    // headful real Chrome; letting it introduce itself is strictly more honest.
  });
}

// v1.0.x: scraping is auth-OPTIONAL. Hiring.cafe lets logged-out users
// browse jobs; the only blocker historically was Cloudflare's bot challenge,
// which the persistent profile clears after the warmup pass.
//
// checkBrowsable() returns true if the search UI renders job cards — that's
// the only thing the scraper actually needs. If it doesn't render, run
// scripts/login-once.mjs to warm Cloudflare on this profile.
async function checkBrowsable(page) {
  const probe = { searchQuery: 'engineer', workplaceTypes: ['Remote'] };
  const url = 'https://hiring.cafe/?searchState=' + encodeURIComponent(JSON.stringify(probe));
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Cloudflare can take a while; wait up to 25s for cards to appear
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(2000);
        const count = await page.locator('a[href*="/job/"]').count().catch(() => 0);
        if (count > 0) return true;
      }
    } catch { /* retry once */ }
  }
  return false;
}

// v4.3: searchState builder, extracted pure so tests can pin the contract.
// hideJobTypes is hiring.cafe's server-side account filter: it hides jobs the
// signed-in account has Saved / Applied to. Viewed is deliberately excluded:
// opening a description for ranking must never burn a job the user did not
// receive. Delivered-only dedup lives in the local profile store.
// sessions (the reason v1.0.x removed it — back then the scrape ran unauth),
// so we send it ONLY when this run has verified an authenticated session;
// sending it signed-out is a silent no-op but would misrepresent the mode.
// v5.0: friendly labels → hiring.cafe's workplaceTypes enum. "Remote" is
// verified; Hybrid/Onsite follow hiring.cafe's convention. Centralized so it's
// a one-line fix if their enum differs — and the default (Remote) is unchanged,
// so nothing existing breaks. Empty/garbage → ['Remote'].
const WORKPLACE_MAP = { 'remote': 'Remote', 'hybrid': 'Hybrid', 'on-site': 'Onsite', 'onsite': 'Onsite', 'on site': 'Onsite', 'in-office': 'Onsite', 'in office': 'Onsite' };
export function normalizeWorkplaceTypes(arr) {
  const out = [];
  for (const w of (Array.isArray(arr) ? arr : [])) {
    const v = WORKPLACE_MAP[String(w).toLowerCase().trim()];
    if (v && !out.includes(v)) out.push(v);
  }
  return out.length ? out : ['Remote'];
}
export function buildSearchState(term, { formEaseFilter = null, accountDedup = false, workplaceTypes = ['Remote'], location = '' } = {}) {
  const wt = normalizeWorkplaceTypes(workplaceTypes);
  // Location biases the free-text query (safe — can't break the request shape),
  // and only when the user wants non-remote jobs (a location on a remote search
  // just shrinks results). hiring.cafe does full-text matching over the query.
  const loc = String(location || '').trim();
  const wantsLocal = wt.some(w => w !== 'Remote');
  const searchQuery = (loc && wantsLocal) ? `${term} ${loc}` : term;
  const s = { searchQuery, workplaceTypes: wt };
  if (accountDedup) s.hideJobTypes = ['Saved', 'Applied'];
  if (formEaseFilter) s.applicationFormEase = formEaseFilter;
  return s;
}

async function scrape() {
  log(`Launching headless Chromium with persistent profile…`);
  const ctx = await launchBrowser();
  try {
    return await _scrapeWith(ctx);
  } finally {
    // Always close — leaked Chromium leaves a LevelDB lockfile in
    // data/browser-profile/ that blocks the next run.
    await ctx.close().catch(() => {});
  }
}

async function _scrapeWith(ctx) {
  const page = ctx.pages()[0] || await ctx.newPage();

  // Browsability gate — Cloudflare may not have cleared yet on a fresh
  // profile. If cards never render, abort cleanly so we don't poison the
  // seen-jobs store. (Renamed from "auth" gate; scraping works signed-out —
  // v4.3: signing in additionally enables account-side dedup, see below.)
  log('Verifying hiring.cafe is browsable (Cloudflare cleared)…');
  const browsable = await checkBrowsable(page);
  if (!browsable) {
    const e = new Error('Hiring.cafe not yet browsable from this profile. Run the login-once helper to clear the Cloudflare challenge — no sign-in required.');
    e.unauth = true;
    throw e;
  }
  log('✓ browsable');
  // NOTE: recordAuthOk() deliberately deferred until AFTER the scrape loop
  // produces at least one card. /saved loading is necessary but not sufficient
  // — if every query then returns 0 cards the user is effectively broken and
  // /status / /diagnose should not display "auth OK" as if everything's fine.

  // v4.3: account-based dedup. If the persistent profile is signed in to
  // hiring.cafe, ask the server to hide Saved/Applied jobs. Viewed is not
  // hidden because the ranker may inspect more descriptions than it delivers.
  // probe (~5s, one /saved navigation on the already-open page) also
  // refreshes the dashboard's data/hcafe-auth.json pill on every run.
  const ACCOUNT_DEDUP = SCORING.accountDedup !== false; // default on
  let hcafeAuthed = false;
  if (ACCOUNT_DEDUP) {
    // Tri-state on purpose: a probe ERROR (flaky /saved navigation) is not a
    // confirmed "signed out" — treat the run as unauth (safe: no hideJobTypes)
    // but DON'T clobber the dashboard's cached pill with a false negative.
    try {
      hcafeAuthed = await isSignedIn(page);
      writeHcafeAuthCache(hcafeAuthed);
      log(hcafeAuthed
        ? '✓ signed in to hiring.cafe — saved/applied account dedup active; delivered-job memory stays local'
        : 'not signed in to hiring.cafe — local seen-jobs fallback (sign in from the dashboard to sync dedup across computers)');
    } catch (e) {
      log(`hiring.cafe sign-in probe failed (transient: ${SCRUB(e.message || e).split('\n')[0]}) — running this batch signed-out; auth cache left untouched`);
    }
  }
  const results = {};
  // Map config's applicationFormEase → hiring.cafe URL filter
  const formEase = (CFG.filters?.applicationFormEase || 'all').toLowerCase();
  const formEaseFilter = formEase === 'simple' ? ['Simple']
                        : formEase === 'long'  ? ['TimeConsuming']
                        : null; // 'all' or anything else → no filter

  // v1.0.x: pagination. Hiring.cafe shows ~40 cards per page. Page 1 loads
  // with the search; we then click the "Next" link (a[aria-label*="next"])
  // for pages 2..MAX_PAGES_PER_QUERY — i.e. up to MAX_PAGES_PER_QUERY pages
  // total per query. Stops early if Next disappears/disables OR a new page
  // returns no fresh cards (already seen this query).
  // v7.9: raised 50 → 300. This is a runaway guard, NOT a target — hiring.cafe
  // stops offering a Next link long before it (observed 15–25 pages), so the
  // real end of the result set is what ends the loop. The old 50 was close
  // enough to real page counts to look like a legitimate stopping point.
  const MAX_PAGES_PER_QUERY = SCORING.maxPagesPerQuery ?? 300;

  // v1.0.x: target-driven cross-query early stop. After each query's
  // pagination, we compute the running fresh-after-dedup count. If it
  // exceeds the target with some headroom for floor losses, we stop
  // scraping additional queries — saves time on heavy-supply days.
  const TARGET_JOBS = DELIVER_COUNT;
  // v2.3: by default search EVERY configured keyword, fully paginated — don't
  // skip later keywords just because the early ones filled the target. Set
  // scoring.searchAllQueries:false to restore the old "stop once we have
  // ~1.5x target candidates" speed optimization.
  const SEARCH_ALL_QUERIES = SCORING.searchAllQueries !== false;
  const _appliedSet  = loadAppliedState();
  const _blockedSet  = loadBlockedSeen();
  const _crossQuerySeen = new Set(); // dedup hrefs across query boundaries
  let runningFreshEstimate = 0;

  // v7.9: exhaustive pagination helpers.
  //
  // The old loop slept a flat 2.5s after clicking Next, then checked ONCE for
  // the Next button. hiring.cafe re-renders its grid in place and is often
  // slower than that, so a still-rendering page looked identical to the end of
  // the results: a short card count and no Next button. Measured cost of that
  // race — "iam" (Remote) reported 899 jobs on the site; the scrape collected
  // 398. Waiting properly collected 560 from the same search.
  //
  // Everything below trades time for completeness, which is the correct trade
  // for a batch that runs unattended at 7am.
  const NEXT_SEL = 'a[aria-label*="next" i], button[aria-label*="next" i]';

  // Wait until the grid actually turns over. Anchors on the first card's href
  // instead of a wall-clock guess: the page has genuinely advanced only once
  // that value changes.
  const waitForPageTurn = async (prevFirstHref, timeoutMs = 20000) => {
    try {
      await page.waitForFunction(
        (prev) => {
          const first = document.querySelector('a[href^="/job/"]');
          return !!first && first.getAttribute('href') !== prev;
        },
        prevFirstHref,
        { timeout: timeoutMs, polling: 250 }
      );
      return true;
    } catch { return false; }
  };

  // Wait for the card count to hold steady across consecutive polls, so we
  // never extract a half-populated grid and mistake it for a final short page.
  const waitForCardsSettled = async (timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs;
    let last = -1, stableFor = 0;
    while (Date.now() < deadline) {
      const n = await page.evaluate(() => document.querySelectorAll('a[href^="/job/"]').length).catch(() => -1);
      if (n > 0 && n === last) { if (++stableFor >= 2) return n; }
      else { stableFor = 0; last = n; }
      await page.waitForTimeout(400);
    }
    return last;
  };

  // Only declare "no more pages" after the button has stayed missing across
  // several escalating waits (~12s total). A single miss is almost always a
  // slow render, not the end of the result set.
  const findNextButton = async (attempts = 5) => {
    for (let t = 0; t < attempts; t++) {
      const btn = page.locator(NEXT_SEL).first();
      const visible = await btn.isVisible().catch(() => false);
      const enabled = visible && await btn.isEnabled().catch(() => false);
      if (visible && enabled) return btn;
      if (t < attempts - 1) await page.waitForTimeout(1200 * (t + 1)); // 1.2s → 2.4s → 3.6s → 4.8s
    }
    return null;
  };

  for (const [key, query] of HCAFE_QUERIES) {
    const searchState = buildSearchState(query, { formEaseFilter, accountDedup: hcafeAuthed, workplaceTypes: CFG.search?.workplaceTypes, location: CFG.search?.location });
    const url = 'https://hiring.cafe/?searchState=' + encodeURIComponent(JSON.stringify(searchState));
    log(`Scraping "${query}"…`);
    const seenInQuery = new Set();
    const allRows = [];

    // Page 1 — initial navigation, retry up to 3 times on failure.
    let firstPageRows = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('a[href^="/job/"]', { timeout: 15000 }).catch(() => {});
        await waitForCardsSettled(); // v7.9: no fixed sleep — wait for the grid to stop growing
        firstPageRows = await page.evaluate(EXTRACT_FN);
        break;
      } catch (e) {
        log(`  attempt ${attempt} failed: ${e.message.split('\n')[0]}`);
        if (attempt === 3) throw e;
        await page.waitForTimeout(2000);
      }
    }
    for (const r of firstPageRows) {
      if (!seenInQuery.has(r.href)) { seenInQuery.add(r.href); allRows.push(r); }
    }
    log(`  page 1 → ${firstPageRows.length} cards (running total: ${allRows.length})`);

    // Pages 2..N — click Next to the true end of the result set. v7.9: every
    // stop condition now has to survive a retry, so we only quit when the site
    // has actually run out, never because a render was slow.
    let stoppedBecause = `hit the ${MAX_PAGES_PER_QUERY}-page safety cap`;
    for (let pageNum = 2; pageNum <= MAX_PAGES_PER_QUERY; pageNum++) {
      const nextBtn = await findNextButton();
      if (!nextBtn) {
        stoppedBecause = `Next stayed gone after 5 checks over ~12s — end of results`;
        log(`  no more pages after ${pageNum - 1} (${stoppedBecause})`);
        break;
      }
      try {
        const prevFirstHref = await page.evaluate(() => {
          const a = document.querySelector('a[href^="/job/"]');
          return a ? a.getAttribute('href') : null;
        });
        await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
        await nextBtn.click({ timeout: 10000 });
        // Wait for the grid to actually turn over, then for it to stop growing.
        const turned = await waitForPageTurn(prevFirstHref);
        await waitForCardsSettled();
        let pageRows = await page.evaluate(EXTRACT_FN);
        // A short page is the classic false-end. Give it one more settle pass
        // before believing it.
        if (pageRows.length < 40) {
          await page.waitForTimeout(2500);
          await waitForCardsSettled(6000);
          const retryRows = await page.evaluate(EXTRACT_FN);
          if (retryRows.length > pageRows.length) pageRows = retryRows;
        }
        let newCards = 0;
        for (const r of pageRows) {
          if (!seenInQuery.has(r.href)) { seenInQuery.add(r.href); allRows.push(r); newCards++; }
        }
        log(`  page ${pageNum} → ${pageRows.length} cards (${newCards} new, running total: ${allRows.length})${turned ? '' : ' [grid did not turn over]'}`);
        if (newCards === 0) {
          // Re-extract once after a longer pause before concluding we're looping
          // on the same page — another slow-render false positive.
          await page.waitForTimeout(3000);
          await waitForCardsSettled(8000);
          const secondLook = await page.evaluate(EXTRACT_FN);
          let recovered = 0;
          for (const r of secondLook) {
            if (!seenInQuery.has(r.href)) { seenInQuery.add(r.href); allRows.push(r); recovered++; }
          }
          if (recovered === 0) {
            stoppedBecause = `page ${pageNum} returned no new jobs on two consecutive reads`;
            log(`  stopping pagination — ${stoppedBecause}`);
            break;
          }
          log(`  page ${pageNum} recovered ${recovered} more on a second read (running total: ${allRows.length})`);
        }
      } catch (e) {
        stoppedBecause = `page ${pageNum} errored: ${e.message.split('\n')[0]}`;
        log(`  ${stoppedBecause} — stopping pagination`);
        break;
      }
    }
    log(`  "${query}" complete: ${allRows.length} jobs (${stoppedBecause})`);

    results[key] = allRows;

    // Cross-query running-fresh estimate. We don't run the full scoring
    // mid-scrape (too expensive); we just count how many of THIS query's
    // rows aren't already blocked + haven't been seen earlier this run.
    for (const r of allRows) {
      if (_crossQuerySeen.has(r.href)) continue;
      _crossQuerySeen.add(r.href);
      if (!matchesIdentityState(r, _appliedSet) && !matchesIdentityState(r, _blockedSet)) runningFreshEstimate++;
    }
    // v2.3: only early-stop when explicitly opted out of full-scan. By
    // default we search every keyword to the end so a plethora of jobs under
    // later keywords is never missed.
    if (!SEARCH_ALL_QUERIES && runningFreshEstimate >= TARGET_JOBS * 1.5) {
      log(`  ✓ target hit early — running fresh estimate ${runningFreshEstimate} ≥ ${Math.round(TARGET_JOBS * 1.5)}. Skipping remaining queries (searchAllQueries=false).`);
      break;
    }
  }
  log(`Searched ${Object.keys(results).length}/${QUERIES.length} keywords${SEARCH_ALL_QUERIES ? ' (full scan — every keyword, every page)' : ''}.`);

  // Persist per-query 7-day rolling supply history. Surfaces in /diagnose
  // so a user can see "Detection Engineer has averaged 0 cards/day for a
  // week" and act on it — typo, niche term, or hiring.cafe simply doesn't
  // have that kind of role indexed.
  recordQueryStats(results);

  // Auth state is "OK" only if we both passed /saved AND extracted at least
  // one card across all queries. If every query returned zero, something
  // upstream is wrong even though /saved loaded — don't lie to /status.
  const totalCards = Object.values(results).reduce((s, rows) => s + rows.length, 0);
  if (totalCards > 0) recordAuthOk();
  return { byQuery: results, hcafeAuthed, accountDedupEnabled: ACCOUNT_DEDUP };
}

// Per-query rolling 7-day card-count history. Read by /diagnose. Per-profile.
const QUERY_STATS_PATH = PP.queryStats;
function recordQueryStats(byQuery) {
  let store = { lastUpdated: null, queries: {} };
  try { store = JSON.parse(fs.readFileSync(QUERY_STATS_PATH, 'utf8')); } catch {}
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const [key, rows] of Object.entries(byQuery)) {
    const q = QUERIES.find(([k]) => k === key);
    const term = q ? q[1] : key;
    const slot = store.queries[term] || { history: [] };
    // Replace today's entry if it already exists (handles intra-day reruns)
    slot.history = slot.history.filter(h => h.date !== DATE && h.date >= cutoff);
    slot.history.push({ date: DATE, cards: rows.length });
    slot.history.sort((a, b) => a.date.localeCompare(b.date));
    store.queries[term] = slot;
  }
  store.lastUpdated = new Date().toISOString();
  atomicWriteJson(QUERY_STATS_PATH, store);
}

// ---------- filter ----------
// escRx + termRegex shared with resume-parser via term-match.mjs (v2.0).
// termRegex fixes the Security+/C++ hole: plain \b after a trailing
// non-word char never matches, so those terms previously scored zero.
import { escRx, termRegex } from './term-match.mjs';
import { recencyMaxDays, withinRecency } from './job-recency.mjs';
import { excludedTitleCategory } from './job-title-filters.mjs';

// Build filter regexes from config.json
const DROP_TITLE_PATTERNS = (CFG.filters?.dropTitlePatterns || []).map(p => p.replace(/\s+/g, '\\s+'));
const DROP_TITLE = DROP_TITLE_PATTERNS.length
  ? new RegExp('\\b(' + DROP_TITLE_PATTERNS.join('|') + ')\\b', 'i')
  : /(?!.*)/; // matches nothing if no patterns
const SKIP_COMPANIES = CFG.filters?.skipCompanies || [];
const SKIP_CO = SKIP_COMPANIES.length
  ? new RegExp('^(' + SKIP_COMPANIES.map(escRx).join('|') + ')', 'i')
  : /(?!.*)/;

// ---------- CV keyword scoring ----------
// Pulled from data/cv-parsed.json (written by resume-parser.mjs at setup-time).
// To regenerate: node scripts/resume-parser.mjs <path-to-resume>
const CV_TITLES     = CV.titles     || [];
const CV_CERTS      = CV.certs      || [];
const CV_SKILLS     = CV.skills     || [];
const CV_COMPLIANCE = CV.compliance || [];
// Raw resume text (up to 100K on newly parsed resumes; older profiles may still
// carry the legacy 8K copy) —
// feeds the Smart match rerank so the model reads the actual resume, not
// just the keyword arrays. Empty string on older cv-parsed.json files.
const CV_RAW        = typeof CV.raw === 'string' ? CV.raw : '';

// v1.0 E3: cluster-aware scoring. The CV's primary clusters narrow which
// matches count at full weight — non-cluster matches still count but at
// half weight. Kills the IAM-bias problem for backend/data-leaning users.
const CV_PRIMARY_CLUSTERS = CV.primaryClusters || [];
const CLUSTER_TERMS = (() => {
  const set = new Set();
  if (!CV_PRIMARY_CLUSTERS.length) return set; // no filter — everything full weight
  let dict = {};
  try { dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'cv-keywords.json'), 'utf8')).clusters || {}; } catch {}
  for (const c of CV_PRIMARY_CLUSTERS) {
    for (const t of (dict[c]?.terms || [])) set.add(t.toLowerCase());
  }
  return set;
})();
function clusterMultiplier(term) {
  if (CLUSTER_TERMS.size === 0) return 1.0;            // no clusters → flat weights
  return CLUSTER_TERMS.has(term.toLowerCase()) ? 1.0 : 0.5;
}

const SCORING = CFG.scoring || {};
// v5.0: ATS source boards (Greenhouse/Lever/Ashby). Inert unless the user lists
// companies (or a remote config URL) — so existing installs are unaffected.
const SOURCES = CFG.sources || {};
const SOURCES_CONFIGURED = ['greenhouse', 'lever', 'ashby'].some(k => Array.isArray(SOURCES[k]) && SOURCES[k].length) || !!(SOURCES.remoteConfigUrl && String(SOURCES.remoteConfigUrl).trim()); // ATS boards only — Dice is always-on (v7.4), gated purely by term routing
// v4.5: user-selectable batch size (50/100/150/200). Clamped so a hand-edited
// config can't make the resolve pass visit an unbounded number of job pages.
const DELIVER_COUNT = clampBatchSize(SCORING.targetJobsPerBatch);
const W_TITLE       = SCORING.titleWeight       ?? 10;
const W_CERT        = SCORING.certWeight        ?? 5;
const W_SKILL       = SCORING.skillWeight       ?? 3;
const W_COMPLIANCE  = SCORING.complianceWeight  ?? 2;
const SALARY_BONUS  = SCORING.salaryBonus       ?? 5;
const SALARY_PENALTY= SCORING.salaryPenalty     ?? -10;
// v5.0: default 0 (no floor) — a fresh install shouldn't penalize any salary
// until the user sets a floor in setup. `?? 90000` only applies if the field is
// entirely absent (legacy configs); config.example ships 0.
export const SALARY_FLOOR_K = Math.round((CFG.user?.salaryFloorUsd ?? 90000) / 1000);
const MATCH_FLOOR_PCT = SCORING.matchFloorPercent ?? 70;
const TARGET_TERMS = (CFG.queries || []).map(q => q.term).filter(Boolean);
const DESCRIPTION_CHUNK = Math.max(50, Math.min(250, DELIVER_COUNT));
const MAX_DESCRIPTION_EVALUATIONS = Math.max(
  DELIVER_COUNT,
  Math.min(5000, Number(SCORING.maxDescriptionEvaluations) || 3000),
);
const TF_CAP        = 3; // count term occurrences up to this many times

// v4.0: optional AI rerank (off by default; configured from the dashboard
// Settings page). Key lives in config.json (gitignored, local-only) or the
// AMM_AI_KEY env var. NEVER log the key.
const AI_CFG = {
  enabled: !!SCORING.ai?.enabled,
  apiKey: env.AMM_AI_KEY || process.env.AMM_AI_KEY || SCORING.ai?.apiKey || '',
  model: SCORING.ai?.model || 'claude-opus-4-8',
};

const clamp100 = v => Math.max(0, Math.min(100, Math.round(v)));
const smartMatchedRows = [];
let smartMatchFailedOpen = false;

async function applySmartMatch(rows) {
  if (!AI_CFG.enabled || !AI_CFG.apiKey || !rows.length || smartMatchFailedOpen) return 0;
  const cvSummary = {
    titles: CV_TITLES.slice(0, 12), certs: CV_CERTS.slice(0, 16),
    skills: CV_SKILLS.slice(0, 60), compliance: CV_COMPLIANCE.slice(0, 16),
    employment: CV.employment || [],
    experienceEvidence: CV.experienceEvidence || {},
    ...(CV_RAW ? { resumeText: CV_RAW.slice(0, 24000) } : {}),
  };
  let applied = 0;
  // Forty is now an API-request batch size, not a total-job ceiling.
  const batches = candidateBatches(rows, 40);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const candidates = batch.map((r, n) => ({
      n, title: r.title, company: r.company,
      text: (r.__jd || r.cardText || '').slice(0, 3500),
    }));
    let ratings;
    try {
      ratings = await aiRerank({ apiKey: AI_CFG.apiKey, model: AI_CFG.model, cvSummary, candidates });
      const unique = new Set((ratings || []).map(r => r.n).filter(n => Number.isInteger(n) && n >= 0 && n < batch.length));
      if (unique.size !== batch.length) throw new Error(`incomplete response (${unique.size}/${batch.length} jobs)`);
    } catch (e) {
      log(`Smart Match batch ${batchIndex + 1}/${batches.length} failed open: ${SCRUB(e.message || e)}`);
      // Do not mix AI and keyword-only scores in one run. Roll back prior AI
      // blends and continue the complete target-fill loop deterministically.
      for (const prior of smartMatchedRows) {
        prior.matchPct = prior.kwPct;
        delete prior.aiPct;
        delete prior.aiReason;
        delete prior.aiSub;
      }
      smartMatchedRows.length = 0;
      smartMatchFailedOpen = true;
      return -1;
    }
    for (const rt of ratings || []) {
      const r = batch[rt.n];
      if (!r || typeof rt.fit !== 'number') continue;
      r.aiPct = clamp100(rt.fit);
      r.aiReason = String(rt.reason || '').slice(0, 180);
      if (Number.isInteger(rt.skills) && Number.isInteger(rt.seniority) && Number.isInteger(rt.role)) {
        r.aiSub = { skills: clamp100(rt.skills), seniority: clamp100(rt.seniority), role: clamp100(rt.role) };
      }
      r.kwPct = r.matchPct;
      r.matchPct = Math.round(0.35 * r.kwPct + 0.65 * r.aiPct);
      smartMatchedRows.push(r);
      applied++;
    }
  }
  return applied;
}

// v4.0: scrape outcome record — the dashboard's red "scrape failed" banner
// reads this via /api/status. Written on EVERY exit path so a failed 7am run
// is never silent for desktop-only users.
function writeScrapeStatus(ok, extra = {}) {
  try {
    atomicWriteJson(path.join(ROOT, 'data', 'scrape-status.json'), {
      ok, at: new Date().toISOString(),
      profile: PP.dir.split(/[/\\]/).pop(), ...extra
    });
  } catch {}
}

// Parse salary numbers from text. Handles ranges, dashes (-, –, —), commas,
// optional "K"/"k", and "USD"/"$" prefixes. Returns array of numbers in $K.
//   "$120k–$160K"        → [120, 160]
//   "$120,000-$160,000"  → [120, 160]
//   "USD 120K - 160K"    → [120, 160]
//   "Salary: $135K"      → [135]
//   "competitive"        → []
// v1.0 E3 — was previously /\$(\d{2,3})\s*[kK](?!\w)/g which accidentally
// worked for many ranges by extracting digits, but failed on em-dashes
// (Windows console encoding) and never parsed comma-separated thousands.
// v5.0: currency-aware-ish salary parsing. Handles USD/EUR/GBP (and C$/A$)
// written as "$120k", full-form with comma OR dot thousands ("$120,000",
// "€60.000", "55,000 GBP"), and HOURLY rates ("$45/hr", "45 per hour") which
// are annualized at 2080 h/yr. The number is taken as-is (no FX conversion) —
// documented, and the salary floor defaults to 0 so cross-currency compares
// don't bite unless the user sets a floor. Returns an array of $K values.
export function parseSalaryK(text) {
  const out = [];
  if (!text) return out;
  const add = (k) => { if (Number.isFinite(k) && k >= 20 && k <= 999) out.push(Math.round(k)); };
  // A) "$120k" / "€75K" / "120k" — a number with a K suffix (a lone comma/dot
  //    here is a decimal separator, e.g. EU "120,5k").
  for (const m of text.matchAll(/(?:USD|EUR|GBP|C\$|A\$|\$|€|£)?\s*(\d{2,4}(?:[.,]\d{1,2})?)\s*[kK]\b/g)) {
    add(parseFloat(m[1].replace(',', '.')));
  }
  // B) Full-form with a thousands separator: "$120,000", "£55,000", "€60.000",
  //    "120,000 USD". Convert to K.
  for (const m of text.matchAll(/(?:USD|EUR|GBP|C\$|A\$|\$|€|£)\s?(\d{2,3})[.,](\d{3})(?!\d)/g)) {
    add(parseInt(m[1] + m[2], 10) / 1000);
  }
  for (const m of text.matchAll(/(\d{2,3})[.,](\d{3})\s?(?:USD|EUR|GBP|dollars|euros|pounds)\b/gi)) {
    add(parseInt(m[1] + m[2], 10) / 1000);
  }
  // C) Hourly → annualize at 2080 h/yr. "$45/hr", "45 per hour", "£30 an hour".
  for (const m of text.matchAll(/(?:USD|EUR|GBP|\$|€|£)?\s?(\d{1,3}(?:\.\d{1,2})?)\s?(?:\/\s?(?:hr|hour)\b|per\s+hour\b|an\s+hour\b|hourly\b)/gi)) {
    add(parseFloat(m[1]) * 2080 / 1000);
  }
  return out;
}

// Phrase-proximity helper: for multi-token CV phrases that aren't found as
// an exact word-boundary match, fall back to "all tokens present anywhere
// in the text" → half credit. Means "AWS … RDS" gets some credit even if
// not adjacent. v1.0 E3.
function tokensAllPresent(jdText, phrase) {
  const tokens = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  return tokens.every(t => termRegex(t).test(jdText));
}

// v4.0: user-muted terms — never score these (set from the dashboard's Why
// panel via /api/score/mute; persisted at scoring.mutedTerms).
const MUTED = new Set((SCORING.mutedTerms || []).map(t => String(t).toLowerCase()));

// v4.0: context guards for ambiguous CV terms — the "Palo Alto" fix. A term
// listed here only scores when its disambiguating context appears in the SAME
// text; "Palo Alto, CA" in a location line no longer credits the firewall
// vendor skill. Only consulted for terms the CV actually contains.
export const AMBIGUOUS_TERM_CONTEXT = {
  'palo alto': /palo\s*alto\s*networks|pan-?os\b|panorama|prisma|ngfw|cortex|firewall/i,
  'chef':      /chef\s+(server|infra|cookbooks?|recipes?|automate)|opscode|configuration management/i,
  'puppet':    /puppet\s+(enterprise|server|modules?|manifests?|bolt)|configuration management/i,
  'salt':      /saltstack|salt\s+(stack|master|minion|states?)/i,
};
export function termAllowedInText(term, text) {
  const rx = AMBIGUOUS_TERM_CONTEXT[String(term).toLowerCase()];
  return !rx || rx.test(text);
}

// v4.0: role-family soft gate. A job whose TITLE is clearly a non-technical
// family (marketing, sales, HR, …) can't climb the ranks on keyword crumbs —
// its score is multiplied down unless the title itself carries one of the
// CV's own cluster terms ("Marketing Security Manager" escapes). Only active
// when the CV has detected primary clusters; fail-open otherwise.
export const OFF_FAMILY_RX = /\b(marketing|sales(?:\s+(?:rep|representative|associate))?|account (?:executive|manager)|business development|recruiter|talent acquisition|human resources|customer (?:success|service|support)|paralegal|attorney|accountant|bookkeeper|nurse|physician|dental|driver|warehouse|forklift|barista|cashier|retail associate|property manager|real estate agent)\b/i;
export const FAMILY_PENALTY = 0.35;
// v5.0: the off-family list (OFF_FAMILY_RX) is tech-centric — it names non-tech
// fields as "off-family". So the penalty may ONLY fire when the user's OWN
// vertical is tech; otherwise a nurse / sales / finance user would get their own
// target roles penalized ×0.35. Non-tech users (or an unreadable CV) never get
// the penalty. Keys match cv-keywords.json's original tech clusters.
export const TECH_CLUSTER_KEYS = new Set(['iam', 'cloudsec', 'm365', 'devops', 'softwareEng', 'data', 'soc', 'networking', 'design', 'mobile', 'product']);
function familyPenalty(title) {
  const primaryIsTech = CV_PRIMARY_CLUSTERS.some(c => TECH_CLUSTER_KEYS.has(c));
  if (!primaryIsTech || !title || !OFF_FAMILY_RX.test(title)) return 1;
  for (const t of CLUSTER_TERMS) {
    if (t.length > 2 && termRegex(t).test(title)) return 1;
  }
  return FAMILY_PENALTY;
}

export function scoreJob(job) {
  const text = ((job.title || '') + '\n' + (job.cardText || ''));
  let score = 0;
  const matched = [];
  const seen = new Set();
  const tryMatch = (term, baseWeight) => {
    if (seen.has(term.toLowerCase())) return;
    if (MUTED.has(term.toLowerCase())) return;              // v4.0
    const weight = baseWeight * clusterMultiplier(term);
    // Exact phrase / word-boundary match. Term-frequency cap: count up to TF_CAP.
    const re = termRegex(term, 'gi');
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      if (!termAllowedInText(term, text)) return;           // v4.0: ambiguous-term guard
      const tf = Math.min(matches.length, TF_CAP);
      score += weight * tf;
      matched.push(tf > 1 ? `${term} ×${tf}` : term);
      seen.add(term.toLowerCase());
      return;
    }
    // Multi-token phrase that didn't match exactly — try tokens-anywhere fallback
    if (term.includes(' ') && tokensAllPresent(text, term)) {
      if (!termAllowedInText(term, text)) return;           // v4.0
      score += weight * 0.5;
      matched.push(`${term} (partial)`);
      seen.add(term.toLowerCase());
    }
  };
  for (const t of CV_TITLES)     tryMatch(t, W_TITLE);
  for (const c of CV_CERTS)      tryMatch(c, W_CERT);
  for (const s of CV_SKILLS)     tryMatch(s, W_SKILL);
  for (const c of CV_COMPLIANCE) tryMatch(c, W_COMPLIANCE);
  // v4.0: salary no longer adds/removes score points (it lifted irrelevant
  // jobs past the floor). It's now a TIE-BREAKER in compareJobs — parsed
  // here so the caller can stash salaryK on the row.
  const salaryNums = parseSalaryK(text);
  const salaryK = salaryNums.length ? Math.max(...salaryNums) : 0;
  score *= familyPenalty(job.title);                         // v4.0
  return { score, matched, salaryK };
}

// Calibrated raw-score → percentage. score 30+ → 90-100%, etc.
function scoreToPercent(s) {
  if (s >= 30) return Math.min(100, Math.round(90 + (s - 30) * 0.5));
  if (s >= 20) return Math.round(75 + (s - 20) * 1.5);
  if (s >= 10) return Math.round(50 + (s - 10) * 2.5);
  if (s >= 5)  return Math.round(30 + (s - 5) * 4);
  return Math.max(0, Math.round(s * 7));
}

function requirementScore(job, text, fallbackPercent = 0) {
  return matchRequirements({
    jobTitle: job.title || '',
    text,
    cv: CV,
    dictionary: CV_DICTIONARY,
    targetTerms: TARGET_TERMS,
    mutedTerms: [...MUTED],
    fallbackPercent,
  });
}

// v4.0: percentage bands for the FULL-DESCRIPTION rescore. JD text is ~4-5×
// longer than a card, so raw scores run higher; these bands are scaled up
// (~1.6×) and continuous at each boundary (48→90, 32→75, 16→50, 8→30).
export function jdScoreToPercent(s) {
  if (s >= 48) return Math.min(100, Math.round(90 + (s - 48) * 0.3));
  if (s >= 32) return Math.round(75 + (s - 32) * 0.9375);
  if (s >= 16) return Math.round(50 + (s - 16) * 1.5625);
  if (s >= 8)  return Math.round(30 + (s - 8) * 2.5);
  return Math.max(0, Math.round(s * 3.75));
}

// v4.0: final ordering — match % first, salary breaks ties. Known salary at
// or above the user's floor ranks by amount; unknown salary is neutral;
// below-floor salary sorts last among equals.
export function salaryRank(r) {
  const k = r.salaryK || 0;
  if (!k) return 0;
  return k >= SALARY_FLOOR_K ? k : -1000 + k;
}
export function compareJobs(a, b) {
  if ((b.matchPct ?? 0) !== (a.matchPct ?? 0)) return (b.matchPct ?? 0) - (a.matchPct ?? 0);
  return salaryRank(b) - salaryRank(a);
}

// v4.0: "the job asks for, your resume doesn't mention." Scans the JD against
// the FULL cv-keywords dictionary (all domains) for known terms that the CV
// lacks — powering the Why panel's misses row. Weighted: titles > certs >
// skills/compliance, then term frequency.
const DICT_ALL = (() => {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'cv-keywords.json'), 'utf8'));
    return [
      ...(d.titles || []).map(t => ({ t, w: 3 })),
      ...(d.certs || []).map(t => ({ t, w: 2 })),
      ...(d.skills || []).map(t => ({ t, w: 1 })),
      ...(d.compliance || []).map(t => ({ t, w: 1 })),
    ];
  } catch { return []; }
})();
const CV_ALL_TERMS = new Set(
  [...CV_TITLES, ...CV_CERTS, ...CV_SKILLS, ...CV_COMPLIANCE].map(t => t.toLowerCase()));
export function missingTerms(text, max = 6) {
  const out = [];
  for (const { t, w } of DICT_ALL) {
    const lt = t.toLowerCase();
    if (CV_ALL_TERMS.has(lt) || MUTED.has(lt)) continue;
    const m = text.match(termRegex(t, 'gi'));
    if (m && termAllowedInText(t, text)) out.push({ t, rank: w * Math.min(m.length, 3) });
  }
  out.sort((a, b) => b.rank - a.rank);
  return out.slice(0, max).map(x => x.t);
}

// Anything mentioning a US-government clearance gets dropped. Hits both the
// title and the card body text so we catch jobs like "Security Engineer (TS/SCI)"
// AND ones where the title is generic but the body says "active Secret required".
const CLEARANCE_RX = /\b(top[\s-]*secret|ts\/sci|\bsecret\s+clearance\b|public[\s-]*trust|polygraph|sf-?86|dod[\s-]*clearance|government[\s-]*clearance|federal[\s-]*clearance|active[\s-]+(security|secret|government)[\s-]+clearance|clearance(?:\s+is)?\s+required|cleared[\s-]+(?:personnel|professional)|able\s+to\s+obtain[^.]{0,40}clearance|must\s+be\s+a\s+u\.?s\.?\s+citizen|us\s+citizenship\s+required)\b/i;

function filterAndDedupe(byQuery, extraCards = []) {
  const collected = [];
  for (const [q, rows] of Object.entries(byQuery)) {
    for (const r of rows) {
      r.q = KEY_TO_TERM[q] || q; collected.push(r);
    }
  }
  // v5.0: ATS source jobs (pre-normalized, pre-resolved) join the same pool and
  // pass through the exact same drop rules below. Their `q` is the source name.
  for (const r of extraCards) {
    if (!r) continue;
    r.q = r.q || r.source || 'ats'; collected.push(r);
  }
  const deduped = dedupeJobs(collected);
  const all = deduped.jobs;
  const filterClearance = CFG.filters?.filterClearance === true; // v5.0: default OFF (opt-in)
  const maxYoe = CFG.user?.maxYoeAcceptable ?? 100; // v5.0: default effectively no cap
  // v2.5: recency filter. filters.maxJobAge is a preset key (today|3days|
  // week|month|any) or a raw day count; recencyMaxDays → max age in days
  // (null = keep everything). Jobs whose card age we can't read are kept.
  const maxAgeDays = recencyMaxDays(CFG.filters?.maxJobAge);
  let droppedClearance = 0;
  let droppedStale = 0;
  let droppedManagement = 0;
  let droppedSales = 0;
  const kept = all.filter(r => {
    if (r.yoe !== null && r.yoe > maxYoe) return false;
    if (r.title && DROP_TITLE.test(r.title)) return false;
    const titleCategory = excludedTitleCategory(r.title, CFG.filters);
    if (titleCategory === 'management') { droppedManagement++; return false; }
    if (titleCategory === 'sales') { droppedSales++; return false; }
    if (r.company && SKIP_CO.test(r.company)) return false;
    if (!withinRecency(r.postedAge, maxAgeDays)) { droppedStale++; return false; }
    if (filterClearance) {
      const body = (r.title || '') + '\n' + (r.cardText || '');
      if (CLEARANCE_RX.test(body)) { droppedClearance++; return false; }
    }
    return true;
  });
  return {
    all, kept,
    rawCount: collected.length,
    droppedDuplicates: deduped.dropped,
    droppedClearance, droppedStale, droppedManagement, droppedSales,
  };
}

function emptyIdentityState() {
  return { urls: new Set(), exact: new Set(), bases: new Set(), looseBases: new Set() };
}

function addIdentityToState(state, identity = {}) {
  if (identity.url) state.urls.add(identity.url);
  if (!identity.company || !identity.title) return;
  const base = `${identity.company}\u0000${identity.title}`;
  state.bases.add(base);
  if (identity.location) state.exact.add(`${base}\u0000${identity.location}`);
  else state.looseBases.add(base);
}

function matchesIdentityState(job, state) {
  const id = jobIdentity(job);
  if (id.url && state.urls.has(id.url)) return true;
  if (!id.company || !id.title) return false;
  const base = `${id.company}\u0000${id.title}`;
  return id.location
    ? state.exact.has(`${base}\u0000${id.location}`) || state.looseBases.has(base)
    : state.bases.has(base);
}

function loadAppliedState() {
  const state = emptyIdentityState();
  try {
    const apps = fs.readFileSync(PP.applications, 'utf8');
    for (const match of apps.matchAll(/https:\/\/[^\s)>]+/gi)) {
      const rawUrl = match[0].replace(/[.,;]+$/, '');
      addIdentityToState(state, jobIdentity({ href: rawUrl }));
      const hcafe = rawUrl.match(/hiring\.cafe\/(?:viewjob|job)\/([a-z0-9]+)/i);
      if (hcafe) addIdentityToState(state, jobIdentity({ href: `https://hiring.cafe/job/${hcafe[1].toLowerCase()}` }));
    }
  } catch {}
  for (const entry of Object.values(readAppliedLedger(PP.appliedJobs).jobs)) {
    addIdentityToState(state, entry?.identity || jobIdentity({ ...entry, href: entry?.url }));
  }
  return state;
}

// Persistent map of every viewjob URL we've ever surfaced via Telegram, with
// firstSeen / lastSeen timestamps. Combined with applications.md, this is
// what guarantees fresh jobs each run.
//
// v1.0 E3 — schema upgraded from `{ids: string[]}` (boolean has-seen) to
// `{jobs: {url: {firstSeenAt, lastSeenAt}}}`. Old entries auto-migrate on
// first load. Decay rule: drop entries with `lastSeenAt > N days ago` so
// jobs that didn't get applied to come back into rotation after the window
// (default 60 days). Applied jobs are blocked separately via applications.md.
const SEEN_PATH = PP.seenJobs;
const SEEN_FRESHNESS_DAYS = SCORING.seenJobsFreshnessDays ?? 60;

function loadSeenStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
    // Migrate old flat schema if encountered.
    if (Array.isArray(raw.ids) && !raw.jobs) {
      log(`Migrating seen-jobs.json: ${raw.ids.length} entries → new schema (firstSeenAt/lastSeenAt).`);
      const stamp = raw.lastUpdated || new Date().toISOString();
      const jobs = {};
      for (const url of raw.ids) jobs[url] = { firstSeenAt: stamp, lastSeenAt: stamp };
      return { lastUpdated: stamp, jobs, _migrated: true };
    }
    return { lastUpdated: raw.lastUpdated || null, jobs: raw.jobs || {} };
  } catch {
    return { lastUpdated: null, jobs: {} };
  }
}

function decaySeenStore(store) {
  const cutoff = Date.now() - SEEN_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
  let dropped = 0;
  const fresh = {};
  for (const [url, meta] of Object.entries(store.jobs)) {
    const lastSeen = new Date(meta.lastSeenAt || meta.firstSeenAt || 0).getTime();
    if (lastSeen >= cutoff) fresh[url] = meta;
    else dropped++;
  }
  return { fresh, dropped };
}

// Returns the set of URLs currently considered "blocked by previous-seen."
// Decayed entries are NOT in this set — they're back in the supply pool.
function loadBlockedSeen() {
  const store = loadSeenStore();
  const { fresh, dropped } = decaySeenStore(store);
  if (dropped > 0) log(`Decayed ${dropped} seen entries past ${SEEN_FRESHNESS_DAYS}-day freshness window.`);
  const state = emptyIdentityState();
  for (const url of Object.keys(fresh)) addIdentityToState(state, jobIdentity({ href: url }));
  for (const meta of Object.values(fresh)) {
    addIdentityToState(state, meta?.identity);
  }
  return state;
}

function wasSeen(job, state) {
  return matchesIdentityState(job, state);
}

// Persist the seen store. Called only after Telegram delivery succeeds for
// the batch — see "Persist seen IDs" block below. v1.0 E3 race fix: was
// previously written before sendDocument retries, so a Telegram outage
// mid-attachment could mark jobs seen that the user never received.
function saveSeenStore(_blockedState, top) {
  const store = loadSeenStore();
  const { fresh } = decaySeenStore(store);
  const now = new Date().toISOString();
  // F-M5: only record what was actually shown today. Preserve the original
  // firstSeenAt (looking up the pre-decay store, not just `fresh`) so a
  // job that was about to age out but got re-shown keeps its real
  // first-seen timestamp instead of being reset to `now`. That used to
  // bump near-expired entries back to day 0 every batch — meaning the
  // 60-day decay window was effectively "60 days since last sighting,"
  // not the documented "60 days since first sighting." The old belt-
  // and-suspenders rewrite of `blockedSet` is dropped — it was the bug.
  for (const r of top) {
    const existing = fresh[r.href] || store.jobs[r.href];
    fresh[r.href] = {
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
      identity: jobIdentity(r),
    };
  }
  const out = {
    lastUpdated: now,
    freshnessDays: SEEN_FRESHNESS_DAYS,
    jobs: fresh
  };
  atomicWriteJson(SEEN_PATH, out);
}

// Track when the bot last confirmed a healthy hiring.cafe session.
// Used by the periodic re-auth nag and by the /auth bot command.
const AUTH_PATH = path.join(ROOT, 'data', 'auth-state.json');
function recordAuthOk() {
  atomicWriteJson(AUTH_PATH, {
    lastAuthOK: new Date().toISOString(),
    lastAuthFail: null
  });
}
function recordAuthFail() {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); } catch {}
  atomicWriteJson(AUTH_PATH, {
    lastAuthOK: prev.lastAuthOK || null,
    lastAuthFail: new Date().toISOString()
  });
}

// v1.0.x: Cloudflare bot-blocks plain Node fetch on viewjob URLs (returns
// 403 even with auth cookies via APIRequestContext). Real-browser navigation
// works. This re-launches the persistent profile (auth cookies preserved),
// spawns a small page pool, and parallel-fetches each viewjob page,
// extracting "apply_url" from the rendered HTML.
async function resolveOnePage(page, viewjobUrl) {
  try {
    await page.goto(viewjobUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    // Settle so JSON payload renders into HTML
    await page.waitForTimeout(1500);
    const html = await page.content();
    // v4.0: we're already standing on the job page for the apply-URL — now we
    // finally READ it. The rendered body text (title + full description +
    // hiring.cafe's requirements summary) feeds the second-pass rescore.
    let jdText = '';
    try { jdText = await page.evaluate(() => document.body.innerText || ''); } catch {}
    jdText = String(jdText).replace(/\s+/g, ' ').slice(0, 7000);
    const m = html.match(/"apply_url":"([^"]+)"/);
    if (!m) return { directUrl: null, jdText };
    const u = m[1];
    // Sanity check — `apply_url` is attacker-controllable (whatever the job
    // poster typed into hiring.cafe). Reject anything that isn't a plain
    // http(s) URL with no embedded HTML/quote characters before we let it
    // through to a Telegram <a href="…"> interpolation. Defense layered with
    // escHtmlAttr() at the message-build site (see buildMessage / F-H1).
    if (!/^https?:\/\/[^\s<>"']+$/i.test(u)) return { directUrl: null, jdText };
    return { directUrl: u, jdText };
  } catch { return { directUrl: null, jdText: '' }; }
}

async function resolveAll(rows) {
  if (!rows.length) return [];
  // v5.0: ATS jobs (from source adapters) already carry their JD + apply URL,
  // so they skip Playwright entirely. If EVERY shortlisted job is from an ATS,
  // don't even launch a browser.
  const preResolve = async (r) => {
    let jdText = r.jdText || '';
    let descriptionQuality = r.__descriptionComplete ? 'full' : (jdText ? 'summary' : 'missing');
    if (typeof r.__loadDescription === 'function') {
      try {
        const loaded = await r.__loadDescription();
        if (loaded) jdText = loaded;
        descriptionQuality = r.__descriptionComplete ? 'full' : (jdText ? 'summary' : 'missing');
      } catch { /* best-effort: retain the search summary */ }
    }
    return { directUrl: r.directUrl || r.href, jdText, descriptionQuality };
  };
  const out = new Array(rows.length);
  const atsIndexes = rows.map((r, idx) => r.__ats ? idx : -1).filter(idx => idx >= 0);
  let atsCursor = 0;
  await Promise.all(Array.from({ length: Math.min(5, atsIndexes.length) }, async () => {
    while (atsCursor < atsIndexes.length) {
      const idx = atsIndexes[atsCursor++];
      out[idx] = await preResolve(rows[idx]);
    }
  }));
  if (rows.every(r => r.__ats)) return out;
  log(`Launching browser for direct-URL resolution (${rows.filter(r => !r.__ats).length} hiring.cafe jobs)…`);
  const ctx = await launchBrowser();
  try {
    const PAR = 5; // 5 concurrent pages — balances speed vs bot-detection risk
    const pages = [];
    for (let i = 0; i < PAR; i++) {
      pages.push(i === 0 ? (ctx.pages()[0] || await ctx.newPage()) : await ctx.newPage());
    }
    let i = 0;
    let resolved = 0;
    await Promise.all(pages.map(async (p) => {
      while (true) {
        const idx = i++;
        if (idx >= rows.length) break;
        const r = rows[idx];
        if (r.__ats) { if (out[idx]?.directUrl) resolved++; continue; }
        out[idx] = await resolveOnePage(p, r.href);
        if (out[idx]) out[idx].descriptionQuality = out[idx].jdText?.length >= 1000 ? 'full' : (out[idx].jdText ? 'summary' : 'missing');
        if (out[idx]?.directUrl) resolved++;
      }
    }));
    return out;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Telegram HTML mode recognizes & < > as syntax. For text contexts that's
// enough; for attribute contexts (href="…"), `"` can break out of the
// attribute and Telegram does NOT auto-escape it. escHtmlAttr is the
// attribute-safe variant — use it for every `href=` interpolation.
function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escHtmlAttr(s) { return escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

// v1.0 E3: prepend supply-side warnings to the batch when something's off.
// (1) afterDedup < 30 → low supply, suggest /forget last + /jobs add
// (2) any query has 3+ consecutive zero-card days → likely typo, suggest /jobs remove + /jobs add
function buildSupplyBanner({ funnel, byQuery }) {
  const warnings = [];
  if ((funnel.sent ?? 0) < (funnel.targetJobsPerBatch ?? 0) && (funnel.afterDedup ?? 0) >= 30) {
    const unchecked = funnel.unevaluatedCandidates || 0;
    warnings.push(funnel.descriptionCeilingReached
      ? `⚠️ <b>Found ${funnel.sent} strong matches after reaching the ${funnel.descriptionEvaluated}-description safety ceiling.</b> ${unchecked} candidates were not evaluated; raise the ceiling to inspect them in this run.`
      : `⚠️ <b>Found ${funnel.sent} strong matches after checking all ${funnel.descriptionEvaluated} candidates.</b> No qualifying matches were held for tomorrow, and AMM did not pad the batch with weaker jobs.`);
  }
  if (funnel.afterDedup < 30) {
    warnings.push(`⚠️ <b>Limited supply today: ${funnel.afterDedup} fresh jobs</b> (typical: 50–80).`);
    const tips = [];
    // Dedup-pressure diagnostic: if filter pass-through was healthy but
    // dedup ate most of it, the freshness window is the real lever.
    const dedupPressure = funnel.keptAfterFilter > 0 ? Math.round((1 - funnel.afterDedup / funnel.keptAfterFilter) * 100) : 0;
    if (dedupPressure >= 50 && funnel.keptAfterFilter >= 50) {
      tips.push(`<b>${dedupPressure}% of today's filter-passing cards were already seen</b> in the past ${SEEN_FRESHNESS_DAYS} days. Lower this in <code>config.json</code>: <code>profiles.&lt;active&gt;.scoring.seenJobsFreshnessDays</code> (try 14). Or run <code>/forget all</code> for a clean slate.`);
    }
    if (funnel.droppedBelowFloor > 0) tips.push(`Lower the match floor with <code>/floor 0</code> (currently ${funnel.matchFloorPercent}%) — would surface ${funnel.droppedBelowFloor} more.`);
    tips.push(`<code>/forget last</code> to revisit yesterday's batch.`);
    tips.push(`<code>/jobs add "Title"</code> to widen your queries.`);
    warnings.push(tips.join('\n'));
  }
  // Dry-query detection — read the freshly-written stats and find queries
  // averaging zero across the most recent 3+ runs.
  let stats = null;
  try { stats = JSON.parse(fs.readFileSync(QUERY_STATS_PATH, 'utf8')); } catch {}
  const dryQueries = findDryQueries(stats);
  if (dryQueries.length) {
    warnings.push(`⚠️ <b>Dry queries (3+ days at 0 cards):</b>\n${dryQueries.map(q => '  · ' + escHtml(q)).join('\n')}\nLikely typos or terms hiring.cafe doesn't index. Edit via <code>/jobs remove</code> + <code>/jobs add</code>.`);
  }
  return warnings.length ? warnings.join('\n\n') : null;
}

export function findDryQueries(stats, minRuns = 3) {
  const requiredRuns = Math.max(1, Number.parseInt(minRuns, 10) || 3);
  const dry = [];
  for (const [term, slot] of Object.entries(stats?.queries || {})) {
    const recent = Array.isArray(slot?.history) ? slot.history.slice(-requiredRuns) : [];
    if (recent.length >= requiredRuns && recent.every(h => h?.cards === 0)) dry.push(term);
  }
  return dry;
}
// v4.1: one-line funnel so "3,000 raw but only 100 jobs — where'd they go?" is
// answerable at a glance. Every number comes straight off the funnel object
// that's already written to last-batch.json — no new bookkeeping. Plain text
// (arrows + numbers only, no markup) so it's safe in both HTML and the .txt.
function funnelLine(f) {
  if (!f) return '';
  const seen = Math.max(0, (f.keptAfterFilter ?? 0) - (f.afterDedup ?? 0));
  const checked = f.descriptionEvaluated ?? f.scored ?? 0;
  const aboveFloor = f.qualifyingMatches ?? Math.max(0, checked - (f.droppedBelowFloor ?? 0));
  const duplicates = f.droppedDuplicates ?? 0;
  const full = f.fullDescriptions ?? f.descriptionScored ?? 0;
  const smart = f.smartMatchEvaluated ? ` · ${f.smartMatchEvaluated} Smart Match` : '';
  return `${f.raw ?? 0} raw → ${f.uniqueBeforeFilter ?? ((f.raw ?? 0) - duplicates)} unique (−${duplicates} duplicates) → ${f.keptAfterFilter ?? 0} after filters → ${f.afterDedup ?? 0} fresh (−${seen} already seen) → ${checked} checked (${full} full descriptions${smart}) → ${aboveFloor} above ${f.matchFloorPercent ?? 0}% → ${f.sent ?? 0} delivered`;
}
function buildMessage(weather, top, directUrls, stats) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const filterBits = [];
  if (stats.droppedClearance) filterBits.push(`${stats.droppedClearance} clearance`);
  if (stats.droppedManagement) filterBits.push(`${stats.droppedManagement} management/lead`);
  if (stats.droppedSales)      filterBits.push(`${stats.droppedSales} sales`);
  if (stats.skippedApplied)   filterBits.push(`${stats.skippedApplied} applied`);
  if (stats.skippedSeen)      filterBits.push(`${stats.skippedSeen} previously seen`);
  const tail = filterBits.length ? ` · filtered: ${filterBits.join(', ')}` : '';
  const userName = CFG.user?.name || 'there';
  const headerTpl = (CFG.telegram?.messageHeader || '☀️ Good morning {NAME} — {DATE}')
    .replace('{NAME}', userName)
    .replace('{DATE}', today);
  // v4.3: truthful dedup/auth line (the old one said "✓ logged in"
  // unconditionally — stale since the v1.0.x switch to unauth scraping).
  // dedupMode() centralizes the branch so this line, the .txt header, and
  // /diagnose can never disagree; the wording per mode stays local.
  const dedupNote = DEDUP_NOTE[dedupMode({ authed: stats.hcafeAuthed, enabled: stats.accountDedupEnabled })];
  const authIndicator = CFG.telegram?.showAuthIndicator !== false
    ? `\n${dedupNote}\nSorted by CV match — best fits first.`
    : '\nSorted by CV match — best fits first.';
  const funnelStr = funnelLine(stats.funnel);
  const funnelBit = funnelStr ? `\n<i>${funnelStr}</i>` : '';
  const head = `<b>${headerTpl}</b>\n\n${weather}\n\n📊 <b>${top.length} fresh jobs</b> · ${stats.raw} raw${tail}${funnelBit}${authIndicator}`;
  const lines = [head, ''];
  top.forEach((r, i) => {
    const url = directUrls[i] || r.href;
    const title = escHtml(r.title);
    const co = escHtml(r.company);
    const yoe = r.yoe ? ` · ${r.yoe}+ YOE` : '';
    const pct = `${r.matchPct ?? 0}% match`;
    const matchedTop = (r.matched || []).slice(0, 5).map(escHtml).join(' · ');
    const matchedLine = matchedTop ? `\n✓ ${matchedTop}` : '';
    // F-H1: attacker-controllable URL inside HTML attribute + text. Use
    // escHtmlAttr for the href value (escapes "), escHtml for the visible
    // anchor text.
    const safeHref = escHtmlAttr(url);
    const safeText = escHtml(url);
    lines.push(`<b>${i + 1}.</b> ${title}${yoe} · <b>${pct}</b>\n<i>${co}</i>${matchedLine}\n<a href="${safeHref}">${safeText}</a>`);
    lines.push('');
  });
  return lines.join('\n');
}

// Build the human-readable batch as a downloadable .txt — same data the
// Telegram messages contain, but consolidated, scrollable, and Cmd+F-able.
// Naming: data/jobs(YYYY-MM-DD).txt — preserved in chat history forever.
function buildBatchTxt(top, directUrls, weather, stats) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const lines = [];
  lines.push('Automatic Munyun Machine — Job Batch');
  lines.push(`Date: ${DATE} (${today})`);
  lines.push(weather.replace(/[^\x20-\x7E°]/g, '').trim());
  const filterBits = [];
  if (stats.droppedClearance) filterBits.push(`${stats.droppedClearance} clearance`);
  if (stats.droppedManagement) filterBits.push(`${stats.droppedManagement} management/lead`);
  if (stats.droppedSales)      filterBits.push(`${stats.droppedSales} sales`);
  if (stats.skippedApplied)   filterBits.push(`${stats.skippedApplied} applied`);
  if (stats.skippedSeen)      filterBits.push(`${stats.skippedSeen} previously seen`);
  const tail = filterBits.length ? ` · filtered: ${filterBits.join(', ')}` : '';
  lines.push(`${top.length} jobs · ${stats.raw} raw${tail} · sorted by CV match`);
  const funnelStr = funnelLine(stats.funnel);
  if (funnelStr) lines.push(funnelStr);
  lines.push(DEDUP_TXT[dedupMode({ authed: stats.hcafeAuthed, enabled: stats.accountDedupEnabled })]);
  lines.push('');
  lines.push('================================================================');
  lines.push('');
  top.forEach((r, i) => {
    const url = directUrls[i] || '';
    const matched = (r.matched || []).join(', ') || '(no keyword matches — ranked on body context)';
    lines.push(`[${i + 1}] ${r.matchPct ?? 0}% match — ${r.title || '(untitled)'}`);
    if (r.company) lines.push(`    Company:  ${r.company}`);
    if (r.yoe)     lines.push(`    YOE:      ${r.yoe}+`);
    if (r.q)       lines.push(`    Search:   ${r.q}`);
    lines.push(`    Matched:  ${matched}`);
    if (url) lines.push(`    Apply:    ${url}`);
    lines.push(`    View:     ${r.href}`);
    lines.push('');
  });
  return lines.join('\n');
}

function writeBatchTxt(top, directUrls, weather, stats) {
  // Per-profile location so /profile switch doesn't show another persona's batch.
  fs.mkdirSync(PP.dir, { recursive: true });
  const file = path.join(PP.dir, `jobs(${DATE}).txt`);
  atomicWriteText(file, buildBatchTxt(top, directUrls, weather, stats));
  return file;
}

// The detailed jobs(date).txt remains the local, searchable archive. The file
// delivered to Telegram/email is intentionally the compact apply-links export:
// number, job title, and direct apply link only.
function writeApplyLinksTxt() {
  const exported = loadExport('txt');
  if (!exported.ok) throw new Error(exported.error || 'Could not build apply-links export.');
  const file = path.join(PP.dir, exported.filename);
  atomicWriteText(file, exported.content);
  return file;
}

function writeBatchTsv(top, directUrls, funnel) {
  fs.mkdirSync(PP.dir, { recursive: true });
  const tsv = top.map((r, i) => {
    const id = r.href.split('/').pop();
    const url = directUrls[i] || '';
    const title = (r.title || '').replace(/\t/g, ' ');
    const co = (r.company || '').replace(/\t/g, ' ');
    const yoe = r.yoe ?? '';
    return `${i + 1}\t${id}\t${title}\t${co}\t${yoe}\t${r.q}\t${url}`;
  }).join('\n');
  // The missed-batch watcher treats TSV existence as the success signal, so
  // publish artifacts atomically: readers never observe a partial file.
  atomicWriteText(path.join(PP.dir, `today-batch-${DATE}.tsv`), tsv + '\n');
  atomicWriteText(path.join(PP.dir, `today-batch-direct-urls-${DATE}.txt`), directUrls.filter(Boolean).join('\n') + '\n');

  // Rich per-job match details, used by the bot's /why N command.
  // Funnel data is read by /diagnose to show the supply pipeline.
  const lastBatch = {
    date: DATE,
    profile: PP.dir.split(/[/\\]/).pop(),
    generatedAt: new Date().toISOString(),
    funnel: funnel || null,
    jobs: top.map((r, i) => ({
      idx: i + 1,
      id: r.href.split('/').pop(),
      title: r.title,
      company: r.company,
      location: r.location || '',
      yoe: r.yoe,
      postedAge: r.postedAge || '',
      q: r.q,
      score: r.score ?? 0,
      matchPct: r.matchPct ?? 0,
      matched: r.matched || [],
      // v4.0: score-journey + coaching fields for the dashboard's Why panel.
      cardPct: r.cardPct ?? r.matchPct ?? 0,
      jdPct: r.jdPct ?? null,
      aiPct: r.aiPct ?? null,
      aiReason: r.aiReason || '',
      aiSub: r.aiSub || null,   // v7.0: {skills, seniority, role} rubric subscores
      missing: r.missing || [],
      coveragePct: r.coveragePct ?? null,
      rolePct: r.rolePct ?? null,
      requirementCount: r.requirementCount ?? 0,
      matchConfidence: r.matchConfidence ?? null,
      yearsRequired: r.yearsRequired ?? 0,
      careerYears: r.careerYears ?? 0,
      descriptionQuality: r.descriptionQuality || 'unknown',
      salaryK: r.salaryK || 0,
      src: r.source || 'hcafe', // v7.3: where the job came from (hcafe/dice/greenhouse/lever/ashby)
      directUrl: directUrls[i] || '',
      viewjobUrl: r.href
    }))
  };
  atomicWriteJson(PP.lastBatch, lastBatch);

  // v4.6: append today's snapshot to batch-history.json (Trends view + search
  // leaderboard). Re-runs on the same date replace that day's entry. Non-fatal.
  try {
    appendHistory(PP.batchHistory, summarizeBatch({
      date: DATE,
      generatedAt: lastBatch.generatedAt,
      jobs: lastBatch.jobs,
      funnel
    }));
  } catch (e) {
    log(`batch-history write skipped (non-fatal): ${SCRUB(String(e.message || e))}`);
  }

  // v7.2: archive the FULL batch (jobs included) so re-scraping never loses
  // the previous list. 30-day retention; dashboard lists/downloads them.
  try {
    archiveBatch(PP.batchArchiveDir, lastBatch);
  } catch (e) {
    log(`batch-archive write skipped (non-fatal): ${SCRUB(String(e.message || e))}`);
  }
}

// Run the scrape pipeline only when invoked as a CLI (see IS_CLI computation
// at the top of the file). Skipped on `import`, so test files can pull
// scoreJob / parseSalaryK without triggering a real scrape.
if (IS_CLI) (async () => {
  // Cross-process scrape lock (v2.0). The bot's in-memory runningJob lock
  // can't see Task Scheduler's independent munyun-daily-batch trigger, so a
  // 7am scheduled run and a /scrape could previously run concurrently —
  // duplicate batches, and the loser's seen-jobs read-modify-write clobbers
  // the winner's. proper-lockfile auto-refreshes the lock's mtime while we
  // hold it, so the 30s stale ceiling tolerates multi-minute scrapes while
  // a crashed holder frees the lock within 30s.
  const lockfile = (await import('proper-lockfile')).default;
  const SCRAPE_LOCK = path.join(ROOT, 'data', 'scrape.lock');
  let releaseScrapeLock = null;
  try {
    fs.mkdirSync(path.dirname(SCRAPE_LOCK), { recursive: true });
    if (!fs.existsSync(SCRAPE_LOCK)) fs.writeFileSync(SCRAPE_LOCK, '');
    releaseScrapeLock = await lockfile.lock(SCRAPE_LOCK, { stale: 30000, retries: 0, realpath: false });
  } catch {
    log('Another scrape holds data/scrape.lock — skipping this run.');
    try { await tg('⏳ Another scrape is already running — skipped this one.'); } catch {}
    return; // exit 0: an overlapping run isn't a failure
  }
  try {
    log(`=== daily-batch ${DATE} ===`);

    // F-H9: a freshly-added profile starts with an empty CV (no /resume
    // upload yet). Every job scores 0 → all dropped by match floor → user
    // gets a confusing empty batch. Fail loud with a Telegram nudge instead.
    if (!CV.titles?.length && !CV.skills?.length && !CV.certs?.length && !CV.compliance?.length) {
      const msg = '⚠️ <b>This profile has no parsed CV.</b>\n\nEvery job will score 0% until you upload one. Run <code>/resume</code> in the bot, then <code>/scrape</code>.';
      log('Empty CV detected — aborting batch with user nudge.');
      writeScrapeStatus(false, { error: 'This profile has no parsed resume — upload one on the Resume page, then scrape again.', kind: 'no-cv' });
      try { await tg(msg); } catch {}
      return;
    }

    let byQuery, hcafeAuthed = false, accountDedupEnabled = true;
    // v7.3: when the source selection leaves hiring.cafe with zero terms
    // (scrapeSources='dice' or every term tagged Dice-only), skip the whole
    // Playwright scrape — Dice + ATS feeds are plain fetch. Auth state falls
    // back to the cached probe so dedup-mode wording stays honest.
    if (!HCAFE_QUERIES.length) {
      byQuery = {};
      hcafeAuthed = readHcafeAuthCache().authed === true;
      accountDedupEnabled = SCORING.accountDedup !== false;
      log('hiring.cafe scrape skipped — no terms routed to it (source selection).');
    } else try {
      ({ byQuery, hcafeAuthed, accountDedupEnabled } = await scrape());
    } catch (e) {
      if (e.unauth) {
        recordAuthFail();
        writeScrapeStatus(false, { error: 'hiring.cafe blocked the scrape — your job feed needs a re-warm (or the site changed its layout).', kind: 'auth' });
        log('AUTH FAIL: ' + SCRUB(e.message));
        // Cross-platform-aware help string. The bot stamps the right helper
        // path per OS in v1.1; for the scraper's failure path we point at
        // the platform-neutral "login-once helper" + npm-script form so the
        // message renders correctly on Mac/Linux too.
        await tg('⚠️ <b>Hiring.cafe session expired.</b>\nRun the login-once helper (<code>npm run login</code>) to clear Cloudflare — the bot will resume normally on the next /daily.');
        return; // exit clean, don't propagate as crash
      }
      throw e;
    }
    // v5.0: pull configured ATS boards (best-effort, never throws) and merge
    // them into the same filter+score pipeline as the hiring.cafe cards.
    // v7.4: Dice is always-on — fetch whenever any term routes to it, with or
    // without ATS boards configured.
    // v7.5: the user's workplace/location/recency filters ride the Dice search
    // URL itself (buildDiceSearchUrl) so page 1 is already filtered server-
    // side — fixes "Dice only returned 2 jobs" (unfiltered nationwide page 1,
    // then the client workplace filter gutted it).
    const diceFilters = {
      workplaceTypes: normalizeWorkplaceTypes(CFG.search?.workplaceTypes),
      location: CFG.search?.location || '',
      maxAgeDays: recencyMaxDays(CFG.filters?.maxJobAge)
    };
    // v7.5: Watch support for Dice. Dice is plain fetch (no browser), so when
    // the user clicked Watch, mirror every Dice search URL in a visible
    // browser page — they see exactly what Dice is being asked, page by page.
    // Navigation is serialized (terms fetch in parallel) and cosmetic: any
    // failure is swallowed, the browser closes when the fetch is done.
    let watchCtx = null, watchChain = Promise.resolve();
    const watchDice = process.env.AMM_SHOW_BROWSER === '1' && DICE_QUERY_TERMS.length;
    if (watchDice) {
      try {
        log('👁  Watch: opening a browser window to mirror the Dice searches…');
        watchCtx = await launchBrowser();
      } catch (e) { log(`watch browser skipped (non-fatal): ${SCRUB(String(e.message || e))}`); }
    }
    const onDicePage = watchCtx ? (url) => {
      watchChain = watchChain.then(async () => {
        const page = watchCtx.pages()[0] || await watchCtx.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1200); // let the user actually see each page
      }).catch(() => {});
      return watchChain;
    } : undefined;
    const atsCards = (SOURCES_CONFIGURED || DICE_QUERY_TERMS.length)
      ? await fetchAllSources(SOURCES, { workplaceTypes: normalizeWorkplaceTypes(CFG.search?.workplaceTypes), log, queries: DICE_QUERY_TERMS, diceOptions: { filters: diceFilters, onPage: onDicePage } }).catch((e) => { log(`ATS sources skipped: ${SCRUB(String(e.message || e))}`); return []; })
      : [];
    if (watchCtx) { try { await watchChain; await watchCtx.close(); } catch {} }
    if (atsCards.length) log(`ATS sources contributed ${atsCards.length} jobs`);
    const {
      all, kept, rawCount, droppedDuplicates,
      droppedClearance, droppedStale, droppedManagement, droppedSales,
    } = filterAndDedupe(byQuery, atsCards);
    log(`raw=${rawCount} unique=${all.length} keptAfterFilter=${kept.length} (duplicates=${droppedDuplicates}, droppedClearance=${droppedClearance}, droppedManagement=${droppedManagement}, droppedSales=${droppedSales}, droppedStale=${droppedStale})`);
    const applied = loadAppliedState();
    const blockedSeen = loadBlockedSeen(); // decayed: jobs > freshness window are no longer blocked
    const fresh = kept.filter(r => !matchesIdentityState(r, applied) && !wasSeen(r, blockedSeen));
    const skippedApplied = kept.filter(r => matchesIdentityState(r, applied)).length;
    const skippedSeen    = kept.filter(r => !matchesIdentityState(r, applied) && wasSeen(r, blockedSeen)).length;
    log(`afterDedup=${fresh.length} (skipped ${kept.length - fresh.length}: ${skippedApplied} applied + ${skippedSeen} previously seen, freshness=${SEEN_FRESHNESS_DAYS}d)`);

    // Pass 1 — cheap recall ranking on every card. The legacy raw score stays
    // as a secondary signal, but the displayed percentage is normalized
    // requirement coverage so long keyword-heavy cards cannot saturate it.
    for (const r of fresh) {
      const s = scoreJob(r);
      const legacyPct = scoreToPercent(s.score);
      const req = requirementScore(r, r.cardText || '', legacyPct);
      r.score = s.score;
      r.matched = req.matched.length ? req.matched : s.matched;
      r.missing = req.missing;
      r.salaryK = s.salaryK;
      r.matchPct = req.matchPct;
      r.cardPct = r.matchPct;
      r.coveragePct = req.coveragePct;
      r.rolePct = req.rolePct;
      r.requirementCount = req.requirementCount;
      r.matchConfidence = req.confidencePct;
      r.yearsRequired = req.yearsRequired;
      r.careerYears = req.careerYears;
      r.__rankScore = 0.7 * req.matchPct + 0.3 * legacyPct;
    }
    fresh.sort((a, b) => b.__rankScore - a.__rankScore);
    // A card is only a preview, so it may order candidates but never eliminate
    // one. Unfamiliar titles and sparse cards still get a description-level
    // chance within the per-run evaluation safety ceiling.
    const candidatePool = fresh;
    const JD_RESCORE = SCORING.jdRescore !== false; // default on
    // Pass 2 — evaluate descriptions in chunks until the requested number of
    // jobs truly clears the final floor. No fixed +30 cutoff: if the first
    // group is weak, keep digging instead of padding the batch or stopping.
    const evaluated = [];
    let cursor = 0;
    let jdScored = 0;
    let resolvedCount = 0;
    let fullDescriptionCount = 0;
    let smartMatchEvaluated = 0;
    while (cursor < candidatePool.length && cursor < MAX_DESCRIPTION_EVALUATIONS) {
      const remainingBudget = MAX_DESCRIPTION_EVALUATIONS - cursor;
      const firstSize = Math.min(DELIVER_COUNT + 50, MAX_DESCRIPTION_EVALUATIONS);
      const take = Math.min(cursor === 0 ? firstSize : DESCRIPTION_CHUNK, remainingBudget);
      const chunk = candidatePool.slice(cursor, cursor + take);
      if (!chunk.length) break;
      const resolved = await resolveAll(chunk);
      for (let i = 0; i < chunk.length; i++) {
        const r = chunk[i];
        r.__direct = resolved[i]?.directUrl || '';
        if (r.__direct) resolvedCount++;
        const jd = resolved[i]?.jdText || '';
        r.__jd = jd;
        r.descriptionQuality = resolved[i]?.descriptionQuality || (jd ? 'summary' : 'missing');
        if (r.descriptionQuality === 'full') fullDescriptionCount++;
        if (JD_RESCORE && jd.length >= 400) {
          const s2 = scoreJob({ title: r.title, cardText: jd });
          const req = requirementScore(r, jd, jdScoreToPercent(s2.score));
          r.jdPct = req.matchPct;
          r.matchPct = req.matchPct;
          r.coveragePct = req.coveragePct;
          r.rolePct = req.rolePct;
          r.requirementCount = req.requirementCount;
          r.matchConfidence = req.confidencePct;
          r.yearsRequired = req.yearsRequired;
          r.careerYears = req.careerYears;
          r.matched = req.matched.length ? req.matched : s2.matched;
          r.missing = req.missing;
          if (s2.salaryK) r.salaryK = s2.salaryK;
          jdScored++;
        }
        evaluated.push(r);
      }
      const aiApplied = await applySmartMatch(chunk);
      if (aiApplied < 0) smartMatchEvaluated = 0;
      else smartMatchEvaluated += aiApplied;
      if (aiApplied > 0) log(`Smart Match evaluated ${aiApplied}/${chunk.length} candidates in this description pass`);
      cursor += chunk.length;
      const qualifying = evaluated.filter(r => r.matchPct >= MATCH_FLOOR_PCT).length;
      log(`description pass: evaluated=${evaluated.length}, resolved=${resolvedCount}, qualifying=${qualifying}/${DELIVER_COUNT}`);
      if (qualifying >= DELIVER_COUNT) break;
    }
    const unevaluatedCandidates = Math.max(0, candidatePool.length - evaluated.length);
    if (JD_RESCORE) log(`description-rescored ${jdScored}/${evaluated.length}; full descriptions=${fullDescriptionCount}; not evaluated=${unevaluatedCandidates}`);

    evaluated.sort(compareJobs);
    const aboveFloor = evaluated.filter(r => r.matchPct >= MATCH_FLOOR_PCT);
    const top = aboveFloor.slice(0, DELIVER_COUNT);
    const droppedBelowFloor = fresh.length - candidatePool.length
      + evaluated.filter(r => r.matchPct < MATCH_FLOOR_PCT).length;
    const directUrls = top.map(r => r.__direct || null);
    log(`final: top=${top[0]?.matchPct ?? 0}%  median=${top[Math.floor(top.length/2)]?.matchPct ?? 0}%  bottom=${top[top.length-1]?.matchPct ?? 0}%`);
    const funnel = {
      raw: rawCount,
      uniqueBeforeFilter: all.length,
      droppedDuplicates,
      keptAfterFilter: kept.length,
      droppedClearance,
      droppedManagement,
      droppedSales,
      afterDedup: fresh.length,
      scored: fresh.length,
      droppedBelowFloor,
      matchFloorPercent: MATCH_FLOOR_PCT,
      descriptionEvaluated: evaluated.length,
      descriptionScored: jdScored,
      fullDescriptions: fullDescriptionCount,
      smartMatchEvaluated,
      unevaluatedCandidates,
      descriptionCeilingReached: evaluated.length >= MAX_DESCRIPTION_EVALUATIONS && candidatePool.length > evaluated.length,
      qualifyingMatches: aboveFloor.length,
      // v4.5: the user's chosen batch size — `sent` may be lower when supply
      // (fresh jobs above the floor) runs out before reaching it.
      targetJobsPerBatch: DELIVER_COUNT,
      sent: top.length,
      topPct: top[0]?.matchPct ?? 0,
      medianPct: top[Math.floor(top.length / 2)]?.matchPct ?? 0,
      bottomPct: top[top.length - 1]?.matchPct ?? 0,
      // True when Saved/Applied account filtering was available. Viewed jobs
      // are deliberately never hidden; delivered-job dedup remains local.
      accountDedup: hcafeAuthed
    };
    writeBatchTsv(top, directUrls, funnel);
    const weather = await getWeather();
    const banner = buildSupplyBanner({ funnel, byQuery });
    let message = buildMessage(weather, top, directUrls, {
      raw: rawCount,
      kept: kept.length,
      droppedClearance,
      droppedManagement,
      droppedSales,
      skippedApplied,
      skippedSeen,
      hcafeAuthed,
      accountDedupEnabled,
      funnel
    });
    if (banner) message = banner + '\n\n' + message;
    if (TELEGRAM_ON) {
      const chunks = await tgChunked(message);
      log(`Telegram sent in ${chunks} chunk(s)`);
    } else {
      log('Telegram off — batch ready in the dashboard (last-batch.json) + jobs txt on disk.');
    }

    // Keep the detailed disk archive, but deliver the compact apply-links
    // file requested for handoff: number, title, and direct apply URL only.
    const txtStats = { raw: rawCount, droppedClearance, droppedManagement, droppedSales, skippedApplied, skippedSeen, hcafeAuthed, accountDedupEnabled, funnel };
    let deliveryTxtPath = null;
    try {
      const archiveTxtPath = writeBatchTxt(top, directUrls, weather, txtStats);
      log(`Wrote detailed batch archive: ${path.basename(archiveTxtPath)}`);
    } catch (e) {
      log(`Detailed batch archive write failed (non-fatal): ${e.message}`);
    }
    try {
      deliveryTxtPath = writeApplyLinksTxt();
      if (TELEGRAM_ON) {
        await tgDocument(deliveryTxtPath, `📄 apply-links(${DATE}).txt — ${top.length} jobs · number · title · apply link`);
        log(`Sent apply-links .txt: ${path.basename(deliveryTxtPath)}`);
      } else {
        log(`Wrote delivery export: ${path.basename(deliveryTxtPath)}`);
      }
    } catch (e) {
      log(`Apply-links .txt write/attach failed (non-fatal): ${e.message}`);
    }

    // v4.3: optionally email the batch .txt to a VA/recipient. Independent,
    // non-fatal try — a Telegram or email failure must never abort the run or
    // stop the seen-jobs persistence below.
    if (deliveryTxtPath && EMAIL_ON && CFG.email?.enabled && CFG.email?.autoSend && String(CFG.email?.to || '').trim()) {
      try {
        const to = String(CFG.email.to).trim();
        // v7.0: honor email.format (txt | csv | xlsx, set in System → Email).
        // txt keeps the pre-written delivery file; csv/xlsx build the same
        // minimal number·title·link sheet the Export menu produces, in-memory.
        const emailFmt = ['txt', 'csv', 'xlsx'].includes(CFG.email?.format) ? CFG.email.format : 'txt';
        let attachment = { filename: path.basename(deliveryTxtPath), path: deliveryTxtPath };
        if (emailFmt !== 'txt') {
          const rows = exportRows(lastBatch);
          attachment = emailFmt === 'csv'
            ? { filename: `apply-links(${DATE}).csv`, content: buildExportCsv(rows) }
            : { filename: `apply-links(${DATE}).xlsx`, content: buildExportXlsx(rows, DATE) };
        }
        await sendConfiguredEmail({
          env,
          to,
          from: CFG.email.from || env.SMTP_USER,
          subject: renderSubject(CFG.email.subject, DATE),
          text: `Attached: ${attachment.filename} — today's job batch (titles and direct apply links) from Automatic Munyun Machine.`,
          attachments: [attachment],
        });
        log(`Emailed job batch (${emailFmt}) to ${to}`);
      } catch (e) {
        log(`Batch email failed (non-fatal): ${SCRUB(e.message || e)}`);
      }
    }

    // Only persist seen-jobs *after* successful Telegram delivery —
    // so a failed run doesn't burn jobs we never actually surfaced.
    // v8.4: searchState no longer hides Viewed jobs. hiring.cafe may still
    // record description visits, but those visits cannot remove undelivered
    // candidates from tomorrow's scrape. Only `top` enters local memory.
    saveSeenStore(blockedSeen, top);
    log(`Persisted seen-jobs.json (${top.length} new, freshness=${SEEN_FRESHNESS_DAYS}d)`);

    // v1.0 E4: write per-batch callback table + send a final "Open batch
    // browser" CTA. The callback table maps idx → {url, company, ...} so
    // the bot can resolve inline-button taps for the next 7 days.
    // v2.1: Telegram-only — the table + HMAC callbacks exist for the inline
    // bot UI. Skip entirely when Telegram is off (the dashboard reads
    // last-batch.json directly).
    if (TELEGRAM_ON) try {
      const items = top.map((r, i) => ({
        idx: i + 1,
        viewjobUrl: r.href,
        title: r.title,
        company: r.company,
        location: r.location || '',
        directUrl: directUrls[i] || '',
        matchPct: r.matchPct,
        score: r.score,
        yoe: r.yoe,
        q: r.q
      }));
      writeCallbackTable(items);
      const reply_markup = {
        inline_keyboard: [[
          { text: '📋 Open batch browser', callback_data: makeNavCallback('b', 1, TG_TOKEN) },
          { text: '📊 Diagnose supply',     callback_data: makeNavCallback('diag', 0, TG_TOKEN) }
        ]]
      };
      await tg('🎯 <b>Tap to act on this batch.</b>\n<i>Each job in the browser has Save / Applied / Why / Skip-company buttons. Browser stays usable for 7 days.</i>', { reply_markup });
      log('Sent batch CTA + wrote callback table');
    } catch (e) {
      log(`CTA / callback table write failed (non-fatal): ${e.message}`);
    }

    writeScrapeStatus(true, { jobCount: top.length });
    log('=== done ===');
  } catch (e) {
    const msg = '❌ daily-batch failed: ' + SCRUB(e.message || e);
    writeScrapeStatus(false, { error: SCRUB(String(e.message || e)).slice(0, 300), kind: 'crash' });
    log(msg);
    try { await tg(msg); } catch (tgErr) { log(`(also: tg failed: ${SCRUB(tgErr.message || tgErr)})`); }
    // Release before the hard exit — finally doesn't run after process.exit.
    // (If the process dies harder than this, proper-lockfile's 30s stale
    // ceiling frees the lock anyway.)
    await releaseScrapeLock().catch(() => {});
    process.exit(1);
  } finally {
    // Covers the normal path AND the early returns (empty-CV nudge,
    // auth-fail). Releasing twice is harmless — the second call throws
    // "already released" and is swallowed.
    await releaseScrapeLock().catch(() => {});
  }
})();
