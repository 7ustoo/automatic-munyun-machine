# AMM — Project State

This is the durable project memory consulted by GSD agents at the start of each phase.

---

## Current state

- **Latest shipped version:** **v2.9.0** (`package.json`) — shipped 2026-07-05
- **Active milestone:** none — v2.9 is shipped and the working tree is clean. No milestone is currently in flight.
- **Active branch:** `v2.9` (merged history; the next feature cuts a new `vX.Y` branch from `main`)
- **Repo HEAD:** `4b6c054 feat(v2.9): watch-the-scrape toggle + reliable dashboard reopen after update`
- **Test suite:** 18 test files under `scripts/__tests__/` (~150+ assertions; v2.8 reported "153 green") + Go tests in `wrapper/`
- **Prod deps:** `mammoth`, `pdf-parse`, `playwright-core`, `proper-lockfile` (4 total)

> **⚠️ GSD docs drift note (2026-07-06):** The rest of `.planning/` (ROADMAP, REQUIREMENTS, REVIEW, `codebase/*`) was authored 2026-05-07 for the **v1.1** milestone and describes AMM as it was at **v1.0.0** (Windows-only, Telegram-first, three processes, no wrapper, no dashboard). All of that shipped and was superseded across v1.1→v2.9. Those files are retained as historical artifacts with staleness banners. This STATE.md and PROJECT.md are the current-truth documents. Regenerate `codebase/*` with `/gsd-map-codebase` before starting the next milestone.

---

## What AMM is now (post-v2.9)

AMM shifted from **Telegram-first** (v1.0) to **desktop-first** (v2.1+). The primary surface is a **local dashboard app window**; Telegram is optional.

Four independent processes coordinate via the filesystem (`config.json`, `data/*.json`):

1. **`AMM.exe`** (Go tray wrapper, `wrapper/`, added v1.2) — owns the system-tray icon and the app window, serves the localhost dashboard (`dashboard.go` + `dashboard.html`, added v1.3; full control surface v2.1), and **supervises the bot as a child process** but only while Telegram is enabled. Single-instance lock, launch-takeover, in-place upgrade handling.
2. **`scripts/telegram-bot.mjs`** — long-running poller (~30 commands, inline callbacks). Runs only while Telegram is configured; idles otherwise.
3. **`scripts/daily-batch.mjs`** — the scraper. Persistent-profile Chromium → multi-query pagination → CV scoring → top-100 → dashboard (`last-batch.json` + `jobs(date).txt`) and, if enabled, Telegram push.
4. **`scripts/watchdog.mjs`** — every 5 min, restarts on stale heartbeat (independent of the wrapper's own supervision).

Cross-platform since v1.1: Windows (Task Scheduler / Inno Setup), macOS (launchd / `.dmg`), Linux (systemd / `.deb` + `.AppImage`). "Is Telegram on" is single-sourced in `scripts/telegram-config.mjs#telegramConfigured` and mirrored in the wrapper's `telegramEnabled`.

---

## Milestone history

| Version | Date | Theme |
|---|---|---|
| **v2.9** | 2026-07-05 | Watch-the-scrape toggle (`AMM_SHOW_BROWSER=1`); reliable dashboard reopen after auto-update (`--after-update`, `waitForDashboardReady()`) |
| **v2.8** | 2026-07-05 | "Clear all" search terms; keyword/titles toggle moved to Resume card + instant re-suggest |
| **v2.7** | 2026-07-04 | Dashboard-driven first-run setup (5-step panel); terminal wizard demoted to dev/CI escape hatch |
| **v2.6** | 2026-07-03 | Profile CRUD in the dashboard (add/switch/rename/delete) |
| **v2.5** | 2026-07-03 | Recency filter, resume rescan from dashboard, automatic self-update |
| **v2.4 / v2.4.1** | 2026-07-02 | Apply-links export (.txt/.csv/.xlsx); Windows single-instance lock + launch-chain fix; installer replaces running AMM |
| **v2.3** | 2026-06-14 | Search every keyword (`searchAllQueries`); AMM tray logo; reliable post-install window |
| **v2.2** | 2026-06-14 | Real app window (installed Chrome/Edge in app-mode, isolated profile); download jobs .txt |
| **v2.1** | 2026-06-13 | **Desktop-first pivot** — dashboard is a full control surface; Telegram optional + set up from GUI; localhost CSRF |
| **v2.0 → v2.0.4** | 2026-06-11→13 | Audit remediation + `/viewjob/`→`/job/` migration; installed-browser resolver; AMM icon; keyword search mode; auto-start on setup finish |
| **v1.3** | 2026-05-18 | Local read-only dashboard (embedded HTTP server in the tray wrapper) |
| **v1.2 → v1.2.3** | 2026-05-11→12 | Go tray wrapper (`AMM.exe`) + supervisor; CI/release pipeline fixes |
| **v1.1** | 2026-05-08 | **Cross-platform + hardened** — macOS launchd + Linux systemd, code signing, CI matrix; closed 9 HIGH + 7 MEDIUM REVIEW.md findings; `os-paths.mjs` + `io-helpers.mjs` + `proper-lockfile` |
| **v1.0** | 2026-05 | "Trustworthy and shareable on Windows" — inline callbacks, scoring overhaul, out-of-process watchdog, multi-profile, Inno Setup installer |
| v0.5 | 2026-04 | User knobs (weather, role suggester, /jobs, /yoe, geocoding, file picker) |
| v0.4 | 2026-03 | Setup wizard + first non-developer install |

(Full detail per release: `CHANGELOG.md`.)

---

## Pinned facts (current — don't re-derive these)

1. **Desktop-first, Telegram optional.** The dashboard app window is the primary surface. Telegram is on ⇔ a valid token + numeric chat id (`telegramConfigured`). The wrapper runs the bot poller only while Telegram is enabled; `isSetUp` (config.json exists) is decoupled from `telegramEnabled`.
2. **Never reimplement Telegram in Go.** All Telegram API talk stays in Node (`telegram-setup.mjs`, `telegram-bot.mjs`); the wrapper execs those and relays their JSON.
3. **State-changing dashboard endpoints are CSRF-guarded** by a per-process token + loopback `Host` check (`wrapper/dashboard_actions.go`). Add new POST routes behind the same guard.
4. **All Playwright launches go through `scripts/browser-launcher.mjs#resolveBrowser()`** (installed Chrome → Edge → bundled Chromium). Never hardcode a browser or spread anything but its `launchOptions`.
5. **Cross-platform is shipped.** Win32/darwin/linux branches live in `scripts/os-paths.mjs` (system-binary paths + scheduler abstractions) and `scripts/io-helpers.mjs` (atomic + locked writes). New system-tool spawns must resolve through `os-paths.mjs` — never `spawn('powershell'|'cmd.exe', ...)` bare.
6. **`config.json` writes go through `scripts/config-rw.mjs`** (atomic temp+rename, `proper-lockfile` advisory lock). Per-profile JSON writes use `io-helpers.mjs`.
7. **Version is single-sourced from `package.json`.** `update-checker.mjs#currentVersion()` reads it; bump `package.json` only, at tag time.
8. **Branding sentinel is `munyun-*`** (Task Scheduler / systemd) and `com.amm.*` (launchd plists).
9. **Multi-profile is fully wired** (per-profile CV/queries/filters/scoring/last-batch) end-to-end, with dashboard CRUD (v2.6) and Telegram `/profile` parity.
10. **`.planning/` is committed to git.** The user reviews each artifact and merges manually via GitHub PR; work happens on `vX.Y` feature branches, never directly on `main`.

---

## Recent change log (most recent first)

| Date | Action | Outcome |
|---|---|---|
| 2026-07-06 | Refreshed GSD `.planning/` docs to match shipped reality | STATE.md + PROJECT.md rewritten to v2.9; staleness banners on ROADMAP/REQUIREMENTS/REVIEW/codebase; v1.1→v2.9 milestone history recorded |
| 2026-07-05 | v2.9 shipped | Watch-the-scrape toggle + reliable dashboard reopen after update |
| 2026-05→07 | v1.1 through v2.9 shipped (8 milestones) | Cross-platform, Go tray wrapper, desktop-first dashboard, dashboard-driven setup — see milestone table above |
| 2026-05-07 | (historical) v1.1 milestone scoped via gsd-codebase-mapper ×4 + gsd-code-reviewer | Wrote `codebase/*` + `REVIEW.md` + v1.1 `PROJECT/REQUIREMENTS/ROADMAP/STATE` — all now superseded |

---

## Commands to remember

| What | How |
|---|---|
| Run all tests | `npm test` (Node built-in runner, scoped to `scripts/__tests__`) |
| Run one batch end-to-end | `npm run daily` |
| Build the tray wrapper | `npm run build:wrapper` (`cd wrapper && make build`) |
| Restart the bot after editing | `Get-Process node \| Where-Object { ... -match 'telegram-bot' } \| Stop-Process -Force; Start-ScheduledTask -TaskName 'munyun-bot'` |
| Tail bot log | `Get-Content -Wait data/telegram-bot.log` |
| Tail today's batch log | `Get-Content -Wait data/daily-batch-$(Get-Date -Format yyyy-MM-dd).log` |

---

*Last updated: 2026-07-06 — synced to shipped v2.9.0*
