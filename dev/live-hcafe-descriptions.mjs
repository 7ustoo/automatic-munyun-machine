// Read-only live probe: isolated browser/temp catalog, no profile/seen writes or AI requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { resolveBrowser } from '../scripts/browser-launcher.mjs';
import { keywordSearchExtractor, createApplyLinkCollector } from '../scripts/hcafe-apply-links.mjs';
import { createHiringCafeDescriptionCollector } from '../scripts/hcafe-descriptions.mjs';
import { beginCatalogRun, collectCatalogRows, readCatalog, readCatalogDescription, withCatalogDescriptions } from '../scripts/job-catalog.mjs';
import { queueDescriptionEnrichment, enrichQueuedDescriptions } from '../scripts/description-enrichment.mjs';
import { exportRows, buildExportCsv } from '../scripts/export-batch.mjs';
import { csvJobs, importPreview, ingestImport, readImport } from '../scripts/job-import.mjs';
import { reviewCatalog } from '../scripts/catalog-review.mjs';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'amm-live-description-'));
const browser=await resolveBrowser();
const ctx=await chromium.launch({...browser.launchOptions,headless:false,args:['--window-position=10000,10000','--disable-blink-features=AutomationControlled']});
try {
  const page=await ctx.newPage();
  const searchState={searchQuery:'cloud engineer',workplaceTypes:['Remote'],sortBy:'date',dateFetchedPastNDays:-1};
  await page.goto('https://hiringcafe.com/?searchState='+encodeURIComponent(JSON.stringify(searchState)),{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(()=>!!document.querySelector('#__NEXT_DATA__'),null,{timeout:20000});
  const candidates=await page.evaluate(keywordSearchExtractor('[]'));
  assert.ok(candidates.length>1,'Live search returned too few source records');
  const links=createApplyLinkCollector({context:ctx,limit:3});
  await links.collect(candidates);
  const rows=links.rows();await links.close();
  const employerHosts=new Set(rows.map(r=>new URL(r.directUrl).hostname));let employerNavigations=0;
  ctx.on('request',r=>{if(r.isNavigationRequest()&&employerHosts.has(new URL(r.url()).hostname))employerNavigations++;});
  const cache={},descriptions=createHiringCafeDescriptionCollector({context:ctx,cache,log:console.log});
  await descriptions.collect(rows,{fetchMissing:false});
  assert.equal(rows.length,3);assert.ok(rows.every(r=>!r.description),'Fast publication must not wait for descriptions');
  const pp={jobCatalog:path.join(temporary,'catalog.json'),jobDescriptions:path.join(temporary,'descriptions'),jobImports:path.join(temporary,'imports')};
  const run=await beginCatalogRun(pp.jobCatalog,'keyword','test');
  await collectCatalogRows(pp.jobCatalog,run,'cloud engineer',rows);
  await queueDescriptionEnrichment(pp.jobCatalog,run);
  await enrichQueuedDescriptions({file:pp.jobCatalog,directory:pp.jobDescriptions,collect:items=>descriptions.collect(items)});
  await descriptions.close();
  assert.equal(readCatalog(pp.jobCatalog).runs[0].enrichment.status,'complete');
  for(const job of Object.values(readCatalog(pp.jobCatalog).jobs))assert.ok(readCatalogDescription(pp.jobDescriptions,job.id).length>250);
  const batch={funnel:{directApplyLinks:true},jobs:rows.map((r,i)=>({...r,idx:i+1}))};
  const hydrated=withCatalogDescriptions(batch,readCatalog(pp.jobCatalog),pp.jobDescriptions);
  assert.ok(hydrated.jobs.every(r=>r.description?.length>250),'Later downloads must acquire the full JDs');
  const csv=buildExportCsv(exportRows(hydrated));const parsed=csvJobs(csv);
  assert.equal(parsed.rows.length,3);
  parsed.rows.forEach((r,i)=>{assert.equal(r.description,hydrated.jobs[i].description);assert.equal(r.directUrl,rows[i].directUrl);assert.equal(r.viewjobUrl,rows[i].viewjobUrl);});
  const preview=importPreview(pp,'test','fresh.csv',parsed);const importRun=await ingestImport(pp,readImport(pp,preview.id,'test'),'test');
  let reviewed=0,websiteReads=0;
  await reviewCatalog({file:pp.jobCatalog,directory:pp.jobDescriptions,runId:importRun,context:'test',
    loadDescription:async()=>{websiteReads++;throw Error('Must reuse collected text');},score:()=>({matchPct:75}),exclusions:()=>[],
    review:async batch=>{reviewed+=batch.length;for(const row of batch){row.aiPct=80;row.matchPct=78;}}});
  assert.equal(reviewed,3);assert.equal(websiteReads,0);assert.equal(employerNavigations,0);
  const reused=createHiringCafeDescriptionCollector({context:ctx,cache,read:async()=>{throw Error('Cached descriptions must not reload');}});
  const repeat=rows.map(({description,jdText,__descriptionComplete,descriptionQuality,...row})=>row);
  await reused.collect(repeat);await reused.close();assert.equal(reused.stats.cached,3);
  console.log(JSON.stringify({jobs:rows.length,fastPublication:true,backgroundComplete:true,descriptionLengths:hydrated.jobs.map(r=>r.description.length),csvBytes:Buffer.byteLength(csv),
    csvRoundTrip:true,savedListReviewWithoutWebsiteReads:true,cacheHits:reused.stats.cached,employerNavigations,aiRequests:0}));
} finally {
  await ctx.close();
  if(path.dirname(temporary)!==path.resolve(os.tmpdir())||!path.basename(temporary).startsWith('amm-live-description-'))throw Error('Unexpected temporary directory');
  fs.rmSync(temporary,{recursive:true,force:true});
}
