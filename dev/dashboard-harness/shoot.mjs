// Screenshot the v3.0 dashboard against the stub server, capturing console
// errors. Uses the repo's own resolveBrowser() so we exercise the same
// browser path AMM ships with.
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const outDir = process.argv[3];
const { chromium } = await import(pathToFileURL(path.join(repo, "node_modules", "playwright-core", "index.mjs")).href);
const { resolveBrowser } = await import(pathToFileURL(path.join(repo, "scripts", "browser-launcher.mjs")).href);
const b = await resolveBrowser();

const browser = await chromium.launch({ ...b.launchOptions, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));

async function shot(url, name, actions) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  if (actions) await actions();
  await page.screenshot({ path: path.join(outDir, name), fullPage: false });
  console.log("shot:", name);
}

// 1. Jobs view (default)
await shot("http://127.0.0.1:8765/#jobs", "01-jobs.png");
// 2. Why-expander open + a search filter applied
await shot("http://127.0.0.1:8765/#jobs", "02-jobs-why-search.png", async () => {
  await page.click('button[data-act="why"][data-idx="2"]');
  await page.waitForTimeout(200);
});
// 3. Band filter + sort
await shot("http://127.0.0.1:8765/#jobs", "03-jobs-filtered.png", async () => {
  await page.click('button[data-band="hi"]');
  await page.selectOption("#job-sort", "match");
  await page.waitForTimeout(200);
});
// Historical snapshot loaded into the full ranked dashboard.
await shot("http://127.0.0.1:8765/#jobs", "03b-history-ranked.png", async () => {
  await page.click('.arch-view[data-id="batch-2026-07-06T14-30-00"]');
  await page.waitForSelector('#history-view-bar:not(.hidden)');
  await page.waitForTimeout(200);
});
// 4. Searches view
await shot("http://127.0.0.1:8765/#searches", "04-searches.png");
// 5. Resume view
await shot("http://127.0.0.1:8765/#resume", "05-resume.png");
// 6. Profiles view + delete modal open
await shot("http://127.0.0.1:8765/#profiles", "06-profiles.png");
await shot("http://127.0.0.1:8765/#profiles", "07-modal.png", async () => {
  await page.click('button[data-pact="delete"]:not([disabled])');
  await page.waitForTimeout(250);
});
await page.click("#modal-cancel");
// 8. System view
await shot("http://127.0.0.1:8765/#system", "08-system.png");
// 9. Settings view
await shot("http://127.0.0.1:8765/#settings", "09-settings.png");
await shot("http://127.0.0.1:8765/#settings", "09a-custom-batch.png", async () => {
  await page.click('button[data-batch-preset="150"]');
  await page.waitForFunction(() => document.querySelector('#set-batch-size').value === '150');
  await page.fill('#set-batch-size', '1250');
  await page.locator('#set-batch-size').dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('#set-batch-size').value === '1250');
  if (await page.locator('#batch-size-presets button.on').count()) throw new Error('custom amount kept a preset selected');
});
// A keyword collection displays listing links without invented match scores.
await shot("http://127.0.0.1:8765/#jobs", "09b-keyword-jobs.png", async () => {
  await page.evaluate(async () => {
    await useBatch({ date: '2026-10-30', mode: 'keyword', keyword: 'cloud', funnel: { mode: 'keyword', keyword: 'cloud', raw: 1, uniqueBeforeFilter: 1, sent: 1, targetJobsPerBatch: 1000,
      searchIncomplete: true, searchCoverage: [{ pages: 1, complete: false, reason: 'page 2: timeout' }] }, jobs: [
      { idx: 1, title: 'Cloud Engineer', company: 'Example', q: 'cloud', src: 'hcafe', viewjobUrl: 'https://hiring.cafe/job/cloud-1' }
    ] });
  });
  if (!await page.locator('#lb-body').getByText('Unranked').count()) throw new Error('keyword job was shown as ranked');
  if (!await page.locator('#lb-body').getByText('View listing').count()) throw new Error('keyword listing link missing');
  if (await page.locator('#lb-body button[data-act="why"]').count()) throw new Error('keyword job showed a match explanation');
  if (!await page.locator('#band-seg.hidden').count()) throw new Error('match filters visible for keyword jobs');
  const details = await page.locator('#st-funnel').textContent();
  if (!details.includes('1/1000') || !details.includes('Stopped early: page 2: timeout')) throw new Error('partial keyword collection hid its target or stop reason');
});
// 10. First-run setup overlay
await shot("http://127.0.0.1:8766/", "10-setup.png");
// 11. Export menu open
await shot("http://127.0.0.1:8765/#jobs", "11-export-menu.png", async () => {
  await page.click("#export-menu summary");
  await page.waitForTimeout(200);
});
// 11b. Open jobs count menu with presets and custom amount.
await shot("http://127.0.0.1:8765/#jobs", "11b-open-jobs-menu.png", async () => {
  await page.click("#open-jobs-btn");
  await page.waitForTimeout(200);
});
// 12. Narrow viewport (responsive rail)
await page.setViewportSize({ width: 820, height: 900 });
await shot("http://127.0.0.1:8765/#jobs", "12-narrow.png");

console.log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "no console errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
