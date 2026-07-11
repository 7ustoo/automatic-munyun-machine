/**
 * Ashby public job-board adapter (v5.0).
 *   https://api.ashbyhq.com/posting-api/job-board/<token>?includeCompensation=true
 * <token> is the board name in jobs.ashbyhq.com/<token>. Includes descriptionPlain
 * (JD), isRemote / workplaceType, and compensation.
 */

import { normalizeCard } from './normalize.mjs';

export function normalizeAshby(job, token) {
  if (!job || !job.title) return null;
  let salaryHint = '';
  const comp = job.compensation;
  if (comp && Array.isArray(comp.compensationTierSummary) && comp.compensationTierSummary.length) {
    salaryHint = ' ' + comp.compensationTierSummary.join(' ');
  } else if (typeof comp?.summary === 'string') {
    salaryHint = ' ' + comp.summary;
  }
  return normalizeCard({
    source: 'ashby',
    title: job.title,
    company: token,
    location: job.location || '',
    url: job.jobUrl || job.applyUrl || '',
    jd: (job.descriptionPlain || '') + salaryHint,
    postedAt: job.publishedAt || '',
    workplaceType: job.isRemote ? 'Remote' : (job.workplaceType || '')
  });
}

export async function fetchAshby(token, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data?.jobs) ? data.jobs : [])
      .filter(j => j && j.isListed !== false)
      .map(j => normalizeAshby(j, token))
      .filter(Boolean);
  } catch { return []; }
}
