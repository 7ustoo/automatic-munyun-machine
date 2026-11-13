import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginCatalogRun, collectCatalogRows, readCatalog, updateCatalog, saveCatalogDescription, saveCatalogDescriptions, catalogAction, catalogSummary, catalogAnalytics, reviewContext, catalogRunActivity } from '../job-catalog.mjs';
import { reviewCatalog } from '../catalog-review.mjs';
import { selectCatalogJobs, selectCatalogRun } from '../smart-match-api.mjs';

function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amm-catalog-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {file:path.join(dir,'jobs.json'),directory:path.join(dir,'descriptions')}; }
const row = n => ({ sourceId: String(n), source: 'hcafe', title: 'Linux Engineer', company: 'Example', location: 'Remote', directUrl: `https://jobs.example.com/apply/${n}`, viewjobUrl: `https://hiringcafe.com/job/job-${n}` });

test('dashboard shows an older resumed worker while explicit history selection remains available',()=>{
 const active={id:'older',workerRunning:true},newer={id:'newer',workerRunning:false};
 const catalog={runs:[active,newer]};
 assert.equal(selectCatalogRun(catalog).id,'older');
 assert.equal(selectCatalogRun(catalog,{run:'newer'}).id,'newer');
 active.workerRunning=false;assert.equal(selectCatalogRun(catalog).id,'newer');
});

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
 const options={file,directory,runId,context:'ctx',batchSize:20,reviewConcurrency:1,loadDescription:async()=>{descriptions++;return {jdText:'Full role description. Linux operations and automation.'};},score:()=>({matchPct:80}),exclusions:()=>[],review:async rows=>{calls++;if(calls===2)throw new Error('API unavailable');for(const r of rows){r.aiPct=90;r.matchPct=87;r.aiReason='Relevant Linux operations.';}}};
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
 await updateCatalog(file,c=>{c.jobs[id].review={context:'ctx',descriptionHash:c.jobs[id].descriptionHash,matchPct:85,exclusions:['Lead role'],at:new Date().toISOString()};});
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

test('job actions reject object-prototype names and unknown IDs',async t=>{
 const {file}=fixture(t);await beginCatalogRun(file,'smart','ctx');
 for(const id of ['__proto__','constructor','a'.repeat(24)]) await assert.rejects(()=>catalogAction(file,'exclude',id),/no longer/);
 assert.equal(Object.keys(readCatalog(file).jobs).length,0);
});

test('website reads overlap within bounds, AI batches overlap, and in-flight success survives a peer failure', async t => {
 const {file,directory}=fixture(t),runId=await beginCatalogRun(file,'smart','ctx');
 await collectCatalogRows(file,runId,'linux',Array.from({length:8},(_,n)=>row(n)));
 let pages=0,maxPages=0,requests=0,maxRequests=0,calls=0;
 let releaseFirst;const first=new Promise(resolve=>{releaseFirst=resolve;});
 const options={file,directory,runId,context:'ctx',batchSize:2,descriptionConcurrency:2,reviewConcurrency:2,
  loadDescription:async()=>{pages++;maxPages=Math.max(maxPages,pages);await new Promise(r=>setTimeout(r,5));pages--;return {jdText:'Complete Linux infrastructure description.'};},
  score:()=>({matchPct:80}),exclusions:()=>[],review:async rows=>{
   const call=++calls;requests++;maxRequests=Math.max(maxRequests,requests);
   try {if(call===1){await first;await new Promise(r=>setTimeout(r,10));for(const r of rows){r.aiPct=90;r.matchPct=87;r.aiReason='Linux';}}
    else {releaseFirst();throw new Error('One API batch failed');}
   }finally{requests--;}
  }};
 await assert.rejects(()=>reviewCatalog(options),/One API batch failed/);
 const c=readCatalog(file);assert.equal(maxPages,2);assert.equal(maxRequests,2);
 assert.equal(c.runs[0].status,'interrupted');assert.equal(c.runs[0].reviewedIds.length,2);
 assert.equal(catalogSummary(c,'ctx').strong,2);assert.equal(catalogSummary(c,'ctx').pending,6);
 assert.equal(c.runs[0].progress.activeReviews,0);assert.equal(c.runs[0].workerPid,process.pid);
});

test('blocked descriptions stay pending and progress finishes rather than getting stuck reviewing', async t => {
 const {file,directory}=fixture(t),runId=await beginCatalogRun(file,'smart','ctx');
 await collectCatalogRows(file,runId,'linux',[row(1),row(2)]);
 await reviewCatalog({file,directory,runId,context:'ctx',loadDescription:async()=>{throw new Error('HTTP 403');},review:()=>assert.fail('No complete JD'),score:()=>({}),exclusions:()=>[]});
 const c=readCatalog(file),r=c.runs[0];assert.equal(r.status,'pending');assert.equal(r.progress.checked,2);assert.equal(r.progress.descriptionErrors,2);
 assert.equal(r.progress.activeDescriptions,0);assert.equal(catalogSummary(c,'ctx').pending,2);
});

test('dead and legacy workers are reported interrupted while live workers and final statuses remain accurate', () => {
 const run={status:'reviewing',workerPid:123};
 assert.equal(catalogRunActivity(run,{isAlive:()=>false}).status,'interrupted');
 assert.equal(catalogRunActivity(run,{isAlive:()=>true}).workerRunning,true);
 assert.equal(catalogRunActivity({status:'reviewing'},{lockActive:false}).status,'interrupted');
 assert.equal(catalogRunActivity({status:'collecting'},{lockActive:true}).status,'collecting');
 assert.equal(catalogRunActivity({status:'complete',workerPid:123},{isAlive:()=>false}).status,'complete');
});

test('subscription usage limits pause the run and leave unfinished jobs awaiting review',async t=>{
 const {file,directory}=fixture(t),runId=await beginCatalogRun(file,'smart','ctx');await collectCatalogRows(file,runId,'linux',[row(1)]);
 await assert.rejects(()=>reviewCatalog({file,directory,runId,context:'ctx',loadDescription:async()=>({jdText:'Complete Linux operations description.'}),score:()=>({}),exclusions:()=>[],
  review:async()=>{throw Object.assign(new Error('Your ChatGPT allowance is unavailable. No API fallback was used.'),{code:'SUBSCRIPTION_LIMIT'});}}),e=>e.code==='SUBSCRIPTION_LIMIT');
 const c=readCatalog(file);assert.equal(c.paused,true);assert.equal(c.runs[0].status,'paused');assert.equal(catalogSummary(c,'ctx').pending,1);
});

test('sparse successful descriptions pack across windows instead of issuing one-job requests', async t => {
 const {file,directory}=fixture(t),runId=await beginCatalogRun(file,'smart','ctx');
 await collectCatalogRows(file,runId,'linux',Array.from({length:120},(_,n)=>row(n)));
 const sizes=[];
 await reviewCatalog({file,directory,runId,context:'ctx',batchSize:10,
  loadDescription:async job=>{if(Number(job.sourceId)%4)throw new Error('Unavailable');return {jdText:'Complete Linux infrastructure description.'};},
  score:()=>({}),exclusions:()=>[],review:async rows=>{sizes.push(rows.length);for(const r of rows){r.aiPct=82;r.matchPct=80;r.aiReason='Linux operations fit.';}}});
 assert.deepEqual(sizes,[10,10,10]);
 const c=readCatalog(file);assert.equal(catalogSummary(c,'ctx').strong,30);assert.equal(c.runs[0].progress.descriptionErrors,90);
});

test('saved descriptions are reviewed first and a closed browser cannot mark every remaining job unavailable', async t => {
 const {file,directory}=fixture(t),runId=await beginCatalogRun(file,'smart','ctx');
 await collectCatalogRows(file,runId,'linux',Array.from({length:44},(_,n)=>row(n)));
 for(const job of Object.values(readCatalog(file).jobs).slice(-4))await saveCatalogDescription(file,directory,job,'Full cached Linux duties.');
 const calls=[];
 await assert.rejects(()=>reviewCatalog({file,directory,runId,context:'ctx',batchSize:4,reviewConcurrency:1,
  loadDescription:async()=>{throw Object.assign(new Error('Shared browser failed'),{code:'DESCRIPTION_WORKER_FAILED'});},
  score:()=>({}),exclusions:()=>[],review:async rows=>{calls.push(rows.map(r=>r.sourceId));for(const r of rows){r.aiPct=82;r.matchPct=80;r.aiReason='Linux';}}}),/Shared browser failed/);
 assert.deepEqual(calls,[['40','41','42','43']]);
 const c=readCatalog(file);assert.equal(c.runs[0].status,'interrupted');assert.equal(c.runs[0].reviewedIds.length,4);
 assert.equal(Object.values(c.jobs).filter(j=>j.descriptionError).length,0);
});

test('a thousand cached jobs survive bulk review without a hidden cap or extra website reads',async t=>{
 const {file,directory}=fixture(t),runId=await beginCatalogRun(file,'import','ctx');
 await collectCatalogRows(file,runId,'linux',Array.from({length:1000},(_,n)=>row(n)));
 await saveCatalogDescriptions(file,directory,Object.values(readCatalog(file).jobs).map(job=>({job,jdText:'Full Linux infrastructure responsibilities and requirements.'})));
 const sizes=[];
 await reviewCatalog({file,directory,runId,context:'ctx',batchSize:100,reviewConcurrency:4,
  loadDescription:()=>assert.fail('The complete CSV/cache must not trigger a website visit'),score:()=>({}),exclusions:()=>[],
  review:async rows=>{sizes.push(rows.length);for(const r of rows){r.aiPct=80;r.matchPct=80;r.aiReason='Deterministic test fixture';}}});
 const c=readCatalog(file);assert.equal(c.runs[0].status,'complete');assert.equal(c.runs[0].reviewedIds.length,1000);
 assert.equal(catalogSummary(c,'ctx').strong,1000);assert.deepEqual(sizes,Array(10).fill(100));
});
