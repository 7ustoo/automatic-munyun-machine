import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { csvJobs, parseCsv, importPreview, readImport, ingestImport, normalizeImportRows } from '../job-import.mjs';
import { readCatalog, updateCatalog, catalogSummary, readCatalogDescription, saveCatalogDescription } from '../job-catalog.mjs';
import { reviewCatalog } from '../catalog-review.mjs';
import { publicIPv4, publicPageRequest } from '../employer-description.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { jobCatalog: path.join(dir, 'catalog.json'), jobDescriptions: path.join(dir, 'descriptions'), jobImports: path.join(dir, 'imports') };
}
const csv = 'Job Title,Company,Apply Link,Description\r\n"Linux Engineer, II",Example,https://jobs.example.com/1,"Full Linux duties\nwith ""automation"" experience."\r\nDevOps Engineer,Example,https://jobs.example.com/2,\r\n';

test('CSV supports quoted multiline descriptions, BOM, AMM minimal/detailed exports and delimiters', () => {
  const parsed = csvJobs('\uFEFF' + csv);
  assert.equal(parsed.rows.length, 2); assert.equal(parsed.rows[0].title, 'Linux Engineer, II');
  assert.match(parsed.rows[0].description, /\nwith "automation"/);
  assert.equal(csvJobs('#;Job Title;Apply Link\n1;Linux;https://jobs.example.com/3').rows.length, 1);
  assert.equal(csvJobs('Job title\tDirect apply link\tSearch keywords\nEngineer\thttps://jobs.example.com/3\tlinux').rows[0].q, 'linux');
  assert.equal(csvJobs('"Job Title";"Company, Inc, Name";"Apply Link"\nLinux;Example;https://jobs.example.com/1').rows.length, 1);
  assert.throws(() => parseCsv('Title,URL\n"broken,https://jobs.example.com'), /not closed/);
  assert.throws(() => csvJobs('Title,Company\nLinux,Example'), /Apply Link/);
});

test('imports have no 200/1000 cap; exact links deduplicate while different roles at one company stay separate', () => {
  const input = Array.from({ length: 3423 }, (_, n) => `Engineer ${n},Example,https://jobs.example.com/${n}`).join('\n');
  const parsed = csvJobs('Title,Company,URL\n' + input + '\nRepeated,Example,https://jobs.example.com/1?utm_source=other\nBad,Example,javascript:bad\nBad2,Example,http://localhost/secret');
  assert.equal(parsed.rows.length, 3423); assert.equal(parsed.duplicates, 1); assert.equal(parsed.invalid, 2);
  assert.equal(csvJobs('Title,Apply Link\nLinux,https://hiring.cafe/job/123').rows[0].viewjobUrl, 'https://hiring.cafe/job/123');
});

test('prepared imports are profile scoped, idempotent and preserve cached reviews and applied state', async t => {
  const pp = fixture(t), preview = importPreview(pp, 'linux', 'linux.csv', csvJobs(csv));
  const receipt = readImport(pp, preview.id, 'linux');
  assert.throws(() => readImport(pp, preview.id, 'other'), /Profile changed/);
  assert.throws(() => readImport(pp, '../catalog', 'linux'), /not available/);
  const runId = await ingestImport(pp, receipt, 'ctx');
  let catalog = readCatalog(pp.jobCatalog), [one, two] = Object.values(catalog.jobs);
  assert.match(readCatalogDescription(pp.jobDescriptions, one.id), /Linux duties/);
  await saveCatalogDescription(pp.jobCatalog, pp.jobDescriptions, two, 'Full DevOps job description.');
  await updateCatalog(pp.jobCatalog, c => { for (const j of Object.values(c.jobs)) j.review = { context: 'ctx', descriptionHash: j.descriptionHash, matchPct: 84, exclusions: [] }; c.jobs[two.id].appliedAt = '2026-11-01'; });
  assert.equal(await ingestImport(pp, readImport(pp, preview.id, 'linux'), 'ctx'), runId);
  // Re-importing a minimal title/link export cannot erase the cached JD.
  const second = importPreview(pp, 'linux', 'minimal.csv', csvJobs('Job Title,Apply Link\nDifferent sparse title,https://jobs.example.com/1'));
  assert.equal(second.known, 1);
  const secondRun = await ingestImport(pp, readImport(pp, second.id, 'linux'), 'ctx');
  let requests = 0;
  await reviewCatalog({ file: pp.jobCatalog, directory: pp.jobDescriptions, runId: secondRun, context: 'ctx', loadDescription: () => { throw new Error('Cached description should be reused'); }, review: () => requests++ });
  catalog = readCatalog(pp.jobCatalog);
  assert.equal(requests, 0); assert.equal(catalog.jobs[one.id].title, 'Linux Engineer, II');
  assert.equal(catalogSummary(catalog, 'ctx').pending, 0); assert.equal(catalogSummary(catalog, 'ctx').applied, 1);
  assert.equal(catalog.runs.find(r => r.id === secondRun).ids.length, 1);
  await updateCatalog(pp.jobCatalog, c => { c.jobs[one.id].descriptionAt = '2000-01-01'; });
  await ingestImport(pp, readImport(pp, second.id, 'linux'), 'ctx');
  assert.equal(readCatalog(pp.jobCatalog).jobs[one.id].needsDescription, true);
});

test('a new supplied description invalidates an old score and selected review leaves other lists pending', async t => {
  const pp = fixture(t), preview = importPreview(pp, 'linux', 'old.csv', csvJobs(csv));
  await ingestImport(pp, readImport(pp, preview.id, 'linux'), 'ctx');
  let oldJob = Object.values(readCatalog(pp.jobCatalog).jobs)[0];
  await updateCatalog(pp.jobCatalog, c => { c.jobs[oldJob.id].review = { context: 'ctx', descriptionHash: oldJob.descriptionHash, matchPct: 90, exclusions: [] }; });
  const changed = importPreview(pp, 'linux', 'changed.csv', normalizeImportRows([{ title: 'Linux', directUrl: oldJob.directUrl, description: 'Changed duties: consultant role.' }]));
  const runId = await ingestImport(pp, readImport(pp, changed.id, 'linux'), 'ctx');
  assert.equal(catalogSummary(readCatalog(pp.jobCatalog), 'ctx').pending, 2);
  await reviewCatalog({ file: pp.jobCatalog, directory: pp.jobDescriptions, runId, context: 'ctx', loadDescription: () => { throw new Error('Should use CSV'); }, score: () => ({}), review: async rows => { for (const r of rows) { r.aiPct = 75; r.matchPct = 72; r.aiReason = 'Consultant duties.'; } }, exclusions: () => ['Consultant role excluded.'] });
  const c = readCatalog(pp.jobCatalog);
  assert.equal(catalogSummary(c, 'ctx').pending, 1); assert.equal(catalogSummary(c, 'ctx').excluded, 1);
  assert.equal(c.jobs[oldJob.id].review.matchPct, 72); assert.equal(c.jobs[oldJob.id].reviewHistory.length, 1);
});

test('employer reader rejects private, reserved, mixed-DNS, literal IP and local URLs before making a connection', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.3.4', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1', '203.0.113.3', '::1']) assert.equal(publicIPv4(address), false, address);
  assert.equal(publicIPv4('8.8.8.8'), true);
  await assert.rejects(() => publicPageRequest('http://localhost/secret'), /public employer/);
  await assert.rejects(() => publicPageRequest('https://jobs.example.com/job', { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] }), /private/);
});

test('minimal saved lists reuse a fresh full description cache but never a summary', async t => {
 const pp=fixture(t),p=importPreview(pp,'linux','links.csv',csvJobs('Title,URL\nLinux,https://jobs.example.com/1\nLinux,https://jobs.example.com/2'));
 fs.writeFileSync(path.join(path.dirname(pp.jobCatalog),'description-cache.json'),JSON.stringify({
  '/one':{directUrl:'https://jobs.example.com/1',jdText:'Full cached Linux description.',at:Date.now()},
  '/two':{directUrl:'https://jobs.example.com/2',jdText:'A short card summary',descriptionQuality:'summary',at:Date.now()}
 }));
 await ingestImport(pp,readImport(pp,p.id,'linux'),'ctx');
 const jobs=Object.values(readCatalog(pp.jobCatalog).jobs);
 assert.equal(readCatalogDescription(pp.jobDescriptions,jobs[0].id),'Full cached Linux description.');
 assert.equal(readCatalogDescription(pp.jobDescriptions,jobs[1].id),'');
});
