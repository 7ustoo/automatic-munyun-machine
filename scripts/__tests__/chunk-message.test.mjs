// node --test scripts/__tests__/chunk-message.test.mjs
// Pins down chunkMessage (daily-batch.mjs), the Telegram message splitter.
// v2.0 fix: a single block (no blank lines) longer than the limit used to be
// emitted as-is — Telegram rejects messages over 4096 chars, which killed
// the whole batch send. Failure here means oversized chunks can ship again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMessage } from '../daily-batch.mjs';

test('short message → single chunk', () => {
  assert.deepEqual(chunkMessage('hello\n\nworld'), ['hello\n\nworld']);
});

test('splits on blank-line boundaries under the limit', () => {
  const block = 'x'.repeat(2500);
  const chunks = chunkMessage(`${block}\n\n${block}\n\n${block}`, 3900);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= 3900);
});

test('hard-splits a single oversized block on line boundaries', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
  const chunks = chunkMessage(lines, 1000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1000, `chunk of ${c.length} exceeds limit`);
  // No content lost
  assert.equal(chunks.join('\n').replace(/\n+/g, '\n'), lines.replace(/\n+/g, '\n'));
});

test('hard-splits even with no newlines at all', () => {
  const blob = 'z'.repeat(9000);
  const chunks = chunkMessage(blob, 3900);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 3900);
  assert.equal(chunks.join(''), blob);
});

test('empty input → no chunks', () => {
  assert.deepEqual(chunkMessage(''), []);
});
