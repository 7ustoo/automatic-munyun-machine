#!/usr/bin/env node
/**
 * Long-running Telegram bot for career-ops.
 *
 * Polls Telegram getUpdates every 3 sec for new messages from your chat.
 * Dispatches commands:
 *   /daily, gm, morning   → run daily batch (weather + 100 jobs)
 *   /jobs                  → 100 jobs only, no weather
 *   /weather               → Miami weather only
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---------- env ----------
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT = String(env.TELEGRAM_CHAT_ID);

if (!TG_TOKEN || !ALLOWED_CHAT) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

// ---------- log ----------
const LOG = path.join(ROOT, 'data', 'telegram-bot.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
function log(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  fs.appendFileSync(LOG, msg + '\n');
}

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
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=25.7617&longitude=-80.1918&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=America/New_York';
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  const code = j.current.weather_code;
  return `${WMO_EMOJI[code] || '🌤'} Miami: ${Math.round(j.current.temperature_2m)}°F, ${WMO[code] || 'unknown'}, high ${Math.round(j.daily.temperature_2m_max[0])}° / low ${Math.round(j.daily.temperature_2m_min[0])}°`;
}

// ---------- run claude code ----------
let runningJob = null;

function runClaudeBatch(chatId) {
  if (runningJob) {
    return reply(chatId, '⏳ A scrape is already in progress — wait for it to finish.');
  }
  reply(chatId, '🔄 Scraping hiring.cafe… this takes 1–2 min. You\'ll get the batch when it\'s done.');
  log('Starting daily batch via run-daily-batch.cmd');
  const child = spawn('cmd.exe', ['/c', path.join(ROOT, 'scripts', 'run-daily-batch.cmd')], {
    cwd: ROOT,
    detached: false,
    windowsHide: true
  });
  runningJob = child;
  let stderr = '';
  child.stderr?.on('data', d => { stderr += d.toString(); });
  child.on('exit', (code) => {
    log(`run-daily-batch exit code=${code}`);
    runningJob = null;
    if (code !== 0) {
      reply(chatId, `❌ Batch failed (exit ${code}). Check data/telegram-bot.log.\n<pre>${stderr.slice(-500)}</pre>`);
    }
    // Success: the prompt itself sends the result to Telegram, no reply needed here.
  });
}

// ---------- dispatch ----------
const HELP_TEXT = `<b>🤖 Automatic Munyun Machine</b>

/daily, gm, morning  → weather + 100 jobs ranked by CV match
/weather             → Miami weather
/auth                → check hiring.cafe login state
/reauth              → trigger a re-login on your computer
/save N              → bookmark job #N from latest batch
/applied N           → mark job #N as applied
/pause               → stop the daily 7am push
/resume-bot          → re-enable the daily 7am push
/test, /ping         → bot health check
/help                → this message

Scrape takes 1-2 min.`;

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

function spawnAction(action, jobUrl) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(ROOT, 'scripts', 'job-action.mjs'), action, jobUrl], {
      cwd: ROOT,
      windowsHide: true
    });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stdout += d.toString(); });
    child.on('exit', code => resolve({ code, output: stdout.trim() }));
  });
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  if (chatId !== ALLOWED_CHAT) {
    log(`Ignored message from non-allowed chat ${chatId}`);
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
  if (/^\/?(daily|jobs|gm|morning|update)\b/.test(text)) {
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
    return new Promise((resolve) => {
      const c = spawn('powershell', ['-Command', "Disable-ScheduledTask -TaskName 'munyun-daily-batch'"], { windowsHide: true });
      c.on('exit', code => {
        reply(chatId, code === 0 ? '⏸ Daily 7am push paused. Use /resume-bot to re-enable.' : `❌ Could not pause (exit ${code}).`);
        resolve();
      });
    });
  }
  // /resume-bot — re-enable 7am push
  if (/^\/?resume[-_\s]?bot\b/.test(text)) {
    return new Promise((resolve) => {
      const c = spawn('powershell', ['-Command', "Enable-ScheduledTask -TaskName 'munyun-daily-batch'"], { windowsHide: true });
      c.on('exit', code => {
        reply(chatId, code === 0 ? '▶️ Daily 7am push re-enabled.' : `❌ Could not resume (exit ${code}).`);
        resolve();
      });
    });
  }
  // /reauth — spawn login-once.mjs on the user's machine
  if (/^\/?reauth\b/.test(text)) {
    reply(chatId, '🔓 Opening login window on your computer. Sign into hiring.cafe with Google, then close the window.');
    spawn('cmd.exe', ['/c', path.join(ROOT, 'scripts', 'login-once.cmd')], {
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

  return reply(chatId, `Unknown command. Try /help.`);
}

function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---------- main loop ----------
let offset = loadOffset();
log(`Bot starting. Offset=${offset}. Allowed chat=${ALLOWED_CHAT}.`);
reply(ALLOWED_CHAT, '🤖 <b>Automatic Munyun Machine</b> — online. /help for commands.').catch(e => log('Initial ping failed: ' + e.message));

while (true) {
  try {
    const j = await tgGet('getUpdates', { offset, timeout: 30, allowed_updates: JSON.stringify(['message']) });
    if (j.ok && j.result?.length) {
      for (const u of j.result) {
        if (u.message) {
          // Don't await — let messages dispatch in parallel (most are quick)
          handleMessage(u.message).catch(e => log('handleMessage error: ' + e.message));
        }
        offset = u.update_id + 1;
      }
      saveOffset(offset);
    }
  } catch (e) {
    log('poll error: ' + e.message);
    await new Promise(r => setTimeout(r, 5000));
  }
}
