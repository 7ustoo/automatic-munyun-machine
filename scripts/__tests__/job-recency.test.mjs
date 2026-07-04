// node --test scripts/__tests__/job-recency.test.mjs
// v2.5: recency filtering keys off the posted-age token hiring.cafe shows on
// each card ("5h", "3d", "2w", "1mo", "1y"). The parse must map those to days
// and the filter must FAIL-OPEN — a job whose age we can't read is never
// hidden (silently dropping real jobs is the exact failure we're avoiding).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgeToDays, recencyMaxDays, withinRecency, RECENCY_PRESETS } from '../job-recency.mjs';

test('parseAgeToDays maps each unit to days', () => {
  assert.equal(parseAgeToDays('3d'), 3);
  assert.equal(parseAgeToDays('2w'), 14);
  assert.equal(parseAgeToDays('1mo'), 30);
  assert.equal(parseAgeToDays('1y'), 365);
  assert.equal(parseAgeToDays('12h'), 0.5);
});

test('parseAgeToDays tolerates whitespace + case', () => {
  assert.equal(parseAgeToDays(' 5D '), 5);
  assert.equal(parseAgeToDays('2W'), 14);
});

test('parseAgeToDays returns null for unreadable input', () => {
  assert.equal(parseAgeToDays(''), null);
  assert.equal(parseAgeToDays(null), null);
  assert.equal(parseAgeToDays('yesterday'), null);
  assert.equal(parseAgeToDays('3x'), null);
  assert.equal(parseAgeToDays('mo'), null);
});

test("'mo' is not mis-read as 'm' (months, not a bad minute unit)", () => {
  // The regex must prefer 'mo' — '1mo' is 30 days, never 1.
  assert.equal(parseAgeToDays('1mo'), 30);
  assert.equal(parseAgeToDays('6mo'), 180);
});

test('recencyMaxDays maps presets and raw numbers; any/blank → null', () => {
  assert.equal(recencyMaxDays('today'), 1);
  assert.equal(recencyMaxDays('3days'), 3);
  assert.equal(recencyMaxDays('week'), 7);
  assert.equal(recencyMaxDays('month'), 31);
  assert.equal(recencyMaxDays('any'), null);
  assert.equal(recencyMaxDays(''), null);
  assert.equal(recencyMaxDays(null), null);
  assert.equal(recencyMaxDays(14), 14);
  assert.equal(recencyMaxDays('10'), 10);
  assert.equal(recencyMaxDays('garbage'), null);
});

test('every preset key resolves (no typo drift between UI + parser)', () => {
  for (const k of Object.keys(RECENCY_PRESETS)) {
    // Each preset either maps to a positive day count or null (any).
    const v = recencyMaxDays(k);
    assert.ok(v === null || (typeof v === 'number' && v > 0), `preset ${k} → ${v}`);
  }
});

test('withinRecency: keeps jobs within the window, drops older', () => {
  assert.equal(withinRecency('2d', 3), true);
  assert.equal(withinRecency('5d', 3), false);
  assert.equal(withinRecency('12h', 1), true);   // half a day ≤ today(1)
  assert.equal(withinRecency('1w', 3), false);   // 7d > 3
  assert.equal(withinRecency('1mo', 31), true);  // 30d ≤ month(31)
});

test('withinRecency fails OPEN: unreadable age or no filter keeps the job', () => {
  assert.equal(withinRecency('2w', null), true);      // no filter → keep all
  assert.equal(withinRecency('', 3), true);           // unknown age → keep
  assert.equal(withinRecency('whenever', 1), true);   // unparseable → keep
  assert.equal(withinRecency(null, 1), true);
});
