import fs from 'node:fs';
import path from 'node:path';
import { lockedUpdateJson } from './io-helpers.mjs';
import { jobIdentity } from './job-deduper.mjs';
import { updateCatalog } from './job-catalog.mjs';
import { directApplyKey } from './hcafe-apply-links.mjs';

export function readAppliedLedger(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return raw && typeof raw.jobs === 'object' ? raw : { jobs: {} };
  } catch { return { jobs: {} }; }
}

export async function recordAppliedJob(filePath, job, url) {
  const identity = jobIdentity({ ...job, href: url, directUrl: job.directUrl || url });
  await lockedUpdateJson(filePath, (raw) => {
    const next = raw && typeof raw === 'object' ? raw : {};
    if (!next.jobs || typeof next.jobs !== 'object') next.jobs = {};
    const key = identity.url || `${identity.company}\u0000${identity.title}\u0000${identity.location}`;
    if (!identity.url && (!identity.company || !identity.title)) {
      throw new Error('Applied job needs a URL or company and title');
    }
    next.jobs[key] = {
      url: String(url || ''), title: String(job.title || ''), company: String(job.company || ''),
      identity, appliedAt: new Date().toISOString(),
    };
    next.lastUpdated = new Date().toISOString();
    return next;
  });
  const catalogFile = path.join(path.dirname(filePath), 'job-catalog.json');
  if (fs.existsSync(catalogFile)) {
    const target = directApplyKey(job.directUrl || url);
    await updateCatalog(catalogFile, catalog => {
      for (const saved of Object.values(catalog.jobs)) {
        if ((target && directApplyKey(saved.directUrl) === target) || (url && saved.href === url)) saved.appliedAt ||= new Date().toISOString();
      }
    });
  }
  return identity;
}
