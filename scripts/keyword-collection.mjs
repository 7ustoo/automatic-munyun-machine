import { dedupeJobs } from './job-deduper.mjs';
import { parseKeywordBatchSize } from './batch-size.mjs';

export function buildKeywordCollection(rows, term, requested, coverage = []) {
  const keyword = String(term || '').trim();
  const limit = parseKeywordBatchSize(requested);
  if (!keyword || keyword.length > 120 || /[\r\n\0]/.test(keyword) || !limit) {
    throw new Error('Keyword collection requires a term and a limit from 1 to 1000.');
  }
  const valid = (Array.isArray(rows) ? rows : []).filter(r => {
    try {
      const url = new URL(r.href);
      return url.protocol === 'https:' && ['hiring.cafe', 'hiringcafe.com'].includes(url.hostname);
    } catch { return false; }
  });
  const unique = dedupeJobs(valid);
  const top = unique.jobs.slice(0, limit).map(r => ({ ...r, q: keyword }));
  return {
    top,
    funnel: {
      mode: 'keyword', keyword, raw: valid.length,
      uniqueBeforeFilter: unique.jobs.length, droppedDuplicates: unique.dropped,
      keptAfterFilter: unique.jobs.length, afterDedup: unique.jobs.length,
      targetJobsPerBatch: limit, sent: top.length,
      searchCoverage: coverage, searchIncomplete: coverage.some(q => !q.complete),
      smartMatchStatus: 'skipped',
    },
  };
}
