# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Automatic Munyun Machine (AMM) — a local-first Windows tool that scrapes hiring.cafe daily, ranks 100 jobs against the user's CV, and pushes them to Telegram. Pure Node.js + Playwright; no server, no cloud, no third-party APIs beyond hiring.cafe / open-meteo / Telegram. Targets non-technical end users installed via a one-liner; setup is wizard-driven.

`README.md` is the user-facing surface. `CONTEXT.md` is the running state-of-the-project doc — read it before making structural changes, and update it after any commit that adds a command, file, or schema field.

## Commands

```bash
npm install
npx playwright install chromium       # one-time; pulls Chromium into the user profile

npm run setup       # dev/CI escape hatch — interactive 10-step CLI wizard. v2.7: end users are onboarded from the dashboard's setup panel (rendered when needsSetup=true); this CLI is not surfaced to end users anywhere anymore.
npm run daily       # one-shot scrape + Telegram push (also: node scripts/daily-batch.mjs)
npm run bot         # long-running Telegram poller
npm run login       # opens Chromium so user signs into hiring.cafe (persists session)
npm run parse-resume <path>   # re-parse CV → data/cv-parsed.json
npm test            # unit suite via scripts/run-tests.mjs (~160 node + 4 Go tests)
npm run check       # fast syntax check (scripts/check-syntax.mjs)
npm run test:ui     # dashboard UI harness (dev/dashboard-harness/run-all.mjs)
npm run build:wrapper   # rebuild the Go wrapper (also: cd wrapper && make build)
```

A `node:test` suite (no third-party framework — pure Node ≥18 built-in runner) runs through `scripts/run-tests.mjs`: ~20 files under `scripts/__tests__/` (v4-scoring, term-match, salary, role-cluster, profile-store, callback-router HMAC, watchdog, xlsx, job-recency, dashboard-static contract, …) plus Go tests (`go test ./...`) for the wrapper. There is no linter — changes are still validated by running `npm run daily` end-to-end and watching the Telegram output, plus tailing `data/daily-batch-{date}.log` and `data/telegram-bot.log`.

Restart the bot after editing `telegram-bot.mjs`:
```powershell
Get-Process node | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'telegram-bot' } | Stop-Process -Force
Start-ScheduledTask -TaskName 'munyun-bot'
```

## Architecture

Since v1.2 there are **four** independent processes total (one of them — the wrapper — supervises another, but they coordinate via filesystem like the rest). State lives in `config.json` and `data/*.json`.

```
Task Scheduler / launchd / systemd
   ↓ at logon
AMM.exe (wrapper/ — Go binary, ~3.6 MB)         ← v1.2 added
   ↓ spawns + supervises as child
node scripts/telegram-bot.mjs                    ← long-running bot
   ↓
data/heartbeat.json
   ↑ also read by
scripts/watchdog.mjs (every 5 min, independent)
```

Plus `scripts/daily-batch.mjs` (one-shot scraper, fired by its own scheduled task or by the bot/wrapper on demand).

The wrapper code lives in `wrapper/` (its own Go module, build with `cd wrapper && make build`). It's a small native shell around the JS payload, not a replacement for it. All bot logic stays in `scripts/telegram-bot.mjs`.

**v2.1 — desktop-first, Telegram optional.** The wrapper's localhost dashboard (`wrapper/dashboard.go` + `dashboard.html`) is the primary surface: it serves the ranked batch from `last-batch.json` and has state-changing POST endpoints (`/api/scrape`, `/api/telegram/{validate,detect,save,disable}`) guarded by a per-process CSRF token (`wrapper/dashboard_actions.go`). Telegram is now optional — "is it on" = a token in `.env`, defined once in `scripts/telegram-config.mjs#telegramConfigured` and mirrored in the wrapper's `telegramEnabled`. The supervisor runs the bot poller **only while Telegram is enabled** and idles otherwise (`isSetUp` = config.json exists, decoupled from Telegram). `daily-batch.mjs` no-ops its Telegram sends when off but always writes `last-batch.json` + `jobs(date).txt`. Telegram setup from the GUI flows through `scripts/telegram-setup.mjs` (the wrapper execs it and relays its JSON — never reimplement Telegram in Go). Dashboard action endpoints are backed by `scripts/dashboard-api.mjs`, which the wrapper execs and whose JSON it relays (same pattern) — the Go layer stays a thin shell. v4 added a scrape FAILED banner (`data/scrape-status.json`), a hiring.cafe sign-in status card (`data/hcafe-auth.json`), and config snapshots/restore (`data/backups/`).

1. **`scripts/daily-batch.mjs`** — the scraper. Launches a persistent-profile Playwright Chromium, runs each `config.queries[]` term against hiring.cafe, scores results against `data/cv-parsed.json`, resolves direct ATS apply URLs, and pushes the top 100 to Telegram (chunked messages + a `jobs(YYYY-MM-DD).txt` attachment). Triggered by Task Scheduler `munyun-daily-batch` weekdays at 07:00, by `/scrape` from the bot, or manually via `npm run daily`. Writes `data/last-batch.json` so `/why N` can explain a score after the fact.

2. **`scripts/telegram-bot.mjs`** — the long-running poller. `getUpdates` every ~3s, dispatches ~30 commands (see README's command tables). Stateful only via `data/bot-offset.json` (poll cursor) + a small in-memory `runningJob` lock. Most settings commands route through `scripts/config-rw.mjs` for atomic writes; commands that mutate scheduling/login spawn helper scripts. Started at logon by Task Scheduler `munyun-bot` via `scripts/start-bot.cmd`.

3. **Helper scripts** (one job each, spawnable from the bot): `setup-wizard.mjs`, `login-once.mjs`, `job-action.mjs` (does `/save`/`/applied`/`/auth` against hiring.cafe with the persistent profile), `resume-parser.mjs` + `cv-keywords.json` (PDF/DOCX/MD → keyword arrays), `role-suggester.mjs` (CV → suggested job titles), `geocode.mjs` (open-meteo wrapper, no key), `update-checker.mjs` (GitHub Releases poll for `/version` + `/update`), `file-picker.mjs` (Win32 OpenFileDialog), `browser-launcher.mjs` (v2.0.1 — resolves installed Chrome → Edge → bundled Chromium; ALL Playwright launch sites must go through `resolveBrowser()` and spread its `launchOptions`, never hardcode a browser). Also since v2.7: `ai-rerank.mjs` (optional Claude rerank), `self-update.mjs` (sha256-verified in-place update), `telegram-setup.mjs` (GUI Telegram wiring), `export-batch.mjs` + `xlsx-writer.mjs`, `profile-store.mjs`, `scheduler-register.mjs`.

Scoring lives inline in `daily-batch.mjs` (v4.0 overhaul, three passes): (1) a card-level keyword pass over job text vs the CV's `{titles, certs, skills, compliance}` arrays; (2) a second pass that fetches and scores the **real JD**, gated by a role-family check (`OFF_FAMILY_RX`) and an ambiguous-term guard (`AMBIGUOUS_TERM_CONTEXT`/`termAllowedInText`, so "Palo Alto, CA" ≠ "Palo Alto Networks"), with salary as a tie-breaker; (3) an **optional** Claude rerank (`scripts/ai-rerank.mjs`, off unless `scoring.ai.apiKey` is set). Per-job scores (`cardPct/jdPct/aiPct/aiReason/missing/salaryK`) and the `raw → after filters → fresh → above floor → delivered` funnel are written to `data/last-batch.json` so `/why N` and the dashboard can explain them. Config knobs: `scoring.jdRescore`, `scoring.ai`, `scoring.mutedTerms` (see `config.example.json`).

## Conventions

**Spawning Windows binaries: always absolute paths.** Some user installs are missing `C:\Windows\System32` from `PATH` (we've hit this twice — wizard in v0.4.1, bot commands in v0.5). `telegram-bot.mjs` resolves `POWERSHELL`, `CMD_EXE`, `SCHTASKS` from `%SystemRoot%` at the top of the file — follow that pattern for any new spawn of a system tool. Never `spawn('powershell', ...)` or `spawn('cmd.exe', ...)` bare.

**`config.json` writes go through `scripts/config-rw.mjs`.** Atomic temp-file + rename; the bot and a concurrent scrape can both touch the file. `read()`, `set('dot.path', value)`, `addToArray()`, `removeFromArray()`. Don't `JSON.stringify` and `writeFileSync` it directly.

**Telegram messages chunk at ~3900 chars.** `daily-batch.mjs` has `tgChunked()` that splits on blank-line boundaries; reuse it instead of rolling your own. All bot replies use `parse_mode: 'HTML'` — escape user-provided strings.

**Token + chat-ID scrubbing.** Logs must never contain the raw `TG_TOKEN`. Existing pattern: `.replace(TG_TOKEN, '<TOKEN>')` in error handlers. Chat IDs are masked to `***1234`.

**Crash safety in the bot.** `telegram-bot.mjs` installs `unhandledRejection` and `uncaughtException` handlers, and the poll loop has exponential backoff on `fetch failed`. Don't remove these — the bot needs to survive transient Telegram outages and `log()` itself swallows write errors so a locked log file can't kill it.

**Version is single-sourced from `package.json`.** Bumping the version number means editing `package.json` only — `update-checker.mjs#currentVersion()` reads from there for `/version`, the startup ping, and `/help`.

**Personal data and secrets are gitignored.** `.env`, `config.json`, `cv.md`, `cv.pdf`, all of `data/`, and any `*PRIVATE*.md`. `config.example.json` is the shipping template; the wizard copies it to `config.json` and edits in place. `CONTEXT-PRIVATE.md` is for the developer's machine state and never gets committed.

**Branding sentinel.** Task Scheduler / launchd / systemd entries are `munyun-bot`, `munyun-daily-batch`, `munyun-watchdog`, `munyun-batch-missed` (or the Mac/Linux platform-equivalent reverse-DNS / unit-name forms). Old `career-ops-*` migration block was removed in v1.1 — anyone still on v0.1 must `schtasks /delete` those by hand.

## Branching

Always work on a feature/version branch (e.g. `v0.5`, `v0.6`). Do not commit directly to `main`; the user merges branches into main manually via GitHub PRs. The install one-liner clones from `main`.

## Files worth knowing

- `CONTEXT.md` — running project state, file map, recent change history. Update after structural changes.
- `CHANGELOG.md` — Keep-a-Changelog format; add an entry under `[Unreleased]` for any user-visible change.
- `README.md` — public-facing. Keep the command tables in sync when adding/removing bot commands.
- `config.example.json` — shipping template. When adding a new config field, add it here too (with a `_comment` if non-obvious) so wizard-fresh installs get a sensible default.
- `scripts/cv-keywords.json` — ~1,500-term dictionary used by the resume parser. Adding new domains (e.g. data eng, design) means appending here.
