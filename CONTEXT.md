# CONTEXT.md — Automatic Munyun Machine

> **Purpose:** complete project state so a fresh contributor (or fresh Claude Code session) can resume work without re-explaining anything.
> **Last updated:** 2026-05-06 (E1 of v1.0: career-ops consolidation. Live bot already runs from AMM repo; this commit drops the stale dual-directory docs + cosmetic comment references.)
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
| `v1.0-e1-consolidate` | Active. E1 of v1.0 — career-ops cleanup + docs. | First epic of the v1.0 plan |

**v1.0 epic branches** (sequenced — each merges to main individually):
1. `v1.0-e1-consolidate` (current) — career-ops consolidation + cleanup
2. `v1.0-e2-reliability` — heartbeat, /status, /diagnose, watchdog, batch-missed
3. `v1.0-e3-engine` — phrase-proximity, match floor, seen-jobs decay, role-cluster
4. `v1.0-e4-inline-ui` — callback_query, inline keyboards, /batch, /history
5. `v1.0-e5-profiles` — multi-profile architecture
6. `v1.0-e6-distribution` — Inno Setup .exe + uninstall lifecycle

**Releases:** v0.3.0 (pre-release), v0.4.0, v0.4.1, v0.5.0 (latest) — all live as GitHub Releases with notes synced from `CHANGELOG.md`.

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
- 🚧 v1.0 (active) — "Trustworthy and shareable on Windows." Six sequenced epics (E1–E6). Plan: `~/.claude/plans/wonderful-now-time-to-quirky-pizza.md`. Ships:
  - E1: career-ops consolidation (current branch)
  - E2: heartbeat + watchdog + `/status` + `/diagnose`
  - E3: phrase-proximity scoring, match floor, seen-jobs decay, role-cluster auto-detection
  - E4: inline-button Telegram UI (callback_query, paginated `/batch`, `/history`)
  - E5: multi-profile support
  - E6: Inno Setup `.exe` + uninstall lifecycle (`/uninstall`, `uninstall.ps1`)
- ⏭ v1.1 — Mac + Linux support, code signing
- ⏭ v1.2 — scam detection, per-query supply analytics
- ⏭ v2.0 — embeddings + optional LLM rerank, salary database, browser extension. **Tauri desktop GUI cut from roadmap entirely** — Telegram-first inline UI replaces it.

## Recent change history (newest first)

- **2026-05-06** — v1.0 planning + E1 kickoff. Two-agent audit identified engine ceiling (~75%, depth-blind keyword scoring), UX cliff (29 flat commands, number-typing on phone, no batch browser, no `/status`), single-user wall, Windows-only chains, and silent-death reliability gap. v1.0 plan written: 6 sequenced epics, Tauri GUI cut entirely (contradicts Telegram-first thesis), Mac/Linux deferred to v1.1. **E1 (current commit):** career-ops consolidation. Live state was already consolidated (Task Scheduler points at AMM, no `career-ops/` directory exists), so E1 collapsed to cleanup of stale `career-ops` references in `telegram-bot.mjs` (header comment + Task Scheduler entry name), `telegram-send.mjs` (default test message), and `CONTEXT.md` (dual-directory + workflow + roadmap sections rewritten). Latent path-bug audit clean: zero `process.cwd()` usage; every script uses `__dirname`-based ROOT.
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
