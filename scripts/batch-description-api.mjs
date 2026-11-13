import fs from 'node:fs';
import { paths, getActiveProfile } from './profile-store.mjs';
import { directApplyKey, keywordListingUrl } from './hcafe-apply-links.mjs';
import { readCatalog, withCatalogDescriptions } from './job-catalog.mjs';
import { startDescriptionEnrichment } from './description-enrichment.mjs';

export function batchCatalogIds(batch,catalog) {
  return [...new Set((batch.jobs||[]).map(row=>catalog.aliases[`apply:${directApplyKey(row.directUrl)}`]
    || (keywordListingUrl(row.viewjobUrl)&&catalog.aliases[`listing:${new URL(row.viewjobUrl).pathname}`])).filter(Boolean))];
}

export function describeBatchDescriptions(batch,catalog,directory,{isAlive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}={}) {
  const ids=batchCatalogIds(batch,catalog);
  const run=catalog.runs.filter(r=>r.enrichment&&ids.length&&ids.every(id=>r.ids.includes(id))).at(-1);
  const enrichment=run?.enrichment;
  const queued=enrichment?.status==='queued'&&(Number.isInteger(enrichment.workerPid)
    ?Date.now()-Date.parse(enrichment.heartbeatAt)<60000&&isAlive(enrichment.workerPid)
    :Date.now()-Date.parse(enrichment.heartbeatAt)<30000);
  const loading=queued||(enrichment?.status==='running'&&Number.isInteger(enrichment.workerPid)
    &&Date.now()-Date.parse(enrichment.heartbeatAt)<60000&&isAlive(enrichment.workerPid));
  const rows=withCatalogDescriptions(batch,catalog,directory).jobs;
  const available=rows.filter(row=>row.descriptionQuality==='full'&&row.description).length;
  const checked=new Set(enrichment?.checkedIds||[]);
  const unavailable=rows.filter(row=>!(row.descriptionQuality==='full'&&row.description)
    &&batchCatalogIds({jobs:[row]},catalog).some(id=>checked.has(id)&&catalog.jobs[id]?.descriptionError)).length;
  return {ok:true,total:rows.length,available,unavailable,pending:Math.max(0,rows.length-available-unavailable),
    loading:!!loading,status:loading?'loading':available===rows.length?'complete':enrichment?.status==='running'?'interrupted':enrichment?.status||'pending',
    generatedAt:batch.generatedAt,run:run?.id||'',ids};
}

export function batchDescriptionsGet() {
  const pp=paths(),batch=JSON.parse(fs.readFileSync(pp.lastBatch,'utf8')),catalog=readCatalog(pp.jobCatalog);
  return {...describeBatchDescriptions(batch,catalog,pp.jobDescriptions),profile:getActiveProfile()};
}

export async function batchDescriptionsRetry({profile,generatedAt}) {
  if(profile!==getActiveProfile())throw new Error('Profile changed. Refresh this list before loading descriptions.');
  const pp=paths(),batch=JSON.parse(fs.readFileSync(pp.lastBatch,'utf8')),catalog=readCatalog(pp.jobCatalog);
  if(batch.generatedAt!==generatedAt)throw new Error('A newer list is available. Refresh before loading descriptions.');
  const status=describeBatchDescriptions(batch,catalog,pp.jobDescriptions);
  if(status.loading)return {ok:true,alreadyRunning:true};
  if(!status.run||status.ids.length!==batch.jobs.length)throw new Error('Use Smart match this list to add this saved list to job history first.');
  await startDescriptionEnrichment(profile,status.run,status.ids);
  return {ok:true,total:status.ids.length};
}
