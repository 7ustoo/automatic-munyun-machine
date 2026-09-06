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
  assert.deepEqual(result, { saved: 1, pending: 1 });
  assert.equal(readSaveQueue(file)[0].url, b);
  await drainSaveQueue(file, async () => {});
  assert.equal(readSaveQueue(file).length, 0);
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
