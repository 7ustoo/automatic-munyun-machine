# Automatic Munyun Machine (AMM)

> Wake up to your morning coffee, the Miami weather, and 100 jobs sorted by how well they match your CV — delivered straight to Telegram every weekday at 7am. Apply, save, and track from your phone.

## What it does

- **Daily 100-job batch.** Scrapes hiring.cafe across 15 search queries (IAM, Cloud Security, Cybersecurity, M365, Linux, etc.).
- **CV-aware ranking.** Parses your resume, scores each job by keyword overlap, sorts top→bottom by match %.
- **Filters out the noise.** Drops manager/principal/director/sales-engineer titles, government clearance roles, jobs above your YOE limit, companies you've blacklisted.
- **Telegram-first.** Push at 7am Mon-Fri, on-demand `/scrape`, plus `/save N`, `/applied N`, `/reauth`, `/pause` from your phone.
- **Downloadable .txt batch every morning.** `jobs(YYYY-MM-DD).txt` arrives as a Telegram attachment alongside the message stream — search-friendly, archivable, pull anytime via `/export`.
- **Local-first.** Everything runs on your machine. Nothing leaves your computer except the actual Telegram messages.

## Install

### One-line install (recommended)

```powershell
iwr -useb https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.ps1 | iex
```

This:
1. Installs Node.js + Git (via winget) if missing
2. Clones the repo to `%LOCALAPPDATA%\automatic-munyun-machine\`
3. Installs npm deps + Chromium (for Playwright)
4. Launches the interactive setup wizard

### Manual install (developers)

```bash
git clone https://github.com/7ustoo/automatic-munyun-machine.git
cd automatic-munyun-machine
npm install
npx playwright install chromium
node scripts/setup-wizard.mjs
```

## Setup wizard — 10 steps, ~3 minutes

1. **Telegram bot.** Wizard walks you through @BotFather to create one, validates the token.
2. **Chat ID.** Send any message to your bot, wizard auto-detects your chat ID.
3. **hiring.cafe login.** Browser opens, you sign in with Google once. Session persists.
4. **Resume.** Three options:
   - **Pick from disk** *(default)* — opens a Windows file picker dialog. Click your PDF / DOCX / MD resume.
   - **Upload via Telegram later** — skip the wizard step, send `/resume` to the bot once setup finishes and attach your CV.
   - **Type the path manually** — fallback for headless installs or weird environments.
5. **Auto-suggested job titles.** Wizard reads your CV and proposes 10-12 search titles. Accept all, pick a subset, or keep defaults. (Skipped if you uploaded later — defaults apply until you run `/jobs suggest` post-upload.)
6. **Years of experience.** Max YOE you'd accept on a job listing.
7. **Salary floor.** Used for ranking (bonus above floor, penalty below).
8. **Clearance filter.** Toggle on/off — drop or include gov clearance jobs.
9. **Your city.** Auto-geocoded for the morning weather report.
10. **Schedule + finalize.** Pick time + days. Wizard registers Windows Task Scheduler, starts the bot, and sends a final ✅ ping to your Telegram so you know setup completed end-to-end.

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
| `/jobs add "Title"` | Add a search title |
| `/jobs remove "Title"` | Remove a search title |
| `/jobs suggest` | Bot reads your CV and proposes new titles |
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

- Windows 10 / 11 (Mac and Linux support is on the roadmap)
- ~500 MB disk (mostly Chromium)
- Always-on machine for the 7am push (or use `/daily` on demand)
- A Telegram account
- A hiring.cafe account (free; sign in via Google)

## Roadmap

- ✅ **v0.2** — Setup wizard, install one-liner, configurable everything
- ✅ **v0.3** — 18 new bot commands, 10-step wizard, smart resume parsing, `/forms` filter, `/jobs suggest`, `/why N`
- ✅ **v0.4** — Downloadable `.txt` batch attachment + `/export` command
- ✅ **v0.4.1** — Native Windows file picker for resume step, Telegram-only setup path, fixed PowerShell PATH crash, libuv assertion fix, transient-outage resilience
- ✅ **v0.5** *(current)* — `/update` command, `/version` command, update notifications on startup + daily, version-aware bot startup ping
- **v0.6** — Mac + Linux support, plugin architecture for additional job sources (RemoteOK, YC, Greenhouse, Lever, Ashby)
- **v1.0** — Tauri desktop GUI with dashboard, history calendar, application Kanban
- **v2.0** — Embeddings-based ranking + optional LLM rerank (BYO Anthropic key), opt-in salary database, browser extension

## License

MIT — do whatever you want with it.

## Contributing

Pull requests welcome. Likely-needed contributions:
- Mac/Linux equivalents of `setup-tasks.ps1`, `start-bot.cmd`, etc.
- Selectors for new ATS providers in `daily-batch.mjs`
- Additional keyword domains in `scripts/cv-keywords.json` (data eng, software, design)

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

### Want to start over from scratch
1. Stop and unregister the bot:
   ```
   Get-Process node | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'telegram-bot' } | Stop-Process -Force
   Unregister-ScheduledTask -TaskName 'munyun-bot' -Confirm:$false
   Unregister-ScheduledTask -TaskName 'munyun-daily-batch' -Confirm:$false
   ```
2. Delete the install dir:
   ```
   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\automatic-munyun-machine"
   ```
3. Re-run the install one-liner.

### File picker doesn't open during the resume step
You're either on a stripped Windows install without `System.Windows.Forms`, or running from a no-GUI session (e.g. SSH). The wizard auto-falls-back to typed-path input — paste the full path to your resume. Or pick option 2 ("upload via Telegram later") and send `/resume` to the bot once setup finishes.
