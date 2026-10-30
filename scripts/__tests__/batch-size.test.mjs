import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampBatchSize, parseRankedBatchSize, parseKeywordBatchSize, BATCH_SIZE_OPTIONS, DEFAULT_BATCH_SIZE } from '../batch-size.mjs';

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

test('custom strong-match counts pass through', () => {
  for (const n of [1, 60, 80, 125, 175, 199]) assert.equal(clampBatchSize(n), n);
});

test('custom ranked targets have no preset ceiling', () => {
  for (const n of [201, 1000, 10000, 1_000_000]) assert.equal(clampBatchSize(n), n);
  assert.equal(clampBatchSize(-1), DEFAULT_BATCH_SIZE);
  assert.equal(clampBatchSize(Number.MAX_SAFE_INTEGER + 1), DEFAULT_BATCH_SIZE);
});

test('ranked target writes require a positive whole number', () => {
  for (const n of ['50', '201', '1000', '10000', '00100']) assert.equal(parseRankedBatchSize(n), Number(n));
  for (const bad of ['', '0', '-1', '1.5', 'abc', String(Number.MAX_SAFE_INTEGER + 1)]) assert.equal(parseRankedBatchSize(bad), null);
});

test('keyword collection accepts a safe 1–1000 limit', () => {
  for (const n of [1, 500, 1000]) assert.equal(parseKeywordBatchSize(String(n)), n);
  for (const bad of [0, 1001, '1.5', 'x', Infinity]) assert.equal(parseKeywordBatchSize(bad), null);
});

test('fractional stored values round to an integer', () => {
  assert.equal(clampBatchSize(149.6), 150);
  assert.equal(clampBatchSize(99.4), 99);
});
