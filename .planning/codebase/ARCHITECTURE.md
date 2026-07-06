<!-- refreshed: 2026-05-07 -->
# Architecture

> **⚠️ STALE — describes v1.0.0 (banner added 2026-07-06).** This map predates the Go tray wrapper (v1.2), the localhost dashboard (v1.3 / v2.1 control surface), the installed-browser resolver (v2.0.1), the desktop-first pivot (v2.1), and cross-platform support (v1.1). Current architecture is a **four-process** design (wrapper + bot + scraper + watchdog), desktop-first with optional Telegram — see `STATE.md` / `PROJECT.md` / `CLAUDE.md`. **Regenerate this file with `/gsd-map-codebase` before the next milestone.** Below is the v1.0.0 snapshot.

**Analysis Date:** 2026-05-07

## 1. System Overview

Automatic Munyun Machine (AMM) v1.0.0 is a local-first Windows tool that scrapes hiring.cafe daily, ranks the top 100 jobs against the user's CV, and pushes them to Telegram. It runs entirely on the user's laptop with no server, no cloud, and no third-party APIs beyond hiring.cafe (scraped via Playwright), open-meteo (weather; no key), Telegram Bot API, and the GitHub Releases API (for `/update` / `/version`).

The system is a **three-process model coordinated through the filesystem**: there is no shared memory, no IPC socket, no daemon, no message bus. The scraper (`scripts/daily-batch.mjs`), the long-running poller (`scripts/telegram-bot.mjs`), and the watchdog (`scripts/watchdog.mjs`) each launch as independent Node processes from Windows Task Scheduler. They share state by reading and writing files under `data/` and `config.json` — atomically, with temp-file + rename for the config and append-only for log files. A small fleet of one-shot helper scripts (login warmup, job action click, resume parser, geocoder, file picker, update checker, uninstaller) is spawned synchronously by the bot or wizard as needed and exits when done.

```text
┌───────────────────────────────────────────────────────────────────────┐
│                          Telegram (cloud)                              │
│        Bot API · sendMessage · sendDocument · getUpdates ·            │
│        callback_query · answerCallbackQuery · editMessageText         │
└─────────────▲──────────────────────────────────▲──────────────────────┘
              │                                  │
   getUpdates │ sendMessage                      │ sendMessage
   (long-poll)│ (chunked HTML)                   │ (alerts only)
              │                                  │
┌─────────────┴──────────┐    ┌───────────┐  ┌──┴────────────────────┐
│  telegram-bot.mjs      │    │ daily-    │  │  watchdog.mjs          │
│  (long-running)        │    │ batch.mjs │  │  (Task Scheduler 5min) │
│  PID + heartbeat       │    │ (one-shot)│  │  reads heartbeat       │
└──┬───┬────────────┬────┘    └─────┬─────┘  └────────┬───────────────┘
   │   │            │                │                │
   │   │ spawn      │ spawn helpers  │ spawn          │ schtasks /run
   │   │ run-daily  │ (job-action,   │ writes         │ munyun-bot
   │   │ -batch.cmd │  resume-       │ last-batch.    │ on stale heartbeat
   │   │            │  parser, …)    │ json,          │
   │   ▼            ▼                │ seen-jobs,     │
   │ ┌─────────────────────┐         │ TSV/TXT,       │
   │ │ Helper one-shots    │         │ callback       │
   │ │ (one job each)      │         │ table          │
   │ └─────────────────────┘         │                │
   │                                  ▼                ▼
   │                       ┌────────────────────────────────────┐
   │ writes heartbeat,     │     Filesystem state (data/)       │
   └─────────────────────▶ │  config.json · heartbeat.json ·    │
                           │  data/profiles/<slug>/* · logs ·   │
                           │  browser-profile/ (Chromium)        │
                           └────────────────────────────────────┘
                                          ▲
                                          │ atomic temp+rename
                           ┌──────────────┴────────────┐
                           │  config-rw.mjs            │
                           │  profile-store.mjs        │
                           └───────────────────────────┘
```

## 2. Process Inventory

### 2.1 Scraper — `scripts/daily-batch.mjs` (963 lines)

**One-shot.** Fires Mon-Fri at 07:00 (configurable per-profile), or on-demand when the bot receives `/scrape` / `/daily` / `gm` / `morning`, or manually via `npm run daily`.

**Triggered by:**
- Task Scheduler entry `munyun-daily-batch` running `scripts/run-daily-batch.cmd` → `node scripts/daily-batch.mjs` (`scripts/setup-tasks.ps1:48-53`)
- Bot's `runClaudeBatch()` (`scripts/telegram-bot.mjs:257-294`) spawns the same `.cmd` via `spawn(CMD_EXE, ['/c', 'run-daily-batch.cmd'])`
- Manual: `npm run daily` (script defined in `package.json:13`)

**Produces** (per active profile, under `data/profiles/<slug>/`):
- `today-batch-<DATE>.tsv` — 100-row machine-readable batch
- `today-batch-direct-urls-<DATE>.txt` — resolved ATS URLs only
- `jobs(<DATE>).txt` — human-readable batch (Telegram document attachment)
- `last-batch.json` — rich per-job match details + funnel (consumed by `/why N`, `/status`, `/diagnose`, `/forget last`)
- `last-batch-callbacks.json` — idx → {url, company, …} table backing inline-button taps for 7 days
- `seen-jobs.json` — persistent dedupe map `{ jobs: { url: { firstSeenAt, lastSeenAt } } }` with 60-day decay
- `query-stats.json` — per-query 7-day rolling card counts (consumed by `/diagnose`)

**Plus shared:**
- `data/auth-state.json` — `{ lastAuthOK, lastAuthFail }` timestamps
- `data/daily-batch-<DATE>.log` — per-run log
- Telegram messages and document attachment to the user's chat

**Top-level pipeline** (CLI guard at `scripts/daily-batch.mjs:843`):
1. `migrateIfNeeded()` → `readActiveConfig()` (`daily-batch.mjs:23-65`)
2. `scrape()` — Cloudflare warmup probe + paginated multi-query scrape (`daily-batch.mjs:229-368`)
3. `filterAndDedupe()` — drop title patterns, skip companies, clearance, YOE cap (`daily-batch.mjs:531-553`)
4. Subtract applied (`applications.md`) and previously-seen (`seen-jobs.json`, decayed)
5. `scoreJob()` over each fresh row (`daily-batch.mjs:479-515`)
6. Match-floor cut → top 100 slice (`daily-batch.mjs:878-880`)
7. `resolveAll()` — relaunch Playwright, parallel-fetch direct ATS URLs (`daily-batch.mjs:675-697`)
8. `writeBatchTsv()` + `last-batch.json` write (`daily-batch.mjs:803-838`)
9. `tgChunked(message)` — paginated Telegram send (`daily-batch.mjs:108-120, 909`)
10. `tgDocument()` — `.txt` attachment (`daily-batch.mjs:96-106, 917`)
11. `saveSeenStore()` — only after Telegram delivery succeeds (`daily-batch.mjs:925`)
12. `writeCallbackTable()` + final CTA inline keyboard (`daily-batch.mjs:931-953`)

### 2.2 Bot — `scripts/telegram-bot.mjs` (1615 lines)

**Long-running.** Started at user logon by Task Scheduler entry `munyun-bot` via `scripts/start-bot.cmd` (`setup-tasks.ps1:55-60`). Runs in a minimized `cmd /c node scripts\telegram-bot.mjs` window titled `"munyun bot"` (`scripts/start-bot.cmd:11`).

**Dispatches ~30 commands** plus 10 inline-button callback actions. See `HELP_TEXT` at `telegram-bot.mjs:343-392` for the full menu.

**Survives crashes via three layers:**
1. `process.on('unhandledRejection')` + `process.on('uncaughtException')` (`telegram-bot.mjs:104-111`) — logs the kitchen sink, doesn't propagate
2. Poll-loop exponential backoff: `[5s, 10s, 20s, 30s]` cap (`telegram-bot.mjs:1564, 1603-1614`)
3. Out-of-process watchdog (next process below) — restarts the bot if its heartbeat goes stale

**Stateful only via:**
- `data/bot-offset.json` — Telegram poll cursor (`telegram-bot.mjs:133-140`)
- `data/heartbeat.json` — written every poll iteration (`telegram-bot.mjs:120-130, 1573, 1608`)
- In-memory `runningJob` lock (`telegram-bot.mjs:248`) with 5-min force-clear timer (`telegram-bot.mjs:286-293`)
- In-memory `pendingState` Map (`telegram-bot.mjs:321`) for multi-step interactions (e.g. `/resume` waiting for attachment), 10-min TTL

**Spawning external work:**
- `runClaudeBatch()` → `cmd.exe /c run-daily-batch.cmd` (`telegram-bot.mjs:263`)
- `spawnAction()` → `node job-action.mjs <save|applied|auth> <url>` (`telegram-bot.mjs:409-414`)
- `/reauth` → `cmd.exe /c login-once.cmd` detached (`telegram-bot.mjs:743-745`)
- `/pause` / `/resume-bot` → `powershell.exe -Command "Disable|Enable-ScheduledTask -TaskName 'munyun-daily-batch'"` (`telegram-bot.mjs:728, 735`)
- `/schedule HH:MM` → re-runs `setup-tasks.ps1` via `powershell.exe` (`telegram-bot.mjs:919`)
- `/update` → `git pull origin main` + `npm.cmd install` + detached `cmd /c "timeout /t 4 && schtasks /run /tn munyun-bot"` then `process.exit(0)` (`telegram-bot.mjs:1089-1123`)
- `/uninstall` → spawns `node scripts/uninstall.mjs --mode=<pause|wipe>` detached, then `process.exit(0)` (`telegram-bot.mjs:1364-1373`)

### 2.3 Watchdog — `scripts/watchdog.mjs` (191 lines)

**One-shot, every 5 min.** Task Scheduler entry `munyun-watchdog` runs `node scripts/watchdog.mjs` once-and-repeat with a 5-minute interval (`setup-tasks.ps1:62-72`).

**Detection:** reads `data/heartbeat.json`. If the bot's last heartbeat is older than `STALE_THRESHOLD_MS = 10 min` (`watchdog.mjs:42`), bot is considered dead or hung.

**Recovery sequence** (`watchdog.mjs:171-189`):
1. `killBot(hb)` — `Stop-Process -Id <pid>` via PowerShell (precise PID from heartbeat), then a belt-and-suspenders `Get-Process node | … if ($cl -match 'telegram-bot')` cleanup of orphans (`watchdog.mjs:101-118`)
2. `setTimeout(2000)` — let the OS reap the killed process
3. `startBot()` — `schtasks /run /tn munyun-bot` (`watchdog.mjs:120-126`)
4. Append timestamp to `data/watchdog-state.json#restarts[]` (sliding 1-hour window)
5. Telegram alert via independent `node scripts/telegram-send.mjs <text>` process — does NOT import bot code, so a corrupt bot module can't take the alerter down

**Throttling** (`watchdog.mjs:159-169`): if `restarts.length >= 3` in the last hour, give up and send a single "won't auto-restart again, check logs" alert. Reset on any successful restart attempt.

**Self-heartbeat:** writes `data/watchdog-heartbeat.json` on every tick so future tooling can verify the watchdog itself is running.

### 2.4 Helper one-shots (spawned, exit when done)

| Script | Lines | Purpose |
|---|---:|---|
| `scripts/setup-wizard.mjs` | 463 | 10-step interactive wizard. Creates `.env` + `config.json`, geocodes city, parses CV, registers Task Scheduler entries via `setup-tasks.ps1`. |
| `scripts/login-once.mjs` | 81 | Cloudflare warmup (v1.0.x): opens visible Chromium with the persistent profile, navigates to `https://hiring.cafe/`, waits up to 45s for job cards to render, persists profile. Optional Google sign-in for `/save`/`/applied` server-side bookmarking. |
| `scripts/job-action.mjs` | 97 | Performs `save` / `applied` / `auth` against hiring.cafe with the persistent Chromium profile. Exit codes: 0=OK, 7=AUTH_OPTIONAL (skip silently), 1/3/4=fail. |
| `scripts/resume-parser.mjs` | 137 | Parses PDF/DOCX/MD/TXT into `cv-parsed.json` via regex match against `cv-keywords.json`. Computes `primaryClusters` (top 2 by signal density) for cluster-aware scoring. |
| `scripts/role-suggester.mjs` | 123 | CV → suggested job titles by domain cluster. Used by `/jobs suggest` and wizard step 5. |
| `scripts/geocode.mjs` | 38 | open-meteo geocoding wrapper (no API key). Used by `/city <name>` and wizard step 9. |
| `scripts/update-checker.mjs` | 188 | Polls GitHub Releases API. 5-min in-memory cache. Persists `data/update-state.json` (dismissed version). Owns `markUpdating()` / `consumePostUpdateFlag()` for post-update confirmation pings. |
| `scripts/file-picker.mjs` | 52 | Spawns PowerShell + `System.Windows.Forms.OpenFileDialog` for the wizard's resume step. |
| `scripts/telegram-send.mjs` | 30 | Standalone Telegram sender. Used by watchdog and `batch-missed-watcher` so they don't import bot code. |
| `scripts/uninstall.mjs` | 118 | Two modes: `--mode=pause` (kill bot + unregister 4 tasks) and `--mode=wipe` (pause steps + delete `data/`, `config.json`, `.env`). Idempotent. |
| `scripts/batch-missed-watcher.mjs` | 89 | Pings Telegram if `today-batch-<DATE>.tsv` is missing 1h after the scheduled batch time on a scheduled day. State in `data/batch-missed-state.json` to avoid double-ping. |
| `scripts/setup-tasks.ps1` | 84 | Registers/re-registers `munyun-daily-batch`, `munyun-bot`, `munyun-watchdog`, `munyun-batch-missed`. Migrates legacy `career-ops-*` names. |
| `scripts/run-daily-batch.cmd` | 14 | `node "%~dp0daily-batch.mjs"` — Task Scheduler launcher for the scraper. |
| `scripts/start-bot.cmd` | 11 | `start "munyun bot" /min cmd /c "node scripts\telegram-bot.mjs"` — Task Scheduler launcher for the bot. |
| `scripts/login-once.cmd` | 8 | Wrapper for `login-once.mjs`. |
| `scripts/uninstall.ps1` | 69 | Symmetric to `install.ps1` for `iwr | iex` users. Prompts pause vs wipe, then runs `node scripts/uninstall.mjs --mode=<choice>`. |

## 3. Scrape Pipeline Data Flow

For one batch run (`scripts/daily-batch.mjs:843-963`):

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. migrateIfNeeded() / readActiveConfig()                             │
│    profile-store.mjs:63 / readActiveConfig() at :176                  │
│    → CFG.queries / CFG.scoring / CFG.user / CFG.weather               │
│    → CV from data/profiles/<active>/cv-parsed.json                    │
└──────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 2. launchBrowser() — chromium.launchPersistentContext(data/browser-   │
│    profile)  + checkBrowsable() probe (Cloudflare gate)               │
│    daily-batch.mjs:188-227                                            │
│    │                                                                   │
│    └─ Throws Error{unauth:true} if cards never render → bot pings    │
│       "session expired, run scripts\login-once.cmd" (:853)            │
└──────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 3. Multi-query paginated scrape (daily-batch.mjs:273-353)             │
│    For each [key, query] in CFG.queries:                              │
│      - goto hiring.cafe?searchState={query, Remote, formEase?}        │
│      - Page 1: extract via EXTRACT_FN (a[href^="/viewjob/"] cards)    │
│      - Pages 2..MAX_PAGES_PER_QUERY (50): click [aria-label*=next]    │
│        until disabled, missing, or page returns 0 new cards           │
│      - Cross-query early stop: once running fresh estimate ≥ target   │
│        × 1.5 (default 150), skip remaining queries                    │
│    Records per-query supply to query-stats.json (recordQueryStats:372)│
└──────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 4. filterAndDedupe (daily-batch.mjs:531-553)                          │
│    - Cross-query dedup by href                                         │
│    - r.yoe > maxYoeAcceptable → drop                                  │
│    - DROP_TITLE regex (Manager|Director|Sales Engineer|…) → drop      │
│    - SKIP_CO regex (filters.skipCompanies[]) → drop                   │
│    - CLEARANCE_RX over title + cardText (if filterClearance) → drop   │
└──────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 5. Subtract applied + seen (daily-batch.mjs:860-866)                  │
│    - loadAppliedHrefs() reads applications.md, extracts viewjob URLs │
│    - loadBlockedSeen() reads seen-jobs.json + decays entries          │
│      with lastSeenAt > seenJobsFreshnessDays (default 60)             │
│    - fresh = kept \ (applied ∪ blockedSeen)                           │
└──────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 6. scoreJob() per fresh row + sort by score desc                      │
│    daily-batch.mjs:479-524                                            │
│    - Word-boundary regex match against CV.titles/certs/skills/        │
│      compliance, weighted W_TITLE/CERT/SKILL/COMPLIANCE               │
│    - Term-frequency capped at TF_CAP=3                                │
│    - Cluster multiplier: full weight if term in CV.primaryClusters,   │
│      else half weight                                                  │
│    - Multi-token phrase fallback: if not exact-matched, all tokens    │
│      present anywhere → half credit                                   │
│    - parseSalaryK() over full text → bonus/penalty vs salaryFloorUsd  │
│    - scoreToPercent() maps raw → 0-100% via calibrated bands          │
└──────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 7. Match-floor cut + top-100 slice (daily-batch.mjs:878-881)          │
│    - aboveFloor = fresh.filter(r ⇒ matchPct ≥ matchFloorPercent)      │
│    - top = aboveFloor.slice(0, 100)                                    │
└──────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 8. resolveAll() — direct ATS URLs (daily-batch.mjs:675-697)           │
│    Re-launches the persistent-profile Chromium, opens 5 concurrent    │
│    pages, navigates each /viewjob/<id>, regex-extracts                │
│    "apply_url":"…" from rendered HTML. Plain Node fetch is blocked    │
│    by Cloudflare even with cookies — real-browser nav is the lever.   │
└──────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 9. Persistence + Telegram delivery (daily-batch.mjs:898-953)          │
│    a. writeBatchTsv() → today-batch-<DATE>.tsv +                      │
│       today-batch-direct-urls-<DATE>.txt + last-batch.json (with      │
│       funnel: raw/keptAfterFilter/afterDedup/scored/sent/topPct/…)    │
│    b. getWeather() — open-meteo                                       │
│    c. buildSupplyBanner() — low-supply / dry-query warnings           │
│    d. tgChunked(message) — split on blank-line boundaries at          │
│       MAX=3900 chars, sequential sendMessage calls                    │
│    e. writeBatchTxt() + tgDocument() — jobs(<DATE>).txt attachment    │
│    f. saveSeenStore(blockedSeen, top) — ONLY AFTER Telegram OK,       │
│       so a failed run doesn't burn jobs the user never received       │
│    g. writeCallbackTable(items) → last-batch-callbacks.json (7-day    │
│       expiresAt) + final CTA message with [📋 Open batch browser]    │
│       [📊 Diagnose supply] inline keyboard                             │
└──────────────────────────────────────────────────────────────────────┘
```

## 4. Telegram Dispatch Flow

The bot's main loop (`telegram-bot.mjs:1568-1615`):

```
while (true) {
  j = await tgGet('getUpdates', {
    offset, timeout: 30,
    allowed_updates: '["message", "callback_query"]'
  })
  writeHeartbeat({ lastPollOk: true })           # ← watchdog input
  for (u of j.result) {
    if (u.message?.document)  → handleAttachment(u.message)
    elif (u.message)          → handleMessage(u.message)
    elif (u.callback_query)   → handleCallback(u.callback_query)
    offset = u.update_id + 1
  }
  saveOffset(offset)
} catch (e) {
  consecutiveFailures++
  writeHeartbeat({ lastPollOk: false, consecutiveFailures })
  delay = BACKOFF_MS[min(failures-1, 3)]   # 5s → 10s → 20s → 30s
  sleep(delay)
}
```

### Command messages

`handleMessage(msg)` (`telegram-bot.mjs:566-1175`):
1. Reject if `chatId !== ALLOWED_CHAT` (`:568-572`) — note: rejected chat ID is NOT logged to prevent enumeration
2. Match `text` against ~30 regex patterns sequentially. First match wins.
3. Each branch either:
   - Calls `cfgRW.set/appendUnique/removeFromArray` for settings (atomic)
   - Calls `spawnWithTimeout(POWERSHELL/SCHTASKS/CMD_EXE/node, args)` for system actions
   - Reads `data/profiles/<active>/last-batch.json` or other state for queries
   - Returns a `reply()` (HTML parse_mode, falls back to plain text on parse error)

### Callback queries (inline buttons)

`handleCallback(cq)` (`telegram-bot.mjs:1303-1439`):
1. Reject if `chatId !== ALLOWED_CHAT` → `tgAnswerCallback('Not authorized', alert=true)`
2. `parseAndVerify(cq.data, TG_TOKEN)` (`callback-router.mjs:61-81`):
   - Split `<action>:<idx>:<sig>` (3-part)
   - For job-targeted actions (`s`/`a`/`w`/`k`): look up item by `idx` in `data/profiles/<active>/last-batch-callbacks.json`. If table is missing or `expiresAt` past → `{ok: false, expired: true}` → toast "This batch has expired — run /scrape"
   - Recompute HMAC-SHA256 of `<action>:<idx>:<viewjobUrl>` keyed by `TG_TOKEN`, take first 8 hex chars, compare to `sig`. Mismatch → toast "Invalid or stale button"
3. Dispatch by action code:
   - `noop` → ack only (counter button)
   - `b` → batch browser nav: `tgEditMessage` to re-render the same bubble with `renderJobPage(idx)` (in-place edit, not a new message)
   - `h` → history pagination → `showHistory(idx)`
   - `sv` → saved-jobs pagination → `showSaved(idx)`
   - `diag` → run `buildDiagnoseMessage()` and reply
   - `uni` → uninstall confirmation: idx 0=cancel, 1=pause, 2=wipe → spawns `uninstall.mjs --mode=<>` detached, exits
   - `s` → save: append to `saved.md`, `spawnAction('save', url)`
   - `a` → applied: append to `applications.md`, `spawnAction('applied', url)`
   - `w` → why: read `last-batch.json`, format matched-terms reply
   - `k` → skip-company: `cfgRW.appendUnique('filters.skipCompanies', item.company)`

### Why a separate callback table

Telegram caps `callback_data` at 64 bytes per button. A full viewjob URL alone exceeds that. The scheme in `scripts/callback-router.mjs:44-57` packs `<action>:<idx>:<sig>` into ~14-20 bytes by deferring the URL to a per-batch lookup table (`data/profiles/<active>/last-batch-callbacks.json`, 7-day TTL). The HMAC sig defends against stale callbacks: if the user taps a button from yesterday's batch after today's `/scrape` rotates the table, the sig recomputed against the NEW idx→url mapping won't match, and the bot rejects with "Invalid or stale button."

## 5. Profile Store

`scripts/profile-store.mjs` (192 lines) owns multi-profile CRUD + filesystem layout + idempotent migration.

### Schema

```jsonc
// config.json (post-migration shape)
{
  "active_profile": "default",
  "profiles": {
    "default": {
      "user":     { "name", "salaryFloorUsd", "maxYoeAcceptable" },
      "queries":  [ { "key", "term" }, … ],
      "filters":  { "filterClearance", "applicationFormEase", "skipCompanies", "dropTitlePatterns" },
      "scoring":  { "titleWeight", "certWeight", "skillWeight", "complianceWeight",
                    "salaryBonus", "salaryPenalty", "matchFloorPercent",
                    "maxPagesPerQuery", "targetJobsPerBatch", "seenJobsFreshnessDays" },
      "weather":  { "city", "lat", "lon", "tempUnit", "timezone" },
      "schedule": { "time", "days[]" },
      "telegram": { "messageHeader", "showAuthIndicator" }
    },
    "<other-slug>": { … }
  }
}
```

`PROFILE_FIELDS = ['user', 'queries', 'filters', 'scoring', 'weather', 'schedule', 'telegram']` (`profile-store.mjs:36`) — exactly these top-level keys live inside a profile.

### Per-profile data files

Under `data/profiles/<slug>/` (`PROFILE_DATA_FILES`, `profile-store.mjs:39-46`):
- `cv-parsed.json`
- `seen-jobs.json`
- `last-batch.json`
- `last-batch-callbacks.json`
- `applications.md`
- `query-stats.json`

Plus, written by `daily-batch.mjs` directly into the active profile's dir:
- `today-batch-<DATE>.tsv`
- `today-batch-direct-urls-<DATE>.txt`
- `jobs(<DATE>).txt`
- `saved.md` (appended by callback handler `s` and `/save N`)

### Migration (`profile-store.mjs:63-94`)

`migrateIfNeeded()` is **idempotent** and called from every script entrypoint that reads config (`daily-batch.mjs:23`, `telegram-bot.mjs:50`, `batch-missed-watcher.mjs:27`, `config-rw.mjs:36/42/68/92/113`). On first call after upgrading from v0.x:

1. Detects flat shape (no `profiles` field) and wraps existing `user/queries/filters/scoring/weather/schedule/telegram` into `profiles.default.*`
2. Atomically writes the new `config.json` via `atomicWriteConfig()` (temp file + rename, `:56-60`)
3. Relocates each per-profile data file from `data/<f>` → `data/profiles/default/<f>` via `fs.renameSync`

### Shared vs per-profile

| State | Location | Shared? |
|---|---|---|
| Bot heartbeat | `data/heartbeat.json` | **Shared** — one bot process serves all profiles |
| Watchdog state | `data/watchdog-state.json`, `data/watchdog-heartbeat.json` | Shared |
| Telegram offset | `data/bot-offset.json` | Shared |
| Auth state | `data/auth-state.json` | Shared (one hiring.cafe session) |
| Update state | `data/update-state.json` | Shared |
| Batch-missed state | `data/batch-missed-state.json` | Shared |
| Browser profile (Chromium cookies) | `data/browser-profile/` | **Shared** — one hiring.cafe account regardless of persona |
| Bot logs | `data/telegram-bot.log`, `data/watchdog.log` | Shared |
| Daily batch logs | `data/daily-batch-<DATE>.log` | Shared (single date stamp, one batch at a time) |
| CV parsed | `data/profiles/<slug>/cv-parsed.json` | **Per-profile** |
| Seen jobs | `data/profiles/<slug>/seen-jobs.json` | Per-profile |
| Last batch | `data/profiles/<slug>/last-batch.json` | Per-profile |
| Callback table | `data/profiles/<slug>/last-batch-callbacks.json` | Per-profile |
| Applications log | `data/profiles/<slug>/applications.md` | Per-profile |
| Saved jobs | `data/profiles/<slug>/saved.md` | Per-profile |
| Query stats | `data/profiles/<slug>/query-stats.json` | Per-profile |

### Bot commands

`telegram-bot.mjs:649-699`:
- `/profile list` → `listProfiles()` + `getActiveProfile()`
- `/profile add <slug>` → `addProfile(slug)` clones from active (`profile-store.mjs:128-144`)
- `/profile switch <slug>` → `setActiveProfile(slug)` — refuses if `runningJob` is set (will apply at next `/scrape`)
- `/profile delete <slug>` → `deleteProfile(slug)` — cannot delete active or last profile

## 6. Filesystem State Map

The filesystem is the **only coordination channel** between processes. Every file under `data/` plus `config.json` is touched by 1-3 processes; no file is touched by all three.

### Top-level under `data/`

| File | Writer | Reader(s) | Purpose |
|---|---|---|---|
| `data/heartbeat.json` | bot (`telegram-bot.mjs:120-130`) every poll | watchdog (`watchdog.mjs:77-80`), `/status`, `uninstall.mjs` | `{ ts, pid, version, startedAt, lastPollOk, consecutiveFailures, lastPollError }` — bot liveness + Telegram reachability |
| `data/watchdog-state.json` | watchdog (`watchdog.mjs:70-75`) | watchdog | `{ restarts: [ts…], gaveUpAt }` — sliding 1h restart counter (max 3) |
| `data/watchdog-heartbeat.json` | watchdog (`watchdog.mjs:56-64`) | (future tooling) | watchdog's own liveness + last phase |
| `data/watchdog.log` | watchdog | human | append-only log |
| `data/bot-offset.json` | bot (`telegram-bot.mjs:138-140`) after each batch of updates | bot at startup | `{ offset }` — Telegram getUpdates cursor |
| `data/telegram-bot.log` | bot (`telegram-bot.mjs:91-96`) | human, `/status` parses last line | append-only, chat ID masked, TG_TOKEN scrubbed |
| `data/daily-batch-<DATE>.log` | scraper (`daily-batch.mjs:76-81`) | human | append-only, per-run |
| `data/auth-state.json` | scraper (`recordAuthOk`/`recordAuthFail`, `daily-batch.mjs:644-657`) | bot (`/auth`, `/status`) | `{ lastAuthOK, lastAuthFail }` |
| `data/update-state.json` | update-checker (`update-checker.mjs:54-56`) | bot startup, `/version`, `/update` | `{ dismissedVersion, lastCheckedAt, lastSeenLatest }` |
| `data/.updating` | bot before `process.exit(0)` for `/update` (`update-checker.mjs:153-161`) | bot at startup (`consumePostUpdateFlag`) | post-update confirmation flag, single use |
| `data/batch-missed-state.json` | batch-missed-watcher (`batch-missed-watcher.mjs:42-47`) | itself | `{ lastAlertedDate, lastAlertedAt }` — once-per-day dedupe |
| `data/browser-profile/` | Playwright (Chromium persistent context) | scraper, `job-action.mjs`, `login-once.mjs` | hiring.cafe cookies + Cloudflare clearance |

### Per-profile under `data/profiles/<slug>/`

| File | Writer | Reader(s) | Purpose |
|---|---|---|---|
| `cv-parsed.json` | `resume-parser.mjs#writeParsedCV` (`resume-parser.mjs:102-108`) | scraper (`scoreJob`), bot (`/jobs suggest`, `/settings`) | `{ titles[], certs[], skills[], compliance[], primaryClusters[], clusterScores, raw }` |
| `seen-jobs.json` | scraper (`saveSeenStore`, `daily-batch.mjs:616-639`) **only after Telegram delivery succeeds** | scraper (`loadBlockedSeen`), bot (`/forget all/last`, `/diagnose`, `/settings`) | `{ jobs: { url: { firstSeenAt, lastSeenAt } }, freshnessDays }` (v1.0 E3 schema) |
| `last-batch.json` | scraper (`writeBatchTsv`, `daily-batch.mjs:818-837`) | bot (`/why N`, `/status`, `/diagnose`, `/forget last`), callback handler `w` | per-job match details + funnel |
| `last-batch-callbacks.json` | scraper (`writeCallbackTable`, `callback-router.mjs:95-114`) | bot (`parseAndVerify`, `openBatchBrowser`) | `{ generatedAt, expiresAt: +7d, items: [ {idx, url, title, company, directUrl, matchPct, score, yoe, q} ] }` |
| `applications.md` | bot (`/applied N` and `a` callback, `telegram-bot.mjs:1399-1402`) | scraper (`loadAppliedHrefs`), bot (`/history`) | append-only `- DATE — title @ company — viewjobUrl` |
| `saved.md` | bot (`/save N` and `s` callback, `telegram-bot.mjs:1385-1388`) | bot (`/saved`) | append-only, same format as applications.md |
| `query-stats.json` | scraper (`recordQueryStats`, `daily-batch.mjs:372-388`) | bot (`/diagnose`, `daily-batch.mjs#buildSupplyBanner`) | per-query 7-day rolling card counts |
| `today-batch-<DATE>.tsv` | scraper | bot (`loadLatestBatch` for `/save N`, `/applied N`), `batch-missed-watcher` (existence check) | machine-readable batch |
| `today-batch-direct-urls-<DATE>.txt` | scraper | (debug, not read programmatically) | resolved ATS URLs only |
| `jobs(<DATE>).txt` | scraper | bot (`/export`) | human-readable batch (Telegram document attachment) |

### Top-level (gitignored)

| File | Notes |
|---|---|
| `config.json` | Owned by `config-rw.mjs` + `profile-store.mjs`. Atomic writes only. |
| `.env` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional `CHROME_DEBUG_PORT`. Read by every entrypoint that talks to Telegram. NEVER quote contents in logs — token-scrub via `.replace(TG_TOKEN, '<TOKEN>')`. |
| `cv.md`, `cv.pdf` | Source resume (input to `resume-parser.mjs`). Gitignored. |

## 7. Lifecycle / Scheduling

### Install paths

| Path | Mechanism | Files |
|---|---|---|
| `.exe` installer (recommended) | Inno Setup | `installer/amm.iss` builds `installer/dist/amm-setup-vX.Y.Z.exe`. Installs to `{localappdata}\automatic-munyun-machine`. Post-install runs `npm install && npx playwright install chromium` then `node scripts/setup-wizard.mjs`. |
| One-liner | `iwr | iex` | `install.ps1` clones to `%LOCALAPPDATA%\automatic-munyun-machine`, installs Node + Git via winget if missing, runs npm install + Chromium install + wizard. |
| Manual | `git clone` | README option 3. |

### Task Scheduler entries (registered by `setup-tasks.ps1`)

| Task name | Trigger | Action | Settings |
|---|---|---|---|
| `munyun-bot` | At logon (current user) | `scripts/start-bot.cmd` → minimized `cmd /c node scripts\telegram-bot.mjs` | RestartCount=5, RestartInterval=1m, ExecutionTimeLimit=1d, runs on battery |
| `munyun-daily-batch` | Weekly on `schedule.days` at `schedule.time` (default Mon-Fri 07:00) | `scripts/run-daily-batch.cmd` → `node scripts\daily-batch.mjs` | StartWhenAvailable, ExecutionTimeLimit=20m, runs on battery |
| `munyun-watchdog` | Once + RepetitionInterval=5m (forever) | `node scripts\watchdog.mjs` | ExecutionTimeLimit=2m, MultipleInstances=IgnoreNew |
| `munyun-batch-missed` | Weekly on `schedule.days` at `schedule.time + 1h` | `node scripts\batch-missed-watcher.mjs` | ExecutionTimeLimit=2m |

`setup-tasks.ps1:40-46` migrates legacy `career-ops-daily-batch` / `career-ops-bot` if present (no-op on fresh installs; pre-v0.2 leftover).

### Uninstall paths (all symmetric)

| Path | Entry point | Calls |
|---|---|---|
| Telegram `/uninstall` | `telegram-bot.mjs:626-643` + callback handler `uni` (`:1353-1374`) | spawns `node scripts/uninstall.mjs --mode=<pause|wipe>` detached, then exits |
| Add/Remove Programs | Inno Setup uninstaller (`installer/amm.iss:71-83`) | `node scripts/uninstall.mjs --mode=wipe` then `[UninstallDelete]` removes `node_modules`, `data`, `{app}` |
| One-liner | `iwr -useb …/uninstall.ps1 | iex` | prompts pause vs wipe, runs `node scripts/uninstall.mjs --mode=<choice>` |

`uninstall.mjs` (`scripts/uninstall.mjs:36`) idempotently kills the bot (PID from heartbeat + cmdline-match orphan cleanup), unregisters all four `munyun-*` tasks via `schtasks /delete /tn <> /f`, and (in `wipe` mode) removes `data/`, `config.json`, `.env`. The install dir itself is never deleted by `uninstall.mjs`; the Inno Setup `[UninstallDelete]` block does that for `.exe` installs, the user does it manually for one-liner installs.

## 8. Cross-Cutting Concerns

| Concern | Owner | Files |
|---|---|---|
| **Cloudflare bypass** | Persistent Chromium profile (`data/browser-profile/`) | `daily-batch.mjs:188-203` (launchBrowser), `daily-batch.mjs:212-227` (checkBrowsable probe), `login-once.mjs:41-79` (Cloudflare warmup) |
| **Token scrubbing** | `.replace(TG_TOKEN, '<TOKEN>')` applied at every error log path | `telegram-bot.mjs:104-111` (top-level handlers), `telegram-bot.mjs:1471` (resume-upload net errors), `telegram-bot.mjs:1498` (resume-upload top-level), per CLAUDE.md convention. Never log the resume download URL — it embeds the token. |
| **Chat ID masking** | Logs only the last 4 digits | `telegram-bot.mjs:1509` (`maskedChat = '***' + ALLOWED_CHAT.slice(-4)`); rejected non-allowed chat IDs are NOT logged at all (`telegram-bot.mjs:570`) |
| **Atomic writes** | Temp file + rename via `fs.writeFileSync` then `fs.renameSync` | `config-rw.mjs:46-50` (config), `profile-store.mjs:56-60` (config) |
| **Crash safety** | unhandledRejection + uncaughtException handlers, log() never throws, poll-loop exponential backoff | `telegram-bot.mjs:91-96` (log), `telegram-bot.mjs:104-111` (handlers), `telegram-bot.mjs:1564-1614` (backoff loop), `telegram-bot.mjs:127-130` (writeHeartbeat swallows write errors) |
| **Replay defense** | HMAC-SHA256 sig of `<action>:<idx>:<viewjobUrl>` keyed by TG_TOKEN, 8 hex chars | `callback-router.mjs:44-51` (makeCallback), `callback-router.mjs:61-91` (parseAndVerify) |
| **Stale callback expiry** | `expiresAt = +7 days` on callback table | `callback-router.mjs:96, 86-87` (TTL check on lookup) |
| **Out-of-process supervision** | Watchdog reads heartbeat, kills + restarts via schtasks | `watchdog.mjs:101-126`, `setup-tasks.ps1:62-72` |
| **Telegram chunking** | `tgChunked()` splits at blank-line boundaries at 3900 chars | `daily-batch.mjs:108-120` |
| **HTML parse_mode + fallback** | Reply with `parse_mode: 'HTML'`; on parse error, retry as plain text | `telegram-bot.mjs:177-188` (reply), `escHtml()` at `telegram-bot.mjs:1504` and `daily-batch.mjs:699` |
| **Version source-of-truth** | `package.json#version` only | `update-checker.mjs:25-32` (`currentVersion()`); never hardcode anywhere else |
| **Timeout-bounded child processes** | `spawnWithTimeout(cmd, args, ms)` returns `{code, output, timeout, error}`; force-kills on timeout | `telegram-bot.mjs:297-312` |
| **Idempotent migrations** | `migrateIfNeeded()` is safe to call from any entrypoint | `profile-store.mjs:63-94` (every script that reads config calls this first) |

## 9. External Integrations

| Service | Used by | Auth | Notes |
|---|---|---|---|
| **hiring.cafe** | scraper (Playwright nav), `job-action.mjs` (button clicks), `login-once.mjs` | Cookies in `data/browser-profile/`. Auth-OPTIONAL for scraping (v1.0.x); Cloudflare clearance is the real requirement. Auth required for `/save` / `/applied` server-side bookmarking. | Plain Node fetch is Cloudflare-blocked; everything goes through real-browser navigation. ~40 cards per page, paginated up to `maxPagesPerQuery=50`. |
| **open-meteo** | `daily-batch.mjs:126-136` (`getWeather`), `telegram-bot.mjs:229-245` (live re-read for `/weather`), `geocode.mjs` | None — public API, no key | 8-10s timeout; failure → `weather unavailable` text fallback |
| **Telegram Bot API** | bot (`tgGet`/`tgPost`/`tgSendDocument`), scraper (`tg`/`tgChunked`/`tgDocument`), `telegram-send.mjs` (alerts only) | `TELEGRAM_BOT_TOKEN` from `.env` | All replies use `parse_mode: 'HTML'`; `disable_web_page_preview: true`. Long-poll `getUpdates` with `timeout: 30, allowed_updates: ['message', 'callback_query']`. 64-byte `callback_data` cap drives the callback-router scheme. |
| **GitHub Releases API** | `update-checker.mjs:78-149` | None — public API; sets `User-Agent: automatic-munyun-machine/<version>` | 8s timeout, 5-min in-memory cache, `/releases?per_page=10` (includes pre-releases) with fallback to `/tags?per_page=10`. Powers `/version`, `/update`, startup ping, daily check. |

## 10. Win32 Coupling Points

Every place that hardcodes Windows-only paths, binaries, or APIs. This is the input to the v1.1 Phase 2 path-abstraction layer. Listed file:line.

### `%SystemRoot%`-resolved system binaries (used to dodge stripped-PATH installs)

- `scripts/telegram-bot.mjs:61-64` — `SYS32`, `POWERSHELL`, `CMD_EXE`, `SCHTASKS`
- `scripts/watchdog.mjs:38-40` — same trio
- `scripts/uninstall.mjs:32-34` — same trio
- `scripts/setup-wizard.mjs:25-31` — `POWERSHELL_EXE`
- `scripts/file-picker.mjs:11-14` — `POWERSHELL`
- `scripts/telegram-bot.mjs:1113` — `TIMEOUT = path.join(SYS32, 'timeout.exe')` for the `/update` restarter

### `cmd.exe` / `.cmd` script invocations

- `scripts/telegram-bot.mjs:263` — `spawn(CMD_EXE, ['/c', 'scripts\\run-daily-batch.cmd'])` (bot starts a batch)
- `scripts/telegram-bot.mjs:743` — `spawn(CMD_EXE, ['/c', 'scripts\\login-once.cmd'])` (`/reauth`)
- `scripts/telegram-bot.mjs:1115` — `spawn(CMD_EXE, ['/c', 'timeout /t 4 && schtasks /run /tn munyun-bot'])` (post-`/update` restarter)
- `scripts/run-daily-batch.cmd` — CMD wrapper, scraper launcher
- `scripts/start-bot.cmd` — CMD wrapper, bot launcher (`start "munyun bot" /min cmd /c "node …"`)
- `scripts/login-once.cmd` — CMD wrapper, login-once launcher
- `scripts/setup-tasks.ps1:12-13` — Task Scheduler actions point at `.cmd` files

### `powershell.exe -Command` / `-File`

- `scripts/telegram-bot.mjs:728` — `Disable-ScheduledTask -TaskName 'munyun-daily-batch'` (`/pause`)
- `scripts/telegram-bot.mjs:735` — `Enable-ScheduledTask -TaskName 'munyun-daily-batch'` (`/resume-bot`)
- `scripts/telegram-bot.mjs:919` — re-runs `setup-tasks.ps1` (`/schedule HH:MM`)
- `scripts/setup-wizard.mjs:367-372` — runs `setup-tasks.ps1` from wizard step 10
- `scripts/setup-wizard.mjs:397` — wizard final spawn (post-finalize)
- `scripts/watchdog.mjs:103-115` — `Stop-Process -Id <pid>` precise kill + `Get-Process | Get-CimInstance` orphan cleanup
- `scripts/uninstall.mjs:58-67` — same kill pattern
- `scripts/file-picker.mjs:16-28` + spawn at `:32` — `Add-Type -AssemblyName System.Windows.Forms` + `OpenFileDialog`

### `schtasks.exe`

- `scripts/telegram-bot.mjs:487` — `schtasks /query /tn munyun-bot /fo CSV /nh` (`/status`)
- `scripts/telegram-bot.mjs:1114` — `schtasks /run /tn munyun-bot` (post-`/update` restart)
- `scripts/watchdog.mjs:121` — `schtasks /run /tn munyun-bot` (recovery)
- `scripts/uninstall.mjs:75` — `schtasks /delete /tn <each-of-4-tasks> /f`

### PowerShell scripts (`.ps1`) — Windows-only by language

- `scripts/setup-tasks.ps1` — Register-ScheduledTask, Get-ScheduledTask, Unregister-ScheduledTask, `[System.DayOfWeek]` enum
- `scripts/uninstall.ps1` — `iwr | iex` symmetric uninstaller
- `install.ps1` — top-level installer, `winget install`, `Get-Command`, PATH refresh

### `npm.cmd` (Windows-specific binary name)

- `scripts/telegram-bot.mjs:1097` — `process.platform === 'win32' ? 'npm.cmd' : 'npm'` — already conditioned, just noting it

### Inno Setup installer

- `installer/amm.iss` — entire file. Win32-specific by design (Inno Setup is Windows-only). Will need a separate Mac `.pkg` / Linux `.deb` story for v1.1.

### Documentation references that imply Windows-only paths

- `scripts/daily-batch.mjs:241` — error message: `"Run scripts\\login-once.cmd to clear the Cloudflare challenge"` (uses backslash, .cmd)
- `scripts/daily-batch.mjs:853` — same string for the unauth Telegram alert
- `scripts/telegram-bot.mjs:723` — `/auth` failure: `"Run <code>scripts\\login-once.cmd</code>"` (backslash, .cmd)
- `scripts/telegram-bot.mjs:1361` — `/uninstall` pause message: `"Re-run <code>scripts\\setup-tasks.ps1</code>"`
- `scripts/uninstall.mjs:117` — pause-mode console output: same `setup-tasks.ps1` string
- `README.md:212-220` — troubleshooting section hardcodes `C:\Windows\System32\WindowsPowerShell\…` and `%LOCALAPPDATA%\automatic-munyun-machine\` paths

### Path conventions

- All scripts use `__dirname`-based `ROOT` resolution (`path.join(__dirname, '..')`) — no `process.cwd()` anywhere (verified in CONTEXT.md change log entry, 2026-05-06 E1 audit). This is a **portability win**; the path-abstraction layer in v1.1 only needs to swap the binary names + script suffixes, not rewrite the directory model.
- Path separators in source are mostly `path.join` (cross-platform), but error/help-text strings hardcode backslashes — see "Documentation references" above. These are user-facing strings, not actual `fs` calls, so they're cosmetic for now but should flip to forward slashes (or be platform-conditional) when porting.

### Summary: what v1.1 must abstract

| Win32 thing | Posix equivalent | Affected files |
|---|---|---|
| `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | n/a (use bash directly, or skip entirely on Mac/Linux) | telegram-bot.mjs, watchdog.mjs, uninstall.mjs, setup-wizard.mjs, file-picker.mjs |
| `cmd.exe /c <.cmd>` | `bash <.sh>` or direct `node <.mjs>` | telegram-bot.mjs (3 sites), .cmd files |
| `schtasks /create|/run|/query|/delete` | launchd plist (Mac) or systemd unit + timer (Linux) | telegram-bot.mjs, watchdog.mjs, uninstall.mjs, setup-tasks.ps1 |
| `Disable-ScheduledTask` / `Enable-ScheduledTask` | `launchctl unload|load` or `systemctl disable|enable --now` | telegram-bot.mjs:728, 735 |
| `Stop-Process -Id` | `kill <pid>` (already cross-platform via `process.kill` once we ditch PowerShell) | watchdog.mjs, uninstall.mjs |
| `System.Windows.Forms.OpenFileDialog` | `osascript -e 'choose file'` (Mac), `zenity --file-selection` (Linux), or skip → typed-path only | file-picker.mjs |
| `npm.cmd` vs `npm` | Already conditioned via `process.platform` | telegram-bot.mjs:1097 |
| Inno Setup installer | `pkgbuild`+`productbuild` (Mac), `dpkg-deb` (Linux), or shipped via Homebrew/cargo/snap | installer/amm.iss |
| `winget install` (in `install.ps1`) | `brew install` (Mac), `apt install`/`dnf install` (Linux) | install.ps1 |
| `%LOCALAPPDATA%\automatic-munyun-machine` | `~/Library/Application Support/automatic-munyun-machine` (Mac), `~/.local/share/automatic-munyun-machine` (Linux) | install.ps1, README.md |

The architectural good news: **no shared-memory or IPC layer needs porting** — the filesystem-coordination model is already platform-agnostic. The work is at the spawn layer (binary names, script extensions) and the scheduler-registration layer (Task Scheduler → launchd/systemd). Roughly 25 spawn sites + 4 scheduling sites + 1 file-picker site.

---

*Architecture analysis: 2026-05-07*
