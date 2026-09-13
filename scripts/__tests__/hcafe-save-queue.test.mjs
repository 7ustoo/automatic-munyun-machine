import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enqueueSaved, drainSaveQueue, readSaveQueue, ensureJobSaved, isHiringCafeJob } from '../hcafe-save-queue.mjs';
test('save queue deduplicates selected jobs, retains failures, removes only verified saves', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-save-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json');
  const a = 'https://hiringcafe.com/job/a', b = 'https://hiringcafe.com/job/b';
  enqueueSaved(file, [{ href: a }, { href: a }, { href: b }, { href: 'https://evil.test/job/a' }]);
  assert.equal(readSaveQueue(file).length, 2);
  const result = await drainSaveQueue(file, async url => { if (url === b) throw new Error('offline'); });
  assert.deepEqual(result, { saved: 1, pending: 1, attempted: 2, blocked: false });
  assert.equal(readSaveQueue(file)[0].url, b);
  await drainSaveQueue(file, async () => {});
  assert.equal(readSaveQueue(file).length, 0);
});
test('three failed saves rotate behind unattempted jobs instead of starving the queue', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-save-rotate-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json');
  const urls = ['a', 'b', 'c', 'd'].map(id => `https://hiringcafe.com/job/${id}`);
  enqueueSaved(file, urls.map(href => ({ href })));
  const first = await drainSaveQueue(file, async () => { throw new Error('unavailable'); });
  assert.deepEqual(first, { saved: 0, pending: 4, attempted: 3, blocked: true });
  assert.deepEqual(readSaveQueue(file).map(j => j.url), [urls[3], urls[0], urls[1], urls[2]]);
  const second = await drainSaveQueue(file, async () => {});
  assert.deepEqual(second, { saved: 4, pending: 0, attempted: 4, blocked: false });
});
test('already-saved jobs are not toggled; unsafe destinations rejected', async () => {
  let clicks = 0;
  const page = { goto: async () => {}, locator: () => ({ waitFor: async () => {} }),
    getByRole: () => ({ first: () => ({ isVisible: async () => true, click: async () => { clicks++; } }) }) };
  await ensureJobSaved(page, 'https://hiringcafe.com/job/a');
  assert.equal(clicks, 0);
  assert.equal(isHiringCafeJob('https://hiringcafe.com.evil.test/job/a'), false);
  await assert.rejects(ensureJobSaved(page, 'http://localhost/job/a'));
});
