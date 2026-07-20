import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitQueriesByEngine, normalizeEngines, normalizeScrapeSources } from '../query-engines.mjs';

const Q = [
  { key: 'iam', term: 'iam engineer' },                       // no engines → both
  { key: 'sec', term: 'security engineer', engines: 'both' },
  { key: 'net', term: 'network admin', engines: 'hcafe' },
  { key: 'dev', term: 'devops', engines: 'dice' }
];

test('normalize: junk values fall back to both', () => {
  assert.equal(normalizeEngines('DICE'), 'both');
  assert.equal(normalizeEngines(undefined), 'both');
  assert.equal(normalizeEngines('dice'), 'dice');
  assert.equal(normalizeScrapeSources('nonsense'), 'both');
});

test('scrapeSources=both: per-term routing applies', () => {
  const { hcafe, dice } = splitQueriesByEngine(Q, 'both');
  assert.deepEqual(hcafe, [['iam', 'iam engineer'], ['sec', 'security engineer'], ['net', 'network admin']]);
  assert.deepEqual(dice, ['iam engineer', 'security engineer', 'devops']);
});

test('scrapeSources=hcafe: dice list empty, dice-only terms idle', () => {
  const { hcafe, dice } = splitQueriesByEngine(Q, 'hcafe');
  assert.deepEqual(dice, []);
  assert.deepEqual(hcafe.map(([k]) => k), ['iam', 'sec', 'net']);
});

test('scrapeSources=dice: hcafe loop gets nothing', () => {
  const { hcafe, dice } = splitQueriesByEngine(Q, 'dice');
  assert.deepEqual(hcafe, []);
  assert.deepEqual(dice, ['iam engineer', 'security engineer', 'devops']);
});

test('malformed queries are dropped, defaults safe', () => {
  const { hcafe, dice } = splitQueriesByEngine([null, { key: 'x' }, { term: 'orphan' }, ...Q.slice(0, 1)], undefined);
  assert.deepEqual(hcafe, [['iam', 'iam engineer']]);
  assert.deepEqual(dice, ['iam engineer']);
});
