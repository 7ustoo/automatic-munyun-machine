# Changelog

All notable changes to Automatic Munyun Machine.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.1.0] — 2026-05-08

> **"Cross-platform + hardened."** Two parallel tracks bundled into one release: every HIGH-severity bug from the v1.0 code review closed, and Mac launchd + Linux systemd ports landed alongside a GitHub Actions release pipeline. Ships as one PR — no per-phase branches.

### Added — Cross-platform support

- **macOS** runs via launchd. New `scripts/setup-tasks-mac.sh` renders four LaunchAgent plists into `~/Library/LaunchAgents/` (`com.amm.bot` with `RunAtLoad`+`KeepAlive(Crashed)`, `com.amm.daily` with `StartCalendarInterval`, `com.amm.watchdog` with `StartInterval=300`, `com.amm.batch-missed` with `StartCalendarInterval`+1h).
- **Linux** runs via systemd user units. New `scripts/setup-tasks-linux.sh` renders four units into `~/.config/systemd/user/` and enables linger so they fire when the user isn't logged in.
- **Cross-platform installer** at `install.sh` mirroring `install.ps1`. Auto-detects platform via `uname -s`, installs missing prereqs (git, node ≥ 18) via `brew` / `apt-get` / `dnf`, clones into `~/Library/Application Support/automatic-munyun-machine` (Mac) or `~/.local/share/automatic-munyun-machine` (Linux), runs `npm install` + `npx playwright install chromium`, hands off to the wizard.
- **Bash launcher trio** (`scripts/start-bot.sh`, `scripts/run-daily-batch.sh`, `scripts/login-once.sh`) symmetric to the existing `.cmd` launchers.
- **Native file picker on macOS + Linux** via `osascript "choose file"` (Mac) / `zenity` (GNOME) / `kdialog` (KDE), with typed-path fallback when no GUI dialog backend is available.
- **`scripts/os-paths.mjs`** — single source of truth for system-binary paths (`POWERSHELL`/`CMD_EXE`/`SCHTASKS` on Win32, `BASH`/`LAUNCHCTL`/`SYSTEMCTL`/`OSASCRIPT` on POSIX), `npmCmd()` / `nodeCmd()` resolution, and scheduler abstractions (`runScheduledTask` / `disableScheduledTask` / `enableScheduledTask` / `scheduledTaskExists` / `deleteScheduledTask` — internally branch by `process.platform`). User-facing helper-name strings (`LOGIN_HELPER_DOC`, `SETUP_HELPER_DOC`, `RESTART_HINT_DOC`, `INSTALL_DIR_HINT`) resolve to the right per-platform path so Telegram messages render correctly across all three platforms.
- **`scripts/io-helpers.mjs`** — atomic write helpers (`atomicWriteText`, `atomicWriteJson`, `atomicUpdateJson`) with NTFS EPERM/EACCES/EBUSY retry, plus `withFileLock` / `lockedUpdateJson` / `lockedUpdateJsonSync` via `proper-lockfile` for cross-process serialization of `config.json` and per-profile JSON file writes.

### Added — Code signing + CI

- **`docs/SIGNING.md`** — maintainer playbook covering Microsoft Trusted Signing (Windows), Apple Developer ID + notarization (macOS), and GPG self-signed (Linux .deb / .AppImage).
- **`scripts/build/sign-windows.ps1`** — AzureSignTool wrapper.
- **`scripts/build/notarize-mac.sh`** — `xcrun notarytool submit --wait` + `xcrun stapler staple`.
- **`scripts/build/sign-linux.sh`** — `dpkg-sig` for `.deb`, detached GPG `.sig` for AppImages.
- All three signers degrade gracefully: missing secrets log `[skip signing — env:X not set]` and exit 0; releases still ship unsigned-but-functional artifacts.
- **`scripts/build/mac.sh`** — `hdiutil`-based `.dmg` builder. Stages source tree (excludes `node_modules`/`data`/`.env`/`cv.*`/`.planning`); embeds a "Run Setup.command" double-click target that runs `npm install` + `playwright install` + wizard on first launch.
- **`scripts/build/deb.sh`** — `dpkg-deb` builder. Installs to `/opt/automatic-munyun-machine` + `/usr/local/bin/amm` wrapper exposing `setup`/`daily`/`bot`/`login`/`uninstall` subcommands. Depends: `nodejs >= 18`, `git`. Recommends: `zenity | kdialog`.
- **`scripts/build/appimage.sh`** — `appimagetool` builder with a bundled Node 20 runtime so the AppImage works on minimal distros without system Node.
- **`.github/workflows/ci.yml`** — matrix CI on `(windows-latest, macos-latest, ubuntu-latest) × (Node 18, 20)`. Per-PR + per-push. Runs `npm test` on every leg + an `os-paths` import smoke test.
- **`.github/workflows/release.yml`** — triggered by `v*.*.*` tag push. Three parallel build jobs. Each runs tests, builds the platform installer, conditionally signs (best-effort), uploads as artifact. Final `publish` job downloads all artifacts, computes `SHA256SUMS.txt`, creates GitHub Release with auto-generated notes.

### Added — Tests

41 new unit tests bringing the total from 24 → 65 (all passing on Windows). Same suite runs on Mac + Linux via the CI matrix.

- **`scripts/__tests__/callback-router.test.mjs`** (18 tests) — `makeCallback` / `parseAndVerify` round-trip, sig determinism, action/idx/token-divergence checks, `requireToken` throw, `KNOWN_ACTIONS` whitelist, timing-safe sig compare via `crypto.timingSafeEqual`, malformed-input handling, full round-trip with `writeCallbackTable` + sig verification, stale-rotation rejection.
- **`scripts/__tests__/io-helpers.test.mjs`** (16 tests) — atomic write semantics, lock release on success/throw, `withFileLock` serializes `Promise.all` of three incrementers (final v=3, no lost updates), and the cross-process integration test: 3 child node processes × 30 increments each → final v=90 with no lost updates. (Pre-Phase 2 this routinely lost updates on Windows.)
- **`scripts/__tests__/watchdog.test.mjs`** (7 tests) — healthy heartbeat → no kill; stale → kill + start + recovery alert; F-M7 failed-start does NOT increment restarts; MAX_RESTARTS gives up with single alert; alert is suppressed on second consecutive give-up within 1h window; `pruneRestarts` drops old timestamps; no-heartbeat short-circuit.

### Changed — Cross-platform plumbing

- `telegram-bot.mjs` `/pause` / `/resume-bot` / `/reauth` / `/schedule` / `/update` restart all branch through `os-paths` instead of hardcoding PowerShell + schtasks. `/status` scheduled-tasks probe goes through `scheduledTaskExists`.
- `setup-wizard.mjs` `registerSchedulerForPlatform()` picks `setup-tasks.ps1` (Win32) / `setup-tasks-mac.sh` (Darwin) / `setup-tasks-linux.sh` (Linux) and `startBotForPlatform()` uses `runScheduledTask('bot')`. `POWERSHELL_EXE` retained as a Win32-only alias.
- `uninstall.mjs` cross-platform: launchctl bootout + plist removal on Mac, `systemctl --user disable --now` + unit removal on Linux. POSIX `process.kill` + `pgrep -f` cmdline cleanup replaces the PowerShell `Stop-Process` orphan-killer on non-Windows.
- All `config.json` and per-profile JSON writes (`seen-jobs.json`, `last-batch.json`, `last-batch-callbacks.json`, `auth-state.json`, `query-stats.json`) now route through `atomicWriteJson` / `lockedUpdateJsonSync`. The TOCTOU window in `cfgRW.set` / `appendUnique` / `removeFromArray` is closed.
- User-facing Telegram strings that referenced `scripts\login-once.cmd` / `scripts\setup-tasks.ps1` / `%LOCALAPPDATA%` now read from the platform-aware `LOGIN_HELPER_DOC` / `SETUP_HELPER_DOC` / `RESTART_HINT_DOC` / `INSTALL_DIR_HINT` constants.

### Fixed — Hardening (v1.0 code review findings)

Closes 9 HIGH + 7 MEDIUM findings from the GSD `gsd-code-reviewer` audit (`.planning/REVIEW.md`):

- **F-H1: HTML injection via unescaped `directUrl`** in batch + browser + history + saved messages. Added `escHtmlAttr()` helper that escapes `"` for href-attribute contexts (Telegram HTML mode does NOT auto-escape `"`); applied to every `<a href="…">` interpolation. `resolveOnePage` now rejects malformed `apply_url` values upstream via regex sanity check.
- **F-H2: Token scrubbing missing in `daily-batch.mjs` error paths.** Hoisted `SCRUB(s)` helper that tokenizes `TG_TOKEN` to `<TOKEN>`. Applied to `log()`, `tg()` throws, `tgDocument()` throws, the CLI outer catch, the bot's `unhandledRejection` handler, the resume-upload network error, and `setup-wizard.mjs` token validation. Local log files + Telegram-bound error messages no longer leak the token via fetch-internal `cause` chains.
- **F-H3: `fs.renameSync` not atomic on NTFS when destination exists.** `config-rw.mjs#atomicWrite` got an EPERM/EACCES/EBUSY retry loop with 50/100/150/200 ms backoff and unique tmp-file suffix. Phase 2 layered `proper-lockfile` advisory locking on top via `lockedUpdateJsonSync` so concurrent writers serialize cleanly. Cross-process integration test (3 children × 30 writes) confirms zero lost updates.
- **F-H4: HMAC keying defaults to literal `'no-token'` if missing.** `callback-router.mjs#requireToken` throws if the token is missing or < 10 chars; `parseAndVerify` returns `{ok:false}` for missing tokens instead of trusting a fallback-keyed sig.
- **F-H5: Browser context not closed on `scrape()` / `resolveAll()` failure.** Both wrapped in `try/finally` with `ctx.close().catch(() => {})` in `finally`. A page-1 navigation failure no longer leaves a Chromium LevelDB lockfile that blocks the next run.
- **F-H6: `unhandledRejection` handler brittle if `TG_TOKEN` undefined.** Defensive `SCRUB(s)` checks `TG_TOKEN` truthiness before `replace`; eliminates the `String.replace(undefined, …)` substring-replace failure mode.
- **F-H7: `loadAppliedHrefs()` case-sensitive viewjob ID regex.** Added `/i` flag + `.toLowerCase()` normalization at the boundary so an upstream ID-case shift doesn't silently re-show applied jobs. Same for `/history` callback URL parsing.
- **F-H8: `/forget last` writes seen-jobs without atomic.** Now goes through `atomicWriteJson(seenPath, seen)` — no more torn-write window where a concurrent scrape's `saveSeenStore` clobbers the user's `/forget last`.
- **F-H9: `addProfile` produces a broken first batch.** When `addProfile(slug, opts)` runs, it now copies `cv-parsed.json` from the source profile so the new persona inherits a working CV. `daily-batch.mjs` checks for an empty CV at startup and pings Telegram with a `/resume` nudge instead of running an all-zeros batch.
- **F-M1: `escHtml(e.message)` at 4 sites** that interpolated raw error text into `parse_mode:'HTML'` replies (weather / settings / geocoding / forget last).
- **F-M2: HMAC sig comparison uses `crypto.timingSafeEqual`** instead of `===`. Flagged for cryptographic-primitive correctness even though the practical timing-oracle risk is essentially nil here.
- **F-M3: `KNOWN_ACTIONS` whitelist** gates `makeCallback` and `parseAndVerify` before the HMAC compute.
- **F-M5: Decay-then-add race in `saveSeenStore`.** Dropped the belt-and-suspenders `blockedSet` rewrite that reset `firstSeenAt` for near-expired entries. The documented "60-day decay since first sighting" promise now actually holds — preserves original `firstSeenAt` by reading the pre-decay store.
- **F-M6: Watchdog cmdline regex anchored to `telegram-bot\.mjs`** (was a bare substring match — could collateral-kill an editor process whose CLI happened to contain "telegram-bot"). Same anchor fix in `uninstall.mjs#killBot`.
- **F-M7: Watchdog only counts a successful restart** toward `MAX_RESTARTS`. A transient scheduler failure no longer burns one of the three retry slots when no restart actually happened.
- **F-M10: Profile-store migration rename failure** now `console.error`s instead of silently swallowing — stranded data files would have looked like an empty new install after migration.
- **F-M13: `/jobs add` fallback slug for non-Latin terms.** Empty key would silently collide with another non-Latin query in `results[key]`; now derives `q<timestamp>` if the slug collapses to empty.

### Removed

- `setup-tasks.ps1` legacy `career-ops-*` Task Scheduler migration block (was gated on "until v1.x"; we are now v1.x). Anyone upgrading from v0.1 must `schtasks /delete /tn career-ops-*` by hand. The block was a no-op on every install ≥ v0.2.

### Added — Dependencies

- `proper-lockfile@^4.0.0` — single new prod dep (~30 KB), used for advisory file locking around `config.json` + per-profile JSON writes.

---

## [1.0.0] (post-release patches — superseded by v1.1)

### Fixed — v1.0 post-release patch

- **Daily batch was running only the 3 default queries instead of the user's full list (and weather + filters were silently disabled).** Regression introduced by E5 multi-profile migration: `daily-batch.mjs`, `batch-missed-watcher.mjs`, and `setup-tasks.ps1` had their own raw `JSON.parse(fs.readFileSync('config.json'))` reads that didn't know about the new `{active_profile, profiles: {<slug>: {...}}}` schema. After migration, `CFG.queries` / `CFG.weather` / `CFG.filters` / `CFG.scoring` resolved to `undefined`, which fell through to hardcoded defaults — 3 queries (`IAM Engineer`, `Cloud Security Engineer`, `Cybersecurity Engineer`) and the weather-unavailable fallback. Fixed by routing all three through `readActiveConfig()` (in `daily-batch.mjs` and `batch-missed-watcher.mjs`) and adding a profile-aware schedule lookup in `setup-tasks.ps1`. Verified end-to-end: live `/scrape` now fires all 16 of this dev's queries (raw=409 vs the 116 the bug produced) and surfaces 38 fresh jobs with weather + dropTitlePatterns + skipCompanies filters all active.
- **Direct ATS apply URLs were silently 100% broken.** `resolveOne()` used Node `fetch()` to read viewjob HTML and regex-extract `apply_url`. Hiring.cafe (Cloudflare in front) returns 403 to plain HTTP fetches — even authenticated `APIRequestContext` with the bot's session cookies gets 403. The function caught the error and returned null, so every batch fell back to hiring.cafe links via `directUrls[i] || r.href`. Today's pre-fix log showed `resolved=0/38`. **Fixed** by replacing `resolveAll` with a Playwright-based resolver that reuses the persistent `browser-profile/` (auth carries over), spawns 5 concurrent `page.goto()` workers, and extracts `apply_url` from the rendered HTML. Verified live: `resolved=59/59` on the post-fix scrape. Cost: ~30s for 60 jobs (was ~5s but failing); acceptable for a daily cron.

### Added — v1.0 post-release patch

- **Pagination across hiring.cafe search results.** The scraper now clicks the `a[aria-label*="next" i]` pagination link to pull pages 2..N per query, up to `MAX_PAGES_PER_QUERY` (default **50**, configurable via new `config.scoring.maxPagesPerQuery`). Stops early when Next disappears OR a new page returns zero new cards (per-query dedup against viewjobUrl). Live verification: `cloud security` query alone went from 40 cards (page 1 only) to 80 cards (2 pages of unique results); `iam` went 40 → 120 across 3 pages; `IAM Engineer` went 40 → 120; `M365 Administrator` 40 → 115. Total run: raw=698 vs 409 pre-fix (+70%), fresh-after-dedup 74 vs 40 (+85%), 59 jobs delivered vs 38.
- **Target-driven cross-query early stop.** New `config.scoring.targetJobsPerBatch` (default 100). After each query's pagination, the bot computes a running fresh-after-dedup estimate. Once it hits `target × 1.5` (50% headroom for filter+floor losses), the QUERIES loop exits early. On heavy-supply days this cuts batch time dramatically — live verification: scrape ran only 1/16 queries (IAM Engineer paginated 8 pages to 301 raw cards) and stopped early. Total scrape time: ~55 sec vs ~3 min.
- **`/saved` command.** New paginated browser of locally-bookmarked jobs (`data/profiles/<active>/saved.md`), 5 per page, `⬅️/➡️` inline-button navigation. Counterpart to `/history`. Used by `/save N` and the `[💾 Save]` callback button.

### Changed — v1.0 post-release patch

- **Hiring.cafe scrape is now auth-OPTIONAL.** Replaced the Google sign-in dance in `scripts/login-once.mjs` with a passive Cloudflare warmup: a visible Chromium window loads `hiring.cafe/`, waits up to 45s for Cloudflare's bot challenge to auto-resolve (job cards become visible), and saves the persistent profile. **No Google sign-in required.** Hiring.cafe lets logged-out users browse jobs; the only blocker for headless scrapes was Cloudflare's challenge, which a real-browser visit clears. The persistent profile keeps the "challenge passed" cookie for subsequent headless runs. Verified: a fresh, never-signed-in profile passes Cloudflare in ~20 seconds and returns full 40-card pages on `cloud security` queries, plus extracts `apply_url` from individual viewjob pages successfully.
- **`scripts/daily-batch.mjs::checkLogin()` → `checkBrowsable()`.** Probes a search URL and waits up to 25s for cards to render. Returns true if the search UI works at all — the only thing the scraper actually needs. Old `checkLogin` visited `/saved` (auth-only); replaced because we no longer require auth.
- **`searchState.hideJobTypes` field removed** from search URL building. That field only takes effect for logged-in users; we now scrape unauth. Local `seen-jobs.json` + `applications.md` cover the dedup we actually need. Side benefit: hiring.cafe returns more results per query because nothing's filtered server-side based on an account's history.
- **`/save N` and `/applied N` are now local-first.** They write to `saved.md` / `applications.md` *first* (source of truth), then attempt the hiring.cafe-side click as a best-effort. New exit code `7` from `job-action.mjs` means "not signed in — skipping hiring.cafe action" and the bot replies `✅ Saved/Applied locally. (Run /reauth to also act on hiring.cafe.)`. Users without a hiring.cafe account get full local bookmarking + applied-tracking; the hiring.cafe-side button-click is opt-in via `/reauth`.
- **Setup wizard Step 3 copy** rewritten: no longer mentions Google sign-in. Tells the user to wait for jobs to render and close the window. Sign-in inside the window is documented as optional (enables hiring.cafe-side `/save` and `/applied`).
- **`/help` text** updated: `/auth` and `/reauth` now noted as optional; `/saved` added.
- **Supply-diagnostics banner** in the morning batch now includes a dedup-pressure callout when ≥50% of filter-passing cards were dropped as already-seen, with a direct pointer to `seenJobsFreshnessDays` (the actual lever) instead of generic "try /forget last."

### Added

### Changed

---

## [1.0.0] — 2026-05-06

> **"Trustworthy and shareable on Windows."** Six sequenced epics (E1–E6) closing the foundational gaps the v0.5 audit surfaced: silent-death reliability, depth-blind scoring, IAM-bias, supply that decayed to nothing, single-user wall, and the install/uninstall lifecycle. Telegram-first remains the thesis; the planned-then-cut Tauri GUI does not return.

### Added — v1.0 E6 (Distribution + uninstall lifecycle)

- **Inno Setup `.exe` installer.** New `installer/amm.iss` builds an `amm-setup-vX.Y.Z.exe` that bundles `npm install` + `npx playwright install chromium` + the setup wizard. Standard Add/Remove Programs uninstaller works. Unsigned for v1.0 (signing arrives in v1.1).
- **`/uninstall` Telegram command** with inline confirmation buttons. `[⚠️ Pause only]` stops the bot + unregisters all four scheduled tasks but preserves data. `[☠️ Wipe everything]` does pause steps + deletes `data/`, `config.json`, `.env`, browser session. Bot can't delete its own dir; final message tells the user to remove the install dir by hand if they want the code gone.
- **`scripts/uninstall.mjs`** — orchestrator with `--mode=pause|wipe`. Idempotent — safe to re-run on partial state. Kills the bot via PID match (cleanest) + cmdline-match cleanup. Unregisters all four `munyun-*` Task Scheduler entries. Wipe mode also wipes data + secrets.
- **`scripts/uninstall.ps1`** — PowerShell wrapper for `iwr | iex` users. Symmetric to the install one-liner.
- **README rewrite** — `.exe` installer leads as the recommended path; one-liner kept as Option 2 for developers; manual install as Option 3. Old "Want to start over from scratch" troubleshooting section replaced with three uninstall paths (Telegram, Add/Remove, PowerShell).

### Added — v1.0 E5 (Multi-profile)

- **Multi-profile support.** One install, multiple personas. Each profile has its own CV, queries, filters, scoring, schedule, and seen-jobs memory. Browser session (`data/browser-profile/`), bot heartbeat, and machine-level state stay shared. New `/profile list / add <slug> / switch <slug> / delete <slug>` Telegram commands.
- **`config.json` schema migration.** v0.x flat shape (`{user, queries, filters, ...}`) auto-wrapped on first load into `{active_profile: "default", profiles: {default: {...}}}`. Migration is idempotent — safe to call from any script entry point. Existing per-profile data files (`cv-parsed.json`, `seen-jobs.json`, `last-batch.json`, `last-batch-callbacks.json`, `applications.md`, `query-stats.json`) relocated into `data/profiles/default/`.
- **`scripts/profile-store.mjs`** — single module owning profile CRUD, migration, and path resolution. `paths(slug?)` returns the canonical per-profile file slots; `addProfile` clones the active profile's config so a new persona inherits queries/filters and just needs a fresh `/resume` upload.
- **Profile-aware `config-rw.mjs`.** Existing dot-path setters (`set('user.salaryFloorUsd', X)`, `appendUnique('filters.skipCompanies', X)`) auto-route under `profiles[active].*` after migration. Existing `read()` returns a flattened view of the active profile so consumers like `daily-batch.mjs` keep working unchanged.
- **Per-profile data layout.** `data/profiles/<slug>/{cv-parsed.json, seen-jobs.json, last-batch.json, last-batch-callbacks.json, applications.md, query-stats.json}` — `/profile switch` swaps the entire active state cleanly. Today's TSV (`today-batch-{date}.tsv`) and downloadable jobs txt also live under the active profile dir.
- **Mid-batch switch handling.** If a user runs `/profile switch` while a batch is in flight, the switch is queued via the existing `runningJob` lock — surface message tells them to wait until the current scrape completes.
- **5 new profile-store smoke tests** in `scripts/__tests__/profile-store.test.mjs`. Total test count: 24 (was 19).

### Fixed — v1.0 E5
- **`/forget last` and `/settings` count are now schema-aware** — work against both the v0.x `{ids: [...]}` shape and the v1.0 `{jobs: {url: {...}}}` shape so users mid-migration aren't broken.

### Added — v1.0 E4
- **Inline-button paginated batch browser.** New `/batch [N]` command opens a tap-friendly job browser. Each page renders one job with action buttons `[💾 Save] [✅ Applied] [❓ Why] [🚫 Skip co]` and `[⬅️] [N/M] [➡️]` navigation. Replaces having to remember "save 42, applied 7" job numbers across a 100-message scroll-back.
- **Per-batch CTA after morning push.** Daily batch ends with a `🎯 Tap to act` message carrying `[📋 Open batch browser] [📊 Diagnose supply]` buttons — opens the new browser without typing.
- **`/history [N]` command.** Paginated past-application list read from `data/applications.md`, 5 entries/page. Inline `⬅️/➡️` nav.
- **Inline-keyboard inline-button-tap actions** for save/applied/why/skip-company. Tapping `[💾 Save]` runs the same `job-action.mjs save <url>` path that `/save N` uses; tapping `[🚫 Skip co]` adds the company to `filters.skipCompanies`.
- **Telegram `callback_query` handling.** Bot now subscribes to `callback_query` updates and dispatches via the new `scripts/callback-router.mjs` module. Each callback is HMAC-signed at mint time (`<action>:<idx>:<sig>` where sig = first 8 hex of HMAC-SHA256(token, action+idx+url)) so stale callbacks from rotated batches are rejected with "this batch has expired" rather than silently acting on the wrong job.
- **`data/last-batch-callbacks.json`** — per-batch callback table (idx → {url, company, title, directUrl, matchPct, score, yoe, q}). 7-day TTL. Written at end of each batch, read on every callback dispatch.
- **`tgEditMessage` + `tgAnswerCallback` helpers** — pagination edits the bubble in place rather than piling up new messages; callback acks turn off the loading spinner with optional toast text.

### Added — v1.0 E3
- **Match floor (FIXES "0% jobs in batch").** Default 25%; jobs below the threshold are dropped *before* the top-100 cut, so the bot never ships filler when supply is short. New `config.scoring.matchFloorPercent` field. New `/floor N` Telegram command (`/floor 0` to disable, `/floor 50` to be picky).
- **Seen-jobs freshness window (FIXES "only 7 jobs after a few weeks").** Schema upgraded from `{ids: string[]}` (boolean has-seen, grew forever) to `{jobs: {url: {firstSeenAt, lastSeenAt}}}`. Default 60-day decay: unapplied previously-seen jobs roll back into the supply pool. Applied jobs (read from `applications.md`) are always blocked. Old schema auto-migrates on first load. New `config.scoring.seenJobsFreshnessDays` field.
- **Phrase-proximity scoring + term-frequency cap.** Multi-token CV phrases that don't match exactly now get half-credit if all tokens appear anywhere in the JD ("AWS … 50 words … RDS" no longer scores zero). Matches are counted up to 3 occurrences (TF cap) so a JD mentioning "AWS" 8 times no longer ties one mentioning it once.
- **Cluster-aware scoring (kills the IAM-bias problem).** New `clusters` field in `cv-keywords.json` defines 11 role domains (iam, cloudsec, m365, devops, softwareEng, data, soc, networking, design, mobile, product) with signal terms. Resume parser computes hits per cluster and picks top-2 as `primaryClusters`. At scoring time, terms outside primary clusters get half weight — backend/data CVs no longer get IAM-biased rankings. New `cv-parsed.json#primaryClusters` and `clusterScores` fields.
- **Salary parser rewrite.** New `parseSalaryK()` exports handle `$120k–$160K`, `$120,000-$160,000`, em-dash + en-dash, `USD 120K-160K`, and rejects implausible numbers. The old regex extracted bare digits and accidentally matched "K" inside words like "Kotlin". 10 fixtures pin down the new behavior.
- **Supply-diagnostics banner.** When `afterDedup < 30`, the morning batch prepends a banner to the Telegram message: `⚠️ Limited supply today: 14 fresh jobs (typical: 50–80)` with actionable hints (`/forget last`, lowering `/floor`, expanding `/jobs add`). Decisions surface to the user instead of being buried in logs.
- **Per-query dry-run warning.** If any single search query has averaged 0 cards over 3+ consecutive runs, the next batch's banner names the dry queries: `⚠️ Dry queries (3+ days at 0 cards): "M365 Sec Engineer". Likely typo — edit via /jobs remove + /jobs add.`
- **First test suite.** `scripts/__tests__/salary.test.mjs`, `phrase-proximity.test.mjs`, `role-cluster.test.mjs` — 19 tests using built-in `node:test` runner. New `npm test` script.
- **Title heuristic hardened.** Card extraction now validates candidate titles against a non-title blacklist (`/^(full[- ]?time|part[- ]?time|remote|hybrid|onsite|contract|w2|c2c|us only|usa)$/i`) and falls through to the next candidate if the primary line is metadata bleed. Prevents `(untitled)` and "Full Time" / "Remote, US" titles in batches.

### Fixed — v1.0 E3
- **Seen-jobs persistence race.** `seen-jobs.json` was previously written at the top of the post-Telegram block but the variable mutation happened separately. The new write happens *only* after Telegram chunked-message delivery succeeded for the batch and only stamps the surfaced jobs.
- **`scoreJob` and `parseSalaryK` are now safe to import** — `daily-batch.mjs` gates its top-level pipeline IIFE behind a CLI-vs-imported check (`IS_CLI`) so test files can pull engine functions without triggering a real scrape + Telegram push at module load. `.env` validation also gated on CLI invocation.

### Added — v1.0 E2
- **Heartbeat + out-of-process watchdog.** Bot writes `data/heartbeat.json` every poll iteration with `{ts, pid, version, lastPollOk, consecutiveFailures}`. New `scripts/watchdog.mjs` runs every 5 minutes via Task Scheduler entry `munyun-watchdog` — if the heartbeat is stale > 10 min, it kills the bot, restarts the `munyun-bot` task, and pings Telegram via `scripts/telegram-send.mjs` (independent process, so a corrupt bot module can't take the alerter down). Throttled to 3 restart attempts per hour; after the limit, sends a single "give up — human needed" alert and stops trying. Solves the silent-death failure mode (we hit it during v0.5 release work — bot died without surfacing).
- **`/status` command.** One-screen bot health snapshot: process uptime, last heartbeat, last batch (date + count + funnel + score band), last auth-OK, batch-in-progress lock state, scheduled-task state. Read by user; structured similarly by the watchdog.
- **`/diagnose` command.** Answers "why am I getting only N jobs?" directly. Surfaces the last batch's funnel (raw → keptAfterFilter → afterDedup → sent), seen-jobs total, and per-query 7-day average card count with low-supply queries flagged. If the batch was below typical supply (< 30 fresh jobs), `/diagnose` includes hint actions (`/forget last`, `/jobs add`).
- **Per-query supply history.** New `data/query-stats.json` written by `daily-batch.mjs` after each scrape — rolling 7-day window of `{date, cards}` per query term. Read by `/diagnose`.
- **Funnel persistence in `data/last-batch.json`.** New `funnel: {raw, keptAfterFilter, droppedClearance, afterDedup, scored, sent, topPct, medianPct, bottomPct}` field. Read by `/status` and `/diagnose`.
- **Batch-missed watcher.** New `scripts/batch-missed-watcher.mjs` + Task Scheduler entry `munyun-batch-missed`. Runs 1 hour after configured batch time on configured days. If today's `data/today-batch-{date}.tsv` is missing, pings Telegram. Idempotent — won't re-alert for the same date. File-existence check is the truth; doesn't parse logs.
- **Initial heartbeat at bot startup** so the watchdog sees a fresh boot as alive within seconds, not after the first 30s long-poll round-trip.

### Fixed — v1.0 E2
- **`recordAuthOk()` no longer lies on a failed scrape.** Was previously called immediately after `/saved` loaded successfully, even if the subsequent scrape loop returned zero cards across all 15 queries. Now deferred to after the loop completes AND at least one card was extracted. `/status` and `/diagnose` no longer show "auth OK" when the user is effectively broken.

### Changed — v1.0 E2
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

[Unreleased]: https://github.com/7ustoo/automatic-munyun-machine/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.5.0...v1.0.0
[0.5.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/7ustoo/automatic-munyun-machine/releases/tag/v0.3.0
[0.2.0]: https://github.com/7ustoo/automatic-munyun-machine/releases/tag/v0.2.0
