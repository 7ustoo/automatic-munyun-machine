#!/usr/bin/env node
/**
 * Long-running Telegram bot for career-ops.
 *
 * Polls Telegram getUpdates every 3 sec for new messages from your chat.
 * Dispatches commands:
 *   /daily, gm, morning   → run daily batch (weather + 100 jobs)
 *   /jobs                  → 100 jobs only, no weather
 *   /export                → download today's batch as a .txt file
 *   /weather               → Miami weather only
 *   /version               → show bot version + latest GitHub version
 *   /update                → pull latest code from GitHub + restart
 *   /test, /ping           → reply "alive"
 *   /help, /start          → list commands
 *
 * Started at logon by Task Scheduler entry `career-ops-bot`.
 * Logs to data/telegram-bot.log.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  currentVersion,
  checkForUpdate,
  dismissVersion,
  markUpdating,
  consumePostUpdateFlag
} from './update-checker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VERSION = currentVersion();

// Absolute paths to Windows system binaries. spawn('powershell', ...) and
// spawn('cmd.exe', ...) rely on PATH lookup, which fails on the
// stripped-PATH installs we've seen in the wild (Daniel hit this in v0.4
// during wizard task registration; another tester hit it in v0.5 trying
// to /pause). Resolving via %SystemRoot% always works on a sane Windows.
const SYS32      = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD_EXE    = path.join(SYS32, 'cmd.exe');
const SCHTASKS   = path.join(SYS32, 'schtasks.exe');

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
const ALLOWED_CHAT = String(env.TELEGRAM_CHAT_ID);

if (!TG_TOKEN || !ALLOWED_CHAT || ALLOWED_CHAT === 'undefined') {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in ' + ENV_PATH);
  console.error('   Re-run: node scripts/setup-wizard.mjs');
  process.exit(1);
}

// ---------- log ----------
const LOG = path.join(ROOT, 'data', 'telegram-bot.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
function log(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  try { fs.appendFileSync(LOG, msg + '\n'); } catch { /* never let log writes crash the bot */ }
}

// ---------- crash safety nets ----------
// Bot died once during a transient `fetch failed` Telegram outage — the
// suspected cause was an unhandled rejection or thrown error inside the
// poll-loop's catch block (e.g., log() failing on a locked file). Catch
// the kitchen sink so the bot never silently disappears. Token is scrubbed
// from log lines defensively in case it leaks via a stack trace.
process.on('unhandledRejection', (e) => {
  const raw = e instanceof Error ? `${e.message}\n${e.stack || ''}` : String(e);
  log('UNHANDLED REJECTION: ' + raw.replace(TG_TOKEN, '<TOKEN>'));
});
process.on('uncaughtException', (e) => {
  const raw = e instanceof Error ? `${e.message}\n${e.stack || ''}` : String(e);
  log('UNCAUGHT EXCEPTION: ' + raw.replace(TG_TOKEN, '<TOKEN>'));
});

// ---------- offset persistence ----------
const OFFSET_FILE = path.join(ROOT, 'data', 'bot-offset.json');
function loadOffset() {
  try { return JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')).offset || 0; }
  catch { return 0; }
}
function saveOffset(offset) {
  fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset }));
}

// ---------- telegram api ----------
async function tgGet(method, params = {}) {
  const url = new URL(`https://api.telegram.org/bot${TG_TOKEN}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, { signal: AbortSignal.timeout(40000) });
  return r.json();
}
async function tgPost(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) {
    log(`TG ${method} FAILED ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    throw new Error(`Telegram ${method} failed: ${j.description || j.error_code}`);
  }
  return j;
}
async function tgSendDocument(chatId, filePath, caption) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
  fd.append('document', new Blob([buf]), path.basename(filePath));
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  const j = await r.json();
  if (!j.ok) {
    log(`TG sendDocument FAILED ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    throw new Error(`Telegram sendDocument failed: ${j.description || j.error_code}`);
  }
  return j;
}

async function reply(chatId, text, opts = {}) {
  // First try with HTML parse_mode; if Telegram rejects the markup, fall back to plain text.
  try {
    return await tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...opts });
  } catch (e) {
    if (/parse|entit|tag/i.test(e.message)) {
      log(`HTML parse failed, retrying as plain text: ${e.message}`);
      return tgPost('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...opts });
    }
    throw e;
  }
}

// ---------- weather ----------
const WMO = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 81: 'showers', 82: 'heavy showers', 95: 'thunderstorm', 96: 'thunderstorm', 99: 'thunderstorm' };
const WMO_EMOJI = { 0: '☀️', 1: '🌤', 2: '⛅', 3: '☁️', 45: '🌫', 48: '🌫', 51: '🌦', 53: '🌦', 55: '🌧', 61: '🌧', 63: '🌧', 65: '🌧', 71: '🌨', 73: '🌨', 75: '❄️', 80: '🌦', 81: '🌧', 82: '⛈', 95: '⛈', 96: '⛈', 99: '⛈' };

async function getWeather() {
  // Read weather config fresh on every call so /city updates take effect immediately
  let w;
  try { w = cfgRW.read().weather || {}; }
  catch { w = { city: 'Miami', lat: 25.7617, lon: -80.1918, tempUnit: 'fahrenheit', timezone: 'America/New_York' }; }
  const lat = w.lat ?? 25.7617;
  const lon = w.lon ?? -80.1918;
  const unit = w.tempUnit || 'fahrenheit';
  const tz = w.timezone || 'auto';
  const city = w.city || 'Local';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&temperature_unit=${unit}&timezone=${encodeURIComponent(tz)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  const code = j.current.weather_code;
  const tempSuffix = unit === 'celsius' ? '°C' : '°F';
  return `${WMO_EMOJI[code] || '🌤'} ${city}: ${Math.round(j.current.temperature_2m)}${tempSuffix}, ${WMO[code] || 'unknown'}, high ${Math.round(j.daily.temperature_2m_max[0])}° / low ${Math.round(j.daily.temperature_2m_min[0])}°`;
}

// ---------- run claude code ----------
let runningJob = null;
let runningJobTimeout = null;
const SCRAPE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — generous

function clearRunningJob() {
  runningJob = null;
  if (runningJobTimeout) { clearTimeout(runningJobTimeout); runningJobTimeout = null; }
}

function runClaudeBatch(chatId) {
  if (runningJob) {
    return reply(chatId, '⏳ A scrape is already in progress — wait for it to finish.');
  }
  reply(chatId, '🔄 Scraping hiring.cafe… this takes 1–2 min. You\'ll get the batch when it\'s done.');
  log('Starting daily batch via run-daily-batch.cmd');
  const child = spawn(CMD_EXE, ['/c', path.join(ROOT, 'scripts', 'run-daily-batch.cmd')], {
    cwd: ROOT,
    detached: false,
    windowsHide: true
  });
  runningJob = child;
  let stderr = '';
  child.stderr?.on('data', d => { stderr += d.toString(); });
  child.on('error', (e) => {
    log('run-daily-batch spawn error: ' + e.message);
    clearRunningJob();
    reply(chatId, `❌ Could not start batch: ${escHtml(e.message)}`);
  });
  child.on('exit', (code) => {
    log(`run-daily-batch exit code=${code}`);
    clearRunningJob();
    if (code !== 0) {
      reply(chatId, `❌ Batch failed (exit ${code}). Check data/telegram-bot.log.\n<pre>${escHtml(stderr.slice(-500))}</pre>`);
    }
    // Success: the prompt itself sends the result to Telegram, no reply needed here.
  });
  // Self-clearing safety: if the process is killed externally and never emits exit/error,
  // the lock would stick forever. Force-clear after 5 min.
  runningJobTimeout = setTimeout(() => {
    if (runningJob === child) {
      log('runningJob timeout — force-clearing lock');
      try { child.kill('SIGKILL'); } catch {}
      clearRunningJob();
      reply(chatId, '⏰ Scrape took longer than 5 min and was force-stopped. Try /scrape again.').catch(() => {});
    }
  }, SCRAPE_TIMEOUT_MS);
}

// Generic helper: spawn a process and return Promise<{code, stdout}> with a timeout
function spawnWithTimeout(cmd, args, timeoutMs = 30000, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true, ...opts });
    let out = '';
    let timed = false;
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ code: -1, output: out + '\n[timed out after ' + (timeoutMs / 1000) + 's]', timeout: true });
    }, timeoutMs);
    child.stdout?.on('data', d => out += d.toString());
    child.stderr?.on('data', d => out += d.toString());
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -2, output: out + '\n' + e.message, error: true }); });
    child.on('exit', code => { if (!timed) { clearTimeout(timer); resolve({ code, output: out }); } });
  });
}

// ---------- config helpers (config-rw.mjs) ----------
import * as cfgRW from './config-rw.mjs';
import { geocode } from './geocode.mjs';
import { suggestRoles } from './role-suggester.mjs';
import { parseResume, writeParsedCV } from './resume-parser.mjs';

// Per-chat state for multi-step interactions (e.g. /resume waiting for attachment)
const pendingState = new Map(); // chatId -> { kind, startedAt, data? }
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes — anything older is stale

function getPendingState(chatId) {
  const s = pendingState.get(chatId);
  if (!s) return null;
  if (Date.now() - s.startedAt > PENDING_TTL_MS) {
    pendingState.delete(chatId);
    return null;
  }
  return s;
}

// Periodically purge stale entries so the Map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingState) {
    if (now - v.startedAt > PENDING_TTL_MS) pendingState.delete(k);
  }
}, 60 * 1000);

// ---------- dispatch ----------
const HELP_TEXT = `<b>🤖 Automatic Munyun Machine v${VERSION}</b>

<b>Core actions</b>
/scrape, /daily, gm  → weather + 100 jobs ranked by CV match
/save N              → bookmark job N on hiring.cafe
/applied N           → mark job N applied
/why N               → explain why job N got its match %
/export              → download today's batch as a .txt file

<b>Settings — view + edit from your phone</b>
/settings            → current config in one message
/resume              → upload a new resume (PDF/DOCX/MD)
/jobs                → list current search titles
/jobs add &lt;title&gt;    → add a search title
/jobs remove &lt;title&gt; → remove a search title
/jobs suggest        → bot reads your CV and proposes new titles
/yoe N               → set max years of experience
/salary N            → set salary floor in $K (e.g. /salary 120)
/clearance on/off    → toggle gov clearance filter
/forms all/simple/long → application form filter (Easy Apply etc.)
/skip &lt;company&gt;      → never show this company again
/unskip &lt;company&gt;    → reverse it
/city &lt;name&gt;         → change weather city
/schedule HH:MM      → change daily push time

<b>Maintenance</b>
/auth                → check hiring.cafe login
/reauth              → re-login on your computer
/pause /resume-bot   → stop/start the 7am push
/forget all          → wipe seen-jobs memory
/forget last         → un-memorize most recent batch
/weather             → Miami weather
/version             → show running version
/update              → pull latest from GitHub + restart
/update skip         → skip notifications about the latest version
/test, /ping         → bot health check
/help                → this message`;

// Latest batch TSV → array of { idx, id, title, company, yoe, q, url }
function loadLatestBatch() {
  const dir = path.join(ROOT, 'data');
  const files = fs.readdirSync(dir).filter(f => /^today-batch-\d{4}-\d{2}-\d{2}\.tsv$/.test(f)).sort();
  if (!files.length) return null;
  const latest = files[files.length - 1];
  const txt = fs.readFileSync(path.join(dir, latest), 'utf8');
  const rows = txt.trim().split('\n').map(l => {
    const [idx, id, title, company, yoe, q, url] = l.split('\t');
    return { idx: parseInt(idx), id, title, company, yoe, q, url, viewjobUrl: 'https://hiring.cafe/viewjob/' + id };
  });
  return { file: latest, rows };
}

async function spawnAction(action, jobUrl) {
  const args = jobUrl ? [path.join(ROOT, 'scripts', 'job-action.mjs'), action, jobUrl]
                       : [path.join(ROOT, 'scripts', 'job-action.mjs'), action];
  const r = await spawnWithTimeout('node', args, 60000);
  return { code: r.code, output: (r.output || '').trim(), timeout: r.timeout };
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  if (chatId !== ALLOWED_CHAT) {
    // Don't echo the rejected chat ID — could enable enumeration via log scrape
    log(`Ignored message from non-allowed chat`);
    return;
  }
  const text = (msg.text || '').trim().toLowerCase();
  log(`< ${text}`);

  if (/^\/?(start|help)\b/.test(text)) {
    return reply(chatId, HELP_TEXT);
  }
  if (/^\/?(test|ping)\b/.test(text)) {
    return reply(chatId, '✅ alive');
  }
  if (/^\/?weather\b/.test(text)) {
    try { return reply(chatId, await getWeather()); }
    catch (e) { return reply(chatId, '❌ Weather fetch failed: ' + e.message); }
  }
  // /scrape (and aliases /daily, gm, morning, update) — run a fresh batch
  if (/^\/?(scrape|daily|gm|morning|update)\b/.test(text) && !/^\/?jobs\b/.test(text)) {
    return runClaudeBatch(chatId);
  }

  // /auth — quick health check
  if (/^\/?auth\b/.test(text)) {
    reply(chatId, '🔍 Checking hiring.cafe login state…');
    const { code, output } = await spawnAction('auth');
    if (code === 0) {
      // Read auth-state.json for last-OK timestamp
      let extra = '';
      try {
        const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'auth-state.json'), 'utf8'));
        if (s.lastAuthOK) extra = `\nLast confirmed: ${new Date(s.lastAuthOK).toLocaleString()}`;
      } catch {}
      return reply(chatId, '✅ Logged in to hiring.cafe.' + extra);
    }
    return reply(chatId, '❌ Not logged in. Run <code>scripts\\login-once.cmd</code> on the laptop to re-auth.');
  }

  // /pause — disable 7am push
  if (/^\/?pause\b/.test(text)) {
    const r = await spawnWithTimeout(POWERSHELL, ['-NoProfile', '-Command', "Disable-ScheduledTask -TaskName 'munyun-daily-batch'"], 30000);
    if (r.timeout) return reply(chatId, '⏰ Pause command timed out after 30s. Try again.');
    if (r.code === 0) return reply(chatId, '⏸ Daily 7am push paused. Use /resume-bot to re-enable.');
    return reply(chatId, `❌ Could not pause (exit ${r.code}).${r.error ? '\n<i>spawn error: ' + escHtml(String(r.output || '').slice(0, 200)) + '</i>' : ''}`);
  }
  // /resume-bot — re-enable 7am push
  if (/^\/?resume[-_\s]?bot\b/.test(text)) {
    const r = await spawnWithTimeout(POWERSHELL, ['-NoProfile', '-Command', "Enable-ScheduledTask -TaskName 'munyun-daily-batch'"], 30000);
    if (r.timeout) return reply(chatId, '⏰ Resume command timed out after 30s. Try again.');
    if (r.code === 0) return reply(chatId, '▶️ Daily 7am push re-enabled.');
    return reply(chatId, `❌ Could not resume (exit ${r.code}).${r.error ? '\n<i>spawn error: ' + escHtml(String(r.output || '').slice(0, 200)) + '</i>' : ''}`);
  }
  // /reauth — spawn login-once.mjs on the user's machine
  if (/^\/?reauth\b/.test(text)) {
    reply(chatId, '🔓 Opening login window on your computer. Sign into hiring.cafe with Google, then close the window.');
    spawn(CMD_EXE, ['/c', path.join(ROOT, 'scripts', 'login-once.cmd')], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: false
    }).unref();
    return;
  }
  // /save N or /applied N
  const actionMatch = text.match(/^\/?(save|applied)\s+(\d+)\b/);
  if (actionMatch) {
    const action = actionMatch[1];
    const n = parseInt(actionMatch[2]);
    const batch = loadLatestBatch();
    if (!batch) return reply(chatId, '❌ No batch on disk yet — run /daily first.');
    const job = batch.rows.find(r => r.idx === n);
    if (!job) return reply(chatId, `❌ Job #${n} not found in latest batch (${batch.rows.length} jobs in ${batch.file}).`);
    reply(chatId, `🔄 ${action === 'save' ? 'Bookmarking' : 'Marking applied'}: <b>${escHtml(job.title)}</b> @ ${escHtml(job.company)}…`);
    const { code, output } = await spawnAction(action, job.viewjobUrl);
    if (code === 0) {
      // Bonus: append to applications.md when /applied succeeds
      if (action === 'applied') {
        try {
          const line = `\n| - | ${new Date().toISOString().slice(0, 10)} | ${job.company} | ${job.title} | - | APPLIED | - | - | via /applied | ${job.viewjobUrl} |`;
          fs.appendFileSync(path.join(ROOT, 'data', 'applications.md'), line);
        } catch (e) { log('applications.md append failed: ' + e.message); }
      }
      return reply(chatId, `✅ ${action === 'save' ? 'Saved' : 'Applied'} on hiring.cafe.${action === 'applied' ? '\nAlso logged to applications.md.' : ''}`);
    }
    return reply(chatId, `❌ ${action} failed.\n<pre>${escHtml(output.slice(0, 400))}</pre>`);
  }

  // ===== v0.3 commands =====

  // Use raw message (preserves case for skip lists, jobs add, city names)
  const rawText = (msg.text || '').trim();

  // /settings — show current config
  if (/^\/?settings\b/.test(text)) {
    try {
      const cfg = cfgRW.read();
      const cv = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cv-parsed.json'), 'utf8')); }
        catch { return null; }
      })();
      const queries = cfg.queries || [];
      const skip = cfg.filters?.skipCompanies || [];
      const seen = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seen-jobs.json'), 'utf8')).ids?.length || 0; }
        catch { return 0; }
      })();
      const lines = [
        '<b>⚙️ Current configuration</b>',
        '',
        `<b>Resume:</b>     ${cv ? `${cv.titles?.length || 0} titles · ${cv.certs?.length || 0} certs · ${cv.skills?.length || 0} skills` : 'not parsed'}`,
        `<b>Years exp:</b>  max ${cfg.user?.maxYoeAcceptable ?? 5}`,
        `<b>Salary:</b>     floor $${(cfg.user?.salaryFloorUsd || 0).toLocaleString()}`,
        `<b>Clearance:</b>  ${cfg.filters?.filterClearance === false ? 'INCLUDED in results' : 'filtered OUT'}`,
        `<b>Forms:</b>      ${{ all: 'all (default)', simple: 'Simple only (quick apps)', long: 'Time-consuming only' }[cfg.filters?.applicationFormEase || 'all']}`,
        `<b>Weather:</b>    ${cfg.weather?.city || '?'} (${cfg.weather?.lat}, ${cfg.weather?.lon})`,
        `<b>Schedule:</b>   ${cfg.schedule?.time || '?'} ${(cfg.schedule?.days || []).map(d => d.slice(0, 3)).join('/')}`,
        '',
        `<b>Job titles (${queries.length}):</b>`,
        '  ' + queries.map(q => q.term).join(', '),
        '',
        skip.length ? `<b>Skip list (${skip.length}):</b> ${skip.join(', ')}` : '<b>Skip list:</b> empty',
        `<b>Memory:</b>     ${seen} jobs seen`,
        '',
        '<i>Edit any: /yoe N · /salary N · /clearance on/off · /forms all|simple|long · /city &lt;name&gt; · /schedule HH:MM · /skip · /unskip · /jobs · /resume · /forget</i>'
      ];
      return reply(chatId, lines.join('\n'));
    } catch (e) {
      return reply(chatId, '❌ Could not read settings: ' + e.message);
    }
  }

  // /yoe N — set max years of experience
  const yoeM = text.match(/^\/?yoe\s+(\d{1,2})\b/);
  if (yoeM) {
    const n = parseInt(yoeM[1]);
    cfgRW.set('user.maxYoeAcceptable', n);
    return reply(chatId, `✅ Max YOE set to <b>${n}</b>. Next /scrape will use this.`);
  }

  // /salary N — set salary floor in $K
  const salM = text.match(/^\/?salary\s+(\d{2,4})\b/);
  if (salM) {
    const k = parseInt(salM[1]);
    cfgRW.set('user.salaryFloorUsd', k * 1000);
    return reply(chatId, `✅ Salary floor set to <b>$${k}k</b>.`);
  }

  // /clearance on/off
  const clearM = text.match(/^\/?clearance\s+(on|off)\b/);
  if (clearM) {
    const filterOn = clearM[1] === 'on';
    cfgRW.set('filters.filterClearance', filterOn);
    return reply(chatId, filterOn
      ? '🛡️ Clearance filter <b>ON</b> — gov clearance jobs will be filtered OUT.'
      : '🛡️ Clearance filter <b>OFF</b> — gov clearance jobs will be INCLUDED.');
  }

  // /forms all|simple|long — hiring.cafe applicationFormEase toggle
  const formsM = text.match(/^\/?forms\s+(all|simple|long|easy|time)\b/);
  if (formsM) {
    let v = formsM[1];
    if (v === 'easy') v = 'simple';   // alias
    if (v === 'time') v = 'long';     // alias
    cfgRW.set('filters.applicationFormEase', v);
    const labels = {
      all:    'All Application Forms (no filter — both quick and long apps)',
      simple: 'Simple Application Forms only (no account creation, fast apply)',
      long:   'Time Consuming Application Forms only (longer/multi-step apps)'
    };
    return reply(chatId, `📝 Application form filter: <b>${labels[v]}</b>`);
  }

  // /skip <company>
  const skipM = rawText.match(/^\/?skip\s+(.+)$/i);
  if (skipM) {
    const company = skipM[1].trim();
    const r = cfgRW.appendUnique('filters.skipCompanies', company);
    return reply(chatId, r.added
      ? `✅ Added <b>${escHtml(company)}</b> to skip list. ${r.list.length} companies blocked.`
      : `<i>${escHtml(company)} was already in skip list.</i>`);
  }

  // /unskip <company>
  const unskipM = rawText.match(/^\/?unskip\s+(.+)$/i);
  if (unskipM) {
    const company = unskipM[1].trim();
    const r = cfgRW.removeFromArray('filters.skipCompanies', company);
    return reply(chatId, r.removed
      ? `✅ Removed <b>${escHtml(company)}</b> from skip list. ${r.list.length} remaining.`
      : `<i>${escHtml(company)} wasn't in the skip list.</i>`);
  }

  // /city <name>
  const cityM = rawText.match(/^\/?city\s+(.+)$/i);
  if (cityM) {
    const q = cityM[1].trim();
    reply(chatId, `🌍 Looking up <b>${escHtml(q)}</b>…`);
    try {
      const r = await geocode(q);
      if (!r) return reply(chatId, `❌ No match for "${escHtml(q)}". Try a more specific query.`);
      cfgRW.set('weather.city', r.city);
      cfgRW.set('weather.lat', r.lat);
      cfgRW.set('weather.lon', r.lon);
      cfgRW.set('weather.timezone', r.timezone);
      return reply(chatId, `✅ Weather city: <b>${escHtml(r.city)}</b>${r.admin ? `, ${escHtml(r.admin)}` : ''} (${escHtml(r.country)})`);
    } catch (e) { return reply(chatId, '❌ Geocoding failed: ' + e.message); }
  }

  // /schedule HH:MM
  const schedM = text.match(/^\/?schedule\s+(\d{1,2}):(\d{2})\b/);
  if (schedM) {
    const hh = parseInt(schedM[1]), mm = parseInt(schedM[2]);
    if (hh > 23 || mm > 59) return reply(chatId, '❌ Invalid time. Use 24-hour HH:MM.');
    const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    cfgRW.set('schedule.time', time);
    const r = await spawnWithTimeout(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'setup-tasks.ps1')], 30000);
    if (r.timeout) return reply(chatId, `⏰ Schedule saved but task re-registration timed out after 30s.`);
    return reply(chatId, r.code === 0
      ? `✅ Schedule updated to <b>${time}</b>. Task Scheduler re-registered.`
      : `❌ Schedule saved but task re-registration failed:\n<pre>${escHtml((r.output || '').slice(0, 300))}</pre>`);
  }

  // /jobs — list / add / remove / suggest
  if (/^\/?jobs\b/.test(text)) {
    const cfg = cfgRW.read();
    const queries = cfg.queries || [];

    // /jobs add "Title"
    const addM = rawText.match(/^\/?jobs\s+add\s+["']?(.+?)["']?$/i);
    if (addM) {
      const term = addM[1].trim();
      const key = term.replace(/[^a-z0-9]/gi, '').slice(0, 20);
      const r = cfgRW.appendUnique('queries', { key, term });
      return reply(chatId, r.added
        ? `✅ Added "<b>${escHtml(term)}</b>" — now searching ${r.list.length} job titles.`
        : `<i>"${escHtml(term)}" was already in your search list.</i>`);
    }

    // /jobs remove "Title"
    const rmM = rawText.match(/^\/?jobs\s+remove\s+["']?(.+?)["']?$/i);
    if (rmM) {
      const term = rmM[1].trim();
      const r = cfgRW.removeFromArray('queries', term);
      return reply(chatId, r.removed
        ? `✅ Removed "<b>${escHtml(term)}</b>". ${r.list.length} titles remaining.`
        : `<i>"${escHtml(term)}" wasn't in your search list.</i>`);
    }

    // /jobs suggest
    if (/^\/?jobs\s+suggest\b/i.test(text)) {
      try {
        const cv = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cv-parsed.json'), 'utf8'));
        const suggestions = suggestRoles(cv, { max: 12 });
        if (!suggestions.length) {
          return reply(chatId, '❌ No suggestions. Your CV may be too sparse — try /resume to upload a fuller version.');
        }
        const existing = new Set(queries.map(q => q.term.toLowerCase()));
        const fresh = suggestions.filter(s => !existing.has(s.title.toLowerCase()));
        if (!fresh.length) {
          return reply(chatId, '✅ Your search list already covers the strongest matches from your CV. Nothing new to suggest.');
        }
        const lines = [
          '<b>💡 Suggested job titles based on your CV:</b>',
          '',
          ...fresh.map((s, i) => `${i + 1}. <b>${escHtml(s.title)}</b>\n   <i>${escHtml(s.cluster)} · ${s.signalsHit.slice(0, 4).map(escHtml).join(', ')}</i>`),
          '',
          'Add any with: <code>/jobs add Title Here</code>'
        ];
        return reply(chatId, lines.join('\n'));
      } catch (e) {
        return reply(chatId, '❌ Could not load CV. Try /resume to upload one first.');
      }
    }

    // /jobs (list)
    if (!queries.length) return reply(chatId, '<i>No search titles yet. Add some with /jobs add &lt;title&gt;.</i>');
    const lines = [
      `<b>🔎 Search titles (${queries.length}):</b>`,
      '',
      ...queries.map((q, i) => `${i + 1}. ${escHtml(q.term)}`),
      '',
      '<i>/jobs add "Title" · /jobs remove "Title" · /jobs suggest</i>'
    ];
    return reply(chatId, lines.join('\n'));
  }

  // /resume — start file upload flow
  if (/^\/?resume\b/.test(text)) {
    pendingState.set(chatId, { kind: 'resume_upload', startedAt: Date.now() });
    return reply(chatId, '📎 Send me your resume as an attachment (PDF, DOCX, or MD).\nI\'ll parse it and update your skills/certs/titles. Cancel with /cancel.');
  }

  // /cancel — clear any pending state
  if (/^\/?cancel\b/.test(text)) {
    pendingState.delete(chatId);
    return reply(chatId, '✅ Cancelled.');
  }

  // /why N — explain match
  const whyM = text.match(/^\/?why\s+(\d{1,3})\b/);
  if (whyM) {
    const n = parseInt(whyM[1]);
    try {
      const last = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'last-batch.json'), 'utf8'));
      const job = last.jobs.find(j => j.idx === n);
      if (!job) return reply(chatId, `❌ Job #${n} not found in last batch (${last.jobs.length} jobs).`);
      const lines = [
        `<b>${job.matchPct}% match: ${escHtml(job.title)}</b>`,
        `<i>${escHtml(job.company)}</i>`,
        '',
        `<b>Raw score:</b> ${job.score}`,
        `<b>Search query that found it:</b> ${escHtml(job.q)}`,
        job.matched.length ? `<b>Matched keywords (${job.matched.length}):</b>\n${job.matched.map(escHtml).join(' · ')}` : '<i>No CV keywords matched — score is from search relevance only.</i>',
        '',
        `<a href="${job.directUrl || job.viewjobUrl}">Open job →</a>`
      ];
      return reply(chatId, lines.join('\n'));
    } catch {
      return reply(chatId, '❌ No batch data on disk. Run /scrape first.');
    }
  }

  // /forget all
  if (/^\/?forget\s+all\b/.test(text)) {
    try {
      fs.unlinkSync(path.join(ROOT, 'data', 'seen-jobs.json'));
      return reply(chatId, '🗑 Wiped seen-jobs memory. Next /scrape treats every job as fresh.');
    } catch {
      return reply(chatId, '<i>No memory to wipe — you\'re already at a clean slate.</i>');
    }
  }

  // /version — show running version + last seen latest version
  if (/^\/?version\b/.test(text)) {
    const latest = (await checkForUpdate())?.latest || '?';
    return reply(chatId, [
      `🤖 <b>Automatic Munyun Machine v${VERSION}</b>`,
      `Latest on GitHub: v${latest}`,
      latest && latest !== '?' && latest !== VERSION ? '\n<i>Run /update to install the latest.</i>' : ''
    ].filter(Boolean).join('\n'));
  }

  // /update [skip|check]
  //   /update         → pull latest from main, npm install, restart bot
  //   /update skip    → mark current latest as "don't notify me about this version"
  //   /update check   → re-fetch GitHub and report
  //   /update notes   → release notes for the latest
  if (/^\/?update\b/.test(text)) {
    const sub = text.replace(/^\/?update\s*/, '').trim();

    if (sub.startsWith('skip')) {
      const info = await checkForUpdate();
      if (!info || !info.latest) return reply(chatId, '⚠️ Could not reach GitHub to confirm the version. Try again later.');
      dismissVersion(info.latest);
      return reply(chatId, `🙈 Skipping v${info.latest}. I'll let you know when a newer version is available.`);
    }

    if (sub.startsWith('check')) {
      // Force-refresh: user explicitly asked, bypass the 5-min cache.
      const info = await checkForUpdate({ force: true });
      if (!info) return reply(chatId, '⚠️ Could not reach GitHub. Try again later.');
      if (!info.hasUpdate) return reply(chatId, `✅ You're on the latest: v${info.current}.`);
      const notes = info.releaseNotes ? info.releaseNotes.slice(0, 500) : '';
      return reply(chatId, [
        `🆕 v${info.latest} available (you're on v${info.current})`,
        notes ? '\n' + escHtml(notes) : '',
        `\n<code>/update</code> to install · <code>/update skip</code> to dismiss`
      ].join('\n'));
    }

    if (sub.startsWith('notes')) {
      const info = await checkForUpdate();
      if (!info) return reply(chatId, '⚠️ Could not reach GitHub.');
      const notes = info.releaseNotes || '<i>(no release notes)</i>';
      return reply(chatId, `<b>v${info.latest} release notes:</b>\n\n${escHtml(notes).slice(0, 3500)}\n\n${info.releaseUrl}`);
    }

    // Bare /update → run the actual update flow
    const info = await checkForUpdate();
    if (!info) return reply(chatId, '⚠️ Could not reach GitHub. Try again later.');
    if (!info.hasUpdate) return reply(chatId, `✅ You're already on the latest: v${info.current}. Nothing to update.`);

    await reply(chatId, `🔄 Updating from v${info.current} to v${info.latest}…\n<i>Pulling latest from GitHub.</i>`);

    // git pull origin main (spawnWithTimeout's cwd already defaults to ROOT)
    const pullR = await spawnWithTimeout('git', ['pull', 'origin', 'main'], 60000);
    if (pullR.timeout) return reply(chatId, '❌ git pull timed out after 60s. Cancelling update.');
    if (pullR.code !== 0) {
      return reply(chatId, `❌ git pull failed (exit ${pullR.code}):\n<pre>${escHtml((pullR.output || '').slice(0, 800))}</pre>\n\n<i>Likely cause: uncommitted local changes. Update the bot manually:\n<code>cd %LOCALAPPDATA%\\automatic-munyun-machine; git stash; git pull origin main; npm install</code></i>`);
    }

    await reply(chatId, '📦 <i>Installing dependencies…</i>');
    // npm.cmd on Windows — passing 'npm' to spawn() without shell:true won't find it
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npmR = await spawnWithTimeout(npmCmd, ['install', '--no-audit', '--no-fund', '--loglevel=error'], 120000);
    if (npmR.timeout) return reply(chatId, '❌ npm install timed out after 2min. Bot left in old state — restart manually.');
    if (npmR.code !== 0) {
      return reply(chatId, `❌ npm install failed (exit ${npmR.code}):\n<pre>${escHtml((npmR.output || '').slice(0, 800))}</pre>`);
    }

    // Mark for the post-restart confirmation message
    markUpdating(info.current, info.latest);

    await reply(chatId, '👋 <b>Restarting bot to apply update…</b>\nBack online in ~10 seconds.');

    // Detached restarter: waits 4s for this bot to exit, then runs schtasks
    // to start a fresh bot from the (now updated) code on disk.
    // Absolute paths used everywhere — if PATH is stripped (which is exactly
    // the kind of environment that needs auto-update most), this still works.
    const TIMEOUT = path.join(SYS32, 'timeout.exe');
    const restartCmd = `"${TIMEOUT}" /t 4 /nobreak >nul && "${SCHTASKS}" /run /tn munyun-bot`;
    const restarter = spawn(CMD_EXE, ['/c', restartCmd], {
      detached: true, stdio: 'ignore', windowsHide: true
    });
    restarter.unref();

    // Give Telegram ~1s to deliver the "restarting" message before we exit
    await new Promise(r => setTimeout(r, 1500));
    log('Bot exiting for update restart');
    process.exit(0);
  }

  // /export — send today's jobs(YYYY-MM-DD).txt as a downloadable attachment.
  // Falls back to the most recent dated file if today's hasn't been generated yet.
  if (/^\/?export\b/.test(text)) {
    try {
      const dir = path.join(ROOT, 'data');
      const today = new Date().toISOString().slice(0, 10);
      const todayFile = path.join(dir, `jobs(${today}).txt`);
      if (fs.existsSync(todayFile)) {
        await tgSendDocument(chatId, todayFile, `📄 jobs(${today}).txt — today's batch`);
        return;
      }
      const files = fs.readdirSync(dir).filter(f => /^jobs\(\d{4}-\d{2}-\d{2}\)\.txt$/.test(f)).sort();
      if (!files.length) {
        return reply(chatId, '<i>No batches yet. Run /scrape to generate one.</i>');
      }
      const latest = files[files.length - 1];
      const latestDate = latest.match(/\d{4}-\d{2}-\d{2}/)[0];
      await tgSendDocument(chatId, path.join(dir, latest), `📄 ${latest} — most recent batch (no run yet today, last from ${latestDate})`);
      return;
    } catch (e) {
      return reply(chatId, '❌ Export failed: ' + escHtml(e.message));
    }
  }

  // /forget last
  if (/^\/?forget\s+last\b/.test(text)) {
    try {
      const seenPath = path.join(ROOT, 'data', 'seen-jobs.json');
      const last = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'last-batch.json'), 'utf8'));
      const seen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
      const remove = new Set(last.jobs.map(j => j.viewjobUrl));
      const before = seen.ids.length;
      seen.ids = seen.ids.filter(id => !remove.has(id));
      fs.writeFileSync(seenPath, JSON.stringify(seen, null, 2));
      return reply(chatId, `✅ Forgot ${before - seen.ids.length} jobs from the last batch. They'll come back next /scrape.`);
    } catch (e) {
      return reply(chatId, '❌ ' + e.message);
    }
  }

  return reply(chatId, `Unknown command. Try /help.`);
}

// Handle file attachments (for /resume upload flow)
async function handleAttachment(msg) {
  const chatId = String(msg.chat.id);
  if (chatId !== ALLOWED_CHAT) return;
  const state = getPendingState(chatId);
  if (!state || state.kind !== 'resume_upload') {
    return reply(chatId, '<i>I wasn\'t expecting an attachment. Use /resume to upload a new resume.</i>');
  }
  pendingState.delete(chatId);

  const doc = msg.document;
  if (!doc) return reply(chatId, '❌ Send a file as a Document attachment, not a photo.');

  const ext = path.extname(doc.file_name || '').toLowerCase();
  if (!['.pdf', '.docx', '.md', '.txt', '.markdown'].includes(ext)) {
    return reply(chatId, `❌ Unsupported format: ${ext}. Use PDF, DOCX, or MD.`);
  }

  reply(chatId, '🔄 Downloading + parsing…');
  let downloadOk = false;
  try {
    const fileInfo = await tgGet('getFile', { file_id: doc.file_id });
    if (!fileInfo.ok) throw new Error('Telegram getFile rejected the request');
    // Build the download URL inline; never log or surface this string — it contains TG_TOKEN
    const downloadUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${fileInfo.result.file_path}`;
    let r;
    try {
      r = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
    } catch (netErr) {
      // Strip token from any thrown error message before re-raising
      const safe = String(netErr.message || netErr).replace(TG_TOKEN, '<TOKEN>');
      throw new Error('Network: ' + safe);
    }
    if (!r.ok) throw new Error(`Download HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    downloadOk = true;

    const localPath = path.join(ROOT, 'data', `cv-uploaded${ext}`);
    fs.writeFileSync(localPath, buf);

    const parsed = await parseResume(localPath);
    if (!parsed || !Array.isArray(parsed.titles) || !Array.isArray(parsed.skills)) {
      throw new Error('Parser returned invalid shape — file may be corrupted');
    }
    writeParsedCV(parsed);

    return reply(chatId, [
      '✅ <b>Resume updated!</b>',
      '',
      `${parsed.titles.length} titles · ${parsed.certs.length} certs · ${parsed.skills.length} skills · ${parsed.compliance.length} compliance frameworks`,
      '',
      `<b>Top skills:</b> ${parsed.skills.slice(0, 8).map(escHtml).join(', ')}`,
      '',
      'Try <code>/jobs suggest</code> for new search title ideas, then /scrape for a fresh batch.'
    ].join('\n'));
  } catch (e) {
    // Defense-in-depth: scrub any token that might have leaked into the error message
    const safe = String(e.message || e).replace(TG_TOKEN, '<TOKEN>');
    log('Resume upload failed: ' + safe);
    return reply(chatId, '❌ Resume upload failed: ' + escHtml(safe));
  }
}

function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---------- main loop ----------
let offset = loadOffset();
// Mask all but last 4 digits of chat ID in logs
const maskedChat = ALLOWED_CHAT.length > 4 ? '***' + ALLOWED_CHAT.slice(-4) : '***';
log(`Bot starting v${VERSION}. Offset=${offset}. Allowed chat=${maskedChat}.`);

// Detect a fresh-from-update reboot — if the previous bot wrote .updating
// before exiting, this run is the result of a successful pull+install.
// Send a clear confirmation message instead of the generic "online" ping.
const postUpdate = consumePostUpdateFlag();
if (postUpdate) {
  log(`Post-update detected: from v${postUpdate.from} to v${VERSION}`);
  reply(ALLOWED_CHAT, `✅ <b>Updated to v${VERSION}</b> (was v${postUpdate.from}).\nBot is back online — type /help for commands.`).catch(e => log('Post-update ping failed: ' + e.message));
} else {
  reply(ALLOWED_CHAT, `🤖 <b>Automatic Munyun Machine v${VERSION}</b> — online. /help for commands.`).catch(e => log('Initial ping failed: ' + e.message));
}

// Update check on startup (5s delay so we don't race the startup ping) +
// once every 24h thereafter. If a newer release is on GitHub and the user
// hasn't dismissed it, the bot pings the chat with what's new.
async function notifyIfUpdateAvailable() {
  try {
    const info = await checkForUpdate();
    if (!info) return; // network/API failed — silently retry next cycle
    if (!info.hasUpdate) { log(`Update check: on latest v${info.current}`); return; }
    if (info.dismissed) { log(`Update check: v${info.latest} available but dismissed`); return; }
    log(`Update check: v${info.current} -> v${info.latest} available`);
    const notes = info.releaseNotes ? info.releaseNotes.slice(0, 700) : '';
    const text = [
      `🆕 <b>Update available: v${info.current} → v${info.latest}</b>`,
      '',
      notes ? `<b>What's new:</b>\n${escHtml(notes)}\n` : '',
      `Install now: <code>/update</code>`,
      `Skip this version: <code>/update skip</code>`,
      `Full release notes: ${info.releaseUrl}`
    ].filter(Boolean).join('\n');
    await reply(ALLOWED_CHAT, text).catch(e => log('Update notification failed: ' + e.message));
  } catch (e) {
    log('notifyIfUpdateAvailable error: ' + e.message);
  }
}
setTimeout(() => { notifyIfUpdateAvailable(); }, 5000);
setInterval(() => { notifyIfUpdateAvailable(); }, 24 * 60 * 60 * 1000);

// Resilient poll loop with exponential backoff + recovery detection.
// On Telegram outages we used to retry every 5s and silently die if anything
// in the catch block threw. Now we:
//   - Back off (5s -> 10s -> 20s -> 30s cap) so we don't hammer Telegram
//     during sustained outages.
//   - Track consecutive failures + outage start so we can log a clear
//     "✓ recovered" line when polling succeeds again.
//   - Send a Telegram ping if the outage lasted >= 60s so the user knows
//     the bot was offline (vs. silent death they only notice when
//     /scrape doesn't respond).
const BACKOFF_MS = [5000, 10000, 20000, 30000];
let consecutiveFailures = 0;
let outageStartedAt = null;

while (true) {
  try {
    const j = await tgGet('getUpdates', { offset, timeout: 30, allowed_updates: JSON.stringify(['message']) });

    // Just recovered from a poll-failure streak — note it loudly.
    if (consecutiveFailures > 0) {
      const downSec = outageStartedAt ? Math.round((Date.now() - outageStartedAt) / 1000) : 0;
      log(`Telegram reachable again — recovered after ${consecutiveFailures} failed polls (~${downSec}s)`);
      if (downSec >= 60) {
        const human = downSec >= 120 ? `${Math.round(downSec / 60)}m` : `${downSec}s`;
        reply(ALLOWED_CHAT, `📶 Bot reconnected after ~${human} of poll failures.`).catch(e => log('Recovery ping failed: ' + e.message));
      }
      consecutiveFailures = 0;
      outageStartedAt = null;
    }

    if (j.ok && j.result?.length) {
      for (const u of j.result) {
        if (u.message) {
          if (u.message.document) {
            // File attachment — route to attachment handler
            handleAttachment(u.message).catch(e => log('handleAttachment error: ' + e.message));
          } else {
            handleMessage(u.message).catch(e => log('handleMessage error: ' + e.message));
          }
        }
        offset = u.update_id + 1;
      }
      saveOffset(offset);
    }
  } catch (e) {
    consecutiveFailures++;
    if (consecutiveFailures === 1) outageStartedAt = Date.now();
    const delay = BACKOFF_MS[Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)];
    log(`poll error #${consecutiveFailures}: ${e.message} — backing off ${delay / 1000}s`);
    try {
      await new Promise(r => setTimeout(r, delay));
    } catch { /* setTimeout never rejects, but defensive */ }
  }
}
