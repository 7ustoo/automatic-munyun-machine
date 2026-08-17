import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampBatchSize, BATCH_SIZE_OPTIONS, DEFAULT_BATCH_SIZE } from '../batch-size.mjs';

test('the four offered options pass through unchanged', () => {
  for (const n of [50, 100, 150, 200]) assert.equal(clampBatchSize(n), n);
});

test('options list and default are the expected values', () => {
  assert.deepEqual(BATCH_SIZE_OPTIONS, [50, 100, 150, 200]);
  assert.equal(DEFAULT_BATCH_SIZE, 200);
});

test('missing / garbage values fall back to the default', () => {
  for (const bad of [undefined, null, '', 'abc', NaN, {}, [], Infinity]) {
    assert.equal(clampBatchSize(bad), DEFAULT_BATCH_SIZE);
  }
});

test('string digits are accepted (dashboard/Telegram send strings)', () => {
  assert.equal(clampBatchSize('150'), 150);
  assert.equal(clampBatchSize('50'), 50);
});

test('off-grid numbers snap to the nearest option', () => {
  assert.equal(clampBatchSize(60), 50);    // closer to 50
  assert.equal(clampBatchSize(80), 100);   // closer to 100
  assert.equal(clampBatchSize(175), 200);  // closer to 200
});

test('out-of-range numbers clamp to the ends', () => {
  assert.equal(clampBatchSize(1), 50);     // below the floor → 50
  assert.equal(clampBatchSize(10000), 200); // above the ceiling → 200
});

test('exact midpoints round up to the larger option', () => {
  assert.equal(clampBatchSize(75), 100);   // 50 vs 100 tie → 100
  assert.equal(clampBatchSize(125), 150);  // 100 vs 150 tie → 150
  assert.equal(clampBatchSize(175), 200);  // 150 vs 200 tie → 200
});

test('fractional values round before snapping', () => {
  assert.equal(clampBatchSize(149.6), 150);
  assert.equal(clampBatchSize(99.4), 100);
});
