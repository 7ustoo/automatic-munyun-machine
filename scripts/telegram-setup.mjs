#!/usr/bin/env node
/**
 * Telegram setup helper for the desktop dashboard (v2.1).
 *
 * The dashboard's "Telegram (optional)" panel drives Telegram setup from the
 * GUI instead of the terminal wizard. The Go wrapper execs this script and
 * relays its single-line JSON output back to the page. All Telegram API talk
 * stays here in Node, where the patterns already live.
 *
 * Subcommands (each prints ONE line of JSON to stdout, exit 0):
 *   validate <token>          → { ok, username } | { ok:false, error }
 *   detect   <token>          → { ok, chatId, text } | { ok:false, error }
 *       Polls getUpdates briefly for a message the user just sent the bot,
 *       returns the chat id. Clears the update backlog first so only a NEW
 *       message counts.
 *   save     <token> <chatId> → { ok } | { ok:false, error }
 *       Writes TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID into .env.
 *   disable                   → { ok }
 *       Removes the two keys from .env (backs the old values up to
 *       .env.telegram-bak) so the bot stops and the dashboard takes over.
 *   status                    → { ok, enabled }
 *
 * Never throws to stderr in a way that leaks the token — output is scrubbed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegramConfigured, parseEnvText } from './telegram-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function scrub(s, token) {
  const str = String(s ?? '');
  return token ? str.split(token).join('<TOKEN>') : str;
}

function readEnv() {
  try { return parseEnvText(fs.readFileSync(ENV_PATH, 'utf8')); }
  catch { return {}; }
}

// Merge-write keys into .env, preserving unrelated lines.
function writeEnvKeys(vars) {
  let body = '';
  try { body = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}
  for (const [k, v] of Object.entries(vars)) {
    const rx = new RegExp(`^${k}=.*$`, 'm');
    if (rx.test(body)) body = body.replace(rx, `${k}=${v}`);
    else body += (body.endsWith('\n') || body === '' ? '' : '\n') + `${k}=${v}\n`;
  }
  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
  fs.writeFileSync(ENV_PATH, body);
}

async function validate(token) {
  if (!/^\d+:[\w-]+$/.test(token || '')) return out({ ok: false, error: 'That does not look like a bot token. It should look like 123456789:ABC…' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (j.ok) return out({ ok: true, username: j.result.username });
    return out({ ok: false, error: scrub(j.description || 'Telegram rejected the token', token) });
  } catch (e) {
    return out({ ok: false, error: scrub('Network error: ' + (e.message || e), token) });
  }
}

async function detect(token) {
  if (!/^\d+:[\w-]+$/.test(token || '')) return out({ ok: false, error: 'Validate the token first.' });
  // Clear backlog so only a NEW message counts (mirrors wizard step 2).
  try { await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1`, { signal: AbortSignal.timeout(10000) }); } catch {}
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=10`, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (j.ok && j.result.length) {
        const msg = j.result[j.result.length - 1].message;
        if (msg && msg.chat && msg.chat.id) {
          return out({ ok: true, chatId: String(msg.chat.id), text: (msg.text || '').slice(0, 40) });
        }
      }
    } catch { /* keep polling until deadline */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  return out({ ok: false, error: 'Did not receive a message in time. Send your bot any message, then click Detect again.' });
}

async function save(token, chatId) {
  if (!telegramConfigured({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId })) {
    return out({ ok: false, error: 'Token or chat id looks invalid — re-check both.' });
  }
  // Confirm the pair actually works before persisting.
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '✅ Telegram connected from the AMM dashboard. You\'ll get job batches here.' }),
      signal: AbortSignal.timeout(15000)
    });
    const j = await r.json();
    if (!j.ok) return out({ ok: false, error: scrub(j.description || 'Telegram rejected the chat id', token) });
  } catch (e) {
    return out({ ok: false, error: scrub('Network error: ' + (e.message || e), token) });
  }
  writeEnvKeys({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId });
  return out({ ok: true });
}

function disable() {
  let body = '';
  try { body = fs.readFileSync(ENV_PATH, 'utf8'); } catch { return out({ ok: true }); }
  const env = parseEnvText(body);
  // Back up the old values so re-enabling is a one-click (the dashboard can
  // offer "reconnect" later); then strip them from the live .env.
  if (env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID) {
    try {
      fs.writeFileSync(ENV_PATH + '.telegram-bak',
        `TELEGRAM_BOT_TOKEN=${env.TELEGRAM_BOT_TOKEN || ''}\nTELEGRAM_CHAT_ID=${env.TELEGRAM_CHAT_ID || ''}\n`);
    } catch {}
  }
  const stripped = body.split('\n')
    .filter(l => !/^\s*TELEGRAM_BOT_TOKEN=/.test(l) && !/^\s*TELEGRAM_CHAT_ID=/.test(l))
    .join('\n');
  fs.writeFileSync(ENV_PATH, stripped);
  return out({ ok: true });
}

const [, , cmd, a, b] = process.argv;
(async () => {
  switch (cmd) {
    case 'validate': return validate(a);
    case 'detect':   return detect(a);
    case 'save':     return save(a, b);
    case 'disable':  return disable();
    case 'status':   return out({ ok: true, enabled: telegramConfigured(readEnv()) });
    default:
      out({ ok: false, error: 'usage: telegram-setup.mjs <validate|detect|save|disable|status> [args]' });
      process.exit(2);
  }
})().catch(e => { out({ ok: false, error: scrub(e.message || e, a) }); process.exit(1); });
