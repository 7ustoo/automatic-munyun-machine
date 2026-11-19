// node --test — minimal export builders (v2.4): number · title · apply link
// as txt or Excel-ready csv.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportRows, buildExportTxt, buildExportCsv, csvCell, simpleExportRows, buildSimpleExportCsv } from '../export-batch.mjs';
import { parseCsv, csvJobs } from '../job-import.mjs';

test('simple CSV has exactly four columns and round-trips role/company/keyword without descriptions or scores', () => {
  const batch = {keyword:'cloud engineer',jobs:[{title:'Cloud Engineer, "II"',company:'Example, Inc.',directUrl:'https://jobs.example.com/apply?id=1&team=cloud',q:'linux',description:'PRIVATE FULL DESCRIPTION',matchPct:87},
    {title:'Azure Engineer',company:'Cloud Systems',directUrl:'https://jobs.example.com/2'}]};
  const before=JSON.stringify(batch),csv=buildSimpleExportCsv(simpleExportRows(batch));
  assert.equal(csv.charCodeAt(0),0xFEFF);
  const [headers,...rows]=parseCsv(csv);
  assert.deepEqual(headers,['Job Title','Company','Direct Apply Link','Keyword']);
  assert.deepEqual(rows[0],['Cloud Engineer, "II"','Example, Inc.','https://jobs.example.com/apply?id=1&team=cloud','linux']);
  assert.equal(rows[1][3],'cloud engineer');
  assert.ok(rows.every(row=>row.length===4));
  assert.doesNotMatch(csv,/PRIVATE FULL DESCRIPTION|87|Match %|Description/);
  assert.equal(JSON.stringify(batch),before);
  assert.equal(csvJobs(csv).rows[0].q,'linux');
});

test('old snapshots use only exact saved identities for missing employer metadata, never listing links or similar titles', () => {
  const jobs=[{id:'legacy',title:'Cloud Engineer',viewjobUrl:'https://hiringcafe.com/job/exact',q:'cloud'},
    {title:'Cloud Engineer',viewjobUrl:'https://hiringcafe.com/job/other',q:'linux'}];
  const catalog={aliases:{'listing:/job/exact':'saved'},jobs:{saved:{company:'Original Company',directUrl:'https://jobs.example.com/1'}}};
  const rows=simpleExportRows({jobs},catalog);
  assert.equal(rows[0].directUrl,'https://jobs.example.com/1');assert.equal(rows[0].company,'Original Company');
  assert.equal(rows[1].directUrl,'');assert.equal(rows[1].company,'');assert.equal(rows[1].keyword,'linux');
  assert.equal(parseCsv(buildSimpleExportCsv(rows))[2][2],'');
  assert.doesNotMatch(buildSimpleExportCsv(rows),/hiringcafe/);
});

test('simple CSV keeps all rows, protects spreadsheet formulas, and rejects non-employer destinations', () => {
  const csv=buildSimpleExportCsv([{title:'=HYPERLINK("bad")',company:'+Example',directUrl:'javascript:bad',keyword:'@cloud'},
    ...Array.from({length:6380},(_,i)=>({title:'Engineer '+i,company:'Example',directUrl:'https://jobs.example.com/'+i,keyword:'cloud'}))]);
  const [headers,...rows]=parseCsv(csv);assert.equal(headers.length,4);assert.equal(rows.length,6381);
  assert.equal(rows[0][0],"'=HYPERLINK(\"bad\")");assert.equal(rows[0][1],"'+Example");assert.equal(rows[0][2],'');assert.equal(rows[0][3],"'@cloud");
});

const LB = {
  date: '2026-07-02',
  jobs: [
    { idx: 1, title: 'IAM Engineer', directUrl: 'https://ats.example/apply/1', viewjobUrl: 'https://hiring.cafe/viewjob/aaa' },
    { idx: 2, title: 'Cloud Security, Sr. "IAM"', directUrl: '', viewjobUrl: 'https://hiring.cafe/viewjob/bbb' },
    { idx: 3, title: '', directUrl: null, viewjobUrl: 'https://hiring.cafe/viewjob/ccc' }
  ]
};

test('exportRows: direct URL preferred, rich CSV fields are retained', () => {
  const rows = exportRows(LB);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].description, '');
  assert.equal(rows[0].company, '');
  assert.equal(rows[0].applyUrl, 'https://ats.example/apply/1'); // direct wins
  assert.equal(rows[1].applyUrl, 'https://hiring.cafe/viewjob/bbb'); // fallback
  assert.equal(rows[2].title, '(untitled)');
});

test('direct keyword exports do not fall back to a hiring.cafe listing', () => {
  const rows = exportRows({ mode: 'keyword', funnel: { directApplyLinks: true }, jobs: [
    { idx: 1, title: 'Cloud Engineer', directUrl: '', viewjobUrl: 'https://hiring.cafe/job/a' },
  ] });
  assert.equal(rows[0].applyUrl, '');
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
  assert.equal(lines[0], '#,Job Title,Apply Link,Company,HiringCafe Link,Job Description,Description Status');
  assert.equal(lines[1], '1,IAM Engineer,https://ats.example/apply/1,,,,Description unavailable');
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
