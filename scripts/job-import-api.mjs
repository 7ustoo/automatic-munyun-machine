import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import lockfile from 'proper-lockfile';
import { getActiveProfile, paths } from './profile-store.mjs';
import { read as readConfig } from './config-rw.mjs';
import { readEmailEnv } from './email.mjs';
import { readArchive } from './batch-archive.mjs';
import { activeCatalog } from './smart-match-api.mjs';
import { aiConnection } from './ai-rerank.mjs';
import { chatgptStatus, checkSubscriptionAllowance } from './codex-subscription.mjs';
import { readCatalog, updateCatalog, withCatalogDescriptions } from './job-catalog.mjs';
import { csvJobs, normalizeImportRows, importPreview, readImport, ingestImport, MAX_CSV_BYTES } from './job-import.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function prepareJobImport(kind, fileOrArchive = '', filename = '') {
  const profile = getActiveProfile(), pp = paths(profile);
  if (kind === 'csv') {
    if (fs.statSync(fileOrArchive).size > MAX_CSV_BYTES) throw new Error('CSV must be 20 MB or smaller.');
    return importPreview(pp, profile, filename || 'Imported jobs.csv', csvJobs(fs.readFileSync(fileOrArchive, 'utf8')));
  }
  const batch = fileOrArchive ? readArchive(pp.batchArchiveDir, fileOrArchive) : JSON.parse(fs.readFileSync(pp.lastBatch, 'utf8'));
  if (!batch || !Array.isArray(batch.jobs) || !batch.jobs.length) throw new Error('There are no jobs in this saved list.');
  const hydrated = withCatalogDescriptions(batch, readCatalog(pp.jobCatalog), pp.jobDescriptions);
  const parsed = normalizeImportRows(hydrated.jobs.map(j => ({ ...j, sourceId: j.sourceId || j.id,
    description: j.description || (j.descriptionQuality === 'full' || j.__descriptionComplete ? j.jdText || j.__jd || '' : '') })), batch.keyword || 'Saved list');
  return importPreview(pp, profile, `${batch.keyword || 'My matches'} · ${batch.date || 'saved list'}`, parsed, 'batch');
}

export async function startJobImport({ id = '', run: selectedRun = '', profile: expectedProfile = '' } = {}) {
  const profile = getActiveProfile();
  if (expectedProfile !== profile) throw new Error('Profile changed. Open this list again for the current profile.');
  process.env.AMM_PROFILE = profile;
  const pp = paths(profile), config = readConfig();
  let cv;
  try { cv = JSON.parse(fs.readFileSync(pp.cvParsed, 'utf8')); } catch {}
  if (!cv || !['titles', 'skills', 'certs', 'compliance'].some(k => cv[k]?.length)) throw new Error('Upload a resume for this profile first, then review this list.');
  if (!config.scoring?.ai?.enabled) throw new Error('Enable Smart Match for this profile, then review this list.');
  const ai = aiConnection(config, readEmailEnv().AMM_AI_KEY || process.env.AMM_AI_KEY || config.scoring.ai.apiKey);
  if (!ai.configured) throw new Error('Connect ChatGPT or add an AI key in Smart Match, then review this list.');
  if (ai.connection === 'chatgpt') {
    const status = await chatgptStatus(); if (!status.connected) throw new Error(status.message);
    await checkSubscriptionAllowance();
  }
  const lock = path.join(ROOT, 'data', 'scrape.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (!fs.existsSync(lock)) fs.writeFileSync(lock, '');
  let release;
  try { release = await lockfile.lock(lock, { stale: 30000, retries: 0, realpath: false }); }
  catch { throw new Error('A scrape or review is already running. Pause it and wait for it to finish, then try this list.'); }
  let runId;
  try {
    const { context } = activeCatalog();
    if (selectedRun) {
      const run = readCatalog(pp.jobCatalog).runs.find(r => r.id === selectedRun && r.mode === 'import');
      if (!run) throw new Error('This saved-list review is not available in this profile.');
      runId = run.id;
      await updateCatalog(pp.jobCatalog, c => { c.paused = false; const r = c.runs.find(r => r.id === runId); r.status = 'pending'; r.error = ''; });
    } else runId = await ingestImport(pp, readImport(pp, id, profile), context);
  } finally { await release(); }
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'daily-batch.mjs')], {
    cwd: ROOT, env: { ...process.env, AMM_PROFILE: profile, AMM_SMART_MATCH: '1', AMM_SMART_MATCH_RUN: runId },
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('Could not start the review. Your imported jobs are saved; use Continue review to retry.'))); });
  child.unref();
  return { ok: true, run: runId, profile };
}
