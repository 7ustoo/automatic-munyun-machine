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

if (errors.length) throw new Error('dashboard console errors:\n' + errors.join('\n'));
await browser.close();
console.log('E2E: dashboard jobs, profiles, and Gmail OAuth flow passed');
