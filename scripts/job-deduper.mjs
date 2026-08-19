/**
 * Cross-source job identity helpers.
 *
 * URLs cannot identify a posting across aggregators: the same opening may use
 * unrelated hiring.cafe, Dice, and ATS links. These helpers prefer exact URLs,
 * then a conservative company/title/location identity. If one source omitted
 * location, company + title is enough; two explicit different locations stay
 * separate.
 */

function words(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corporation|corp|company|co)\b/g, ' ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function canonicalUrl(value) {
  try {
    const u = new URL(String(value || ''));
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|source$|ref$|referrer$)/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch { return ''; }
}

export function jobIdentity(job = {}) {
  return {
    url: canonicalUrl(job.directUrl || job.href),
    company: words(job.company),
    title: words(job.title),
    location: words(job.location),
  };
}

export function sameCanonicalJob(a, b) {
  const x = jobIdentity(a);
  const y = jobIdentity(b);
  if (x.url && x.url === y.url) return true;
  if (!x.company || !x.title || x.company !== y.company || x.title !== y.title) return false;
  return !x.location || !y.location || x.location === y.location;
}

function richness(job) {
  return String(job.jdText || '').length
    + (job.directUrl ? 500 : 0)
    + (job.location ? 50 : 0);
}

export function dedupeJobs(jobs = []) {
  const unique = [];
  const byUrl = new Map();
  const byBase = new Map();
  let dropped = 0;
  for (const job of jobs) {
    if (!job) continue;
    const identity = jobIdentity(job);
    const base = identity.company && identity.title ? `${identity.company}\u0000${identity.title}` : '';
    let idx = identity.url && byUrl.has(identity.url) ? byUrl.get(identity.url) : -1;
    if (idx < 0 && base) {
      const candidates = byBase.get(base) || [];
      const hit = candidates.find(entry => !entry.location || !identity.location || entry.location === identity.location);
      if (hit) idx = hit.idx;
    }
    if (idx < 0) {
      idx = unique.length;
      unique.push(job);
      if (identity.url) byUrl.set(identity.url, idx);
      if (base) {
        const entries = byBase.get(base) || [];
        entries.push({ idx, location: identity.location });
        byBase.set(base, entries);
      }
      continue;
    }
    dropped++;
    // Keep the richer representation but retain the earliest query label so
    // per-query diagnostics stay stable.
    if (richness(job) > richness(unique[idx])) {
      unique[idx] = { ...job, q: unique[idx].q || job.q };
    }
    if (identity.url) byUrl.set(identity.url, idx);
  }
  return { jobs: unique, dropped };
}
