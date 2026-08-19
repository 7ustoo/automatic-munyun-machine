import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAppliedLedger, recordAppliedJob } from '../application-ledger.mjs';

test('recordAppliedJob persists canonical cross-source identity', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-applied-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'applied-jobs.json');

  await recordAppliedJob(file, {
    title: 'Senior Software Engineer',
    company: 'Acme, Inc.',
    location: 'Remote - US',
    directUrl: 'https://jobs.example.com/123?utm_source=dice',
  }, 'https://jobs.example.com/123?utm_source=dice');

  const entries = Object.values(readAppliedLedger(file).jobs);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].identity, {
    url: 'https://jobs.example.com/123',
    company: 'acme',
    title: 'senior software engineer',
    location: 'remote us',
  });
});

test('recordAppliedJob rejects an unidentifiable record', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-applied-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(recordAppliedJob(path.join(dir, 'applied-jobs.json'), {}, ''), /needs a URL/);
});
