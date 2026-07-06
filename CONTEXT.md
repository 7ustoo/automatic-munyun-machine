# CONTEXT.md — Automatic Munyun Machine

> **Purpose:** complete project state so a fresh contributor (or fresh Claude Code session) can resume work without re-explaining anything.
> **Last updated:** 2026-07-05 (v2.9.0 on branch `v2.9`: "👁 Watch" checkbox to run a scrape with the browser on-screen + auto-update now reliably reopens the dashboard window instead of just the tray. See "Recent change history" below — earlier sections of this file may lag a version or two behind.)
> **Update protocol:** update this file at the end of *any* code change (commit, command added, file moved, schema shift). Treat it like a CHANGELOG-of-state.

---

## What it is

**Automatic Munyun Machine (AMM)** — a Telegram bot that scrapes hiring.cafe every weekday morning and pushes the user 100 jobs ranked by CV match. Local-first (runs on the user's Windows laptop), free ($0/month), Telegram-only UX.

- **Public repo:** https://github.com/7ustoo/automatic-munyun-machine
- **License:** MIT

## Single working directory (post-consolidation)

The dev machine now has **one** directory: the AMM repo at `<dev-machine>/automatic-munyun-machine/`. The live bot runs from here directly. Personal `.env`, `config.json`, `data/cv-parsed.json`, `data/browser-profile/` all live here (gitignored). Task Scheduler entries (`munyun-bot`, `munyun-daily-batch`) point at AMM paths.

Historical note: an earlier dual-directory workflow (`<dev-machine>/career-ops/` was the live bot, AMM was a publish-target mirror) was deprecated when E1 of v1.0 ran. The legacy `career-ops-*` Task Scheduler migration block in `scripts/setup-tasks.ps1` is preserved as defense-in-depth for any user upgrading from a v0.1-era install — it's a no-op on fresh installs.

> **For non-developers cloning this repo:** run `npm install` + `npx playwright install chromium` + `node scripts/setup-wizard.mjs`. The wizard creates everything else.

## GitHub branches & releases

| Branch | What | State |
|---|---|---|
| `main` | Production. v0.5.0 (latest). Install one-liner clones this. | Last commit: `d288053` (PR #4 merge of v0.5 into main) |
| `v0.3` | Historical. Do not push. | Tagged `v0.3.0`. Tip: `5afae31` |
| `v0.4` | Historical. Merged via PR #2 as v0.4.0. Do not push. | Tagged `v0.4.0` at `d5541fa` |
| `v0.5` | Historical. Merged via PR #4 carrying v0.4.1 fixes + v0.5 features. Do not push. | Tagged `v0.5.0`, `v0.4.1` at `0e2655d` mid-branch |
| `v1.0` | Active. **Single branch carrying all E1–E6 work.** One PR to main when v1.0 ships. | First commit (E1): `87d1094` |

**v1.0 epic sequence** (all commit to the single `v1.0` branch — no per-epic branches, one PR at the end):
1. E1 — career-ops consolidation + cleanup (commit `87d1094`, done)
2. E2 — heartbeat, /status, /diagnose, watchdog, batch-missed
3. E3 — phrase-proximity, match floor, seen-jobs decay, role-cluster
4. E4 — callback_query, inline keyboards, /batch, /history
5. E5 — multi-profile architecture
6. E6 — Inno Setup .exe + uninstall lifecycle

**Releases:** v0.3.0 (pre-release), v0.4.0, v0.4.1, v0.5.0 (latest) — all live as GitHub Releases with notes synced from `CHANGELOG.md`. v1.0.0 will be tagged at v1.0 branch HEAD before the final PR opens.

**Install one-liner** (pulls main HEAD, currently v0.5.0):
```powershell
iwr -useb https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.ps1 | iex
```

**Upgrade path** for users on v0.4.x or earlier: send `/update` in Telegram. The bot does `git pull` + `npm install` + restart, all from the phone.

## File map

### `scripts/`

| File | Purpose |
|---|---|
| `daily-batch.mjs` | The scraper. Playwright off-screen Chromium → 15 hiring.cafe queries → filter → score → resolve direct ATS URLs → Telegram push. |
| `telegram-bot.mjs` | Long-running poller. Handles 28+ commands. Started by Task Scheduler `munyun-bot` at logon. |
| `telegram-send.mjs` | Standalone Telegram sender helper. Used by terminal commands and bot itself. |
| `setup-wizard.mjs` | 10-step interactive first-run wizard. |
| `resume-parser.mjs` | PDF/DOCX/MD → `data/cv-parsed.json` via `cv-keywords.json` regex match. |
| `cv-keywords.json` | ~1,500-term curated dictionary (IAM/cloud/security + software/data/ML/design/ops). |
| `role-suggester.mjs` | Reads parsed CV, returns suggested job titles by domain cluster. Used by `/jobs suggest` and wizard step 5. |
| `geocode.mjs` | Wraps open-meteo geocoding API for `/city <name>`. Free, no key. |
| `config-rw.mjs` | Atomic config.json read/write (dot-path get/set, array append/remove). Used by all settings commands. |
| `job-action.mjs` | Standalone helper for `/save N`, `/applied N`, `/auth` — opens hiring.cafe job URL with persistent profile, clicks button. |
| `login-once.mjs` | Opens visible Chromium, navigates to hiring.cafe, waits for user to sign in via Google SSO, persists session in profile. |
| `setup-tasks.ps1` | Registers Task Scheduler entries (`munyun-daily-batch` + `munyun-bot`). Reads time/days from config.json. Migrates legacy `career-ops-*` entries. |
| `run-daily-batch.cmd` | Wrapper invoked by Task Scheduler 7am task. Just calls `node scripts/daily-batch.mjs`. |
| `start-bot.cmd` | Launches bot detached/minimized. Window title `"munyun bot"`. |
| `login-once.cmd` | Wraps `login-once.mjs`. User runs this to (re)auth hiring.cafe. |

### `wrapper/` (Go tray + dashboard binary — v1.2+)

| File | Purpose |
|---|---|
| `main.go` | Entrypoint. Resolves install dir, sets up logging, acquires single-instance lock, checks `isConfigured()` for needsSetup mode, starts supervisor goroutine + dashboard server, calls `systray.Run`. |
| `supervisor.go` | Spawns the node bot as a child process. 3-strikes-per-hour respawn throttle mirrors `scripts/watchdog.mjs`. Kill on tray Quit; Restart via menu. |
| `tray.go` | Builds the system tray menu (Status / Open dashboard / Run scrape / Pause / Open Telegram / View logs / Open folder / Restart bot / Quit). Heartbeat poller updates icon color + status label every 10s. |
| `actions.go` | Menu-action handlers — shells out to existing JS scripts for setup/scrape, opens URLs via the platform's default opener for Telegram + dashboard + folder. |
| `dashboard.go` | **v1.3.** Local HTTP server on `127.0.0.1:<random-port>`. `GET /api/status` aggregates heartbeat + config + last-batch; `GET /` serves the embedded HTML. Bound port written to `data/dashboard-port.txt`. |
| `dashboard.html` | **v1.3.** Single self-contained dark-theme page (inline CSS, no CDN). Polls `/api/status` every 5s and renders bot/Telegram/profile cards + a top-10 jobs table. |
| `singleinstance.go` | `data/wrapper.lock` PID-based lock prevents double-tray scenarios when the watchdog and the scheduled task race. |
| `platform_windows.go` / `platform_unix.go` | OS-specific helpers — child window hiding (Windows `CREATE_NO_WINDOW`), `terminateProcess` (SIGTERM vs Job kill). |
| `icons.go` + `icon-*.{png,ico}` | Embedded tray icons for gray (initial), green (alive), yellow (stale), red (dead) states. |
| `Makefile` | `build`, `build-win`, `build-mac` (arm64 + amd64), `build-linux`. Version injected via `-ldflags "-X main.AMMVersion=$(VERSION)"` from `package.json`. |
| `main_test.go`, `dashboard_test.go` | Go unit tests — 7 isConfigured cases + 9 dashboard buildStatus cases. Run via `go test ./...`. |

### Top-level files

| Path | Purpose |
|---|---|
| `config.example.json` | Template config (queries, filters, scoring, weather, schedule, applicationFormEase). Ships with repo. |
| `config.json` | User's actual config — gitignored. Created by wizard. Loaded by daily-batch + bot. |
| `.env` | User's Telegram bot token + chat ID — gitignored everywhere. |
| `.env.example` | Template `.env` shipping with repo. |
| `data/cv-parsed.json` | Parsed CV (titles, certs, skills, compliance arrays). |
| `data/applications.md` | Append-only log of jobs `/applied` to. |
| `data/seen-jobs.json` | Persistent dedupe — every viewjob URL ever pushed to Telegram. |
| `data/last-batch.json` | Per-job match details for the most recent scrape (used by `/why N`). |
| `data/auth-state.json` | `{ lastAuthOK, lastAuthFail }` timestamps. |
| `data/bot-offset.json` | Telegram poll cursor. |
| `data/browser-profile/` | Playwright Chromium persistent profile with hiring.cafe session cookies. |
| `data/today-batch-{date}.tsv` | Each day's batch as TSV. |
| `data/jobs({date}).txt` | Each day's batch as a downloadable plain-text file — sent as Telegram document attachment at end of every batch and on `/export`. |
| `data/daily-batch-{date}.log` | Per-run scraper log. |
| `data/telegram-bot.log` | Bot poll + dispatch log. Chat ID masked. |
| `install.ps1` | One-liner installer. Installs Node + Git via winget, clones repo, runs wizard. |
| `README.md` | Public-facing project README. |
| `CHANGELOG.md` | Versioned changelog (Keep-a-Changelog format). |
| `LICENSE` | MIT. |
| `package.json` | npm manifest. v0.3.0. Deps: `playwright-core`, `pdf-parse`, `mammoth`. |
| `.gitignore` | Ignores `.env`, `config.json`, `data/`, `cv.md`, `node_modules/`, logs, `*PRIVATE*.md`. |

## Telegram commands (29 total)

### Core
`/scrape` (alias `/daily`, `gm`, `morning`) · `/save N` · `/applied N` · `/why N` · `/export`

### Settings (NEW in v0.3)
`/settings` · `/resume` · `/jobs` (+ `add`/`remove`/`suggest`) · `/yoe N` · `/salary N` · `/clearance on/off` · `/forms all|simple|long` · `/skip <co>` · `/unskip <co>` · `/city <name>` · `/schedule HH:MM`

### Maintenance
`/auth` · `/reauth` · `/pause` · `/resume-bot` · `/forget all` · `/forget last` · `/cancel` · `/weather` · `/test` · `/help`

## Architecture

```
                  ┌─────────────────┐
                  │  config.json    │  ← user-editable
                  │  cv-parsed.json │
                  └─────────────────┘
                          │
                          ▼
   ┌─────────────────────────────────────────┐
   │     scripts/daily-batch.mjs              │ ← Playwright + scoring + Telegram
   └─────────────────────────────────────────┘
        ▲                          │
        │                          ▼
   ┌──────────┐            ┌────────────────┐
   │ Task     │            │ Telegram API   │
   │ Scheduler│            └────────────────┘
   │ 7am      │
   └──────────┘            ┌────────────────┐
                           │ telegram-bot   │ ← polls for /scrape,
                           │     .mjs       │   /save, /applied, etc.
                           └────────────────┘
                                  ▲
                                  │
                              Your phone
```

## Common operations

### Restart bot after code change
```powershell
Get-Process node | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'telegram-bot' } | Stop-Process -Force
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'munyun-bot'
```

### Trigger a fresh scrape from terminal
```bash
node scripts/daily-batch.mjs
```

### Verify GitHub-side state
```powershell
gh api repos/7ustoo/automatic-munyun-machine/commits/v0.3 | ConvertFrom-Json | Select-Object @{n='sha';e={$_.sha.Substring(0,7)}},@{n='msg';e={$_.commit.message.Split([Environment]::NewLine)[0]}}
```

### Send a Telegram message from terminal
```bash
node scripts/telegram-send.mjs "<message>"
```

## Roadmap

- ✅ v0.1 — initial Telegram + CDP-based scraper, local only
- ✅ v0.2 — Public AMM repo with 5-step wizard, install.ps1, branding rename
- ✅ v0.3 — 18 new bot commands, 10-step wizard, smart resume parsing, `/forms`, audit-patch. **Merged to main 2026-05-04.**
- ✅ v0.4 — `.txt` batch export + `/export` command. **Merged to main 2026-05-04.**
- ✅ v0.4.1 — Native file picker, transient-outage resilience, libuv assertion fix, wizard PATH crash. **Shipped via the v0.5 PR.**
- ✅ v0.5 — `/update`, `/version`, update notifications, absolute-paths fix for bot commands. **Merged to main 2026-05-06 via PR #4.**
- 🚧 v1.0 (active) — "Trustworthy and shareable on Windows." Six sequenced epics (E1–E6) on a single `v1.0` branch with one PR to main at the end. Plan: `~/.claude/plans/wonderful-now-time-to-quirky-pizza.md`. Ships:
  - E1: career-ops consolidation (committed)
  - E2: heartbeat + watchdog + `/status` + `/diagnose`
  - E3: phrase-proximity scoring, match floor, seen-jobs decay, role-cluster auto-detection
  - E4: inline-button Telegram UI (callback_query, paginated `/batch`, `/history`)
  - E5: multi-profile support
  - E6: Inno Setup `.exe` + uninstall lifecycle (`/uninstall`, `uninstall.ps1`)
- ⏭ v1.1 — Mac + Linux support, code signing
- ⏭ v1.2 — scam detection, per-query supply analytics
- ⏭ v2.0 — embeddings + optional LLM rerank, salary database, browser extension. **Tauri desktop GUI cut from roadmap entirely** — Telegram-first inline UI replaces it.

## Recent change history (newest first)

- **2026-07-05** — v2.9.0 (branch `v2.9`). Two user-reported items. (1) **Watch the scrape**: the scrape browser was always headful but parked off-screen (`--window-position=10000,10000`) so the daily run never covers the desktop — so it was never watchable. New `AMM_SHOW_BROWSER=1` env flag read in `daily-batch.mjs#launchBrowser` flips the window to `60,60` (on-screen). Wired via `actionRunScrape(installDir, showBrowser)` (new bool param; tray passes false, scheduled run never sets it) ← `handleScrape` reads `watch` from the POST body ← dashboard **👁 Watch** checkbox next to "Scrape now". No config/schema change. (2) **Auto-update reopens the dashboard, not just the tray**: `self-update.mjs`'s relaunch `.cmd` now does `start "" AMM.exe --after-update` (and waits `ping -n 4` for the installer's file lock to release). New `flagAfterUpdate` in `main.go` → after `startDashboard`, calls `waitForDashboardReady(url, 24, 500ms)` (polls `/api/status` until 200, ~12s budget) before `openAppWindow`, so the just-restarted HTTP server isn't raced into a dead-port window. 3 new Go tests for `waitForDashboardReady` (becomes-ready / times-out / no-listener). Note: the post-update relaunch itself can only be verified with a real install+release cycle — the readiness poll is the reasoned fix for the "reopened in tray, no window" symptom. Suite: 153 JS + Go green.
- **2026-07-05** — v2.8.0 (branch `v2.8`). Two dashboard fixes for search-term confusion. (1) **Clear all**: the "What we search for" card gets a `Clear all` button (confirm-guarded) next to Add. New `dashboard-api.mjs` subcommand `jobs-clear` (`cfgRW.set('queries', [])` — profile-scoped) + wrapper route `POST /api/jobs/clear` (guardPost). (2) **Search-style rework**: the `search.mode` (titles|keywords) dropdown moved out of the Settings card into the Resume card as "Search style", with a plain-language note. Flipping it now saves the mode AND immediately calls the new read-only `POST /api/suggest` route → `suggest-current` subcommand, which re-runs `suggestRoles`/`suggestKeywords` against the *already-parsed* CV (`profilePaths().cvParsed`, no re-upload) and shows the results in the existing resume-suggest chip UI to apply. New pure exported helper `suggestTermsForMode(parsed, mode, max)` (flavor selection + flatten to strings; unknown mode → titles) with 6 unit tests in `suggest-mode.test.mjs`. The scraper is untouched — `search.mode` still never reaches `daily-batch.mjs`; it purely shapes suggestions. Suite: 153 green. Verified live: `suggest-current keywords`→`[iam, okta, m365…]`, `suggest-current titles`→`[IAM Engineer…]`, `jobs-clear` cleared 5→0 (snapshot-restored the real config).
- **2026-07-04** — v2.7.0 (branch `v2.7`). Dashboard-native first-run setup. Kills the terminal wizard as the user-facing onboarding surface — installer no longer spawns `cmd /c start node setup-wizard.mjs & pause`, tray's Setup menu item opens the dashboard app window instead. The wrapper's dashboard HTTP server was already starting before `config.json` exists (v1.3), the tray was already polling for `isSetUp` to flip true (v1.2 `exitNeedsSetupMode`), and Telegram + resume + profile management were already dashboard-native (v2.1/v2.5/v2.6) — v2.7 closes the last gap. New scripts: `scripts/scheduler-register.mjs` (extracted from `setup-wizard.mjs:34-56` so both the dashboard and the wizard can register scheduled tasks). New `dashboard-api.mjs` subcommands: `setup-geocode` (proxy to open-meteo), `setup-hcafe-login-start` (spawn `login-once.mjs` detached, write PID), `setup-hcafe-login-status` (`process.kill(pid, 0)` alive-probe + `job-action.mjs auth` verification), `setup-init` (one-shot config.json write in v1.0 profile shape, merging user input over `config.example.json` defaults), `setup-finalize` (scheduler registration). ESM main-module gate added so `buildInitConfig` is importable by tests without triggering CLI dispatch. New wrapper HTTP routes: `GET /api/setup/geocode`, `GET /api/setup/hcafe-login/status`, `POST /api/setup/hcafe-login/start`, `POST /api/setup/init`, `POST /api/setup/finalize` (POSTs guardPost-wrapped like v2.6's profile CRUD). `NeedsSetup bool` added to `statusResponse`. dashboard.html: 250-line 5-step overlay panel with progress dots, resume upload + suggestion chips (step 1), basics + geocode preview + all filter toggles (step 2), required hiring.cafe warmup with launch + 2.5s polling (step 3), optional Telegram mini-flow reusing v2.1 endpoints (step 4), finish button triggers init + finalize + reload (step 5). installer/amm.iss: dropped the postinstall wizard step and the "Setup wizard" Start Menu shortcut; single postinstall step now unconditionally launches AMM.exe. wrapper/actions.go: `actionRunSetup` opens the app window (dropped ~50 lines of platform-specific terminal-spawn code). tray label: "Run setup wizard" → "Open setup". 16 new unit tests: 5 for scheduler-register (platform selector correctness), 11 for buildInitConfig (merge semantics, query normalization, defaults preservation), 1 Go test (`NeedsSetup` flips correctly in `buildStatus`). `scripts/setup-wizard.mjs` unchanged behaviorally — still callable via `npm run setup` as a dev/CI escape hatch.
- **2026-07-03** — v2.6.0 (branch `v2.6`). Multi-profile management from the dashboard. The backend profile system landed in v1.0 E5 (per-profile CV, queries, filters, scoring, applications history; `scripts/profile-store.mjs`) and the Telegram bot got `/profile list|add|switch|delete` at the same time — but the dashboard was read-only for profiles right up through v2.5. This closes that gap. New `renameProfile(oldSlug, newSlug)` in `profile-store.mjs` (rebuilds the profiles object preserving insertion order so the UI list stays stable, moves `data/profiles/<old>/` → `<new>/`, follows active_profile). New `dashboard-api.mjs` subcommands `profile-{list,add,rename,delete,switch}` (thin wrappers on the store; delete wipes the data dir by default so a re-used slug doesn't inherit stranded state). New wrapper routes: GET `/api/profile/list` (read-only, no CSRF); POST `/api/profile/{add,rename,delete,switch}` (guardPost). Dashboard HTML gets a full CRUD Profile card — list of profiles with per-row Switch/Rename/Delete, plus an Add input at the bottom; switch triggers a full page reload so settings/batch/terms/resume all pick up the new context. Two new profile-store tests (slug validation + no-op self-rename) that don't mutate real config. No config-schema changes — this is UI parity, not new data.
- **2026-07-03** — v2.5.0 (branch `v2.5`). Three user-requested features. (1) Recency filter: `scripts/job-recency.mjs` parses the card posted-age token the scraper already reads (now captured as `postedAge`); `filters.maxJobAge` (today|3days|week|month|any) drops stale jobs in `filterAndDedupe`; dashboard dropdown. Client-side by design (guessing hiring.cafe's date param risks silent zero-results); fail-open on unreadable age. (2) Resume rescan: dashboard `Resume` card → `/api/resume/upload` (multipart, Go saves temp) → `dashboard-api resume-parse` (re-parses CV + suggests terms) → `/api/resume/apply` replaces queries. (3) Auto-update: `scripts/self-update.mjs` (info/apply) finds the platform installer asset, downloads it, spawns a detached cmd that runs the installer `/VERYSILENT` then relaunches AMM; dashboard banner auto-checks on load + every 30 min, one-click. Verified live: update-check resolves the installer URL (canAutoUpdate:true), settings round-trip maxJobAge, resume-parse of a sample CV → 12 suggestions. 8 new recency unit tests.
- **2026-07-02** — v2.4.1 (branch `v2.4.1`). `.xlsx` export with native clickable apply links. New `scripts/xlsx-writer.mjs`: zero-dep OOXML writer (STORED-entry ZIP + hand-written worksheet/styles/rels XML, table-driven CRC-32); `export-batch.mjs` gained `buildExportXlsx` + base64 transport for the binary format; Go `handleExport` decodes + serves the xlsx MIME; third dashboard export button; `/export xlsx` on Telegram. Verified by opening the generated workbook in real Excel via COM: 3/3 hyperlinks native + clickable, no repair prompt. 9 new unit tests.
- **2026-07-02** — v2.4.0 (branch `v2.4`). Project audit + launch-chain fixes. Root-cause find: the single-instance lock NEVER worked on Windows (POSIX kill-0 idiom always errors on foreign processes) — double-click spawned silent duplicate instances. Fixed with Win32 OpenProcess probe; double-click now hands off to the healthy instance (health-probed) or takes over a stale one (kill tree → steal lock → open window). Installer stops running AMM before upgrading (upgrades used to keep the old exe alive till reboot). Telegram on/off parity between wrapper and bot (token+chat, validated) ends the half-config crash-loop. dashboard-api: URL validation + locked applications.md writes. Wizard tolerates corrupt config templates. npm test scoped to scripts/__tests__ (Chrome profile ships *.test.js files!). Verified by live two-instance launch tests on Windows.

- **2026-06-14** — v2.3.0 (branch `v2.3`). Three fixes. (1) Scraper: cross-query early-stop gated behind `scoring.searchAllQueries` (default true) so every keyword is searched + fully paginated — fixes "only searching one keyword / no jobs"; daily-batch task time limit 20→45 min. (2) Tray icon = AMM logo: new `scripts/build/make-tray-ico.mjs` produces BMP/DIB `logo-tray.ico` (systray can't load PNG-compressed `logo.ico`); `tray.go` shows the logo for healthy/idle and treats Telegram-off as "running — Telegram off" (not dead). (3) Wizard `startBotForPlatform` launches the wrapper once with no flag (was racing the `--background` scheduled task) so the dashboard window opens after setup. Verified: build + 106 node tests + go tests green; tray systray "load icon" error is a sandbox-only temp-file artifact (the shipped gray icon hits it too) — loads fine on real machines.

- **2026-06-14** — v2.2.0 (branch `v2.2`). AMM opens as a real app window: `wrapper/appwindow.go` resolves installed Chrome/Edge and launches the dashboard in `--app` mode (chromeless, isolated `data/app-window` profile, AMM favicon served from embedded `logo.png`). main.go: `--background` flag (login auto-start, no window); user launch opens the window; second instance opens the running instance's window via `data/dashboard-port.txt`. tray "Open dashboard" → app window. setup-tasks.ps1 passes `--background` to the logon task. New `GET /api/jobs-txt` serves newest `jobs(date).txt` from the active profile as a download; "Download .txt" button in the dashboard. 5 new Go tests; verified live (window opens via chrome.exe app-mode, --background quiet, favicon + .txt download serve correctly).

- **2026-06-13** — v2.1.0 (branch `v2.1`), part 2: dashboard becomes a full control surface. `scripts/dashboard-api.mjs` (job-action by idx + applications.md, settings get/set, search-term add/remove/mode via profile-aware config-rw). Go: `Matched` added to batchJob, `GET /api/batch` (full list) + `GET /api/settings`, `POST /api/job/action`, `/api/settings/set`, `/api/jobs/{add,remove,mode}` (all CSRF-guarded). dashboard.html: full job list with Apply/Why/Save/Applied buttons, Settings card, search-term chips. Verified live against AMM.exe (batch+settings+actions+CSRF); 4 new Go tests. UI rendered for the user via a faithful widget mockup.
- **2026-06-13** — v2.1.0 (branch `v2.1`). Desktop-first: dashboard is primary, Telegram optional. New `scripts/telegram-config.mjs` (`telegramConfigured` single source of truth) + `scripts/telegram-setup.mjs` (validate/detect/save/disable for the GUI flow). daily-batch no longer exits on missing .env and no-ops Telegram sends when off (still writes last-batch.json + jobs txt). Wizard step 1 is now an opt-in (default no), skipping the @BotFather dance; finalize messaging points at the dashboard. Wrapper: `isConfigured` split into `isSetUp` (config.json) + `telegramEnabled` (.env token); supervisor idles while Telegram off and supervises while on (enable/disable with no restart via `KillChild`); dashboard gained POST endpoints (`/api/scrape`, `/api/telegram/{validate,detect,save,disable}`) guarded by a per-process CSRF token + loopback Host check; `/api/status` exposes `telegram.enabled`; dashboard.html grew a "Scrape now" button + interactive Telegram setup card. 19 new tests (Go guard/injection + node telegramConfigured). Verified live: binary serves, CSRF returns 403, validate relays Telegram's response.

- **2026-06-13** — v2.0.4 (branch `v2.0.4`). Auto-start AMM after setup: wizard's `startBotForPlatform()` now direct-launches the tray wrapper (via `wrapperBinaryPath`) in addition to `runScheduledTask` — wrapper single-instance lock dedupes; tray-aware success/failure messaging in console + final Telegram ping ("AMM must stay running"); installer finish page gains a "Start AMM in the system tray" checkbox gated on `.env` existing (upgrade path).
- **2026-06-12** — v2.0.3 (branch `v2.0.3`). Keyword search mode: `search.mode` config (titles|keywords), `suggestKeywords()` in role-suggester (per-cluster curated keyword lists, same signal-density ranking), `/jobs mode` bot command, mode-aware `/jobs suggest` + wizard step 5, `/settings` shows mode. 8 new tests (95 total). Scraper untouched — queries[] still holds plain search strings.
- **2026-06-12** — v2.0.2 (branch `v2.0.2`). Custom AMM logo as the app icon: `wrapper/logo.png` (640×640 money-printer art) feeds go-winres for AMM.exe; new `scripts/build/make-ico.mjs` (PNG → multi-size .ico via headless system browser, no new deps) generated `wrapper/logo.ico` for SetupIconFile/shortcuts/ARP. Tray status icons unchanged.
- **2026-06-12** — v2.0.1 (branch `v2.0.1`). System-browser support: `scripts/browser-launcher.mjs` resolves installed Chrome → Edge → bundled Chromium (config override via `browser.channel`/`browser.executablePath`, per profile); wired into daily-batch/job-action/login-once — same AMM-private profile, only the binary is borrowed. Installer: `node_modules` ships in the payload (npm install step deleted), Chromium download conditional on no Chrome/Edge + runs visible; same conditional in install.ps1. Icons: SetupIconFile on the installer, shortcuts + ARP point at wrapper/icon-green.ico, `make build-win` embeds the icon in AMM.exe via go-winres v0.3.3 (wrapper/winres/winres.json). 12 new tests (87 total).

- **2026-06-11** — **v2.0 audit remediation** (branch `v2.0`, replaces an earlier draft of the branch that was accidentally based on the v0.5-era main). Fixed: `/update` swallowed by a leftover scrape alias (broken since v0.5 — `update` matched the scrape regex first, so self-update never ran); `Security+`/`C++`/`A+` CV terms never matching (trailing `\b` after a non-word char matches nothing) — new shared `scripts/term-match.mjs#termRegex()` used by daily-batch scoring AND resume-parser, with regression tests; **`setup-tasks.ps1` failed to parse under PS 5.1** (v1.2's em-dash string + no BOM → ANSI smart-quote terminated the string → wizard task registration broke on stock Windows) — ASCII string + UTF-8 BOM on all .ps1 files; wizard now verifies the bot started (20s log watch) instead of blind "setup complete!", with recovery steps + Telegram warning on failure; poll loop treats `{ok:false}` as failure with backoff + one-time 409 second-instance ping (used to fast-loop silently); `/update` rolls back via `git reset --hard` + fresh-process dep-import probe before restart; `data/scrape.lock` (proper-lockfile) stops scheduled + manual scrapes overlapping; all self-spawns use `process.execPath`, git resolved via new `os-paths.mjs#gitCmd()`, `npmCmd()`'s ESM `require()` bug fixed; wizard/file-picker timeouts; `chunkMessage()` hard-splits oversized blocks (exported + tested); central token scrub in `log()` + 5 MB log rotation; installer progress de-silenced + winget source pinned; `npm run check` syntax gate; CI actions v4→v5 (Node-20 runtime retirement 2026-06-16). Tests 65 → 76. Version → **2.0.0**.
- **2026-05-06** — v1.0 complete. **E6: Distribution + uninstall lifecycle.** New `installer/amm.iss` Inno Setup script (unsigned, v1.0). New `scripts/uninstall.mjs` orchestrator with `--mode=pause|wipe`: kills bot, unregisters all four Task Scheduler entries, optionally wipes data + secrets. New `scripts/uninstall.ps1` for `iwr|iex` users (symmetric to install one-liner). New `/uninstall` Telegram command with `[⚠️ Pause only] [☠️ Wipe everything] [✋ Cancel]` confirmation buttons — bot pre-stops cleanly, spawns uninstall.mjs detached, exits. README rewrite: `.exe` installer leads, one-liner second, manual third; "Want to start over from scratch" troubleshooting replaced with three uninstall paths. **Version bumped to v1.0.0 in package.json. CHANGELOG promoted: `[1.0.0]` dated section, `[Unreleased]` cleared, footer compare-links updated. Test count: 24/24 green.** Ready for tagging + GitHub Release + final PR to main.
- **2026-05-06** — v1.0 E5 landed on `v1.0` branch: multi-profile support. New `scripts/profile-store.mjs` owns profile CRUD + path resolution + idempotent migration. `config.json` auto-migrates from `{user,queries,...}` flat shape to `{active_profile, profiles: {default: {...}}}` on first load. Per-profile data files relocate to `data/profiles/<slug>/`. Browser session + heartbeat + auth-state stay shared. `config-rw.mjs` rewritten profile-aware: dot-path setters auto-route under `profiles[active].*`; `read()` returns flattened view of active profile so existing consumers (daily-batch, settings, etc.) need no changes. Telegram commands: `/profile list`, `/profile add <slug>` (clones active config), `/profile switch <slug>`, `/profile delete <slug>`. `/forget last` + `/settings` count handlers updated for new seen-jobs schema. 5 new profile-store tests; total test count 24/24 green. Live config migrated cleanly: confirmed config.json now has `active_profile: "default"` + `profiles.default.*`, all 4 per-profile data files moved into `data/profiles/default/` with no stale top-level files left behind.
- **2026-05-06** — v1.0 E4 landed on `v1.0` branch: inline-button Telegram UI. New `scripts/callback-router.mjs` module mints/verifies HMAC-signed callback_data (`<action>:<idx>:<sig>`). Bot's `getUpdates` now subscribes to `callback_query` updates and dispatches via new `handleCallback`. New `/batch [N]` paginated browser renders one job per page with `[💾 Save] [✅ Applied] [❓ Why] [🚫 Skip co]` action row + `[⬅️] [N/M] [➡️]` nav row; pagination edits the bubble in place via new `tgEditMessage` helper. New `/history [N]` paginated past-applications view from `applications.md`. Daily batch ends with a CTA message `[📋 Open batch browser] [📊 Diagnose supply]` so users can start tapping without typing. New `data/last-batch-callbacks.json` (7-day TTL) maps idx → {url, company, ...}. Tap-to-skip-company writes to `filters.skipCompanies` via `cfgRW.appendUnique`.
- **2026-05-06** — v1.0 E3 landed on `v1.0` branch: engine cheap-wins. Match floor (default 25%, /floor cmd), seen-jobs freshness window (60-day decay, schema migration baked in), phrase-proximity + TF-cap scoring, cluster-aware scoring (11 role clusters in cv-keywords.json drive primaryClusters in cv-parsed.json), salary regex rewrite (10 fixture cases), title heuristic blacklist, supply-diagnostics banner, dry-query warning. seen-jobs.json schema migrated from {ids: string[]} to {jobs: {url: {firstSeenAt, lastSeenAt}}}. First test suite shipped — 19 tests via node:test under scripts/__tests__/. daily-batch.mjs CLI guard added so engine functions are safe to import.
- **2026-05-06** — v1.0 E2 landed on `v1.0` branch: reliability + observability layer. Bot writes `data/heartbeat.json` every poll; new out-of-process `scripts/watchdog.mjs` runs every 5 min via Task Scheduler entry `munyun-watchdog` and restarts the bot on stale heartbeat (3-per-hour throttle, then alerts and gives up). New `scripts/batch-missed-watcher.mjs` + `munyun-batch-missed` task pings if the daily batch TSV is missing 1h after schedule on a scheduled day. New `/status` command (uptime, last batch funnel, auth, lock, task state) and `/diagnose` command (per-query 7-day averages, seen-jobs size, last batch funnel — answers "why only N jobs?"). `recordAuthOk()` timing fixed: deferred until scrape loop produces ≥1 card. New persistent stores: `data/heartbeat.json`, `data/watchdog-state.json`, `data/watchdog-heartbeat.json`, `data/watchdog.log`, `data/batch-missed-state.json`, `data/query-stats.json`. `data/last-batch.json` schema augmented with `funnel`.
- **2026-05-06** — v1.0 strategy switch: collapsed planned per-epic branches (`v1.0-e1-consolidate`, `v1.0-e2-reliability`, ...) into a single `v1.0` branch carrying all E1–E6 work, with one PR to main when v1.0 ships. PR #5 closed; `v1.0-e1-consolidate` deleted local + remote.
- **2026-05-06** — v1.0 planning + E1 landed. Two-agent audit identified engine ceiling (~75%, depth-blind keyword scoring), UX cliff (29 flat commands, number-typing on phone, no batch browser, no `/status`), single-user wall, Windows-only chains, and silent-death reliability gap. v1.0 plan written: 6 sequenced epics, Tauri GUI cut entirely (contradicts Telegram-first thesis), Mac/Linux deferred to v1.1. **E1:** career-ops consolidation. Live state was already consolidated (Task Scheduler points at AMM, no `career-ops/` directory exists), so E1 collapsed to cleanup of stale `career-ops` references in `telegram-bot.mjs`, `telegram-send.mjs`, and `CONTEXT.md`. Latent path-bug audit clean: zero `process.cwd()` usage; every script uses `__dirname`-based ROOT.
- **2026-05-06** — v0.5 merged to main via PR #4 (commit `d288053`). Carries v0.4.1 fixes + v0.5 features. Tagged `v0.4.0` at `d5541fa`, `v0.4.1` at `0e2655d`, `v0.5.0` at v0.5 branch HEAD. GitHub Releases created for all three so `update-checker.mjs` can detect them.
- **2026-05-06** — v0.5 fix commit (`61bf88a`): replaced every bare `spawn('powershell'/'cmd.exe'/'schtasks', ...)` in `telegram-bot.mjs` with absolute paths resolved from `%SystemRoot%`. Same root cause as v0.4.1's wizard PATH bug — affected `/pause`, `/resume-bot`, `/schedule`, `/reauth`, `/scrape`, `/update` restarter. Also: `consumePostUpdateFlag` now verifies `flag.to === currentVersion()` to avoid false-positive "✅ Updated" replies; `checkForUpdate` results cached 5 min.
- **2026-05-05** — v0.5 feature commit (`778e482`): `/version`, `/update`, update-on-startup-and-daily notifications, post-update confirmation. New `scripts/update-checker.mjs` polls GitHub Releases API. Single source of truth for version: `package.json#version`.
- **2026-05-05** — v0.4.1 fixes landed (`3ee3fa6`, `5db8131`, `0e2655d`): wizard PATH crash → absolute `powershell.exe` path; libuv UV_HANDLE_CLOSING assertion at wizard shutdown → `stdio:'ignore'` + `child.unref()` + drop force-exit; bot survives transient Telegram outages → exponential backoff, unhandled-rejection/exception handlers, recovery detection ping. Also added native Windows file picker (`scripts/file-picker.mjs`) and Telegram-only setup path.
- **2026-05-04** — v0.4 merged into `main` via PR #2 (commit `d5541fa`). Adds `.txt` batch export + `/export` command. Plus a tiny follow-up (`71bc67a`) replacing UTF-8 em-dashes in `setup-tasks.ps1` with ASCII hyphens.
- **2026-05-04** — v0.3 merged into `main` via PR #1 (commit `03efcca`). Install one-liner now serves v0.3 by default. Pre-release flag dropped.
- **2026-05-04** — v0.3 audit patch (commit `a044367`): 6 ship-blockers + 4 majors + 6 polish fixes. `/weather` reads config; token scrubbed from logs; spawn timeouts; runningJob auto-clear; CHANGELOG added; window title rebranded; chat ID masked.
- **2026-05-04** — `/forms all|simple|long` command added (commit `3653873`). Maps to hiring.cafe `applicationFormEase` URL filter.
- **2026-05-04** — v0.3 branch shipped (commit `699f7bb`): 18 new bot commands, 10-step wizard, role-suggester, geocoder, config-rw, expanded keywords. Pre-release `v0.3.0` tagged.
- **2026-05-03** — Public AMM repo created at github.com/7ustoo/automatic-munyun-machine. Initial commit `e589220` on `main`.
- **2026-05-03** — gh CLI installed via winget. GitHub auth via OAuth device flow. Author rewritten to `7ustoo@users.noreply.github.com`.
- **2026-05-02** — v0.2 Telegram bot working end-to-end. Branding rename `career-ops-*` → `munyun-*`. Backups created (git tag `v0.1-backup`, sibling backup folder, Desktop zip).
- **2026-05-02** — Pivoted from CDP-based scraping (required Chrome with `--remote-debugging-port=9222`) to Playwright off-screen Chromium with persistent profile. Solves bot detection without burdening user.

## Pending decisions / open questions

- **Team rollout** — v0.5+ is ready to share. Each teammate creates their own bot via `@BotFather` (separate token, separate chat). Bot `@username` is per-person — no shared `@justinjobbot` lookup.
- **Inno Setup `.exe` installer** — scheduled for v1.0 E6. Will ship with the uninstall lifecycle (`/uninstall`, `uninstall.ps1`).
- **Code signing** — deferred to v1.1 alongside Mac/Linux. Cert-management is its own rabbit hole; v1.0 ships unsigned.
- **LLM rerank (Claude API)** — NOT in current build. v1.0 E3 cheap-wins (phrase-proximity scoring, role-cluster auto-detection) close most of the ceiling without LLM cost. Re-evaluate after v1.0 ships.

---

> Personal/private project state (live bot PID, locked policy values, real chat ID, etc.) lives in `CONTEXT-PRIVATE.md` in the same directory. That file is gitignored and never reaches GitHub.
