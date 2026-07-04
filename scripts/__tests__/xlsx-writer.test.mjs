// node --test scripts/__tests__/xlsx-writer.test.mjs
// v2.4.1: the zero-dep .xlsx writer must produce a structurally valid ZIP
// (correct signatures, CRCs, entry counts) whose worksheet carries NATIVE
// hyperlinks for the apply-link column — the whole reason it exists is that
// CSV (plain text per RFC 4180) cannot represent a clickable link.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, buildZip, buildXlsx, colLetter, xmlEsc } from '../xlsx-writer.mjs';
import { buildExportXlsx, exportRows } from '../export-batch.mjs';

test('crc32 matches the standard check vector', () => {
  // Canonical CRC-32 test vector: "123456789" → 0xCBF43926
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('colLetter maps 0-based indexes to A1 letters', () => {
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(2), 'C');
  assert.equal(colLetter(25), 'Z');
  assert.equal(colLetter(26), 'AA');
});

test('xmlEsc escapes markup and strips XML-illegal control chars', () => {
  assert.equal(xmlEsc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  assert.equal(xmlEsc('bad\x01ctrl\x0Bchars'), 'badctrlchars');
});

test('buildZip produces a valid STORED zip (signatures + EOCD count)', () => {
  const zip = buildZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/b.txt', data: Buffer.from('world') }
  ]);
  // Local file header signature at offset 0
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  // EOCD signature in the last 22 bytes, entry count 2
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  assert.equal(zip.readUInt16LE(eocd + 10), 2);
});

function extractEntry(zip, name) {
  // Minimal STORED-zip reader for tests: walk local headers.
  let off = 0;
  while (off + 30 <= zip.length && zip.readUInt32LE(off) === 0x04034b50) {
    const nameLen = zip.readUInt16LE(off + 26);
    const extraLen = zip.readUInt16LE(off + 28);
    const size = zip.readUInt32LE(off + 22);
    const entryName = zip.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    if (entryName === name) return zip.subarray(dataStart, dataStart + size);
    off = dataStart + size;
  }
  return null;
}

const SAMPLE = {
  columns: [
    { header: '#', width: 6 },
    { header: 'Job Title', width: 60 },
    { header: 'Apply Link', width: 80, hyperlink: true }
  ],
  rows: [
    [1, 'IAM Engineer', 'https://jobs.example.com/apply?id=1&src=amm'],
    [2, 'Cloud & Security <Lead>', 'https://hiring.cafe/viewjob/abc123']
  ]
};

test('buildXlsx contains all required OOXML parts', () => {
  const xlsx = buildXlsx(SAMPLE);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
    'xl/worksheets/_rels/sheet1.xml.rels']) {
    assert.ok(extractEntry(xlsx, part), `missing part: ${part}`);
  }
});

test('hyperlink column produces native <hyperlink> refs + external rels', () => {
  const xlsx = buildXlsx(SAMPLE);
  const sheet = extractEntry(xlsx, 'xl/worksheets/sheet1.xml').toString('utf8');
  const rels = extractEntry(xlsx, 'xl/worksheets/_rels/sheet1.xml.rels').toString('utf8');
  // One hyperlink per data row, anchored at the link column (C), styled s="1"
  assert.ok(sheet.includes('<hyperlink ref="C2" r:id="rId1"/>'), 'C2 hyperlink missing');
  assert.ok(sheet.includes('<hyperlink ref="C3" r:id="rId2"/>'), 'C3 hyperlink missing');
  assert.ok(sheet.includes('<c r="C2" t="inlineStr" s="1">'), 'link cell not hyperlink-styled');
  // Rels carry the ESCAPED external targets
  assert.ok(rels.includes('Target="https://jobs.example.com/apply?id=1&amp;src=amm"'), 'external rel target missing/unescaped');
  assert.ok(rels.includes('TargetMode="External"'), 'rel not marked External');
});

test('titles with XML metacharacters are escaped in cells', () => {
  const xlsx = buildXlsx(SAMPLE);
  const sheet = extractEntry(xlsx, 'xl/worksheets/sheet1.xml').toString('utf8');
  assert.ok(sheet.includes('Cloud &amp; Security &lt;Lead&gt;'), 'title not XML-escaped');
  assert.ok(!sheet.includes('<Lead>'), 'raw markup leaked into sheet XML');
});

test('numbers are numeric cells, not strings', () => {
  const xlsx = buildXlsx(SAMPLE);
  const sheet = extractEntry(xlsx, 'xl/worksheets/sheet1.xml').toString('utf8');
  assert.ok(sheet.includes('<c r="A2"><v>1</v></c>'), 'number column not numeric');
});

test('buildExportXlsx wires batch rows into the workbook', () => {
  const rows = exportRows({
    jobs: [
      { idx: 1, title: 'IAM Engineer', directUrl: 'https://ats.example.com/1', viewjobUrl: 'https://hiring.cafe/viewjob/x1' },
      { idx: 2, title: 'SOC Analyst', directUrl: '', viewjobUrl: 'https://hiring.cafe/viewjob/x2' }
    ]
  });
  const xlsx = buildExportXlsx(rows, '2026-07-02');
  assert.equal(xlsx.readUInt32LE(0), 0x04034b50, 'not a zip');
  const sheet = extractEntry(xlsx, 'xl/worksheets/sheet1.xml').toString('utf8');
  const rels = extractEntry(xlsx, 'xl/worksheets/_rels/sheet1.xml.rels').toString('utf8');
  // Direct ATS link preferred; viewjob fallback used when direct missing
  assert.ok(rels.includes('Target="https://ats.example.com/1"'));
  assert.ok(rels.includes('Target="https://hiring.cafe/viewjob/x2"'));
  assert.ok(sheet.includes('IAM Engineer'));
  // Sheet tab name stays within Excel's 31-char cap
  const wb = extractEntry(xlsx, 'xl/workbook.xml').toString('utf8');
  const m = wb.match(/name="([^"]+)"/);
  assert.ok(m && m[1].length <= 31, 'sheet name exceeds Excel 31-char cap');
});
