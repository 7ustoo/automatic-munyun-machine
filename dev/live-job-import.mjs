// Opt-in: two existing public employer postings, a synthetic resume and the
// configured provider. The installed catalog/batches/resumes are never written.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseEnvText } from '../scripts/telegram-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const install = path.resolve(process.argv[2] || root);
const config = JSON.parse(fs.readFileSync(path.join(install, 'config.json')));
const profile = config.active_profile || 'default';
const key = parseEnvText(fs.readFileSync(path.join(install, '.env'), 'utf8')).AMM_AI_KEY;
if (!key) throw new Error('A configured AI key is required.');
const publicBatch = JSON.parse(fs.readFileSync(path.join(install, 'data/profiles', profile, 'last-batch.json')));
const rows = publicBatch.jobs.filter(j => j.directUrl).slice(0, 2);
assert.equal(rows.length, 2);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-import-live-'));
fs.cpSync(path.join(root, 'scripts'), path.join(temporary, 'scripts'), { recursive: true });
fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const defaults = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json')));
defaults.telegram = { enabled: false }; defaults.email = { enabled: false };
defaults.scoring.ai = { ...defaults.scoring.ai, apiKey: '', enabled: true, collectAll: true, rememberJobs: true, onlyNew: true };
fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify(defaults));
fs.copyFileSync(path.join(root, 'config.example.json'), path.join(temporary, 'config.example.json'));
const pp = path.join(temporary, 'data/profiles/default'); fs.mkdirSync(pp, { recursive: true });
fs.writeFileSync(path.join(pp, 'cv-parsed.json'), JSON.stringify({ titles: ['Linux Systems Engineer'], skills: ['Linux', 'Terraform', 'Docker', 'CI/CD', 'Python', 'AWS'], certs: [], compliance: [], raw: 'Linux Systems Engineer. Four years operating Linux infrastructure, automating deployments with Terraform, Python and CI/CD, supporting AWS and Docker, monitoring and production incident response.' }));
const original = JSON.stringify({ mode: 'keyword', keyword: publicBatch.keyword, date: publicBatch.date, jobs: rows });
fs.writeFileSync(path.join(pp, 'last-batch.json'), original);
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(temporary, 'scripts/dashboard-api.mjs'), ...args], { cwd: temporary, windowsHide: true, env: { ...process.env, AMM_PROFILE: 'default', AMM_AI_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.resume();
  child.on('error', reject); child.on('exit', code => { try { const result = JSON.parse(output.trim()); if (!result.ok || code) reject(new Error(result.error || 'Isolated helper failed.')); else resolve(result); } catch (error) { reject(error); } });
});
const waitReview = async id => {
  for (let attempt = 0; attempt < 150; attempt++) {
    const c = JSON.parse(fs.readFileSync(path.join(pp, 'job-catalog.json')));
    const r = c.runs.find(r => r.id === id);
    if (['complete', 'interrupted'].includes(r.status) || (r.status === 'pending' && r.finishedAt)) {
      if (r.status !== 'complete') throw new Error(`Review ${r.status}: ${r.error || Object.values(c.jobs).map(j => j.descriptionError).filter(Boolean).join('; ')}`);
      return r;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Isolated review timed out.');
};
let finished = false;
try {
  const preview = await run(['smart-import-prepare']);
  const started = await run(['smart-import-review', JSON.stringify({ id: preview.id, profile: 'default' })]);
  console.log('Reviewing two employer descriptions from the saved pull…');
  const first = await waitReview(started.run); assert.equal(first.reviewedIds.length, 2);
  assert.equal(fs.readFileSync(path.join(pp, 'last-batch.json'), 'utf8'), original);
  const input = path.join(temporary, 'same-jobs.csv');
  const cell = value => '"' + String(value).replaceAll('"', '""') + '"';
  fs.writeFileSync(input, ['Job Title,Apply Link', ...rows.map(j => [j.title, j.directUrl].map(cell).join(','))].join('\r\n'));
  const uploaded = await run(['smart-import-csv', input, 'ci-cd.csv']); assert.equal(uploaded.known, 2);
  const again = await run(['smart-import-review', JSON.stringify({ id: uploaded.id, profile: 'default' })]);
  const second = await waitReview(again.run); assert.equal(second.reviewedIds.length, 0); assert.equal(second.reusedIds.length, 2);
  const api = await run(['smart-get', JSON.stringify({ run: started.run, scope: 'history' })]);
  assert.equal(api.summary.pending, 0); assert.equal(api.total, 2);
  const csv = await run(['smart-export', 'csv', JSON.stringify({ run: started.run, scope: 'history' })]);
  assert.ok(csv.content.includes(rows[0].directUrl));
  const report = { version: '13.0.0', model: api.model, reviewed: 2, reused: 2, originalBatchPreserved: true, selectedExport: true, jobs: api.jobs.map(j => ({ title: j.title, matchPct: j.matchPct, state: j.state, reasons: j.exclusions })) };
  const out = path.join(root, 'data/outputs/v13-import-live.json'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); finished = true;
} finally {
  // No real resume/config or credential file was copied. Only synthetic test
  // data is removed; retain failed diagnostics without touching installed data.
  if (finished) fs.rmSync(temporary, { recursive: true, force: true });
}
