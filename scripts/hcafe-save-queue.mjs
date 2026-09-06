import fs from 'node:fs';
import { atomicWriteJson } from './io-helpers.mjs';

export function isHiringCafeJob(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ['hiring.cafe', 'hiringcafe.com'].includes(u.hostname)
      && /^\/(job|viewjob)\/[^/]+\/?$/.test(u.pathname) && !u.username && !u.password;
  } catch { return false; }
}

export function readSaveQueue(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).pending.filter(j => isHiringCafeJob(j.url)); }
  catch { return []; }
}

export function enqueueSaved(file, jobs) {
  const pending = new Map(readSaveQueue(file).map(j => [j.url, j]));
  for (const j of jobs) if (isHiringCafeJob(j.href) && !pending.has(j.href)) {
    pending.set(j.href, { url: j.href, queuedAt: new Date().toISOString() });
  }
  atomicWriteJson(file, { pending: [...pending.values()] });
  return pending.size;
}

// Do not toggle an already-saved job off. A successful click is not enough:
// require the saved state to survive a fresh navigation before acknowledging it.
export async function ensureJobSaved(page, url) {
  if (!isHiringCafeJob(url)) throw new Error('not a hiring.cafe job URL');
  const saved = () => page.getByRole('button', { name: /^(Saved|Unsave job|Remove from saved)$/i }).first();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('#job-description').waitFor({ timeout: 15000 });
  if (await saved().isVisible()) return;
  await page.getByRole('button', { name: /^Save job$/i }).first().click({ timeout: 10000 });
  await saved().waitFor({ timeout: 10000 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await saved().waitFor({ timeout: 15000 });
}

export async function drainSaveQueue(file, save) {
  const pending = readSaveQueue(file);
  let saved = 0, failures = 0;
  for (let i = 0; i < pending.length;) {
    try {
      await save(pending[i].url);
      pending.splice(i, 1);
      saved++;
      failures = 0;
    } catch {
      pending[i].lastAttempt = new Date().toISOString();
      pending[i].error = 'Save not verified; will retry next scrape';
      i++;
      failures++;
    }
    atomicWriteJson(file, { pending });
    if (failures >= 3) break;
  }
  return { saved, pending: pending.length };
}
