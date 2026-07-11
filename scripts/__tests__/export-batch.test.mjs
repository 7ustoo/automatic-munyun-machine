// node --test — minimal export builders (v2.4): number · title · apply link
// as txt or Excel-ready csv.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportRows, buildExportTxt, buildExportCsv, csvCell } from '../export-batch.mjs';

const LB = {
  date: '2026-07-02',
  jobs: [
    { idx: 1, title: 'IAM Engineer', directUrl: 'https://ats.example/apply/1', viewjobUrl: 'https://hiring.cafe/viewjob/aaa' },
    { idx: 2, title: 'Cloud Security, Sr. "IAM"', directUrl: '', viewjobUrl: 'https://hiring.cafe/viewjob/bbb' },
    { idx: 3, title: '', directUrl: null, viewjobUrl: 'https://hiring.cafe/viewjob/ccc' }
  ]
};

test('exportRows: number + title + apply link only, direct URL preferred', () => {
  const rows = exportRows(LB);
  assert.equal(rows.length, 3);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['applyUrl', 'n', 'title']);
  assert.equal(rows[0].applyUrl, 'https://ats.example/apply/1'); // direct wins
  assert.equal(rows[1].applyUrl, 'https://hiring.cafe/viewjob/bbb'); // fallback
  assert.equal(rows[2].title, '(untitled)');
});

test('txt export: numbered title lines with the apply link under each', () => {
  const txt = buildExportTxt(exportRows(LB), LB.date);
  assert.equal(txt, [
    'Automatic Munyun Machine — apply links (2026-07-02)',
    '3 jobs · number · title · apply link',
    '',
    '1. IAM Engineer',
    '   https://ats.example/apply/1',
    '',
    '2. Cloud Security, Sr. "IAM"',
    '   https://hiring.cafe/viewjob/bbb',
    '',
    '3. (untitled)',
    '   https://hiring.cafe/viewjob/ccc',
    ''
  ].join('\n'));
  // Only the three fields — no company/match%/search-query lines like the
  // old full export.
  assert.ok(!/Company:|Matched:|Search:|YOE:/.test(txt));
});

test('csv export: BOM + header + CRLF rows', () => {
  const csv = buildExportCsv(exportRows(LB));
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'Excel needs a UTF-8 BOM');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], '#,Job Title,Apply Link');
  assert.equal(lines[1], '1,IAM Engineer,https://ats.example/apply/1');
  assert.equal(lines[lines.length - 1], '', 'trailing CRLF');
});

test('csv quoting: commas and embedded quotes survive Excel round-trip rules', () => {
  const csv = buildExportCsv(exportRows(LB));
  // RFC 4180: field with comma/quote is wrapped in quotes, inner quotes doubled
  assert.ok(csv.includes('"Cloud Security, Sr. ""IAM"""'), csv);
});

test('csvCell edge cases', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(42), '42');
});

test('empty batch → no rows', () => {
  assert.deepEqual(exportRows({ jobs: [] }), []);
  assert.deepEqual(exportRows(null), []);
});
