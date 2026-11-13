import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('saved-list API validates profile/lock, binds the worker, keeps original batch and ignores CSV scores', async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  // macOS aliases /var to /private/var. Use the canonical path so the helper's
  // ESM entry-point check and the child argv refer to the same file.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'amm-import-api-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  fs.cpSync(path.join(root, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json')));
  config.scoring.ai.enabled = true;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'config.example.json'), JSON.stringify(config));
  const pp = path.join(dir, 'data/profiles/default'); fs.mkdirSync(pp, { recursive: true });
  fs.writeFileSync(path.join(pp, 'cv-parsed.json'), JSON.stringify({ titles: ['Linux Engineer'], skills: ['Linux'], certs: [], compliance: [] }));
  const batch = JSON.stringify({ mode: 'keyword', keyword: 'ci/cd', date: '2026-11-09', jobs: [{ id: 'one', title: 'Linux Engineer', company: 'Example', directUrl: 'https://jobs.example.com/one', q: 'ci/cd' }] });
  fs.writeFileSync(path.join(pp, 'last-batch.json'), batch);
  // The worker double records its environment. No collection or paid API call.
  fs.writeFileSync(path.join(dir, 'scripts/daily-batch.mjs'), `import fs from 'node:fs';fs.writeFileSync('worker.json',JSON.stringify({profile:process.env.AMM_PROFILE,run:process.env.AMM_SMART_MATCH_RUN,keyword:process.env.AMM_KEYWORD_SCRAPE_TERM||''}));`);
  const cli = (...args) => {
    const child = spawnSync(process.execPath, [path.join(dir, 'scripts/dashboard-api.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, AMM_PROFILE: '', AMM_AI_KEY: 'sk-test-import-no-network' } });
    assert.ok(child.stdout.trim(), child.stderr);
    return JSON.parse(child.stdout.trim());
  };
  const preview = cli('smart-import-prepare'); assert.equal(preview.total, 1); assert.equal(preview.profile, 'default');
  const wrong = cli('smart-import-review', JSON.stringify({ id: preview.id, profile: 'different' })); assert.equal(wrong.ok, false); assert.match(wrong.error, /Profile changed/);
  const lockdir = path.join(dir, 'data/scrape.lock.lock'); fs.mkdirSync(lockdir);
  const busy = cli('smart-import-review', JSON.stringify({ id: preview.id, profile: 'default' })); assert.match(busy.error, /already running/);
  fs.rmdirSync(lockdir);
  const started = cli('smart-import-review', JSON.stringify({ id: preview.id, profile: 'default' })); assert.equal(started.ok, true);
  for (let n = 0; !fs.existsSync(path.join(dir, 'worker.json')) && n < 40; n++) await new Promise(resolve => setTimeout(resolve, 50));
  const worker = JSON.parse(fs.readFileSync(path.join(dir, 'worker.json'))); assert.equal(worker.profile, 'default'); assert.equal(worker.run, started.run); assert.equal(worker.keyword, '');
  assert.equal(fs.readFileSync(path.join(pp, 'last-batch.json'), 'utf8'), batch);
  const csvFile = path.join(dir, 'input.csv'); fs.writeFileSync(csvFile, 'Title,URL,Match %,Status\nCloud Engineer,https://jobs.example.com/two,100,applied');
  const imported = cli('smart-import-csv', csvFile, 'cloud.csv'); assert.equal(imported.total, 1);
  assert.equal(cli('smart-import-review', JSON.stringify({ id: imported.id, profile: 'default' })).ok, true);
  const catalog = JSON.parse(fs.readFileSync(path.join(pp, 'job-catalog.json')));
  const job = Object.values(catalog.jobs).find(j => j.directUrl.endsWith('/two'));
  assert.equal(job.review, undefined); assert.equal(job.appliedAt, undefined);
  const resumed = cli('smart-import-review', JSON.stringify({ run: started.run, profile: 'default' })); assert.equal(resumed.run, started.run);
  // Wait for the detached test worker before deleting its private fixture.
  await new Promise(resolve => setTimeout(resolve, 250));
});
