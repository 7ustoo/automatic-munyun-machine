import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { detectBrowser, browserLaunchOptions } from '../browser-launcher.mjs';

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local'
};
const CHROME = path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
const EDGE = path.join('C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');

const existsOnly = (...paths) => (p) => paths.includes(p);

test('win32: installed Chrome wins', () => {
  const d = detectBrowser({ platform: 'win32', env: WIN_ENV, exists: existsOnly(CHROME, EDGE) });
  assert.deepEqual(d, { kind: 'channel', channel: 'chrome', label: 'installed Google Chrome' });
});

test('win32: Edge when Chrome absent (the every-Windows-machine fallback)', () => {
  const d = detectBrowser({ platform: 'win32', env: WIN_ENV, exists: existsOnly(EDGE) });
  assert.equal(d.kind, 'channel');
  assert.equal(d.channel, 'msedge');
});

test('win32: bundled Chromium as last resort', () => {
  const bundled = 'C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome.exe';
  const d = detectBrowser({ platform: 'win32', env: WIN_ENV, exists: existsOnly(bundled), bundledPath: bundled });
  assert.equal(d.kind, 'bundled');
});

test('nothing installed anywhere → null', () => {
  const d = detectBrowser({ platform: 'win32', env: WIN_ENV, exists: () => false, bundledPath: null });
  assert.equal(d, null);
});

test('config executablePath override wins over auto-detection', () => {
  const brave = 'C:\\Apps\\Brave\\brave.exe';
  const d = detectBrowser({
    platform: 'win32', env: WIN_ENV,
    exists: existsOnly(brave, CHROME),
    cfg: { executablePath: brave }
  });
  assert.equal(d.kind, 'executablePath');
  assert.equal(d.path, brave);
});

test('config executablePath that does not exist falls through to auto', () => {
  const d = detectBrowser({
    platform: 'win32', env: WIN_ENV,
    exists: existsOnly(CHROME),
    cfg: { executablePath: 'C:\\typo\\nope.exe' }
  });
  assert.equal(d.kind, 'channel');
  assert.equal(d.channel, 'chrome');
});

test('config channel forces even when nothing is detected', () => {
  const d = detectBrowser({ platform: 'win32', env: WIN_ENV, exists: () => false, cfg: { channel: 'msedge' } });
  assert.deepEqual(d, { kind: 'channel', channel: 'msedge', label: 'forced channel "msedge"' });
});

test('config channel "auto" behaves like no override', () => {
  const d = detectBrowser({ platform: 'win32', env: WIN_ENV, exists: existsOnly(CHROME), cfg: { channel: 'auto' } });
  assert.equal(d.channel, 'chrome');
});

test('darwin: Chrome.app detected', () => {
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const d = detectBrowser({ platform: 'darwin', env: {}, exists: existsOnly(mac) });
  assert.equal(d.channel, 'chrome');
});

test('linux: distro chromium uses executablePath (no channel name exists)', () => {
  const d = detectBrowser({ platform: 'linux', env: {}, exists: existsOnly('/usr/bin/chromium') });
  assert.equal(d.kind, 'executablePath');
  assert.equal(d.path, '/usr/bin/chromium');
});

test('browserLaunchOptions maps each kind correctly', () => {
  const IGN = ['--enable-automation'];
  assert.deepEqual(browserLaunchOptions({ kind: 'channel', channel: 'chrome' }), { ignoreDefaultArgs: IGN, channel: 'chrome' });
  assert.deepEqual(browserLaunchOptions({ kind: 'executablePath', path: '/x' }), { ignoreDefaultArgs: IGN, executablePath: '/x' });
  assert.deepEqual(browserLaunchOptions({ kind: 'bundled' }), { ignoreDefaultArgs: IGN });
  assert.deepEqual(browserLaunchOptions(null), { ignoreDefaultArgs: IGN });
});

// v7.8: the anti-bot regression. Cloudflare Turnstile loops forever when the
// browser self-identifies via --enable-automation, so EVERY launch (including
// the bundled-Chromium and null-detection fallbacks) must drop it.
test('browserLaunchOptions always drops --enable-automation (Cloudflare loop guard)', () => {
  for (const d of [{ kind: 'channel', channel: 'chrome' }, { kind: 'executablePath', path: '/x' }, { kind: 'bundled' }, null]) {
    assert.ok(browserLaunchOptions(d).ignoreDefaultArgs?.includes('--enable-automation'),
      `detection ${JSON.stringify(d)} must ignore --enable-automation`);
  }
});

// The returned array must be a fresh copy — a caller mutating it (or Playwright
// sorting it in place) must not poison the next launch.
test('browserLaunchOptions returns a fresh ignoreDefaultArgs array each call', () => {
  const a = browserLaunchOptions({ kind: 'bundled' });
  a.ignoreDefaultArgs.push('--mutated');
  assert.deepEqual(browserLaunchOptions({ kind: 'bundled' }).ignoreDefaultArgs, ['--enable-automation']);
});
