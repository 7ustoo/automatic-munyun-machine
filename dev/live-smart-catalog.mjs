// Explicit, opt-in live validation. Three real postings only, isolated from
// the user's catalog/batch/application state. Never logs credentials/resumes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveBrowser } from '../scripts/browser-launcher.mjs';
import { embeddedSearchJobs } from '../scripts/hcafe-apply-links.mjs';
import { beginCatalogRun, collectCatalogRows, readCatalog } from '../scripts/job-catalog.mjs';
import { parseEnvText } from '../scripts/telegram-config.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-smart-live-'));
const inputRoot = process.argv[2] ? path.resolve(process.argv[2]) : root;
const rawConfig = JSON.parse(fs.readFileSync(path.join(inputRoot, 'config.json'), 'utf8'));
const activeConfig = rawConfig.profiles?.[rawConfig.active_profile] || rawConfig;
const secrets = parseEnvText(fs.readFileSync(path.join(inputRoot, '.env'), 'utf8'));
const key = secrets.AMM_AI_KEY || activeConfig.scoring?.ai?.apiKey;
if (!key) throw new Error('No saved AI key.');
const config = structuredClone({ ...activeConfig, browser: rawConfig.browser });
config.telegram = { enabled: false }; config.email = { enabled: false };
config.scoring = { ...config.scoring, ai: { ...config.scoring?.ai, enabled: true, collectAll: true, rememberJobs: true, onlyNew: true } };
config.search = { ...config.search, scrapeSources: 'hcafe' };
config.queries = [{ key: 'linux', term: 'linux', engines: 'hcafe' }];
fs.cpSync(path.join(root, 'scripts'), path.join(temporary, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(temporary, 'package.json'));
fs.copyFileSync(path.join(root, 'config.example.json'), path.join(temporary, 'config.example.json'));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), 'junction');
fs.mkdirSync(path.join(temporary, 'data', 'profiles', 'default'), { recursive: true });
fs.writeFileSync(path.join(temporary, 'config.json'), JSON.stringify({ active_profile: 'default', profiles: { default: config } }));
fs.writeFileSync(path.join(temporary, '.env'), `AMM_AI_KEY=${key}\n`, { mode: 0o600 });
fs.copyFileSync(path.join(inputRoot, 'data', 'profiles', rawConfig.active_profile || 'default', 'cv-parsed.json'), path.join(temporary, 'data', 'profiles', 'default', 'cv-parsed.json'));
const file = path.join(temporary, 'data', 'profiles', 'default', 'job-catalog.json');
const browser = await resolveBrowser();
const context = await chromium.launch({ ...browser.launchOptions, headless: false,
  args: ['--window-position=10000,10000', '--disable-blink-features=AutomationControlled'] });
try {
  const page = await context.newPage();
  const state = { searchQuery: 'linux', workplaceTypes: ['Remote'], dateFetchedPastNDays: -1, sortBy: 'date' };
  await page.goto('https://hiringcafe.com/?searchState=' + encodeURIComponent(JSON.stringify(state)), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#__NEXT_DATA__', { state: 'attached' });
  const data = await page.locator('#__NEXT_DATA__').textContent();
  const rows = embeddedSearchJobs(JSON.parse(data)).filter(j => j.viewjobUrl && j.directUrl && !j.expired).slice(0, 3);
  if (rows.length !== 3) throw new Error('Source did not supply three suitable live test records.');
  const id = await beginCatalogRun(file, 'smart', 'seed');
  await collectCatalogRows(file, id, 'linux', rows);
} finally { await context.close(); }

function run(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(temporary, 'scripts', script), ...args], { cwd: temporary, windowsHide: true,
      env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject); child.on('exit', code => code ? reject(new Error(`Isolated helper failed (${code}). ${stderr.replaceAll(key, '<redacted>').slice(0, 400)}`)) : resolve(stdout));
  });
}
try {
  await run('daily-batch.mjs', [], { AMM_SMART_MATCH: '1', AMM_SMART_MATCH_RESUME: '1' });
  let c = readCatalog(file);
  if (c.runs.at(-1).status !== 'complete' || c.runs.at(-1).reviewedIds.length !== 3) throw new Error(`Live review incomplete: ${c.runs.at(-1).status}. ${c.runs.at(-1).error || ''}`);
  await run('daily-batch.mjs', [], { AMM_SMART_MATCH: '1', AMM_SMART_MATCH_RESUME: '1' });
  c = readCatalog(file);
  if (c.runs.at(-1).reviewedIds.length !== 0 || c.runs.at(-1).reusedIds.length !== 3) throw new Error('Unchanged live reviews were not reused.');
  const api = JSON.parse(await run('dashboard-api.mjs', ['smart-get', '{}']));
  if (api.summary.pending !== 0) throw new Error('Dashboard context disagrees with saved review context.');
  const csv = JSON.parse(await run('dashboard-api.mjs', ['smart-export', 'csv', '{}']));
  const xlsx = JSON.parse(await run('dashboard-api.mjs', ['smart-export', 'xlsx', '{}']));
  if (!csv.content.includes('Direct apply link') || Buffer.from(xlsx.contentBase64, 'base64').subarray(0, 2).toString() !== 'PK') throw new Error('Detailed exports failed.');
  const report = { at: new Date().toISOString(), model: api.model, jobs: api.jobs.map(j => ({ title: j.title, directUrl: j.directUrl, matchPct: j.matchPct, state: j.state })), reviewed: 3, reusedOnSecondRun: 3, pending: api.summary.pending, csv: true, xlsx: true };
  const output = path.join(root, 'data', 'outputs', 'smart-match-live-2026-11-11.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Retain public posting receipts for diagnosis; remove copied private inputs.
  for (const name of ['.env', 'config.json', path.join('data', 'profiles', 'default', 'cv-parsed.json')]) fs.rmSync(path.join(temporary, name), { force: true });
}
