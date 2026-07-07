// Behavioral test for the v3.0.2 update handoff:
// 1. Load the dashboard in update-available mode (banner shows).
// 2. Navigate between views via the sidebar (replaceState must keep
//    history at one entry, or window.close() would be refused).
// 3. Click "Update now" (stub returns ok).
// 4. Kill the stub — simulates the installer killing the wrapper.
// 5. Assert: splash appears, then the page CLOSES ITSELF (Playwright
//    'close' event), with no console errors.
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const outDir = process.argv[3];
const scratch = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { chromium } = await import(pathToFileURL(path.join(repo, "node_modules", "playwright-core", "index.mjs")).href);
const { resolveBrowser } = await import(pathToFileURL(path.join(repo, "scripts", "browser-launcher.mjs")).href);

// Spawn the stub as our own child so we can kill it mid-test.
const stub = spawn(process.execPath, [path.join(scratch, "stub-server.mjs"), path.join(repo, "wrapper", "dashboard.html")], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise(res => stub.stdout.on("data", d => { if (String(d).includes("8767")) res(); }));

const b = await resolveBrowser();
// Production-faithful: the real app window is `chrome --app=<url>` whose FIRST
// navigation is the dashboard (history.length === 1 — the window.close()
// precondition). launchPersistentContext with --app replicates that; a plain
// newPage+goto would start at about:blank and inflate history to 2.
const fs = await import("node:fs");
const profileDir = path.join(outDir, "..", "app-window-test-profile");
fs.rmSync(profileDir, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(profileDir, {
  ...b.launchOptions, headless: true,
  args: [...(b.launchOptions.args || []), "--app=http://127.0.0.1:8767/"],
  viewport: { width: 1440, height: 900 },
});
let page = context.pages()[0];
if (!page) page = await new Promise(res => context.once("page", res));
await page.waitForLoadState("networkidle");
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
let closed = false;
page.on("close", () => { closed = true; });
await page.waitForSelector("#update-banner:not(.hidden)", { timeout: 10000 });
console.log("banner: visible");

// v4.0 assertions: red failure banner (stub serves lastScrape.ok=false) and
// the Why panel's score journey + misses.
await page.waitForSelector("#fail-banner:not(.hidden)", { timeout: 10000 });
const fbText = (await page.textContent("#fb-text")).trim();
console.log("fail banner:", /re-warm/.test(fbText) ? "visible (OK)" : "WRONG TEXT: " + fbText);
await page.click('button[data-act="why"][data-idx="1"]');
await page.waitForSelector(".why-journey", { timeout: 5000 });
const journey = await page.textContent(".why-journey");
const hasMiss = await page.$(".kw.miss") !== null;
console.log("why panel:", /Card scan/.test(journey) && /Final/.test(journey) ? "journey OK" : "JOURNEY FAIL",
  "| misses:", hasMiss ? "OK" : "FAIL");
await page.screenshot({ path: path.join(outDir, "v4-why-fail.png") });
await page.click('button[data-act="why"][data-idx="1"]'); // close it again

// Prove nav doesn't grow history (the window.close() prerequisite).
await page.click('a.nav-item[data-view="settings"]');
await page.click('a.nav-item[data-view="system"]');
await page.click('a.nav-item[data-view="jobs"]');
const histLen = await page.evaluate(() => history.length);
console.log("history.length after 3 nav clicks:", histLen, histLen === 1 ? "(OK)" : "(FAIL)");

await page.click("#ub-update");
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, "u1-applying.png") });

// Installer "kills the wrapper".
stub.kill();
console.log("stub killed — waiting for splash + self-close (2 failed polls ≈ 10s)");

// Splash should appear, then the page closes itself.
try {
  await page.waitForSelector("#update-splash:not(.hidden)", { timeout: 20000 });
  console.log("splash: visible");
  await page.screenshot({ path: path.join(outDir, "u2-splash.png") });
} catch { console.log("splash: NOT SEEN"); }

const deadline = Date.now() + 15000;
while (!closed && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
console.log(closed ? "window closed ITSELF: PASS" : "window did not close: FAIL");

// Connection-refused resource errors are EXPECTED after we kill the stub —
// that's the simulated wrapper death. Only other errors count.
const realErrors = errors.filter(e => !/ERR_CONNECTION_REFUSED/.test(e));
console.log(realErrors.length ? "CONSOLE ERRORS:\n" + realErrors.join("\n") : "no unexpected console errors");
await context.close();
process.exit(closed && histLen === 1 && !realErrors.length ? 0 : 1);
