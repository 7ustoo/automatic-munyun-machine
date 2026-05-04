# Automatic Munyun Machine (AMM)

> Wake up to your morning coffee, the Miami weather, and 100 jobs sorted by how well they match your CV — delivered straight to Telegram every weekday at 7am. Apply, save, and track from your phone.

![Telegram screenshot placeholder](docs/screenshot.png)

## What it does

- **Daily 100-job batch.** Scrapes hiring.cafe across 15 search queries (IAM, Cloud Security, Cybersecurity, M365, Linux, etc.).
- **CV-aware ranking.** Parses your resume, scores each job by keyword overlap, sorts top→bottom by match %.
- **Filters out the noise.** Drops manager/principal/director/sales-engineer titles, government clearance roles, jobs above your YOE limit, companies you've blacklisted.
- **Telegram-first.** Push at 7am Mon-Fri, on-demand `/daily`, plus `/save N`, `/applied N`, `/reauth`, `/pause` from your phone.
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

## Setup wizard — 5 steps, ~90 seconds

1. **Telegram bot.** Wizard walks you through @BotFather to create one, validates the token.
2. **Chat ID.** Send any message to your bot, wizard auto-detects your chat ID.
3. **hiring.cafe login.** Browser opens, you sign in with Google once. Session persists.
4. **Resume.** Drop a path to your PDF / DOCX / MD resume. Wizard parses skills, certs, titles.
5. **Schedule.** Pick time + days. Wizard registers Windows Task Scheduler.

After setup, the bot runs in the background and delivers a batch every weekday morning.

## Telegram commands

| Command | Action |
|---|---|
| `/daily`, `gm`, `morning` | Run a fresh batch now (1-2 min) |
| `/weather` | Just the weather |
| `/auth` | Verify hiring.cafe login |
| `/reauth` | Trigger re-login on your computer |
| `/save N` | Bookmark job #N from latest batch |
| `/applied N` | Mark job #N applied (also logs to applications.md) |
| `/pause` | Stop the daily 7am push |
| `/resume-bot` | Re-enable the daily 7am push |
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
| `data/today-batch-{date}.tsv` | Each day's batch as TSV |
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

- v0.2 (current): Setup wizard, install one-liner, configurable everything
- v0.3: Inno Setup .exe installer, Mac/Linux support
- v1.0: Tauri desktop GUI with dashboard, history calendar, application Kanban
- v2.0: LLM rerank (opt-in, BYO Anthropic key), analytics, multi-resume profiles

## License

MIT — do whatever you want with it.

## Contributing

Pull requests welcome. Likely-needed contributions:
- Mac/Linux equivalents of `setup-tasks.ps1`, `start-bot.cmd`, etc.
- Selectors for new ATS providers in `daily-batch.mjs`
- Additional keyword domains in `scripts/cv-keywords.json` (data eng, software, design)

## Troubleshooting

**"Hiring.cafe session expired"** — Run `/reauth` on the bot. Pops a Chromium window on your PC; sign in, close window.

**0 jobs scraped** — hiring.cafe may have changed their DOM. Check `data/daily-batch-*.log`. Open an issue with the log.

**Bot not responding** — Check `data/telegram-bot.log`. The bot may have crashed; restart with `Start-ScheduledTask -TaskName munyun-bot`.

**Wrong jobs in the batch** — Edit `config.json` to add/remove search queries or filter rules, then run `/daily` again.
