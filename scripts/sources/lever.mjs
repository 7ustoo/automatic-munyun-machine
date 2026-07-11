/**
 * Lever public postings adapter (v5.0).
 *   https://api.lever.co/v0/postings/<token>?mode=json
 * <token> is the company slug in jobs.lever.co/<token>. Richest feed — includes
 * descriptionPlain (JD), workplaceType, and salaryRange inline.
 */

import { normalizeCard } from './normalize.mjs';

export function normalizeLever(p, token) {
  if (!p || !p.text) return null;
  const cat = p.categories || {};
  const jd = p.descriptionPlain
    || (p.description || '').replace(/<[^>]+>/g, ' ')
    || '';
  // salaryRange → append to JD so the existing salary parser picks it up.
  let salaryHint = '';
  if (p.salaryRange && (p.salaryRange.min || p.salaryRange.max)) {
    const cur = p.salaryRange.currency === 'GBP' ? '£' : p.salaryRange.currency === 'EUR' ? '€' : '$';
    salaryHint = ` ${cur}${p.salaryRange.min} - ${cur}${p.salaryRange.max}`;
  }
  return normalizeCard({
    source: 'lever',
    title: p.text,
    company: token,
    location: cat.location || (Array.isArray(cat.allLocations) ? cat.allLocations[0] : '') || '',
    url: p.hostedUrl || p.applyUrl || '',
    jd: jd + salaryHint,
    postedAt: Number.isFinite(p.createdAt) ? new Date(p.createdAt).toISOString() : '',
    workplaceType: p.workplaceType || ''
  });
}

export async function fetchLever(token, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map(p => normalizeLever(p, token)).filter(Boolean);
  } catch { return []; }
}
