#!/usr/bin/env node
/**
 * Email delivery (v4.3) — send the daily job batch .txt to a recipient
 * (e.g. a virtual assistant who applies on your behalf) through the user's
 * own Gmail over SMTP.
 *
 * This is the FOURTH delivery channel after hiring.cafe / open-meteo /
 * Telegram, and the first that talks SMTP. Credentials live in .env
 * (SMTP_USER / SMTP_APP_PASSWORD) exactly like the Telegram token — never in
 * config.json, never in logs. Gmail requires a 16-char App Password (with
 * 2-Step Verification on); a normal account password will be rejected.
 *
 * Pure/helper functions here; the GUI wiring (validate → save → send/disable)
 * lives in scripts/dashboard-api.mjs as email-* subcommands, and daily-batch
 * calls sendEmail() directly for the optional auto-send-each-morning path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { parseEnvText } from './telegram-config.mjs';
import { atomicWriteText } from './io-helpers.mjs';
import { oauthStatus, oauthAvailable, sendGmail, disconnectOAuth } from './gmail-oauth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

// Gmail SMTP over implicit TLS. Port 465/secure is the least-fiddly for
// app-password auth (587/STARTTLS also works but adds an upgrade step).
export const SMTP_HOST = 'smtp.gmail.com';
export const SMTP_PORT = 465;

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// --- .env credential read/write (mirrors telegram-setup.mjs) -----------------

export function readEmailEnv() {
  try { return parseEnvText(fs.readFileSync(ENV_PATH, 'utf8')); }
  catch { return {}; }
}

// True iff a usable Gmail address + app password are present. Shape-only —
// does not hit the network (see verifyLogin for that).
export function emailConfigured(env = {}) {
  const user = (env.SMTP_USER || '').trim();
  const pass = (env.SMTP_APP_PASSWORD || '').trim();
  if (!user || !pass) return false;
  if (!EMAIL_RX.test(user)) return false;
  return true;
}

export function emailDeliveryStatus(env = readEmailEnv()) {
  const oauth = oauthStatus();
  if (oauth.connected) return { connected: true, provider: 'gmail-oauth', email: oauth.email };
  if (emailConfigured(env)) return { connected: true, provider: 'smtp', email: String(env.SMTP_USER || '').trim() };
  return { connected: false, provider: null, email: '' };
}

export function emailDeliveryConfigured(env = readEmailEnv()) {
  return emailDeliveryStatus(env).connected;
}

export { oauthAvailable };

export function isEmailAddress(s) {
  return EMAIL_RX.test(String(s || '').trim());
}

// Never let the app password land in a log or a user-visible error string.
export function emailScrub(s, pass) {
  const str = String(s ?? '');
  return pass ? str.split(pass).join('<APP_PASSWORD>') : str;
}

// Merge-write SMTP keys into .env, preserving unrelated lines.
export function writeEmailEnv({ user, pass }) {
  let body = '';
  try { body = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}
  const vars = { SMTP_USER: user, SMTP_APP_PASSWORD: pass };
  for (const [k, v] of Object.entries(vars)) {
    const rx = new RegExp(`^${k}=.*$`, 'm');
    if (rx.test(body)) body = body.replace(rx, `${k}=${v}`);
    else body += (body.endsWith('\n') || body === '' ? '' : '\n') + `${k}=${v}\n`;
  }
  atomicWriteText(ENV_PATH, body);
}

// Strip SMTP keys from .env (backing them up to .env.email-bak first so a
// re-connect is easy). Mirrors the Telegram disable path.
export function disableEmailEnv() {
  let body = '';
  try { body = fs.readFileSync(ENV_PATH, 'utf8'); } catch { return; }
  const env = parseEnvText(body);
  if (env.SMTP_USER || env.SMTP_APP_PASSWORD) {
    try {
      atomicWriteText(ENV_PATH + '.email-bak',
        `SMTP_USER=${env.SMTP_USER || ''}\nSMTP_APP_PASSWORD=${env.SMTP_APP_PASSWORD || ''}\n`);
    } catch {}
  }
  const stripped = body.split('\n')
    .filter(l => !/^\s*SMTP_USER=/.test(l) && !/^\s*SMTP_APP_PASSWORD=/.test(l))
    .join('\n');
  atomicWriteText(ENV_PATH, stripped);
}

// --- sending -----------------------------------------------------------------

export function makeTransport(env) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: (env.SMTP_USER || '').trim(), pass: (env.SMTP_APP_PASSWORD || '').trim() },
  });
}

// Turn nodemailer/SMTP errors into something a non-technical user can act on.
// The most common case by far is a wrong/absent app password (EAUTH / 535).
export function friendlyError(e) {
  const code = e && (e.code || '');
  const rc = e && e.responseCode;
  if (code === 'EAUTH' || rc === 535 || rc === 534) {
    return 'Gmail rejected the sign-in. Turn on 2-Step Verification, then generate an App Password at myaccount.google.com/apppasswords and paste that 16-character password (not your normal Gmail password).';
  }
  if (code === 'EENVELOPE' || rc === 550 || rc === 553) {
    return 'Gmail rejected the recipient address — double-check the email you entered.';
  }
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ETIMEDOUT' || code === 'EDNS') {
    return 'Could not reach Gmail — check your internet connection and try again.';
  }
  return String((e && e.message) || e || 'Unknown email error');
}

// Confirm the credentials can actually log in to Gmail (no message sent).
export async function verifyLogin(env) {
  const t = makeTransport(env);
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: emailScrub(friendlyError(e), (env.SMTP_APP_PASSWORD || '').trim()) };
  } finally {
    try { t.close(); } catch {}
  }
}

// Send one message. Throws on failure (callers map/scrub). `attachments` is
// nodemailer's array form: [{ filename, path }] or [{ filename, content }].
export async function sendEmail({ env, to, from, subject, text, attachments }) {
  const t = makeTransport(env);
  try {
    return await t.sendMail({
      from: from || (env.SMTP_USER || '').trim(),
      to,
      subject,
      text,
      attachments: attachments || [],
    });
  } finally {
    try { t.close(); } catch {}
  }
}

// Preferred provider first: Gmail OAuth when connected, App Password SMTP as
// the backward-compatible advanced fallback.
export async function sendConfiguredEmail({ env = readEmailEnv(), to, from, subject, text, attachments }) {
  if (oauthStatus().connected) return sendGmail({ to, from, subject, text, attachments }, { env });
  if (emailConfigured(env)) return sendEmail({ env, to, from, subject, text, attachments });
  throw new Error('Email is not connected.');
}

export function disconnectEmail() {
  disconnectOAuth();
  disableEmailEnv();
}

// Expand the user's subject template. Only {DATE} is supported for now.
export function renderSubject(tpl, date) {
  const base = String(tpl || 'Job batch — {DATE}');
  return base.split('{DATE}').join(date || '').trim() || 'Job batch';
}
