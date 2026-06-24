# Automatic Munyun Machine (AMM)

> Every weekday morning, 100 jobs sorted by how well they match your CV — in a clean desktop dashboard, with one-click apply. Optionally pushed to your phone over Telegram too. Runs on Windows, macOS, and Linux.

## What it does

- **Daily 100-job batch.** Scrapes hiring.cafe across as many search queries as you configure (default ships with 16; add more with the dashboard or `/jobs add`).
- **CV-aware ranking.** Parses your resume, scores each job by keyword overlap, sorts top→bottom by match %.
- **Filters out the noise.** Drops manager/principal/director/sales-engineer titles, government clearance roles, jobs above your YOE limit, companies you've blacklisted.
- **Desktop dashboard (primary).** A local control surface in your browser — see the ranked batch, open jobs to apply, and click **Scrape now** for a fresh batch. Opened from the system-tray icon, which also shows real-time health (green/yellow/red).
- **Telegram (optional, since v2.1).** Want batches on your phone too? Turn Telegram on right from the dashboard — paste a bot token, connect your chat, done. Skip it and AMM is a pure desktop app; no bot token needed. When on, you also get `/scrape`, `/save N`, `/applied N`, `/reauth`, `/pause` from your phone.
- **Downloadable .txt batch.** `jobs(YYYY-MM-DD).txt` is written every run — search-friendly, archivable. Sent to Telegram too when it's enabled, or pulled anytime via `/export`.
- **Local-first.** Everything runs on your machine. Nothing leaves your computer except (if you enable it) the Telegram messages.

## Install

### Option 1 — Native installer (recommended for non-developers)

Grab the platform-appropriate artifact from the [latest GitHub release](https://github.com/7ustoo/automatic-munyun-machine/releases/latest):

| Platform | Artifact | Verify |
|---|---|---|
| Windows | `amm-setup-vX.Y.Z.exe` | Right-click → Properties → Digital Signatures (signed via Microsoft Trusted Signing when available) |
| macOS | `amm-vX.Y.Z.dmg` | `spctl --assess --type install <amm.dmg>` (notarized via Apple Developer ID when available) |
| Linux (Debian/Ubuntu) | `amm_X.Y.Z_all.deb` | `dpkg-sig --verify` against `keys/amm-release.gpg` |
| Linux (any distro) | `amm-vX.Y.Z-x86_64.AppImage` | `gpg --verify amm-vX.Y.Z-x86_64.AppImage.sig amm-vX.Y.Z-x86_64.AppImage` |

Download, double-click (or `sudo dpkg -i amm_X.Y.Z_all.deb` on Linux), follow the wizard.

> If signing keys aren't configured for a release, artifacts ship unsigned. Windows SmartScreen says "Unknown Publisher" → *More info* → *Run anyway*. macOS Gatekeeper says "unverified developer" → right-click → Open. Functionality is identical.

### Option 2 — One-line install

**Windows (PowerShell):**
```powershell
iwr -useb https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.ps1 | iex
```

**macOS / Linux (bash):**
```bash
curl -fsSL https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.sh | bash
```

Both:
1. Install Node.js + Git (via winget / brew / apt / dnf) if missing
2. Clone the repo to the platform-appropriate dir (`%LOCALAPPDATA%\automatic-munyun-machine\` on Windows, `~/Library/Application Support/automatic-munyun-machine/` on macOS, `~/.local/share/automatic-munyun-machine/` on Linux)
3. Install npm deps. Since v2.0.1 AMM drives your installed Chrome/Edge (with its own private profile) — the ~150 MB Playwright Chromium download only happens if you have neither.
4. Launch the interactive setup wizard

### Option 3 — Manual install

```bash
git clone https://github.com/7ustoo/automatic-munyun-machine.git
cd automatic-munyun-machine
npm install
npx playwright install chromium   # only needed if you have neither Chrome nor Edge installed
node scripts/setup-wizard.mjs
```

## Setup wizard — ~3 minutes

1. **Telegram phone notifications (optional).** Default is **no** — AMM is desktop-first, so you can skip the @BotFather token entirely and use the dashboard. Say yes only if you also want batches pushed to your phone (you can also turn it on later from the dashboard's Telegram panel).
2. **Chat ID.** *(only if you opted into Telegram)* Send any message to your bot, wizard auto-detects your chat ID.
3. **hiring.cafe login.** Browser opens, you sign in with Google once. Session persists.
4. **Resume.** Three options:
   - **Pick from disk** *(default)* — opens a Windows file picker dialog. Click your PDF / DOCX / MD resume.
   - **Upload via Telegram later** — skip the wizard step, send `/resume` to the bot once setup finishes and attach your CV.
   - **Type the path manually** — fallback for headless installs or weird environments.
5. **Auto-suggested search terms.** Pick a search style — full job titles ("IAM Engineer", precise) or short keywords ("iam", "m365", "linux" — broader nets, the CV-match ranking does the filtering) — then the wizard reads your CV and proposes 10-12 terms. Accept all, pick a subset, or keep defaults. Switch styles anytime with `/jobs mode`. (Skipped if you uploaded later — defaults apply until you run `/jobs suggest` post-upload.)
6. **Years of experience.** Max YOE you'd accept on a job listing.
7. **Salary floor.** Used for ranking (bonus above floor, penalty below).
8. **Clearance filter.** Toggle on/off — drop or include gov clearance jobs.
9. **Your city.** Auto-geocoded for the morning weather report.
10. **Schedule + finalize.** Pick time + days. Wizard registers the scheduler, starts AMM (the tray app), and confirms it's running. Open the dashboard from the tray menu and click **Scrape now** for your first batch. (If you connected Telegram, you also get a ✅ ping there.)

## Desktop dashboard

The tray icon's **Open dashboard** opens a local page (`127.0.0.1`, your machine only) where you:

- see today's ranked batch and open any job to apply,
- click **Scrape now** to pull a fresh batch on demand,
- turn **Telegram** on or off — the panel walks you through pasting a bot token, connecting your chat, and enabling phone notifications, with a one-click Disable later.

It's the primary way to use AMM; Telegram is an optional notification channel layered on top.

After setup, the bot runs in the background and delivers a batch every weekday morning. Every wizard answer is later editable from your phone via Telegram commands.

## Telegram commands

### Core actions
| Command | Action |
|---|---|
| `/scrape`, `/daily`, `gm`, `morning` | Run a fresh batch now (1-2 min). Run as often as you want. |
| `/save N` | Bookmark job #N on hiring.cafe |
| `/applied N` | Mark applied (also logs to applications.md) |
| `/why N` | Explain why job #N got its match % |
| `/export` | Download today's batch as a `jobs(YYYY-MM-DD).txt` file. Falls back to the most recent dated file if today's batch hasn't run. |

### Settings — edit from your phone (NEW in v0.3)
| Command | Action |
|---|---|
| `/settings` | Show current config in one message |
| `/resume` | Upload a new resume (PDF/DOCX/MD); bot re-parses skills |
| `/jobs` | List current search titles |
| `/jobs add "term"` | Add a search term (a job title or a keyword) |
| `/jobs remove "term"` | Remove a search term |
| `/jobs suggest` | Bot reads your CV and proposes new search terms |
| `/jobs mode titles\|keywords` | What `/jobs suggest` proposes: full job titles ("IAM Engineer") or short keywords ("iam", "m365", "linux") |
| `/yoe N` | Set max years of experience |
| `/salary N` | Set salary floor in $K (e.g. `/salary 120`) |
| `/clearance on/off` | Toggle gov clearance filter |
| `/forms all\|simple\|long` | Application form filter — `all` (default), `simple` (Easy Apply, no account needed), `long` (multi-step apps only) |
| `/skip <company>` | Never show this company again |
| `/unskip <company>` | Reverse it |
| `/city <name>` | Change weather city (auto-geocoded) |
| `/schedule HH:MM` | Change daily push time |

### Maintenance
| Command | Action |
|---|---|
| `/auth` | Verify hiring.cafe login |
| `/reauth` | Trigger re-login on your computer |
| `/pause` | Stop the daily 7am push |
| `/resume-bot` | Re-enable the daily 7am push |
| `/forget all` | Wipe seen-jobs memory |
| `/forget last` | Un-memorize the most recent batch |
| `/cancel` | Cancel a multi-step interaction |
| `/weather` | Just the weather |
| `/version` | Show running version + latest on GitHub |
| `/update` | Pull latest from GitHub + restart bot |
| `/update skip` | Don't notify about the current latest version |
| `/update check` | Re-check GitHub for a newer version |
| `/update notes` | Show release notes for the latest version |
| `/test`, `/ping` | Bot health check |
| `/help` | Show this list |

## Local dashboard (NEW in v1.3)

The tray menu has an **Open dashboard** item that pops a small status page in your default browser. It shows:

- Bot state (alive / stale / dead) + uptime + PID
- Telegram connection (last poll OK + consecutive failure count)
- Active profile + all profiles
- Last batch summary — date, job count, and the top 10 jobs with company / query / match % and a direct-apply link

The dashboard binds to `127.0.0.1` on an OS-assigned port — it is **not reachable from the LAN or the internet**. The page auto-refreshes every 5 seconds. Telegram remains the primary surface; the dashboard is a glance for moments when you're at your desk.

## Customize

All settings live in `config.json` (created from `config.example.json` by the wizard). Edit at any time and the next run picks up changes:

- **Search queries** — what hiring.cafe searches the bot runs
- **Filters** — companies to skip, title patterns to drop, clearance toggle
- **Scoring weights** — how much titles/certs/skills/compliance count
- **Weather** — your city's lat/lon
- **Schedule** — time + days

## Data files

| File | Purpose |
|---|---|
| `.env` | Telegram credentials (gitignored) |
| `config.json` | User config (gitignored) |
| `data/cv-parsed.json` | Parsed resume keywords (gitignored) |
| `data/cv.md` | Markdown copy of resume (gitignored) |
| `data/seen-jobs.json` | Local memory of jobs already surfaced (gitignored) |
| `data/applications.md` | Application log (gitignored) |
| `data/browser-profile/` | Playwright Chromium profile with hiring.cafe session (gitignored) |
| `data/auth-state.json` | Last successful auth timestamp |
| `data/today-batch-{date}.tsv` | Each day's batch as TSV (machine-readable) |
| `data/jobs({date}).txt` | Each day's batch as plain text (human-readable, sent as Telegram attachment) |
| `data/daily-batch-{date}.log` | Per-run log |
| `data/telegram-bot.log` | Bot poll log |

Everything sensitive is gitignored — your token, session cookies, resume, application history all stay local.

## Privacy

- **Nothing is uploaded.** The only outbound traffic: hiring.cafe (job listings), open-meteo (weather, no API key needed), Telegram (your bot token + chat). Nothing else.
- **No telemetry.** AMM does not collect, send, or aggregate any usage data.
- **No third-party APIs.** No OpenAI, no Anthropic, no embedding services. Pure local keyword scoring.

## Cost

**$0 / month.** Telegram is free. open-meteo is free. Playwright is free. Hiring.cafe scraping uses your own bandwidth.

## Architecture

```
                  ┌─────────────────┐
                  │  config.json    │  ← user-editable
                  │  cv-parsed.json │
                  └─────────────────┘
                          │
                          ▼
   ┌─────────────────────────────────────────┐
   │     scripts/daily-batch.mjs              │
   │     (Playwright + scoring + Telegram)    │
   └─────────────────────────────────────────┘
        ▲                          │
        │                          ▼
   ┌──────────┐            ┌────────────────┐
   │ Task     │            │ Telegram API   │
   │ Scheduler│            └────────────────┘
   │ 7am      │
   └──────────┘            ┌────────────────┐
                           │ telegram-bot   │ ← polls for /daily,
                           │     .mjs       │   /save, /applied,
                           └────────────────┘   /reauth, etc.
                                  ▲
                                  │
                              Your phone
```

Three independent processes, all reading/writing one shared filesystem. No server, no cloud, no external state.

## Requirements

- Windows 10 / 11, macOS 14+ (Sonoma), or any reasonably modern Linux (Ubuntu 22.04+, Fedora 40+, etc.)
- ~150 MB disk (v2.0.1 uses your installed Chrome/Edge; ~500 MB only if neither exists and Playwright's Chromium gets downloaded)
- Always-on machine for the 7am push (or use `/daily` on demand)
- A Telegram account
- A hiring.cafe account (free; sign in via Google)

## Roadmap

- ✅ **v0.2–v0.5** — Setup wizard, 30+ bot commands, smart resume parsing, downloadable `.txt` batch, native file picker, `/update` + `/version`, transient-outage resilience.
- ✅ **v1.0** — Multi-profile support, inline callback buttons + HMAC sig replay defense, phrase-proximity + role-cluster scoring, out-of-process watchdog, Inno Setup installer, Cloudflare-bypass scraping (no hiring.cafe auth required), pagination + target-driven cross-query early stop.
- ✅ **v1.1** — **Cross-platform.** macOS (launchd) + Linux (systemd) ports, unified `install.sh`, native file pickers (osascript / zenity / kdialog), `os-paths.mjs` abstraction layer, atomic IO via `proper-lockfile`, `.dmg` / `.deb` / `.AppImage` builders, GitHub Actions CI matrix, code signing scripts. Plus 9 HIGH bug fixes from the v1.0 code review and 41 new unit tests (24 → 65 total).
- ✅ **v1.2** — **AMM as a real app.** Small Go tray-wrapper binary (~3.6 MB stripped) shows up as `AMM.exe` / `AMM.app` / `amm-tray` in Task Manager + Start menu + Apps & Features. Owns a system-tray icon with heartbeat-driven color (green/yellow/red) and a right-click menu (Status/Pause/Scrape/Telegram/Logs/Restart/Quit). Supervises the node bot as a child process with the same 3-strikes/hour respawn throttle as the watchdog.
- ✅ **v2.0** *(current)* — **Audit remediation.** Fixed `/update` (silently ran a scrape instead — broken since v0.5), `Security+`/`C++` resume terms never scoring, a PowerShell 5.1 encoding bug that broke task registration, setup declaring success without checking the bot started, concurrent-scrape collisions, update failures leaving broken installs (now rolls back), and second-bot-instance 409s looking like a dead bot. Plus visible installer progress, log rotation, and 11 new regression tests.
- **Next** — Scam-listing detection + salary database. Plugin architecture for additional job sources (RemoteOK, YC, Greenhouse, Lever, Ashby).
- **Later** — Embeddings-based ranking + optional LLM rerank (BYO Anthropic key), opt-in salary database, browser extension.

(Tauri desktop GUI was permanently cut in v1.0 — Telegram-first stays the thesis.)

## License

MIT — do whatever you want with it.

## Contributing

Pull requests welcome. Likely-needed contributions:
- Selectors for new ATS providers in `daily-batch.mjs`
- Additional keyword domains in `scripts/cv-keywords.json` (data eng, software, design)
- macOS / Linux distro testing — the v1.1 ports are functionally complete but each new distro/version surfaces small things (especially around launchd plist quirks and systemd user-unit linger semantics)

## Troubleshooting

### Wizard crashed with `spawn powershell ENOENT`
Your `PATH` is missing `C:\Windows\System32`. Fixed in v0.4.1, but if you're on an older install or it still happens: run `setup-tasks.ps1` directly with the absolute path. In `cmd.exe`:

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\automatic-munyun-machine\scripts\setup-tasks.ps1"
```

Then start the bot manually:
```
schtasks /run /tn munyun-bot
```

### Bot doesn't reply on Telegram
1. Verify it's running: `schtasks /query /tn munyun-bot` (look for State: Running).
2. Restart: `schtasks /run /tn munyun-bot`.
3. Check the log: `%LOCALAPPDATA%\automatic-munyun-machine\data\telegram-bot.log` (the last few lines tell you what crashed).
4. Verify your token + chat ID in `.env` are correct — try sending a manual message via:
   ```
   node scripts\telegram-send.mjs "test"
   ```

### `/scrape` says "session expired"
Run `/reauth` from your phone — the bot pops a Chromium window on your laptop, you sign in with Google, close the window. Session is saved automatically.

### 0 jobs scraped or DOM-related crash
hiring.cafe likely changed their HTML structure. Check `data/daily-batch-{date}.log` for the specific error and open an issue with the log attached.

### Wrong jobs in the batch
Edit your queries / filters from your phone — `/jobs add "Title"`, `/jobs remove "Title"`, `/skip <company>`, `/yoe N`, `/salary N`, `/clearance on/off`. Or edit `config.json` directly and re-run `/scrape`.

### Want to pause or uninstall
Three symmetric paths — pick whichever matches how you installed:

**From Telegram** *(easiest, works regardless of install method)*:
- Send `/uninstall` to the bot. Tap `[⚠️ Pause only]` to keep your data, or `[☠️ Wipe everything]` to clear it. Bot stops itself, unregisters all four scheduled tasks, optionally wipes `data/` + `config.json` + `.env`. Install dir is left for you to delete by hand if you want the code gone too.

**From Add/Remove Programs** *(if you used the `.exe` installer)*:
- Settings → Apps → Automatic Munyun Machine → Uninstall. Runs `uninstall.mjs --mode=wipe` automatically and removes the install dir.

**From PowerShell** *(if you used the one-liner)*:
```powershell
iwr -useb https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/scripts/uninstall.ps1 | iex
```
Pick `1` for pause or `2` for wipe.

### File picker doesn't open during the resume step
You're either on a stripped Windows install without `System.Windows.Forms`, or running from a no-GUI session (e.g. SSH). The wizard auto-falls-back to typed-path input — paste the full path to your resume. Or pick option 2 ("upload via Telegram later") and send `/resume` to the bot once setup finishes.
