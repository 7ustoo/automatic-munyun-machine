import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exclusionsFrom, toggleIdx, readExclusions, writeExclusion } from '../batch-exclusions.mjs';

const STAMP = '2026-07-21T08:00:00.000Z';

test('exclusionsFrom: matching stamp yields the set', () => {
  const s = exclusionsFrom({ batchGeneratedAt: STAMP, excluded: [3, 7, '12'] }, STAMP);
  assert.deepEqual([...s].sort((a, b) => a - b), [3, 7, 12]);
});

test('exclusionsFrom: stale or missing stamp yields empty (new batch starts clean)', () => {
  assert.equal(exclusionsFrom({ batchGeneratedAt: 'old', excluded: [1] }, STAMP).size, 0);
  assert.equal(exclusionsFrom(null, STAMP).size, 0);
  assert.equal(exclusionsFrom({ batchGeneratedAt: STAMP, excluded: [1] }, '').size, 0);
});

test('exclusionsFrom: junk indices are dropped', () => {
  const s = exclusionsFrom({ batchGeneratedAt: STAMP, excluded: ['x', -4, 0, 2.9, 5] }, STAMP);
  assert.deepEqual([...s].sort(), [2, 5]); // parseInt('2.9')→2; negatives/zero/NaN dropped
});

test('toggleIdx: add, remove, ignore junk', () => {
  assert.deepEqual(toggleIdx(new Set([2]), 5, true), [2, 5]);
  assert.deepEqual(toggleIdx(new Set([2, 5]), 2, false), [5]);
  assert.deepEqual(toggleIdx(new Set([2]), 'junk', true), [2]);
  assert.deepEqual(toggleIdx(new Set([2]), -1, true), [2]);
});

test('write + read round-trip; stamp change resets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-excl-'));
  const file = path.join(dir, 'batch-exclusions.json');
  try {
    assert.deepEqual(writeExclusion(file, STAMP, 4, true), [4]);
    assert.deepEqual(writeExclusion(file, STAMP, 9, true), [4, 9]);
    assert.deepEqual(writeExclusion(file, STAMP, 4, false), [9]);
    assert.deepEqual([...readExclusions(file, STAMP)], [9]);
    // a new batch stamp discards the old list on read AND on write
    assert.equal(readExclusions(file, 'newer-stamp').size, 0);
    assert.deepEqual(writeExclusion(file, 'newer-stamp', 1, true), [1]);
    assert.deepEqual([...readExclusions(file, 'newer-stamp')], [1]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
