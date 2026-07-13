import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmailFormat, emailAttachmentFromExport } from '../dashboard-api.mjs';

test('manual email format accepts txt, csv, and xlsx only', () => {
  assert.equal(normalizeEmailFormat('txt'), 'txt');
  assert.equal(normalizeEmailFormat('csv'), 'csv');
  assert.equal(normalizeEmailFormat('xlsx'), 'xlsx');
  assert.equal(normalizeEmailFormat('pdf'), 'txt');
  assert.equal(normalizeEmailFormat(undefined), 'txt');
});

test('text email exports remain exact strings', () => {
  const csv = '\uFEFF#,Job Title,Apply Link\r\n1,Engineer,https://example.com\r\n';
  const att = emailAttachmentFromExport({
    ok: true, format: 'csv', filename: 'apply-links(2026-07-13).csv',
    content: csv, count: 1, date: '2026-07-13'
  });
  assert.equal(att.filename, 'apply-links(2026-07-13).csv');
  assert.equal(att.content, csv);
  assert.equal(att.date, '2026-07-13');
});

test('xlsx email exports decode base64 into a binary attachment', () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]);
  const att = emailAttachmentFromExport({
    ok: true, format: 'xlsx', filename: 'apply-links(2026-07-13).xlsx',
    contentBase64: bytes.toString('base64'), count: 1, date: '2026-07-13'
  });
  assert.ok(Buffer.isBuffer(att.content));
  assert.deepEqual(att.content, bytes);
});

test('email attachment builder preserves export errors', () => {
  assert.deepEqual(
    emailAttachmentFromExport({ ok: false, error: 'The latest batch has no jobs to export.' }),
    { ok: false, error: 'The latest batch has no jobs to export.' }
  );
});
