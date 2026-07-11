// node --test scripts/__tests__/salary.test.mjs
// First test fixture in the repo. Pins down the salary parser's behavior
// across the formats hiring.cafe and surrounding ATS pages tend to use.
// Failure means a regression in scoring's salary-bonus signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSalaryK } from '../daily-batch.mjs';

test('basic $K format', () => {
  assert.deepEqual(parseSalaryK('Salary: $120k'), [120]);
  assert.deepEqual(parseSalaryK('$135K base'), [135]);
});

test('range with hyphen', () => {
  assert.deepEqual(parseSalaryK('$120k-$160K'), [120, 160]);
});

test('range with en-dash', () => {
  assert.deepEqual(parseSalaryK('$120k–$160K'), [120, 160]);
});

test('range with em-dash (the v0.x bug)', () => {
  assert.deepEqual(parseSalaryK('$120K—$160K'), [120, 160]);
});

test('comma-thousands without K', () => {
  assert.deepEqual(parseSalaryK('$120,000 - $160,000'), [120, 160]);
});

test('USD prefix', () => {
  assert.deepEqual(parseSalaryK('USD 120K - 160K'), [120, 160]);
});

test('lowercase k', () => {
  assert.deepEqual(parseSalaryK('compensation up to $145k'), [145]);
});

test('no salary signal', () => {
  assert.deepEqual(parseSalaryK('Competitive compensation'), []);
  assert.deepEqual(parseSalaryK('TBD based on experience'), []);
});

test('rejects implausible numbers', () => {
  // 5K is too low (would be flagged as not a real annual salary)
  assert.deepEqual(parseSalaryK('Bonus up to $5K'), []);
  // 9000K is too high
  assert.deepEqual(parseSalaryK('$9000K equity'), []);
});

test('does not double-count "K" matches inside words', () => {
  // "Kotlin" and "stack" should not match the K-suffix pattern
  assert.deepEqual(parseSalaryK('Tech stack: Kotlin'), []);
});

// v5.0: non-USD and hourly formats — so international + hourly postings parse
// instead of silently showing no salary (and sorting below a floor).
test('GBP / EUR K-suffix', () => {
  assert.deepEqual(parseSalaryK('£55k'), [55]);
  assert.deepEqual(parseSalaryK('€60k - €75k'), [60, 75]);
});

test('GBP / EUR full-form (comma and dot thousands)', () => {
  assert.deepEqual(parseSalaryK('£55,000 per annum'), [55]);
  assert.deepEqual(parseSalaryK('€60.000 - €75.000'), [60, 75]);
});

test('currency suffix full-form', () => {
  assert.deepEqual(parseSalaryK('55,000 GBP'), [55]);
});

test('hourly is annualized at 2080 h/yr', () => {
  assert.deepEqual(parseSalaryK('$45 / hour'), [94]);   // 45*2080/1000 = 93.6 → 94
  assert.deepEqual(parseSalaryK('$60/hr'), [125]);       // 60*2080/1000 = 124.8 → 125
  assert.deepEqual(parseSalaryK('£30 an hour'), [62]);   // 30*2080/1000 = 62.4 → 62
});

test('does not misread "40 hours per week" as hourly pay', () => {
  assert.deepEqual(parseSalaryK('40 hours per week'), []);
});
