#!/usr/bin/env node

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginOAuth, completeOAuth, sendGmail } from '../scripts/gmail-oauth.mjs';
import { atomicWriteJson } from '../scripts/io-helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULT_PATH = path.join(ROOT, 'data', 'gmail-live-e2e.json');
const toIndex = process.argv.indexOf('--to');
const to = toIndex >= 0 ? String(process.argv[toIndex + 1] || '').trim() : '';

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('Usage: node dev/live-gmail-e2e.mjs --to you@example.com');
  process.exit(2);
}

let settled = false;
const finish = (result, exitCode) => {
  if (settled) return;
  settled = true;
  atomicWriteJson(RESULT_PATH, { ...result, finishedAt: new Date().toISOString() });
  server.close(() => process.exit(exitCode));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== '/oauth/google/callback') {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    if (url.searchParams.get('error')) throw new Error(`Google authorization failed: ${url.searchParams.get('error')}`);
    const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/google/callback`;
    const connected = await completeOAuth({
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      redirectUri
    });
    const sent = await sendGmail({
      to,
      subject: '[AMM v4.4.1 E2E] Gmail OAuth verified',
      text: 'Automatic Munyun Machine completed a real Google OAuth consent, token exchange, and Gmail API send test successfully.'
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>AMM Gmail test passed</h1><p>The OAuth connection and real Gmail API send both succeeded. You can close this tab.</p>');
    finish({ ok: true, connectedEmail: connected.email, messageId: sent.id || null }, 0);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`AMM Gmail test failed: ${error.message}`);
    finish({ ok: false, error: error.message }, 1);
  }
});

server.listen(0, '127.0.0.1', () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/google/callback`;
  try {
    const started = beginOAuth({ redirectUri, to, subject: '[AMM v4.4.1 E2E] Gmail OAuth verified' });
    atomicWriteJson(RESULT_PATH, { ok: null, authUrl: started.authUrl, startedAt: new Date().toISOString() });
    console.log(`Open this URL to authorize the live Gmail test:\n${started.authUrl}`);
  } catch (error) {
    finish({ ok: false, error: error.message }, 1);
  }
});

setTimeout(() => finish({ ok: false, error: 'Timed out waiting for Google authorization.' }, 1), 10 * 60 * 1000).unref();
