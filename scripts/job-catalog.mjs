import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteJson, withFileLock } from './io-helpers.mjs';
import { directApplyKey, directApplyUrl, keywordListingUrl } from './hcafe-apply-links.mjs';

export const catalogHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const emptyCatalog = () => ({ version: 1, jobs: {}, aliases: {}, runs: [], paused: false });

export function readCatalog(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return emptyCatalog();
    const catalog = JSON.parse(text);
    if (catalog.version !== 1 || !catalog.jobs || !catalog.aliases || !Array.isArray(catalog.runs)) throw new Error('schema');
    return catalog;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyCatalog();
    throw new Error('Saved job history could not be read. Restore its backup before collecting more jobs.');
  }
}

export async function updateCatalog(file, mutate) {
  return withFileLock(file, () => {
    const catalog = readCatalog(file);
    const result = mutate(catalog);
    atomicWriteJson(file, catalog);
    return result;
  });
}

export function reviewContext(config, resume, model) {
  const { apiKey, ...ai } = config.scoring?.ai || {};
  return catalogHash({ version: 1, resume, model, filters: config.filters, user: config.user,
    search: config.search, queries: config.queries, scoring: { ...config.scoring, ai } });
}

export async function beginCatalogRun(file, mode, context, options = {}) {
  const id = randomUUID();
  await updateCatalog(file, catalog => {
    catalog.paused = false;
    catalog.runs.push({ id, mode, context, startedAt: new Date().toISOString(), status: options.resume ? 'reviewing' : 'collecting',
      terms: {}, ids: [], newIds: [], reviewedIds: [], reusedIds: [], coverage: [], resume: !!options.resume });
  });
  return id;
}

function aliasesFor(row) {
  const aliases = [];
  const direct = directApplyKey(row.directUrl);
  if (direct) aliases.push(`apply:${direct}`);
  if (row.sourceId) aliases.push(`${row.source || 'hcafe'}:${row.sourceId}`);
  const listing = keywordListingUrl(row.viewjobUrl || row.href);
  if (listing) aliases.push(`listing:${new URL(listing).pathname}`);
  return aliases;
}

function mergeAliases(catalog, aliases) {
  const ids = [...new Set(aliases.map(alias => catalog.aliases[alias]).filter(Boolean))]
    .sort((a, b) => catalog.jobs[a].firstSeenAt.localeCompare(catalog.jobs[b].firstSeenAt));
  const id = ids[0];
  for (const duplicate of ids.slice(1)) {
    const keep = catalog.jobs[id], other = catalog.jobs[duplicate];
    keep.queries = { ...other.queries, ...keep.queries };
    keep.events = [...(other.events || []), ...(keep.events || [])];
    keep.appliedAt ||= other.appliedAt;
    keep.override ||= other.override;
    if (!keep.review || other.review?.at > keep.review.at) keep.review = other.review;
    for (const [alias, value] of Object.entries(catalog.aliases)) if (value === duplicate) catalog.aliases[alias] = id;
    for (const run of catalog.runs) {
      for (const field of ['ids', 'newIds', 'reviewedIds', 'reusedIds']) run[field] = [...new Set(run[field].map(value => value === duplicate ? id : value))];
      for (const term of Object.values(run.terms)) for (const page of Object.values(term.pages)) page.ids = [...new Set(page.ids.map(value => value === duplicate ? id : value))];
    }
    delete catalog.jobs[duplicate];
  }
  return id;
}

export async function collectCatalogRows(file, runId, term, rows, pageKey = '0') {
  return updateCatalog(file, catalog => {
    const run = catalog.runs.find(item => item.id === runId);
    if (!run) throw new Error('Collection run is missing');
    const pageIds = new Set();
    const now = new Date().toISOString();
    for (const row of rows) {
      const aliases = aliasesFor(row);
      if (!aliases.length) continue;
      const id = mergeAliases(catalog, aliases) || catalogHash(aliases[0]).slice(0, 24);
      const previous = catalog.jobs[id];
      const sourceHash = catalogHash({ title: row.title, company: row.company, location: row.location,
        sourceVersion: row.sourceVersion || '', summary: row.cardText || '', directUrl: row.directUrl || '' });
      const metadata = {
        sourceId: row.sourceId || previous?.sourceId || '', source: row.source || previous?.source || 'hcafe',
        title: String(row.title || previous?.title || '(untitled)').slice(0, 500),
        company: String(row.company || previous?.company || '').slice(0, 300),
        location: String(row.location || previous?.location || '').slice(0, 500),
        href: keywordListingUrl(row.viewjobUrl || row.href) || previous?.href || '',
        directUrl: directApplyUrl(row.directUrl) || previous?.directUrl || '',
        yoe: row.yoe ?? previous?.yoe ?? null, sourceHash, lastSeenAt: now,
      };
      catalog.jobs[id] = { ...previous, ...metadata, id, firstSeenAt: previous?.firstSeenAt || now,
        queries: { ...previous?.queries, [term]: previous?.queries?.[term] || now },
        needsDescription: previous?.needsDescription || !previous?.descriptionHash || previous.sourceHash !== sourceHash
          || Date.now() - Date.parse(previous.descriptionAt || 0) > 24 * 60 * 60 * 1000,
      };
      for (const alias of aliases) catalog.aliases[alias] = id;
      if (!previous && !run.newIds.includes(id)) run.newIds.push(id);
      if (!run.ids.includes(id)) run.ids.push(id);
      pageIds.add(id);
    }
    run.terms[term] ||= { pages: {} };
    run.terms[term].pages[String(pageKey)] = { hits: rows.length, ids: [...pageIds].filter(id => catalog.jobs[id]) };
    return { collected: run.ids.length, newJobs: run.newIds.length };
  });
}

export async function saveCatalogDescription(file, directory, job, description, directUrl) {
  const text = String(description || '').trim().slice(0, 40000);
  if (!text) return;
  return updateCatalog(file, catalog => {
    let current = catalog.jobs[job.id];
    if (!current || current.sourceHash !== job.sourceHash) return;
    if (directApplyUrl(directUrl)) {
      const aliases = aliasesFor({ ...current, directUrl });
      const id = mergeAliases(catalog, aliases) || current.id;
      current = catalog.jobs[id];
      for (const alias of aliases) catalog.aliases[alias] = id;
      current.directUrl = directApplyUrl(directUrl);
    }
    atomicWriteJson(path.join(directory, `${current.id}.json`), { text });
    current.descriptionHash = catalogHash(text);
    current.descriptionAt = new Date().toISOString();
    current.needsDescription = false;
    current.descriptionError = '';
    return current.id;
  });
}

export function readCatalogDescription(directory, id) {
  if (!/^[a-f0-9]{24}$/.test(id)) return '';
  try { return String(JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), 'utf8')).text || ''); }
  catch { return ''; }
}

export function catalogJobState(job, context) {
  if (job.appliedAt) return 'applied';
  if (job.override === 'excluded') return 'excluded';
  if (!job.review || job.forceReview || job.needsDescription || (context && job.review.context !== context)) return 'awaiting';
  if (job.override === 'included') return 'reviewed';
  return job.review.exclusions?.length ? 'excluded' : 'reviewed';
}

export function catalogPublicJob(job, context) {
  const state = catalogJobState(job, context);
  const current = state !== 'awaiting';
  return { id: job.id, title: job.title, company: job.company, location: job.location, directUrl: job.directUrl,
    viewjobUrl: job.href, firstSeenAt: job.firstSeenAt, lastSeenAt: job.lastSeenAt, queries: Object.keys(job.queries || {}),
    state, appliedAt: job.appliedAt || null, override: job.override || '', matchPct: current ? job.review?.matchPct ?? null : null,
    lastMatchPct: job.review?.matchPct ?? null, aiPct: current ? job.review?.aiPct ?? null : null,
    aiReason: job.review?.reason || '', exclusions: job.override === 'excluded' ? ['Excluded manually.'] : job.review?.exclusions || [],
    reviewedAt: job.review?.at || null, descriptionError: job.descriptionError || '',
    reviewHistory: job.reviewHistory || [], events: job.events || [] };
}

export async function catalogAction(file, action, id) {
  const allowed = ['pause', 'continue', 'recheck-all', 'recheck', 'restore', 'exclude', 'applied'];
  if (!allowed.includes(action)) throw new Error('Unknown Smart Match action');
  await updateCatalog(file, catalog => {
    if (action === 'pause' || action === 'continue') { catalog.paused = action === 'pause'; return; }
    if (action === 'recheck-all') {
      for (const job of Object.values(catalog.jobs)) if (!job.appliedAt) { job.forceReview = true; job.forceReviewAt = new Date().toISOString(); }
      return;
    }
    const job = /^[a-f0-9]{24}$/.test(id || '') && Object.hasOwn(catalog.jobs, id) ? catalog.jobs[id] : null;
    if (!job) throw new Error('That job is no longer in this profile');
    const at = new Date().toISOString();
    if (action === 'recheck') { job.forceReview = true; job.forceReviewAt = at; }
    if (action === 'restore') job.override = 'included';
    if (action === 'exclude') job.override = 'excluded';
    if (action === 'applied') job.appliedAt = at;
    job.events ||= [];
    job.events.push({ action, at });
  });
}

export function catalogSummary(catalog, context) {
  const summary = { unique: 0, strong: 0, stretch: 0, below: 0, pending: 0, excluded: 0, applied: 0 };
  for (const job of Object.values(catalog.jobs)) {
    summary.unique++;
    const state = catalogJobState(job, context);
    if (state === 'excluded') summary.excluded++;
    if (state === 'applied') summary.applied++;
    if (!job.review || state === 'awaiting') { summary.pending++; continue; }
    const score = job.review.matchPct;
    if (score >= 70) summary.strong++;
    else if (score >= 50) summary.stretch++;
    else summary.below++;
  }
  return summary;
}

export function catalogAnalytics(catalog, context, days = 30) {
  const cutoff = days === 0 ? '' : new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const selected = Object.values(catalog.jobs).filter(job => !cutoff || job.firstSeenAt.slice(0, 10) >= cutoff);
  const subset = { ...catalog, jobs: Object.fromEntries(selected.map(job => [job.id, job])) };
  const totals = { ...catalogSummary(subset, context), hits: 0 };
  const daily = {};
  const terms = {};
  const ensureDay = date => daily[date] ||= { date, hits: 0, unique: 0, strong: 0, stretch: 0, below: 0, pending: 0, terms: {} };
  for (const run of catalog.runs) {
    const date = run.startedAt.slice(0, 10);
    if (cutoff && date < cutoff) continue;
    for (const [term, source] of Object.entries(run.terms)) {
      const hits = Object.values(source.pages).reduce((sum, page) => sum + page.hits, 0);
      totals.hits += hits;
      const day = ensureDay(date);
      day.hits += hits;
      day.terms[term] ||= { hits: 0 };
      day.terms[term].hits += hits;
      terms[term] ||= { term, hits: 0, unique: 0, strong: 0, stretch: 0, below: 0, pending: 0 };
      terms[term].hits += hits;
    }
  }
  for (const job of selected) {
    const state = catalogJobState(job, context);
    const band = !job.review || state === 'awaiting' ? 'pending' : job.review.matchPct >= 70 ? 'strong' : job.review.matchPct >= 50 ? 'stretch' : 'below';
    const day = ensureDay(job.firstSeenAt.slice(0, 10));
    day.unique++;
    day[band]++;
    for (const term of Object.keys(job.queries || {})) {
      day.terms[term] ||= { hits: 0 };
      day.terms[term].unique = (day.terms[term].unique || 0) + 1;
      day.terms[term][band] = (day.terms[term][band] || 0) + 1;
      terms[term] ||= { term, hits: 0, unique: 0, strong: 0, stretch: 0, below: 0, pending: 0 };
      terms[term].unique++;
      terms[term][band]++;
    }
  }
  return { totals, days: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)), keywords: Object.values(terms),
    runs: catalog.runs.filter(run => !cutoff || run.startedAt.slice(0, 10) >= cutoff).map(run => ({
      id: run.id, at: run.startedAt, status: run.status, error: run.error || '', unique: run.ids.length, newJobs: run.newIds.length,
      reviewed: run.reviewedIds.length, coverage: run.coverage,
      terms: Object.fromEntries(Object.entries(run.terms).map(([term, source]) => [term, {
        hits: Object.values(source.pages).reduce((sum, page) => sum + page.hits, 0),
        unique: new Set(Object.values(source.pages).flatMap(page => page.ids)).size,
      }])),
    })).reverse() };
}
