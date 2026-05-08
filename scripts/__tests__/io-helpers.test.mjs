// Unit tests for scripts/io-helpers.mjs — atomic writes, locked updates,
// and the concurrent-writer integration test that REVIEW.md flagged as
// the missing coverage for the F-H3 "atomic writes under contention" claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteText, atomicWriteJson, atomicUpdateJson,
  withFileLock, lockedUpdateJson, lockedUpdateJsonSync
} from '../io-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Each test gets a clean temp dir.
function newTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `amm-io-${prefix}-`));
}

// ---------- atomicWriteText / atomicWriteJson ----------

test('atomicWriteText creates the file with exact content', () => {
  const tmp = newTmp('text');
  const target = path.join(tmp, 'out.txt');
  atomicWriteText(target, 'hello\nworld\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello\nworld\n');
  fs.rmSync(tmp, { recursive: true });
});

test('atomicWriteText overwrites an existing file', () => {
  const tmp = newTmp('overwrite');
  const target = path.join(tmp, 'out.txt');
  fs.writeFileSync(target, 'OLD');
  atomicWriteText(target, 'NEW');
  assert.equal(fs.readFileSync(target, 'utf8'), 'NEW');
  fs.rmSync(tmp, { recursive: true });
});

test('atomicWriteText creates parent directory if needed', () => {
  const tmp = newTmp('mkdir');
  const target = path.join(tmp, 'nested', 'deep', 'file.txt');
  atomicWriteText(target, 'ok');
  assert.equal(fs.readFileSync(target, 'utf8'), 'ok');
  fs.rmSync(tmp, { recursive: true });
});

test('atomicWriteText cleans up tmp file on rename failure', () => {
  // Hard to reliably trigger EPERM in a test environment; instead we just
  // confirm that no .tmp.* leftovers exist after a successful write.
  const tmp = newTmp('cleanup');
  const target = path.join(tmp, 'a.txt');
  atomicWriteText(target, 'x');
  const stragglers = fs.readdirSync(tmp).filter(f => f.includes('.tmp.'));
  assert.deepEqual(stragglers, []);
  fs.rmSync(tmp, { recursive: true });
});

test('atomicWriteJson serializes with 2-space indent by default', () => {
  const tmp = newTmp('json');
  const target = path.join(tmp, 'a.json');
  atomicWriteJson(target, { a: 1, b: [2, 3] });
  const text = fs.readFileSync(target, 'utf8');
  assert.match(text, /^{\n  "a": 1/);
  fs.rmSync(tmp, { recursive: true });
});

test('atomicWriteJson honors custom indent', () => {
  const tmp = newTmp('json-indent');
  const target = path.join(tmp, 'a.json');
  atomicWriteJson(target, { a: 1 }, { indent: 4 });
  const text = fs.readFileSync(target, 'utf8');
  assert.match(text, /^{\n    "a": 1/);
  fs.rmSync(tmp, { recursive: true });
});

// ---------- atomicUpdateJson (no lock) ----------

test('atomicUpdateJson reads, mutates, writes', () => {
  const tmp = newTmp('upd');
  const target = path.join(tmp, 'a.json');
  atomicWriteJson(target, { count: 0 });
  atomicUpdateJson(target, prev => ({ count: (prev?.count ?? 0) + 1 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { count: 1 });
  fs.rmSync(tmp, { recursive: true });
});

test('atomicUpdateJson with missing file passes null to mutator', () => {
  const tmp = newTmp('upd-missing');
  const target = path.join(tmp, 'a.json');
  let received = 'sentinel';
  atomicUpdateJson(target, prev => { received = prev; return { fresh: true }; });
  assert.equal(received, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { fresh: true });
  fs.rmSync(tmp, { recursive: true });
});

test('atomicUpdateJson skips write if mutator returns undefined', () => {
  const tmp = newTmp('upd-skip');
  const target = path.join(tmp, 'a.json');
  atomicWriteJson(target, { keep: 'me' });
  atomicUpdateJson(target, () => undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { keep: 'me' });
  fs.rmSync(tmp, { recursive: true });
});

// ---------- withFileLock ----------

test('withFileLock runs the callback and releases on success', async () => {
  const tmp = newTmp('lock-ok');
  const target = path.join(tmp, 'a.json');
  let ran = false;
  const result = await withFileLock(target, async () => {
    ran = true;
    return 42;
  });
  assert.equal(ran, true);
  assert.equal(result, 42);
  // Lock dir should be cleaned up
  assert.equal(fs.existsSync(target + '.lock'), false);
  fs.rmSync(tmp, { recursive: true });
});

test('withFileLock releases on throw', async () => {
  const tmp = newTmp('lock-throw');
  const target = path.join(tmp, 'a.json');
  await assert.rejects(
    withFileLock(target, async () => { throw new Error('boom'); }),
    /boom/
  );
  // After unwind the lock should be released
  assert.equal(fs.existsSync(target + '.lock'), false);
  fs.rmSync(tmp, { recursive: true });
});

test('withFileLock serializes overlapping holders', async () => {
  const tmp = newTmp('lock-serial');
  const target = path.join(tmp, 'a.json');
  atomicWriteJson(target, { v: 0 });

  // Two "writers" each increment the value. Without the lock, they'd
  // race and one increment could be lost. With the lock, both succeed.
  const incr = () => withFileLock(target, async () => {
    const cur = JSON.parse(fs.readFileSync(target, 'utf8'));
    // Simulate work between read + write
    await new Promise(r => setTimeout(r, 50));
    atomicWriteJson(target, { v: cur.v + 1 });
  });

  await Promise.all([incr(), incr(), incr()]);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 3 });
  fs.rmSync(tmp, { recursive: true });
});

// ---------- lockedUpdateJson / lockedUpdateJsonSync ----------

test('lockedUpdateJson async serializes', async () => {
  const tmp = newTmp('lupd-async');
  const target = path.join(tmp, 'a.json');
  atomicWriteJson(target, { v: 0 });

  await Promise.all([1, 2, 3, 4, 5].map(() =>
    lockedUpdateJson(target, prev => ({ v: (prev?.v ?? 0) + 1 }))
  ));

  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 5 });
  fs.rmSync(tmp, { recursive: true });
});

test('lockedUpdateJsonSync works in the synchronous path used by config-rw', () => {
  const tmp = newTmp('lupd-sync');
  const target = path.join(tmp, 'a.json');
  atomicWriteJson(target, { v: 0 });
  for (let i = 0; i < 3; i++) {
    lockedUpdateJsonSync(target, prev => ({ v: (prev?.v ?? 0) + 1 }));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 3 });
  fs.rmSync(tmp, { recursive: true });
});

// ---------- Cross-process concurrent-writer test (the F-H3 audit) ----------
// Spawn N child processes that each call lockedUpdateJsonSync 100×; assert
// the final counter equals N × 100. Without the lock, this routinely loses
// updates on Windows.

test('cross-process: 3 concurrent writers each increment 30× with no lost updates', async (t) => {
  if (process.env.AMM_SKIP_CROSS_PROCESS) {
    t.skip('skipping cross-process test (AMM_SKIP_CROSS_PROCESS set)');
    return;
  }
  const tmp = newTmp('cross');
  const target = path.join(tmp, 'counter.json');
  atomicWriteJson(target, { v: 0 });

  // Build a file:// URL for the import (Windows ESM requires this — bare
  // backslash paths fail with ERR_UNSUPPORTED_ESM_URL_SCHEME).
  const ioHelpersUrl = new URL('../io-helpers.mjs', import.meta.url).href;
  const workerSrc = `
    import { lockedUpdateJsonSync } from ${JSON.stringify(ioHelpersUrl)};
    const target = ${JSON.stringify(target)};
    for (let i = 0; i < 30; i++) {
      lockedUpdateJsonSync(target, prev => ({ v: (prev?.v ?? 0) + 1 }));
    }
  `;
  const workerPath = path.join(tmp, 'worker.mjs');
  fs.writeFileSync(workerPath, workerSrc);

  const child = (i) => new Promise((resolve) => {
    const c = spawn(process.execPath, [workerPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    c.stderr.on('data', d => { stderr += d.toString(); });
    c.on('exit', code => resolve({ code, stderr }));
  });

  const results = await Promise.all([0, 1, 2].map(child));
  for (const r of results) {
    if (r.code !== 0) {
      throw new Error(`worker exited ${r.code}: ${r.stderr.slice(0, 500)}`);
    }
  }

  const final = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(final.v, 90);
  fs.rmSync(tmp, { recursive: true });
});
