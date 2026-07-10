// v4.0: static integrity contract for wrapper/dashboard.html — the checks
// that caught real bugs during the v3 rewrite, now pinned in CI. No browser
// needed. The full behavioral harness (stub wrapper + Playwright) lives in
// dev/dashboard-harness/ (run locally: npm run test:ui).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', '..', 'wrapper', 'dashboard.html'), 'utf8');

// ids created only at runtime by the modal system / empty state.
const DYNAMIC = new Set(['modal-overlay', 'modal', 'modal-input', 'modal-cancel', 'modal-ok', 'empty-scrape', 'empty-setup', 'empty-tour']);

test('every JS-referenced element id exists in the markup', () => {
  const defined = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const referenced = new Set([
    ...[...html.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]),
    ...[...html.matchAll(/getElementById\("([^"]+)"\)/g)].map(m => m[1]),
  ]);
  const missing = [...referenced].filter(id => !defined.has(id) && !DYNAMIC.has(id));
  assert.deepEqual(missing, [], 'missing ids: ' + missing.join(', '));
  assert.ok(referenced.size > 100, 'sanity: expected 100+ referenced ids');
});

test('no duplicate element ids', () => {
  const seen = new Set(); const dupes = [];
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
    if (seen.has(m[1])) dupes.push(m[1]);
    seen.add(m[1]);
  }
  assert.deepEqual(dupes, []);
});

test('CSRF placeholder appears exactly once', () => {
  assert.equal((html.match(/__AMM_TOKEN__/g) || []).length, 1);
});

test('every svg <use> points at a defined symbol', () => {
  const symbols = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));
  const bad = [...new Set([...html.matchAll(/href="#(i-[^"]+)"/g)].map(m => m[1]))].filter(u => !symbols.has(u));
  assert.deepEqual(bad, []);
});

test('page is fully offline — no external resources', () => {
  const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ext, []);
});

// v4.3: setup + tour entry points moved from the System view into the topbar
// so they're reachable from every view. Pin the new location and make sure
// the old System-card ids don't quietly come back.
test('onboarding entry points live in the topbar, not the System view', () => {
  const topbar = html.slice(html.indexOf('<header id="topbar">'), html.indexOf('</header>'));
  assert.ok(topbar.includes('id="top-setup-btn"'), 'top-setup-btn missing from topbar');
  assert.ok(topbar.includes('id="top-tour-btn"'), 'top-tour-btn missing from topbar');
  assert.ok(!html.includes('sys-setup-btn'), 'sys-setup-btn should be gone');
  assert.ok(!html.includes('sys-tour-btn'), 'sys-tour-btn should be gone');
});

// v4.3: email-to-VA — the "Email" batch button sits in the Jobs toolbar next to
// Export, and the connect flow lives in a System-view card.
test('email-to-VA button + setup card are present', () => {
  assert.ok(html.includes('id="email-btn"'), 'email-btn (Jobs toolbar) missing');
  assert.ok(html.includes('id="email-setup-start"'), 'email-setup-start (System card) missing');
  assert.ok(html.includes('id="email-validate"') && html.includes('id="email-save"'), 'email connect steps missing');
});
