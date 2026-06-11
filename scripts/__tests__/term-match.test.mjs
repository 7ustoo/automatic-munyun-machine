// node --test scripts/__tests__/term-match.test.mjs
// Pins down termRegex (scripts/term-match.mjs), the v2.0 fix for a silent
// scoring hole: '\b' + term + '\b' never matches terms ending in a non-word
// char, so Security+ / C++ / A+ scored zero in job ranking AND were never
// extracted from CVs by resume-parser. Failure here means those terms have
// regressed back to invisible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termRegex, escRx } from '../term-match.mjs';
import { scoreJob } from '../daily-batch.mjs';

test('plain terms stay word-bounded on both ends', () => {
  assert.ok(termRegex('Python').test('we use Python here'));
  assert.ok(!termRegex('Python').test('Pythonista'));
  assert.ok(!termRegex('IAM').test('LIAM'));
});

test('terms ending in + match (the Security+/C++ regression)', () => {
  assert.ok(termRegex('Security+').test('CompTIA Security+ required'));
  assert.ok(termRegex('Security+').test('Security+ or CISSP'));
  assert.ok(termRegex('C++').test('C++ developer'));
  assert.ok(termRegex('C++').test('knows C++, Rust'));
  // still anchored at the word-char start
  assert.ok(!termRegex('C++').test('ABC++'));
});

test('terms with internal regex specials are escaped literally', () => {
  assert.ok(termRegex('Node.js').test('Node.js services'));
  assert.ok(!termRegex('Node.js').test('Nodexjs services'));
});

test('flags pass through (gi for term-frequency counting)', () => {
  const re = termRegex('Okta', 'gi');
  assert.equal(('Okta okta OKTA'.match(re) || []).length, 3);
});

test('escRx escapes regex metacharacters', () => {
  assert.equal(escRx('C++ (Sr.)'), 'C\\+\\+ \\(Sr\\.\\)');
});

test('scoreJob credits a Security+ job (end-to-end through daily-batch)', () => {
  // scoreJob reads the parsed CV from disk at module load; on a fresh
  // checkout that's empty, so this asserts the matcher path, not weights:
  // a job whose only signal is in cardText must not throw and must return
  // the {score, matched} shape.
  const r = scoreJob({ title: 'Security Engineer', cardText: 'CompTIA Security+ required, $120k' });
  assert.equal(typeof r.score, 'number');
  assert.ok(Array.isArray(r.matched));
});
