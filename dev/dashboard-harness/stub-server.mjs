// Visual-verification stub for wrapper/dashboard.html.
// Serves the real page with a fake token + canned API responses so the full
// UI can be exercised in a browser without touching a real AMM install.
// Port 8765 = normal dashboard; port 8766 = first-run (needsSetup) mode.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const HTML_PATH = process.argv[2];
const page = () => readFileSync(HTML_PATH, "utf8").replace("__AMM_TOKEN__", "stub-token-123");

const companies = ["Cloudscale Systems", "Meridian Health", "Vertex Financial", "Nimbus Labs", "Atlas Aerospace", "Quantum Grid", "Harborview Tech", "Brightpath", "Ironclad Security", "Bluefin Analytics"];
const titles = ["IAM Engineer", "Identity & Access Management Analyst", "Cloud Security Engineer", "Security Operations Analyst", "Systems Administrator", "M365 Administrator", "Infrastructure Engineer", "IT Security Specialist", "Access Management Engineer", "Cybersecurity Analyst"];
const queries = ["iam", "cloud security", "m365", "linux"];
let oauthEmailConnected = false;
const jobs = Array.from({ length: 42 }, (_, i) => ({
  idx: i + 1,
  title: titles[i % titles.length] + (i > 19 ? ` ${["II","III","Sr.","Lead"][i % 4]}` : ""),
  company: companies[i % companies.length],
  yoe: i % 5 === 0 ? null : (i % 7) + 1,
  matchPct: Math.max(18, 92 - Math.floor(i * 1.9) - (i % 3) * 2),
  score: 900 - i * 12,
  q: queries[i % queries.length],
  matched: ["iam", "azure ad", "okta", "mfa", "security+"].slice(0, (i % 5) + 1),
  cardPct: Math.max(10, 92 - Math.floor(i * 1.9) - 9),
  jdPct: i % 4 === 3 ? null : Math.max(12, 92 - Math.floor(i * 1.9) + 3),
  aiPct: i < 6 ? 90 - i * 3 : null,
  aiReason: i < 6 ? "Strong: Entra ID + Okta depth covers their stack. Gap: SailPoint (nice-to-have)." : "",
  missing: i % 3 === 0 ? ["SailPoint IdentityIQ", "SCIM provisioning", "Azure PIM"] : [],
  salaryK: 120 + (i % 5) * 10,
  directUrl: "https://jobs.example.com/apply/" + (1000 + i),
  viewjobUrl: "https://hiring.cafe/job/xyz" + (1000 + i),
}));

// v3.0.1 test: simulate a scrape finishing while the dashboard idles — the
// batch's generatedAt flips ~15s after server start and 15 jobs appear.
const bootTime = Date.now();
const scrapeDone = () => Date.now() - bootTime > 15000;
const genAt = () => scrapeDone() ? "2026-07-06T22:45:00" : "2026-07-06T07:02:11";
const liveJobs = () => scrapeDone() ? jobs : jobs.slice(0, 27);

const routes = (needsSetup, opts = {}) => ({
  "/api/update/check": opts.update
    ? { ok: true, hasUpdate: true, current: "3.0.1", latest: "3.0.2", canAutoUpdate: true, releaseUrl: "https://example.com/rel" }
    : { ok: true, hasUpdate: false, current: "3.0.0" },
  "/api/status": () => ({
    wrapper: { version: "3.0.0", pid: 4242, installDir: "C:\\Users\\demo\\AppData\\Local\\AMM" },
    bot: { state: "alive", pid: 3131, version: "3.0.0", uptimeSec: 19620, lastHeartbeatAgeSec: 21, lastHeartbeatTs: "2026-07-06T12:00:00Z" },
    telegram: { enabled: false, connected: false, lastPollOk: false, consecutiveFailures: 0 },
    profile: { active: "default", all: ["default", "marketing"] },
    lastBatch: { available: true, date: "2026-07-06", jobCount: liveJobs().length, generatedAt: genAt() },
    lastScrape: opts.failedScrape
      ? { ok: false, at: "2026-07-06T07:00:12Z", error: "hiring.cafe blocked the scrape — your job feed needs a re-warm.", kind: "auth" }
      : { ok: true, at: genAt() + "Z", jobCount: liveJobs().length },
    scrapeRunning: false,
    needsSetup,
    now: new Date().toISOString(),
  }),
  "/api/batch": () => ({ ok: true, available: true, date: "2026-07-06", profile: "default", generatedAt: genAt(), jobCount: liveJobs().length, jobs: liveJobs() }),
  "/api/settings": () => ({ ok: true, settings: { maxYoeAcceptable: 5, salaryFloorUsd: 90000, matchFloorPercent: 35, scheduleTime: "07:00", filterClearance: true, applicationFormEase: "all", maxJobAge: "any", searchMode: "keywords", queries,
      aiEnabled: true, aiHasKey: true, aiModel: "claude-opus-4-8", mutedTerms: ["palo alto"], cvTermCount: 34,
      email: { enabled: oauthEmailConnected, hasCreds: oauthEmailConnected, provider: oauthEmailConnected ? "gmail-oauth" : null, connectedEmail: oauthEmailConnected ? "owner@gmail.com" : "", oauthAvailable: true, to: oauthEmailConnected ? "helper@example.com" : "", autoSend: true } } }),
  "/api/config/backups": { ok: true, backups: ["config-2026-07-06T12-00-00-000Z-pre-setup.json", "config-2026-07-05T09-10-00-000Z-pre-rename.json"] },
  "/api/profile/list": { ok: true, profiles: [ { slug: "default", active: true, hasCV: true }, { slug: "marketing", active: false, hasCV: false } ] },
  "/api/hcafe/auth": { ok: true, authed: true, checkedAt: "2026-07-10T12:00:00Z" },
});

// POST endpoints reply generically so buttons can be exercised.
const postReplies = {
  "/api/scrape": { ok: true },
  "/api/job/action": { ok: true },
  "/api/settings/set": { ok: true },
  "/api/jobs/add": { ok: true, added: true, list: [...queries, "new term"] },
  "/api/jobs/remove": { ok: true, list: queries.slice(0, 3) },
  "/api/jobs/clear": { ok: true, list: [] },
  "/api/suggest": { ok: true, mode: "titles", suggestions: ["IAM Engineer", "Cloud Security Engineer", "Security Analyst"] },
  "/api/telegram/validate": { ok: true, username: "demo_bot" },
  "/api/email/oauth/start": { ok: true, authUrl: "http://127.0.0.1:8765/oauth/google/callback?stub=1" },
  "/api/profile/add": { ok: true },
};

function serve(port, needsSetup, opts) {
  const R = routes(needsSetup, opts);
  createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/" ) { res.writeHead(200, { "content-type": "text/html" }); res.end(page()); return; }
    if (path === "/oauth/google/callback") {
      oauthEmailConnected = true;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Gmail connected</title><p>Gmail connected. Return to AMM.</p><script>if(window.opener)setTimeout(()=>window.close(),100)</script>");
      return;
    }
    if (path === "/favicon.png" || path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (R[path]) {
      const body = typeof R[path] === "function" ? R[path]() : R[path];
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); return;
    }
    if (req.method === "POST") {
      const reply = postReplies[path] || { ok: true };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(reply)); return;
    }
    res.writeHead(404, { "content-type": "application/json" }); res.end('{"ok":false,"error":"stub 404"}');
  }).listen(port, "127.0.0.1", () => console.log(`stub ${needsSetup ? "SETUP" : "NORMAL"} on http://127.0.0.1:${port}`));
}

serve(8765, false);
serve(8766, true);
serve(8767, false, { update: true, failedScrape: true }); // update-available mode (v3.0.2 handoff test)
