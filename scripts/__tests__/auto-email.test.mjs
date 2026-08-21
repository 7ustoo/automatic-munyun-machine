import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildAutoEmailAttachment } from '../daily-batch.mjs';

const batch = {
  jobs: [{
    idx: 1,
    title: 'Cloud Security Engineer',
    directUrl: 'https://example.com/apply/1',
    viewjobUrl: 'https://example.com/jobs/1'
  }]
};

test('automatic CSV email builds from the batch published by the scraper', () => {
  const attachment = buildAutoEmailAttachment({
    lastBatch: batch,
    format: 'csv',
    deliveryTxtPath: 'ignored.txt',
    date: '2026-08-21'
  });
  assert.equal(attachment.filename, 'apply-links(2026-08-21).csv');
  assert.match(attachment.content, /Cloud Security Engineer/);
  assert.match(attachment.content, /https:\/\/example\.com\/apply\/1/);
});

test('automatic XLSX email builds a real workbook from the published batch', () => {
  const attachment = buildAutoEmailAttachment({
    lastBatch: batch,
    format: 'xlsx',
    deliveryTxtPath: 'ignored.txt',
    date: '2026-08-21'
  });
  assert.equal(attachment.filename, 'apply-links(2026-08-21).xlsx');
  assert.ok(Buffer.isBuffer(attachment.content));
  assert.equal(attachment.content.subarray(0, 2).toString(), 'PK');
});

test('automatic TXT email keeps the already-written apply-links file', () => {
  const deliveryTxtPath = path.join('batch', 'apply-links(2026-08-21).txt');
  const attachment = buildAutoEmailAttachment({
    lastBatch: batch,
    format: 'txt',
    deliveryTxtPath,
    date: '2026-08-21'
  });
  assert.equal(attachment.filename, 'apply-links(2026-08-21).txt');
  assert.equal(attachment.path, deliveryTxtPath);
});

test('automatic spreadsheet email refuses an empty or missing batch', () => {
  assert.throws(
    () => buildAutoEmailAttachment({ format: 'xlsx', date: '2026-08-21' }),
    /published batch has no jobs/i
  );
});
