import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { summarizeBatch, mergeHistory, appendHistory, readHistory, termLeaderboard, HISTORY_MAX_DAYS } from '../batch-history.mjs';

const JOBS = [
  { q: 'iam', matchPct: 90 },
  { q: 'iam', matchPct: 70 },
  { q: 'linux', matchPct: 40 },
  { q: '', matchPct: 99 },          // no source term — counted in totals, not in terms
];

test('summarizeBatch: averages, strong count, and per-term stats', () => {
  const s = summarizeBatch({ date: '2026-07-11', generatedAt: 'T1', jobs: JOBS, funnel: { raw: 500, keptAfterFilter: 300, afterDedup: 120, targetJobsPerBatch: 100 } });
  assert.equal(s.sent, 4);
  assert.equal(s.avgPct, Math.round((90 + 70 + 40 + 99) / 4));
  assert.equal(s.strongCount, 3); // 90, 70, 99
  assert.equal(s.target, 100);
  assert.equal(s.raw, 500);
  assert.deepEqual(s.terms.iam, { count: 2, avgPct: 80, strong: 2 });
  assert.deepEqual(s.terms.linux, { count: 1, avgPct: 40, strong: 0 });
  assert.equal(Object.keys(s.terms).length, 2); // blank q excluded
});

test('summarizeBatch: empty batch is safe', () => {
  const s = summarizeBatch({ date: '2026-07-11', generatedAt: 'T1', jobs: [], funnel: {} });
  assert.equal(s.sent, 0);
  assert.equal(s.avgPct, 0);
  assert.equal(s.strongCount, 0);
  assert.deepEqual(s.terms, {});
});

test('mergeHistory: same-date entry replaces, sorted ascending, capped', () => {
  const d1 = { date: '2026-07-09', sent: 10 };
  const d2 = { date: '2026-07-10', sent: 20 };
  let days = mergeHistory([d2, d1], { date: '2026-07-10', sent: 99 });
  assert.equal(days.length, 2);
  assert.deepEqual(days.map(d => d.date), ['2026-07-09', '2026-07-10']);
  assert.equal(days[1].sent, 99); // replaced, not duplicated

  // cap: 91 distinct dates → oldest dropped
  days = [];
  for (let i = 0; i < HISTORY_MAX_DAYS + 1; i++) {
    days = mergeHistory(days, { date: `2026-01-${String(i + 1).padStart(3, '0')}`, sent: i });
  }
  assert.equal(days.length, HISTORY_MAX_DAYS);
  assert.equal(days[0].sent, 1); // entry 0 fell off
});

test('appendHistory + readHistory round-trip on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-hist-'));
  const file = path.join(dir, 'batch-history.json');
  assert.equal(readHistory(file).length, 0); // missing → empty
  assert.equal(appendHistory(file, summarizeBatch({ date: '2026-07-10', generatedAt: 'T1', jobs: JOBS, funnel: {} })), true);
  assert.equal(appendHistory(file, summarizeBatch({ date: '2026-07-11', generatedAt: 'T2', jobs: JOBS.slice(0, 2), funnel: {} })), true);
  const days = readHistory(file);
  assert.equal(days.length, 2);
  assert.equal(days[1].sent, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('termLeaderboard: aggregates across days, sorts by avg match', () => {
  const days = [
    { date: 'a', terms: { iam: { count: 2, avgPct: 80, strong: 2 }, linux: { count: 2, avgPct: 40, strong: 0 } } },
    { date: 'b', terms: { iam: { count: 2, avgPct: 90, strong: 2 } } },
  ];
  const { rows, totalJobs, daysCovered } = termLeaderboard(days);
  assert.equal(daysCovered, 2);
  assert.equal(totalJobs, 6);
  assert.equal(rows[0].term, 'iam');
  assert.equal(rows[0].count, 4);
  assert.equal(rows[0].avgPct, 85); // (2*80 + 2*90) / 4
  assert.equal(rows[0].strong, 4);
  assert.equal(rows[1].term, 'linux');
  assert.equal(rows[1].sharePct, Math.round(2 / 6 * 100));
});

test('termLeaderboard: lastNDays window and empty input', () => {
  const days = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, terms: { x: { count: 1, avgPct: 50, strong: 0 } } }));
  assert.equal(termLeaderboard(days, { lastNDays: 30 }).totalJobs, 30);
  assert.deepEqual(termLeaderboard([]).rows, []);
});
