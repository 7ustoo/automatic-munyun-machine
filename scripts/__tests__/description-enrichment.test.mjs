import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {queueDescriptionEnrichment,enrichQueuedDescriptions,collectBackgroundDescriptions} from '../description-enrichment.mjs';
import {beginCatalogRun,collectCatalogRows,readCatalog,withCatalogDescriptions,readCatalogDescription} from '../job-catalog.mjs';
import {exportRows,buildExportCsv} from '../export-batch.mjs';
import {csvJobs} from '../job-import.mjs';
import {describeBatchDescriptions} from '../batch-description-api.mjs';

async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amm-background-jd-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'catalog.json'),directory=path.join(dir,'descriptions');
  const run=await beginCatalogRun(file,'keyword','ctx');
  const rows=[1,2].map(n=>({sourceId:String(n),source:'hcafe',title:'Platform Engineer',directUrl:`https://jobs.example.com/${n}`,viewjobUrl:`https://hiringcafe.com/job/${n}`}));
  await collectCatalogRows(file,run,'cloud',rows);await queueDescriptionEnrichment(file,run);
  return {file,directory,run,rows,batch:{jobs:rows.map((r,i)=>({...r,idx:i+1,descriptionQuality:'missing',descriptionError:'Pending background loading'}))}};
}
const full='Responsibilities\nOperate Linux and AWS. Build Terraform and CI/CD pipelines.\nRequirements\nPython, Bash, monitoring and incident response.';

test('one throttled posting does not label unattempted employer descriptions unavailable',async()=>{
 const rows=[1,2,3].map(id=>({id:String(id)}));let calls=0;
 await collectBackgroundDescriptions(rows,async row=>{calls++;if(row.id==='1')throw new Error('HTTP 429');return {jdText:full,descriptionQuality:'full'};});
 assert.equal(calls,3);assert.match(rows[0].descriptionError,/429/);assert.equal(rows[1].description,full);assert.equal(rows[2].description,full);
});

test('a counted scrape enriches only published job IDs and reports actual CSV readiness',async t=>{
 const f=await fixture(t);let catalog=readCatalog(f.file),ids=Object.keys(catalog.jobs);
 await queueDescriptionEnrichment(f.file,f.run,[ids[0]]);
 let read=0;await enrichQueuedDescriptions({...f,collect:async rows=>{read+=rows.length;for(const r of rows)Object.assign(r,{description:full,descriptionQuality:'full'});}});
 catalog=readCatalog(f.file);assert.equal(read,1);assert.equal(catalog.runs[0].enrichment.total,1);
 const status=describeBatchDescriptions(f.batch,catalog,f.directory);
 assert.equal(status.total,2);assert.equal(status.available,1);assert.equal(status.pending,1);assert.equal(status.loading,false);
});
test('queued enrichment checkpoints JDs independently; later CSV downloads acquire them without changing batch identity',async t=>{
  const f=await fixture(t);const before=withCatalogDescriptions(f.batch,readCatalog(f.file),f.directory);
  assert.equal(before.jobs.length,2);assert.equal(before.jobs[0].description,undefined);
  await enrichQueuedDescriptions({...f,collect:async rows=>{for(const r of rows)Object.assign(r,{description:full,descriptionQuality:'full'});}});
  const c=readCatalog(f.file);assert.equal(c.runs[0].enrichment.status,'complete');assert.equal(c.runs[0].enrichment.available,2);
  const after=withCatalogDescriptions(f.batch,c,f.directory);const parsed=csvJobs(buildExportCsv(exportRows(after)));
  assert.equal(parsed.rows.length,2);assert.equal(parsed.rows[0].description,full);assert.equal(parsed.rows[0].directUrl,f.rows[0].directUrl);
  assert.equal(f.batch.jobs[0].description,undefined,'Published snapshot stays unchanged');
});
test('background enrichment yields to foreground work and does not invoke a matching provider',async t=>{
  const f=await fixture(t);let foreground=true,waits=0,reads=0;
  await enrichQueuedDescriptions({...f,shouldYield:()=>foreground,wait:async()=>{waits++;assert.equal(reads,0);foreground=false;},
    collect:async rows=>{reads++;for(const r of rows)Object.assign(r,{description:full,descriptionQuality:'full'});}});
  assert.equal(waits,1);assert.equal(reads,1);
});
test('unavailable background descriptions keep application links and finish as partial without endless retries',async t=>{
  const f=await fixture(t);let calls=0;
  await enrichQueuedDescriptions({...f,collect:async rows=>{calls++;for(const r of rows)r.descriptionError='HiringCafe HTTP 403';}});
  const c=readCatalog(f.file);assert.equal(calls,1);assert.equal(c.runs[0].enrichment.status,'partial');
  const rows=withCatalogDescriptions(f.batch,c,f.directory).jobs;assert.equal(rows[0].directUrl,f.rows[0].directUrl);assert.match(rows[0].descriptionError,/403/);
});
test('a changed posting cannot receive a stale background description',async t=>{
  const f=await fixture(t);let calls=0;
  await enrichQueuedDescriptions({...f,collect:async rows=>{
    calls++;
    if(calls===1)await collectCatalogRows(f.file,f.run,'cloud',f.rows.map(r=>({...r,sourceVersion:'changed'})));
    for(const r of rows)Object.assign(r,{description:calls===1?'Stale text':full,descriptionQuality:'full'});
  }});
  assert.equal(calls,2);const c=readCatalog(f.file);for(const job of Object.values(c.jobs))assert.equal(readCatalogDescription(f.directory,job.id),full);
});
