# Codebase Concerns

**Analysis Date:** 2026-05-07
**Repo state:** AMM v1.0.0 shipped; `v1.0` branch tip; preparing v1.1 (Mac/Linux + code signing)
**Scope:** what is wrong with AMM today — strictly factual, file:line cited

This document is intentionally painful to read. v1.0 prioritized "trustworthy and shareable on Windows," and many of the cuts that made the milestone hit on time are enumerated below. Each item is something the v1.1 plan should consider acknowledging or fixing.

---

## 1. Platform Coupling

AMM is a Windows-only program at the source-code level, not just at the deployment level. Every spawn of an OS binary, every path to a launcher, and every Task Scheduler call has to be re-engineered for Mac and Linux. This is the single biggest tax on v1.1.

### 1.1 Win32-only system-binary spawns

| File:Line | Construct | Mac equivalent | Linux equivalent |
|---|---|---|---|
| `scripts/telegram-bot.mjs:61` | `SYS32 = path.join(process.env.SystemRoot \|\| 'C:\\Windows', 'System32')` | n/a — derive `/usr/bin`, `/bin` from `os.platform()` | n/a — same |
| `scripts/telegram-bot.mjs:62` | `POWERSHELL = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')` | `osascript` for AppleScript dialogs; `bash`/`zsh` for shell | `bash` (`/bin/bash`) |
| `scripts/telegram-bot.mjs:63` | `CMD_EXE = path.join(SYS32, 'cmd.exe')` | `/bin/sh` | `/bin/sh` |
| `scripts/telegram-bot.mjs:64` | `SCHTASKS = path.join(SYS32, 'schtasks.exe')` | `launchctl` (LaunchAgents in `~/Library/LaunchAgents/`) | `systemctl --user` (systemd unit files in `~/.config/systemd/user/`) |
| `scripts/telegram-bot.mjs:263` | `spawn(CMD_EXE, ['/c', '...run-daily-batch.cmd'])` | `spawn('/bin/sh', [run-daily-batch.sh])` | same |
| `scripts/telegram-bot.mjs:728` | `Disable-ScheduledTask -TaskName 'munyun-daily-batch'` | `launchctl bootout gui/$UID/com.amm.daily` | `systemctl --user disable munyun-daily.timer` |
| `scripts/telegram-bot.mjs:735` | `Enable-ScheduledTask` | `launchctl bootstrap` | `systemctl --user enable` |
| `scripts/telegram-bot.mjs:743` | `spawn(CMD_EXE, ['/c', '...login-once.cmd'])` | shell-script wrapper | shell-script wrapper |
| `scripts/telegram-bot.mjs:919` | `spawn(POWERSHELL, [...setup-tasks.ps1])` for `/schedule` | re-render LaunchAgent plist + `launchctl reload` | re-render systemd timer + `systemctl --user daemon-reload` |
| `scripts/telegram-bot.mjs:1097` | `npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'` | already cross-aware (one of the few) | already cross-aware |
| `scripts/telegram-bot.mjs:1113-1115` | `restartCmd = "TIMEOUT.exe /t 4 /nobreak >nul && schtasks /run /tn munyun-bot"` | `sleep 4 && launchctl kickstart -k gui/$UID/com.amm.bot` | `sleep 4 && systemctl --user restart munyun-bot` |
| `scripts/watchdog.mjs:38-40` | Same `SYS32` / `POWERSHELL` / `SCHTASKS` triple | Same launchctl story | Same systemctl story |
| `scripts/watchdog.mjs:104-117` | `Stop-Process -Id $pid` + `Get-Process node` cmdline match | `kill <pid>` + `pgrep -f telegram-bot` | `kill <pid>` + `pgrep -f telegram-bot` |
| `scripts/watchdog.mjs:121` | `schtasks /run /tn munyun-bot` | `launchctl kickstart` | `systemctl --user start munyun-bot` |
| `scripts/uninstall.mjs:32-34` | Same triple | launchctl + `~/Library/LaunchAgents/*.plist` removal | systemctl `--user disable --now` + unit file removal |
| `scripts/uninstall.mjs:75` | `schtasks /delete /tn ... /f` | `launchctl bootout` + plist `rm` | `systemctl --user disable --now` + unit `rm` |
| `scripts/file-picker.mjs:11-14, 16-28` | `Add-Type -AssemblyName System.Windows.Forms; OpenFileDialog` | `osascript -e 'choose file ...'` | `zenity --file-selection` (GTK) or `kdialog --getopenfilename` (KDE) — fall back to typed input if neither installed |
| `scripts/setup-wizard.mjs:28-31` | `POWERSHELL_EXE` resolved from `%SystemRoot%` | n/a | n/a |
| `scripts/setup-wizard.mjs:369-378` | Spawn `setup-tasks.ps1` for Task Scheduler registration | spawn `setup-tasks-mac.sh` (LaunchAgent plist gen) | spawn `setup-tasks-linux.sh` (systemd unit gen) |
| `scripts/setup-wizard.mjs:396-398` | `Start-ScheduledTask -TaskName 'munyun-bot'` | `launchctl kickstart gui/$UID/com.amm.bot` | `systemctl --user start munyun-bot` |

Every one of those is a separate spawn that needs an `os.platform()` switch in v1.1. There is currently **no abstraction layer** — each call site re-derives `SYS32` independently, so a path-helper module (`scripts/os-paths.mjs`) is a v1.1 prerequisite, not an optimization.

### 1.2 Win32-only launcher files

| File | Purpose | v1.1 equivalent needed |
|---|---|---|
| `scripts/run-daily-batch.cmd` | Task Scheduler invokes this to launch `node scripts/daily-batch.mjs` | `scripts/run-daily-batch.sh` (LaunchAgent + systemd target) |
| `scripts/start-bot.cmd` | Task Scheduler invokes this at logon to launch the bot detached with window title `munyun bot` | `scripts/start-bot.sh` (LaunchAgent ProgramArguments / systemd ExecStart) |
| `scripts/login-once.cmd` | Wraps `node scripts/login-once.mjs` for non-technical users | `scripts/login-once.sh` |

### 1.3 PowerShell-only scripts

| File:Line | Purpose | v1.1 equivalent |
|---|---|---|
| `scripts/setup-tasks.ps1:1-85` | Registers all four Task Scheduler entries (`munyun-bot`, `munyun-daily-batch`, `munyun-watchdog`, `munyun-batch-missed`) | `scripts/setup-tasks-mac.sh` writing four LaunchAgent plists; `scripts/setup-tasks-linux.sh` writing four systemd user units (`.service` + `.timer`) |
| `scripts/uninstall.ps1` | PowerShell wrapper for `iwr \| iex` users; symmetric to install one-liner | `scripts/uninstall.sh` for `curl \| sh` |
| `install.ps1` (top-level) | One-liner installer for Windows | `install.sh` |

### 1.4 Hardcoded backslash path strings in user-visible messages

Not load-bearing for execution (Node's `path` module handles separators internally), but baked into Telegram strings the user sees:

- `scripts/daily-batch.mjs:241` — `'Run scripts\\login-once.cmd to clear the Cloudflare challenge'` (user message)
- `scripts/daily-batch.mjs:853` — `'Run <code>scripts\\login-once.cmd</code> to re-auth'` (Telegram message)
- `scripts/telegram-bot.mjs:723` — `'Run <code>scripts\\login-once.cmd</code> on the laptop to re-auth'`
- `scripts/telegram-bot.mjs:1092` — `'<code>cd %LOCALAPPDATA%\\automatic-munyun-machine; git stash; ...</code>'`
- `scripts/telegram-bot.mjs:1361` — `'Re-run <code>scripts\\setup-tasks.ps1</code> to bring it back'` (`/uninstall` pause confirmation)

All need a platform-aware string helper in v1.1.

### 1.5 Inno Setup as the only installer

- `installer/amm.iss` — single Windows installer, builds `amm-setup-vX.Y.Z.exe`. Inno Setup is Windows-only by design.
- v1.1 equivalents needed: `.dmg` for macOS (`hdiutil` + a templated `.app` bundle), `.deb` for Debian/Ubuntu (`dpkg-deb`), `.AppImage` for distro-agnostic Linux (`appimagetool`).
- The Inno Setup `[Run]` block (`amm.iss:57-69`) does `npm install && npx playwright install chromium`. That command is portable; the surrounding installer chrome is not.

### 1.6 Task Scheduler as the only scheduler

- `scripts/setup-tasks.ps1` is a single-source-of-truth that knows nothing else. It registers four entries:
  - `munyun-daily-batch` — weekly, scheduled days at scheduled time
  - `munyun-bot` — at logon, auto-restart on crash
  - `munyun-watchdog` — every 5 min, repetition trigger
  - `munyun-batch-missed` — weekly, scheduled-time + 1h
- The PowerShell idioms used (`New-ScheduledTaskAction`, `Register-ScheduledTask -Force`, `[System.DayOfWeek]` enum casting, `MultipleInstances IgnoreNew`) are 1:1 unmappable to launchctl/systemd, which have different concurrency semantics. Each platform port needs a fresh design (e.g. systemd `OnCalendar=` syntax, launchctl `StartCalendarInterval` dictionary).

---

## 2. Race Conditions and Concurrency Hazards

Three independent processes (bot, scrape, watchdog) share one filesystem. There is no IPC, no daemon, no lock manager. Every shared file is a potential race.

### 2.1 `fs.renameSync(tmp, CFG_PATH)` is NOT atomic on NTFS for rename-over-existing-file

POSIX guarantees `rename(2)` over an existing destination is atomic — readers see either the old file or the new file, never partial state. **NTFS does not.** Windows `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` is atomic only with respect to *crash-consistency* of the metadata, but a concurrent `open()` for read can fail with `ERROR_SHARING_VIOLATION` (EBUSY) if another handle holds the destination open.

| File:Line | Hazard |
|---|---|
| `scripts/config-rw.mjs:46-50` (`atomicWrite`) | If the bot's `cfgRW.set('user.salaryFloorUsd', X)` runs while a scrape is calling `readActiveConfig()` from `daily-batch.mjs:65`, the scrape can crash with `EBUSY` on the underlying read. Failure mode: the scrape throws, bot logs "❌ daily-batch failed: EBUSY: resource busy or locked, rename ..." |
| `scripts/profile-store.mjs:56-60` (`atomicWriteConfig`) | Same pattern, same caveat. Migrations + profile add/switch/delete all go through this. |
| `scripts/profile-store.mjs:90` (`fs.renameSync(oldPath, newPath)` during migration) | If the bot starts while migration is mid-flight (e.g. user has `munyun-bot` task running and manually invokes `node scripts/daily-batch.mjs`), the migration's `fs.renameSync` of `data/seen-jobs.json` → `data/profiles/default/seen-jobs.json` can race with whatever is reading the old path. |

**When does this bite?** Empirically rare because:
1. `config.json` writes from the bot are user-triggered (`/yoe`, `/skip`, etc.) and the scrape reads it once at process start.
2. The atomic-write pattern itself is fast (<5 ms for a ~3 KB file).
3. NTFS `MoveFileEx` *usually* succeeds even with readers, because it doesn't require an exclusive handle for the rename — but it's not guaranteed.

**When it bites hard:** during E5 migration. If the bot's `migrateIfNeeded()` runs while a scheduled scrape kicks off and *also* calls `migrateIfNeeded()`, you get a TOCTOU window where both think migration is needed → both try to rename `data/cv-parsed.json` to `data/profiles/default/cv-parsed.json` → second call gets ENOENT and silently swallows it (`profile-store.mjs:90` `try { ... } catch {}`). Not corrupting per se, but a v1.1 audit should add a file-lock advisory mechanism (e.g. `proper-lockfile`) for the migration block.

**Mitigation today:** none. Documented as "atomic" in the comments (`scripts/config-rw.mjs:6`, `scripts/profile-store.mjs:62`) which **overstates the actual guarantee on Windows**.

### 2.2 Bot ↔ scraper concurrent writes to per-profile state

Files written by both processes:
- `seen-jobs.json` — bot writes via `/forget last` (`telegram-bot.mjs:1167`); scrape writes via `saveSeenStore` (`daily-batch.mjs:638`). **Neither uses atomic temp-file + rename.** Both call `fs.writeFileSync` directly.
  - **Failure mode:** if bot's `/forget last` runs during the post-Telegram-success window of a scrape (`daily-batch.mjs:925`), one write clobbers the other. The user sees "✅ Forgot N jobs" and then minutes later the scrape silently re-records them.
- `query-stats.json` — only scrape writes (`daily-batch.mjs:387`); bot reads in `/diagnose` and `buildSupplyBanner`. Read-during-write produces JSON parse errors which are caught at `daily-batch.mjs:723` and logged silently. Same for `telegram-bot.mjs:539` (caught with empty `catch {}`).
- `applications.md` — bot appends from `/applied N` text command (`telegram-bot.mjs:764`) and from inline `[✅ Applied]` callback (`telegram-bot.mjs:1401`). Scrape only reads (`daily-batch.mjs:557` `loadAppliedHrefs`). Append-only reduces but does not eliminate races: `fs.appendFileSync` is not atomic across multiple writers, and a partial line could land mid-URL.
- `last-batch-callbacks.json` — only scrape writes (`callback-router.mjs:113`); bot reads on every callback dispatch (`callback-router.mjs:85`). Direct `writeFileSync` (no temp-file). Read-during-write returns null and the callback router responds "Invalid or stale button" to the user.
- `last-batch.json` — only scrape writes (`daily-batch.mjs:837`, direct `writeFileSync`); bot reads on `/why N`, `/status`, `/diagnose`, `[❓ Why]` callback. Same hazard as above.

**None of these use the atomic temp-file pattern that `config.json` uses.** At minimum, the same `tmp + rename` discipline should be applied to all per-profile files in v1.1.

### 2.3 Heartbeat write while watchdog reads — partial-write window

- Bot writes `data/heartbeat.json` every poll iteration via direct `fs.writeFileSync` (`telegram-bot.mjs:122`).
- Watchdog reads it via direct `fs.readFileSync` + `JSON.parse` (`watchdog.mjs:78`).
- The file is small (~150 bytes); writes complete in well under 1 ms.
- The watchdog runs every 5 min; the staleness threshold is 10 min (`watchdog.mjs:42`).
- The 10-min threshold is two orders of magnitude larger than any realistic write-ack time, so even a torn-read would just return null and the watchdog would treat it as "no heartbeat file" (`watchdog.mjs:140`) and skip — false negative, not a false-positive restart.
- **Mitigation:** the architecture is sound but the semantic is "we don't care because the threshold is huge." Document explicitly so a future contributor doesn't tighten the threshold to 30s and discover the race.

### 2.4 `last-batch-callbacks.json` rotation while a user clicks an old button

- The HMAC sig (`callback-router.mjs:44-50`) protects against acting on the wrong job: when the new batch rotates the callback table, an old idx may now point to a different job; the recomputed sig won't match and the callback is rejected with "this batch has expired" (`callback-router.mjs:74`, `telegram-bot.mjs:1313`).
- **The failure UX is poor.** The user taps `[💾 Save]` on a 6-day-old morning push and gets `"This batch has expired — run /scrape"` as a Telegram alert. The alert is correct but unsatisfying — there's no way to say "save anyway, the URL is still in the message body." The button-click is dead, and the only path forward is to run a fresh scrape.
- **Defense-in-depth observation:** the 7-day TTL (`callback-router.mjs:39`) is a soft bound; once the table rotates (next scrape), all old buttons are dead even if today is day 2.
- v1.1 could keep an append-only "callback archive" (last 30 days) so an old button degrades gracefully — but that's a UX feature, not a bug fix.

### 2.5 Browser-profile dir corruption from concurrent Playwright launches

- Both `daily-batch.mjs:188-203` (`launchBrowser`) and `daily-batch.mjs:678` (`resolveAll`'s second `launchBrowser` call) launch Playwright with the **same** `data/browser-profile/` dir.
- Within a single scrape run, the first `launchBrowser` returns its `ctx`, the code calls `await ctx.close()` at line 354, and the second call (resolution phase, line 678) opens a fresh `ctx`. Sequential — no overlap.
- **The hazard:** if a user runs `node scripts/daily-batch.mjs` manually on the laptop while the scheduled `munyun-daily-batch` task is also running, both Playwright contexts try to open the LevelDB lockfile in `data/browser-profile/Default/Local Storage/leveldb/LOCK`, and the second one fails with `Error: lockfile already held` (Playwright surfaces this).
- The bot's `runningJob` lock (`telegram-bot.mjs:248-294`) only covers bot-initiated scrapes. A Task-Scheduler-fired scrape racing with a bot-initiated `/scrape` is **not** prevented — `runningJob` lives in the bot process; Task Scheduler launches a separate `node` process. No cross-process lock exists.
- Empirical impact today: the scheduled task has `MultipleInstances IgnoreNew` (`setup-tasks.ps1:70`), so two scheduled instances can't collide. But scheduled-vs-manual is unguarded.
- **Mitigation:** none. Symptom is a hard error in one of the two scrapes; no data corruption, but the user sees "❌ daily-batch failed: lockfile held."

### 2.6 `runningJob` lock can drift from reality

`telegram-bot.mjs:286-293` — if the spawned `run-daily-batch.cmd` process is killed externally (Task Manager, system reboot mid-batch, watchdog restarting the bot), the bot's in-memory `runningJob` reference points to a dead child. The 5-minute force-clear timer (`telegram-bot.mjs:286`) catches this eventually but for up to 5 minutes the bot will refuse `/scrape` with "⏳ A scrape is already in progress."

---

## 3. Reliability Gaps

### 3.1 Watchdog cannot detect a hung scrape

`scripts/watchdog.mjs` watches *only* `data/heartbeat.json`, which is written by the bot's poll loop, not the scrape. If `daily-batch.mjs` hangs (Playwright stuck on a Cloudflare challenge that never resolves; a single `page.goto` blocked at `domcontentloaded` for an hour), the bot continues to poll Telegram and the heartbeat stays fresh. Watchdog says "healthy."

The 5-minute scrape timeout in `telegram-bot.mjs:250` (`SCRAPE_TIMEOUT_MS`) covers bot-initiated scrapes but **not Task-Scheduler-initiated ones**, which don't go through the bot. A scheduled scrape that hangs at 7 AM and never produces a TSV has no kill switch — it runs until Task Scheduler's `ExecutionTimeLimit (New-TimeSpan -Minutes 20)` expires (`setup-tasks.ps1:51`), at which point Windows force-kills it. 20 minutes of zombie Playwright on the user's laptop.

The `batch-missed-watcher.mjs` does eventually fire (1 hour after scheduled time, `setup-tasks.ps1:79`) and pings Telegram, but only 40 minutes after the 20-minute kill — total user-facing latency is up to 1h to learn the morning batch died.

### 3.2 No retry budget for hiring.cafe Cloudflare 403s

`daily-batch.mjs:212-227` (`checkBrowsable`) is the warmup gate. It tries 2 attempts of `page.goto` × 12 polls of 2 seconds each. If both attempts fail to render cards, the function throws `unauth` (line 241) and the scrape aborts cleanly with a Telegram message telling the user to run `login-once.cmd`.

What's missing:
- **No exponential backoff between attempts** — both retries fire back-to-back. If Cloudflare is throttling this IP, two attempts in 50 seconds make the situation worse.
- **No "wait an hour and retry" mode** for scheduled batches. If 7 AM hits during a Cloudflare incident, today is just gone.
- **No persistence of consecutive Cloudflare failures.** If 3 days in a row produce empty batches due to CF throttling, there's no signal to the user beyond the `/diagnose` "supply pipeline" view, and even that just shows "raw=0" with no causal label.

### 3.3 No circuit breaker for Telegram API outages

The bot's exponential backoff (`telegram-bot.mjs:1564` `BACKOFF_MS = [5000, 10000, 20000, 30000]`) caps at 30 seconds and **never gives up**. If Telegram is down for 6 hours, the bot polls 720 times and the log file grows ~720 lines of `poll error #N: fetch failed — backing off 30s`.

There's no "after N hours of consecutive failure, sleep for an hour" mode. There's no metric of "total seconds of outage today." There's no Telegram-independent alert path (the bot is the only thing that can ping Telegram, but it's the thing failing).

The watchdog *can* alert independently via `scripts/telegram-send.mjs` (`watchdog.mjs:85-96`), but it only fires when the heartbeat is stale — a polling-failure-but-process-alive bot will pass the watchdog check (heartbeat is updated even on poll failures, `telegram-bot.mjs:1608`).

### 3.4 GitHub rate limiting in `update-checker.mjs`

`update-checker.mjs:78-88` (`ghJson`) hits the GitHub API unauthenticated. GitHub's unauthenticated rate limit is **60 requests per IP per hour**.

- Cache TTL is 5 minutes (`update-checker.mjs:95`), so worst case is 12 calls/hour from a single bot.
- But the `/update check` command bypasses the cache (`telegram-bot.mjs:1063`).
- And the bot also does an initial check 5 seconds after startup (`telegram-bot.mjs:1547`) plus once every 24 hours (`telegram-bot.mjs:1548`). On a flap-restart loop (watchdog firing 3× per hour), each restart burns one cache miss.
- A user spamming `/update check` 60 times in an hour would 403 themselves out for the rest of the hour; subsequent `checkForUpdate` calls would silently return null (`update-checker.mjs:147`), and the user would see "⚠️ Could not reach GitHub" (`telegram-bot.mjs:1064`).

There's no explicit handling for HTTP 403 with `X-RateLimit-Remaining: 0`. The catch block treats it the same as a network error.

---

## 4. Security Hardening Gaps

### 4.1 HMAC sig is 8 hex chars (32 bits) — adequate but document the tradeoff

`callback-router.mjs:49` — sig is the first 8 hex chars (32 bits) of HMAC-SHA256(token, action+idx+url). This is **fine** for the actual threat model:

- Telegram callbacks come *only* from Telegram. An attacker cannot forge a `callback_query` update — the bot only sees them via authenticated `getUpdates`.
- An attacker who somehow injected a forged callback would need to know `TG_TOKEN` to compute a valid sig — at which point they own the bot already, and forging callbacks is the least of the user's problems.
- The actual purpose of the sig is **stale-callback rejection**: when the callback table rotates and idx 5 now points to a different job, the recomputed sig won't match, and the bot refuses to act on the wrong job.

For that purpose, 32 bits is plenty (2^32 ≈ 4 billion collisions; an idx is at most 100, so practical collision probability is astronomically low). **But the comment at `callback-router.mjs:14` calls it "our defense against stale callbacks" without naming the actual integrity property** ("acts as a checksum, not an auth token"). A passing security audit would flag the truncated HMAC as suspicious; the code reviewer needs context to understand why it's fine. **v1.1 doc fix: expand the comment to explicitly name the threat model and why 32 bits suffices.**

### 4.2 HTML escaping in Telegram replies — search results

All `parse_mode: 'HTML'` send sites in the bot use `escHtml()` (`telegram-bot.mjs:1504`) on user-controlled fields. The implementation is minimal — only `&`, `<`, `>` are escaped. This is correct for Telegram's HTML mode (which only recognizes a small subset of HTML tags). Telegram does **not** require quote/apostrophe escaping for text content.

**Verified safe sites** (user data is escaped):
- `telegram-bot.mjs:660, 672, 684, 693, 695` — profile slug echoes
- `telegram-bot.mjs:767, 882, 892, 903, 908` — company names, city names
- `telegram-bot.mjs:938, 948, 968, 983` — query terms, role suggestions
- `telegram-bot.mjs:1011-1016` — `/why N` job title, company, matched keywords
- `telegram-bot.mjs:1078, 1101, 1146` — release notes, npm output, error messages
- `telegram-bot.mjs:1191-1195` — batch browser job rendering
- `telegram-bot.mjs:1257, 1291` — `/history` and `/saved` URL rendering
- `telegram-bot.mjs:1391-1407, 1421-1435` — callback action confirmations
- `telegram-bot.mjs:1500` — resume upload error fallback

**Suspicious sites** (data passes through `escHtml` but the URL is interpolated into an `href=`, where Telegram's HTML mode does NOT escape `"` automatically):
- `telegram-bot.mjs:1018` — `<a href="${job.directUrl || job.viewjobUrl}">` — the URL is **not** wrapped in `escHtml`. If a malicious hiring.cafe response embedded `"` or `>` in the apply_url, the `href=` attribute could be broken out of. Practical risk: low (URLs come from `daily-batch.mjs::resolveOnePage`, which extracts via regex `"apply_url":"([^"]+)"` so embedded `"` in the URL would terminate the regex match early — but the `directUrl` field IS user-influencable via the source HTML).
- `telegram-bot.mjs:1194-1195` — `<a href="${escHtml(item.directUrl)}">` — escHtml DOES run, but escHtml only escapes `&<>` not `"`. If `item.directUrl` contains `"`, it will close the attribute. Same hazard.
- `telegram-bot.mjs:1257, 1291` — same `<a href="${escHtml(e.url)}">` pattern in `/history` and `/saved`.
- `telegram-bot.mjs:756` (`daily-batch.mjs:756`) — `<a href="${url}">` in `buildMessage`. URL is not run through `escHtml`. Source: `directUrls[i] || r.href`, where `r.href` comes from hiring.cafe DOM `a.href` and `directUrls[i]` from the `apply_url` regex.

**v1.1 fix:** the escHtml utility should also escape `"` for use inside attribute values, OR a separate `escHtmlAttr` helper should be added and applied to all `href=` interpolations.

### 4.3 Token leakage scan — `console.log` and `log()` calls

Searched for paths where `TG_TOKEN` could leak via log/error:

- **`scripts/setup-wizard.mjs:100`** — `fetch('https://api.telegram.org/bot${tok}/getMe')`. Errors caught at line 108 are surfaced as `console.log(fail('Network error: ' + e.message))`. If Node's fetch error message includes the URL (it does on some failures), the token would print to stdout and end up in any wizard transcript / Telegram-attached log. **MEDIUM RISK** — wizard runs once, output is interactive, but a screen-recording tutorial could expose it.
- **`scripts/daily-batch.mjs:78-81`** — `log()` writes to `data/daily-batch-{date}.log`. Token is interpolated into Telegram URLs at lines 86, 102 but never directly logged. Throw at line 92 `'Telegram error: ' + JSON.stringify(json)` — `json` from Telegram's response doesn't contain the token (Telegram echoes back `{ok: true, result: ...}`). **LOW RISK.**
- **`scripts/telegram-bot.mjs:106, 110`** — `unhandledRejection` and `uncaughtException` handlers explicitly do `raw.replace(TG_TOKEN, '<TOKEN>')` before logging. **MITIGATED.**
- **`scripts/telegram-bot.mjs:157, 171`** — `tgPost` and `tgSendDocument` log `JSON.stringify(j).slice(0, 300)` of failure responses. Telegram's failure response object never contains the token. **LOW RISK.**
- **`scripts/telegram-bot.mjs:1465`** — File-download URL is built inline and explicitly NOT logged: `// Build the download URL inline; never log or surface this string — it contains TG_TOKEN`. **MITIGATED — but only by convention.** If a future contributor adds `log('Downloading: ' + downloadUrl)` here, the token leaks. There is no automated check to catch this regression.
- **`scripts/telegram-bot.mjs:1471, 1498`** — `String(netErr.message).replace(TG_TOKEN, '<TOKEN>')` before logging. **MITIGATED.**
- **`scripts/telegram-send.mjs:17, 19`** — Reads `env.TELEGRAM_BOT_TOKEN`, errors out if missing; if env is malformed the error message is a static string, no token leak. **LOW RISK.**

**Net assessment:** the bot is well-defended. The wizard's `step1Token` error path (setup-wizard.mjs:108) is the one practical leak vector and should get the same `.replace(tok, '<TOKEN>')` treatment in v1.1.

### 4.4 File permissions: `data/` and `config.json` are world-readable

The repo lives at `%LOCALAPPDATA%\automatic-munyun-machine` (Inno Setup default, `installer/amm.iss:22`). On a single-user Windows machine, this is fine — `%LOCALAPPDATA%` is per-user.

**On a multi-user Windows machine** (shared family laptop, lab computer, kiosk mode), `%LOCALAPPDATA%` is per-user but **`C:\Users\<other>\AppData\Local\automatic-munyun-machine` is readable by Administrators by default**. Anyone with admin rights can read another user's:
- `cv.md` / `cv.pdf` — entire resume
- `data/cv-parsed.json` — parsed CV JSON
- `data/profiles/<slug>/applications.md` — every job applied to (employment intent)
- `.env` — Telegram bot token

There are no ACL hardening calls (`icacls` invocations) in `setup-wizard.mjs` or `setup-tasks.ps1`.

**v1.1 status:** likely out of scope. AMM targets non-technical solo users on personal laptops. Documenting here so an enterprise rollout (if it ever happens) doesn't pretend this is solved.

### 4.5 `.env` is plaintext on disk

Standard for the ecosystem; not a concern unique to AMM. Listed here only for completeness — any tool that handles a Telegram bot token has the same exposure surface.

---

## 5. Testing Gaps (headline only — full audit in QUALITY.md)

24 tests across 4 files in `scripts/__tests__/`:
- `salary.test.mjs` — `parseSalaryK` with 10 fixture cases
- `phrase-proximity.test.mjs` — `scoreJob` partial matching
- `role-cluster.test.mjs` — cluster-aware scoring
- `profile-store.test.mjs` — multi-profile CRUD + migration

**Critical paths with NO automated test:**

1. **HMAC sig generation + verification** (`callback-router.mjs:44-91`). The action that protects against stale-callback misfires has zero coverage. A regression in `makeCallback` or `parseAndVerify` ships unnoticed.
2. **Watchdog restart logic** (`watchdog.mjs:133-191`). The throttling, give-up, and Telegram-alert paths are untested. A bug in `pruneRestarts` could let the bot restart 1000×/hour silently.
3. **Cloudflare warmup** (`daily-batch.mjs:212-227` `checkBrowsable`). No headless test of the gate. A regression that makes `checkBrowsable` always return true would silently produce empty batches with `auth=ok`.
4. **Atomic config writes under contention**. No test simulates the "bot writes config + scrape reads config" race. The atomicity claim in the comment is unverified.
5. **`/why N` JSON parsing** (`telegram-bot.mjs:1006-1024`). If `last-batch.json` schema drifts again (it has, twice), `/why` silently fails with "❌ No batch data on disk."
6. **GitHub release detection** (`update-checker.mjs:97-149`). The fall-through from `/releases` to `/tags` is untested. A repo with neither would behave...how exactly? Returns null, becomes "⚠️ Could not reach GitHub" — but the path isn't exercised.
7. **Resume parser shape validation** (`telegram-bot.mjs:1482-1485`). If `parseResume` returns malformed data, the validator throws — but the validator itself has no test coverage.
8. **Profile migration idempotence under partial state**. `profile-store.mjs:63-94` is supposed to be idempotent; the existing profile-store test covers the happy path but not "config.json migrated, but data files only half-moved" (e.g. the user killed the process mid-migration last time).

---

## 6. UX Deferrals from v1.0

These are explicit "we know it's missing" items, not bugs.

| Deferral | Source | Why deferred |
|---|---|---|
| **No GUI** | Plan: `~/.claude/plans/wonderful-now-time-to-quirky-pizza.md` line 178; `CONTEXT.md:178` "Tauri desktop GUI cut from roadmap entirely" | Telegram-first thesis won; Tauri added a dependency tree the size of the rest of the codebase. Permanent decision. |
| **No bulk-import/export of jobs** | Observed in `telegram-bot.mjs` command surface — no `/import`, no JSON dump | Out of scope for v1.0 milestone |
| **No proactive "stuck on Cloudflare" warning** | `daily-batch.mjs:239-243` aborts silently with a one-time Telegram message; no recurring nag | Cut for time |
| **No way to pause batches without uninstalling**... wait, there is: `/pause` exists (`telegram-bot.mjs:727`). Replace this row with: **No way to pause for a fixed duration** ("/pause for 2 weeks, auto-resume"). | `telegram-bot.mjs:727-738` only does on/off | Cut for v1.0 |
| **No undo for `/wipe`** | `/uninstall` mode=wipe (`telegram-bot.mjs:1359`) gives a confirm button but no recovery after. Bot exits, files delete, no rollback. | Acceptable risk — confirmation buttons cover the worst case |
| **No `/undo` for `/forget all` or `/forget last`** | `telegram-bot.mjs:1027, 1151` permanently delete state. No backup is taken before the delete. | Cut |
| **No salary database** | `CHANGELOG.md` Unreleased; v1.2 roadmap | Wide-scope feature |
| **No application-status tracking** beyond append-only `applications.md` (no "rejected", "interviewed", "offer") | `telegram-bot.mjs:1397-1407` `/applied` only writes the URL + date | Out of scope |
| **No "all-day" mode** for the bot to act on multiple Telegrams concurrently | Single `runningJob` global lock (`telegram-bot.mjs:248`) | Single-user thesis |
| **No way to download all `applications.md` history as one file** (only paginated `/history`) | `telegram-bot.mjs:1235` | Easy v1.1 add |
| **No interactive "first batch" tutorial** after wizard finishes | `setup-wizard.mjs:402-413` sends a single `/scrape` nudge | Cut |
| **No /resume preview** before committing | `telegram-bot.mjs:1481-1495` parses + commits in one step | Cut |
| **No way to A/B test scoring weights** | `cfgRW.set('scoring.titleWeight', N)` exists but no UI in /settings | Power-user only |

---

## 7. Documentation Drift Risk

Code says one thing, docs say another. Not fixing — flagging for v1.1.

### 7.1 `daily-batch.mjs` header comment is wrong

`scripts/daily-batch.mjs:3-13` claims:
- "Connects to your already-running Chrome via CDP (port 9222)" — **FALSE.** v0.2 pivoted away from CDP to Playwright persistent profile (`CONTEXT.md:201`).
- "Pulls Miami weather from open-meteo" — **FALSE.** `getWeather` (line 126) reads `CFG.weather` (lat/lon/city are user-configurable since v0.3).
- "Runs 7 hiring.cafe searches" — **FALSE.** Default is 3 (line 142); user adds queries via `/jobs add`. Default `config.example.json` has 16 queries (`CONTEXT.md` v1.0 post-release log).

### 7.2 `/diagnose` mentions a v1.0 E3 feature that already shipped

`telegram-bot.mjs:532` — diagnose output says `<i>Freshness window (60-day decay) lands in v1.0 E3 — until then, /forget all wipes the list.</i>` — but E3 shipped (CHANGELOG `[1.0.0]` v1.0 E3 section, line 73-86). The comment is stale.

### 7.3 `seen.ids` legacy schema reference

`telegram-bot.mjs:529` — `if (seen?.ids) { lines.push(\`Total: ${seen.ids.length} jobs\`); ... }` — the old v0.x schema is still being read here even though E3 migrated to `seen.jobs`. The new path is implemented at `telegram-bot.mjs:793` for `/settings`. `/diagnose` was missed in the schema migration. Users on v1.0 will see "0 jobs / empty" when they have thousands.

### 7.4 README mentions Miami weather as if it's hardcoded

`README.md:3` — `"Wake up to your morning coffee, the Miami weather, ..."` — was true in v0.1, false since v0.3. Implies Miami is special; it's just the default for the example config.

### 7.5 README install-one-liner pulls main HEAD

If a user with v0.5 runs the install one-liner `iwr ... main/install.ps1 | iex`, they get v1.0 — fine. But the **`install.ps1` itself** is not version-pinned; an evolving installer can break older clones. Documented today as "the install one-liner clones from main" (`CLAUDE.md:64`); fine but worth checking on every release.

### 7.6 `CLAUDE.md:60` says "leave that migration block alone until v1.x"

We're now in v1.x (`package.json:3` is `1.0.0`). The `career-ops-*` migration block in `setup-tasks.ps1:40-46` is technically eligible for removal, but no plan does it. v1.1 should either remove it explicitly or update CLAUDE.md to "until v2.x."

---

## 8. Tech Debt Carried Forward

### 8.1 `setup-tasks.ps1` `career-ops-*` migration block

`scripts/setup-tasks.ps1:40-46`:

```powershell
foreach ($oldName in @('career-ops-daily-batch','career-ops-bot')) {
  if (Get-ScheduledTask -TaskName $oldName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $oldName -Confirm:$false
    ...
  }
}
```

`CLAUDE.md:60` explicitly says **"leave that migration block alone until v1.x"** — and we are in v1.x now. The block is a no-op on fresh installs (no legacy entries exist), so it costs ~50 ms per `setup-tasks.ps1` run. v1.1 cleanup target: remove or relabel.

### 8.2 No other "// TODO" / "// HACK" / "// FIXME" comments

A grep for `TODO|FIXME|HACK|XXX` in `scripts/**/*.{mjs,ps1,cmd,iss}` returns **zero matches** (only false-positive on `daily-batch.mjs:453` which is a regex comment about k/K letters). The codebase is unusually clean of self-flagged debt — but that's not the same as actually being clean. The debt is in the architecture choices documented in §1-§4 above, not in inline comments.

### 8.3 `daily-batch.mjs` header comment is ~3 versions out of date

Already covered in §7.1. The opportunity cost: a fresh contributor reading the file top-to-bottom learns about CDP / Miami / 7 queries before discovering they're all wrong. Listed as tech debt because the fix is a 5-minute comment rewrite.

### 8.4 `daily-batch.mjs` is 963 lines in a single file

The IIFE at `daily-batch.mjs:843-963` mixes:
- env validation
- scrape orchestration
- filter / dedup
- scoring (already extracted as exports for testability)
- Telegram chunked send
- attachment send
- callback table write
- CTA send
- error path

Splitting this into `scrape.mjs`, `score.mjs` (already partial), `telegram.mjs`, `pipeline.mjs` would help the v1.1 platform port (the Mac/Linux-specific bits are concentrated, but the rest of the engine is portable).

### 8.5 Bot dispatcher is a 600-line if/else chain

`telegram-bot.mjs:566-1175` — `handleMessage` is a flat sequence of regex tests. No command-table abstraction. Adding a 30th command (or migrating the whole table to e.g. a `/help`-discoverable command map) means surgery on the whole function.

### 8.6 Multiple "I will get to this" comments in code

Searches for "for now", "temporary", "until we", "eventually" in scripts return:

- `scripts/uninstall.mjs:113` — "Install dir at ${ROOT} is preserved (delete by hand if you want to remove the code too)" — accepted limitation, not debt.
- `scripts/uninstall.mjs:117` — "data/ ... preserved. Re-run \`...setup-tasks.ps1\` to bring it back" — same.
- Numerous `// v1.0 E3:` / `// v1.0 E5:` / `// v1.0.x:` markers — these are version-tagged comments documenting *what* was added when. Not debt; archeology.

---

## 9. Deferred Items From v1.0 Cut List

Source: `~/.claude/plans/wonderful-now-time-to-quirky-pizza.md` ("Tentative v1.1 phases" + roadmap in `CONTEXT.md:177-178`).

| Item | Why cut from v1.0 | Where v1.1 should pick it up |
|---|---|---|
| **Mac launchd port** | "Trustworthy and shareable on Windows" was the v1.0 thesis; macOS is a 6th platform of work | Phase 3 of v1.1 plan: `setup-tasks-mac.sh` (LaunchAgent plist gen), `.sh` wrappers replacing `.cmd`, `osascript`-based file picker |
| **Linux systemd port** | Same | Phase 4: `setup-tasks-linux.sh` (systemd user units), `zenity`/`kdialog` file picker |
| **Code signing** | Cert acquisition + renewal is its own rabbit hole; Inno Setup `.exe` ships unsigned in v1.0 | Phase 5: code-sign Windows `.exe` (Microsoft Trusted Signing or DigiCert), notarize `.dmg` for Apple Gatekeeper |
| **Scam detection** | Out of scope for v1.0; needs a labeled corpus and a small classifier | v1.2 — independent of platform port |
| **Salary database** | Wide-scope feature; needs scraping infrastructure beyond hiring.cafe | v1.2 |
| **Embeddings / semantic match** | LLM cost + latency; v1.0 E3 cheap-wins (phrase-proximity, role-cluster) closed most of the gap | v2.0 — re-evaluate after v1.1 ships and we see whether scoring complaints persist |
| **Cross-platform installers** (`.dmg`, `.deb`, `.AppImage`) | Each is a separate toolchain | Phase 6: GitHub Actions matrix (windows-latest / macos-latest / ubuntu-latest), per-platform installer build artifacts on tag push |
| **CI / GitHub Actions** | No tests existed pre-v1.0 E3; matrix didn't make sense | Phase 6 (paired with installer matrix) |
| **Tauri GUI** | **PERMANENTLY CUT** — contradicts Telegram-first thesis | Never — see `CONTEXT.md:178` |

---

## 10. Observability Gaps

### 10.1 No structured logging

Every `log()` call writes plain text strings:
- `daily-batch.mjs:79` — `[${stamp}] ${line}` to `data/daily-batch-{date}.log`
- `telegram-bot.mjs:91` — same to `data/telegram-bot.log`
- `watchdog.mjs:46` — same to `data/watchdog.log`

There is no JSON structure, no level (info/warn/error), no trace ID, no machine-parseable filter. To debug "why was last Tuesday's batch only 12 jobs," a human reads three log files in three different formats and correlates by timestamp. There is no `grep` query that gets the answer programmatically.

### 10.2 No metrics

`data/last-batch.json` records the funnel for the *most recent* batch. `data/query-stats.json` records 7-day per-query supply. **There is no:**
- Count of scrapes per day / per week / per month
- Average matches per scrape over time
- Distribution of `matchPct` over time (have scoring tweaks helped?)
- Callback latency (taps per day, callback dispatch time)
- Resume parse failures over time
- Cloudflare warmup duration distribution
- Watchdog restart frequency (`watchdog-state.json` keeps a 1-hour rolling window only)

A future "is the bot getting better at picking jobs?" question is unanswerable.

### 10.3 No alerting beyond "bot dead"

Watchdog pings Telegram if the heartbeat is stale (`watchdog.mjs:185-188`) or after 3 restart attempts in an hour (`watchdog.mjs:163`). That's the entire alert surface.

There are NO alerts for:
- "Cloudflare 403'd 3 days in a row"
- "Resume hasn't been re-parsed in 90 days"
- "Match floor is at 0% — you're getting filler"
- "GitHub rate-limited the update checker"
- "All 16 queries returned 0 cards today"
- "TG_TOKEN appears to be revoked (401 from Telegram)"

### 10.4 No way to ask the bot "how's the last week looked?"

`/diagnose` shows the last batch's funnel and per-query 7-day averages. There is no:
- `/history week` — totals across the last 7 days
- `/health` — comprehensive snapshot beyond `/status`
- `/trend` — match-quality distribution over time
- `/audit` — list of times the watchdog had to restart, with reasons

### 10.5 Logs are date-rolled but never compacted or rotated by size

`daily-batch-2026-05-07.log` exists for every day a scrape ran. After 1 year of daily runs, that's 365 files in `data/`. There's no `logrotate`-equivalent. `/uninstall mode=wipe` deletes `data/` wholesale; otherwise users accumulate logs forever.

### 10.6 Stale data files in `data/`

Glob of `data/*.tsv` and `data/*.md` shows files like:
- `data/today-batch-2026-05-02.md`
- `data/today-batch-resolved.tsv`
- `data/today-batch-ids-2026-05-02-v2.txt`
- `data/today-batch-resolve.sh`
- `data/today-batch-final-2026-05-02.tsv`
- `data/daily-targets-2026-05-02.csv`
- `data/apply-targets.csv`
- `data/scan-history.tsv`

These are pre-v0.2 artifacts (v0.2 standardized on `today-batch-{date}.tsv` and per-profile dirs). They have no consumers in the current codebase but are not gitignored so they may persist on dev machines. Cleanup-task candidate, low priority.

---

## Summary

**Volume:** ~10 categories, 50+ enumerated concerns, ~30 actionable v1.1 items.

**Highest-impact v1.1 priorities (extracted from above):**

1. **Path/spawn abstraction layer** — every file in `scripts/*.mjs` that spawns an OS binary needs a `os-paths.mjs` helper before Mac/Linux ports can land. This is §1.1 + §1.2 + §1.3.
2. **Genuinely atomic config writes** — `proper-lockfile` or equivalent advisory locking; document the NTFS truth honestly (§2.1).
3. **Apply atomic-write pattern to all per-profile JSON files** (`seen-jobs.json`, `last-batch.json`, `last-batch-callbacks.json`, `query-stats.json`) — currently only `config.json` uses the temp+rename pattern (§2.2).
4. **HTML-attribute escaping** — current `escHtml` only escapes `&<>`, but Telegram's `href="..."` interpolations are vulnerable to `"` (§4.2).
5. **Hung-scrape watchdog** — extend watchdog to detect a stuck `daily-batch.mjs`, not just a stuck bot (§3.1).
6. **Cloudflare retry budget** — exponential backoff between attempts; persistent failure counter (§3.2).
7. **Stale `seen.ids` reference in `/diagnose`** — schema-aware fix matching `/settings` and `/forget last` (§7.3).
8. **Wizard token-leak defense** — `setup-wizard.mjs:108` should `.replace(tok, '<TOKEN>')` like the bot does (§4.3).
9. **Doc rewrites** — `daily-batch.mjs:3-13` header, README Miami line, CLAUDE.md "until v1.x" sentinel (§7.1, §7.4, §7.6).
10. **Remove `career-ops-*` migration block** — guarded by `CLAUDE.md` note that says "until v1.x" (§8.1).

**Items deferred to v1.2 or later:** scam detection, salary database, embeddings, multi-user support, structured logging, CI metrics dashboard.

**Items permanently cut:** Tauri GUI.

---

*Concerns audit: 2026-05-07 — AMM v1.0.0 → v1.1 prep*
