import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const { chromium } = await import(pathToFileURL(path.join(repo, 'node_modules', 'playwright-core', 'index.mjs')).href);
const { resolveBrowser } = await import(pathToFileURL(path.join(repo, 'scripts', 'browser-launcher.mjs')).href);
const resolved = await resolveBrowser();
const browser = await chromium.launch({ ...resolved.launchOptions, headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

await page.goto('http://127.0.0.1:8765/#jobs', { waitUntil: 'networkidle' });
await page.waitForSelector('tr.job-row');
if (await page.locator('tr.job-row').count() < 20) throw new Error('jobs did not render');
await page.click('#open-all-btn');
await page.waitForSelector('#modal');
if (!/^Open all \d+ jobs\?$/.test(await page.locator('#modal h3').textContent())) throw new Error('Open All confirmation did not include the batch size');
await page.click('#modal-ok');
await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Opened 42 jobs'));
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
if (await page.locator('#open-all-btn').isDisabled()) throw new Error('historical Open All should be available');
await page.click('#open-all-btn');
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
if (await page.locator('#open-all-btn').isDisabled()) throw new Error('Back to latest did not restore current-batch actions');

if (errors.length) throw new Error('dashboard console errors:\n' + errors.join('\n'));
await browser.close();
console.log('E2E: dashboard jobs, profiles, Gmail OAuth, and previous scrapes passed');
