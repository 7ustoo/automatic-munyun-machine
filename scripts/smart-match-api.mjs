import fs from 'node:fs';
import { read as readConfig } from './config-rw.mjs';
import { paths } from './profile-store.mjs';
import { enrichParsedResume } from './resume-parser.mjs';
import { detectAiProvider } from './ai-rerank.mjs';
import { readEmailEnv } from './email.mjs';
import { readCatalog, reviewContext, catalogPublicJob, catalogSummary, catalogAnalytics, catalogAction } from './job-catalog.mjs';
import { recordAppliedJob } from './application-ledger.mjs';
import { buildXlsx } from './xlsx-writer.mjs';

export function activeCatalog() {
  const pp = paths(), config = readConfig();
  let cv = { titles: [], certs: [], skills: [], compliance: [] };
  try { cv = enrichParsedResume(JSON.parse(fs.readFileSync(pp.cvParsed, 'utf8'))); } catch {}
  const key = readEmailEnv().AMM_AI_KEY || process.env.AMM_AI_KEY || config.scoring?.ai?.apiKey || '';
  const model = detectAiProvider(key)?.model || '';
  return { pp, config, context: reviewContext(config, { parsed: cv, text: cv.raw || '' }, model), catalog: readCatalog(pp.jobCatalog), model };
}

export function selectCatalogJobs(catalog, context, options = {}) {
  const run = options.run && catalog.runs.find(r => r.id === options.run);
  const runIds = run && new Set(run.ids);
  const search = String(options.search || '').toLowerCase();
  return Object.values(catalog.jobs).map(job => catalogPublicJob(job, context)).filter(job => {
    if (options.run && (!runIds || !runIds.has(job.id))) return false;
    if (options.keyword && !job.queries.includes(options.keyword)) return false;
    if (options.day && job.firstSeenAt.slice(0, 10) !== options.day) return false;
    if (search && !`${job.title} ${job.company} ${job.location}`.toLowerCase().includes(search)) return false;
    if (options.scope === 'results' && job.state !== 'reviewed') return false;
    if (options.scope === 'excluded' && job.state !== 'excluded') return false;
    if (options.scope === 'awaiting' && job.state !== 'awaiting') return false;
    if (options.band === 'strong' && !(job.matchPct >= 70)) return false;
    if (options.band === 'stretch' && !(job.matchPct >= 50 && job.matchPct < 70)) return false;
    return true;
  }).sort((a, b) => (b.matchPct ?? -1) - (a.matchPct ?? -1) || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function smartMatchGet(options = {}) {
  const { catalog, context, model, config } = activeCatalog();
  const jobs = selectCatalogJobs(catalog, context, options);
  const page = Math.max(0, parseInt(options.page) || 0), size = 40;
  return { ok: true, summary: catalogSummary(catalog, context), jobs: jobs.slice(page * size, (page + 1) * size),
    keywords: [...new Set(Object.values(catalog.jobs).flatMap(job => Object.keys(job.queries || {})))].sort(),
    total: jobs.length, page, pages: Math.ceil(jobs.length / size), paused: catalog.paused,
    run: catalog.runs.at(-1) ? { ...catalog.runs.at(-1), ids: undefined, newIds: undefined, reviewedIds: undefined, reusedIds: undefined, terms: undefined } : null,
    model, floor: config.scoring?.matchFloorPercent ?? 70 };
}

export function smartTrendsGet(options = {}) {
  const { catalog, context, pp } = activeCatalog();
  const days = options.days !== '' && options.days != null && [0, 7, 30, 90].includes(Number(options.days)) ? Number(options.days) : 30;
  const keywords = [...new Set(Object.values(catalog.jobs).flatMap(j => Object.keys(j.queries || {})))].sort();
  const filteredJobs = Object.fromEntries(Object.entries(catalog.jobs).filter(([, j]) => Object.hasOwn(j.queries || {}, options.keyword))
    .map(([id, job]) => [id, { ...job, queries: { [options.keyword]: job.queries[options.keyword] } }]));
  const filtered = options.keyword ? { ...catalog, jobs: filteredJobs,
    runs: catalog.runs.map(r => ({ ...r,
      ...Object.fromEntries(['ids', 'newIds', 'reviewedIds', 'reusedIds'].map(field => [field, r[field].filter(id => filteredJobs[id])])),
      terms: Object.fromEntries(Object.entries(r.terms).filter(([term]) => term === options.keyword)),
      coverage: r.coverage.filter(item => item.query === options.keyword),
    })).filter(r => r.ids.length || Object.keys(r.terms).length) } : catalog;
  let legacy = [];
  try { const history = JSON.parse(fs.readFileSync(pp.batchHistory, 'utf8')); legacy = Array.isArray(history) ? history : history.days || history.history || []; } catch {}
  if (options.keyword) legacy = legacy.filter(day => day.terms?.[options.keyword]).map(day => {
    const term = day.terms[options.keyword];
    return { ...day, sent: term.count, strongCount: term.strong, avgPct: term.avgPct, terms: { [options.keyword]: term } };
  });
  const firstCatalogDate = catalog.runs[0]?.startedAt?.slice(0, 10);
  const cutoff = days ? new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10) : '';
  return { ok: true, ...catalogAnalytics(filtered, context, days), allKeywords: keywords,
    legacy: legacy.filter(entry => (!firstCatalogDate || entry.date < firstCatalogDate) && (!cutoff || entry.date >= cutoff)), note: 'Collection hits include repeat sightings. Unique jobs are counted once. Keyword totals can overlap. Scores describe the current review of jobs first collected in the selected period; excluded is a separate status.' };
}

export async function smartMatchAction(action, id) {
  const { pp, catalog } = activeCatalog();
  if (action === 'applied') {
    const job = catalog.jobs[id];
    if (!job) throw new Error('Job is missing from this profile.');
    await recordAppliedJob(pp.appliedJobs, job, job.directUrl || job.href);
  }
  await catalogAction(pp.jobCatalog, action, id);
  return { ok: true };
}

export function smartMatchExport(format, options = {}) {
  const { catalog, context } = activeCatalog();
  const jobs = selectCatalogJobs(catalog, context, options);
  const headers = ['Job title', 'Company', 'Location', 'Direct apply link', 'Match %', 'Status', 'Reason', 'Search keywords', 'First collected', 'Last collected'];
  const rows = jobs.map(j => [j.title, j.company, j.location, j.directUrl, j.matchPct ?? '', j.state,
    [...j.exclusions, j.aiReason, j.descriptionError].filter(Boolean).join(' | '), j.queries.join('; '), j.firstSeenAt, j.lastSeenAt]);
  const filename = `Smart Match - ${['results', 'excluded', 'awaiting'].includes(options.scope) ? options.scope : 'job history'} - ${new Date().toISOString().slice(0, 10)}`;
  if (format === 'xlsx') return { ok: true, filename: filename + '.xlsx', contentBase64: buildXlsx({ sheetName: 'Smart Match', columns: headers.map((header, i) => ({ header, width: i === 3 ? 75 : i === 6 ? 90 : 26, hyperlink: i === 3 })), rows }).toString('base64') };
  const cell = v => '"' + String(v).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
  return { ok: true, filename: filename + '.csv', content: '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n' };
}
