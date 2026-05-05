# Changelog

All notable changes to Automatic Munyun Machine.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed — v0.4.1 (in progress)

- **Wizard no longer crashes at Task Scheduler step on stripped-down Windows installs.** The wizard's call to `spawn('powershell', ...)` relied on `powershell.exe` being on `PATH`. Some user environments — notably one that surfaced this in the wild — don't include `C:\Windows\System32` in `PATH`, so spawn returned `ENOENT` and the wizard exited mid-setup. Now uses the absolute path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, with friendly fall-through error messaging if the spawn still fails.

### Added — v0.4.1 (in progress)

- **Native Windows file picker for the resume step.** New `scripts/file-picker.mjs` spawns a real Windows OpenFileDialog from PowerShell. The wizard now offers three choices: pick from disk via dialog (default), upload via Telegram later, or type the path manually as a fallback. Eliminates the most error-prone step of the wizard for non-technical users.
- **Telegram-only setup path.** Users can skip the resume step in the wizard entirely and upload it later via the existing `/resume` Telegram command. The final wizard banner and the closing Telegram ping both nudge them. Useful when the resume isn't on the same machine as the install.
- **Friendlier error recovery for task registration.** If the Task Scheduler spawn fails, the wizard prints the exact one-line command needed to register manually instead of just dying.

### Added — v0.4

- **Downloadable batch as `.txt` attachment.** Every morning push now ends with a `jobs(YYYY-MM-DD).txt` file sent via Telegram `sendDocument`. Same data the message bubbles contain (rank, title, company, YOE, score, matched keywords, apply URL, view-on-hiring.cafe URL), but consolidated into one file you can open in any text app, search with Cmd+F, and keep forever in your Telegram chat history.
- **`/export` command.** Pull today's `jobs(YYYY-MM-DD).txt` on demand. If today's batch hasn't run yet, falls back to the most recent dated file with a label noting which day it's from. Replies "no batches yet" if `data/` is empty.
- Updated `/help` and bot top-of-file dispatch comment to list `/export`.

## [0.3.0] — 2026-05-04

### Added — bot commands

- `/scrape` (alias for `/daily`) — explicit name signaling on-demand scraping is fine, run as often as you want.
- `/why N` — explain why job #N got its match %, listing the matched CV keywords.
- `/settings` — full config dump in one Telegram message.
- `/resume` — upload a new resume as a Telegram document attachment; bot re-parses skills/certs/titles automatically.
- `/jobs` family — `/jobs` (list), `/jobs add "Title"`, `/jobs remove "Title"`, `/jobs suggest` (auto-suggest titles from CV).
- `/yoe N` — set max years of experience filter.
- `/salary N` — set salary floor in $K.
- `/clearance on/off` — toggle gov clearance filter.
- `/forms all|simple|long` — toggle hiring.cafe `applicationFormEase` filter.
- `/skip <company>` / `/unskip <company>` — manage company skip list.
- `/city <name>` — change weather city, auto-geocoded via open-meteo.
- `/schedule HH:MM` — change daily push time, auto-re-registers Task Scheduler.
- `/forget all` — wipe seen-jobs memory.
- `/forget last` — un-memorize the most recent batch.
- `/cancel` — cancel multi-step interactions like `/resume`.

### Added — wizard

- Setup wizard expanded from 5 steps to **10 steps**:
  - Step 5: auto-suggested job titles from parsed CV (accept all / pick subset / skip)
  - Step 6: max YOE
  - Step 7: salary floor
  - Step 8: clearance filter on/off
  - Step 9: city geocoding (auto-finds lat/lon)
  - Step 10: schedule + finalize (was step 5)

### Added — internals

- `scripts/config-rw.mjs` — atomic `config.json` read/write helper used by all settings commands.
- `scripts/geocode.mjs` — open-meteo geocoding wrapper (no API key, free).
- `scripts/role-suggester.mjs` — CV → suggested job titles by domain cluster (IAM, Cloud Sec, M365, DevOps, Software, Data, etc.).
- `daily-batch.mjs` writes `data/last-batch.json` with per-job match details, used by `/why N`.
- Wider `cv-keywords.json` dictionary (~1,500 terms) covering software, data, ML/AI, design, mobile, ops in addition to original IAM/cloud/security.
- `applicationFormEase` field in `config.json` for the new `/forms` filter.

### Fixed (v0.3.0 patch)

- `/weather` now reads from `config.json` instead of hardcoded Miami coordinates — was a regression where `/scrape` showed your real city but `/weather` always showed Miami.
- `.env` missing now produces a friendly error message pointing at the setup wizard, instead of crashing with `ENOENT`.
- `/resume` pending-state has a 10-minute timeout — stale `/resume` invocations no longer block all future attachments.
- `/save`, `/applied`, `/pause`, `/resume-bot`, `/schedule` spawn calls have a 30-60 second timeout — bot no longer hangs forever if a child process gets stuck.
- `runningJob` lock auto-resets after 5 minutes if the daily-batch subprocess is killed externally — was previously sticking until bot restart.
- `parseResume()` output is now validated before formatting the success reply — corrupted PDFs no longer crash the attachment handler.
- Telegram bot token no longer surfaced in caught error messages or log lines (defense-in-depth scrubbing).
- Allowed chat ID now masked in startup log (`***1234` instead of full ID).
- `setup-tasks.ps1` logs a warning if `config.json` is missing (was silently using defaults).

### Branding

- Task Scheduler entries renamed `career-ops-*` → `munyun-*` (auto-migrates on next `setup-tasks.ps1` run).
- `start-bot.cmd` window title renamed `"career-ops bot"` → `"munyun bot"`.
- `setup-wizard.mjs` final-step function renamed `step5Finalize` → `step10Finalize` for accuracy.

### Documentation

- `README.md` rewritten with full v0.3 command reference and updated 10-step wizard description.
- Roadmap updated to show v0.2 + v0.3 as shipped, future work listed for v0.4 / v1.0 / v2.0.
- `CHANGELOG.md` added (this file).

---

## [0.2.0] — 2026-05-02

### Added

- Initial public release of Automatic Munyun Machine.
- 5-step setup wizard (`scripts/setup-wizard.mjs`).
- One-liner installer (`install.ps1`).
- Telegram bot with daily 7am push of 100 ranked jobs (`scripts/telegram-bot.mjs`).
- hiring.cafe scraper using Playwright off-screen Chromium (`scripts/daily-batch.mjs`).
- Resume parser with curated keyword dictionary (`scripts/resume-parser.mjs`, `scripts/cv-keywords.json`).
- Persistent browser profile for hiring.cafe Google SSO login (`scripts/login-once.mjs`).
- Telegram commands: `/daily`, `/save`, `/applied`, `/auth`, `/reauth`, `/pause`, `/resume-bot`, `/test`, `/help`, `/weather`.
- CV-aware scoring with Option B calibrated percentage bands (30+ → 90-100%, 20-29 → 75-89%, etc.).
- Government clearance filter (drops Top Secret, TS/SCI, Public Trust, DoD).
- Local seen-jobs memory (`data/seen-jobs.json`) — never see the same job twice across runs.
- Auto-detect login state on each scrape; alert via Telegram if session expired.
- Branded Windows Task Scheduler entries: `munyun-daily-batch` (07:00 Mon-Fri) + `munyun-bot` (at logon).

[Unreleased]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/7ustoo/automatic-munyun-machine/releases/tag/v0.3.0
[0.2.0]: https://github.com/7ustoo/automatic-munyun-machine/releases/tag/v0.2.0
