/**
 * ATS source aggregator (v5.0).
 *
 * Fetches every configured company board across Greenhouse / Lever / Ashby in
 * parallel, dedups by URL, and filters by the user's workplace preference.
 * Best-effort: any single board failing yields [] for that board, never throws.
 * Additive to the hiring.cafe scrape — inert when no companies are configured.
 *
 * `sources` shape (config.json `sources`):
 *   { greenhouse: [tokens], lever: [tokens], ashby: [tokens], remoteConfigUrl }
 * remoteConfigUrl (optional) points at a JSON file that can add more companies
 * without an app update — fetched read-only and merged over the local lists.
 */

import { fetchGreenhouse } from './greenhouse.mjs';
import { fetchLever } from './lever.mjs';
import { fetchAshby } from './ashby.mjs';
import { matchesWorkplace } from './normalize.mjs';

const FETCHERS = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby };

// Merge a remote config's { greenhouse:[], lever:[], ashby:[] } over local lists.
export function mergeSources(local = {}, remote = {}) {
  const out = { greenhouse: [], lever: [], ashby: [] };
  for (const ats of Object.keys(out)) {
    const set = new Set();
    for (const t of [...(local[ats] || []), ...(remote[ats] || [])]) {
      const tok = String(t || '').trim();
      if (tok) set.add(tok);
    }
    out[ats] = [...set];
  }
  return out;
}

async function loadRemoteSources(url, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (!url || !/^https:\/\//i.test(url)) return {};
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!res.ok) return {};
    const data = await res.json();
    return data && typeof data === 'object' ? (data.sources || data) : {};
  } catch { return {}; }
}

export async function fetchAllSources(sources = {}, { workplaceTypes = [], log = () => {}, fetchImpl } = {}) {
  const remote = await loadRemoteSources(sources.remoteConfigUrl, { fetchImpl });
  const merged = mergeSources(sources, remote);
  const tasks = [];
  for (const [ats, fetcher] of Object.entries(FETCHERS)) {
    for (const token of merged[ats]) {
      tasks.push(
        fetcher(token, { fetchImpl })
          .then(jobs => ({ ats, token, jobs }))
          .catch(() => ({ ats, token, jobs: [] }))
      );
    }
  }
  if (!tasks.length) return [];
  const results = await Promise.all(tasks);
  const seen = new Set();
  const out = [];
  for (const { ats, token, jobs } of results) {
    log(`  ATS ${ats}/${token}: ${jobs.length} jobs`);
    for (const j of jobs) {
      if (!j || seen.has(j.href)) continue;
      if (!matchesWorkplace(j, workplaceTypes)) continue;
      seen.add(j.href);
      out.push(j);
    }
  }
  log(`  ATS total (deduped, workplace-filtered): ${out.length}`);
  return out;
}
