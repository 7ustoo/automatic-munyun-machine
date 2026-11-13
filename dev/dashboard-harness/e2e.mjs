import path from 'node:path';
import { verifyEmployerExtraction } from './check-employer.mjs';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const { chromium } = await import(pathToFileURL(path.join(repo, 'node_modules', 'playwright-core', 'index.mjs')).href);
const { resolveBrowser } = await import(pathToFileURL(path.join(repo, 'scripts', 'browser-launcher.mjs')).href);
const resolved = await resolveBrowser();
const browser = await chromium.launch({ ...resolved.launchOptions, headless: true });
await verifyEmployerExtraction(browser);
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

await page.goto('http://127.0.0.1:8765/#jobs', { waitUntil: 'networkidle' });
await page.waitForSelector('tr.job-row');
if (await page.locator('tr.job-row').count() < 20) throw new Error('jobs did not render');
// v11.3: the active profile's scheduled scrape can be disabled directly from
// Ranked jobs without disabling the manual Scrape now action.
if (!(await page.locator('#auto-scrape').isChecked())) throw new Error('active profile auto scrape should load as on');
const autoOffRequest = page.waitForRequest(r => r.url().endsWith('/api/settings/set') && r.method() === 'POST' && r.postDataJSON()?.path === 'schedule.enabled');
await page.click('#auto-scrape-toggle');
const autoOffBody = (await autoOffRequest).postDataJSON();
if (autoOffBody.value !== 'false') throw new Error('auto scrape switch did not persist false');
await page.waitForFunction(() => document.querySelector('#auto-scrape-label')?.textContent === 'Auto off');
if (await page.locator('#scrape-btn').isDisabled()) throw new Error('manual Scrape now must remain available when auto scrape is off');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('#auto-scrape-label')?.textContent === 'Auto off');
if (await page.locator('#auto-scrape').isChecked()) throw new Error('auto scrape state did not survive reload');
await page.click('#auto-scrape-toggle');
await page.waitForFunction(() => document.querySelector('#auto-scrape-label')?.textContent === 'Auto on');
await page.click('#open-jobs-btn');
if (await page.locator('button[data-open-count]').count() !== 4) throw new Error('Open jobs presets are missing');
const openPresetRequest = page.waitForRequest(r => r.url().endsWith('/api/jobs/open-all') && r.method() === 'POST');
await page.click('button[data-open-count="50"]');
await page.waitForSelector('#modal');
if ((await page.locator('#modal h3').textContent()) !== 'Open 27 jobs?') throw new Error('Open jobs confirmation did not cap to the batch size');
await page.click('#modal-ok');
if ((await openPresetRequest).postDataJSON().limit !== '50') throw new Error('Open jobs preset did not send its limit');
await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Opened 27 jobs'));
await page.click('#open-jobs-btn');
await page.fill('#open-custom-count', '17');
const openCustomRequest = page.waitForRequest(r => r.url().endsWith('/api/jobs/open-all') && r.method() === 'POST');
await page.click('#open-custom-submit');
if ((await page.locator('#modal h3').textContent()) !== 'Open 17 jobs?') throw new Error('custom Open jobs count was not used');
await page.click('#modal-ok');
if ((await openCustomRequest).postDataJSON().limit !== '17') throw new Error('custom Open jobs count did not reach the server');
await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Opened 17 jobs'));
await page.click('button[data-act="why"][data-idx="2"]');
await page.waitForSelector('tr.why-row[data-why="2"]');

await page.goto('http://127.0.0.1:8765/#profiles', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-pact="delete"]');

await page.goto('http://127.0.0.1:8765/#system', { waitUntil: 'networkidle' });
await page.click('#email-setup-start');
await page.fill('#email-oauth-to', 'helper@example.com');
await page.fill('#email-oauth-subject', 'Jobs — {DATE}');
const popupPromise = page.waitForEvent('popup');
await page.click('#email-oauth-connect');
const popup = await popupPromise;
await popup.waitForLoadState('domcontentloaded');
await page.waitForFunction(() => window.__emailConnected === true, null, { timeout: 10000 });
if ((await page.locator('#email-state').textContent()) !== 'Connected') throw new Error('OAuth email did not become connected');

await page.selectOption('#email-send-format', 'xlsx');
const xlsxRequestPromise = page.waitForRequest(r => r.url().endsWith('/api/email/send') && r.method() === 'POST');
await page.click('#email-send-now');
const xlsxRequest = await xlsxRequestPromise;
if (xlsxRequest.postDataJSON().format !== 'xlsx') throw new Error('System email send did not request XLSX');
await page.waitForFunction(() => document.querySelector('#email-on-note')?.textContent.includes('.xlsx'));

await page.goto('http://127.0.0.1:8765/#jobs', { waitUntil: 'networkidle' });
await page.waitForSelector('tr.job-row');
await page.click('#email-btn');
const csvRequestPromise = page.waitForRequest(r => r.url().endsWith('/api/email/send') && r.method() === 'POST');
await page.click('button[data-email-format="csv"]');
const csvRequest = await csvRequestPromise;
if (csvRequest.postDataJSON().format !== 'csv') throw new Error('Jobs email menu did not request CSV');
await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('.csv'));

// v7.7: ✕ exclusion — click X on job #2, row grays out, footer shows the count, restore works.
await page.click('button[data-act="exclude"][data-idx="2"]');
await page.waitForSelector('tr.excluded-row[data-idx="2"]');
await page.waitForFunction(() => document.querySelector('#lb-foot')?.textContent.includes('1 excluded'));
const exBtn = page.locator('button[data-act="exclude"][data-idx="2"]');
if ((await exBtn.textContent()) !== '↩') throw new Error('exclude button did not flip to restore');
await exBtn.click();
await page.waitForFunction(() => !document.querySelector('tr.excluded-row'));

// v11.2: Previous scrapes — View loads the complete snapshot into the ranked
// dashboard, preserves archive-specific actions, and keeps live mutations unavailable.
await page.waitForSelector('#arch-body tr[data-arch]');
if (await page.locator('#arch-body tr[data-arch]').count() !== 3) throw new Error('archive list did not render 3 previous scrapes');
const dlHref = await page.locator('#arch-body .arch-dl a').first().getAttribute('href');
if (!/\/api\/export\?format=txt&archive=batch-2026-07-06T14-30-00$/.test(dlHref)) throw new Error('archive download link missing archive id: ' + dlHref);
await page.click('.arch-view[data-id="batch-2026-07-06T14-30-00"]');
await page.waitForSelector('#history-view-bar:not(.hidden)');
if ((await page.locator('#view-title').textContent()) !== 'Ranked jobs · Previous scrape') throw new Error('historical dashboard title missing');
if (await page.locator('tr.job-row').count() < 20) throw new Error('archived jobs did not render in ranked dashboard');
if (!(await page.locator('#st-funnel').textContent()).includes('640 raw')) throw new Error('archived funnel did not render');
const historicalExport = await page.locator('[data-batch-export="xlsx"]').getAttribute('href');
if (!historicalExport.endsWith('&archive=batch-2026-07-06T14-30-00')) throw new Error('ranked dashboard export is not archive-scoped: ' + historicalExport);
if (await page.locator('#open-jobs-menu').getAttribute('aria-disabled') !== 'false') throw new Error('historical Open jobs should be available');
await page.click('#open-jobs-btn');
await page.click('button[data-open-count="50"]');
await page.click('#modal-ok');
await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Opened 30 jobs'));
if (await page.locator('#email-menu').getAttribute('aria-disabled') !== 'false') throw new Error('historical Email should be available');
await page.locator('#email-menu summary').click();
await page.locator('#email-menu button[data-email-format="xlsx"]').click();
await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('apply-links(2026-07-06T14-30-00).xlsx'));
if (await page.locator('button[data-act="save"],button[data-act="applied"],button[data-act="exclude"]').count()) throw new Error('live batch actions leaked into historical view');
await page.click('button[data-act="why"][data-idx="2"]');
await page.waitForSelector('tr.why-row[data-why="2"]');
await page.click('#history-back');
await page.waitForFunction(() => document.querySelector('#history-view-bar')?.classList.contains('hidden'));
if (await page.locator('#open-jobs-menu').getAttribute('aria-disabled') !== 'false') throw new Error('Back to latest did not restore current-batch actions');

await page.goto('http://127.0.0.1:8765/#settings', { waitUntil: 'networkidle' });
const keyword = page.getByRole('textbox', { name: 'Search keyword' });
await keyword.fill('linux');
const count = page.getByRole('spinbutton', { name: 'Number of links' });
const allRequest = page.waitForRequest(r => r.url().endsWith('/api/scrape') && r.method() === 'POST');
await page.getByRole('button', { name: 'Pull all' }).click();
const allBody = (await allRequest).postDataJSON();
if (allBody.mode !== 'keyword' || allBody.term !== 'linux' || allBody.limit !== 'all') throw new Error('Pull all did not send the full keyword request');
await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Checking every available page'));
await page.getByText('Collect a specific number instead', { exact: true }).click();
await count.fill('2423');
const countedRequest = page.waitForRequest(r => r.url().endsWith('/api/scrape') && r.method() === 'POST');
await count.press('Enter');
if ((await countedRequest).postDataJSON().limit !== '2423') throw new Error('custom keyword count above 1,000 did not reach the server');

// CSV readiness reflects actual saved descriptions and retry stays scoped.
let descriptionsReady = false;
await page.route('**/api/batch/descriptions', route => route.fulfill({json:{ok:true,total:100,available:descriptionsReady?100:1,unavailable:descriptionsReady?0:99,pending:0,loading:false,generatedAt:'description-test',profile:'default'}}));
await page.route('**/api/batch/descriptions/retry', async route => {
  const body=route.request().postDataJSON();
  if(body.generatedAt!=='description-test'||body.profile!=='default') throw new Error('Description retry lost its batch/profile guard');
  descriptionsReady=true;await route.fulfill({json:{ok:true}});
});
await page.goto('http://127.0.0.1:8765/#jobs',{waitUntil:'networkidle'});
await page.evaluate(async()=>{await useBatch({mode:'keyword',keyword:'cloud engineer',generatedAt:'description-test',jobs:[{idx:1,title:'Cloud Engineer',company:'Example',directUrl:'https://jobs.example.com/1'}]});});
await page.waitForFunction(()=>document.querySelector('#batch-description-count').textContent==='1 of 100 full job descriptions saved');
if(!(await page.locator('#batch-description-download').textContent()).includes('1/100')) throw new Error('Incomplete CSV was presented as fully populated');
await page.click('#batch-description-retry');
await page.waitForFunction(()=>document.querySelector('#batch-description-count').textContent==='100 of 100 full job descriptions saved');
if(!(await page.locator('#batch-description-retry').isDisabled()))throw new Error('Completed descriptions should not be reloaded');
await page.unroute('**/api/batch/descriptions');await page.unroute('**/api/batch/descriptions/retry');

// v13: current/archive lists and CSV uploads enter the same review preview.
let preparedArchive = '', importedCsv = false, reviewedSelection = null;
const importRun = '11111111-2222-4333-8444-555555555555';
await page.route('**/api/smart-match/prepare', async route => {
  preparedArchive = route.request().postDataJSON().archive;
  await route.fulfill({ json: { ok: true, id: 'preview-current', profile: 'default', label: preparedArchive ? 'Previous CI/CD pull' : 'CI/CD pull', total: 3287, known: 10, descriptions: 0, invalid: 0, duplicates: 0, issues: [] } });
});
await page.route('**/api/smart-match/import', async route => {
  importedCsv = route.request().headers()['content-type'].startsWith('multipart/form-data') && route.request().postDataBuffer().includes(Buffer.from('linux.csv'));
  await route.fulfill({ json: { ok: true, id: 'preview-csv', profile: 'default', label: '<linux>.csv', total: 2, known: 1, descriptions: 1, invalid: 1, duplicates: 1, issues: ['Row 4: no valid application link.'] } });
});
await page.route('**/api/smart-match/review', async route => {
  reviewedSelection = route.request().postDataJSON();
  await route.fulfill({ json: { ok: true, run: importRun, profile: 'default' } });
});
await page.route('**/api/smart-match?*', async route => {
  const q = new URL(route.request().url()).searchParams;
  await route.fulfill({ json: { ok: true, summary: { unique: 2, strong: 0, stretch: 0, below: 0, pending: 2, excluded: 0, applied: 0 }, jobs: [], keywords: ['ci/cd'], total: 0, page: 0, pages: 0, paused: false, run: q.get('run') ? { id: importRun, mode: 'import', status: 'pending', sourceLabel: 'linux.csv', startedAt: '2026-11-11T12:00:00Z' } : null } });
});
await page.goto('http://127.0.0.1:8765/#jobs', { waitUntil: 'networkidle' });
await page.click('#match-saved-list');
await page.waitForSelector('#modal');
if (!(await page.locator('#modal').textContent()).includes('3,287')) throw new Error('Saved-list preview lost the full list count');
await page.click('#modal-cancel');
if (reviewedSelection) throw new Error('Cancel started a paid review');
await page.click('.arch-view[data-id="batch-2026-07-06T14-30-00"]');
await page.waitForSelector('#history-view-bar:not(.hidden)');
await page.click('#match-saved-list'); await page.waitForSelector('#modal');
if (preparedArchive !== 'batch-2026-07-06T14-30-00') throw new Error('Archived-list review used the latest batch');
await page.click('#modal-cancel');
await page.goto('http://127.0.0.1:8765/#smart', { waitUntil: 'networkidle' });
await page.locator('#sm-csv-file').setInputFiles({ name: 'linux.csv', mimeType: 'text/csv', buffer: Buffer.from('Job Title,Apply Link\nLinux Engineer,https://jobs.example.com/linux') });
await page.waitForSelector('#modal');
if (!importedCsv || !(await page.locator('#modal').textContent()).includes('1 invalid rows skipped')) throw new Error('CSV upload or validation preview failed');
if (await page.locator('#modal linux').count()) throw new Error('CSV filename became HTML');
await page.click('#modal-ok');
await page.waitForFunction(() => document.querySelector('#sm-run-label').textContent.includes('linux.csv'));
if (reviewedSelection.id !== 'preview-csv' || reviewedSelection.profile !== 'default') throw new Error('CSV review did not bind the prepared profile');
await page.click('#sm-continue');
await page.waitForFunction(() => document.querySelector('#sm-error').textContent.includes('Continuing'));
if (reviewedSelection.run !== importRun) throw new Error('Continue review lost the selected imported list');
await page.click('#sm-tabs [data-tab="results"]');
if (!(await page.locator('#sm-csv').getAttribute('href')).includes('run=' + importRun)) throw new Error('Imported-list export lost its run filter');

// Smart Match: the real page renders saved percentages/reasons and sends
// profile-scoped actions. A tiny local API fixture models persisted state.
let catalogState = 'excluded';
await page.route('**/api/smart-match?*', async route => {
  const q=new URL(route.request().url()).searchParams;
  const job={id:'a'.repeat(24),title:'Lead Linux Engineer',company:'Example',location:'Remote',directUrl:'https://jobs.example.com/apply/linux',state:catalogState,queries:['linux'],matchPct:82,lastMatchPct:82,aiReason:'Linux experience fits; this is a lead position.',exclusions:['Lead roles are excluded.'],firstSeenAt:'2026-11-11T10:00:00Z',lastSeenAt:'2026-11-11T11:00:00Z',reviewedAt:'2026-11-11T11:01:00Z',reviewHistory:[],events:[]};
  const visible=(q.get('scope')==='excluded'&&catalogState==='excluded')||(q.get('scope')==='results'&&catalogState==='reviewed')||q.get('scope')==='history';
  await route.fulfill({json:{ok:true,summary:{unique:1,strong:1,stretch:0,below:0,pending:0,excluded:catalogState==='excluded'?1:0,applied:catalogState==='applied'?1:0},keywords:['linux'],jobs:visible?[job]:[],total:visible?1:0,page:0,pages:visible?1:0,paused:false,run:null}});
});
await page.route('**/api/smart-match/action',async route=>{const b=route.request().postDataJSON();if(b.action==='restore')catalogState='reviewed';if(b.action==='applied')catalogState='applied';await route.fulfill({json:{ok:true}});});
await page.goto('http://127.0.0.1:8765/#smart',{waitUntil:'networkidle'});
await page.click('#sm-tabs [data-tab="excluded"]');
await page.waitForSelector('#sm-jobs [data-job-action="restore"]');
if (!(await page.locator('#sm-jobs').textContent()).includes('82%') || !(await page.locator('#sm-jobs').textContent()).includes('Lead roles are excluded.')) throw new Error('Excluded jobs lost their score or reason');
const applyLink=await page.locator('#sm-jobs a').getAttribute('href');
if(applyLink!=='https://jobs.example.com/apply/linux')throw new Error('Smart Match Apply did not use the direct employer URL');
await page.click('#sm-jobs [data-job-action="restore"]');
await page.waitForFunction(()=>document.querySelector('#sm-list-count').textContent==='0 jobs');
await page.click('#sm-tabs [data-tab="results"]');
await page.waitForSelector('#sm-jobs [data-job-action="applied"]');
if(!(await page.locator('#sm-xlsx').getAttribute('href')).includes('catalog=results'))throw new Error('Smart Match export is not scoped to the selected view');
await page.click('#sm-jobs [data-job-action="applied"]');
await page.waitForFunction(()=>document.querySelector('#sm-list-count').textContent==='0 jobs');
await page.click('#sm-tabs [data-tab="overview"]');
const smartRequest=page.waitForRequest(r=>r.url().endsWith('/api/scrape')&&r.method()==='POST');
await page.click('#sm-pull');if((await smartRequest).postDataJSON().mode!=='smart')throw new Error('Smart Match did not start full collection');
// Subscription selection persists explicitly; paid-key controls disappear.
await page.selectOption('#sm-connection','chatgpt');
await page.waitForFunction(()=>document.querySelector('#sm-connection-note').textContent.includes('API fallback is disabled'));
if(!(await page.locator('#sm-api-settings').evaluate(el=>el.classList.contains('hidden'))))throw new Error('Paid key controls remained active for subscription mode');
const connectRequest=page.waitForRequest(r=>r.url().endsWith('/api/smart-match/connect')&&r.method()==='POST');
await page.click('#sm-connect-chatgpt');await connectRequest;
await page.waitForFunction(()=>document.querySelector('#sm-model').textContent.includes('ChatGPT subscription'));
await page.goto('http://127.0.0.1:8765/#trends',{waitUntil:'networkidle'});
await page.waitForSelector('.sm-chart');
await page.click('[data-trtab="keywords"]');
if(!(await page.locator('#tr-panels').textContent()).includes('Awaiting'))throw new Error('Trends lost the separate pending band');
const trendsRequest=page.waitForRequest(r=>r.url().includes('/api/smart-trends?')&&new URL(r.url()).searchParams.get('days')==='7');
await page.selectOption('#tr-range','7');await trendsRequest;
await page.click('[data-trtab="history"]');
await page.waitForSelector('#tr-panels .sm-empty');

if (errors.length) throw new Error('dashboard console errors:\n' + errors.join('\n'));
await browser.close();
console.log('E2E: dashboard jobs, profiles, Gmail OAuth, previous scrapes, and keyword collection passed');
