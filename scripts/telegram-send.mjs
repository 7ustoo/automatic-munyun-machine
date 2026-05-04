#!/usr/bin/env node
// Send a Telegram message. Usage: node telegram-send.mjs "your message"
// Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from ../.env
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const token = env.TELEGRAM_BOT_TOKEN;
const chatId = env.TELEGRAM_CHAT_ID;
if (!token || !chatId) { console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env'); process.exit(1); }

const text = process.argv.slice(2).join(' ') || 'Test from career-ops daily batch.';

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
});
const json = await res.json();
if (!json.ok) { console.error('Telegram error:', json); process.exit(1); }
console.log('OK message_id=' + json.result.message_id);
