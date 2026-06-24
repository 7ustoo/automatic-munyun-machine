#!/usr/bin/env node
/**
 * Daily 100-job batch.
 *   1. Launches a headless Chromium with the persistent profile (Cloudflare
 *      cookies live there); warmup probe verifies hiring.cafe is browsable.
 *   2. Runs every configured hiring.cafe search (default 16), paginates to
 *      maxPagesPerQuery (default 50), with target-driven cross-query early
 *      stop once running fresh estimate ≥ targetJobsPerBatch × 1.5.
 *   3. Filters (clearance, skip-companies, drop-titles, max YOE), dedups,
 *      subtracts applied + previously-seen, scores against the parsed CV.
 *   4. Slices top targetJobsPerBatch (default 100) above matchFloorPercent.
 *   5. Resolves each viewjob URL to its direct ATS URL via 5-page browser
 *      pool (Cloudflare blocks plain Node fetch; browser nav works).
 *   6. Pulls weather from open-meteo (lat/lon/city are user-configurable).
 *   7. Sends chunked HTML messages + jobs(<DATE>).txt attachment + inline
 *      callback CTA to Telegram. Persists seen-jobs only after delivery.
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
import { atomicWriteJson } from './io-helpers.mjs';
import { telegramConfigured } from './telegram-config.mjs';
import { resolveBrowser } from './browser-launcher.mjs';

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

// Token scrubber for everything that lands in logs or user-visible error
// messages. Telegram URL is `…/bot<TOKEN>/sendMessage`; if a fetch failure
// surfaces the URL via `cause` chain, the token can leak into log files
// users routinely paste publicly when asking for help. Mirror the bot's
// pattern so the discipline is uniform across all entrypoints.
const SCRUB = (s) => {
  if (s == null) return '';
  let str = String(s);
  if (TG_TOKEN) str = str.split(TG_TOKEN).join('<TOKEN>');
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

// ---------- parsed CV (per-profile, written by resume-parser.mjs) ----------
function loadParsedCV() {
  const p = PP.cvParsed;
  if (!fs.existsSync(p)) return { titles: [], certs: [], skills: [], compliance: [] };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const CV = loadParsedCV();

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
const QUERIES = (CFG.queries && CFG.queries.length)
  ? CFG.queries.map(q => [q.key, q.term])
  : [['IAM', 'IAM Engineer'], ['CloudSec', 'Cloud Security Engineer'], ['Cyber', 'Cybersecurity Engineer']];

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
  return chromium.launchPersistentContext(profileDir, {
    ...browser.launchOptions,
    headless: false,
    timeout: 30000,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-position=10000,10000',
      '--window-size=1280,800'
    ],
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
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
  // seen-jobs store. (Renamed from "auth" gate; v1.0.x scraping is unauth.)
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
  const results = {};
  // Map config's applicationFormEase → hiring.cafe URL filter
  const formEase = (CFG.filters?.applicationFormEase || 'all').toLowerCase();
  const formEaseFilter = formEase === 'simple' ? ['Simple']
                        : formEase === 'long'  ? ['TimeConsuming']
                        : null; // 'all' or anything else → no filter

  // v1.0.x: pagination. Hiring.cafe shows ~40 cards per page. We click the
  // "Next" link (a[aria-label*="next"]) up to MAX_PAGES_PER_QUERY-1 times to
  // pull additional pages. Stops early if Next disappears/disables OR new
  // page returns no fresh cards (already seen this query).
  const MAX_PAGES_PER_QUERY = SCORING.maxPagesPerQuery ?? 50;

  // v1.0.x: target-driven cross-query early stop. After each query's
  // pagination, we compute the running fresh-after-dedup count. If it
  // exceeds the target with some headroom for floor losses, we stop
  // scraping additional queries — saves time on heavy-supply days.
  const TARGET_JOBS = SCORING.targetJobsPerBatch ?? 100;
  const _appliedSet  = loadAppliedHrefs();
  const _blockedSet  = loadBlockedSeen();
  const _crossQuerySeen = new Set(); // dedup hrefs across query boundaries
  let runningFreshEstimate = 0;

  for (const [key, query] of QUERIES) {
    const searchState = {
      searchQuery: query,
      workplaceTypes: ['Remote']
      // v1.0.x: dropped hideJobTypes — that field only takes effect for
      // logged-in users, and we now scrape unauth. Local seen-jobs.json +
      // applications.md cover the dedup we actually need.
    };
    if (formEaseFilter) searchState.applicationFormEase = formEaseFilter;
    const url = 'https://hiring.cafe/?searchState=' + encodeURIComponent(JSON.stringify(searchState));
    log(`Scraping "${query}"…`);
    const seenInQuery = new Set();
    const allRows = [];

    // Page 1 — initial navigation, retry up to 3 times on failure.
    let firstPageRows = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('a[href^="/job/"]', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2000);
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

    // Pages 2..N — click Next until cap, button disappears, or no new cards.
    for (let pageNum = 2; pageNum <= MAX_PAGES_PER_QUERY; pageNum++) {
      const nextBtn = page.locator('a[aria-label*="next" i], button[aria-label*="next" i]').first();
      const visible = await nextBtn.isVisible().catch(() => false);
      const enabled = visible && await nextBtn.isEnabled().catch(() => false);
      if (!visible || !enabled) {
        log(`  no more pages after ${pageNum - 1} (Next not available)`);
        break;
      }
      try {
        await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
        await nextBtn.click({ timeout: 5000 });
        await page.waitForTimeout(2500);
        const pageRows = await page.evaluate(EXTRACT_FN);
        let newCards = 0;
        for (const r of pageRows) {
          if (!seenInQuery.has(r.href)) { seenInQuery.add(r.href); allRows.push(r); newCards++; }
        }
        log(`  page ${pageNum} → ${pageRows.length} cards (${newCards} new, running total: ${allRows.length})`);
        if (newCards === 0) {
          log(`  stopping pagination — page ${pageNum} returned no new cards`);
          break;
        }
      } catch (e) {
        log(`  page ${pageNum} failed: ${e.message.split('\n')[0]} — stopping pagination`);
        break;
      }
    }

    results[key] = allRows;

    // Cross-query running-fresh estimate. We don't run the full scoring
    // mid-scrape (too expensive); we just count how many of THIS query's
    // rows aren't already blocked + haven't been seen earlier this run.
    for (const r of allRows) {
      if (_crossQuerySeen.has(r.href)) continue;
      _crossQuerySeen.add(r.href);
      if (!_appliedSet.has(r.href) && !_blockedSet.has(r.href)) runningFreshEstimate++;
    }
    // 50% headroom for filter+floor losses — stop scraping once we have
    // ~1.5x the target candidate cards. Conservative; usually means we'll
    // end up delivering close to TARGET_JOBS after filters trim.
    if (runningFreshEstimate >= TARGET_JOBS * 1.5) {
      log(`  ✓ target hit early — running fresh estimate ${runningFreshEstimate} ≥ ${Math.round(TARGET_JOBS * 1.5)} (target ${TARGET_JOBS} × 1.5 headroom). Skipping remaining queries.`);
      break;
    }
  }

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
  return results;
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
const W_TITLE       = SCORING.titleWeight       ?? 10;
const W_CERT        = SCORING.certWeight        ?? 5;
const W_SKILL       = SCORING.skillWeight       ?? 3;
const W_COMPLIANCE  = SCORING.complianceWeight  ?? 2;
const SALARY_BONUS  = SCORING.salaryBonus       ?? 5;
const SALARY_PENALTY= SCORING.salaryPenalty     ?? -10;
const SALARY_FLOOR_K= Math.round((CFG.user?.salaryFloorUsd ?? 90000) / 1000);
const MATCH_FLOOR_PCT = SCORING.matchFloorPercent ?? 25;
const TF_CAP        = 3; // count term occurrences up to this many times

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
export function parseSalaryK(text) {
  const out = [];
  // Pattern A: $XXXk style. Captures number + optional K. Supports en/em dashes between two patterns.
  const reA = /(?:USD\s*|\$|€|£)?\s*(\d{2,4}(?:[.,]\d{3})?)\s*[kK](?!\w)/g;
  let m;
  while ((m = reA.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(n) && n >= 30 && n <= 999) out.push(Math.round(n));
  }
  // Pattern B: $120,000 style (no K suffix). Convert to K.
  const reB = /\$\s*(\d{2,3}),(\d{3})(?!\d)/g;
  while ((m = reB.exec(text)) !== null) {
    const n = parseFloat(m[1] + m[2]) / 1000;
    if (!isNaN(n) && n >= 30 && n <= 999) out.push(Math.round(n));
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

export function scoreJob(job) {
  const text = ((job.title || '') + '\n' + (job.cardText || ''));
  let score = 0;
  const matched = [];
  const seen = new Set();
  const tryMatch = (term, baseWeight) => {
    if (seen.has(term.toLowerCase())) return;
    const weight = baseWeight * clusterMultiplier(term);
    // Exact phrase / word-boundary match. Term-frequency cap: count up to TF_CAP.
    const re = termRegex(term, 'gi');
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      const tf = Math.min(matches.length, TF_CAP);
      score += weight * tf;
      matched.push(tf > 1 ? `${term} ×${tf}` : term);
      seen.add(term.toLowerCase());
      return;
    }
    // Multi-token phrase that didn't match exactly — try tokens-anywhere fallback
    if (term.includes(' ') && tokensAllPresent(text, term)) {
      score += weight * 0.5;
      matched.push(`${term} (partial)`);
      seen.add(term.toLowerCase());
    }
  };
  for (const t of CV_TITLES)     tryMatch(t, W_TITLE);
  for (const c of CV_CERTS)      tryMatch(c, W_CERT);
  for (const s of CV_SKILLS)     tryMatch(s, W_SKILL);
  for (const c of CV_COMPLIANCE) tryMatch(c, W_COMPLIANCE);
  // Salary check — if visible and any number ≥ floor (in $K), bonus; else penalty
  const salaryNums = parseSalaryK(text);
  if (salaryNums.length) {
    if (Math.max(...salaryNums) >= SALARY_FLOOR_K) score += SALARY_BONUS;
    else score += SALARY_PENALTY;
  }
  return { score, matched };
}

// Calibrated raw-score → percentage. score 30+ → 90-100%, etc.
function scoreToPercent(s) {
  if (s >= 30) return Math.min(100, Math.round(90 + (s - 30) * 0.5));
  if (s >= 20) return Math.round(75 + (s - 20) * 1.5);
  if (s >= 10) return Math.round(50 + (s - 10) * 2.5);
  if (s >= 5)  return Math.round(30 + (s - 5) * 4);
  return Math.max(0, Math.round(s * 7));
}

// Anything mentioning a US-government clearance gets dropped. Hits both the
// title and the card body text so we catch jobs like "Security Engineer (TS/SCI)"
// AND ones where the title is generic but the body says "active Secret required".
const CLEARANCE_RX = /\b(top[\s-]*secret|ts\/sci|\bsecret\s+clearance\b|public[\s-]*trust|polygraph|sf-?86|dod[\s-]*clearance|government[\s-]*clearance|federal[\s-]*clearance|active[\s-]+(security|secret|government)[\s-]+clearance|clearance(?:\s+is)?\s+required|cleared[\s-]+(?:personnel|professional)|able\s+to\s+obtain[^.]{0,40}clearance|must\s+be\s+a\s+u\.?s\.?\s+citizen|us\s+citizenship\s+required)\b/i;

function filterAndDedupe(byQuery) {
  const all = []; const seen = new Set();
  for (const [q, rows] of Object.entries(byQuery)) {
    for (const r of rows) {
      if (seen.has(r.href)) continue;
      seen.add(r.href); r.q = q; all.push(r);
    }
  }
  const filterClearance = CFG.filters?.filterClearance !== false; // default true
  const maxYoe = CFG.user?.maxYoeAcceptable ?? 5;
  let droppedClearance = 0;
  const kept = all.filter(r => {
    if (r.yoe !== null && r.yoe > maxYoe) return false;
    if (r.title && DROP_TITLE.test(r.title)) return false;
    if (r.company && SKIP_CO.test(r.company)) return false;
    if (filterClearance) {
      const body = (r.title || '') + '\n' + (r.cardText || '');
      if (CLEARANCE_RX.test(body)) { droppedClearance++; return false; }
    }
    return true;
  });
  return { all, kept, droppedClearance };
}

function loadAppliedHrefs() {
  try {
    const apps = fs.readFileSync(PP.applications, 'utf8');
    // Case-insensitive match + lowercase normalization. hiring.cafe IDs are
    // lowercase today, but treating them as a case-sensitive contract was
    // the kind of brittleness that bites silently if the upstream shifts.
    // Accept both legacy `/viewjob/` and the current `/job/` paths so an
    // applications.md that pre-dates the v1.3 path migration still dedupes.
    return new Set([...apps.matchAll(/hiring\.cafe\/(?:viewjob|job)\/([a-z0-9]+)/gi)]
      .map(m => 'https://hiring.cafe/job/' + m[1].toLowerCase()));
  } catch { return new Set(); }
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
  return new Set(Object.keys(fresh));
}

// Persist the seen store. Called only after Telegram delivery succeeds for
// the batch — see "Persist seen IDs" block below. v1.0 E3 race fix: was
// previously written before sendDocument retries, so a Telegram outage
// mid-attachment could mark jobs seen that the user never received.
function saveSeenStore(blockedSet, top) {
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
      lastSeenAt: now
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
    const m = html.match(/"apply_url":"([^"]+)"/);
    if (!m) return null;
    const u = m[1];
    // Sanity check — `apply_url` is attacker-controllable (whatever the job
    // poster typed into hiring.cafe). Reject anything that isn't a plain
    // http(s) URL with no embedded HTML/quote characters before we let it
    // through to a Telegram <a href="…"> interpolation. Defense layered with
    // escHtmlAttr() at the message-build site (see buildMessage / F-H1).
    if (!/^https?:\/\/[^\s<>"']+$/i.test(u)) return null;
    return u;
  } catch { return null; }
}

async function resolveAll(rows) {
  if (!rows.length) return [];
  log(`Launching browser for direct-URL resolution (${rows.length} jobs)…`);
  const ctx = await launchBrowser();
  try {
    const PAR = 5; // 5 concurrent pages — balances speed vs bot-detection risk
    const pages = [];
    for (let i = 0; i < PAR; i++) {
      pages.push(i === 0 ? (ctx.pages()[0] || await ctx.newPage()) : await ctx.newPage());
    }
    const out = new Array(rows.length);
    let i = 0;
    let resolved = 0;
    await Promise.all(pages.map(async (p) => {
      while (true) {
        const idx = i++;
        if (idx >= rows.length) break;
        out[idx] = await resolveOnePage(p, rows[idx].href);
        if (out[idx]) resolved++;
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
  try { stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'query-stats.json'), 'utf8')); } catch {}
  const dryQueries = [];
  for (const [term, slot] of Object.entries(stats?.queries || {})) {
    const recent = (slot.history || []).slice(-3);
    if (recent.length >= 3 && recent.every(h => h.cards === 0)) dryQueries.push(term);
  }
  if (dryQueries.length) {
    warnings.push(`⚠️ <b>Dry queries (3+ days at 0 cards):</b>\n${dryQueries.map(q => '  · ' + escHtml(q)).join('\n')}\nLikely typos or terms hiring.cafe doesn't index. Edit via <code>/jobs remove</code> + <code>/jobs add</code>.`);
  }
  return warnings.length ? warnings.join('\n\n') : null;
}
function buildMessage(weather, top, directUrls, stats) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const filterBits = [];
  if (stats.droppedClearance) filterBits.push(`${stats.droppedClearance} clearance`);
  if (stats.skippedApplied)   filterBits.push(`${stats.skippedApplied} applied`);
  if (stats.skippedSeen)      filterBits.push(`${stats.skippedSeen} previously seen`);
  const tail = filterBits.length ? ` · filtered: ${filterBits.join(', ')}` : '';
  const userName = CFG.user?.name || 'there';
  const headerTpl = (CFG.telegram?.messageHeader || '☀️ Good morning {NAME} — {DATE}')
    .replace('{NAME}', userName)
    .replace('{DATE}', today);
  const authIndicator = CFG.telegram?.showAuthIndicator !== false ? '\n✓ logged in · sorted by CV match — best fits first.' : '\nSorted by CV match — best fits first.';
  const head = `<b>${headerTpl}</b>\n\n${weather}\n\n📊 <b>${top.length} fresh jobs</b> · ${stats.raw} raw${tail}${authIndicator}`;
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
  if (stats.skippedApplied)   filterBits.push(`${stats.skippedApplied} applied`);
  if (stats.skippedSeen)      filterBits.push(`${stats.skippedSeen} previously seen`);
  const tail = filterBits.length ? ` · filtered: ${filterBits.join(', ')}` : '';
  lines.push(`${top.length} jobs · ${stats.raw} raw${tail} · sorted by CV match`);
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
  fs.writeFileSync(file, buildBatchTxt(top, directUrls, weather, stats));
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
  // TSV + direct-URLs files are write-once-per-day artifacts; not contended,
  // plain writes are fine. last-batch.json IS contended (bot's /forget last
  // can mutate while a scrape is mid-run), so use atomicWriteJson for it.
  fs.writeFileSync(path.join(PP.dir, `today-batch-${DATE}.tsv`), tsv + '\n');
  fs.writeFileSync(path.join(PP.dir, `today-batch-direct-urls-${DATE}.txt`), directUrls.filter(Boolean).join('\n') + '\n');

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
      yoe: r.yoe,
      q: r.q,
      score: r.score ?? 0,
      matchPct: r.matchPct ?? 0,
      matched: r.matched || [],
      directUrl: directUrls[i] || '',
      viewjobUrl: r.href
    }))
  };
  atomicWriteJson(PP.lastBatch, lastBatch);
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
      try { await tg(msg); } catch {}
      return;
    }

    let byQuery;
    try {
      byQuery = await scrape();
    } catch (e) {
      if (e.unauth) {
        recordAuthFail();
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
    const { all, kept, droppedClearance } = filterAndDedupe(byQuery);
    log(`raw=${all.length} keptAfterFilter=${kept.length} (droppedClearance=${droppedClearance})`);
    const applied = loadAppliedHrefs();
    const blockedSeen = loadBlockedSeen(); // decayed: jobs > freshness window are no longer blocked
    const blockAll = new Set([...applied, ...blockedSeen]);
    const fresh = kept.filter(r => !blockAll.has(r.href));
    const skippedApplied = kept.filter(r => applied.has(r.href)).length;
    const skippedSeen    = kept.filter(r => !applied.has(r.href) && blockedSeen.has(r.href)).length;
    log(`afterDedup=${fresh.length} (skipped ${kept.length - fresh.length}: ${skippedApplied} applied + ${skippedSeen} previously seen, freshness=${SEEN_FRESHNESS_DAYS}d)`);

    // Score every fresh job against your CV, sort by match quality.
    for (const r of fresh) {
      const s = scoreJob(r);
      r.score = s.score;
      r.matched = s.matched;
      r.matchPct = scoreToPercent(s.score);
    }
    fresh.sort((a, b) => b.score - a.score);
    // v1.0 E3: match floor — drop jobs below threshold BEFORE slicing top 100,
    // so the bot never ships 0% filler to fill out the batch.
    const aboveFloor = fresh.filter(r => r.matchPct >= MATCH_FLOOR_PCT);
    const droppedBelowFloor = fresh.length - aboveFloor.length;
    const top = aboveFloor.slice(0, 100);
    log(`scored: top=${top[0]?.matchPct ?? 0}%  median=${top[Math.floor(top.length/2)]?.matchPct ?? 0}%  bottom=${top[top.length-1]?.matchPct ?? 0}%  (floor=${MATCH_FLOOR_PCT}%, dropped ${droppedBelowFloor} below)`);
    log(`Resolving ${top.length} direct ATS URLs in parallel…`);
    const directUrls = await resolveAll(top);
    log(`resolved=${directUrls.filter(Boolean).length}/${top.length}`);
    const funnel = {
      raw: all.length,
      keptAfterFilter: kept.length,
      droppedClearance,
      afterDedup: fresh.length,
      scored: fresh.length,
      droppedBelowFloor,
      matchFloorPercent: MATCH_FLOOR_PCT,
      sent: top.length,
      topPct: top[0]?.matchPct ?? 0,
      medianPct: top[Math.floor(top.length / 2)]?.matchPct ?? 0,
      bottomPct: top[top.length - 1]?.matchPct ?? 0
    };
    writeBatchTsv(top, directUrls, funnel);
    const weather = await getWeather();
    const banner = buildSupplyBanner({ funnel, byQuery });
    let message = buildMessage(weather, top, directUrls, {
      raw: all.length,
      kept: kept.length,
      droppedClearance,
      skippedApplied,
      skippedSeen
    });
    if (banner) message = banner + '\n\n' + message;
    if (TELEGRAM_ON) {
      const chunks = await tgChunked(message);
      log(`Telegram sent in ${chunks} chunk(s)`);
    } else {
      log('Telegram off — batch ready in the dashboard (last-batch.json) + jobs txt on disk.');
    }

    // Always write the downloadable .txt (it's the disk record + /export
    // source); only attach it to Telegram when enabled.
    const txtStats = { raw: all.length, droppedClearance, skippedApplied, skippedSeen };
    try {
      const txtPath = writeBatchTxt(top, directUrls, weather, txtStats);
      if (TELEGRAM_ON) {
        await tgDocument(txtPath, `📄 jobs(${DATE}).txt — full batch · search-friendly · pull anytime with /export`);
        log(`Sent batch .txt: ${path.basename(txtPath)}`);
      } else {
        log(`Wrote batch .txt: ${path.basename(txtPath)}`);
      }
    } catch (e) {
      log(`Batch .txt write/attach failed (non-fatal): ${e.message}`);
    }

    // Only persist seen-jobs *after* successful Telegram delivery —
    // so a failed run doesn't burn jobs we never actually surfaced.
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

    log('=== done ===');
  } catch (e) {
    const msg = '❌ daily-batch failed: ' + SCRUB(e.message || e);
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
