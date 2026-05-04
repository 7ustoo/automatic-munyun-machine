#!/usr/bin/env node
/**
 * Automatic Munyun Machine — interactive setup wizard.
 *
 * Walks a new user through: Telegram bot, chat ID detection, hiring.cafe login,
 * resume upload, schedule + finalization. Run once after install.
 *
 * Idempotent — re-running it overwrites existing config / re-prompts each step.
 *
 * Usage: node scripts/setup-wizard.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseResume, writeParsedCV } from './resume-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CONFIG_EXAMPLE = path.join(ROOT, 'config.example.json');

// ANSI colors
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
};
const ok = (s) => `${c.green}✓${c.reset} ${s}`;
const fail = (s) => `${c.red}✗${c.reset} ${s}`;
const arrow = (s) => `${c.cyan}→${c.reset} ${s}`;

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

function banner(text) {
  const line = '═'.repeat(60);
  console.log(`\n${c.cyan}╔${line}╗${c.reset}`);
  console.log(`${c.cyan}║${c.reset}  ${c.bold}${text.padEnd(56)}${c.reset}${c.cyan}║${c.reset}`);
  console.log(`${c.cyan}╚${line}╝${c.reset}\n`);
}

function step(n, of, title) {
  console.log(`\n${c.magenta}── Step ${n} of ${of}: ${title} ──${c.reset}\n`);
}

// ---- env helpers ----
function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_PATH, 'utf8')
      .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}
function writeEnv(vars) {
  let body = '';
  if (fs.existsSync(ENV_PATH)) body = fs.readFileSync(ENV_PATH, 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    const rx = new RegExp(`^${k}=.*$`, 'm');
    if (rx.test(body)) body = body.replace(rx, `${k}=${v}`);
    else body += (body.endsWith('\n') ? '' : '\n') + `${k}=${v}\n`;
  }
  fs.writeFileSync(ENV_PATH, body);
}

// ---- step 1: Telegram bot token ----
async function step1Token() {
  step(1, 5, 'Telegram bot');
  const env = readEnv();
  if (env.TELEGRAM_BOT_TOKEN && /^\d+:[\w-]+$/.test(env.TELEGRAM_BOT_TOKEN)) {
    const a = await ask(arrow(`Existing bot token detected. Reuse it? [Y/n] `));
    if (!a.match(/^n/i)) return env.TELEGRAM_BOT_TOKEN;
  }

  console.log(`${c.dim}On your phone: open Telegram, search ${c.bold}@BotFather${c.reset}${c.dim}, send /newbot.${c.reset}`);
  console.log(`${c.dim}Choose any name and username. BotFather replies with a token.${c.reset}\n`);

  while (true) {
    const tok = (await ask(arrow('Paste bot token: '))).trim();
    if (!tok) continue;
    process.stdout.write(arrow('Validating… '));
    try {
      const r = await fetch(`https://api.telegram.org/bot${tok}/getMe`);
      const j = await r.json();
      if (j.ok) {
        console.log(ok(`Connected as @${j.result.username}`));
        writeEnv({ TELEGRAM_BOT_TOKEN: tok });
        return tok;
      }
      console.log(fail(`Telegram says: ${j.description || 'invalid token'}`));
    } catch (e) {
      console.log(fail('Network error: ' + e.message));
    }
  }
}

// ---- step 2: chat ID auto-detection ----
async function step2ChatId(token) {
  step(2, 5, 'Connecting your chat');
  const env = readEnv();
  if (env.TELEGRAM_CHAT_ID && /^\d+$/.test(env.TELEGRAM_CHAT_ID)) {
    const a = await ask(arrow(`Existing chat ID ${env.TELEGRAM_CHAT_ID}. Reuse it? [Y/n] `));
    if (!a.match(/^n/i)) return env.TELEGRAM_CHAT_ID;
  }

  console.log(`${c.dim}Open your bot in Telegram and send any message (e.g. "hi").${c.reset}`);
  console.log(`${c.dim}Listening for it now…${c.reset}\n`);

  // Clear any existing updates first so we capture only NEW messages
  await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1`).catch(() => {});

  const start = Date.now();
  const TIMEOUT_MS = 120000;
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=10`);
      const j = await r.json();
      if (j.ok && j.result.length) {
        const msg = j.result[0].message;
        if (msg && msg.chat && msg.chat.id) {
          const chatId = String(msg.chat.id);
          console.log(ok(`Got chat ID ${chatId} from your message: "${(msg.text || '').slice(0, 40)}"`));
          writeEnv({ TELEGRAM_CHAT_ID: chatId });
          // Send confirmation back
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: '✅ Setup wizard connected to this chat. Continuing setup on your computer…' })
          }).catch(() => {});
          return chatId;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timed out waiting for a Telegram message. Send any message to your bot and re-run setup.');
}

// ---- step 3: hiring.cafe login ----
async function step3Login() {
  step(3, 5, 'hiring.cafe login');
  console.log(`${c.dim}A Chromium window will open at hiring.cafe. Sign in with Google.${c.reset}`);
  console.log(`${c.dim}When you see your profile picture top-right, close the window.${c.reset}\n`);
  await ask(arrow('Press Enter to open the browser… '));

  // Spawn login-once.mjs and wait for it to exit (window closed)
  await new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, 'login-once.mjs')], {
      cwd: ROOT, stdio: 'inherit'
    });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('login-once exited ' + code)));
  });

  // Verify auth landed
  process.stdout.write(arrow('Verifying login… '));
  const r = await new Promise((resolve) => {
    const child = spawn('node', [path.join(__dirname, 'job-action.mjs'), 'auth'], {
      cwd: ROOT, windowsHide: true
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('exit', code => resolve({ code, out }));
  });
  if (r.code === 0) {
    console.log(ok('Logged in to hiring.cafe.'));
    return true;
  }
  console.log(fail('Could not verify login. You can re-run /reauth on the bot later.'));
  return false;
}

// ---- step 4: resume upload ----
async function step4Resume() {
  step(4, 5, 'Your resume');
  console.log(`${c.dim}Drop a path to your resume (PDF, DOCX, or Markdown).${c.reset}\n`);

  while (true) {
    const raw = (await ask(arrow('Resume file path: '))).trim().replace(/^["']|["']$/g, '');
    if (!raw) continue;
    if (!fs.existsSync(raw)) { console.log(fail(`File not found: ${raw}`)); continue; }
    process.stdout.write(arrow('Parsing… '));
    try {
      const parsed = await parseResume(raw);
      writeParsedCV(parsed);
      // Also copy a markdown copy into data/cv.md for posterity (optional)
      try {
        if (path.extname(raw).toLowerCase() === '.md') {
          fs.copyFileSync(raw, path.join(ROOT, 'data', 'cv.md'));
        }
      } catch {}
      console.log(ok(`${parsed.titles.length} titles · ${parsed.certs.length} certs · ${parsed.skills.length} skills · ${parsed.compliance.length} compliance frameworks`));
      const ok2 = await ask(arrow('Looks right? [Y/n] '));
      if (!ok2.match(/^n/i)) return parsed;
    } catch (e) {
      console.log(fail(e.message));
    }
  }
}

// ---- step 5: schedule + finalize ----
async function step5Finalize(token, chatId) {
  step(5, 5, 'Schedule & finalize');

  // Load config (defaults from example) and let user tweak schedule
  const cfg = JSON.parse(fs.readFileSync(fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_EXAMPLE, 'utf8'));

  const t = (await ask(arrow(`Daily push time? [default ${cfg.schedule?.time || '07:00'}] `))).trim();
  if (t) cfg.schedule.time = t;
  const name = (await ask(arrow(`Your first name (used in the morning greeting)? [default ${cfg.user?.name || 'there'}] `))).trim();
  if (name) cfg.user.name = name;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(ok('Wrote config.json'));

  // Register Task Scheduler entries
  process.stdout.write(arrow('Registering Windows Task Scheduler… '));
  const r = await new Promise((resolve) => {
    const child = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'setup-tasks.ps1')
    ], { cwd: ROOT, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('exit', code => resolve({ code, out }));
  });
  if (r.code === 0) console.log(ok('Tasks registered (daily 7am + bot autostart).'));
  else { console.log(fail('Task registration failed:\n' + r.out)); }

  // Start the bot
  process.stdout.write(arrow('Starting bot… '));
  spawn('powershell', ['-Command', "Start-ScheduledTask -TaskName 'munyun-bot'"],
    { cwd: ROOT, windowsHide: true, detached: true });
  await new Promise(r2 => setTimeout(r2, 3000));
  console.log(ok('Bot started.'));

  // Final Telegram ping
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: '🎉 <b>Automatic Munyun Machine — setup complete!</b>\n\nTry <code>/daily</code> to get your first batch of 100 ranked jobs.',
      parse_mode: 'HTML'
    })
  }).catch(() => {});
}

// ---- main ----
(async () => {
  banner('AUTOMATIC MUNYUN MACHINE — Setup Wizard');
  console.log(`${c.dim}This wizard takes ~90 seconds. Press Ctrl+C at any time to cancel.${c.reset}`);
  await ask(`\n${arrow('Press Enter to begin… ')}`);

  try {
    const token = await step1Token();
    const chatId = await step2ChatId(token);
    await step3Login();
    await step4Resume();
    await step5Finalize(token, chatId);

    banner('🎉 ALL DONE — check Telegram for next steps');
    console.log(`${c.dim}Bot is now running in the background.${c.reset}`);
    console.log(`${c.dim}Daily push registered for ${JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).schedule.time} Mon-Fri.${c.reset}`);
    console.log(`${c.dim}Edit config.json anytime to customize queries, filters, weather, schedule.${c.reset}\n`);
    rl.close();
    process.exit(0);
  } catch (e) {
    console.log(`\n${fail(e.message)}`);
    rl.close();
    process.exit(1);
  }
})();
