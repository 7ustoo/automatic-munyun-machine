import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from './io-helpers.mjs';
import { directApplyKey, directApplyUrl, keywordListingUrl } from './hcafe-apply-links.mjs';
import { beginCatalogRun, collectCatalogRows, readCatalog, saveCatalogDescriptions, updateCatalog } from './job-catalog.mjs';

export const MAX_CSV_BYTES = 20 * 1024 * 1024;
const tokenPattern = /^[a-f0-9-]{36}$/;
const headerKey = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

// RFC 4180, including embedded newlines and escaped quotes. No job-count cap.
export function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  if (Buffer.byteLength(text) > MAX_CSV_BYTES) throw new Error('CSV must be 20 MB or smaller.');
  const counts = { ',': 0, '\t': 0, ';': 0 }; let inHeaderQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && inHeaderQuote && text[i + 1] === '"') { i++; continue; }
    if (c === '"') inHeaderQuote = !inHeaderQuote;
    if (!inHeaderQuote && /[\r\n]/.test(c)) break;
    if (!inHeaderQuote && Object.hasOwn(counts, c)) counts[c]++;
  }
  const delimiter = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const push = () => { row.push(cell); cell = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === delimiter) push();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      push(); if (row.some(v => v.trim())) rows.push(row); row = [];
    } else {
      if (closed && c.trim()) throw new Error('Malformed CSV: unexpected text after a quoted field.');
      cell += c;
    }
  }
  if (quoted) throw new Error('Malformed CSV: a quoted field was not closed.');
  push(); if (row.some(v => v.trim())) rows.push(row);
  return rows;
}

export function normalizeImportRows(input, fallbackKeyword = 'Imported CSV') {
  const rows = [], seen = new Set(), issues = []; let invalid = 0, duplicates = 0;
  for (const [index, raw] of input.entries()) {
    const directUrl = directApplyUrl(raw.directUrl || raw.url || raw.href);
    const viewjobUrl = keywordListingUrl(raw.viewjobUrl || raw.href || raw.url || raw.directUrl);
    const key = directApplyKey(directUrl) || viewjobUrl;
    if (!key) {
      invalid++; if (issues.length < 5) issues.push(`Row ${index + 2}: no valid application or HiringCafe job link.`);
      continue;
    }
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    rows.push({ title: String(raw.title || '').trim().slice(0, 500), company: String(raw.company || '').trim().slice(0, 300),
      location: String(raw.location || '').trim().slice(0, 500), directUrl, viewjobUrl,
      sourceId: String(raw.sourceId || '').slice(0, 500), source: String(raw.source || raw.src || 'import').slice(0, 60),
      q: String(raw.q || fallbackKeyword).trim().slice(0, 120), yoe: Number.isFinite(raw.yoe) ? raw.yoe : null,
      description: String(raw.description || raw.jdText || '').trim().slice(0, 40000), preserveMetadata: true });
  }
  return { rows, invalid, duplicates, issues, inputRows: input.length };
}

export function csvJobs(text) {
  const [headers, ...records] = parseCsv(text);
  if (!headers) throw new Error('This CSV is empty.');
  const keys = headers.map(headerKey);
  const get = (row, names) => { const i = keys.findIndex(k => names.includes(k)); return i < 0 ? '' : (row[i] || '').trim(); };
  if (!keys.some(k => ['applylink', 'directapplylink', 'directapplicationlink', 'directurl', 'url', 'link', 'joburl', 'listingurl', 'viewjoburl'].includes(k))) {
    throw new Error('Add an Apply Link or URL column. AMM exports can be imported as they are.');
  }
  return normalizeImportRows(records.map(row => ({
    title: get(row, ['jobtitle', 'title', 'job']), company: get(row, ['company', 'companyname', 'employer']),
    location: get(row, ['location', 'joblocation']), directUrl: get(row, ['applylink', 'directapplylink', 'directapplicationlink', 'directurl', 'url', 'link', 'joburl']),
    viewjobUrl: get(row, ['listingurl', 'viewjoburl', 'hiringcafelink', 'hiringcafeurl']), description: get(row, ['description', 'jobdescription', 'jdtext', 'jd']),
    q: get(row, ['keyword', 'keywords', 'searchkeywords', 'search', 'query']),
  })));
}

export function importPreview(pp, profile, label, parsed, source = 'csv') {
  if (!parsed.rows.length) throw new Error('No usable jobs found. Include a job title and an application link.');
  const id = randomUUID(), catalog = readCatalog(pp.jobCatalog);
  const known = parsed.rows.filter(row => catalog.aliases[`apply:${directApplyKey(row.directUrl)}`]
    || (row.sourceId && catalog.aliases[`${row.source}:${row.sourceId}`])
    || (row.viewjobUrl && catalog.aliases[`listing:${new URL(row.viewjobUrl).pathname}`])).length;
  const receipt = { id, profile, label: (source === 'csv' ? path.basename(label) : String(label)).slice(0, 180), source, createdAt: new Date().toISOString(), ...parsed };
  atomicWriteJson(path.join(pp.jobImports, `${id}.json`), receipt);
  return { ok: true, id, profile, label: receipt.label, source, total: parsed.rows.length,
    invalid: parsed.invalid, duplicates: parsed.duplicates, issues: parsed.issues, known,
    descriptions: parsed.rows.filter(r => r.description).length };
}

export function readImport(pp, id, profile) {
  if (!tokenPattern.test(id || '')) throw new Error('That import is not available. Upload the CSV again.');
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(path.join(pp.jobImports, `${id}.json`), 'utf8')); }
  catch { throw new Error('That import is not available in this profile.'); }
  if (receipt.profile !== profile) throw new Error('Profile changed. Prepare this list again for the current profile.');
  return receipt;
}

// Called under the same global lock as collection. Existing reviews and applied
// state survive imports; CSV scores/status are never trusted as AI decisions.
export async function ingestImport(pp, receipt, context) {
  let runId = receipt.runId;
  if (!runId || !readCatalog(pp.jobCatalog).runs.some(r => r.id === runId)) {
    runId = await beginCatalogRun(pp.jobCatalog, 'import', context);
    // Save the run before adding rows, so a retry can repair a partial import.
    atomicWriteJson(path.join(pp.jobImports, `${receipt.id}.json`), { ...receipt, runId });
  }
  const groups = new Map();
  for (const row of receipt.rows) { if (!groups.has(row.q)) groups.set(row.q, []); groups.get(row.q).push(row); }
  for (const [term, rows] of groups) await collectCatalogRows(pp.jobCatalog, runId, term, rows, 'import');
  // A saved pull may already have a full JD in the older per-profile cache.
  // Index exact destinations once; summaries and expired entries cannot pass.
  let cached = {};
  try { cached = JSON.parse(fs.readFileSync(path.join(path.dirname(pp.jobCatalog), 'description-cache.json'), 'utf8')); } catch {}
  const cachedByApply = new Map(Object.values(cached).filter(item => item?.jdText && item.descriptionQuality !== 'summary'
    && Date.now() - item.at < 86400000 && directApplyKey(item.directUrl)).map(item => [directApplyKey(item.directUrl), item]));
  const catalog = readCatalog(pp.jobCatalog), descriptions = [];
  for (const row of receipt.rows) {
    const entry = cached[row.viewjobUrl] || cachedByApply.get(directApplyKey(row.directUrl));
    const fresh = entry?.jdText && entry.descriptionQuality !== 'summary' && Date.now() - entry.at < 86400000;
    const text = row.description || (fresh ? entry.jdText : '');
    if (!text) continue;
    const id = catalog.aliases[`apply:${directApplyKey(row.directUrl)}`] || catalog.aliases[`listing:${row.viewjobUrl && new URL(row.viewjobUrl).pathname}`];
    if (catalog.jobs[id] && (row.description || !catalog.jobs[id].descriptionHash)) {
      descriptions.push({job:catalog.jobs[id],jdText:text,directUrl:row.directUrl});
    }
  }
  // Import thousands of descriptions with one history checkpoint, rather than
  // reading and rewriting the entire catalog once per CSV row.
  if (descriptions.length) await saveCatalogDescriptions(pp.jobCatalog, pp.jobDescriptions, descriptions);
  await updateCatalog(pp.jobCatalog, c => {
    c.paused = false;
    Object.assign(c.runs.find(r => r.id === runId), { resume: false, status: 'pending', context,
      sourceLabel: receipt.label, importSource: receipt.source, importId: receipt.id, error: '' });
  });
  return runId;
}
