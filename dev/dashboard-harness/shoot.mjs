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
// 8. System view
await shot("http://127.0.0.1:8765/#system", "08-system.png");
// 9. Settings view
await shot("http://127.0.0.1:8765/#settings", "09-settings.png");
// 10. First-run setup overlay
await shot("http://127.0.0.1:8766/", "10-setup.png");
// 11. Export menu open
await shot("http://127.0.0.1:8765/#jobs", "11-export-menu.png", async () => {
  await page.click("#export-menu summary");
  await page.waitForTimeout(200);
});
// 12. Narrow viewport (responsive rail)
await page.setViewportSize({ width: 820, height: 900 });
await shot("http://127.0.0.1:8765/#jobs", "12-narrow.png");

console.log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "no console errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
