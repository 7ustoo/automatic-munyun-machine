# Changelog

All notable changes to Automatic Munyun Machine.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added — v1.0 E3 (in progress)

- **Match floor (FIXES "0% jobs in batch").** Default 25%; jobs below the threshold are dropped *before* the top-100 cut, so the bot never ships filler when supply is short. New `config.scoring.matchFloorPercent` field. New `/floor N` Telegram command (`/floor 0` to disable, `/floor 50` to be picky).
- **Seen-jobs freshness window (FIXES "only 7 jobs after a few weeks").** Schema upgraded from `{ids: string[]}` (boolean has-seen, grew forever) to `{jobs: {url: {firstSeenAt, lastSeenAt}}}`. Default 60-day decay: unapplied previously-seen jobs roll back into the supply pool. Applied jobs (read from `applications.md`) are always blocked. Old schema auto-migrates on first load. New `config.scoring.seenJobsFreshnessDays` field.
- **Phrase-proximity scoring + term-frequency cap.** Multi-token CV phrases that don't match exactly now get half-credit if all tokens appear anywhere in the JD ("AWS … 50 words … RDS" no longer scores zero). Matches are counted up to 3 occurrences (TF cap) so a JD mentioning "AWS" 8 times no longer ties one mentioning it once.
- **Cluster-aware scoring (kills the IAM-bias problem).** New `clusters` field in `cv-keywords.json` defines 11 role domains (iam, cloudsec, m365, devops, softwareEng, data, soc, networking, design, mobile, product) with signal terms. Resume parser computes hits per cluster and picks top-2 as `primaryClusters`. At scoring time, terms outside primary clusters get half weight — backend/data CVs no longer get IAM-biased rankings. New `cv-parsed.json#primaryClusters` and `clusterScores` fields.
- **Salary parser rewrite.** New `parseSalaryK()` exports handle `$120k–$160K`, `$120,000-$160,000`, em-dash + en-dash, `USD 120K-160K`, and rejects implausible numbers. The old regex extracted bare digits and accidentally matched "K" inside words like "Kotlin". 10 fixtures pin down the new behavior.
- **Supply-diagnostics banner.** When `afterDedup < 30`, the morning batch prepends a banner to the Telegram message: `⚠️ Limited supply today: 14 fresh jobs (typical: 50–80)` with actionable hints (`/forget last`, lowering `/floor`, expanding `/jobs add`). Decisions surface to the user instead of being buried in logs.
- **Per-query dry-run warning.** If any single search query has averaged 0 cards over 3+ consecutive runs, the next batch's banner names the dry queries: `⚠️ Dry queries (3+ days at 0 cards): "M365 Sec Engineer". Likely typo — edit via /jobs remove + /jobs add.`
- **First test suite.** `scripts/__tests__/salary.test.mjs`, `phrase-proximity.test.mjs`, `role-cluster.test.mjs` — 19 tests using built-in `node:test` runner. New `npm test` script.
- **Title heuristic hardened.** Card extraction now validates candidate titles against a non-title blacklist (`/^(full[- ]?time|part[- ]?time|remote|hybrid|onsite|contract|w2|c2c|us only|usa)$/i`) and falls through to the next candidate if the primary line is metadata bleed. Prevents `(untitled)` and "Full Time" / "Remote, US" titles in batches.

### Fixed — v1.0 E3 (in progress)

- **Seen-jobs persistence race.** `seen-jobs.json` was previously written at the top of the post-Telegram block but the variable mutation happened separately. The new write happens *only* after Telegram chunked-message delivery succeeded for the batch and only stamps the surfaced jobs.
- **`scoreJob` and `parseSalaryK` are now safe to import** — `daily-batch.mjs` gates its top-level pipeline IIFE behind a CLI-vs-imported check (`IS_CLI`) so test files can pull engine functions without triggering a real scrape + Telegram push at module load. `.env` validation also gated on CLI invocation.

### Added — v1.0 E2 (in progress)

- **Heartbeat + out-of-process watchdog.** Bot writes `data/heartbeat.json` every poll iteration with `{ts, pid, version, lastPollOk, consecutiveFailures}`. New `scripts/watchdog.mjs` runs every 5 minutes via Task Scheduler entry `munyun-watchdog` — if the heartbeat is stale > 10 min, it kills the bot, restarts the `munyun-bot` task, and pings Telegram via `scripts/telegram-send.mjs` (independent process, so a corrupt bot module can't take the alerter down). Throttled to 3 restart attempts per hour; after the limit, sends a single "give up — human needed" alert and stops trying. Solves the silent-death failure mode (we hit it during v0.5 release work — bot died without surfacing).
- **`/status` command.** One-screen bot health snapshot: process uptime, last heartbeat, last batch (date + count + funnel + score band), last auth-OK, batch-in-progress lock state, scheduled-task state. Read by user; structured similarly by the watchdog.
- **`/diagnose` command.** Answers "why am I getting only N jobs?" directly. Surfaces the last batch's funnel (raw → keptAfterFilter → afterDedup → sent), seen-jobs total, and per-query 7-day average card count with low-supply queries flagged. If the batch was below typical supply (< 30 fresh jobs), `/diagnose` includes hint actions (`/forget last`, `/jobs add`).
- **Per-query supply history.** New `data/query-stats.json` written by `daily-batch.mjs` after each scrape — rolling 7-day window of `{date, cards}` per query term. Read by `/diagnose`.
- **Funnel persistence in `data/last-batch.json`.** New `funnel: {raw, keptAfterFilter, droppedClearance, afterDedup, scored, sent, topPct, medianPct, bottomPct}` field. Read by `/status` and `/diagnose`.
- **Batch-missed watcher.** New `scripts/batch-missed-watcher.mjs` + Task Scheduler entry `munyun-batch-missed`. Runs 1 hour after configured batch time on configured days. If today's `data/today-batch-{date}.tsv` is missing, pings Telegram. Idempotent — won't re-alert for the same date. File-existence check is the truth; doesn't parse logs.
- **Initial heartbeat at bot startup** so the watchdog sees a fresh boot as alive within seconds, not after the first 30s long-poll round-trip.

### Fixed — v1.0 E2 (in progress)

- **`recordAuthOk()` no longer lies on a failed scrape.** Was previously called immediately after `/saved` loaded successfully, even if the subsequent scrape loop returned zero cards across all 15 queries. Now deferred to after the loop completes AND at least one card was extracted. `/status` and `/diagnose` no longer show "auth OK" when the user is effectively broken.

### Changed — v1.0 E2 (in progress)

- `setup-tasks.ps1` now registers four Task Scheduler entries instead of two: `munyun-bot`, `munyun-daily-batch`, `munyun-watchdog`, `munyun-batch-missed`. The watchdog runs every 5 min; the batch-missed watcher runs at scheduled-time + 1 hour on scheduled days.
- `scripts/telegram-bot.mjs` header comment refreshed in v1.0 E1 was missing 20+ commands shipped after v0.2; now lists the full set.

### Removed — v1.0 E1

- Stale `career-ops` references in `scripts/telegram-bot.mjs` (header comment + Task Scheduler entry name) and `scripts/telegram-send.mjs` (default test message). The dual-directory `career-ops/` ↔ AMM workflow described in `CONTEXT.md` was de facto deprecated; this commit cleans up the references and rewrites the relevant CONTEXT sections.

---

## [0.5.0] — 2026-05-06

### Added

- **Version everywhere.** The bot's startup ping now reads `🤖 Automatic Munyun Machine v0.5.0 — online`. Same for the `/help` header. Single source of truth: `package.json`'s `version` field.
- **`/version` command.** Shows running version + latest version on GitHub. Hint to run `/update` if behind.
- **`/update` command.** Pulls latest from `main` via `git pull`, runs `npm install` if deps changed, restarts the bot — all from Telegram. No more "open PowerShell, paste one-liner, walk wizard." Sub-commands: `/update` (run it), `/update skip` (don't notify me about this version again), `/update check` (re-check now), `/update notes` (show release notes).
- **Update notification on bot startup + once per day.** Bot polls GitHub Releases API on startup (after a 5s delay) and every 24h. If a newer version exists and you haven't dismissed it, you get a Telegram message: `🆕 Update available: v0.4.1 → v0.5.0` with what's new + the install command. No telemetry — outbound only, no auth, no identifying info.
- **Post-update confirmation.** After a successful `/update`, the new bot detects the upgrade and replies `✅ Updated to v0.5.0 (was v0.4.1)` instead of the generic startup ping. Clear signal that the upgrade worked.
- New `scripts/update-checker.mjs` module — handles GitHub API polling, semver comparison, dismissed-version persistence in `data/update-state.json`, and the post-update flag (`data/.updating`).

### Changed

- **`checkForUpdate` results cached for 5 minutes** to avoid hammering the GitHub API when a user spams `/version`, `/update check`, etc. `/update check` passes `{ force: true }` to bypass the cache when the user explicitly asks for a fresh check.
- Removed unused `getDismissed` import in `telegram-bot.mjs` (the `dismissed` field on `checkForUpdate`'s return value is what's actually used).

### Fixed

- **Bot commands that spawn Windows tools no longer fail with `exit -2` on stripped PATH.** Surfaced when a tester ran `/pause` and got `❌ Could not pause (exit -2)`. Same root cause as the v0.4.1 wizard PATH bug: `spawn('powershell', ...)` and `spawn('cmd.exe', ...)` rely on `PATH` lookup, which is missing `C:\Windows\System32` on some Windows installs we're seeing in the wild. Replaced every bare-binary spawn in `telegram-bot.mjs` with absolute paths resolved from `%SystemRoot%`. Affects `/pause`, `/resume-bot`, `/schedule`, `/reauth`, `/scrape`, and the `/update` restarter. Also surfaces spawn-error details to Telegram (e.g. `<i>spawn error: ENOENT</i>`) instead of just `exit -2` so the cause is visible.
- **`consumePostUpdateFlag` guards against false-positive "✅ Updated to vX.Y.Z" messages.** If `markUpdating` wrote the flag but the actual upgrade never landed (git pull/npm install failed before `process.exit`, or the bot restarted from stale code), the next bot boot would have lied about the upgrade succeeding. Now verifies `flag.to === currentVersion()` before reporting success — if mismatched, silently consumes the flag.

---

## [0.4.1] — 2026-05-05

### Added

- **Native Windows file picker for the resume step.** New `scripts/file-picker.mjs` spawns a real Windows OpenFileDialog from PowerShell. The wizard now offers three choices: pick from disk via dialog (default), upload via Telegram later, or type the path manually as a fallback. Eliminates the most error-prone step of the wizard for non-technical users.
- **Telegram-only setup path.** Users can skip the resume step in the wizard entirely and upload it later via the existing `/resume` Telegram command. The final wizard banner and the closing Telegram ping both nudge them. Useful when the resume isn't on the same machine as the install.
- **Friendlier error recovery for task registration.** If the Task Scheduler spawn fails, the wizard prints the exact one-line command needed to register manually instead of just dying.

### Fixed

- **Wizard no longer crashes at Task Scheduler step on stripped-down Windows installs.** The wizard's call to `spawn('powershell', ...)` relied on `powershell.exe` being on `PATH`. Some user environments — notably one that surfaced this in the wild — don't include `C:\Windows\System32` in `PATH`, so spawn returned `ENOENT` and the wizard exited mid-setup. Now uses the absolute path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, with friendly fall-through error messaging if the spawn still fails.
- **Wizard no longer prints `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` on shutdown.** The bot-start spawn used `detached: true` with default piped stdio, so the parent process held references to the child's stdin/stdout/stderr pipes. Combined with an explicit `process.exit(0)` at the wizard's end, libuv (Node's async I/O layer) hit an internal assertion at `src/win/async.c:76` because the event loop tried to operate on handles that were already closing. Two-part fix: spawn now uses `stdio: 'ignore'` + explicit `child.unref()` so the parent never tracks the child's pipes, and the wizard no longer force-exits — Node drains the event loop naturally.
- **Bot survives transient Telegram outages instead of silently dying.** Surfaced when the bot died during a 3-minute network blip and stayed dead until a manual restart. Three-part hardening to `telegram-bot.mjs`: (1) added `unhandledRejection` and `uncaughtException` process handlers so a single weird-shaped error never kills the process — gets logged with token scrubbed and the bot keeps polling; (2) exponential backoff in the poll loop (5s → 10s → 20s → 30s cap) so we don't hammer Telegram during outages; (3) recovery detection that logs `Telegram reachable again — recovered after N failed polls` when polls start succeeding again, plus a `📶 Bot reconnected after ~Xm of poll failures` Telegram ping if the outage was ≥ 60s so you know the bot was offline. Also wrapped `log()`'s file write in try/catch so a locked log file can't crash the bot.

---

## [0.4.0] — 2026-05-04

### Added

- **Downloadable batch as `.txt` attachment.** Every morning push now ends with a `jobs(YYYY-MM-DD).txt` file sent via Telegram `sendDocument`. Same data the message bubbles contain (rank, title, company, YOE, score, matched keywords, apply URL, view-on-hiring.cafe URL), but consolidated into one file you can open in any text app, search with Cmd+F, and keep forever in your Telegram chat history.
- **`/export` command.** Pull today's `jobs(YYYY-MM-DD).txt` on demand. If today's batch hasn't run yet, falls back to the most recent dated file with a label noting which day it's from. Replies "no batches yet" if `data/` is empty.
- Updated `/help` and bot top-of-file dispatch comment to list `/export`.

### Fixed

- `setup-tasks.ps1` no longer crashes on shells that interpret UTF-8 em-dashes oddly — em-dashes replaced with ASCII hyphens.

---

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

[Unreleased]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/7ustoo/automatic-munyun-machine/releases/tag/v0.3.0
[0.2.0]: https://github.com/7ustoo/automatic-munyun-machine/releases/tag/v0.2.0
