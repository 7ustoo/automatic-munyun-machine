/**
 * Greenhouse public job-board adapter (v5.0).
 *
 * Public, unauthenticated, documented JSON feed intended for republishing:
 *   https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true
 * <token> is the board slug in a company's careers URL
 * (boards.greenhouse.io/<token>). `content=true` includes the HTML JD so we can
 * score on the real posting text without a second fetch.
 *
 * normalizeGreenhouse() is pure (fixture-testable); fetchGreenhouse() does the
 * network call and is best-effort (a bad token / outage yields []).
 */

import { normalizeCard } from './normalize.mjs';

export function normalizeGreenhouse(job, token) {
  if (!job || !job.title) return null;
  const html = job.content || '';
  const jd = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return normalizeCard({
    source: 'greenhouse',
    title: job.title,
    company: job.company_name || token,
    location: job.location?.name || '',
    url: job.absolute_url || '',
    jd,
    postedAt: job.updated_at || job.first_published || '',
    workplaceType: '' // Greenhouse doesn't expose a structured remote flag here
  });
}

export async function fetchGreenhouse(token, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data?.jobs) ? data.jobs : [])
      .map(j => normalizeGreenhouse(j, token))
      .filter(Boolean);
  } catch { return []; }
}
