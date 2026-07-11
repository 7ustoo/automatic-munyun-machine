import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-gmail-oauth-'));
process.env.AMM_DATA_DIR = dataDir;
const oauth = await import('../gmail-oauth.mjs');
const env = { GOOGLE_OAUTH_CLIENT_ID: 'desktop-client.apps.googleusercontent.com' };

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('Google Desktop credential JSON is accepted without conversion', () => {
  assert.deepEqual(oauth.parseOAuthClientConfig({
    installed: {
      client_id: 'downloaded.apps.googleusercontent.com',
      client_secret: 'desktop-secret'
    }
  }), {
    clientId: 'downloaded.apps.googleusercontent.com',
    clientSecret: 'desktop-secret'
  });
});

test('beginOAuth creates a PKCE Google URL and pending state', () => {
  const started = oauth.beginOAuth({
    redirectUri: 'http://127.0.0.1:43210/oauth/google/callback',
    to: 'helper@example.com', subject: 'Jobs {DATE}', autoSend: true, env,
    now: () => Date.parse('2026-07-10T12:00:00Z')
  });
  const u = new URL(started.authUrl);
  assert.equal(u.hostname, 'accounts.google.com');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('scope'), /gmail\.send/);
  assert.equal(u.searchParams.get('state'), started.state);
  const pending = JSON.parse(fs.readFileSync(oauth.PENDING_PATH, 'utf8'));
  assert.equal(pending.to, 'helper@example.com');
  assert.equal(pending.autoSend, true);
  assert.ok(pending.verifier.length >= 43);
});

test('completeOAuth exchanges the code and stores the connected Google identity', async () => {
  const pending = JSON.parse(fs.readFileSync(oauth.PENDING_PATH, 'utf8'));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/token')) return response({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: oauth.GMAIL_SEND_SCOPE });
    return response({ email: 'owner@gmail.com' });
  };
  const result = await oauth.completeOAuth({
    code: 'auth-code', state: pending.state, redirectUri: pending.redirectUri,
    env, fetchImpl, now: () => Date.parse('2026-07-10T12:01:00Z')
  });
  assert.equal(result.email, 'owner@gmail.com');
  assert.equal(oauth.oauthStatus().connected, true);
  assert.equal(calls.length, 2);
});

test('sendGmail builds a MIME attachment and calls users.messages.send', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return response({ id: 'gmail-message-1' });
  };
  const result = await oauth.sendGmail({
    to: 'helper@example.com', subject: 'Daily jobs', text: 'Attached.',
    attachments: [{ filename: 'jobs.txt', content: 'job one' }]
  }, { env, fetchImpl, now: () => Date.parse('2026-07-10T12:02:00Z') });
  assert.equal(result.id, 'gmail-message-1');
  assert.match(request.url, /messages\/send$/);
  const raw = JSON.parse(request.options.body).raw;
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(mime, /Subject: Daily jobs/);
  assert.match(mime, /filename="jobs\.txt"/);
  assert.match(mime, /am9iIG9uZQ==/);
});

test('OAuth rejects non-loopback redirects', () => {
  assert.throws(() => oauth.beginOAuth({ redirectUri: 'https://evil.example/callback', env }), /local AMM dashboard/);
});
