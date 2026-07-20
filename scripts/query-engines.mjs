/**
 * Per-source search-term routing (v7.3).
 *
 * Every configured query may carry `engines: 'both' | 'hcafe' | 'dice'`
 * (absent = 'both'), and config carries a global `search.scrapeSources`
 * with the same values (absent = 'both'). This module is the single place
 * that turns those two knobs into "which terms run where" — used by
 * daily-batch (hiring.cafe loop + dice fetch list) and pure for tests.
 */

export const ENGINE_VALUES = ['both', 'hcafe', 'dice'];

export function normalizeEngines(v) {
  return ENGINE_VALUES.includes(v) ? v : 'both';
}

export function normalizeScrapeSources(v) {
  return ENGINE_VALUES.includes(v) ? v : 'both';
}

// queries: CFG.queries entries [{key, term, engines?}]. Returns:
//   hcafe — [key, term] pairs for the hiring.cafe scrape loop
//   dice  — term strings for the Dice per-query fetch
export function splitQueriesByEngine(queries = [], scrapeSources = 'both') {
  const src = normalizeScrapeSources(scrapeSources);
  const defs = (Array.isArray(queries) ? queries : []).filter(q => q && q.key && q.term);
  return {
    hcafe: src === 'dice' ? [] : defs.filter(q => normalizeEngines(q.engines) !== 'dice').map(q => [q.key, q.term]),
    dice: src === 'hcafe' ? [] : defs.filter(q => normalizeEngines(q.engines) !== 'hcafe').map(q => q.term)
  };
}
