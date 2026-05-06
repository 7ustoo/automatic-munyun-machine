#!/usr/bin/env node
/**
 * Daily 100-job batch.
 *   1. Connects to your already-running Chrome via CDP (port 9222).
 *   2. Runs 7 hiring.cafe searches, extracts/filters cards, takes top 100.
 *   3. Resolves each viewjob URL to its direct ATS URL (parallel fetch).
 *   4. Pulls Miami weather from open-meteo.
 *   5. Sends formatted message(s) to Telegram.
 *   6. Writes data/today-batch-{date}.tsv on disk.
 *
 * Prereq: Chrome must be running with --remote-debugging-port=9222 (your
 * normal Chrome, Default profile, has been launched this way already).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATE = new Date().toISOString().slice(0, 10);

// ---------- env ----------
const ENV_PATH = path.join(ROOT, '.env');
if (!fs.existsSync(ENV_PATH)) {
  console.error('❌ Missing .env file at ' + ENV_PATH);
  console.error('   Run: node scripts/setup-wizard.mjs');
  process.exit(1);
}
const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = env.TELEGRAM_CHAT_ID;
const CDP_PORT = env.CHROME_DEBUG_PORT || '9222';

// ---------- config (config.json) ----------
function loadConfig() {
  const userPath = path.join(ROOT, 'config.json');
  const examplePath = path.join(ROOT, 'config.example.json');
  const src = fs.existsSync(userPath) ? userPath : examplePath;
  return JSON.parse(fs.readFileSync(src, 'utf8'));
}
const CFG = loadConfig();

// ---------- parsed CV (data/cv-parsed.json, written by resume-parser.mjs) ----------
function loadParsedCV() {
  const p = path.join(ROOT, 'data', 'cv-parsed.json');
  if (!fs.existsSync(p)) return { titles: [], certs: [], skills: [], compliance: [] };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const CV = loadParsedCV();

// ---------- helpers ----------
function log(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  fs.appendFileSync(path.join(ROOT, 'data', `daily-batch-${DATE}.log`), msg + '\n');
}

async function tg(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const json = await res.json();
  if (!json.ok) throw new Error('Telegram error: ' + JSON.stringify(json));
  return json.result.message_id;
}

async function tgDocument(filePath, caption) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('chat_id', TG_CHAT);
  if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
  fd.append('document', new Blob([buf]), path.basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  const json = await res.json();
  if (!json.ok) throw new Error('Telegram sendDocument error: ' + JSON.stringify(json));
  return json.result.message_id;
}

async function tgChunked(message) {
  const MAX = 3900;
  const blocks = message.split('\n\n');
  const chunks = [];
  let cur = '';
  for (const block of blocks) {
    if ((cur + '\n\n' + block).length > MAX && cur) { chunks.push(cur); cur = block; }
    else cur = cur ? cur + '\n\n' + block : block;
  }
  if (cur) chunks.push(cur);
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
  const seen = new Set(); const out = [];
  document.querySelectorAll('a[href^="/viewjob/"]').forEach(a => {
    if (seen.has(a.href)) return; seen.add(a.href);
    const card = a.closest('.bg-white.rounded-xl') || a.parentElement.parentElement.parentElement;
    const cardText = card.innerText || '';
    const lines = cardText.split('\\n').map(l => l.trim()).filter(Boolean);
    const ageIdx = lines.findIndex(l => /^\\d+[wdhmoy]+$/.test(l));
    let title = ageIdx >= 0 ? (lines[ageIdx + 1] || '') : (lines[0] || '');
    if (!title || ageIdx < 0) {
      title = lines.find(l => l.length > 5 && !/Remote|Full Time|Contract|United States|YOE|\\$|Save|Apply/.test(l)) || '';
    }
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
  return chromium.launchPersistentContext(profileDir, {
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

// Returns true if the persistent profile is logged into hiring.cafe.
// Strategy: navigate to /saved (auth-required). If the page loads without
// redirecting back to home or showing a sign-in CTA, we're authed.
async function checkLogin(page) {
  await page.goto('https://hiring.cafe/saved', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  const finalUrl = page.url();
  // Sign of LOGGED OUT: redirected away from /saved, OR a sign-in button is visible
  if (!finalUrl.includes('/saved')) return false;
  const signInVisible = await page.locator('button:has-text("Sign in"), button:has-text("Log in"), a:has-text("Sign in"):not(:has-text("Sign in with"))').first().isVisible().catch(() => false);
  if (signInVisible) return false;
  // Sign of LOGGED IN: any localStorage key or cookie suggesting auth, OR no sign-in CTA at all
  return true;
}

async function scrape() {
  log(`Launching headless Chromium with persistent profile…`);
  const ctx = await launchBrowser();
  const page = ctx.pages()[0] || await ctx.newPage();

  // Auth gate — if logged out, abort cleanly so we don't poison the seen-jobs store.
  log('Verifying hiring.cafe login state…');
  const loggedIn = await checkLogin(page);
  if (!loggedIn) {
    await ctx.close();
    const e = new Error('Hiring.cafe session expired or never authenticated. Run scripts\\login-once.cmd to re-auth.');
    e.unauth = true;
    throw e;
  }
  log('✓ logged in');
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

  for (const [key, query] of QUERIES) {
    const searchState = {
      searchQuery: query,
      workplaceTypes: ['Remote'],
      hideJobTypes: ['Saved', 'Applied', 'Viewed']
    };
    if (formEaseFilter) searchState.applicationFormEase = formEaseFilter;
    const url = 'https://hiring.cafe/?searchState=' + encodeURIComponent(JSON.stringify(searchState));
    log(`Scraping "${query}"…`);
    let rows = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Wait for at least one card anchor or 8s max — whichever comes first
        await page.waitForSelector('a[href^="/viewjob/"]', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2000); // settle
        rows = await page.evaluate(EXTRACT_FN);
        break;
      } catch (e) {
        log(`  attempt ${attempt} failed: ${e.message.split('\n')[0]}`);
        if (attempt === 3) throw e;
        await page.waitForTimeout(2000);
      }
    }
    results[key] = rows;
    log(`  → ${rows.length} cards`);
  }
  await ctx.close();

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

// Per-query rolling 7-day card-count history. Read by /diagnose.
const QUERY_STATS_PATH = path.join(ROOT, 'data', 'query-stats.json');
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
  fs.writeFileSync(QUERY_STATS_PATH, JSON.stringify(store, null, 2));
}

// ---------- filter ----------
function escRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Build filter regexes from config.json
const DROP_TITLE_PATTERNS = (CFG.filters?.dropTitlePatterns || []).map(p => p.replace(/\s+/g, '\\s+'));
const DROP_TITLE = DROP_TITLE_PATTERNS.length
  ? new RegExp('\\b(' + DROP_TITLE_PATTERNS.join('|') + ')\\b', 'i')
  : /(?!.*)/; // matches nothing if no patterns
const SKIP_COMPANIES = CFG.filters?.skipCompanies || [];
const SKIP_CO = SKIP_COMPANIES.length
  ? new RegExp('^(' + SKIP_COMPANIES.map(escRx).join('|') + ')', 'i')
  : /(?!.*)/;

// ---------- CV keyword scoring (Option B: calibrated percentage) ----------
// Pulled from data/cv-parsed.json (written by resume-parser.mjs at setup-time).
// To regenerate: node scripts/resume-parser.mjs <path-to-resume>
const CV_TITLES     = CV.titles     || [];
const CV_CERTS      = CV.certs      || [];
const CV_SKILLS     = CV.skills     || [];
const CV_COMPLIANCE = CV.compliance || [];

const SCORING = CFG.scoring || {};
const W_TITLE       = SCORING.titleWeight       ?? 10;
const W_CERT        = SCORING.certWeight        ?? 5;
const W_SKILL       = SCORING.skillWeight       ?? 3;
const W_COMPLIANCE  = SCORING.complianceWeight  ?? 2;
const SALARY_BONUS  = SCORING.salaryBonus       ?? 5;
const SALARY_PENALTY= SCORING.salaryPenalty     ?? -10;
const SALARY_FLOOR_K= Math.round((CFG.user?.salaryFloorUsd ?? 90000) / 1000);

function scoreJob(job) {
  const text = ((job.title || '') + '\n' + (job.cardText || ''));
  let score = 0;
  const matched = [];
  const seen = new Set();
  const tryMatch = (term, weight) => {
    if (seen.has(term.toLowerCase())) return;
    // Word-boundary match, case-insensitive
    if (new RegExp('\\b' + escRx(term) + '\\b', 'i').test(text)) {
      score += weight;
      matched.push(term);
      seen.add(term.toLowerCase());
    }
  };
  for (const t of CV_TITLES)     tryMatch(t, W_TITLE);
  for (const c of CV_CERTS)      tryMatch(c, W_CERT);
  for (const s of CV_SKILLS)     tryMatch(s, W_SKILL);
  for (const c of CV_COMPLIANCE) tryMatch(c, W_COMPLIANCE);
  // Salary check — if visible and any number ≥ floor (in $K), bonus; else penalty
  const salaryNums = [...text.matchAll(/\$(\d{2,3})\s*[kK](?!\w)/g)].map(m => parseInt(m[1]));
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
    const apps = fs.readFileSync(path.join(ROOT, 'data', 'applications.md'), 'utf8');
    return new Set([...apps.matchAll(/hiring\.cafe\/viewjob\/([a-z0-9]+)/g)].map(m => 'https://hiring.cafe/viewjob/' + m[1]));
  } catch { return new Set(); }
}

// Persistent set of every viewjob URL we've ever surfaced via Telegram.
// Combined with applications.md, this is what guarantees fresh jobs each run.
const SEEN_PATH = path.join(ROOT, 'data', 'seen-jobs.json');
function loadSeenIds() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8')).ids || []); }
  catch { return new Set(); }
}
function saveSeenIds(set) {
  const obj = { lastUpdated: new Date().toISOString(), ids: [...set].sort() };
  fs.writeFileSync(SEEN_PATH, JSON.stringify(obj, null, 2));
}

// Track when the bot last confirmed a healthy hiring.cafe session.
// Used by the periodic re-auth nag and by the /auth bot command.
const AUTH_PATH = path.join(ROOT, 'data', 'auth-state.json');
function recordAuthOk() {
  fs.writeFileSync(AUTH_PATH, JSON.stringify({
    lastAuthOK: new Date().toISOString(),
    lastAuthFail: null
  }, null, 2));
}
function recordAuthFail() {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); } catch {}
  fs.writeFileSync(AUTH_PATH, JSON.stringify({
    lastAuthOK: prev.lastAuthOK || null,
    lastAuthFail: new Date().toISOString()
  }, null, 2));
}

async function resolveOne(viewjobUrl) {
  try {
    const r = await fetch(viewjobUrl, { signal: AbortSignal.timeout(15000) });
    const html = await r.text();
    const m = html.match(/"apply_url":"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}
async function resolveAll(rows) {
  const PAR = 20;
  const out = new Array(rows.length); let i = 0;
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= rows.length) break;
      out[idx] = await resolveOne(rows[idx].href);
    }
  }));
  return out;
}

function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
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
    lines.push(`<b>${i + 1}.</b> ${title}${yoe} · <b>${pct}</b>\n<i>${co}</i>${matchedLine}\n<a href="${url}">${url}</a>`);
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
  const dir = path.join(ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `jobs(${DATE}).txt`);
  fs.writeFileSync(file, buildBatchTxt(top, directUrls, weather, stats));
  return file;
}

function writeBatchTsv(top, directUrls, funnel) {
  const dir = path.join(ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const tsv = top.map((r, i) => {
    const id = r.href.split('/').pop();
    const url = directUrls[i] || '';
    const title = (r.title || '').replace(/\t/g, ' ');
    const co = (r.company || '').replace(/\t/g, ' ');
    const yoe = r.yoe ?? '';
    return `${i + 1}\t${id}\t${title}\t${co}\t${yoe}\t${r.q}\t${url}`;
  }).join('\n');
  fs.writeFileSync(path.join(dir, `today-batch-${DATE}.tsv`), tsv + '\n');
  fs.writeFileSync(path.join(dir, `today-batch-direct-urls-${DATE}.txt`), directUrls.filter(Boolean).join('\n') + '\n');

  // Rich per-job match details, used by the bot's /why N command.
  // Funnel data is read by /diagnose to show the supply pipeline.
  const lastBatch = {
    date: DATE,
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
  fs.writeFileSync(path.join(dir, 'last-batch.json'), JSON.stringify(lastBatch, null, 2));
}

(async () => {
  try {
    log(`=== daily-batch ${DATE} ===`);
    let byQuery;
    try {
      byQuery = await scrape();
    } catch (e) {
      if (e.unauth) {
        recordAuthFail();
        log('AUTH FAIL: ' + e.message);
        await tg('⚠️ <b>Hiring.cafe session expired.</b>\nRun <code>scripts\\login-once.cmd</code> to re-auth — the bot will resume normally on the next /daily.');
        return; // exit clean, don't propagate as crash
      }
      throw e;
    }
    const { all, kept, droppedClearance } = filterAndDedupe(byQuery);
    log(`raw=${all.length} keptAfterFilter=${kept.length} (droppedClearance=${droppedClearance})`);
    const applied = loadAppliedHrefs();
    const seen = loadSeenIds();
    // Combined block-list: applications.md URLs + every job we've previously surfaced.
    const blocked = new Set([...applied, ...seen]);
    const fresh = kept.filter(r => !blocked.has(r.href));
    const skippedApplied = kept.length - fresh.length;
    log(`afterDedup=${fresh.length} (skipped ${skippedApplied}: ${applied.size} applied + ${seen.size} previously seen)`);

    // Score every fresh job against your CV, sort by match quality, take top 100.
    for (const r of fresh) {
      const s = scoreJob(r);
      r.score = s.score;
      r.matched = s.matched;
      r.matchPct = scoreToPercent(s.score);
    }
    fresh.sort((a, b) => b.score - a.score);
    const top = fresh.slice(0, 100);
    log(`scored: top=${top[0]?.matchPct ?? 0}%  median=${top[Math.floor(top.length/2)]?.matchPct ?? 0}%  bottom=${top[top.length-1]?.matchPct ?? 0}%`);
    log(`Resolving ${top.length} direct ATS URLs in parallel…`);
    const directUrls = await resolveAll(top);
    log(`resolved=${directUrls.filter(Boolean).length}/${top.length}`);
    const funnel = {
      raw: all.length,
      keptAfterFilter: kept.length,
      droppedClearance,
      afterDedup: fresh.length,
      scored: fresh.length,
      sent: top.length,
      topPct: top[0]?.matchPct ?? 0,
      medianPct: top[Math.floor(top.length / 2)]?.matchPct ?? 0,
      bottomPct: top[top.length - 1]?.matchPct ?? 0
    };
    writeBatchTsv(top, directUrls, funnel);
    const weather = await getWeather();
    const message = buildMessage(weather, top, directUrls, {
      raw: all.length,
      kept: kept.length,
      droppedClearance,
      skippedApplied: applied.size === 0 ? 0 : kept.filter(r => applied.has(r.href)).length,
      skippedSeen: seen.size === 0 ? 0 : kept.filter(r => !applied.has(r.href) && seen.has(r.href)).length
    });
    const chunks = await tgChunked(message);
    log(`Telegram sent in ${chunks} chunk(s)`);

    // Build + attach the downloadable .txt as the final message of the batch.
    // Failure here is non-fatal — messages already went through.
    const txtStats = {
      raw: all.length,
      droppedClearance,
      skippedApplied: applied.size === 0 ? 0 : kept.filter(r => applied.has(r.href)).length,
      skippedSeen: seen.size === 0 ? 0 : kept.filter(r => !applied.has(r.href) && seen.has(r.href)).length
    };
    try {
      const txtPath = writeBatchTxt(top, directUrls, weather, txtStats);
      await tgDocument(txtPath, `📄 jobs(${DATE}).txt — full batch · search-friendly · pull anytime with /export`);
      log(`Sent batch .txt: ${path.basename(txtPath)}`);
    } catch (e) {
      log(`Batch .txt attach failed (non-fatal): ${e.message}`);
    }

    // Only persist seen IDs *after* successful Telegram delivery —
    // so a failed run doesn't burn jobs we never actually surfaced.
    for (const r of top) seen.add(r.href);
    saveSeenIds(seen);
    log(`Persisted ${seen.size} seen IDs to data/seen-jobs.json`);

    log('=== done ===');
  } catch (e) {
    const msg = '❌ daily-batch failed: ' + (e.message || e);
    log(msg);
    try { await tg(msg); } catch {}
    process.exit(1);
  }
})();
