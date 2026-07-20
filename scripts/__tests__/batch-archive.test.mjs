import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  archiveId, entryFromBatch, mergeIndex, archiveBatch, listArchives, readArchive,
  ARCHIVE_ID_RX, ARCHIVE_RETENTION_DAYS
} from '../batch-archive.mjs';

const BATCH = {
  date: '2026-07-20',
  generatedAt: '2026-07-20T14:33:05.123Z',
  jobs: [
    { title: 'IAM Engineer', company: 'Acme', matchPct: 90, directUrl: 'https://a.example/x' },
    { title: 'Linux Admin', company: 'Beta', matchPct: 40, viewjobUrl: 'https://hiring.cafe/j/2' }
  ]
};

test('archiveId: filesystem-safe, matches the id regex', () => {
  const id = archiveId(BATCH.generatedAt);
  assert.equal(id, 'batch-2026-07-20T14-33-05');
  assert.ok(ARCHIVE_ID_RX.test(id));
  assert.ok(!id.includes(':'));
});

test('entryFromBatch: counts, average, strong', () => {
  const e = entryFromBatch(BATCH);
  assert.equal(e.id, 'batch-2026-07-20T14-33-05');
  assert.equal(e.date, '2026-07-20');
  assert.equal(e.sent, 2);
  assert.equal(e.avgPct, 65);
  assert.equal(e.strongCount, 1);
});

test('entryFromBatch: empty/missing jobs are safe', () => {
  const e = entryFromBatch({ generatedAt: '2026-07-20T00:00:00Z' });
  assert.equal(e.sent, 0);
  assert.equal(e.avgPct, 0);
  assert.equal(e.strongCount, 0);
});

test('mergeIndex: same id replaces, newest first, old entries pruned', () => {
  const now = Date.parse('2026-07-20T12:00:00Z');
  const fresh = { id: 'batch-2026-07-20T10-00-00', generatedAt: '2026-07-20T10:00:00Z' };
  const older = { id: 'batch-2026-07-01T09-00-00', generatedAt: '2026-07-01T09:00:00Z' };
  const ancient = { id: 'batch-2026-06-01T09-00-00', generatedAt: '2026-06-01T09:00:00Z' }; // > 30 days
  const merged = mergeIndex([older, ancient], fresh, { now });
  assert.deepEqual(merged.map(e => e.id), ['batch-2026-07-20T10-00-00', 'batch-2026-07-01T09-00-00']);
  // replace same id — no duplicates
  const again = mergeIndex(merged, { ...fresh, sent: 9 }, { now });
  assert.equal(again.filter(e => e.id === fresh.id).length, 1);
  assert.equal(again[0].sent, 9);
});

test('mergeIndex: drops malformed entries and honors custom retention', () => {
  const now = Date.parse('2026-07-20T12:00:00Z');
  const junk = [{ id: '../../etc/passwd' }, { id: 'batch-2026-07-19T00-00-00' /* no timestamp */ }, null];
  const entry = { id: 'batch-2026-07-20T11-00-00', generatedAt: '2026-07-20T11:00:00Z' };
  const merged = mergeIndex(junk, entry, { now, retentionDays: 1 });
  assert.deepEqual(merged.map(e => e.id), ['batch-2026-07-20T11-00-00']);
});

test('archiveBatch + listArchives + readArchive round-trip on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-arch-'));
  try {
    const entry = archiveBatch(dir, BATCH);
    assert.ok(entry);
    assert.ok(fs.existsSync(path.join(dir, entry.id + '.json')));
    const list = listArchives(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].sent, 2);
    const back = readArchive(dir, entry.id);
    assert.equal(back.jobs.length, 2);
    assert.equal(back.jobs[0].title, 'IAM Engineer');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('archiveBatch: expired snapshot files are deleted, foreign files kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-arch-'));
  try {
    const old = { ...BATCH, generatedAt: '2026-05-01T08:00:00.000Z', date: '2026-05-01' };
    archiveBatch(dir, old);
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}'); // foreign file — never touched
    const entry = archiveBatch(dir, BATCH); // second write prunes >30d relative to now
    const files = fs.readdirSync(dir).sort();
    assert.ok(files.includes(entry.id + '.json'));
    assert.ok(files.includes('notes.json'));
    assert.ok(!files.includes('batch-2026-05-01T08-00-00.json'));
    assert.equal(listArchives(dir).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readArchive: rejects traversal and unknown ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-arch-'));
  try {
    assert.equal(readArchive(dir, '../secrets'), null);
    assert.equal(readArchive(dir, 'batch-2099-01-01T00-00-00'), null);
    assert.equal(readArchive(dir, ''), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('retention constant is 30 days', () => {
  assert.equal(ARCHIVE_RETENTION_DAYS, 30);
});
