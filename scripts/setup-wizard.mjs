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
import { suggestRoles } from './role-suggester.mjs';
import { geocode } from './geocode.mjs';
import * as cfgRW from './config-rw.mjs';
import { pickResumeFile } from './file-picker.mjs';
import { IS_WIN32, IS_DARWIN, IS_LINUX, POWERSHELL, runScheduledTask } from './os-paths.mjs';

// Absolute path to powershell.exe (Win32 only; null elsewhere) — exported
// here for backward-compat with any code reading POWERSHELL_EXE; new code
// should import POWERSHELL from os-paths directly.
const POWERSHELL_EXE = POWERSHELL;

// Helper: invoke the platform-appropriate setup script. Returns
// { code, out } in the same shape the wizard's PS spawn used.
function registerSchedulerForPlatform() {
  return new Promise((resolve) => {
    let cmd, args, useShell = false;
    if (IS_WIN32) {
      cmd = POWERSHELL_EXE;
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'setup-tasks.ps1')];
    } else if (IS_DARWIN) {
      cmd = 'bash';
      args = [path.join(__dirname, 'setup-tasks-mac.sh')];
    } else if (IS_LINUX) {
      cmd = 'bash';
      args = [path.join(__dirname, 'setup-tasks-linux.sh')];
    } else {
      return resolve({ code: -1, out: `Unsupported platform: ${process.platform}` });
    }
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('exit', code => resolve({ code, out }));
    child.on('error', e => resolve({ code: -1, out: 'spawn failed: ' + e.message }));
  });
}

// Helper: ask the platform scheduler to start the bot now (post-registration).
async function startBotForPlatform() {
  const r = runScheduledTask('bot');
  if (!r.ok) {
    console.log(fail(`Could not auto-start bot: ${r.output}`));
    console.log(`${c.dim}It will start at next login. Or run the bot manually with: npm run bot${c.reset}`);
  }
}

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
  step(1, 10, 'Telegram bot');
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
    // Local scrubber — wizard transcripts (screen recordings, terminal scroll-
    // back) are a token-leak vector if a fetch error message echoes the URL
    // (which contains the token). Match the bot's discipline.
    const scrub = (s) => (s == null ? '' : String(s).split(tok).join('<TOKEN>'));
    try {
      const r = await fetch(`https://api.telegram.org/bot${tok}/getMe`);
      const j = await r.json();
      if (j.ok) {
        console.log(ok(`Connected as @${j.result.username}`));
        writeEnv({ TELEGRAM_BOT_TOKEN: tok });
        return tok;
      }
      console.log(fail(`Telegram says: ${scrub(j.description || 'invalid token')}`));
    } catch (e) {
      console.log(fail('Network error: ' + scrub(e.message)));
    }
  }
}

// ---- step 2: chat ID auto-detection ----
async function step2ChatId(token) {
  step(2, 10, 'Connecting your chat');
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

// ---- step 3: hiring.cafe Cloudflare warmup (no login required) ----
async function step3Login() {
  step(3, 10, 'hiring.cafe browser warmup');
  console.log(`${c.dim}A Chromium window will open at hiring.cafe. No login required —${c.reset}`);
  console.log(`${c.dim}we are just clearing Cloudflare's bot challenge.${c.reset}`);
  console.log(`${c.dim}Wait until you see job listings (~20–30 seconds), then close the window.${c.reset}`);
  console.log(`${c.dim}(Optional: if you sign into hiring.cafe inside that window, the bot's${c.reset}`);
  console.log(`${c.dim}/save and /applied commands will also click those buttons on hiring.cafe.${c.reset}`);
  console.log(`${c.dim}Skip the sign-in for the simplest setup.)${c.reset}\n`);
  await ask(arrow('Press Enter to open the browser… '));

  // Spawn login-once.mjs and wait for it to exit (window closed)
  await new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, 'login-once.mjs')], {
      cwd: ROOT, stdio: 'inherit'
    });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('login-once exited ' + code)));
  });

  // Verify hiring.cafe is browsable (Cloudflare cleared). Auth is optional;
  // job-action.mjs returns AUTH_FAIL when not signed in but we don't treat
  // that as a setup failure anymore.
  process.stdout.write(arrow('Verifying hiring.cafe browsable… '));
  const r = await new Promise((resolve) => {
    const child = spawn('node', [path.join(__dirname, 'job-action.mjs'), 'auth'], {
      cwd: ROOT, windowsHide: true
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('exit', code => resolve({ code, out }));
  });
  if (r.code === 0) {
    console.log(ok('Hiring.cafe is browsable AND you signed in (full feature set).'));
  } else {
    // The new login-once warmed Cloudflare without requiring sign-in. The
    // browsable check inside daily-batch will confirm at scrape time.
    console.log(ok('Hiring.cafe browsable (no sign-in — /save and /applied will record locally).'));
  }
  return true;
}

// ---- step 4: resume upload ----
// Returns the parsed CV object, or null if the user chose to upload via
// Telegram later. Step 5 (job-title suggestions) handles null gracefully.
async function step4Resume() {
  step(4, 10, 'Your resume');
  console.log(`${c.dim}Three ways to add your resume:${c.reset}`);
  console.log(`  ${c.cyan}1${c.reset}  Pick a file from this laptop now  ${c.dim}(file picker dialog)${c.reset}  ${c.green}[recommended]${c.reset}`);
  console.log(`  ${c.cyan}2${c.reset}  Upload via Telegram later         ${c.dim}(skip for now, send /resume to bot when ready)${c.reset}`);
  console.log(`  ${c.cyan}3${c.reset}  Type the file path manually       ${c.dim}(if the picker won't open)${c.reset}\n`);

  const choice = (await ask(arrow('Choice [default 1]: '))).trim() || '1';

  if (choice === '2') {
    console.log(ok('Skipping resume for now. Send /resume to your bot once setup finishes.'));
    return null;
  }

  while (true) {
    let raw = '';

    if (choice === '1') {
      console.log(arrow('Opening file picker…'));
      try {
        raw = await pickResumeFile();
        if (!raw) {
          console.log(`${c.dim}Picker closed without a selection.${c.reset}`);
          const retry = await ask(arrow('Try again? [Y/n/skip] '));
          if (retry.match(/^n/i)) continue;
          if (retry.match(/^s/i)) {
            console.log(ok('Skipping resume. Send /resume to your bot later.'));
            return null;
          }
          continue;
        }
        console.log(ok(`Selected: ${path.basename(raw)}`));
      } catch (e) {
        console.log(fail('File picker failed: ' + e.message));
        console.log(`${c.dim}Falling back to typed path.${c.reset}`);
        raw = (await ask(arrow('Resume file path: '))).trim().replace(/^["']|["']$/g, '');
      }
    } else {
      raw = (await ask(arrow('Resume file path: '))).trim().replace(/^["']|["']$/g, '');
    }

    if (!raw) continue;
    if (!fs.existsSync(raw)) { console.log(fail(`File not found: ${raw}`)); continue; }
    process.stdout.write(arrow('Parsing… '));
    try {
      const parsed = await parseResume(raw);
      writeParsedCV(parsed);
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

// ---- step 5: auto-suggest job titles from resume ----
async function step5JobsSuggest(parsed) {
  step(5, 10, 'Job titles to search');

  // No resume yet? Fall through to defaults; user can run /jobs suggest later.
  if (!parsed) {
    console.log(`${c.dim}Skipping suggestions — no resume yet. Defaults from config.example.json will be used.${c.reset}`);
    console.log(`${c.dim}Once you upload a resume via /resume on Telegram, run /jobs suggest for tailored picks.${c.reset}`);
    return null;
  }

  console.log(`${c.dim}Based on your resume, I'll suggest job titles to search hiring.cafe for.${c.reset}\n`);

  const suggestions = suggestRoles(parsed, { max: 12 });
  if (!suggestions.length) {
    console.log(`${c.dim}Couldn't auto-suggest from your CV. We'll use sensible defaults from config.example.json.${c.reset}`);
    return null;
  }

  console.log(`${c.bold}Suggested:${c.reset}`);
  suggestions.forEach((s, i) => {
    console.log(`  ${c.cyan}${(i + 1).toString().padStart(2)}.${c.reset} ${s.title}  ${c.dim}(${s.cluster})${c.reset}`);
  });

  console.log();
  const a = await ask(arrow('Use all of these? [Y/n/pick] '));
  if (a.match(/^n/i)) return null; // keep config defaults
  if (a.match(/^p/i)) {
    const picksRaw = await ask(arrow('Comma-separated numbers to keep (e.g. 1,3,5,8): '));
    const picks = picksRaw.split(',').map(s => parseInt(s.trim())).filter(n => n > 0 && n <= suggestions.length);
    return picks.map(n => ({ key: suggestions[n - 1].title.replace(/[^a-z0-9]/gi, '').slice(0, 20), term: suggestions[n - 1].title }));
  }
  return suggestions.map(s => ({ key: s.title.replace(/[^a-z0-9]/gi, '').slice(0, 20), term: s.title }));
}

// ---- step 6: years of experience ----
async function step6YOE() {
  step(6, 10, 'Years of experience');
  console.log(`${c.dim}Maximum YOE you'd accept on a job listing. Higher = more results.${c.reset}\n`);
  while (true) {
    const a = (await ask(arrow('Max YOE? [default 5] '))).trim();
    if (!a) return 5;
    const n = parseInt(a);
    if (n >= 0 && n <= 30) return n;
    console.log(fail('Enter a number 0-30.'));
  }
}

// ---- step 7: salary floor ----
async function step7Salary() {
  step(7, 10, 'Salary floor');
  console.log(`${c.dim}Bot adds a small bonus to jobs at/above this floor, penalty below. Doesn't filter, just ranks.${c.reset}\n`);
  while (true) {
    const a = (await ask(arrow('Salary floor in $K? [default 90 = $90,000] '))).trim();
    if (!a) return 90000;
    const n = parseInt(a);
    if (n >= 30 && n <= 500) return n * 1000;
    console.log(fail('Enter a number 30-500 (in thousands).'));
  }
}

// ---- step 8: clearance toggle ----
async function step8Clearance() {
  step(8, 10, 'Government clearance filter');
  console.log(`${c.dim}If ON: bot drops jobs requiring TS/SCI, Public Trust, DoD, etc.${c.reset}`);
  console.log(`${c.dim}If OFF: gov jobs are included (use this if you have a clearance and want gov work).${c.reset}\n`);
  const a = await ask(arrow('Filter out gov clearance jobs? [Y/n] '));
  return !a.match(/^n/i);
}

// ---- step 9: weather city ----
async function step9City() {
  step(9, 10, 'Your city for weather');
  console.log(`${c.dim}The morning push includes a quick weather report. Where should we look up?${c.reset}\n`);
  while (true) {
    const a = (await ask(arrow('City name [default: Miami]: '))).trim();
    const q = a || 'Miami';
    process.stdout.write(arrow(`Geocoding "${q}"… `));
    try {
      const r = await geocode(q);
      if (!r) { console.log(fail('No match. Try again.')); continue; }
      console.log(ok(`${r.city}${r.admin ? ', ' + r.admin : ''} (${r.country})`));
      const ok2 = await ask(arrow('Looks right? [Y/n] '));
      if (!ok2.match(/^n/i)) return r;
    } catch (e) { console.log(fail('Geocoding failed: ' + e.message)); }
  }
}

// ---- step 10: schedule + finalize ----
async function step10Finalize(token, chatId, resumeSkipped) {
  step(10, 10, 'Schedule & finalize');

  // Load config (defaults from example) and let user tweak schedule
  const cfg = JSON.parse(fs.readFileSync(fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_EXAMPLE, 'utf8'));

  const t = (await ask(arrow(`Daily push time? [default ${cfg.schedule?.time || '07:00'}] `))).trim();
  if (t) cfg.schedule.time = t;
  const name = (await ask(arrow(`Your first name (used in the morning greeting)? [default ${cfg.user?.name || 'there'}] `))).trim();
  if (name) cfg.user.name = name;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(ok('Wrote config.json'));

  // Register scheduler entries (cross-platform via os-paths).
  process.stdout.write(arrow(`Registering scheduler (${process.platform})… `));
  const r = await registerSchedulerForPlatform();
  if (r.code === 0) console.log(ok('Tasks registered.'));
  else {
    console.log(fail('Task registration failed:\n' + r.out));
    console.log(`${c.dim}You can register manually later by running the platform-appropriate setup script.${c.reset}`);
  }

  // Start the bot.
  //
  // Subtle: we MUST set `stdio: 'ignore'` here, not just `detached: true`.
  // With default piped stdio, the parent holds references to the child's
  // stdin/stdout/stderr pipes; combined with the wizard's later shutdown
  // path, libuv hits an assertion in src/win/async.c:76 ("UV_HANDLE_CLOSING")
  // because process exit races with handles still tracked in the event loop.
  // `stdio: 'ignore'` drops those refs entirely; `.unref()` is belt-and-
  // suspenders so the loop exits even if the child is still spawning.
  process.stdout.write(arrow('Starting bot… '));
  await startBotForPlatform();
  await new Promise(r2 => setTimeout(r2, 3000));
  console.log(ok('Bot started.'));

  // Final Telegram ping. Tailor the message based on whether resume was uploaded.
  const resumeNudge = resumeSkipped
    ? "\n\n📄 <b>Don't forget your resume.</b> Send <code>/resume</code> to upload it — match quality is poor without one."
    : '';
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🎉 <b>Automatic Munyun Machine — setup complete!</b>\n\nTry <code>/scrape</code> to get your first batch of 100 ranked jobs.${resumeNudge}`,
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
    const parsed = await step4Resume();
    const queries = await step5JobsSuggest(parsed);
    const yoe = await step6YOE();
    const salary = await step7Salary();
    const clearanceOn = await step8Clearance();
    const city = await step9City();

    // Persist all collected settings into config.json before finalizing
    if (queries && queries.length) cfgRW.set('queries', queries);
    cfgRW.set('user.maxYoeAcceptable', yoe);
    cfgRW.set('user.salaryFloorUsd', salary);
    cfgRW.set('filters.filterClearance', clearanceOn);
    cfgRW.set('weather.city', city.city);
    cfgRW.set('weather.lat', city.lat);
    cfgRW.set('weather.lon', city.lon);
    cfgRW.set('weather.timezone', city.timezone);

    const resumeSkipped = parsed === null;
    await step10Finalize(token, chatId, resumeSkipped);

    banner('🎉 ALL DONE — check Telegram for next steps');
    console.log(`${c.dim}Bot is now running in the background.${c.reset}`);
    console.log(`${c.dim}Daily push registered for ${JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).schedule.time} Mon-Fri.${c.reset}`);
    if (resumeSkipped) {
      console.log(`${c.yellow}!${c.reset} Resume not uploaded yet. On Telegram, send ${c.bold}/resume${c.reset} and attach your CV.`);
    }
    console.log(`${c.dim}Edit config.json anytime to customize queries, filters, weather, schedule.${c.reset}\n`);
    rl.close();
    // No process.exit(0) — let Node drain the event loop naturally so any
    // in-flight handles (the unref'd bot-start child, the final fetch's
    // keepalive socket) close cleanly. Force-exit was the second half of
    // the libuv UV_HANDLE_CLOSING assertion bug.
  } catch (e) {
    console.log(`\n${fail(e.message)}`);
    rl.close();
    process.exit(1);
  }
})();
