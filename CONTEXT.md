# CONTEXT.md — Automatic Munyun Machine

> **Purpose:** complete project state so a fresh contributor (or fresh Claude Code session) can resume work without re-explaining anything.
> **Last updated:** 2026-05-04 (v0.3.0 + audit-patch shipped, commit `a044367` on v0.3 branch)
> **Update protocol:** update this file at the end of *any* code change (commit, command added, file moved, schema shift). Treat it like a CHANGELOG-of-state.

---

## What it is

**Automatic Munyun Machine (AMM)** — a Telegram bot that scrapes hiring.cafe every weekday morning and pushes the user 100 jobs ranked by CV match. Local-first (runs on the user's Windows laptop), free ($0/month), Telegram-only UX.

- **Public repo:** https://github.com/7ustoo/automatic-munyun-machine
- **License:** MIT

## Two parallel directories on the developer's machine

| Path | Role |
|---|---|
| `<dev-machine>/career-ops/` | **Live working directory.** Bot runs from here. Has personal `.env`, `config.json`, `data/cv-parsed.json`, `data/browser-profile/` (real hiring.cafe session). NOT a fork of AMM repo — it's the upstream `santifer/career-ops` project that AMM scripts were originally built on top of. Pushing FROM here pushes to santifer's repo (no perms). |
| `<dev-machine>/automatic-munyun-machine/` | **Public repo working tree.** Clone of `7ustoo/automatic-munyun-machine`. Contains only AMM-specific files (no `.env`, no `data/*.json`, no resume). Push from here goes to the public GitHub. |

**Workflow:** edit in `career-ops/scripts/`, smoke-test via the running bot, then `cp` updated files to `automatic-munyun-machine/scripts/` + commit + push to `v0.3` branch.

> **For non-developers cloning this repo:** you only have the second directory. Run `npm install` + `npx playwright install chromium` + `node scripts/setup-wizard.mjs`. The wizard creates everything else.

## GitHub branches & releases

| Branch | What | State |
|---|---|---|
| `main` | Production. v0.2 features only. Install one-liner clones this. | Last commit: `e589220` (v0.2 initial) |
| `v0.3` | Feature branch with v0.3 work. Pre-release. | Tip: `a044367` (audit patch) |

**Releases:** `v0.3.0` is a pre-release pointing at `v0.3` branch tag. Promote to main when proven (~1 week of stable real-world use).

**Install one-liner** (currently still pulls v0.2 from main — by design):
```powershell
iwr -useb https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.ps1 | iex
```

To install v0.3 pre-release manually:
```bash
git clone -b v0.3 https://github.com/7ustoo/automatic-munyun-machine.git
cd automatic-munyun-machine
npm install
npx playwright install chromium
node scripts/setup-wizard.mjs
```

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
| `data/daily-batch-{date}.log` | Per-run scraper log. |
| `data/telegram-bot.log` | Bot poll + dispatch log. Chat ID masked. |
| `install.ps1` | One-liner installer. Installs Node + Git via winget, clones repo, runs wizard. |
| `README.md` | Public-facing project README. |
| `CHANGELOG.md` | Versioned changelog (Keep-a-Changelog format). |
| `LICENSE` | MIT. |
| `package.json` | npm manifest. v0.3.0. Deps: `playwright-core`, `pdf-parse`, `mammoth`. |
| `.gitignore` | Ignores `.env`, `config.json`, `data/`, `cv.md`, `node_modules/`, logs, `*PRIVATE*.md`. |

## Telegram commands (28 total)

### Core
`/scrape` (alias `/daily`, `gm`, `morning`) · `/save N` · `/applied N` · `/why N`

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

### Sync career-ops/ → public AMM repo, commit, push (developer workflow)
```bash
SRC=<career-ops>; DST=<automatic-munyun-machine>
for f in <list of files>; do cp "$SRC/scripts/$f" "$DST/scripts/$f"; done
cd $DST && git add -A && git -c commit.gpgsign=false commit -m "..." && git push
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

- ✅ v0.1 — career-ops bot (Telegram + CDP-based scraper, local only)
- ✅ v0.2 — Public AMM repo with 5-step wizard, install.ps1, branding rename
- ✅ v0.3 (pre-release) — 18 new bot commands, 10-step wizard, smart resume parsing, `/forms`, audit-patch
- ⏭ v0.4 — Inno Setup `.exe` installer, Mac/Linux support, `/jobs suggest` inline buttons
- ⏭ v1.0 — Tauri desktop GUI with dashboard, history calendar, application Kanban
- ⏭ v2.0 — LLM rerank (BYO Anthropic key), analytics, multi-resume profiles

## Recent change history (newest first)

- **2026-05-04** — v0.3 audit patch (commit `a044367`): 6 ship-blockers + 4 majors + 6 polish fixes. `/weather` reads config; token scrubbed from logs; spawn timeouts; runningJob auto-clear; CHANGELOG added; window title rebranded; chat ID masked.
- **2026-05-04** — `/forms all|simple|long` command added (commit `3653873`). Maps to hiring.cafe `applicationFormEase` URL filter.
- **2026-05-04** — v0.3 branch shipped (commit `699f7bb`): 18 new bot commands, 10-step wizard, role-suggester, geocoder, config-rw, expanded keywords. Pre-release `v0.3.0` tagged.
- **2026-05-03** — Public AMM repo created at github.com/7ustoo/automatic-munyun-machine. Initial commit `e589220` on `main`.
- **2026-05-03** — gh CLI installed via winget. GitHub auth via OAuth device flow. Author rewritten to `7ustoo@users.noreply.github.com`.
- **2026-05-02** — v0.2 Telegram bot working end-to-end. Branding rename `career-ops-*` → `munyun-*`. Backups created (git tag `v0.1-backup`, sibling backup folder, Desktop zip).
- **2026-05-02** — Pivoted from CDP-based scraping (required Chrome with `--remote-debugging-port=9222`) to Playwright off-screen Chromium with persistent profile. Solves bot detection without burdening user.

## Pending decisions / open questions

- When to merge `v0.3` → `main`? Policy: "version releases will be merged into the main branch when proven that it works fine." So after ~1 week of real use without bugs, merge + drop pre-release flag on `v0.3.0`.
- Inno Setup `.exe` installer for v0.4 — postponed until v0.3 is proven.
- LLM rerank (Claude API) — NOT in current build. Would cost ~$6/mo. Decision deferred to v2.0.

---

> Personal/private project state (live bot PID, locked policy values, real chat ID, etc.) lives in `CONTEXT-PRIVATE.md` in the same directory. That file is gitignored and never reaches GitHub.
