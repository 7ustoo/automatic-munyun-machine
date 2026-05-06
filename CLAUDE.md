# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Automatic Munyun Machine (AMM) — a local-first Windows tool that scrapes hiring.cafe daily, ranks 100 jobs against the user's CV, and pushes them to Telegram. Pure Node.js + Playwright; no server, no cloud, no third-party APIs beyond hiring.cafe / open-meteo / Telegram. Targets non-technical end users installed via a one-liner; setup is wizard-driven.

`README.md` is the user-facing surface. `CONTEXT.md` is the running state-of-the-project doc — read it before making structural changes, and update it after any commit that adds a command, file, or schema field.

## Commands

```bash
npm install
npx playwright install chromium       # one-time; pulls Chromium into the user profile

npm run setup       # interactive 10-step setup wizard (creates .env + config.json)
npm run daily       # one-shot scrape + Telegram push (also: node scripts/daily-batch.mjs)
npm run bot         # long-running Telegram poller
npm run login       # opens Chromium so user signs into hiring.cafe (persists session)
npm run parse-resume <path>   # re-parse CV → data/cv-parsed.json
```

There is no test suite, linter, or build step — changes are validated by running `npm run daily` end-to-end and watching the Telegram output, plus tailing `data/daily-batch-{date}.log` and `data/telegram-bot.log`.

Restart the bot after editing `telegram-bot.mjs`:
```powershell
Get-Process node | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'telegram-bot' } | Stop-Process -Force
Start-ScheduledTask -TaskName 'munyun-bot'
```

## Architecture

Three independent processes share one filesystem — there is no shared memory, no IPC, no daemon. State lives in `config.json` and `data/*.json`.

1. **`scripts/daily-batch.mjs`** — the scraper. Launches a persistent-profile Playwright Chromium, runs each `config.queries[]` term against hiring.cafe, scores results against `data/cv-parsed.json`, resolves direct ATS apply URLs, and pushes the top 100 to Telegram (chunked messages + a `jobs(YYYY-MM-DD).txt` attachment). Triggered by Task Scheduler `munyun-daily-batch` weekdays at 07:00, by `/scrape` from the bot, or manually via `npm run daily`. Writes `data/last-batch.json` so `/why N` can explain a score after the fact.

2. **`scripts/telegram-bot.mjs`** — the long-running poller. `getUpdates` every ~3s, dispatches ~30 commands (see README's command tables). Stateful only via `data/bot-offset.json` (poll cursor) + a small in-memory `runningJob` lock. Most settings commands route through `scripts/config-rw.mjs` for atomic writes; commands that mutate scheduling/login spawn helper scripts. Started at logon by Task Scheduler `munyun-bot` via `scripts/start-bot.cmd`.

3. **Helper scripts** (one job each, spawnable from the bot): `setup-wizard.mjs`, `login-once.mjs`, `job-action.mjs` (does `/save`/`/applied`/`/auth` against hiring.cafe with the persistent profile), `resume-parser.mjs` + `cv-keywords.json` (PDF/DOCX/MD → keyword arrays), `role-suggester.mjs` (CV → suggested job titles), `geocode.mjs` (open-meteo wrapper, no key), `update-checker.mjs` (GitHub Releases poll for `/version` + `/update`), `file-picker.mjs` (Win32 OpenFileDialog).

Scoring lives inline in `daily-batch.mjs`: keyword overlap between job text and CV's `{titles, certs, skills, compliance}` arrays, weighted by `config.scoring.*`, then mapped to a calibrated percentage band (see the `_percentBands` comment in `config.example.json`).

## Conventions

**Spawning Windows binaries: always absolute paths.** Some user installs are missing `C:\Windows\System32` from `PATH` (we've hit this twice — wizard in v0.4.1, bot commands in v0.5). `telegram-bot.mjs` resolves `POWERSHELL`, `CMD_EXE`, `SCHTASKS` from `%SystemRoot%` at the top of the file — follow that pattern for any new spawn of a system tool. Never `spawn('powershell', ...)` or `spawn('cmd.exe', ...)` bare.

**`config.json` writes go through `scripts/config-rw.mjs`.** Atomic temp-file + rename; the bot and a concurrent scrape can both touch the file. `read()`, `set('dot.path', value)`, `addToArray()`, `removeFromArray()`. Don't `JSON.stringify` and `writeFileSync` it directly.

**Telegram messages chunk at ~3900 chars.** `daily-batch.mjs` has `tgChunked()` that splits on blank-line boundaries; reuse it instead of rolling your own. All bot replies use `parse_mode: 'HTML'` — escape user-provided strings.

**Token + chat-ID scrubbing.** Logs must never contain the raw `TG_TOKEN`. Existing pattern: `.replace(TG_TOKEN, '<TOKEN>')` in error handlers. Chat IDs are masked to `***1234`.

**Crash safety in the bot.** `telegram-bot.mjs` installs `unhandledRejection` and `uncaughtException` handlers, and the poll loop has exponential backoff on `fetch failed`. Don't remove these — the bot needs to survive transient Telegram outages and `log()` itself swallows write errors so a locked log file can't kill it.

**Version is single-sourced from `package.json`.** Bumping the version number means editing `package.json` only — `update-checker.mjs#currentVersion()` reads from there for `/version`, the startup ping, and `/help`.

**Personal data and secrets are gitignored.** `.env`, `config.json`, `cv.md`, `cv.pdf`, all of `data/`, and any `*PRIVATE*.md`. `config.example.json` is the shipping template; the wizard copies it to `config.json` and edits in place. `CONTEXT-PRIVATE.md` is for the developer's machine state and never gets committed.

**Branding sentinel.** Task Scheduler entries are `munyun-daily-batch` and `munyun-bot`. Old `career-ops-*` names are auto-migrated by `setup-tasks.ps1` — leave that migration block alone until v1.x.

## Branching

Always work on a feature/version branch (e.g. `v0.5`, `v0.6`). Do not commit directly to `main`; the user merges branches into main manually via GitHub PRs. The install one-liner clones from `main`.

## Files worth knowing

- `CONTEXT.md` — running project state, file map, recent change history. Update after structural changes.
- `CHANGELOG.md` — Keep-a-Changelog format; add an entry under `[Unreleased]` for any user-visible change.
- `README.md` — public-facing. Keep the command tables in sync when adding/removing bot commands.
- `config.example.json` — shipping template. When adding a new config field, add it here too (with a `_comment` if non-obvious) so wizard-fresh installs get a sensible default.
- `scripts/cv-keywords.json` — ~1,500-term dictionary used by the resume parser. Adding new domains (e.g. data eng, design) means appending here.
