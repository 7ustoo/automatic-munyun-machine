// Capture the v12 setup journey with synthetic data and verify its saved choices.
// Uses the running stub server, never a real profile, resume, or batch.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const outDir = process.argv[3];
const { chromium } = await import(pathToFileURL(path.join(repo, 'node_modules', 'playwright-core', 'index.mjs')).href);
const { resolveBrowser } = await import(pathToFileURL(path.join(repo, 'scripts', 'browser-launcher.mjs')).href);
const browser = await chromium.launch({ ...(await resolveBrowser()).launchOptions, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));

async function shot(name) {
  await page.waitForTimeout(240);
  await page.screenshot({ path: path.join(outDir, name), fullPage: false });
  console.log('preview:', name);
}

try {
  await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.setup-welcome.active');
  await shot('v12-01-welcome.png');

  await page.click('#setup-welcome-start');
  await page.waitForSelector('.setup-step[data-step="1"].active');
  await shot('v12-02-resume.png');
  await page.locator('#setup-resume-file').setInputFiles({
    name: 'sample-resume.txt', mimeType: 'text/plain',
    buffer: Buffer.from('Sample Candidate\nCloud Security Engineer\nOkta, Entra ID, AWS, Terraform'),
  });
  await page.click('#setup-resume-btn');
  await page.waitForSelector('#setup-resume-suggest:not(.hidden)');
  await page.fill('#setup-manual-term', 'IAM Analyst');
  await page.click('#setup-manual-add');
  if (await page.locator('#setup-next').isDisabled()) throw new Error('resume step did not enable Continue');
  await shot('v12-03-search-suggestions.png');

  await page.click('#setup-next');
  await page.waitForSelector('.setup-step[data-step="2"].active');
  await shot('v12-04-preferences.png');
  await page.selectOption('#setup-workplace', 'Hybrid');
  await page.fill('#setup-location', 'Chicago, IL');
  await page.click('#setup-next');
  await page.waitForSelector('.setup-step[data-step="3"].active');
  if (await page.locator('#setup-finish-btn').isDisabled()) throw new Error('Dice start should be ready');
  await shot('v12-05-start-searching.png');
  await page.check('input[name="setup-source"][value="both"]');
  if (!(await page.locator('#setup-finish-btn').isDisabled())) throw new Error('hiring.cafe path must require browser preparation');
  await page.click('#setup-hcafe-btn');
  await page.waitForFunction(() => !document.querySelector('#setup-finish-btn').disabled);
  await shot('v12-05b-both-sources-ready.png');
  await page.check('input[name="setup-source"][value="dice"]');
  const request = page.waitForRequest(r => r.url().endsWith('/api/setup/init') && r.method() === 'POST');
  await page.click('#setup-finish-btn');
  const payload = (await request).postDataJSON();
  if (payload.search?.scrapeSources !== 'dice' || payload.search?.location !== 'Chicago, IL'
      || payload.user?.salaryFloorUsd !== 0 || payload.user?.maxYoeAcceptable !== 100
      || !payload.queries?.includes('IAM Analyst')) throw new Error('setup did not save the selected quick-start choices');

  const dashboard = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  dashboard.on('pageerror', error => errors.push(error.message));
  await dashboard.addInitScript(() => localStorage.setItem('ammOnboarded', '1'));
  for (const [hash, name] of [
    ['jobs', 'v12-06-my-matches.png'],
    ['searches', 'v12-07-searches.png'],
    ['resume', 'v12-08-my-resume.png'],
    ['settings', 'v12-09-settings.png'],
    ['system', 'v12-10-connections.png'],
  ]) {
    await dashboard.goto(`http://127.0.0.1:8765/#${hash}`, { waitUntil: 'networkidle' });
    await dashboard.waitForTimeout(700);
    await dashboard.screenshot({ path: path.join(outDir, name), fullPage: false });
    console.log('preview:', name);
  }
  await dashboard.goto('http://127.0.0.1:8765/#settings', { waitUntil: 'networkidle' });
  await dashboard.locator('.settings-advanced').first().evaluate(el => { el.open = true; });
  await dashboard.waitForTimeout(700);
  await dashboard.screenshot({ path: path.join(outDir, 'v12-11-advanced-settings.png'), fullPage: false });
  await dashboard.goto('http://127.0.0.1:8765/#jobs', { waitUntil: 'networkidle' });
  await dashboard.click('#top-setup-btn');
  if (!(await dashboard.locator('section[data-view="settings"]').evaluate(el => el.classList.contains('on')))
      || !(await dashboard.locator('#setup-overlay').evaluate(el => el.classList.contains('hidden'))))
    throw new Error('completed setup should open Settings without replaying first-run setup');
  await dashboard.close();

  const resumed = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await resumed.addInitScript(() => {
    localStorage.setItem('ammOnboarded', '1');
    localStorage.setItem('ammSetupIncomplete', '1');
  });
  await resumed.goto('http://127.0.0.1:8765/#jobs', { waitUntil: 'networkidle' });
  await resumed.click('#sb-finish');
  await resumed.waitForFunction(() => document.querySelector('#setup-resume-note')?.textContent.includes('saved resume'));
  await resumed.click('#setup-welcome-start');
  if (await resumed.locator('#setup-next').isDisabled()) throw new Error('saved resume did not resume setup');
  await resumed.click('#setup-next');
  await resumed.click('#setup-next');
  if (await resumed.locator('#setup-finish-btn').isDisabled()) throw new Error('saved hiring.cafe state did not resume setup');
  const resumedRequest = resumed.waitForRequest(r => r.url().endsWith('/api/setup/init') && r.method() === 'POST');
  await resumed.click('#setup-finish-btn');
  const resumedPayload = (await resumedRequest).postDataJSON();
  if (resumedPayload.preserveExisting !== true || Object.hasOwn(resumedPayload.user, 'salaryFloorUsd'))
    throw new Error('resumed setup did not preserve untouched settings');
  await resumed.close();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('V12 PREVIEW FLOW: PASS');
} finally {
  await browser.close();
}
