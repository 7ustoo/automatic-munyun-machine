import { parseKeywordBatchSize } from './batch-size.mjs';
import { keywordListingUrl, keywordCandidateKey, directApplyKey, directApplyUrl } from './hcafe-apply-links.mjs';
export { keywordListingUrl, keywordListingKey } from './hcafe-apply-links.mjs';

export function buildKeywordCollection(rows, term, requested, coverage = []) {
  const keyword = String(term || '').trim();
  const limit = parseKeywordBatchSize(requested);
  if (!keyword || keyword.length > 120 || /[\r\n\0]/.test(keyword) || !limit) {
    throw new Error('Keyword collection requires a term and a limit from 1 to 1000.');
  }
  const valid = (Array.isArray(rows) ? rows : []).filter(r => keywordCandidateKey(r) && directApplyKey(r.directUrl));
  const unique = new Map();
  for (const row of valid) unique.set(directApplyKey(row.directUrl), { ...row,
    href: keywordListingUrl(row.href) || directApplyUrl(row.href), directUrl: directApplyUrl(row.directUrl) });
  const top = [...unique.values()].slice(0, limit).map(r => ({ ...r, q: keyword }));
  return {
    top,
    funnel: {
      mode: 'keyword', keyword, raw: valid.length,
      directApplyLinks: true,
      uniqueBeforeFilter: unique.size, droppedDuplicates: valid.length - unique.size,
      keptAfterFilter: unique.size, afterDedup: unique.size,
      targetJobsPerBatch: limit, sent: top.length,
      searchCoverage: coverage, searchIncomplete: coverage.some(q => !q.complete && !q.targetReached),
      smartMatchStatus: 'skipped',
    },
  };
}
