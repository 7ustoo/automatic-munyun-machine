import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHiringCafeDescriptionCollector, readHiringCafeDescription } from '../hcafe-descriptions.mjs';
import { beginCatalogRun, collectCatalogRows, saveCollectedDescriptions, readCatalog, readCatalogDescription } from '../job-catalog.mjs';
import { exportRows, buildExportCsv } from '../export-batch.mjs';
import { csvJobs, importPreview, ingestImport, readImport } from '../job-import.mjs';
import { reviewCatalog } from '../catalog-review.mjs';

const full = 'Responsibilities\nMaintain Linux, AWS and Azure infrastructure.\nBuild CI/CD pipelines with Terraform and Ansible.\nRequirements\nPython, Bash and "production support" experience.';
const job = n => ({ sourceId: String(n), source: 'hcafe', title: 'Platform Engineer', company: 'Example, Inc.',
  directUrl: `https://jobs.example.com/${n}`, href: `https://jobs.example.com/${n}`, viewjobUrl: `https://hiringcafe.com/job/${n}` });
const context = () => ({ newPage: async () => ({ close: async () => {} }) });

test('collection uses HiringCafe listing links, retains full text, and reuses full cache without page reads', async () => {
  const rows=[job(1),job(2)],cache={};let reads=0;
  const collector=createHiringCafeDescriptionCollector({context:context(),cache,read:async(_page,url)=>{
    assert.match(url,/^https:\/\/hiringcafe.com\/job\//);reads++;return {jdText:full,descriptionQuality:'full',directUrl:rows[0].directUrl};
  }});
  await collector.collect(rows);assert.equal(reads,2);assert.equal(rows[0].description,full);
  const next=[job(1)];await collector.collect(next);assert.equal(reads,2);assert.equal(next[0].description,full);
  await collector.close();
});

test('fast collection returns 100 jobs without opening any detail pages and still includes cached full text', async () => {
  const rows=Array.from({length:100},(_,i)=>job(i));
  const collector=createHiringCafeDescriptionCollector({context:{newPage:async()=>{throw Error('Fast pulls must not open detail pages');}},
    read:async()=>{throw Error('Fast pulls must not fetch JDs');},
    cache:{[rows[0].viewjobUrl]:{jdText:full,descriptionQuality:'full',at:Date.now()}}});
  await collector.collect(rows,{fetchMissing:false});
  assert.equal(rows.length,100);assert.equal(rows[0].description,full);assert.equal(collector.stats.cached,1);
  assert.equal(collector.stats.pending,99);assert.match(rows[1].descriptionError,/background/);
  await collector.close();
});

test('summary cache, expired cache and changed source version cannot masquerade as full descriptions', async () => {
  const rows=[job(1),job(2),{...job(3),sourceVersion:'new'}];let calls=0;
  const cache={
    [rows[0].viewjobUrl]:{jdText:'summary',descriptionQuality:'summary',at:Date.now()},
    [rows[1].viewjobUrl]:{jdText:full,descriptionQuality:'full',at:Date.now()-86400001},
    [rows[2].viewjobUrl]:{jdText:full,descriptionQuality:'full',sourceVersion:'old',at:Date.now()},
  };
  const collector=createHiringCafeDescriptionCollector({context:context(),cache,read:async()=>{calls++;return {jdText:full,descriptionQuality:'full'};}});
  await collector.collect(rows);assert.equal(calls,3);await collector.close();
});

test('blocked/missing descriptions keep the job and report the failure, never promoting card text', async () => {
  const rows=[{...job(1),cardText:'Linux summary'},{...job(2),viewjobUrl:''}];
  const collector=createHiringCafeDescriptionCollector({context:context(),read:async()=>{throw new Error('HTTP 403');}});
  await collector.collect(rows);assert.equal(rows.length,2);assert.equal(rows[0].description,undefined);
  assert.equal(rows[0].descriptionQuality,'missing');assert.match(rows[0].descriptionError,/403/);
  assert.match(rows[1].descriptionError,/link unavailable/);await collector.close();
});

test('reader refuses employer URLs and stops on HiringCafe throttling before reading page text', async () => {
  await assert.rejects(()=>readHiringCafeDescription({},'https://jobs.example.com/1'),/listing link/);
  let pause=0;
  const page={goto:async()=>({status:()=>429,headers:()=>({'retry-after':'3'})})};
  await assert.rejects(()=>readHiringCafeDescription(page,job(1).viewjobUrl,{onThrottle:ms=>pause=ms}),/slow down/);
  assert.equal(pause,3000);
});

test('full descriptions survive CSV multiline round trip and selected-list review without website loading', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amm-description-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pp={jobCatalog:path.join(dir,'catalog.json'),jobDescriptions:path.join(dir,'descriptions'),jobImports:path.join(dir,'imports')};
  const input=[{...job(1),idx:1,description:full,descriptionQuality:'full'},{...job(2),idx:2,description:full,descriptionQuality:'full'}];
  const parsed=csvJobs(buildExportCsv(exportRows({funnel:{directApplyLinks:true},jobs:input})));
  assert.equal(parsed.rows.length,2);assert.equal(parsed.rows[0].description,full);assert.equal(parsed.rows[0].company,'Example, Inc.');
  assert.equal(parsed.rows[1].viewjobUrl,job(2).viewjobUrl);assert.equal(parsed.rows[1].directUrl,job(2).directUrl);
  const preview=importPreview(pp,'test','fresh.csv',parsed);const runId=await ingestImport(pp,readImport(pp,preview.id,'test'),'ctx');
  let reviewed=0;
  await reviewCatalog({file:pp.jobCatalog,directory:pp.jobDescriptions,runId,context:'ctx',
    loadDescription:async()=>{throw new Error('Must use saved HiringCafe JD');},score:()=>({matchPct:80}),exclusions:()=>[],
    review:async rows=>{reviewed+=rows.length;for(const r of rows){assert.equal(r.__jd,full);r.aiPct=85;r.matchPct=83;}}});
  assert.equal(reviewed,2);assert.equal(readCatalog(pp.jobCatalog).runs[0].status,'complete');
});

test('bulk collection checkpoints full descriptions without promoting summary text', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amm-description-cache-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'catalog.json'),directory=path.join(dir,'descriptions');const run=await beginCatalogRun(file,'keyword','ctx');
  const rows=[{...job(1),description:full,descriptionQuality:'full'},{...job(2),jdText:'Only summary',descriptionQuality:'summary'}];
  await collectCatalogRows(file,run,'platform',rows);await saveCollectedDescriptions(file,directory,rows);
  const jobs=Object.values(readCatalog(file).jobs);assert.equal(readCatalogDescription(directory,jobs[0].id),full);
  assert.equal(jobs[0].needsDescription,false);assert.equal(readCatalogDescription(directory,jobs[1].id),'');
});

test('CSV reports missing/summary descriptions without exporting leftover summary text as a full JD', () => {
  for(const descriptionQuality of ['summary','missing']) {
    const rows=exportRows({jobs:[{...job(1),idx:1,description:'Short card summary',descriptionQuality,descriptionError:'Blocked by source'}]});
    assert.equal(rows[0].description,'');
    assert.match(buildExportCsv(rows),/Blocked by source/);
    assert.doesNotMatch(buildExportCsv(rows),/Full description saved|Short card summary/);
  }
});
