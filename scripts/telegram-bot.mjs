#!/usr/bin/env node
/**
 * Long-running Telegram bot for Automatic Munyun Machine.
 *
 * Polls Telegram getUpdates every 3 sec for new messages from your chat.
 * Dispatches commands:
 *   /scrape, /daily, gm, morning  → run daily batch (weather + 100 jobs)
 *   /export [csv|xlsx]            → apply-links export (.txt, .csv, or .xlsx with clickable links)
 *   /weather                      → weather only (city from config.json)
 *   /version                      → show bot version + latest GitHub version
 *   /update                       → pull latest code from GitHub + restart
 *   /test, /ping                  → reply "alive"
 *   /help, /start                 → list commands
 *   (plus /save, /applied, /why, /resume, /jobs, /yoe, /salary,
 *    /clearance, /forms, /skip, /city, /schedule, /pause, /resume-bot,
 *    /forget, /settings, /auth, /reauth, /cancel — see /help in-bot)
 *
 * Started at logon by Task Scheduler entry `munyun-bot`.
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
import {
  parseAndVerify,
  makeCallback,
  makeNavCallback,
  readCallbackTable
} from './callback-router.mjs';
import {
  migrateIfNeeded,
  paths as profilePaths,
  listProfiles,
  addProfile,
  setActiveProfile,
  deleteProfile,
  getActiveProfile,
  readActiveConfig
} from './profile-store.mjs';

// v1.0 E5: ensure migration ran before any path is resolved.
migrateIfNeeded();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VERSION = currentVersion();

// v1.1 — system binaries + scheduler ops moved into scripts/os-paths.mjs.
// On Win32 these resolve to absolute %SystemRoot% paths (the stripped-PATH
// defense from v0.4.1 / v0.5); on Mac/Linux they're null + the runtime
// branches via runScheduledTask / disableScheduledTask / etc.
import {
  IS_WIN32, IS_DARWIN, IS_LINUX, PLATFORM,
  POWERSHELL, CMD_EXE, SCHTASKS,
  npmCmd, gitCmd,
  runScheduledTask, disableScheduledTask, enableScheduledTask, scheduledTaskExists,
  LOGIN_HELPER_DOC, SETUP_HELPER_DOC, RESTART_HINT_DOC, INSTALL_DIR_HINT
} from './os-paths.mjs';
import { atomicWriteJson, lockedUpdateJsonSync } from './io-helpers.mjs';
import { readHcafeAuthCache, dedupMode } from './hcafe-session.mjs';
import { clampBatchSize } from './batch-size.mjs';
import { recordAppliedJob } from './application-ledger.mjs';

// v4.3: is account dedup on for the active profile? Read fresh each call —
// settings edits can flip it while the bot runs. Fail-open to the default.
function accountDedupEnabled() {
  try { return readActiveConfig()?.scoring?.accountDedup !== false; }
  catch { return true; }
}
import { telegramConfigured, parseEnvText } from './telegram-config.mjs';
import { loadExport } from './export-batch.mjs';

// ---------- env ----------
// v2.4: Telegram is optional (v2.1) — the poller only makes sense when a
// token + chat id are configured. Exit 0 (not 1) with a friendly note when
// they aren't: the wrapper's supervisor gates on the same telegramConfigured
// definition and shouldn't spawn us at all, but if we ARE run directly
// (npm run bot, old scheduled task), a hard non-zero exit used to read as a
// crash and could burn the supervisor's restart budget, taking the whole
// tray app down.
const ENV_PATH = path.join(ROOT, '.env');
const env = fs.existsSync(ENV_PATH) ? parseEnvText(fs.readFileSync(ENV_PATH, 'utf8')) : {};

if (!telegramConfigured(env)) {
  console.error('Telegram is not set up (no valid TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env).');
  console.error('The bot poller is only needed for phone notifications — AMM works without it.');
  console.error('Enable Telegram from the dashboard (tray icon → Open dashboard → Telegram panel).');
  process.exit(0);
}
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT = String(env.TELEGRAM_CHAT_ID);

// Identifiable in Task Manager / window title of the minimized console.
process.title = 'munyun-bot';

// Defensive scrubber: if TG_TOKEN is somehow falsy (env reload, future
// refactor), `String.replace(undefined, …)` would coerce to literal
// "undefined" and replace stray substrings. Explicitly check truthiness.
// Defined ABOVE log() because log() scrubs centrally (v2.0).
const SCRUB = (s) => {
  if (s == null) return '';
  let str = String(s);
  if (TG_TOKEN) str = str.split(TG_TOKEN).join('<TOKEN>');
  return str;
};

// ---------- log ----------
const LOG = path.join(ROOT, 'data', 'telegram-bot.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB so the log can't grow unbounded
fs.mkdirSync(path.dirname(LOG), { recursive: true });
try {
  if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX_BYTES) {
    fs.rmSync(LOG + '.1', { force: true });
    fs.renameSync(LOG, LOG + '.1');
  }
} catch { /* rotation is best-effort */ }
function log(line) {
  const stamp = new Date().toISOString();
  // Central token scrub — no individual call site can leak TG_TOKEN to disk.
  const msg = `[${stamp}] ${SCRUB(line)}`;
  console.log(msg);
  try { fs.appendFileSync(LOG, msg + '\n'); } catch { /* never let log writes crash the bot */ }
}

// ---------- crash safety nets ----------
// Bot died once during a transient `fetch failed` Telegram outage — the
// suspected cause was an unhandled rejection or thrown error inside the
// poll-loop's catch block (e.g., log() failing on a locked file). Catch
// the kitchen sink so the bot never silently disappears. Token is scrubbed
// from log lines centrally inside log() (SCRUB defined near the top).
process.on('unhandledRejection', (e) => {
  const raw = e instanceof Error ? `${e.message}\n${e.stack || ''}` : String(e);
  log('UNHANDLED REJECTION: ' + SCRUB(raw));
});
process.on('uncaughtException', (e) => {
  const raw = e instanceof Error ? `${e.message}\n${e.stack || ''}` : String(e);
  log('UNCAUGHT EXCEPTION: ' + SCRUB(raw));
});

// ---------- heartbeat ----------
// Written every poll-loop iteration (success OR failure) so the watchdog can
// distinguish "process alive but Telegram unreachable" from "process dead."
// Out-of-process watchdog (scripts/watchdog.mjs) reads this and restarts the
// bot if ts is stale > 10 min.
const HEARTBEAT_FILE = path.join(ROOT, 'data', 'heartbeat.json');
const BOT_STARTED_AT = Date.now();
function writeHeartbeat(extra = {}) {
  try {
    atomicWriteJson(HEARTBEAT_FILE, {
      ts: new Date().toISOString(),
      pid: process.pid,
      version: VERSION,
      startedAt: new Date(BOT_STARTED_AT).toISOString(),
      ...extra
    });
  } catch { /* never let heartbeat write crash the bot */ }
}

// ---------- offset persistence ----------
const OFFSET_FILE = path.join(ROOT, 'data', 'bot-offset.json');
function loadOffset() {
  try { return JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')).offset || 0; }
  catch { return 0; }
}
function saveOffset(offset) {
  atomicWriteJson(OFFSET_FILE, { offset });
}

// ---------- telegram api ----------
async function tgGet(method, params = {}) {
  const url = new URL(`https://api.telegram.org/bot${TG_TOKEN}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, { signal: AbortSignal.timeout(40000) });
  // Non-JSON guard: a 502 from Telegram's CDN returns an HTML error page;
  // r.json() throwing "Unexpected token <" used to surface as an
  // inscrutable poll error. Name the real condition instead.
  try {
    return await r.json();
  } catch {
    throw new Error(`Telegram ${method} returned non-JSON (HTTP ${r.status})`);
  }
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

// v1.0 E4: ack a callback so Telegram stops showing the loading spinner on
// the user's button. `text` shows as a brief toast; alert=true shows as a
// modal popup instead. Both optional.
async function tgAnswerCallback(callbackQueryId, text = '', alert = false) {
  try {
    await tgPost('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text, show_alert: alert } : {})
    });
  } catch (e) {
    log('answerCallbackQuery failed: ' + e.message);
  }
}

// Edit a message in place (used by the paginated browser to re-render the
// same bubble on prev/next instead of piling up new messages). Returns the
// API response or throws.
async function tgEditMessage(chatId, messageId, text, opts = {}) {
  try {
    return await tgPost('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...opts
    });
  } catch (e) {
    // Telegram throws "message is not modified" when the new text === old text.
    // That's not really an error from our perspective.
    if (/not modified/i.test(e.message)) return null;
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

// ---------- run daily batch ----------
let runningJob = null;
let runningJobTimeout = null;
const SCRAPE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — generous

function clearRunningJob() {
  runningJob = null;
  if (runningJobTimeout) { clearTimeout(runningJobTimeout); runningJobTimeout = null; }
}

function runDailyBatch(chatId) {
  if (runningJob) {
    return reply(chatId, '⏳ A scrape is already in progress — wait for it to finish.');
  }
  reply(chatId, '🔄 Scraping hiring.cafe… this takes 1–2 min. You\'ll get the batch when it\'s done.');
  // v1.1 cross-platform: on Windows we go through cmd /c run-daily-batch.cmd
  // (preserves the legacy detached-window contract); on Mac/Linux we invoke
  // node directly with the daily-batch.mjs path. Both inherit cwd=ROOT.
  let child;
  if (IS_WIN32) {
    log('Starting daily batch via run-daily-batch.cmd');
    child = spawn(CMD_EXE, ['/c', path.join(ROOT, 'scripts', 'run-daily-batch.cmd')], {
      cwd: ROOT, detached: false, windowsHide: true
    });
  } else {
    log('Starting daily batch via node scripts/daily-batch.mjs');
    // process.execPath — the node running us — needs no PATH at all (v2.0).
    child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'daily-batch.mjs')], {
      cwd: ROOT, detached: false
    });
  }
  // (Legacy spawn below replaced — kept signature for the rest of the function.)
  ;
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
import { suggestRoles, suggestKeywords } from './role-suggester.mjs';
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
/scrape, /daily, gm  → fresh jobs ranked by CV match
/batch [N]           → tap-friendly browser with Save/Applied/Why buttons
/save N              → bookmark job locally + on hiring.cafe (if /reauth'd)
/applied N           → mark applied locally + on hiring.cafe (if /reauth'd)
/saved [N]           → list locally-bookmarked jobs (paginated)
/why N               → explain why job N got its match %
/history [N]         → past applications (paginated)
/export              → apply-links list (.txt): number · title · link
/export csv          → same as a plain-text sheet (.csv)
/export xlsx         → Excel workbook with CLICKABLE apply links

<b>Settings — view + edit from your phone</b>
/settings            → current config in one message
/resume              → upload a new resume (PDF/DOCX/MD)
/jobs                → list current search titles
/jobs add &lt;title&gt;    → add a search title
/jobs remove &lt;title&gt; → remove a search title
/jobs suggest        → bot reads your CV and proposes new search terms
/jobs mode titles|keywords → suggest full titles or short keywords (iam, m365)
/yoe N               → set max years of experience
/salary N            → set salary floor in $K (e.g. /salary 120)
/floor N             → minimum match-% to include in batch (default 25)
/batchsize N         → strong matches per batch: 50, 100, 150, or 200 (default 200)
/clearance on/off    → toggle gov clearance filter
/forms all/simple/long → application form filter (Easy Apply etc.)
/skip &lt;company&gt;      → never show this company again
/unskip &lt;company&gt;    → reverse it
/city &lt;name&gt;         → change weather city
/schedule HH:MM      → change daily push time

<b>Profiles</b>
/profile list        → list profiles, mark active
/profile add &lt;slug&gt;  → new profile (clones active config)
/profile switch &lt;slug&gt; → switch active profile
/profile delete &lt;slug&gt; → remove (not active, not last)

<b>Maintenance</b>
/status              → bot uptime, last batch, last poll, version, task state
/diagnose            → why am I getting only N jobs? per-query supply + funnel
/auth                → check hiring.cafe sign-in (optional; only needed for hiring.cafe-side bookmarking)
/reauth              → opt-in: sign into hiring.cafe so /save and /applied also click their buttons
/pause /resume-bot   → stop/start the 7am push
/forget all          → wipe seen-jobs memory
/forget last         → un-memorize most recent batch
/weather             → Miami weather
/version             → show running version
/update              → pull latest from GitHub + restart
/update skip         → skip notifications about the latest version
/test, /ping         → bot health check
/uninstall           → pause or wipe — confirmation via inline buttons
/help                → this message`;

// Latest batch TSV → array of { idx, id, title, company, yoe, q, url }
function loadLatestBatch() {
  const dir = profilePaths().dir;
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => /^today-batch-\d{4}-\d{2}-\d{2}\.tsv$/.test(f)).sort();
  if (!files.length) return null;
  const latest = files[files.length - 1];
  const txt = fs.readFileSync(path.join(dir, latest), 'utf8');
  const rows = txt.trim().split('\n').map(l => {
    const [idx, id, title, company, yoe, q, url] = l.split('\t');
    return { idx: parseInt(idx), id, title, company, yoe, q, url, viewjobUrl: 'https://hiring.cafe/job/' + id };
  });
  return { file: latest, rows };
}

async function spawnAction(action, jobUrl) {
  const args = jobUrl ? [path.join(ROOT, 'scripts', 'job-action.mjs'), action, jobUrl]
                       : [path.join(ROOT, 'scripts', 'job-action.mjs'), action];
  // process.execPath, not bare 'node' — survives stripped-PATH installs (v2.0).
  const r = await spawnWithTimeout(process.execPath, args, 60000);
  return { code: r.code, output: (r.output || '').trim(), timeout: r.timeout };
}

// Format a millisecond duration as a compact "5d 3h 12m" / "47m" / "8s" string.
function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

function fmtAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  return fmtDuration(ms) + ' ago';
}

// /status — bot health snapshot. Single screen, structured for fast scan.
async function buildStatusMessage() {
  const lines = [`<b>🤖 Status — v${VERSION}</b>`, ''];

  // Process uptime
  lines.push(`<b>Bot</b>`);
  lines.push(`  Uptime: ${fmtDuration(Date.now() - BOT_STARTED_AT)} (PID ${process.pid})`);

  // Heartbeat (should be very recent)
  let hb = null;
  try { hb = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8')); } catch {}
  if (hb) {
    lines.push(`  Last heartbeat: ${fmtAgo(hb.ts)}` + (hb.lastPollOk === false ? ` ⚠️ poll failing (${hb.consecutiveFailures || 0}× in a row)` : ''));
  }

  // Last successful batch
  let lastBatch = null;
  try { lastBatch = JSON.parse(fs.readFileSync(profilePaths().lastBatch, 'utf8')); } catch {}
  lines.push('');
  lines.push(`<b>Last batch</b>`);
  if (lastBatch) {
    lines.push(`  ${lastBatch.date} · ${lastBatch.jobs?.length || 0} jobs · ${fmtAgo(lastBatch.generatedAt)}`);
    if (lastBatch.funnel) {
      const f = lastBatch.funnel;
      lines.push(`  Funnel: raw=${f.raw} → kept=${f.keptAfterFilter} → fresh=${f.afterDedup} → sent=${f.sent}`);
      lines.push(`  Score: top=${f.topPct}% median=${f.medianPct}% bottom=${f.bottomPct}%`);
    }
  } else {
    lines.push(`  none yet`);
  }

  // Auth state
  let auth = null;
  try { auth = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'auth-state.json'), 'utf8')); } catch {}
  lines.push('');
  lines.push(`<b>Auth</b>`);
  if (auth) {
    lines.push(`  Last OK: ${fmtAgo(auth.lastAuthOK)}`);
    if (auth.lastAuthFail) lines.push(`  ⚠️ Last fail: ${fmtAgo(auth.lastAuthFail)}`);
  } else {
    lines.push(`  unknown — run /auth`);
  }

  // Running batch lock state
  lines.push('');
  lines.push(`<b>Activity</b>`);
  lines.push(`  Batch in progress: ${runningJob ? '✓ yes' : 'no'}`);

  // Scheduled tasks state — platform-aware via os-paths.
  let tasksLine;
  try {
    const exists = scheduledTaskExists('bot');
    tasksLine = exists ? `  munyun-bot: registered (${PLATFORM})` : `  munyun-bot: not registered`;
  } catch (e) {
    tasksLine = `  Scheduled tasks: query failed (${escHtml(e.message)})`;
  }
  lines.push(tasksLine);

  return lines.join('\n');
}

// /diagnose — "why am I getting only N jobs?" Surfaces supply-side health:
// last batch's funnel, per-query 7-day averages, seen-jobs size.
function buildDiagnoseMessage() {
  const lines = [`<b>🔬 Diagnose — supply pipeline</b>`, ''];

  // Funnel from last batch
  let lastBatch = null;
  try { lastBatch = JSON.parse(fs.readFileSync(profilePaths().lastBatch, 'utf8')); } catch {}
  lines.push(`<b>Last batch funnel</b>`);
  if (lastBatch?.funnel) {
    const f = lastBatch.funnel;
    lines.push(`  Date: ${lastBatch.date}`);
    lines.push(`  Raw cards scraped: ${f.raw}`);
    lines.push(`  Cross-source unique: ${f.uniqueBeforeFilter ?? f.raw} (-${f.droppedDuplicates || 0} duplicates)`);
    lines.push(`  After filters: ${f.keptAfterFilter} (${f.droppedClearance || 0} clearance, ${f.droppedManagement || 0} management/lead, ${f.droppedSales || 0} sales dropped)`);
    lines.push(`  After dedup: ${f.afterDedup} (-${f.keptAfterFilter - f.afterDedup} already seen / applied)`);
    lines.push(`  Descriptions: ${f.descriptionEvaluated || 0} evaluated, ${f.fullDescriptions ?? f.descriptionScored ?? 0} full${f.smartMatchEvaluated ? `, ${f.smartMatchEvaluated} Smart Match${f.smartMatchProvider ? ` (${escHtml(f.smartMatchProvider)})` : ''}` : ''}`);
    if (f.consultantSlopMode && f.consultantSlopMode !== 'off') {
      lines.push(`  Consultant Slop (${f.consultantSlopMode}): ${f.droppedConsultantSlop || 0} dropped (${f.consultantCustomerFacing || 0} customer-facing, ${f.consultantConsulting || 0} consulting, ${f.consultantTravelRequired || 0} travel)`);
    }
    lines.push(`  Strong matches: ${f.qualifyingMatches || 0} above ${f.matchFloorPercent || 0}%`);
    if (f.descriptionCeilingReached) lines.push(`  ⚠️ Description safety ceiling reached; ${f.unevaluatedCandidates || 0} candidates were not evaluated.`);
    else if ((f.sent || 0) < (f.targetJobsPerBatch || 0)) lines.push(`  All candidates were evaluated; no strong matches were held for tomorrow.`);
    lines.push(`  Sent to Telegram: ${f.sent}`);
    lines.push(`  Score band: ${f.bottomPct}% – ${f.topPct}% (median ${f.medianPct}%)`);
    if (f.afterDedup < 30) {
      lines.push(`  ⚠️ Below typical 50–80 fresh jobs. Try <code>/forget last</code> or expand <code>/jobs add</code>.`);
    }
  } else if (lastBatch) {
    lines.push(`  (older batch — funnel data added in v1.0; re-run /scrape)`);
  } else {
    lines.push(`  no batches yet — run /scrape`);
  }

  // Seen-jobs size — v1.0 E3 schema is { jobs: { url: { firstSeenAt, lastSeenAt } } }
  // with 60-day decay. Old v0.x flat `ids` array is auto-migrated by daily-batch
  // on first load; we read both shapes here for transitional safety.
  let seen = null;
  try { seen = JSON.parse(fs.readFileSync(profilePaths().seenJobs, 'utf8')); } catch {}
  lines.push('');
  lines.push(`<b>Seen-jobs memory</b>`);
  // Signed in + knob on → hiring.cafe hides Saved/Applied. Viewed stays visible
  // because AMM may inspect more descriptions than it delivers. The local
  // store is authoritative for delivered jobs. Knob off → account filtering
  // never runs regardless of sign-in state, so don't claim it does.
  const hcAuth = readHcafeAuthCache();
  const DEDUP_LINE = {
    account: `  Dedup: hiring.cafe Saved/Applied + local delivered-only memory`,
    'local-disabled': `  Dedup: local (account dedup disabled in settings)`,
    'signed-out': `  Dedup: local only — sign in to hiring.cafe from the dashboard (System page) to sync across devices`,
    unknown: `  Dedup: local (hiring.cafe sign-in status unknown — check the dashboard's System page)`,
  };
  lines.push(DEDUP_LINE[dedupMode({ authed: hcAuth.authed, enabled: accountDedupEnabled() })]);
  const jobCount = seen?.jobs ? Object.keys(seen.jobs).length
                  : (Array.isArray(seen?.ids) ? seen.ids.length : 0);
  if (jobCount > 0) {
    const fd = seen?.freshnessDays ?? 60;
    lines.push(`  Total: ${jobCount} jobs`);
    lines.push(`  Last updated: ${fmtAgo(seen.lastUpdated)}`);
    lines.push(`  Freshness window: ${fd} days (entries decay after; <code>/forget all</code> wipes immediately).`);
  } else {
    lines.push(`  empty`);
  }

  // Per-query 7-day averages
  let stats = null;
  try { stats = JSON.parse(fs.readFileSync(profilePaths().queryStats, 'utf8')); } catch {}
  lines.push('');
  lines.push(`<b>Per-query supply (7-day avg)</b>`);
  if (stats?.queries && Object.keys(stats.queries).length) {
    const rows = Object.entries(stats.queries).map(([term, slot]) => {
      const cards = (slot.history || []).map(h => h.cards);
      const avg = cards.length ? Math.round(cards.reduce((a, b) => a + b, 0) / cards.length) : 0;
      const recent = cards.slice(-3).join('/'); // last 3 days
      return { term, avg, recent, n: cards.length };
    });
    rows.sort((a, b) => a.avg - b.avg); // surface low-supply queries first
    for (const r of rows) {
      const flag = r.avg === 0 ? '⚠️ ' : (r.avg < 5 ? '· ' : '  ');
      lines.push(`${flag}${escHtml(r.term)}: avg ${r.avg}/day (last 3: ${r.recent || '—'})`);
    }
    const dryRuns = rows.filter(r => r.avg === 0 && r.n >= 3);
    if (dryRuns.length) {
      lines.push('');
      lines.push(`⚠️ <b>${dryRuns.length}</b> queries averaged 0 cards — likely typos or terms hiring.cafe doesn't index. Edit via <code>/jobs remove</code> + <code>/jobs add</code>.`);
    }
  } else {
    lines.push(`  no history yet — run /scrape a few times`);
  }

  return lines.join('\n');
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

  // /status — bot uptime, last batch, last poll, version, scheduled-task state.
  // The "is the bot alive and well?" command. Read by the user; structured
  // similarly by the watchdog.
  if (/^\/?status\b/.test(text)) {
    return reply(chatId, await buildStatusMessage());
  }

  // /diagnose — supply-side health: per-query 7-day averages, seen-jobs size,
  // last batch's funnel (raw → kept → afterDedup → scored). Answers
  // "why am I getting only N jobs?" directly.
  if (/^\/?diagnose\b/.test(text)) {
    return reply(chatId, buildDiagnoseMessage());
  }

  // /batch [N] — open the inline-button paginated browser for the latest batch.
  // v1.0 E4. Each page renders one job with [💾 Save] [✅ Applied] [❓ Why]
  // [🚫 Skip co] action buttons + ⬅️/➡️ navigation.
  const batchM = text.match(/^\/?batch(?:\s+(\d{1,3}))?\b/);
  if (batchM) {
    const page = batchM[1] ? parseInt(batchM[1], 10) : 1;
    return openBatchBrowser(chatId, page);
  }

  // /history [N] — paginated application history from data/applications.md.
  const histM = text.match(/^\/?history(?:\s+(\d{1,3}))?\b/);
  if (histM) {
    const page = histM[1] ? parseInt(histM[1], 10) : 1;
    return showHistory(chatId, page);
  }

  // /saved [N] — paginated list of locally-bookmarked jobs (saved.md).
  // v1.0.x: bookmarks are local-first now; hiring.cafe-side bookmarking
  // is opt-in via /reauth.
  const savedM = text.match(/^\/?saved(?:\s+(\d{1,3}))?\b/);
  if (savedM) {
    const page = savedM[1] ? parseInt(savedM[1], 10) : 1;
    return showSaved(chatId, page);
  }

  // /uninstall — v1.0 E6. Two modes (pause / wipe) selected via inline buttons.
  // Bot can't delete its own dir; for wipe mode, we send the final message,
  // spawn uninstall.mjs detached, then exit. The detached process does the
  // actual work after we're gone.
  if (/^\/?uninstall\b/.test(text)) {
    const reply_markup = {
      inline_keyboard: [
        [{ text: '⚠️ Pause only',     callback_data: makeNavCallback('uni', 1, TG_TOKEN) }],
        [{ text: '☠️ Wipe everything', callback_data: makeNavCallback('uni', 2, TG_TOKEN) }],
        [{ text: '✋ Cancel',          callback_data: makeNavCallback('uni', 0, TG_TOKEN) }]
      ]
    };
    return reply(chatId, [
      '<b>⚠️ Uninstall Automatic Munyun Machine</b>',
      '',
      '<b>Pause only</b> — stops the bot and unregisters scheduled tasks. Preserves <code>data/</code>, <code>config.json</code>, <code>.env</code>, browser session. Re-running setup brings everything back.',
      '',
      '<b>Wipe everything</b> — pause steps + delete <code>data/</code>, <code>config.json</code>, <code>.env</code>, browser session. Bot token is gone with .env; reinstalling means a fresh wizard run.',
      '',
      '<i>Install dir itself is not deleted — remove it by hand if you want the code gone too.</i>'
    ].join('\n'), { reply_markup });
  }

  // /profile  /profile list  /profile add <slug>  /profile switch <slug>  /profile delete <slug>
  // v1.0 E5: multi-profile support. One install, multiple personas. Each
  // profile has its own CV, queries, filters, and seen-jobs memory. Browser
  // session is shared (one hiring.cafe account).
  if (/^\/?profile\b/.test(text)) {
    const sub = text.match(/^\/?profile(?:\s+(list|add|switch|delete|rm)(?:\s+(\S+))?)?/i);
    const action = sub?.[1]?.toLowerCase();
    const slug = sub?.[2];

    if (!action || action === 'list') {
      const all = listProfiles();
      const active = getActiveProfile();
      const lines = [
        '<b>👤 Profiles</b>',
        '',
        ...all.map(s => `${s === active ? '✅' : '  '} <code>${escHtml(s)}</code>${s === active ? ' (active)' : ''}`),
        '',
        '<i>/profile add &lt;slug&gt; — add a new profile (clones active config)</i>',
        '<i>/profile switch &lt;slug&gt; — switch active</i>',
        '<i>/profile delete &lt;slug&gt; — remove (cannot delete active or only profile)</i>'
      ];
      return reply(chatId, lines.join('\n'));
    }
    if (action === 'add') {
      if (!slug) return reply(chatId, '<i>Usage: /profile add &lt;slug&gt;</i>');
      try {
        const r = addProfile(slug);
        return reply(chatId, `✅ Profile <code>${escHtml(r.slug)}</code> created (cloned from <code>${escHtml(r.clonedFrom)}</code>).\n<i>Run /profile switch ${escHtml(r.slug)} then /resume to upload a CV for this persona.</i>`);
      } catch (e) {
        return reply(chatId, '❌ ' + escHtml(e.message));
      }
    }
    if (action === 'switch') {
      if (!slug) return reply(chatId, '<i>Usage: /profile switch &lt;slug&gt;</i>');
      try {
        if (runningJob) {
          return reply(chatId, `⚠️ Batch in progress — switch will apply at next /scrape after this one finishes.`);
        }
        setActiveProfile(slug);
        return reply(chatId, `✅ Switched active profile to <code>${escHtml(slug)}</code>. Next /scrape uses this profile's CV + queries + filters.`);
      } catch (e) {
        return reply(chatId, '❌ ' + escHtml(e.message));
      }
    }
    if (action === 'delete' || action === 'rm') {
      if (!slug) return reply(chatId, '<i>Usage: /profile delete &lt;slug&gt;</i>');
      try {
        const r = deleteProfile(slug);
        return reply(chatId, `🗑️ Deleted profile <code>${escHtml(r.deleted)}</code>. Data dir kept for safety — wipe with <code>Remove-Item</code> if desired.`);
      } catch (e) {
        return reply(chatId, '❌ ' + escHtml(e.message));
      }
    }
    return reply(chatId, '<i>Unknown /profile action. Try /profile list.</i>');
  }

  if (/^\/?weather\b/.test(text)) {
    try { return reply(chatId, await getWeather()); }
    catch (e) { return reply(chatId, '❌ Weather fetch failed: ' + escHtml(e.message)); }
  }
  // /scrape (and aliases /daily, gm, morning, update) — run a fresh batch
  // NOTE: 'update' must NOT be an alias here — it shadowed the real /update
  // command (dispatch is first-match), which made self-update unreachable
  // from v0.5 until v2.0: typing /update silently ran a scrape instead.
  if (/^\/?(scrape|daily|gm|morning)\b/.test(text) && !/^\/?jobs\b/.test(text)) {
    return runDailyBatch(chatId);
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
    return reply(chatId, `❌ Not logged in. Run <code>${escHtml(LOGIN_HELPER_DOC)}</code> on the laptop to re-auth.`);
  }

  // /pause — disable scheduled batch (cross-platform via os-paths)
  if (/^\/?pause\b/.test(text)) {
    const r = disableScheduledTask('daily');
    if (r.ok) return reply(chatId, '⏸ Daily push paused. Use /resume-bot to re-enable.');
    return reply(chatId, `❌ Could not pause (exit ${r.code}).\n<pre>${escHtml((r.output || '').slice(0, 200))}</pre>`);
  }
  // /resume-bot — re-enable scheduled batch
  if (/^\/?resume[-_\s]?bot\b/.test(text)) {
    const r = enableScheduledTask('daily');
    if (r.ok) return reply(chatId, '▶️ Daily push re-enabled.');
    return reply(chatId, `❌ Could not resume (exit ${r.code}).\n<pre>${escHtml((r.output || '').slice(0, 200))}</pre>`);
  }
  // /reauth — spawn login-once on the user's machine. Cross-platform:
  // Chromium stays visible, but the Node launcher never needs a console.
  if (/^\/?reauth\b/.test(text)) {
    reply(chatId, '🔓 Opening Cloudflare warmup window on your computer. Wait for it to finish — no sign-in required.');
    if (IS_WIN32) {
      spawn(process.execPath, [path.join(ROOT, 'scripts', 'login-once.mjs')], {
        cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true
      }).unref();
    } else {
      spawn(process.execPath, [path.join(ROOT, 'scripts', 'login-once.mjs')], {
        cwd: ROOT, detached: true, stdio: 'ignore'
      }).unref();
    }
    return;
  }
  // /save N or /applied N — text-mode fallbacks. Both write locally first
  // (source of truth) then attempt hiring.cafe click as a best-effort.
  // Exit code 7 from job-action.mjs means "not signed in, skip silently."
  const actionMatch = text.match(/^\/?(save|applied)\s+(\d+)\b/);
  if (actionMatch) {
    const action = actionMatch[1];
    const n = parseInt(actionMatch[2]);
    const batch = loadLatestBatch();
    if (!batch) return reply(chatId, '❌ No batch on disk yet — run /daily first.');
    const job = batch.rows.find(r => r.idx === n);
    if (!job) return reply(chatId, `❌ Job #${n} not found in latest batch (${batch.rows.length} jobs in ${batch.file}).`);

    // Local write FIRST so the action persists regardless of hiring.cafe outcome.
    try {
      const line = `\n- ${new Date().toISOString().slice(0, 10)} — ${job.title} @ ${job.company} — ${job.viewjobUrl}\n`;
      const target = action === 'save' ? path.join(profilePaths().dir, 'saved.md') : profilePaths().applications;
      fs.appendFileSync(target, line);
    } catch (e) { log(`${action} local write failed: ` + e.message); }

    reply(chatId, `🔄 ${action === 'save' ? 'Bookmarking' : 'Marking applied'}: <b>${escHtml(job.title)}</b> @ ${escHtml(job.company)}…`);
    const { code, output } = await spawnAction(action, job.viewjobUrl);
    if (code === 0) return reply(chatId, `✅ ${action === 'save' ? 'Saved' : 'Applied'} locally + on hiring.cafe.`);
    if (code === 7) return reply(chatId, `✅ ${action === 'save' ? 'Saved' : 'Marked applied'} locally. <i>(Run /reauth to also act on hiring.cafe.)</i>`);
    return reply(chatId, `✅ ${action === 'save' ? 'Saved' : 'Marked applied'} locally. Hiring.cafe click failed (exit ${code}).\n<pre>${escHtml((output || '').slice(0, 300))}</pre>`);
  }

  // ===== v0.3 commands =====

  // Use raw message (preserves case for skip lists, jobs add, city names)
  const rawText = (msg.text || '').trim();

  // /settings — show current config
  if (/^\/?settings\b/.test(text)) {
    try {
      const cfg = cfgRW.read();
      const cv = (() => {
        try { return JSON.parse(fs.readFileSync(profilePaths().cvParsed, 'utf8')); }
        catch { return null; }
      })();
      const queries = cfg.queries || [];
      const skip = cfg.filters?.skipCompanies || [];
      const seen = (() => {
        try {
          const sj = JSON.parse(fs.readFileSync(profilePaths().seenJobs, 'utf8'));
          // v1.0 E3 schema: { jobs: { url: {...} } }; v0.x: { ids: [...] }
          if (sj.jobs) return Object.keys(sj.jobs).length;
          if (Array.isArray(sj.ids)) return sj.ids.length;
          return 0;
        } catch { return 0; }
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
        `<b>Suggest as:</b> ${cfg.search?.mode === 'keywords' ? 'keywords (broad)' : 'job titles (precise)'} — /jobs mode to switch`,
        '',
        `<b>Search terms (${queries.length}):</b>`,
        '  ' + queries.map(q => q.term).join(', '),
        '',
        skip.length ? `<b>Skip list (${skip.length}):</b> ${skip.join(', ')}` : '<b>Skip list:</b> empty',
        `<b>Memory:</b>     ${seen} jobs seen`,
        '',
        '<i>Edit any: /yoe N · /salary N · /clearance on/off · /forms all|simple|long · /city &lt;name&gt; · /schedule HH:MM · /skip · /unskip · /jobs · /resume · /forget</i>'
      ];
      return reply(chatId, lines.join('\n'));
    } catch (e) {
      return reply(chatId, '❌ Could not read settings: ' + escHtml(e.message));
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

  // /floor N — set minimum match-percent threshold (jobs below this are
  // delivered after full-description evaluation). v8.4 default 70; lower it to
  // include filler when supply is low; raise to 50+ to be picky.
  const floorM = text.match(/^\/?floor\s+(\d{1,3})\b/);
  if (floorM) {
    const n = Math.min(100, Math.max(0, parseInt(floorM[1])));
    cfgRW.set('scoring.matchFloorPercent', n);
    return reply(chatId, n === 0
      ? `✅ Match floor set to <b>0%</b> — every scored job will surface (filler included).`
      : `✅ Strong-match floor set to <b>${n}%</b>. AMM will keep checking descriptions until the batch is full or the candidate pool runs out.`);
  }

  // /batchsize N — v4.5: how many ranked jobs make the final batch. Snaps to
  // the nearest of 50/100/150/200 (same options as the dashboard). Bigger
  // batches resolve more apply-URL pages, so scrapes take longer.
  const bsM = text.match(/^\/?batch\s*size\s+(\d{1,4})\b/);
  if (bsM) {
    const n = clampBatchSize(parseInt(bsM[1]));
    cfgRW.set('scoring.targetJobsPerBatch', n);
    return reply(chatId, `✅ Batch size set to <b>${n} jobs</b>. Your next /scrape delivers up to ${n} (fewer if fresh supply runs out first).`);
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
    } catch (e) { return reply(chatId, '❌ Geocoding failed: ' + escHtml(e.message)); }
  }

  // /schedule HH:MM
  const schedM = text.match(/^\/?schedule\s+(\d{1,2}):(\d{2})\b/);
  if (schedM) {
    const hh = parseInt(schedM[1]), mm = parseInt(schedM[2]);
    if (hh > 23 || mm > 59) return reply(chatId, '❌ Invalid time. Use 24-hour HH:MM.');
    const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    cfgRW.set('schedule.time', time);
    // Re-register scheduled tasks on the host platform.
    let r;
    if (IS_WIN32) {
      r = await spawnWithTimeout(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'setup-tasks.ps1')], 30000);
    } else {
      const setupScript = IS_DARWIN
        ? path.join(ROOT, 'scripts', 'setup-tasks-mac.sh')
        : path.join(ROOT, 'scripts', 'setup-tasks-linux.sh');
      r = await spawnWithTimeout('bash', [setupScript], 30000);
    }
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
      // F-M13: non-Latin queries (e.g. /jobs add 中文工程师 or /jobs add !!!)
      // collapse to an empty key, and two empty keys collide silently in
      // results[key]. Fall back to a timestamp-based slug.
      const key = (term.replace(/[^a-z0-9]/gi, '').slice(0, 20)) || `q${Date.now().toString(36)}`;
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

    // /jobs mode [titles|keywords] — v2.0.3: what /jobs suggest proposes
    const modeM = text.match(/^\/?jobs\s+mode(?:\s+(titles?|keywords?))?\s*$/i);
    if (modeM) {
      const current = cfg.search?.mode === 'keywords' ? 'keywords' : 'titles';
      if (!modeM[1]) {
        return reply(chatId, [
          `🔎 Search-suggestion mode: <b>${current}</b>`,
          '',
          '<b>titles</b> — full job titles ("IAM Engineer"). Precise searches.',
          '<b>keywords</b> — short terms ("iam", "m365", "linux"). Broader nets; CV-match ranking + the match floor keep quality up.',
          '',
          'Switch: <code>/jobs mode titles</code> or <code>/jobs mode keywords</code>'
        ].join('\n'));
      }
      const mode = modeM[1].toLowerCase().startsWith('keyword') ? 'keywords' : 'titles';
      cfgRW.set('search.mode', mode);
      return reply(chatId, `✅ Search-suggestion mode: <b>${mode}</b>.\nRun <code>/jobs suggest</code> to get ${mode === 'keywords' ? 'short keyword' : 'job-title'} picks from your CV, then add the ones you like.`);
    }

    // /jobs suggest — proposes titles or keywords per config search.mode
    if (/^\/?jobs\s+suggest\b/i.test(text)) {
      try {
        const cv = JSON.parse(fs.readFileSync(profilePaths().cvParsed, 'utf8'));
        const mode = cfg.search?.mode === 'keywords' ? 'keywords' : 'titles';
        const suggestions = mode === 'keywords' ? suggestKeywords(cv, { max: 12 }) : suggestRoles(cv, { max: 12 });
        if (!suggestions.length) {
          return reply(chatId, '❌ No suggestions. Your CV may be too sparse — try /resume to upload a fuller version.');
        }
        const existing = new Set(queries.map(q => q.term.toLowerCase()));
        const fresh = suggestions.filter(s => !existing.has(s.title.toLowerCase()));
        if (!fresh.length) {
          return reply(chatId, '✅ Your search list already covers the strongest matches from your CV. Nothing new to suggest.');
        }
        const lines = [
          mode === 'keywords'
            ? '<b>💡 Suggested search keywords based on your CV:</b>'
            : '<b>💡 Suggested job titles based on your CV:</b>',
          '',
          ...fresh.map((s, i) => `${i + 1}. <b>${escHtml(s.title)}</b>\n   <i>${escHtml(s.cluster)} · ${s.signalsHit.slice(0, 4).map(escHtml).join(', ')}</i>`),
          '',
          mode === 'keywords'
            ? `Add any with: <code>/jobs add ${escHtml(fresh[0].title)}</code> · switch styles with <code>/jobs mode titles</code>`
            : 'Add any with: <code>/jobs add Title Here</code> · prefer broad nets? <code>/jobs mode keywords</code>'
        ];
        return reply(chatId, lines.join('\n'));
      } catch (e) {
        return reply(chatId, '❌ Could not load CV. Try /resume to upload one first.');
      }
    }

    // /jobs (list)
    if (!queries.length) return reply(chatId, '<i>No search titles yet. Add some with /jobs add &lt;title&gt;.</i>');
    const lines = [
      `<b>🔎 Search terms (${queries.length}):</b>`,
      '',
      ...queries.map((q, i) => `${i + 1}. ${escHtml(q.term)}`),
      '',
      '<i>/jobs add "term" · /jobs remove "term" · /jobs suggest · /jobs mode titles|keywords</i>'
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
      const last = JSON.parse(fs.readFileSync(profilePaths().lastBatch, 'utf8'));
      const job = last.jobs.find(j => j.idx === n);
      if (!job) return reply(chatId, `❌ Job #${n} not found in last batch (${last.jobs.length} jobs).`);
      const lines = [
        `<b>${job.matchPct}% match: ${escHtml(job.title)}</b>`,
        `<i>${escHtml(job.company)}</i>`,
        '',
        job.coveragePct != null ? `<b>Requirements covered:</b> ${job.coveragePct}% (${job.requirementCount || 0} recognized)` : '',
        job.rolePct != null ? `<b>Role fit:</b> ${job.rolePct}%` : '',
        `<b>Search query that found it:</b> ${escHtml(job.q)}`,
        (job.matched || []).length ? `<b>Resume evidence (${job.matched.length}):</b>\n${job.matched.map(escHtml).join(' · ')}` : '<i>No recognized resume evidence.</i>',
        (job.missing || []).length ? `<b>Missing requirements:</b> ${job.missing.map(escHtml).join(' · ')}` : '',
        '',
        `<a href="${escHtmlAttr(job.directUrl || job.viewjobUrl)}">Open job →</a>`
      ];
      return reply(chatId, lines.join('\n'));
    } catch {
      return reply(chatId, '❌ No batch data on disk. Run /scrape first.');
    }
  }

  // /forget all
  if (/^\/?forget\s+all\b/.test(text)) {
    // v4.3: /forget only clears the LOCAL store. When signed in (and the
    // account-dedup knob is on), hiring.cafe's account-side Viewed/Applied
    // memory still hides those jobs — say so.
    const hcNote = accountDedupEnabled() && readHcafeAuthCache().authed === true
      ? '\n<i>Note: your hiring.cafe account still remembers viewed/applied jobs — they may not reappear while signed in.</i>'
      : '';
    try {
      fs.unlinkSync(profilePaths().seenJobs);
      return reply(chatId, '🗑 Wiped seen-jobs memory. Next /scrape treats every job as fresh.' + hcNote);
    } catch {
      return reply(chatId, '<i>No memory to wipe — you\'re already at a clean slate.</i>' + hcNote);
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

    // Resolve git WITHOUT relying on PATH (v2.0) — stripped-PATH machines
    // are exactly the ones that need auto-update most.
    const GIT = gitCmd();
    if (!GIT) {
      return reply(chatId, `❌ Could not find git on this machine. Update manually:\n<code>cd ${escHtml(INSTALL_DIR_HINT)}; git pull origin main; npm install</code>`);
    }

    await reply(chatId, `🔄 Updating from v${info.current} to v${info.latest}…\n<i>Pulling latest from GitHub.</i>`);

    // Remember where we are so a failed update can roll back cleanly (v2.0).
    const headR = await spawnWithTimeout(GIT, ['rev-parse', 'HEAD'], 15000);
    const preUpdateCommit = headR.code === 0 ? (headR.output || '').trim() : null;
    const rollback = async () => {
      if (!preUpdateCommit) return false;
      const r = await spawnWithTimeout(GIT, ['reset', '--hard', preUpdateCommit], 30000);
      return r.code === 0;
    };

    const pullR = await spawnWithTimeout(GIT, ['pull', 'origin', 'main'], 60000);
    if (pullR.timeout) return reply(chatId, '❌ git pull timed out after 60s. Cancelling update.');
    if (pullR.code !== 0) {
      return reply(chatId, `❌ git pull failed (exit ${pullR.code}):\n<pre>${escHtml((pullR.output || '').slice(0, 800))}</pre>\n\n<i>Likely cause: uncommitted local changes. Update manually:\n<code>cd ${escHtml(INSTALL_DIR_HINT)}; git stash; git pull origin main; npm install</code></i>`);
    }

    await reply(chatId, '📦 <i>Installing dependencies…</i>');
    // Resolve npm absolutely via os-paths (handles Win32 stripped-PATH +
    // Mac/Linux PATH lookup uniformly).
    const npmR = await spawnWithTimeout(npmCmd(), ['install', '--no-audit', '--no-fund', '--loglevel=error'], 180000);
    if (npmR.timeout || npmR.code !== 0) {
      // v2.0: roll back instead of leaving new code with broken deps on
      // disk — the restarted bot would crash-loop on a missing import.
      const rolledBack = await rollback();
      const why = npmR.timeout ? 'npm install timed out after 3min' : `npm install failed (exit ${npmR.code})`;
      return reply(chatId, [
        `❌ ${why}:`,
        `<pre>${escHtml((npmR.output || '').slice(0, 600))}</pre>`,
        rolledBack
          ? `↩️ Rolled back to v${info.current} — the bot keeps running on the old version. Try /update again later.`
          : `⚠️ Could not roll back automatically. Run <code>git reset --hard</code> + <code>npm install</code> manually in ${escHtml(INSTALL_DIR_HINT)}.`
      ].join('\n'));
    }

    // Sanity check (v2.0): can the updated install actually load its deps?
    // Guards against "npm exited 0 but node_modules is broken" — a fresh
    // process import is the cheapest truthful probe.
    const depCheck = await spawnWithTimeout(process.execPath, ['-e',
      "Promise.all([import('playwright-core'),import('mammoth'),import('pdf-parse'),import('proper-lockfile')]).then(()=>process.exit(0),()=>process.exit(1))"
    ], 30000);
    if (depCheck.code !== 0) {
      const rolledBack = await rollback();
      return reply(chatId, rolledBack
        ? `❌ Updated dependencies failed to load — rolled back to v${info.current}. The bot keeps running on the old version.`
        : '❌ Updated dependencies failed to load and rollback also failed. Run <code>git reset --hard</code> + <code>npm install</code> manually.');
    }

    // Mark for the post-restart confirmation message
    markUpdating(info.current, info.latest);

    await reply(chatId, '👋 <b>Restarting bot to apply update…</b>\nBack online in ~10 seconds.');

    // Detached restarter: waits 4s for this bot to exit, then asks the
    // platform scheduler to start a fresh bot from the (now updated) code.
    // Cross-platform via os-paths.runScheduledTask — internally branches
    // schtasks (Win32) / launchctl kickstart (Mac) / systemctl --user start (Linux).
    if (IS_WIN32) {
      const TIMEOUT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'timeout.exe');
      const restartCmd = `"${TIMEOUT}" /t 4 /nobreak >nul && "${SCHTASKS}" /run /tn munyun-bot`;
      spawn(CMD_EXE, ['/c', restartCmd], {
        detached: true, stdio: 'ignore', windowsHide: true
      }).unref();
    } else {
      // POSIX: a tiny detached shell sleeps 4s then runs the scheduler call.
      // Shell-out is the simplest portable way to detach + sleep + invoke.
      const sleepThenStart = IS_DARWIN
        ? `sleep 4 && launchctl kickstart -k gui/$(id -u)/com.amm.bot`
        : `sleep 4 && systemctl --user start munyun-bot.service`;
      spawn('/bin/sh', ['-c', sleepThenStart], {
        detached: true, stdio: 'ignore'
      }).unref();
    }

    // Give Telegram ~1s to deliver the "restarting" message before we exit
    await new Promise(r => setTimeout(r, 1500));
    log('Bot exiting for update restart');
    process.exit(0);
  }

  // /export [txt|csv|xlsx] — minimal export of the latest batch: number ·
  // job title · apply link. txt (default) is a readable numbered list; csv
  // is a plain-text sheet; xlsx (v2.4.1) is a real Excel workbook whose
  // Apply Link column is native clickable hyperlinks (CSV structurally
  // can't carry links — it's plain text per RFC 4180).
  if (/^\/?export\b/.test(text)) {
    try {
      const fmt = /\b(xlsx|excel)\b/.test(text) ? 'xlsx' : /\bcsv\b/.test(text) ? 'csv' : 'txt';
      const r = loadExport(fmt);
      if (!r.ok) return reply(chatId, `<i>${escHtml(r.error)} Run /scrape first.</i>`);
      const outPath = path.join(profilePaths().dir, r.filename);
      // xlsx is binary and rides the export contract base64-encoded.
      if (fmt === 'xlsx') fs.writeFileSync(outPath, Buffer.from(r.contentBase64, 'base64'));
      else fs.writeFileSync(outPath, r.content);
      await tgSendDocument(chatId, outPath,
        `📄 ${r.filename} — ${r.count} jobs · number · title · apply link${fmt === 'txt' ? '\nClickable Excel links? /export xlsx' : ''}`);
      return;
    } catch (e) {
      return reply(chatId, '❌ Export failed: ' + escHtml(e.message));
    }
  }

  // /forget last — schema-aware (v1.0 E3 jobs map vs v0.x ids array)
  if (/^\/?forget\s+last\b/.test(text)) {
    try {
      const seenPath = profilePaths().seenJobs;
      const last = JSON.parse(fs.readFileSync(profilePaths().lastBatch, 'utf8'));
      const seen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
      const remove = new Set((last.jobs || []).map(j => j.viewjobUrl));
      let before = 0, after = 0;
      if (seen.jobs) {
        before = Object.keys(seen.jobs).length;
        for (const url of remove) delete seen.jobs[url];
        after = Object.keys(seen.jobs).length;
      } else if (Array.isArray(seen.ids)) {
        before = seen.ids.length;
        seen.ids = seen.ids.filter(id => !remove.has(id));
        after = seen.ids.length;
      }
      atomicWriteJson(seenPath, seen);
      const hcNote = accountDedupEnabled() && readHcafeAuthCache().authed === true
        ? '\n<i>Note: your hiring.cafe account still remembers viewed jobs — some may stay hidden while signed in.</i>'
        : '';
      return reply(chatId, `✅ Forgot ${before - after} jobs from the last batch. They'll come back next /scrape.` + hcNote);
    } catch (e) {
      return reply(chatId, '❌ ' + escHtml(e.message));
    }
  }

  return reply(chatId, `Unknown command. Try /help.`);
}

// =====================================================================
//  v1.0 E4 — Inline callback handling, paginated batch browser, /history
// =====================================================================

// Render one job page from the callbacks table. Returns {text, reply_markup}
// suitable for sendMessage or editMessageText.
function renderJobPage(idx, total, item, opts = {}) {
  const filter = opts.filter || 'all';
  const co = item.company || '<i>(no company)</i>';
  const yoe = (item.yoe !== null && item.yoe !== undefined) ? `${item.yoe}+ YOE · ` : '';
  const q = item.q ? `[${escHtml(item.q)}]` : '';
  const lines = [
    `<b>Job ${idx} / ${total}</b>${filter !== 'all' ? `  <i>(filter: ${filter})</i>` : ''}`,
    '',
    `<b>${escHtml(item.title || '(untitled)')}</b>`,
    `${escHtml(co)}  ·  ${item.matchPct}% match  ·  ${yoe}${q}`,
    '',
    item.directUrl ? `🔗 <a href="${escHtmlAttr(item.directUrl)}">Apply directly</a>` : '',
    `🔍 <a href="${escHtmlAttr(item.url)}">View on hiring.cafe</a>`
  ].filter(Boolean);

  // Action row
  const actionRow = [
    { text: '💾 Save',     callback_data: makeCallback('s', idx, item.url, TG_TOKEN) },
    { text: '✅ Applied',  callback_data: makeCallback('a', idx, item.url, TG_TOKEN) },
    { text: '❓ Why',      callback_data: makeCallback('w', idx, item.url, TG_TOKEN) },
    { text: '🚫 Skip co',  callback_data: makeCallback('k', idx, item.url, TG_TOKEN) }
  ];
  // Nav row
  const prevIdx = Math.max(1, idx - 1);
  const nextIdx = Math.min(total, idx + 1);
  const navRow = [
    { text: '⬅️',                 callback_data: makeNavCallback('b', prevIdx, TG_TOKEN) },
    { text: `${idx} / ${total}`,  callback_data: makeNavCallback('noop', 0, TG_TOKEN) },
    { text: '➡️',                 callback_data: makeNavCallback('b', nextIdx, TG_TOKEN) }
  ];

  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [actionRow, navRow] }
  };
}

async function openBatchBrowser(chatId, page = 1) {
  const tbl = readCallbackTable();
  if (!tbl || !tbl.items?.length) {
    return reply(chatId, '<i>No batch loaded. Run /scrape first.</i>');
  }
  if (tbl.expiresAt && new Date(tbl.expiresAt).getTime() < Date.now()) {
    return reply(chatId, '<i>Last batch expired (>7 days). Run /scrape for a fresh one.</i>');
  }
  const idx = Math.min(Math.max(1, page), tbl.items.length);
  const item = tbl.items.find(i => i.idx === idx) || tbl.items[0];
  const view = renderJobPage(item.idx, tbl.items.length, item);
  return reply(chatId, view.text, { reply_markup: view.reply_markup });
}

// Show /history — paginated list of jobs from applications.md, 5 per page
async function showHistory(chatId, page = 1) {
  const PAGE_SIZE = 5;
  let entries = [];
  try {
    const md = fs.readFileSync(profilePaths().applications, 'utf8');
    // Extract every job URL + the line above it (assume some metadata).
    // Accepts both legacy `/viewjob/` and current `/job/` paths.
    const lines = md.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/hiring\.cafe\/(?:viewjob|job)\/[a-z0-9]+/);
      if (m) entries.push({ url: 'https://' + m[0], context: lines.slice(Math.max(0, i - 1), i + 2).join(' · ').slice(0, 200) });
    }
  } catch {
    return reply(chatId, '<i>No applications.md yet. Use /applied N to start logging.</i>');
  }
  if (!entries.length) return reply(chatId, '<i>No applications logged yet.</i>');
  entries.reverse(); // newest first
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const slice = entries.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const lines = [`<b>📋 Application history</b>  (page ${p}/${totalPages}, ${entries.length} total)`, ''];
  for (const [i, e] of slice.entries()) {
    const num = (p - 1) * PAGE_SIZE + i + 1;
    lines.push(`<b>${num}.</b> <a href="${escHtmlAttr(e.url)}">${escHtml(e.url.replace('https://', ''))}</a>`);
    if (e.context) lines.push(`<i>${escHtml(e.context.slice(0, 120))}</i>`);
    lines.push('');
  }
  const navRow = [];
  if (p > 1)            navRow.push({ text: '⬅️',  callback_data: makeNavCallback('h', p - 1, TG_TOKEN) });
  navRow.push({ text: `${p}/${totalPages}`, callback_data: makeNavCallback('noop', 0, TG_TOKEN) });
  if (p < totalPages)   navRow.push({ text: '➡️',  callback_data: makeNavCallback('h', p + 1, TG_TOKEN) });
  return reply(chatId, lines.join('\n'), { reply_markup: { inline_keyboard: [navRow] } });
}

// Show /saved — paginated list of locally-bookmarked jobs (saved.md), 5 per page.
async function showSaved(chatId, page = 1) {
  const PAGE_SIZE = 5;
  const savedPath = path.join(profilePaths().dir, 'saved.md');
  let entries = [];
  try {
    const md = fs.readFileSync(savedPath, 'utf8');
    const lines = md.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/hiring\.cafe\/(?:viewjob|job)\/[a-z0-9]+/);
      if (m) entries.push({ url: 'https://' + m[0], context: lines[i].slice(0, 200) });
    }
  } catch {
    return reply(chatId, '<i>No saved jobs yet. Tap [💾 Save] in /batch or use /save N to bookmark.</i>');
  }
  if (!entries.length) return reply(chatId, '<i>No saved jobs yet.</i>');
  entries.reverse();
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, page), totalPages);
  const slice = entries.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const lines = [`<b>💾 Saved jobs</b>  (page ${p}/${totalPages}, ${entries.length} total)`, ''];
  for (const [i, e] of slice.entries()) {
    const num = (p - 1) * PAGE_SIZE + i + 1;
    lines.push(`<b>${num}.</b> <a href="${escHtmlAttr(e.url)}">${escHtml(e.url.replace('https://', ''))}</a>`);
    if (e.context) lines.push(`<i>${escHtml(e.context.slice(0, 120))}</i>`);
    lines.push('');
  }
  const navRow = [];
  if (p > 1)            navRow.push({ text: '⬅️',  callback_data: makeNavCallback('sv', p - 1, TG_TOKEN) });
  navRow.push({ text: `${p}/${totalPages}`, callback_data: makeNavCallback('noop', 0, TG_TOKEN) });
  if (p < totalPages)   navRow.push({ text: '➡️',  callback_data: makeNavCallback('sv', p + 1, TG_TOKEN) });
  return reply(chatId, lines.join('\n'), { reply_markup: { inline_keyboard: [navRow] } });
}

// Central callback dispatcher. Telegram fires this for every inline-button tap.
async function handleCallback(cq) {
  const chatId = String(cq.message?.chat?.id || cq.from?.id);
  if (chatId !== ALLOWED_CHAT) {
    return tgAnswerCallback(cq.id, 'Not authorized', true);
  }
  log(`< callback ${cq.data}`);

  const verified = parseAndVerify(cq.data, TG_TOKEN);
  if (!verified.ok) {
    if (verified.expired) {
      return tgAnswerCallback(cq.id, 'This batch has expired — run /scrape', true);
    }
    return tgAnswerCallback(cq.id, 'Invalid or stale button', true);
  }

  const { action, idx, item } = verified;

  // No-op (counter button)
  if (action === 'noop') return tgAnswerCallback(cq.id);

  // Batch browser navigation — edit the bubble in place
  if (action === 'b') {
    const tbl = readCallbackTable();
    if (!tbl) return tgAnswerCallback(cq.id, 'Batch not loaded', true);
    const target = tbl.items.find(i => i.idx === idx);
    if (!target) return tgAnswerCallback(cq.id, 'Job not found', true);
    const view = renderJobPage(idx, tbl.items.length, target);
    await tgEditMessage(chatId, cq.message.message_id, view.text, { reply_markup: view.reply_markup });
    return tgAnswerCallback(cq.id);
  }

  // History pagination
  if (action === 'h') {
    await tgAnswerCallback(cq.id);
    return showHistory(chatId, idx);
  }

  // Saved-jobs pagination (v1.0.x)
  if (action === 'sv') {
    await tgAnswerCallback(cq.id);
    return showSaved(chatId, idx);
  }

  // Diagnose shortcut
  if (action === 'diag') {
    await tgAnswerCallback(cq.id);
    return reply(chatId, buildDiagnoseMessage());
  }

  // /uninstall confirmation buttons (idx: 0=cancel, 1=pause, 2=wipe)
  if (action === 'uni') {
    if (idx === 0) {
      await tgAnswerCallback(cq.id, 'Cancelled');
      return reply(chatId, '✋ Uninstall cancelled. No changes made.');
    }
    const mode = idx === 1 ? 'pause' : 'wipe';
    await tgAnswerCallback(cq.id, mode === 'pause' ? 'Pausing…' : 'Wiping everything…');
    const finalMsg = mode === 'pause'
      ? `🛑 <b>Pausing.</b>\nBot exiting; scheduled tasks unregistering. Preserved: data/, config.json, .env. ${escHtml(RESTART_HINT_DOC)}.`
      : `☠️ <b>Wiping everything.</b>\nBot exiting. data/, config.json, .env, browser session will be deleted by the uninstall process.\n\n<i>Install dir at <code>${escHtml(ROOT)}</code> remains — delete by hand if you want the code gone.</i>`;
    await reply(chatId, finalMsg);
    // Spawn uninstall.mjs detached so it survives our exit.
    // process.execPath, not bare 'node' — survives stripped-PATH installs (v2.0).
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'uninstall.mjs'), `--mode=${mode}`], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT
    });
    child.unref();
    log(`Uninstall (${mode}) spawned PID=${child.pid}; bot exiting.`);
    // Give Telegram time to deliver the final message before we exit
    await new Promise(r => setTimeout(r, 1500));
    process.exit(0);
  }

  // Save / Applied / Why / Skip-company — all require resolved item
  if (!item) return tgAnswerCallback(cq.id, 'Job context missing — re-run /scrape', true);

  if (action === 's') {
    await tgAnswerCallback(cq.id, 'Saving…');
    // v1.0.x: always write to local saved.md first (source of truth for /saved).
    // Hiring.cafe click is best-effort — exit code 7 means "not signed in,
    // skip silently and report local-only success."
    const savedPath = path.join(profilePaths().dir, 'saved.md');
    try {
      const line = `\n- ${new Date().toISOString().slice(0, 10)} — ${item.title} @ ${item.company} — ${item.url}\n`;
      fs.appendFileSync(savedPath, line);
    } catch (e) { log('saved.md append failed: ' + e.message); }
    const { code, output, timeout } = await spawnAction('save', item.url);
    if (timeout) return reply(chatId, `💾 Saved locally for #${idx}; hiring.cafe click timed out (run <code>/reauth</code> to enable hiring.cafe-side bookmarking).`);
    if (code === 0) return reply(chatId, `💾 Saved <b>${escHtml(item.title || `job #${idx}`)}</b> locally and on hiring.cafe.`);
    if (code === 7) return reply(chatId, `💾 Saved <b>${escHtml(item.title || `job #${idx}`)}</b> locally. <i>(Run /reauth to also bookmark on hiring.cafe.)</i>`);
    return reply(chatId, `💾 Saved <b>${escHtml(item.title || `job #${idx}`)}</b> locally. Hiring.cafe click failed (exit ${code}); local record is what /saved reads.`);
  }

  if (action === 'a') {
    await tgAnswerCallback(cq.id, 'Marking applied…');
    // Always write to applications.md first (source of truth for /history).
    try {
      const line = `\n- ${new Date().toISOString().slice(0, 10)} — ${item.title} @ ${item.company} — ${item.url}\n`;
      fs.appendFileSync(profilePaths().applications, line);
    } catch (e) { log('applications.md append failed: ' + e.message); }
    try {
      await recordAppliedJob(profilePaths().appliedJobs, item, item.directUrl || item.url);
    } catch (e) { log('applied-jobs.json update failed: ' + e.message); }
    if (!/https:\/\/(?:www\.)?hiring\.cafe\/(?:viewjob|job)\//i.test(item.url || '')) {
      return reply(chatId, `✅ Marked applied: <b>${escHtml(item.title || `job #${idx}`)}</b> @ ${escHtml(item.company || '')} (locally).`);
    }
    const { code, output, timeout } = await spawnAction('applied', item.url);
    if (timeout) return reply(chatId, `✅ Logged applied locally for #${idx}; hiring.cafe click timed out.`);
    if (code === 0) return reply(chatId, `✅ Marked applied: <b>${escHtml(item.title || `job #${idx}`)}</b> @ ${escHtml(item.company || '')} (locally + on hiring.cafe).`);
    if (code === 7) return reply(chatId, `✅ Marked applied: <b>${escHtml(item.title || `job #${idx}`)}</b> @ ${escHtml(item.company || '')} (locally; <i>/reauth to also mark on hiring.cafe</i>).`);
    return reply(chatId, `✅ Logged applied locally. Hiring.cafe click failed (exit ${code}).`);
  }

  if (action === 'w') {
    await tgAnswerCallback(cq.id);
    // Reuse the existing /why N path by reading last-batch.json directly.
    try {
      const last = JSON.parse(fs.readFileSync(profilePaths().lastBatch, 'utf8'));
      const job = (last.jobs || []).find(j => j.idx === idx);
      if (!job) return reply(chatId, `<i>Couldn't find job #${idx} in last-batch.json. /scrape may have rotated.</i>`);
      const matched = (job.matched || []).slice(0, 30).map(escHtml).join(', ') || '<i>(no keyword matches)</i>';
      return reply(chatId, [
        `<b>Why job #${idx} matched ${job.matchPct}%</b>`,
        '',
        `<b>${escHtml(job.title || '')}</b> @ ${escHtml(job.company || '')}`,
        '',
        `<b>Resume evidence:</b> ${matched}`,
        job.coveragePct != null ? `<b>Requirements covered:</b> ${job.coveragePct}%` : '',
        job.rolePct != null ? `<b>Role fit:</b> ${job.rolePct}%` : ''
      ].join('\n'));
    } catch (e) {
      return reply(chatId, `❌ ${escHtml(e.message)}`);
    }
  }

  if (action === 'k') {
    if (!item.company) return tgAnswerCallback(cq.id, 'No company recorded for this job', true);
    await tgAnswerCallback(cq.id, `Skipping ${item.company}…`);
    cfgRW.appendUnique('filters.skipCompanies', item.company);
    return reply(chatId, `🚫 Added <b>${escHtml(item.company)}</b> to skip list. Future scrapes will ignore them.`);
  }

  return tgAnswerCallback(cq.id, `Unknown action: ${action}`, true);
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
      // Strip token from any thrown error message before re-raising. The
      // download URL embeds TG_TOKEN; a fetch-internal error with `cause`
      // chain can echo the URL.
      throw new Error('Network: ' + SCRUB(netErr.message || netErr));
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
    const safe = SCRUB(e.message || e);
    log('Resume upload failed: ' + safe);
    return reply(chatId, '❌ Resume upload failed: ' + escHtml(safe));
  }
}

function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Attribute-context escaper. Telegram HTML mode honors `"`-delimited href
// attributes but does NOT auto-escape `"` in text — meaning a hostile job
// posting could break out of href="…" and inject content. Apply this to
// every `href=` interpolation; escHtml stays for visible text.
function escHtmlAttr(s) { return escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

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

// Initial heartbeat so the watchdog sees us as alive before the first poll
// completes (Telegram long-poll can take up to 30s to return).
writeHeartbeat({ lastPollOk: null, consecutiveFailures: 0 });

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
let conflictNotified = false;

while (true) {
  try {
    const j = await tgGet('getUpdates', { offset, timeout: 30, allowed_updates: JSON.stringify(['message', 'callback_query']) });

    // Telegram answered but refused the poll. Without this check an
    // {ok:false} response (e.g. 409 Conflict from a second bot instance)
    // used to fall through the `if (j.ok …)` below and the loop re-polled
    // at full speed forever — burning CPU and looking exactly like a dead
    // bot. Treat it as a failure so the backoff applies.
    if (!j.ok) {
      if (j.error_code === 409) {
        log('poll 409 Conflict: another process is polling this bot token (second bot instance?)');
        // Notify once per process lifetime — with two pollers alternating,
        // resetting this on a successful poll would spam the chat.
        if (!conflictNotified) {
          conflictNotified = true;
          reply(ALLOWED_CHAT, '⚠️ <b>Another copy of the bot is running.</b>\nTwo pollers are fighting over this token — kill the extra process or restart the machine. I\'ll keep retrying.').catch(() => {});
        }
      }
      throw new Error(`getUpdates rejected: ${j.error_code} ${j.description || ''}`.trim());
    }

    // Heartbeat: tell the watchdog we're alive and Telegram-reachable.
    writeHeartbeat({ lastPollOk: true, consecutiveFailures: 0 });

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
        } else if (u.callback_query) {
          handleCallback(u.callback_query).catch(e => log('handleCallback error: ' + e.message));
        }
        offset = u.update_id + 1;
      }
      saveOffset(offset);
    }
  } catch (e) {
    consecutiveFailures++;
    if (consecutiveFailures === 1) outageStartedAt = Date.now();
    // Heartbeat even when polling failed — process is alive, network is the
    // issue. Watchdog should not restart us for a Telegram outage.
    writeHeartbeat({ lastPollOk: false, consecutiveFailures, lastPollError: String(e.message || e).slice(0, 200) });
    const delay = BACKOFF_MS[Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)];
    log(`poll error #${consecutiveFailures}: ${e.message} — backing off ${delay / 1000}s`);
    try {
      await new Promise(r => setTimeout(r, delay));
    } catch { /* setTimeout never rejects, but defensive */ }
  }
}
