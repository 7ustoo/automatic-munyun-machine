#!/usr/bin/env node
/**
 * Minimal batch export (v2.4): number · job title · apply link — nothing else.
 *
 * Three formats:
 *   txt  — plain numbered list, one job per block, easy to read/paste
 *   csv  — Excel-ready sheet (UTF-8 BOM so Excel detects the encoding,
 *          CRLF rows, proper quoting) with columns: #, Job Title, Apply Link.
 *          NOTE: CSV is plain text (RFC 4180) — it cannot carry hyperlinks,
 *          so the Apply Link column is inert text in Excel.
 *   xlsx — real Excel workbook (v2.4.1) where the Apply Link column is a
 *          NATIVE clickable hyperlink (blue + underlined). Built by
 *          scripts/xlsx-writer.mjs, zero dependencies.
 *
 * Consumed by:
 *   - the dashboard (GET /api/export?format=txt|csv|xlsx → dashboard-api.mjs export)
 *   - the Telegram /export command (sends the file as an attachment)
 *
 * Built on demand from the ACTIVE profile's last-batch.json, so numbering
 * matches the dashboard table and the Telegram batch. The apply link is the
 * resolved direct ATS URL when we have one, else the hiring.cafe viewjob page.
 *
 * Usage (CLI, used by the Go wrapper):
 *   node scripts/export-batch.mjs txt   → {"ok":true,"filename":...,"content":...}
 *   node scripts/export-batch.mjs csv
 *   node scripts/export-batch.mjs xlsx  → {"ok":true,"filename":...,"contentBase64":...}
 *     (xlsx is binary — it rides the one-line-JSON contract base64-encoded)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths as profilePaths } from './profile-store.mjs';
import { buildXlsx } from './xlsx-writer.mjs';

// ---- pure builders (unit-tested) ----

// last-batch jobs → minimal rows. Apply link prefers the resolved direct
// ATS URL; falls back to the hiring.cafe viewjob page.
export function exportRows(lastBatch) {
  return (lastBatch?.jobs || []).map(j => ({
    n: j.idx,
    title: (j.title || '(untitled)').trim(),
    applyUrl: j.directUrl || j.viewjobUrl || ''
  }));
}

export function buildExportTxt(rows, date = '') {
  const lines = [];
  lines.push('Automatic Munyun Machine — apply links' + (date ? ` (${date})` : ''));
  lines.push(`${rows.length} jobs · number · title · apply link`);
  lines.push('');
  for (const r of rows) {
    lines.push(`${r.n}. ${r.title}`);
    lines.push(`   ${r.applyUrl}`);
    lines.push('');
  }
  return lines.join('\n');
}

// RFC-4180-ish CSV cell: quote when the value contains a comma, quote, or
// newline; double up embedded quotes.
export function csvCell(v) {
  const s = String(v ?? '');
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function buildExportCsv(rows) {
  // \uFEFF: UTF-8 BOM — without it Excel guesses ANSI and mangles any
  // non-ASCII characters in job titles. CRLF rows per RFC 4180.
  const head = ['#', 'Job Title', 'Apply Link'].map(csvCell).join(',');
  const body = rows.map(r => [r.n, r.title, r.applyUrl].map(csvCell).join(','));
  return '\uFEFF' + [head, ...body].join('\r\n') + '\r\n';
}

// Excel workbook with the Apply Link column as native clickable hyperlinks —
// the thing CSV structurally can't do. Returns a Buffer.
export function buildExportXlsx(rows, date = '') {
  return buildXlsx({
    sheetName: ('Apply links ' + date).trim().slice(0, 31), // Excel caps tab names at 31 chars
    columns: [
      { header: '#', width: 6 },
      { header: 'Job Title', width: 60 },
      { header: 'Apply Link', width: 80, hyperlink: true }
    ],
    rows: rows.map(r => [r.n, r.title, r.applyUrl])
  });
}

// ---- loader (reads the active profile's last batch) ----

export function loadExport(format) {
  const fmt = format === 'csv' ? 'csv' : format === 'xlsx' ? 'xlsx' : 'txt';
  let lb;
  try {
    lb = JSON.parse(fs.readFileSync(profilePaths().lastBatch, 'utf8'));
  } catch {
    return { ok: false, error: 'No batch yet — run a scrape first.' };
  }
  const rows = exportRows(lb);
  if (!rows.length) {
    return { ok: false, error: 'The latest batch has no jobs to export.' };
  }
  const date = lb.date || new Date().toISOString().slice(0, 10);
  const filename = `apply-links(${date}).${fmt}`;
  if (fmt === 'xlsx') {
    // Binary format — base64 so it survives the one-line-JSON stdout contract.
    const contentBase64 = buildExportXlsx(rows, date).toString('base64');
    return { ok: true, format: fmt, filename, contentBase64, count: rows.length };
  }
  const content = fmt === 'csv' ? buildExportCsv(rows) : buildExportTxt(rows, date);
  return { ok: true, format: fmt, filename, content, count: rows.length };
}

// ---- CLI (the Go wrapper execs this) ----
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  const r = loadExport(process.argv[2]);
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(r.ok ? 0 : 1);
}
