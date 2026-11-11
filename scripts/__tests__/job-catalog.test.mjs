import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginCatalogRun, collectCatalogRows, readCatalog, updateCatalog, saveCatalogDescription, catalogAction, catalogSummary, catalogAnalytics, reviewContext } from '../job-catalog.mjs';
import { reviewCatalog } from '../catalog-review.mjs';
import { selectCatalogJobs } from '../smart-match-api.mjs';

function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amm-catalog-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {file:path.join(dir,'jobs.json'),directory:path.join(dir,'descriptions')}; }
const row = n => ({ sourceId: String(n), source: 'hcafe', title: 'Linux Engineer', company: 'Example', location: 'Remote', directUrl: `https://jobs.example.com/apply/${n}`, viewjobUrl: `https://hiringcafe.com/job/job-${n}` });

test('exact IDs/links deduplicate cross-keyword sightings, retries keep hit counts, different roles at a company survive', async t=>{
 const {file}=fixture(t),id=await beginCatalogRun(file,'smart','ctx');
 await collectCatalogRows(file,id,'linux',[row(1),row(2)],0);
 await collectCatalogRows(file,id,'linux',[row(1),row(2)],0);
 await collectCatalogRows(file,id,'cloud',[{...row(1),sourceId:'other-source'}],0);
 const c=readCatalog(file),s=catalogAnalytics(c,'ctx',0);
 assert.equal(Object.keys(c.jobs).length,2);assert.equal(s.totals.hits,3);assert.equal(s.totals.unique,2);assert.equal(s.totals.pending,2);assert.equal(s.totals.below,0);
 assert.equal(s.keywords.reduce((sum,k)=>sum+k.unique,0),3);
 assert.equal(c.runs[0].newIds.length,2);
});

test('completed review survives a later AI failure; continue retries only pending decisions',async t=>{
 const {file,directory}=fixture(t),runId=await beginCatalogRun(file,'smart','ctx');
 await collectCatalogRows(file,runId,'linux',Array.from({length:22},(_,n)=>row(n)));
 let calls=0,descriptions=0;
 const options={file,directory,runId,context:'ctx',loadDescription:async()=>{descriptions++;return {jdText:'Full role description. Linux operations and automation.'};},score:()=>({matchPct:80}),exclusions:()=>[],review:async rows=>{calls++;if(calls===2)throw new Error('API unavailable');for(const r of rows){r.aiPct=90;r.matchPct=87;r.aiReason='Relevant Linux operations.';}}};
 await assert.rejects(()=>reviewCatalog(options),/API unavailable/);
 let c=readCatalog(file);assert.equal(catalogSummary(c,'ctx').strong,20);assert.equal(catalogSummary(c,'ctx').pending,2);
 const resume=await beginCatalogRun(file,'smart','ctx',{resume:true});
 calls=0;await reviewCatalog({...options,runId:resume});
 c=readCatalog(file);assert.equal(catalogSummary(c,'ctx').strong,22);assert.equal(descriptions,22);assert.equal(c.runs[1].reviewedIds.length,2);assert.equal(c.runs[1].reusedIds.length,20);
});

test('pause retains pending state; exclusions keep percentages; restore and applied stay independent',async t=>{
 const {file,directory}=fixture(t),runId=await beginCatalogRun(file,'smart','ctx');await collectCatalogRows(file,runId,'linux',[row(1)]);
 await catalogAction(file,'pause');
 await reviewCatalog({file,directory,runId,context:'ctx',loadDescription:()=>{throw new Error('should not run');}});
 assert.equal(readCatalog(file).runs[0].status,'paused');
 const id=Object.keys(readCatalog(file).jobs)[0];
 await saveCatalogDescription(file,directory,readCatalog(file).jobs[id],'Full description');
 await updateCatalog(file,c=>{c.jobs[id].review={context:'ctx',matchPct:85,exclusions:['Lead role'],at:new Date().toISOString()};});
 assert.equal(catalogSummary(readCatalog(file),'ctx').excluded,1);assert.equal(catalogSummary(readCatalog(file),'ctx').strong,1);
 await catalogAction(file,'restore',id);assert.equal(selectCatalogJobs(readCatalog(file),'ctx',{scope:'results'}).length,1);
 await catalogAction(file,'applied',id);assert.equal(catalogSummary(readCatalog(file),'ctx').applied,1);assert.equal(selectCatalogJobs(readCatalog(file),'ctx',{scope:'results'}).length,0);
 assert.equal(catalogSummary(readCatalog(file),'changed-resume').pending,0); // applied remains applied
});

test('resume/model/preferences changes invalidate decisions and secrets are excluded from review fingerprint',()=>{
 const cfg={scoring:{ai:{apiKey:'secret-one',enabled:true}},filters:{filterClearance:true}};
 const a=reviewContext(cfg,{raw:'Linux resume'},'sol');
 assert.equal(a,reviewContext({...cfg,scoring:{ai:{apiKey:'secret-two',enabled:true}}},{raw:'Linux resume'},'sol'));
 assert.notEqual(a,reviewContext(cfg,{raw:'Changed resume'},'sol'));
 assert.notEqual(a,reviewContext(cfg,{raw:'Linux resume'},'new-model'));
 assert.notEqual(a,reviewContext({...cfg,filters:{filterClearance:false}},{raw:'Linux resume'},'sol'));
});

test('repeated page ingestion cannot clear an unresolved description change',async t=>{
 const {file,directory}=fixture(t),runId=await beginCatalogRun(file,'smart','ctx');await collectCatalogRows(file,runId,'linux',[row(1)]);
 let job=Object.values(readCatalog(file).jobs)[0];await saveCatalogDescription(file,directory,job,'Full original job');
 const changed={...row(1),sourceVersion:'new'};await collectCatalogRows(file,runId,'linux',[changed]);await collectCatalogRows(file,runId,'cloud',[changed]);
 job=Object.values(readCatalog(file).jobs)[0];assert.equal(job.needsDescription,true);
});

test('a newly resolved application link merges earlier source-only sightings and run references',async t=>{
 const {file}=fixture(t),runId=await beginCatalogRun(file,'smart','ctx');
 await collectCatalogRows(file,runId,'linux',[{...row(1),directUrl:''}]);
 await collectCatalogRows(file,runId,'cloud',[{...row(2),directUrl:row(1).directUrl}]);
 await collectCatalogRows(file,runId,'linux',[row(1)],1);
 const c=readCatalog(file);assert.equal(Object.keys(c.jobs).length,1);assert.equal(c.runs[0].ids.length,1);assert.deepEqual(Object.keys(Object.values(c.jobs)[0].queries).sort(),['cloud','linux']);
});
