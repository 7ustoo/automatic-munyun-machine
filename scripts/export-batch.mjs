#!/usr/bin/env node
/**
 * Batch export: compact TXT/XLSX and reusable CSV with saved full descriptions.
 *
 * Four formats:
 *   txt  — plain numbered list, one job per block, easy to read/paste
 *   csv  — Excel-ready sheet (UTF-8 BOM so Excel detects the encoding,
 *          CRLF rows, proper quoting) with company, HiringCafe link and full JD.
 *          NOTE: CSV is plain text (RFC 4180) — it cannot carry hyperlinks,
 *          so the Apply Link column is inert text in Excel.
 *   csv-simple — role, company, direct application link and original keyword.
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
import { readArchive } from './batch-archive.mjs';
import { readExclusions } from './batch-exclusions.mjs';
import { buildXlsx } from './xlsx-writer.mjs';
import { keywordListingUrl, directApplyUrl, directApplyKey } from './hcafe-apply-links.mjs';
import { readCatalog, withCatalogDescriptions } from './job-catalog.mjs';

// ---- pure builders (unit-tested) ----

// Batch jobs → compact links plus reusable full-text CSV fields. Apply links
// prefer resolved employer URLs, with source fallback only for older batches.
export function exportRows(lastBatch) {
  return (lastBatch?.jobs || []).map(j => ({
    n: j.idx,
    title: (j.title || '(untitled)').trim(),
    applyUrl: lastBatch?.funnel?.directApplyLinks ? (j.directUrl || '') : (j.directUrl || j.viewjobUrl || ''),
    company: j.company || '',
    viewjobUrl: keywordListingUrl(j.viewjobUrl) || '',
    description: ['summary', 'missing'].includes(j.descriptionQuality) ? '' : String(j.description || (j.descriptionQuality === 'full' ? j.jdText || j.__jd || '' : '')).trim(),
    descriptionError: j.descriptionError || ''
  }));
}

export function buildExportTxt(rows, date = '', linkLabel = 'apply link') {
  const lines = [];
  lines.push('Automatic Munyun Machine — ' + (linkLabel === 'listing link' ? 'listing links' : 'apply links') + (date ? ` (${date})` : ''));
  lines.push(`${rows.length} jobs · number · title · ${linkLabel}`);
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

export function buildExportCsv(rows, linkLabel = 'Apply Link') {
  // \uFEFF: UTF-8 BOM — without it Excel guesses ANSI and mangles any
  // non-ASCII characters in job titles. CRLF rows per RFC 4180.
  const head = ['#', 'Job Title', linkLabel, 'Company', 'HiringCafe Link', 'Job Description', 'Description Status'].map(csvCell).join(',');
  const body = rows.map(r => [r.n, r.title, r.applyUrl, r.company, r.viewjobUrl, r.description,
    r.description ? 'Full description saved' : r.descriptionError || 'Description unavailable'].map(csvCell).join(','));
  return '\uFEFF' + [head, ...body].join('\r\n') + '\r\n';
}

// Older snapshots need no migration. Only exact saved identities may supply
// missing metadata; a listing URL must never masquerade as a direct apply URL.
export function simpleExportRows(batch, catalog = {}) {
  return (batch?.jobs || []).map(job => {
    const listing = keywordListingUrl(job.viewjobUrl || job.href);
    const aliases = [`apply:${directApplyKey(job.directUrl)}`,
      listing && `listing:${new URL(listing).pathname}`,
      (job.sourceId || job.id) && `${job.source || 'hcafe'}:${job.sourceId || job.id}`].filter(Boolean);
    const id = aliases.map(alias => catalog.aliases?.[alias]).find(Boolean);
    const saved = catalog.jobs?.[id];
    return { title: String(job.title || '(untitled)').trim(), company: job.company || saved?.company || '',
      directUrl: directApplyUrl(job.directUrl) || directApplyUrl(saved?.directUrl) || directApplyUrl(job.viewjobUrl || job.href),
      keyword: job.q || job.keyword || batch.keyword || '' };
  });
}

export function buildSimpleExportCsv(rows) {
  const cell = value => csvCell(String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&"));
  const header = ['Job Title', 'Company', 'Direct Apply Link', 'Keyword'];
  return '\uFEFF' + [header, ...rows.map(row => [row.title, row.company, directApplyUrl(row.directUrl), row.keyword])]
    .map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

// Excel workbook with the Apply Link column as native clickable hyperlinks —
// the thing CSV structurally can't do. Returns a Buffer.
export function buildExportXlsx(rows, date = '', linkLabel = 'Apply Link') {
  return buildXlsx({
    sheetName: ((linkLabel === 'Listing Link' ? 'Listing links ' : 'Apply links ') + date).trim().slice(0, 31), // Excel caps tab names at 31 chars
    columns: [
      { header: '#', width: 6 },
      { header: 'Job Title', width: 60 },
      { header: linkLabel, width: 80, hyperlink: true }
    ],
    rows: rows.map(r => [r.n, r.title, r.applyUrl])
  });
}

// ---- loader (reads the active profile's last batch) ----

export function loadExport(format, archiveId) {
  const fmt = ['csv', 'csv-simple', 'xlsx'].includes(format) ? format : 'txt';
  const pp = profilePaths();
  let lb;
  if (archiveId) {
    // v7.2: export a previous scrape from the batch archive instead of the
    // live last-batch.json. readArchive validates the id (path-safe).
    lb = readArchive(profilePaths().batchArchiveDir, archiveId);
    if (!lb) return { ok: false, error: 'That archived scrape is no longer available.' };
  } else try {
    lb = JSON.parse(fs.readFileSync(profilePaths().lastBatch, 'utf8'));
    // v7.7: drop jobs the user ✕-excluded on the dashboard. Live batch only —
    // archived snapshots export exactly as they were delivered.
    const excluded = readExclusions(profilePaths().batchExclusions, lb.generatedAt);
    if (excluded.size) lb = { ...lb, jobs: (lb.jobs || []).filter(j => !excluded.has(j.idx)) };
  } catch {
    return { ok: false, error: 'No batch yet — run a scrape first.' };
  }
  if (fmt === 'csv') try { lb = withCatalogDescriptions(lb, readCatalog(pp.jobCatalog), pp.jobDescriptions); } catch { /* Original links remain exportable. */ }
  let catalog;
  if (fmt === 'csv-simple' && (lb.jobs || []).some(job => !directApplyUrl(job.directUrl) || !job.company)) {
    try { catalog = readCatalog(pp.jobCatalog); } catch { /* Missing legacy metadata stays blank. */ }
  }
  const rows = fmt === 'csv-simple' ? simpleExportRows(lb, catalog) : exportRows(lb);
  if (!rows.length) {
    return { ok: false, error: 'The latest batch has no jobs to export.' };
  }
  const date = lb.date || new Date().toISOString().slice(0, 10);
  // Archived exports carry the full scrape timestamp so two same-day
  // downloads don't overwrite each other in the user's Downloads folder.
  const stamp = archiveId ? archiveId.replace(/^batch-/, '') : date;
  if (fmt === 'csv-simple') return { ok: true, format: 'csv', filename: `simple-jobs(${stamp}).csv`,
    content: buildSimpleExportCsv(rows), count: rows.length, date };
  const listingOnly = lb.mode === 'keyword' && !lb.funnel?.directApplyLinks;
  const filename = `${listingOnly ? 'listing-links' : 'apply-links'}(${stamp}).${fmt}`;
  if (fmt === 'xlsx') {
    // Binary format — base64 so it survives the one-line-JSON stdout contract.
    const contentBase64 = buildExportXlsx(rows, date, listingOnly ? 'Listing Link' : 'Apply Link').toString('base64');
    return { ok: true, format: fmt, filename, contentBase64, count: rows.length, date };
  }
  const content = fmt === 'csv' ? buildExportCsv(rows, listingOnly ? 'Listing Link' : 'Apply Link') : buildExportTxt(rows, date, listingOnly ? 'listing link' : 'apply link');
  return { ok: true, format: fmt, filename, content, count: rows.length, date };
}

// ---- CLI (the Go wrapper execs this) ----
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  const r = loadExport(process.argv[2], process.argv[3]);
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(r.ok ? 0 : 1);
}
