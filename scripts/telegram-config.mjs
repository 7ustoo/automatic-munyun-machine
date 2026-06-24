#!/usr/bin/env node
/**
 * Telegram on/off state (v2.1).
 *
 * As of v2.1 Telegram is OPTIONAL — the desktop dashboard is the primary
 * surface. "Telegram is enabled" means, simply, that a usable bot token AND
 * chat id are present in .env. Setup writes them (wizard or the dashboard's
 * Telegram panel); the dashboard's Disable button clears them.
 *
 * Single source of truth so daily-batch.mjs, telegram-bot.mjs, the wizard,
 * and the Go wrapper all agree on what "enabled" means. Pure — pass it the
 * parsed env object; no disk access here.
 */

// True iff env has a plausibly-valid bot token + a chat id.
// Token shape is `<digits>:<rest>` (BotFather format); chat id is digits
// (optionally leading '-' for groups).
export function telegramConfigured(env = {}) {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = (env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chat || chat === 'undefined') return false;
  if (!/^\d+:[\w-]+$/.test(token)) return false;
  if (!/^-?\d+$/.test(chat)) return false;
  return true;
}

// Parse a .env file body into a flat object. (The v1.x scripts each inline
// this; kept here so the v2.1 Telegram code has one tested copy.)
export function parseEnvText(text) {
  return Object.fromEntries(
    String(text || '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}
