// Behavioral test for the v3.0.1 fresh-batch detector: load the dashboard,
// idle (no clicks) past the stub's simulated scrape-finish, and assert the
// banner appears + the list/stats auto-refresh from 27 → 42 jobs.
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

await page.goto("http://127.0.0.1:8765/#jobs", { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// Pre-flip state: 27 jobs, no banner.
const before = {
  count: await page.textContent("#st-count"),
  bannerHidden: await page.$eval("#batch-banner", el => el.classList.contains("hidden")),
};
console.log("before:", JSON.stringify(before));
if (before.count.trim() !== "27" || !before.bannerHidden) { console.log("PRECONDITION FAIL"); process.exit(1); }
await page.screenshot({ path: path.join(outDir, "b1-before.png") });

// Idle past the flip (stub flips at ~15s; poll is 5s) — no user interaction.
await page.waitForSelector("#batch-banner:not(.hidden)", { timeout: 30000 });
await page.waitForTimeout(1200); // let loadBatch land
const after = {
  count: (await page.textContent("#st-count")).trim(),
  banner: (await page.textContent("#bb-text")).trim(),
  toast: (await page.textContent("#toast")).trim(),
};
console.log("after:", JSON.stringify(after));
await page.screenshot({ path: path.join(outDir, "b2-after.png") });

const pass = after.count === "42" && after.banner.includes("Scrape complete") && after.banner.includes("42");
console.log(pass ? "BEHAVIOR PASS: auto-refresh 27→42 + banner raised, zero clicks" : "BEHAVIOR FAIL");

// Dismiss works.
await page.click("#bb-dismiss");
const dismissed = await page.$eval("#batch-banner", el => el.classList.contains("hidden"));
console.log("dismiss:", dismissed ? "OK" : "FAIL");

console.log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "no console errors");
await browser.close();
process.exit(pass && dismissed && !errors.length ? 0 : 1);
