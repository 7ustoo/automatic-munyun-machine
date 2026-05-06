#!/usr/bin/env node
/**
 * Batch-missed watcher.
 *
 * Runs once per scheduled batch day, 1 hour AFTER the configured batch time,
 * via Task Scheduler entry `munyun-batch-missed`. If today's expected batch
 * file (data/today-batch-{date}.tsv) is missing, ping Telegram so the user
 * knows the morning batch didn't fire.
 *
 * Idempotent within a day: we record the alert in data/batch-missed-state.json
 * and don't re-alert for the same date.
 *
 * Why file-existence and not log parsing: the TSV is the truth — it's only
 * written on a successful batch. Log parsing is brittle and would need to
 * track partial successes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { migrateIfNeeded, paths as profilePaths } from './profile-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

migrateIfNeeded();
const DATA_DIR        = path.join(ROOT, 'data');
const STATE_FILE      = path.join(DATA_DIR, 'batch-missed-state.json'); // shared (one machine)
const TELEGRAM_SEND   = path.join(__dirname, 'telegram-send.mjs');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch { return {}; }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastAlertedDate: null }; }
}
function writeState(s) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch { /* ignore */ }
}

function alertTelegram(text) {
  try {
    spawnSync('node', [TELEGRAM_SEND, text], {
      stdio: 'ignore', timeout: 15000, windowsHide: true
    });
  } catch { /* ignore */ }
}

const cfg = loadConfig();
const today = new Date().toISOString().slice(0, 10);
const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
const scheduledDays = cfg.schedule?.days || ['Monday','Tuesday','Wednesday','Thursday','Friday'];

if (!scheduledDays.includes(dayName)) {
  // Not a scheduled day — silent exit.
  process.exit(0);
}

// v1.0 E5: TSV lives in the active profile's dir.
const tsv = path.join(profilePaths().dir, `today-batch-${today}.tsv`);
if (fs.existsSync(tsv)) {
  // Batch ran. Nothing to do.
  process.exit(0);
}

// Batch didn't run on a scheduled day. Alert once.
const state = readState();
if (state.lastAlertedDate === today) {
  // Already alerted today — don't double-ping.
  process.exit(0);
}

const scheduledTime = cfg.schedule?.time || '07:00';
alertTelegram(
  `⚠️ <b>Daily batch didn't run.</b>\n` +
  `Expected at ${scheduledTime} ${dayName} but no <code>today-batch-${today}.tsv</code> exists. ` +
  `Check Task Scheduler (<code>munyun-daily-batch</code>) and run <code>/scrape</code> from Telegram if you want today's jobs now.`
);

writeState({ ...state, lastAlertedDate: today, lastAlertedAt: new Date().toISOString() });
console.log(`Alerted: missed batch for ${today}`);
