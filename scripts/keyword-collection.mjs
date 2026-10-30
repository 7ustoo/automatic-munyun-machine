import { parseKeywordBatchSize } from './batch-size.mjs';

export function keywordListingUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['hiring.cafe', 'hiringcafe.com'].includes(url.hostname)
      || !/^\/job\/[^/]+\/?$/.test(url.pathname)) return '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.href;
  } catch { return ''; }
}

// Both hiring.cafe hostnames can identify the same posting. Distinct posting
// URLs stay distinct even when their company and title happen to match.
export function keywordListingKey(row) {
  const href = keywordListingUrl(row?.href);
  return href ? new URL(href).pathname : '';
}

export function buildKeywordCollection(rows, term, requested, coverage = []) {
  const keyword = String(term || '').trim();
  const limit = parseKeywordBatchSize(requested);
  if (!keyword || keyword.length > 120 || /[\r\n\0]/.test(keyword) || !limit) {
    throw new Error('Keyword collection requires a term and a limit from 1 to 1000.');
  }
  const valid = (Array.isArray(rows) ? rows : []).filter(r => keywordListingKey(r));
  const unique = new Map();
  for (const row of valid) unique.set(keywordListingKey(row), { ...row, href: keywordListingUrl(row.href) });
  const top = [...unique.values()].slice(0, limit).map(r => ({ ...r, q: keyword }));
  return {
    top,
    funnel: {
      mode: 'keyword', keyword, raw: valid.length,
      uniqueBeforeFilter: unique.size, droppedDuplicates: valid.length - unique.size,
      keptAfterFilter: unique.size, afterDedup: unique.size,
      targetJobsPerBatch: limit, sent: top.length,
      searchCoverage: coverage, searchIncomplete: coverage.some(q => !q.complete && !q.targetReached),
      smartMatchStatus: 'skipped',
    },
  };
}
