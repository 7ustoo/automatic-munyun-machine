import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import lockfile from 'proper-lockfile';
import { chromium } from 'playwright-core';
import { resolveBrowser } from './browser-launcher.mjs';
import { paths } from './profile-store.mjs';
import { readCatalog, updateCatalog, readCatalogDescription, saveCollectedDescriptions } from './job-catalog.mjs';
import { collectedDescription } from './hcafe-descriptions.mjs';
import { createEmployerDescriptionLoader } from './employer-description.mjs';
import { createReviewDescriptionLoader } from './review-description-loader.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function queueDescriptionEnrichment(file,runId,ids) {
  await updateCatalog(file,c=>{
    const run=c.runs.find(r=>r.id===runId);
    if(!run)throw new Error('Description collection run is missing.');
    const selected = ids ? [...new Set(ids)].filter(id=>run.ids.includes(id)&&c.jobs[id]) : [...run.ids];
    run.enrichment={status:'queued',ids:selected,checkedIds:[],available:0,unavailable:0,total:selected.length,heartbeatAt:new Date().toISOString()};
    for(const id of selected) if(c.jobs[id].needsDescription||!c.jobs[id].descriptionHash)c.jobs[id].descriptionError='';
  });
}

export async function startDescriptionEnrichment(profile,runId,ids) {
  const pp=paths(profile);
  await queueDescriptionEnrichment(pp.jobCatalog,runId,ids);
  const child=spawn(process.execPath,[path.join(ROOT,'scripts','description-enrichment.mjs'),profile],{
    cwd:ROOT,env:{...process.env,AMM_PROFILE:profile},detached:true,windowsHide:true,stdio:'ignore',
  });
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  await updateCatalog(pp.jobCatalog,c=>{const state=c.runs.find(r=>r.id===runId)?.enrichment;if(state)state.workerPid=child.pid;});
  child.unref();
}

// No AI, application actions or global scrape lock. Yield to foreground work.
export async function enrichQueuedDescriptions({file,directory,collect,shouldYield=()=>false,wait=delay}) {
  while(true) {
    if(readCatalog(file).paused)return;
    if(shouldYield()){await wait(1000);continue;}
    const snapshot=readCatalog(file);
    const run=snapshot.runs.filter(r=>r.enrichment&&['queued','running','interrupted'].includes(r.enrichment.status)).at(-1);
    if(!run)return;
    const checked=new Set(run.enrichment.checkedIds);
    const ids=(run.enrichment.ids||run.ids).filter(id=>snapshot.jobs[id]&&!checked.has(id)).slice(0,20);
    if(!ids.length){await updateCatalog(file,c=>{c.runs.find(r=>r.id===run.id).enrichment.status=run.enrichment.unavailable?'partial':'complete';});continue;}
    await updateCatalog(file,c=>Object.assign(c.runs.find(r=>r.id===run.id).enrichment,{status:'running',workerPid:process.pid,heartbeatAt:new Date().toISOString()}));
    const rows=ids.map(id=>{
      const job=snapshot.jobs[id],text=!job.needsDescription&&readCatalogDescription(directory,id);
      return {...job,viewjobUrl:job.href,...(text?{description:text,descriptionQuality:'full'}:{})};
    });
    await collect(rows);
    await saveCollectedDescriptions(file,directory,rows);
    await updateCatalog(file,c=>{
      const state=c.runs.find(r=>r.id===run.id).enrichment;
      for(const row of rows){
        const job=c.jobs[row.id];
        if(!job||job.sourceHash!==row.sourceHash)continue;
        if(!state.checkedIds.includes(row.id)){
          state.checkedIds.push(row.id);
          if(collectedDescription(row))state.available++;else state.unavailable++;
        }
        if(!collectedDescription(row))job.descriptionError=row.descriptionError||'HiringCafe description unavailable.';
      }
      state.heartbeatAt=new Date().toISOString();
    });
  }
}

async function main(profile) {
  if(typeof profile!=='string'||profile.length>32||!/^[a-z0-9_-]+(?: [a-z0-9_-]+)*$/i.test(profile))throw new Error('Invalid description profile.');
  const pp=paths(profile),lock=path.join(pp.dir,'description-enrichment.lock');
  fs.mkdirSync(pp.dir,{recursive:true});if(!fs.existsSync(lock))fs.writeFileSync(lock,'');
  let release;
  try{release=await lockfile.lock(lock,{stale:30000,retries:{retries:35,factor:1,minTimeout:1000,maxTimeout:1000},realpath:false});}
  catch(error){if(error.code==='ELOCKED')return;throw error;}
  const employerLoader = createEmployerDescriptionLoader();
  const loader = createReviewDescriptionLoader({ employerLoader, openContext: async()=>{
    const browser=await resolveBrowser();
    return chromium.launchPersistentContext(path.join(pp.dir,'description-browser'),{...browser.launchOptions,headless:false,args:['--window-position=10000,10000','--disable-blink-features=AutomationControlled']});
  }});
  const foreground=()=>{try{return Date.now()-fs.statSync(path.join(ROOT,'data','scrape.lock.lock')).mtimeMs<30000;}catch{return false;}};
  let heartbeatWrite;
  const heartbeat=setInterval(()=>{
    if(!heartbeatWrite)heartbeatWrite=updateCatalog(pp.jobCatalog,c=>{
      for(const run of c.runs)if(run.enrichment?.workerPid===process.pid&&['queued','running'].includes(run.enrichment.status))run.enrichment.heartbeatAt=new Date().toISOString();
    }).catch(()=>{}).finally(()=>{heartbeatWrite=null;});
  },5000);
  heartbeat.unref?.();
  try{
    await enrichQueuedDescriptions({file:pp.jobCatalog,directory:pp.jobDescriptions,shouldYield:foreground,
      collect:async rows=>{
        await collectBackgroundDescriptions(rows,loader);
      }});
  }catch(error){
    await updateCatalog(pp.jobCatalog,c=>{for(const run of c.runs)if(run.enrichment?.workerPid===process.pid&&run.enrichment.status==='running')Object.assign(run.enrichment,{status:'interrupted',error:String(error.message).slice(0,180)});}).catch(()=>{});
    throw error;
  }finally{clearInterval(heartbeat);await heartbeatWrite;await loader.close();await release().catch(()=>{});}
}

export async function collectBackgroundDescriptions(rows,loader,concurrency=4) {
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(concurrency,rows.length)},async()=>{
    while(cursor<rows.length){
      const row=rows[cursor++];if(collectedDescription(row))continue;
      try{
        const result=await loader(row);
        if(!result?.jdText||result.descriptionQuality!=='full')throw new Error('Full job description unavailable.');
        Object.assign(row,{description:result.jdText,descriptionQuality:'full',descriptionError:''});
      }catch(error){
        if(error.code==='DESCRIPTION_WORKER_FAILED')throw error;
        row.descriptionQuality='missing';row.descriptionError=String(error.message).slice(0,180);
      }
    }
  }));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv[2]).catch(()=>{process.exitCode=1;});
