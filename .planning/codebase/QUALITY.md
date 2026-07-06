# QUALITY.md — AMM v1.0 quality audit

> **⚠️ STALE — v1.0.0 metrics (banner added 2026-07-06).** Counts here (17 scripts / 4,637 LOC / 24 tests) are v1.0.0. Current: **31 `scripts/*.mjs`**, **18 test files** (~150+ assertions), plus a **16-file Go wrapper** with its own tests. Regenerate with `/gsd-map-codebase`. Current truth: `STATE.md` / `PROJECT.md`.

**Analysis Date:** 2026-05-07
**Repo:** `C:\Users\Jus7o\automatic-munyun-machine`
**Branch:** `v1.0` · **Version shipped:** v1.0.0
**Test runner:** `node --test scripts/__tests__/*.test.mjs` (built-in `node:test`, no third-party framework)
**Total scripts:** 17 `.mjs` files · 4,637 LOC
**Tests:** 24 across 4 files (~514 lines of code-under-test executed)
**Linter / Formatter / Type checker / CI:** none

The honest summary: the test suite that landed in v1.0 covers the **pure functions** (salary parsing, cluster detection, profile-store path math) and almost none of the **operationally critical paths** (network scrape, Cloudflare warmup, callback HMAC verification, watchdog kill+restart, atomic config writes under contention). Production validation is "run `npm run daily` end-to-end and tail logs" (per `CLAUDE.md` line 24). That's a workable bar for a single-user local tool but it's the bar the v1.1 plan should explicitly raise where new platforms (Mac/Linux) widen the surface area.

---

## 1. Test inventory

| File | Tests | What it covers | What it does NOT cover (adjacent untested code) |
|------|------:|----------------|------------------------------------------------|
| `scripts/__tests__/salary.test.mjs` | 10 | `parseSalaryK()` — `$120k`, `$135K base`, hyphen ranges, en-dash, em-dash (the v0.x bug), comma-thousands `$120,000`, `USD 120K-160K` prefix, lowercase `k`, no-signal text, implausible-number rejection (`$5K`, `$9000K`), word-internal `K` rejection (`Kotlin`, `stack`) | The **integration** — `scoreJob()`'s salary branch (`daily-batch.mjs:509-513`) that converts parsed numbers into `SALARY_BONUS` / `SALARY_PENALTY` against `SALARY_FLOOR_K`. Floor-vs-bonus boundary not tested. |
| `scripts/__tests__/phrase-proximity.test.mjs` | 3 | Smoke import of `scoreJob`, `parseSalaryK` from `daily-batch.mjs`; `scoreJob({title,cardText})` returns `{score, matched}` shape; empty-input safety; `parseSalaryK` is the same export `scoreJob` uses (drift detector) | The actual phrase-proximity feature: `tokensAllPresent()` (`daily-batch.mjs:473`), the half-credit fallback for multi-token CV phrases, the `TF_CAP=3` term-frequency cap, the `clusterMultiplier()` that halves weight for non-cluster terms (`daily-batch.mjs:425-428`). The file's own header says "True per-CV behavioral tests are gated on the CV-parsed.json fixture" — i.e. they were deliberately left undone. |
| `scripts/__tests__/role-cluster.test.mjs` | 6 | `scoreClusters()` + `pickPrimaryClusters()` against four shaped CVs (IAM, backend, data, SOC). Asserts IAM-CV maps to `iam`, backend CV does NOT map to `iam` (the v0.x regression), data CV → `data`, SOC CV → `soc`. Empty-input → `[]`. Zero-score dropping inside top-N. | Doesn't reach `daily-batch.mjs`'s consumption — the `CV_PRIMARY_CLUSTERS` → `CLUSTER_TERMS` Set construction (`daily-batch.mjs:415-424`) and its read inside `clusterMultiplier()`. So a regression in **how the parsed clusters are *used*** during scoring would slip through. |
| `scripts/__tests__/profile-store.test.mjs` | 5 | `paths()` returns the six per-profile slots; `paths('default')` resolves under `data/profiles/default/`; `listProfiles()` includes the active profile after migration; `PROFILE_FIELDS` set is exactly the seven expected; `PROFILE_DATA_FILES` includes per-profile files but NOT shared ones (`heartbeat.json`, `auth-state.json`). | `migrateIfNeeded()` is invoked transitively but **the migration logic itself is not asserted** — the rename loop at `profile-store.mjs:86-92` (with its `try{}catch{}` swallow), the `_comment` skip at `:75`, behavior when `oldPath` exists AND `newPath` exists (the rename-collision case), the flat→profiles wrap at `:67-79`. `addProfile()` slug regex (`:129`) — happy path only via test setup, no rejection cases. `setActiveProfile()` / `deleteProfile()` "can't delete active" / "can't delete only" guards untested. |

**Run command:** `npm test` → `node --test scripts/__tests__/*.test.mjs`

**Coverage of `daily-batch.mjs`:** ~10% by line. The module's `IS_CLI` gate (`:35`) makes the file safely importable by tests, but only `parseSalaryK` and `scoreJob` are exported. The other 900 lines of the file (scrape, pagination, dedup, salary-floor integration, resolver pool, message formatting, `.txt` builder, callback table writer) have zero unit-test coverage.

**Coverage of `telegram-bot.mjs`:** 0%. Not a single test imports anything from this file. ~30 dispatch handlers, the poll loop, callback verification, attachment handler, and the post-update flag detection are all production-validated only.

**Coverage of `callback-router.mjs`:** 0%. The HMAC sign+verify path — security-adjacent — has no tests. Flagged HIGH in §9.

**Coverage of `watchdog.mjs`:** 0%. Kill-and-restart logic, throttle, give-up alerting are all production-validated only. Flagged MEDIUM in §9.

---

## 2. Critical-path coverage gaps

Paths are listed roughly in order of "how badly does v1.0 break if this regresses?"

### HIGH — production-breaking if regressed

| # | Path | File / lines | Test status | Notes |
|---|------|--------------|-------------|-------|
| 1 | **HMAC sig generation + verification** for inline callbacks | `scripts/callback-router.mjs:44-91` | **NO test.** | The 8-hex-char sig is the only defense against stale-callback acting on a rotated job. A regression in `makeCallback` / `parseAndVerify` could either (a) accept any sig (security), or (b) reject every legit sig (every Save/Applied/Why button stops working silently — Telegram just shows toast errors). Easy to unit test (pure function, deterministic given a fixed token). **HIGH priority for v1.1.** |
| 2 | **Cloudflare warmup** in `login-once.mjs` | `scripts/login-once.mjs:41-78` | No test possible without network. Manual only. | This is the entry point for every fresh install. If Cloudflare changes its challenge or the selectors drift, the user sees "0 cards" forever. There's no unit-testable seam — record as "manual smoke test required on each release." |
| 3 | **Pagination loop with per-query early stop** ("0 new cards") | `scripts/daily-batch.mjs:308-334` (the for-loop body) | No test. Live-network only. | The early-stop predicate (`newCards === 0`) was added in v1.0 — if the selector for `a[aria-label*="next"]` drifts, we either over-paginate (slow) or stop at page 1 (under-supply). Could be unit tested by mocking the page object. |
| 4 | **Direct ATS URL resolution** via `resolveOnePage` (5 concurrent pages) | `scripts/daily-batch.mjs:664-697` | No test. Live-network only. | `apply_url` regex `/"apply_url":"([^"]+)"/` (`:670`) breaks if hiring.cafe rerenders the JSON shape or escapes quotes differently. No test catches that until users see "View on hiring.cafe" links instead of direct ATS. |
| 5 | **Match floor + seen-jobs filter ordering** | `scripts/daily-batch.mjs:858-880` | No test. | The CLI block runs filter → dedup → score → floor → top 100 in a specific order. Reordering would silently change what users get. The `MATCH_FLOOR_PCT` cutoff (`:878`) lives in the CLI block, isn't extracted, isn't testable without a fixture. |
| 6 | **Atomic config writes under contention** (bot + scrape both touching `config.json`) | `scripts/config-rw.mjs:46-50, 67-82, 91-109, 112-140` | Single-threaded smoke only via profile-store tests. **No concurrent-write test.** | The temp-file + rename pattern is correct on POSIX but **rename-over-existing-file is NOT atomic on NTFS** the same way (Windows uses MoveFileEx with replace flag — works, but observable interleaving differs). Two concurrent `set()` calls could lose updates. See §8. |
| 7 | **Profile migration** in `profile-store.mjs#migrateIfNeeded` | `scripts/profile-store.mjs:63-94` | The 5 profile-store tests run after migration ran transitively, so they exercise the **post-migrated state**. The migration itself (especially the rename loop `:86-92`) is untested. Specifically NOT covered: rename-collision (`oldPath` exists AND `newPath` exists — the code has `&& !fs.existsSync(newPath)` guard, which means colliding files silently stay in their old location), idempotency on partial migrations, error handling when `targetDir` mkdir fails. |

### MEDIUM — degrades cleanly, but degrades silently

| # | Path | File / lines | Test status |
|---|------|--------------|-------------|
| 8 | **Watchdog kill + restart cycle** | `scripts/watchdog.mjs:101-126` (killBot, startBot) and `:159-189` (give-up logic) | **NO test.** Could be unit tested by stubbing `spawnSync`, providing a fake `heartbeat.json` and `watchdog-state.json`, and asserting the right schtasks/PowerShell invocations. |
| 9 | **Telegram message chunking** (`tgChunked`) | `scripts/daily-batch.mjs:108-120` | No test. The 3900-char boundary + blank-line split is a known invariant; if a ridiculously long single block arrives (no blank lines), it'll exceed 4096 and Telegram rejects the whole thing. |
| 10 | **Resume parsing dispatch** (PDF/DOCX/MD/TXT) | `scripts/resume-parser.mjs:42-60` | The role-cluster test exercises `scoreClusters`/`pickPrimaryClusters` only. `readResumeText()` and the dynamic `pdf-parse`/`mammoth` imports are not tested — a corrupt PDF or a `.docx` with embedded media throws and the bot's `/resume` handler shows the raw error. |
| 11 | **Update-check + version compare** | `scripts/update-checker.mjs` (188 lines) | No test. The `dismissVersion` / `markUpdating` / `consumePostUpdateFlag` lifecycle is tied to state files (`.dismissed-version`, `.updating`); easy targets for a fixture-based test. |
| 12 | **Seen-jobs schema migration** (v0.x flat `ids:[]` → v1.0 `jobs:{}` map) | `scripts/daily-batch.mjs:574-589` (`loadSeenStore`), `:591-601` (`decaySeenStore`) | No test. Migration is one-way and idempotent in principle; lack of test means we can't catch a bug like "decay window applied to firstSeenAt instead of lastSeenAt." |

### LOW — niceties / scaffolding

- `parseAndVerify` parts other than HMAC (`callback-router.mjs:62-67`): split-by-colon parsing, `parseInt` of idx, expired-check via TTL on the callbacks table.
- `tokensAllPresent` (`daily-batch.mjs:473`): pure, easy to test.
- `scoreToPercent` calibration band logic (`daily-batch.mjs:518-524`): four bands, easy regression target.
- `geocode.mjs` (38 LOC, open-meteo wrapper): trivially fixturable.

---

## 3. Code health signals

### File sizes (LOC, descending)

| File | LOC | Notes |
|------|----:|-------|
| `scripts/telegram-bot.mjs` | **1,615** | The single biggest file. ~30 dispatch handlers all in one `handleMessage` switch. **Strong refactor candidate — split into `commands/*.mjs` for v1.1.** |
| `scripts/daily-batch.mjs` | **963** | The core scraper. Defensible at this size given it's the primary pipeline; could split out `scoring.mjs`, `seen-store.mjs`, `message-builder.mjs` cleanly. |
| `scripts/setup-wizard.mjs` | 463 | 10-step interactive flow; one function per step would help. |
| `scripts/profile-store.mjs` | 192 | OK. |
| `scripts/watchdog.mjs` | 191 | OK. |
| `scripts/update-checker.mjs` | 188 | OK. |
| `scripts/config-rw.mjs` | 140 | OK. |
| `scripts/resume-parser.mjs` | 137 | OK. |
| `scripts/role-suggester.mjs` | 123 | OK. |
| `scripts/callback-router.mjs` | 120 | OK. |
| `scripts/uninstall.mjs` | 118 | OK. |
| `scripts/job-action.mjs` | 97 | OK. |
| `scripts/batch-missed-watcher.mjs` | 89 | OK. |
| `scripts/login-once.mjs` | 81 | OK. |
| `scripts/file-picker.mjs` | 52 | OK. |
| `scripts/geocode.mjs` | 38 | OK. |
| `scripts/telegram-send.mjs` | 30 | OK. |

**Two files are clearly oversized.** `telegram-bot.mjs` at 1,615 LOC is the thing you'd most want to split; `daily-batch.mjs` at 963 is borderline.

### Function lengths (worst offenders)

| Function | File:lines | Approx LOC | Concern |
|----------|-----------|-----------:|---------|
| **`handleMessage`** | `telegram-bot.mjs:566-1175` | **~610** | The Pareto-worst function in the codebase. ~30 commands as a long if/else chain on regex matchers. Each command branch is 5-30 lines. **Extracting this into a dispatch table is the single highest-leverage refactor available.** |
| **`handleCallback`** | `telegram-bot.mjs:1303-1439` | ~140 | 10 action branches as if/else chain. Same pattern — table-driven dispatch would cut the line count in half. |
| **CLI block (anonymous async IIFE)** | `daily-batch.mjs:843-963` | ~120 | The "main" of the daily batch. Doesn't have a name, so it isn't testable. v1.0 E3 added the `IS_CLI` gate so unit tests can import without firing it — good, but this main itself is still untested. |
| **`scrape`** | `daily-batch.mjs:229-368` | ~140 | The pagination + cross-query early-stop loop lives here. Reasonable for what it does, but at the upper bound. |
| **`buildStatusMessage`** | `telegram-bot.mjs:437-496` | ~60 | Reasonable. |
| **`buildDiagnoseMessage`** | `telegram-bot.mjs:500-564` | ~65 | Reasonable. |

Nothing else exceeds ~50 lines.

### Cyclomatic complexity hotspots

- `handleMessage` is the only true hotspot — but its complexity is breadth (many branches), not depth. Each branch is shallow.
- `scrape()` has 3-deep nesting (for query → for page → for row) which is appropriate for the work.
- `parseAndVerify` (`callback-router.mjs:61-81`) is well-structured: one branch on `jobActions` membership, no nesting.
- No 6+ deep nested branch found anywhere.

### Magic numbers

**Well-named constants (good):**
- `STALE_THRESHOLD_MS = 10 * 60 * 1000` (`watchdog.mjs:42`) ✓ commented
- `RESTART_WINDOW_MS = 60 * 60 * 1000` (`watchdog.mjs:43`) ✓ commented
- `MAX_RESTARTS = 3` (`watchdog.mjs:44`) ✓ commented
- `CALLBACK_TTL_DAYS = 7` (`callback-router.mjs:39`) ✓ docstring
- `SCRAPE_TIMEOUT_MS = 5 * 60 * 1000` (`telegram-bot.mjs:250`) ✓ inline comment
- `PENDING_TTL_MS = 10 * 60 * 1000` (`telegram-bot.mjs:322`) ✓ inline comment
- `BACKOFF_MS = [5000, 10000, 20000, 30000]` (`telegram-bot.mjs:1564`) ✓ comment block
- `TF_CAP = 3` (`daily-batch.mjs:439`) ✓ inline comment
- `TARGET_JOBS` defaulted from config (`daily-batch.mjs:267`) ✓ commented
- `MAX_PAGES_PER_QUERY` defaulted from config (`daily-batch.mjs:261`) ✓ comment block

**Bare-ish magic numbers (uncommented or weakly commented):**
- `PAR = 5` (`daily-batch.mjs:679`) — has the comment "5 concurrent pages — balances speed vs bot-detection risk." OK.
- `await page.waitForTimeout(2000)` / `2500` / `1500` (`daily-batch.mjs:294,319,668`) — magic millisecond literals scattered through the scraper. Not catastrophic but a `SETTLE_MS` constant would document intent.
- `slice(0, 1500)` for `cardText` truncation (`daily-batch.mjs:182`) — unexplained. Why 1500 specifically?
- `MAX = 3900` in `tgChunked` (`daily-batch.mjs:109`) — explained at the top of the function, OK.
- `PAGE_SIZE = 5` in `showHistory` / `showSaved` (`telegram-bot.mjs:1236, 1270`) — duplicated; should be a module constant.
- `0.5` half-weight multiplier in `clusterMultiplier` (`daily-batch.mjs:427`) and `score += weight * 0.5` (`:499`) — same value, two places. Should be `OFF_CLUSTER_MULTIPLIER` and `PARTIAL_PHRASE_MULTIPLIER` constants.
- Score-band breakpoints in `scoreToPercent` (`daily-batch.mjs:518-524`): `30`, `20`, `10`, `5`, and the multipliers `0.5`, `1.5`, `2.5`, `4`, `7`. These are the calibration table. Fine if intentional, but worth a `SCORE_BANDS` table-of-tuples for readability + future tuning.
- `1.5` headroom multiplier (`daily-batch.mjs:349, 350`): "50% headroom for filter+floor losses" — explained, OK.

### Comment density

`CLAUDE.md` doesn't actually say "default to no comments" — it ships explanatory commentary in conventions. The codebase **leans WHY-heavy**, which matches the spirit of the project: every non-obvious choice has a comment explaining the historical context (the v0.4.1 PowerShell PATH bug, the v1.0 E3 race fix, the Cloudflare-bot-blocks-fetch reasoning). Examples:

- `daily-batch.mjs:447-450` — comment explaining why `parseSalaryK` was rewritten in v1.0 E3.
- `daily-batch.mjs:611-615` — race-fix history for `saveSeenStore`.
- `telegram-bot.mjs:98-103` — why the `unhandledRejection` handler exists.
- `watchdog.mjs:11-22` — the entire rationale for being out-of-process.

This is **above-average** comment quality for a codebase this size. The trade-off is that the comments are sometimes longer than the code they explain, which can mask the actual flow. Skip-able without losing intent.

---

## 4. Error handling patterns

### Survey of `try/catch` use

**33 try/catch blocks across 9 files.** Distribution:
- `telegram-bot.mjs`: 14
- `daily-batch.mjs`: 6
- `update-checker.mjs`: 3
- `callback-router.mjs`, `batch-missed-watcher.mjs`, `login-once.mjs`, `watchdog.mjs`: 2 each
- `profile-store.mjs`, `uninstall.mjs`: 1 each

### Silent swallows (`catch {}`) — 20 occurrences

These are **mostly defensible** because they're best-effort reads of state files where "missing or corrupt" is a legitimate state (no batch yet, no auth state yet, no heartbeat yet). Mapping them out:

| Location | What's swallowed | Justified? |
|----------|------------------|------------|
| `daily-batch.mjs:374` (`recordQueryStats`) | `JSON.parse` of query-stats.json | ✓ "no stats yet" is the new-install state |
| `daily-batch.mjs:419` | Reading `cv-keywords.json` for cluster terms | ⚠ This is shipped with the repo — silent fail means the file got corrupted/deleted and the bot keeps running with no cluster filter. Should at least log. |
| `daily-batch.mjs:652` (`recordAuthFail`) | Reading prev `auth-state.json` | ✓ first-fail is fine |
| `daily-batch.mjs:723` (banner build) | Reading query-stats for dry-query detection | ✓ "no stats yet" |
| `daily-batch.mjs:960` | `await tg(msg)` in the outer error handler | ✓ "Telegram is down AND we're already crashing" — nothing useful left to do |
| `login-once.mjs:79` | `ctx.close()` | ✓ context may already be closed |
| `profile-store.mjs:90` | `fs.renameSync` during migration | ⚠ A failed rename here means a stranded data file. Should log. |
| `telegram-bot.mjs:289, 304` | `child.kill('SIGKILL')` | ✓ child may already be dead |
| `telegram-bot.mjs:446, 453, 469, 505, 526, 539, 720` | All read-and-display state files for `/status`, `/diagnose`, `/auth` | ✓ each has a "missing → display 'unknown'" path |
| `setup-wizard.mjs:149, 250` | (didn't read in detail, likely best-effort cleanup) | likely ✓ |
| `uninstall.mjs:56` | Reading `heartbeat.json` for PID | ✓ no bot running is OK |
| `update-checker.mjs:185` | `fs.unlinkSync` of stale flag | ✓ already gone |
| `watchdog.mjs` (multiple, inside `log()` and state writes) | All log + state writes | ✓ explicitly documented "never let log writes crash the watchdog" |

**Most concerning silent swallows:**
- `daily-batch.mjs:419` (cv-keywords.json missing) — a corrupted dictionary should be a loud failure, not a silent "everyone scores 1.0".
- `profile-store.mjs:90` (migration rename failure) — silent stranded files mean the migration "succeeded" but data is split between old and new locations.

### Logged-and-rethrown / surfaced-to-user (good)

- `telegram-bot.mjs:271-274` — `child.on('error')` for run-daily-batch spawn: logs and replies to user with the message.
- `telegram-bot.mjs:276-282` — `child.on('exit')` for non-zero codes: replies to user with stderr tail.
- `telegram-bot.mjs:1496-1501` — resume upload error: scrubs token from message, logs, and replies with the safe message.
- `daily-batch.mjs:957-961` — outer CLI `try/catch`: logs to file, sends Telegram, exits non-zero.
- `daily-batch.mjs:296-300` — page-1 retry loop: logs each attempt, throws after 3 failures (caller does the right thing).
- `telegram-bot.mjs:182-187` (`reply`): on Telegram parse-mode failure, logs and retries as plain text. Smart fallback.

### Crash safety nets in the bot

`telegram-bot.mjs:104-111` installs both:
- `process.on('unhandledRejection', ...)` — logs with TG_TOKEN scrubbed
- `process.on('uncaughtException', ...)` — same

Both **only log** — they don't restart, don't exit, don't notify. The bet is "the next poll-loop iteration will recover." That bet is reasonable for transient async errors but **does NOT catch synchronous module-load errors or memory-corruption faults** — which is exactly what `watchdog.mjs` exists for. The two layers compose correctly.

The poll loop itself (`telegram-bot.mjs:1568-1614`) has clean exponential backoff (5s → 10s → 20s → 30s cap), heartbeat updates on both success and failure paths, and a recovery-detection branch that pings the user if the outage was ≥60s. This is the most well-engineered part of the bot.

### Network failure handling specifically

- **hiring.cafe scrape**: page-1 has a 3-attempt retry loop (`daily-batch.mjs:289-301`); pagination is best-effort (any failure breaks the loop without retrying). `checkBrowsable` retries twice (`:215-225`).
- **Telegram API**: every `tgPost` (`:149-161`) checks `j.ok` and throws with the upstream `description`; callers either log and continue (`tgChunked` would interrupt; `reply` retries plain-text once on parse errors).
- **open-meteo**: `getWeather` in `daily-batch.mjs:127-136` has a try/catch returning a fallback string. The bot's `getWeather` (`telegram-bot.mjs:229-245`) does NOT — a network failure surfaces as an exception to the caller. Inconsistent.
- **GitHub API** (`update-checker.mjs`): not read in detail but the bot wraps it in try/catch and silently retries next 24h cycle.

---

## 5. Logging quality

### Log file inventory

| File | Rotation | Growth concern |
|------|----------|----------------|
| `data/daily-batch-{YYYY-MM-DD}.log` | **Implicit daily rotation** (date is in filename, written once per scrape day). | None — natural rotation. Old files just accumulate; manual cleanup needed for long-running installs. |
| `data/telegram-bot.log` | **None.** Single file, append-only forever. | **MEDIUM** — currently 6 KB on this dev box, but the bot is long-running. A user with the bot online for a year accrues ~MB-scale logs. Not catastrophic but unbounded. |
| `data/watchdog.log` | **None.** Same. | Already 58 KB on this box (5-min ticks, multiple lines per tick). Will be 100s of MB at 5 years. **MEDIUM**. |

### Log scrubbing

The `TG_TOKEN` scrubbing pattern is **consistent where it matters** (the high-leakage paths) but **not enforced uniformly**:

| Location | Scrubbed? |
|----------|-----------|
| `telegram-bot.mjs:106` (`unhandledRejection`) | ✓ `.replace(TG_TOKEN, '<TOKEN>')` |
| `telegram-bot.mjs:110` (`uncaughtException`) | ✓ same |
| `telegram-bot.mjs:1471` (resume upload network error) | ✓ same |
| `telegram-bot.mjs:1498` (resume upload outer catch) | ✓ same |
| `telegram-bot.mjs:157` (`tgPost` failure) | ✗ — logs `JSON.stringify(j).slice(0, 300)`. Telegram error responses don't normally echo the token, but if the failure mode is e.g. a 401 with the URL in `description`, this could leak. Low risk, but inconsistent. |
| `telegram-bot.mjs:171` (`tgSendDocument` failure) | ✗ — same pattern. |
| `daily-batch.mjs:92` (`tg` outer error) | ✗ — `throw new Error('Telegram error: ' + JSON.stringify(json));` propagates upward and the outer catch at `:957` logs `(e.message || e)`. Token unlikely to appear in `json` from Telegram's API response, but not guaranteed. |
| `daily-batch.mjs:104` (`tgDocument` outer error) | ✗ — same. |

The chat-ID masking pattern (`***1234`) is used **once**, at startup (`telegram-bot.mjs:1509`). Other log lines that mention chat IDs (e.g. `< ${text}` at `:574`) don't mask — but they don't print the chat ID either, so it's moot.

### Log levels

**Uniformly INFO via `console.log` + `fs.appendFileSync`.** No log levels (no `debug`, `warn`, `error`). No structured logging (everything is `[ISO timestamp] free-text`). For a tool of this size that's **fine** — adding structured logs would be over-engineering — but it means filtering by severity or grepping by event type relies on the human reader recognizing patterns.

---

## 6. Linting / formatting / type-checking

**None of these exist:**
- No `.eslintrc*` / `eslint.config.*`
- No `.prettierrc*` / `prettier.config.*`
- No `tsconfig.json` (no `// @ts-check` JSDoc validation either)
- No `.editorconfig`
- No CI (no `.github/workflows/`)

### Cost of this absence — honest accounting

**What static checks would have caught in the v1.0 cycle:**
- Import drift (e.g. an unused import from `update-checker.mjs`) — minor, eslint `no-unused-vars`.
- Typos in property access on dynamic config (`cfg.fillters` instead of `cfg.filters`) — TypeScript would catch this with even loose JSDoc typing of the config shape.
- Inconsistent quote styles, trailing commas, etc. — Prettier territory, purely cosmetic.

**What static checks would NOT have caught:**
- The `playwright-core` ENOENT bug from a friend's install — that was an environment bug (Chromium binary not present), not a code bug.
- The em-dash salary-parse miss — would only be caught by a fixture test, which is what `salary.test.mjs` now does.
- The Cloudflare 403-on-fetch bug — code was correct; the upstream changed. No static check finds those.
- The PATH-stripped-environment crash (`spawn powershell ENOENT`) — code was idiomatic; only manual testing on a stripped environment would surface it.

**Verdict: low-to-medium priority for v1.1.** Adding `// @ts-check` + minimal JSDoc on the public exports of `daily-batch.mjs`, `callback-router.mjs`, and `profile-store.mjs` would document the shapes consumers depend on and catch drift without a build step. ESLint + Prettier would pay off only if more contributors land on the project; for a single-author repo the discipline cost outweighs the bug-prevention cost. **Recommendation: ship `// @ts-check` in v1.1, defer ESLint/Prettier.**

---

## 7. Documentation accuracy

Spot-checked `CLAUDE.md`, `CONTEXT.md` (existence confirmed; not deeply read), `README.md`, and `package.json` against the current code.

### Drift discovered

| Source | Claim | Reality | Severity |
|--------|-------|---------|----------|
| `CLAUDE.md:24` | "There is no test suite, linter, or build step" | **There IS now a test suite.** 24 tests in 4 files. `npm test` works. | **HIGH** — first thing a new contributor reads. Update before v1.1. |
| `CLAUDE.md:36` | "Triggered by Task Scheduler `munyun-daily-batch` weekdays at 07:00" | Code matches; `setup-wizard.mjs` defaults agree. ✓ |
| `CLAUDE.md:38` | "~30 commands (see README's command tables)" | Approximately accurate — counted ~30 distinct command branches in `handleMessage`. ✓ |
| `CLAUDE.md:40` | Helper scripts list does **not** mention `watchdog.mjs`, `batch-missed-watcher.mjs`, `telegram-send.mjs`, `uninstall.mjs`. | These are real shipping scripts; v0.x and v1.0 additions. The helper-scripts paragraph is missing 4 files. | MEDIUM — list is stale. |
| `README.md:7` | "Scrapes hiring.cafe across **15 search queries** (IAM, Cloud Security, Cybersecurity, M365, Linux, etc.)" | The shipped default in `daily-batch.mjs:142` falls back to **3 queries** ('IAM', 'CloudSec', 'Cyber'). The wizard sets up a richer list at install time but the count is user-configurable; "15" is hardcoded marketing copy that may not match. | LOW |
| `README.md:131` | `data/cv-parsed.json` listed at top-level of `data/` | After v1.0 E5 multi-profile, this file lives at `data/profiles/<active>/cv-parsed.json`. Same for `seen-jobs.json`, `applications.md`. | MEDIUM — the data-files table in README is pre-multi-profile. |
| `README.md:96` | `/save N` action: "Bookmark job #N on hiring.cafe" | Code says: write locally first (saved.md, source of truth), then best-effort hiring.cafe click that may exit 7 (not signed in, silent skip). Behavior changed in v1.0.x to be local-first. | MEDIUM — doc undersells the new behavior. |
| `README.md:97` | `/applied N` action: "Mark applied (also logs to applications.md)" | Same flip — applications.md is the source of truth, hiring.cafe click is best-effort. | MEDIUM |
| `README.md:189-196` | Roadmap shows "v0.5 (current)" and "v0.6 — Mac + Linux", "v1.0 — Tauri desktop GUI" | Code is at v1.0.0. Roadmap is two minor versions stale. v1.0 scope was multi-profile + uninstall + Inno Setup, not Tauri. | **HIGH** — top-level marketing-facing doc, completely misses the actual v1.0 release. |
| `README.md` command tables | `/saved`, `/batch`, `/diagnose`, `/profile`, `/floor`, `/uninstall`, `/status` | Some present, some missing. `/saved` and `/profile` are real but weren't searched-for in tables; `/status`, `/diagnose`, `/floor`, `/batch`, `/uninstall` are likely missing or under-documented. | MEDIUM — needs a sweep. |
| `package.json:3` | `"version": "1.0.0"` | Matches recent commits. ✓ |
| `package.json:11-18` | `scripts.test` | Present, correct. ✓ |
| `CLAUDE.md` "Files worth knowing" section | Lists `CONTEXT.md`, `CHANGELOG.md`, `README.md`, `config.example.json`, `cv-keywords.json` | Doesn't list `package.json` (single source of truth for version per the convention) or the `.planning/` directory. | LOW |

### Sentinel checks (what's still accurate)

- ✓ `CLAUDE.md` convention "spawning Windows binaries: always absolute paths" — confirmed across `telegram-bot.mjs:61-64`, `watchdog.mjs:38-40`.
- ✓ `CLAUDE.md` "config.json writes go through scripts/config-rw.mjs" — confirmed; only `profile-store.mjs` writes config directly, and that's by-design (it's the layer below).
- ✓ `CLAUDE.md` "tgChunked at ~3900 chars" — confirmed (`daily-batch.mjs:109`).
- ✓ `CLAUDE.md` "TG_TOKEN scrubbing pattern" — confirmed at the spots that matter, gaps noted in §5.
- ✓ `CLAUDE.md` "version single-sourced from package.json" — confirmed via `update-checker.mjs#currentVersion()`.
- ✓ `CLAUDE.md` "branding sentinel: munyun-daily-batch and munyun-bot" — confirmed throughout.

---

## 8. Security hygiene quick-scan

**This is a list of areas the code-reviewer agent should investigate. Not a deep audit.**

| Area | Notes |
|------|-------|
| **Token scrubbing pattern consistency** | See §5. Pattern correct in 4 high-risk locations; missing in 4 medium-risk Telegram-API error paths. Consider a `safeError(e)` helper that does the scrub once. |
| **HTML escaping** | `escHtml()` is defined twice — once in `daily-batch.mjs:699` and once in `telegram-bot.mjs:1504`. Both implementations match (`& < >` → entities). User-provided strings (`item.title`, `item.company`, slug names from `/profile add`, custom skip-list entries from `/skip`) all pass through `escHtml()` before reaching Telegram. **Review needed:** is `escHtml` applied to **every** user-influenced string before it lands in `parse_mode: 'HTML'`? Spot check looks good — spotchecked `:660, 672, 684, 693, 1191, 1395, 1421, 1500` — all wrap user input. The reply fallback at `:184` switches to plain text on parse failure, defense-in-depth. |
| **Callback HMAC sig length: 8 hex chars = 32 bits** | `callback-router.mjs:50`. **Adequate for replay defense** (the threat model is "old callback button clicked late after batch rotation"; 1-in-4-billion accidental collision is fine). **Inadequate for forgery resistance** if the threat model expands — but the threat model can't expand: `chatId !== ALLOWED_CHAT` is checked first (`telegram-bot.mjs:1305`), so an attacker would need to spoof Telegram's signed callback delivery, which is out of scope. **Trade-off documented; no change needed.** |
| **File-write race conditions on Windows** | NTFS rename-over-existing-file uses `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` under the hood when Node calls `fs.renameSync`. This **is** atomic in the sense that observers see either the old or new file, never partial — but **two concurrent writers** can lose updates: writer A reads, writer B reads, A writes (rename), B writes (rename, clobbers A). The bot polls every ~3s, scrape runs every ~07:00; only `/forget` and `/skip` from the bot during a running scrape would conflict. **Consider** a flock-style lock file for `set()`/`appendUnique()`/`removeFromArray()` if multi-profile usage scales up. v1.1 LOW priority. |
| **Process privilege** | Schtasks creation: typically does NOT need admin for "current user" tasks (which is what `setup-tasks.ps1` should be creating). The wizard runs as the user. PowerShell `Disable-ScheduledTask` / `Enable-ScheduledTask` via `/pause` / `/resume-bot` (`telegram-bot.mjs:728, 735`) operate on user-owned tasks — should not need admin. **No code path uses `runas` or `Verb='runAs'`** based on the files read. |
| **Detached spawns from the bot** | `/reauth` (`telegram-bot.mjs:743`), `/uninstall` (`:1366`), and `/update`'s restarter (`:1115`) all use `detached: true, stdio: 'ignore'` + `.unref()`. This is the right pattern for "bot exits, child survives." Worth verifying the **detach point doesn't inherit the bot's TG_TOKEN env or stdin** — `spawn(...)` passes env by default. The token IS in `process.env` for the bot but **not loaded into env from `.env`** — `env` is parsed into a local object (`telegram-bot.mjs:73-78`), not exported. So children of `spawn` get the system env, not the parsed `.env`. ✓ |
| **Telegram chat-ID guard** | Both `handleMessage` (`:567-572`) and `handleCallback` (`:1304-1306`) compare `chatId !== ALLOWED_CHAT` and bail. The rejected-message log line **does not echo the rejected chat ID** (`:570`) — explicit comment "could enable enumeration via log scrape" — good. The callback path's reject text says "Not authorized" with `alert: true` (`:1306`) — fine. |
| **Resume upload path traversal** | `telegram-bot.mjs:1454-1457` — `path.extname(doc.file_name || '').toLowerCase()` is checked against an allowlist. The local write is `path.join(ROOT, 'data', 'cv-uploaded' + ext)` (`:1478`), which uses a fixed filename, not `doc.file_name`. **No traversal risk.** ✓ |
| **`spawn` arguments user-influenced?** | `cfgRW.set('weather.lat', r.lat)` etc. passes geocoded numbers, not strings, to a write op (no spawn). `/skip <company>` is appended to a JSON array, not passed to a shell. `/jobs add <title>` likewise. **No user input reaches an argv array** for spawned binaries. The schtasks calls all use hardcoded task names. ✓ |
| **PowerShell command injection** | `watchdog.mjs:113` builds a multi-statement PowerShell string with `$_.Id` (loop variable from `Get-Process`), not user input. Safe. `watchdog.mjs:106` interpolates `hb.pid` into a PowerShell string — `hb.pid` comes from `data/heartbeat.json` which the bot writes; if that file is tampered with, an attacker who can already write to `data/` can inject. Out of threat model (local-first; attacker on disk is game-over already). |
| **Logs as data exfil** | The bot's `data/telegram-bot.log` accumulates the user's entire conversation history with their own bot. If someone steals `data/`, they get applications.md + saved.md + the log. Documented as "everything is local-first" in README. No mitigation needed unless an "encrypt-at-rest" feature is added. |

---

## 9. Recommended quality-improvement work for v1.1

Listed in priority order. Each is sized so it's bite-sized enough to slot into a v1.1 phase.

### HIGH — security-adjacent or coverage gaps in critical paths

**H1. HMAC sig tests for `callback-router.mjs`** *(est. 1 hour)*
Add `scripts/__tests__/callback-router.test.mjs` covering:
- `makeCallback('s', 5, 'https://hiring.cafe/viewjob/abc', 'token123')` produces deterministic 8-hex sig
- `parseAndVerify` with the same callback-data + same token → `{ok:true, action:'s', idx:5, item:...}`
- `parseAndVerify` with a tampered sig → `{ok:false}`
- `parseAndVerify` with a different token → `{ok:false}`
- `parseAndVerify` with malformed input (`""`, `"a:b"`, `"a:b:c:d"`, `"a:notnum:c"`) → `{ok:false}`
- Job action vs nav action sig difference (`makeNavCallback` uses `viewjobUrl=''`)
- Expired callbacks table (`expiresAt` in past) → `{ok:false, expired:true}`

Requires stubbing the file-read for `lookupItem`. Use a temp dir or mock `fs.readFileSync`. Pure-function tests; no network.

**H2. Update CLAUDE.md test-suite claim** *(est. 5 minutes)*
Edit line 24: "There is no test suite, linter, or build step" → "There is a small test suite (`npm test` runs ~24 unit tests of pure helpers); no linter, no build step." Update §3 "Conventions" to mention the test runner.

**H3. Update README roadmap + data-files table** *(est. 20 minutes)*
- Mark v0.5/v0.6/v1.0 as ✅ with their actual scope (multi-profile, uninstall, Inno Setup).
- Update `data/` paths to reflect `data/profiles/<active>/`.
- Reword `/save N` and `/applied N` to local-first behavior.

### MEDIUM — operational resilience

**M1. Watchdog kill+restart unit test** *(est. 2 hours)*
Add `scripts/__tests__/watchdog.test.mjs`:
- Use a temp dir for `HEARTBEAT_FILE` / `STATE_FILE` / `SELF_HEARTBEAT`.
- Stub `child_process.spawnSync` (via `node:test`'s `mock` module) to record calls.
- Drive the watchdog as a function (refactor: split the bottom IIFE into an exported `tick()` so tests can call it).
- Cases: healthy heartbeat → no kill; stale heartbeat, restarts < MAX → kills + starts; stale heartbeat, restarts ≥ MAX → no kill, gave-up alert sent; gave-up state expires after 1 hour.

Requires a small refactor (export `tick()`). Worth it.

**M2. Log rotation for `telegram-bot.log` and `watchdog.log`** *(est. 1 hour)*
Simplest implementation: at module load, if file size > `LOG_ROTATE_MAX_MB` (e.g. 10 MB), rename to `.log.1` (replacing any existing `.log.1`) and start fresh. Keep one historical generation. No external dependency.

Alternative: split by date like `daily-batch-{date}.log` does. Slightly more work; better for correlation. Recommend the size-based one for v1.1.

**M3. Concurrent-write test for `config-rw.mjs`** *(est. 1.5 hours)*
Spawn N child processes in `node --test` that each call `appendUnique('queries', {key,term})` with a unique term, wait for all to exit, then read the file and assert all N entries are present. Will surface lost-update race on Windows if it exists.

If it does exist: add a flock-style `.lock` file with `fs.openSync(O_CREAT | O_EXCL)` and stale-lock detection.

**M4. Phrase-proximity behavioral tests with a fixture CV** *(est. 1.5 hours)*
The test file's own header notes these are "gated on the CV-parsed.json fixture." Ship a fixture `scripts/__tests__/fixtures/cv-iam.json`, set up `daily-batch.mjs` to accept an env override for the CV path, and assert that:
- Frequent term mentions trigger TF cap (saturates at 3×).
- Multi-token phrase with adjacent tokens scores full weight.
- Same phrase with tokens scattered in the JD scores half weight.
- Off-cluster term scores half weight when primary clusters are set.

### LOW — non-blocking polish

**L1. `// @ts-check` + JSDoc on public exports** *(est. 2 hours, optional)*
Add `// @ts-check` to `daily-batch.mjs`, `callback-router.mjs`, `profile-store.mjs`, `config-rw.mjs`. JSDoc-type the exported functions and the config schema. Catches drift in IDE without a build step. No `tsconfig.json` strictly required, but a minimal one (`"checkJs": true`, `"target": "es2022"`) at the root makes IDE-wide checks consistent.

**L2. Extract `handleMessage` dispatch table** *(est. 4 hours; refactor)*
Replace the 600-line if/else chain in `telegram-bot.mjs:566-1175` with `commands/{name}.mjs` files exporting `{matcher, handler}`. This **does not improve coverage on its own** but makes per-command tests writable for the first time. Defer if v1.1 timeline is tight; tackle in v1.2.

**L3. Kill the duplicate `escHtml`** *(est. 5 minutes)*
Move to `scripts/util.mjs` and re-export from both modules. Trivial. Not blocking.

**L4. Constants for unexplained magic numbers** *(est. 30 minutes)*
- `OFF_CLUSTER_MULTIPLIER = 0.5` (`daily-batch.mjs:427`)
- `PARTIAL_PHRASE_MULTIPLIER = 0.5` (`daily-batch.mjs:499`)
- `CARD_TEXT_TRUNCATE = 1500` (`daily-batch.mjs:182`)
- `BROWSER_PAGE_SETTLE_MS = 1500` / `2000` / `2500` — pick one or three named constants
- `HISTORY_PAGE_SIZE = 5` (extracted from `:1236, :1270`)

### Out of scope for v1.1, recorded for later

- Full TypeScript migration: too invasive; pure JSDoc check covers 80% of value.
- ESLint + Prettier: only worth it if more contributors arrive.
- Property-based tests for `parseSalaryK` (fast-check): nice-to-have; the hand-written cases already cover the known regression.
- E2E test against a recorded hiring.cafe HAR: would be expensive to maintain; not justified for a single-user tool.

---

## Appendix A: How v1.0 production-validates today

For reference — this is the current "test plan" per `CLAUDE.md`:

1. `npm run daily` end-to-end → watch for the 100-job batch landing in Telegram.
2. Tail `data/daily-batch-{date}.log` for `raw=…` / `keptAfterFilter=…` / `afterDedup=…` lines.
3. Tail `data/telegram-bot.log` for `< /command` echoes and any `UNHANDLED REJECTION` lines.
4. The watchdog sends a Telegram alert if the bot dies, so silent death is mostly caught.

This works for one user (the author) on one machine. It does **not** scale to "multiple OS targets" (v1.1 Mac/Linux), where the developer can no longer drive end-to-end smoke tests on every install. **The v1.1 plan should expect to spend more on automated tests than v1.0 did.**

## Appendix B: At-a-glance test priority

If only **one** test file gets added before v1.1 ships, it's `callback-router.test.mjs` (item H1). Reasons:
- Pure functions, fast to write.
- Security-adjacent (HMAC).
- Currently 0% coverage on a hot path (every Save/Applied/Why button click hits `parseAndVerify`).
- Catches both regressions (sig-format change) and forgery resistance regressions in one file.
