// node --test scripts/__tests__/telegram-config.test.mjs
// v2.1: Telegram is optional. telegramConfigured() is the single source of
// truth for "is Telegram on" — daily-batch, the wizard, telegram-setup, and
// the Go wrapper all key off the same definition (token + chat present and
// well-shaped). Getting this wrong means either a token-less install tries
// to send (crash) or a configured install silently goes quiet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telegramConfigured, parseEnvText } from '../telegram-config.mjs';

test('valid token + chat → enabled', () => {
  assert.equal(telegramConfigured({
    TELEGRAM_BOT_TOKEN: '123456789:ABCdef-GHIjkl_MNOpqr',
    TELEGRAM_CHAT_ID: '987654321'
  }), true);
});

test('group chat id (negative) → enabled', () => {
  assert.equal(telegramConfigured({
    TELEGRAM_BOT_TOKEN: '123456789:ABCdef',
    TELEGRAM_CHAT_ID: '-1001234567890'
  }), true);
});

test('missing token → disabled', () => {
  assert.equal(telegramConfigured({ TELEGRAM_CHAT_ID: '987654321' }), false);
});

test('missing chat → disabled', () => {
  assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: '123:ABC' }), false);
});

test('empty object → disabled', () => {
  assert.equal(telegramConfigured({}), false);
  assert.equal(telegramConfigured(), false);
});

test('malformed token (no colon) → disabled', () => {
  assert.equal(telegramConfigured({
    TELEGRAM_BOT_TOKEN: 'not-a-real-token',
    TELEGRAM_CHAT_ID: '987654321'
  }), false);
});

test('non-numeric chat id → disabled', () => {
  assert.equal(telegramConfigured({
    TELEGRAM_BOT_TOKEN: '123:ABC',
    TELEGRAM_CHAT_ID: 'my-channel'
  }), false);
});

test('literal "undefined" chat id → disabled', () => {
  // The old bot stringified an undefined chat id to "undefined"; guard it.
  assert.equal(telegramConfigured({
    TELEGRAM_BOT_TOKEN: '123:ABC',
    TELEGRAM_CHAT_ID: 'undefined'
  }), false);
});

test('whitespace around values is tolerated', () => {
  assert.equal(telegramConfigured({
    TELEGRAM_BOT_TOKEN: '  123:ABC  ',
    TELEGRAM_CHAT_ID: '  42  '
  }), true);
});

test('parseEnvText round-trips through telegramConfigured', () => {
  const env = parseEnvText('# comment\nTELEGRAM_BOT_TOKEN=123:ABCdef\nTELEGRAM_CHAT_ID=42\n');
  assert.equal(telegramConfigured(env), true);
});

test('parseEnvText keeps = inside the token value', () => {
  const env = parseEnvText('TELEGRAM_BOT_TOKEN=123:ABC=def\n');
  assert.equal(env.TELEGRAM_BOT_TOKEN, '123:ABC=def');
});
