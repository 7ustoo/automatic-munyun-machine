#!/usr/bin/env node
/**
 * Gmail OAuth for the desktop app (v4.4).
 *
 * Uses Google's installed-app authorization-code flow with PKCE and a
 * loopback redirect owned by the Go dashboard. Only gmail.send + basic
 * identity are requested; AMM cannot read or delete mailbox contents.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './io-helpers.mjs';
import { parseEnvText } from './telegram-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.AMM_DATA_DIR || path.join(ROOT, 'data');
const CLIENT_PATH = path.join(__dirname, 'google-oauth-client.json');
export const TOKEN_PATH = path.join(DATA_DIR, 'gmail-oauth.json');
export const PENDING_PATH = path.join(DATA_DIR, 'gmail-oauth-pending.json');
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

function readEnv() {
  try { return parseEnvText(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); }
  catch { return {}; }
}

export function oauthClientConfig(env = readEnv()) {
  let bundled = {};
  try { bundled = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8')); } catch {}
  return {
    clientId: String(env.GOOGLE_OAUTH_CLIENT_ID || bundled.clientId || '').trim(),
    clientSecret: String(env.GOOGLE_OAUTH_CLIENT_SECRET || bundled.clientSecret || '').trim()
  };
}

export function oauthAvailable(env) {
  return !!oauthClientConfig(env).clientId;
}

function secureWrite(file, value) {
  atomicWriteJson(file, value);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs are inherited */ }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function requireLoopbackRedirect(redirectUri) {
  const u = new URL(String(redirectUri || ''));
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) {
    throw new Error('OAuth redirect must use the local AMM dashboard.');
  }
  return u.toString();
}

export function beginOAuth({ redirectUri, to = '', subject = '', autoSend = false, env, now = Date.now } = {}) {
  const { clientId } = oauthClientConfig(env);
  if (!clientId) throw new Error('Google connection is not configured in this AMM build. Use Advanced email setup for now.');
  const redirect = requireLoopbackRedirect(redirectUri);
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  secureWrite(PENDING_PATH, {
    state, verifier, redirectUri: redirect,
    to: String(to || '').trim(), subject: String(subject || '').trim(), autoSend: !!autoSend,
    createdAt: new Date(now()).toISOString()
  });
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: `openid email ${GMAIL_SEND_SCOPE}`,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  }).toString();
  return { authUrl: u.toString(), state };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function jsonFetch(url, options, fetchImpl = fetch) {
  const r = await fetchImpl(url, options);
  let body = null;
  try { body = await r.json(); } catch {}
  if (!r.ok) throw new Error(body?.error_description || body?.error?.message || `Google request failed (${r.status})`);
  return body || {};
}

export async function completeOAuth({ code, state, redirectUri, env, fetchImpl = fetch, now = Date.now } = {}) {
  const pending = readJson(PENDING_PATH);
  if (!pending || !pending.state || pending.state !== String(state || '')) throw new Error('Google connection expired or state did not match. Start again.');
  if (Date.parse(pending.createdAt) < now() - 10 * 60 * 1000) throw new Error('Google connection expired. Start again.');
  const redirect = requireLoopbackRedirect(redirectUri);
  if (redirect !== pending.redirectUri) throw new Error('Google callback returned to a different dashboard address.');
  const { clientId, clientSecret } = oauthClientConfig(env);
  if (!clientId) throw new Error('Google connection is not configured in this AMM build.');
  const form = new URLSearchParams({
    client_id: clientId,
    code: String(code || ''),
    code_verifier: pending.verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirect
  });
  if (clientSecret) form.set('client_secret', clientSecret);
  const tokens = await jsonFetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
  }, fetchImpl);
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('Google did not return a reusable authorization. Revoke AMM and connect again.');
  const identity = await jsonFetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  }, fetchImpl);
  const email = String(identity.email || '').trim();
  if (!email) throw new Error('Google did not return the connected email address.');
  secureWrite(TOKEN_PATH, {
    provider: 'gmail-oauth', email,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000,
    scope: tokens.scope || GMAIL_SEND_SCOPE,
    connectedAt: new Date(now()).toISOString()
  });
  try { fs.unlinkSync(PENDING_PATH); } catch {}
  return { ok: true, email, to: pending.to, subject: pending.subject, autoSend: !!pending.autoSend };
}

export function oauthStatus() {
  const t = readJson(TOKEN_PATH);
  return t?.refreshToken && t?.email
    ? { connected: true, provider: 'gmail-oauth', email: t.email, connectedAt: t.connectedAt || null }
    : { connected: false, provider: null, email: '' };
}

export async function getAccessToken({ env, fetchImpl = fetch, now = Date.now } = {}) {
  const stored = readJson(TOKEN_PATH);
  if (!stored?.refreshToken) throw new Error('Gmail is not connected.');
  if (stored.accessToken && Number(stored.expiresAt) > now() + 60_000) return stored.accessToken;
  const { clientId, clientSecret } = oauthClientConfig(env);
  const form = new URLSearchParams({
    client_id: clientId,
    refresh_token: stored.refreshToken,
    grant_type: 'refresh_token'
  });
  if (clientSecret) form.set('client_secret', clientSecret);
  const tokens = await jsonFetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
  }, fetchImpl);
  stored.accessToken = tokens.access_token;
  stored.expiresAt = now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000;
  secureWrite(TOKEN_PATH, stored);
  return stored.accessToken;
}

function header(value) {
  const s = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
}

export function buildMimeMessage({ from, to, subject, text, attachments = [] }) {
  const boundary = `amm-${crypto.randomBytes(18).toString('hex')}`;
  const lines = [
    `From: ${header(from)}`, `To: ${header(to)}`, `Subject: ${header(subject)}`,
    'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(String(text || '')).toString('base64')
  ];
  for (const attachment of attachments) {
    const content = attachment.content != null ? Buffer.from(attachment.content) : fs.readFileSync(attachment.path);
    const filename = String(attachment.filename || path.basename(attachment.path || 'attachment')).replace(/["\r\n]/g, '_');
    lines.push('', `--${boundary}`, `Content-Type: application/octet-stream; name="${filename}"`,
      'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${filename}"`, '',
      content.toString('base64').replace(/.{1,76}/g, '$&\r\n').trim());
  }
  lines.push('', `--${boundary}--`, '');
  return lines.join('\r\n');
}

export async function sendGmail(message, { env, fetchImpl = fetch, now = Date.now } = {}) {
  const status = oauthStatus();
  if (!status.connected) throw new Error('Gmail is not connected.');
  const accessToken = await getAccessToken({ env, fetchImpl, now });
  const raw = Buffer.from(buildMimeMessage({ ...message, from: message.from || status.email })).toString('base64url');
  return jsonFetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  }, fetchImpl);
}

export function disconnectOAuth() {
  try { fs.unlinkSync(TOKEN_PATH); } catch {}
  try { fs.unlinkSync(PENDING_PATH); } catch {}
}
