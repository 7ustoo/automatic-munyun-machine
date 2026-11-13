// Opt-in subscription check. Synthetic resume and public saved descriptions;
// no API key, no new collection, and no writes to the installed job catalog.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { aiRerank } from '../scripts/ai-rerank.mjs';
import { chatgptStatus, checkSubscriptionAllowance } from '../scripts/codex-subscription.mjs';

const install = path.resolve(process.argv[2] || '.');
const config = JSON.parse(fs.readFileSync(path.join(install, 'config.json'), 'utf8'));
const profile = config.active_profile || 'default';
const directory = path.join(install, 'data/profiles', profile);
const file = path.join(directory, 'job-catalog.json');
const original = fs.readFileSync(file), catalog = JSON.parse(original);
const digest = value => createHash('sha256').update(value).digest('hex');
const count = Math.max(1, Math.min(100, Number(process.argv[3]) || 3));
const selected = Object.values(catalog.jobs).filter(j => j.review && j.descriptionHash).slice(0, count);
assert.equal(selected.length, count);
const status = await chatgptStatus(); assert.equal(status.connected, true);
const allowance = await checkSubscriptionAllowance();
const candidates = selected.map((j, n) => ({ n, title: j.title, company: j.company,
  text: JSON.parse(fs.readFileSync(path.join(directory, 'job-descriptions', `${j.id}.json`), 'utf8')).text }));
const start = performance.now();
const ratings = await aiRerank({ connection: 'chatgpt', candidates, compact: process.argv.includes('--compact'),
  cvSummary: { resumeText: 'Linux Systems Engineer with five years administering Linux and Windows, AWS and Azure infrastructure, Terraform, Ansible, Jenkins and GitHub Actions CI/CD, Bash, Python and PowerShell, monitoring, incident response, Microsoft 365 and Entra ID administration.' },
  preferences: { workplaceTypes: ['Remote'], roleFilters: { excludeLeadRoles: true, excludeSalesRoles: true, excludeConsultantRoles: true } },
  fetchImpl: () => assert.fail('Subscription review must not use the paid API transport'),
});
assert.equal(ratings.length, count);
assert.equal(digest(fs.readFileSync(file)), digest(original));
console.log(JSON.stringify({ model: status.model, connection: 'chatgpt', reviewed: ratings.length,
  seconds: Math.round((performance.now() - start) / 100) / 10, includedAllowanceChecked: true,
  remainingPercentBefore: allowance.remainingPercent, apiRequests: 0, installedCatalogPreserved: true }));
