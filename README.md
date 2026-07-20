<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/5f0014df-1a84-4b4f-a214-0d34ff174789" />

> Your resume in. Your best job matches out.

**AMM** is a local-first desktop app that finds jobs, ranks them against your resume, and gives you a focused batch of **50–200 matches**. Review everything from one dashboard, apply through direct links, and optionally send the batch to Telegram or email.

**Free · Private · Windows, macOS, and Linux · Built for any profession**

[Install](#install) · [How it works](#how-it-works) · [Features](#features) · [Privacy](#privacy) · [Troubleshooting](#troubleshooting)

---

## What AMM does

1. **Reads your resume** and identifies relevant titles, skills, certifications, and experience.
2. **Finds jobs** on hiring.cafe and optional Greenhouse, Lever, and Ashby company boards.
3. **Filters the noise** using your location, workplace preference, experience limit, blocked companies, recency, and other settings.
4. **Ranks each job** against your resume using the listing and full job description.
5. **Delivers a daily shortlist** in the desktop dashboard, with optional Telegram and email handoff.

AMM supports technical and non-technical careers, including healthcare, sales, finance, marketing, education, HR, administration, skilled trades, and more.

## Why use it?

- **Stop repeating the same searches.** AMM runs them on your schedule.
- **See the strongest matches first.** Every job includes a match score and explanation.
- **Apply faster.** AMM resolves direct employer application links.
- **Keep control.** Choose 50, 100, 150, or 200 jobs per batch and tune every search or filter.
- **Keep your data local.** Your resume, history, settings, and browser session stay on your computer.

## Features

### One dashboard for the whole search

- Native Windows app window with AMM's own taskbar icon and pinning identity
- Ranked jobs with search, sorting, match filters, salary, and source details
- **Apply**, **Open All**, **Save**, **Applied**, and **Why this matched** actions
- Resume rescan and automatic search-term suggestions
- Remote, hybrid, and on-site searches with optional location
- Blocked companies, job age, experience, salary, clearance, and application-form controls
- Multiple profiles, each with its own resume, searches, settings, and history
- Trends and a search-term leaderboard to show which searches produce the best matches
- Light and dark themes, desktop notifications, exports, and one-click manual scrapes

### More than one job source

AMM searches hiring.cafe and can also read public job-board feeds directly from companies using:

- Greenhouse
- Lever
- Ashby

Company-board sources are optional and disabled until you add them.

### Optional delivery

The desktop dashboard is the primary app. Extra delivery channels are optional:

- **Telegram:** receive batches and run commands from your phone
- **Email:** send the apply-link list to yourself or a helper through Gmail as `.txt`, `.csv`, or `.xlsx`
- **Export:** download `.txt`, `.csv`, or `.xlsx` files with direct apply links

### Explainable matching

AMM first scores the job card, then fetches and scores the full description. It checks role-family fit, handles ambiguous terms, and uses salary only as a tie-breaker. You can inspect the score journey and missing terms for every job.

An optional bring-your-own Anthropic key can add a final Claude rerank. It is off by default.

---

## Install

### Native installer — recommended

Download the correct file from the [latest GitHub release](https://github.com/7ustoo/automatic-munyun-machine/releases/latest):

| Platform | Download |
|---|---|
| Windows | `amm-setup-vX.Y.Z.exe` |
| macOS | `amm-vX.Y.Z.dmg` |
| Debian / Ubuntu | `amm_X.Y.Z_all.deb` |
| Other Linux | `amm-vX.Y.Z-x86_64.AppImage` |

Open the installer and follow the in-app setup.

On Windows, AMM uses Microsoft's WebView2 runtime for its native dashboard
window. Windows 10/11 commonly already includes it; the installer detects and
provisions the free Evergreen runtime when needed.

> Release artifacts may be unsigned when platform signing credentials are unavailable. Verify that the download came from this repository's Releases page.

### One-line install

Windows PowerShell:

```powershell
iwr -useb https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.ps1 | iex
```

macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.sh | bash
```

### Manual install

Requires Node.js 18+ and Git:

```bash
git clone https://github.com/7ustoo/automatic-munyun-machine.git
cd automatic-munyun-machine
npm install
npm run setup
```

AMM uses an installed Chrome or Edge browser for job collection when available. It downloads Playwright Chromium only when neither is present. On Windows, that collection browser is separate from AMM's native WebView2 dashboard window.

---

## First-time setup

The dashboard walks you through:

1. Uploading your resume and confirming suggested searches
2. Setting basic experience, salary, filter, and schedule preferences
3. Preparing the hiring.cafe browser session and optionally signing in
4. Optionally connecting Telegram
5. Saving the schedule and running your first batch

Fresh installs start with no profession-specific searches or company filters. Your searches are built from your resume, so AMM does not assume your career field.

After setup, use **Settings** for workplace type, location, batch size, and advanced filters. Gmail and company-board sources can be connected from the main dashboard.

## How it works

```text
Schedule or “Scrape now”
          │
          ▼
 hiring.cafe + optional company boards
          │
          ▼
 filter → deduplicate → score full descriptions
          │
          ▼
 local dashboard and batch history
          │
          ├── optional Telegram
          ├── optional email
          └── TXT / CSV / XLSX export
```

The native Go wrapper runs the local dashboard and supervises background work. On Windows it embeds that dashboard in an AMM-owned WebView2 window, so the taskbar and pinned shortcut belong to `AMM.exe` instead of Chrome. Node.js and Playwright handle job collection, resume parsing, scoring, and delivery. The dashboard binds to `127.0.0.1`, not your local network or the public internet.

When signed into hiring.cafe, AMM asks the account to hide saved, applied, and viewed jobs. When signed out, AMM uses its local seen-job history.

---

## Useful commands

Most users can do everything from the dashboard.

### Development and manual runs

```bash
npm run setup          # CLI setup fallback
npm run daily          # run a batch now
npm run login          # refresh hiring.cafe sign-in
npm run parse-resume -- "/path/to/resume.pdf"
npm test               # Node and Go regression suites
npm run check          # fast syntax checks
```

### Telegram essentials

| Command | Action |
|---|---|
| `/scrape` | Run a fresh batch |
| `/save N` | Save job number N |
| `/applied N` | Mark job number N as applied |
| `/why N` | Explain its match score |
| `/export` | Export direct apply links |
| `/settings` | Show current settings |
| `/jobs` | List or manage search terms |
| `/resume` | Upload a new resume |
| `/status` | Check app health |
| `/help` | Show all available commands |

---

## Privacy

AMM has **no telemetry** and does not run a hosted backend.

Stored locally:

- Resume and parsed keywords
- Settings and profiles
- Browser session
- Job batches, seen-job history, and application history
- Telegram, Gmail, or optional AI credentials

Network access happens only when needed for enabled features:

- hiring.cafe and configured company job boards
- open-meteo for optional weather
- Telegram or Gmail when connected
- GitHub for update checks
- Anthropic only when optional AI reranking is enabled

Sensitive and generated files are excluded from Git through `.gitignore`, including `.env`, `config.json`, and `data/`.

## Cost

Core AMM usage is free. hiring.cafe, public company-board feeds, Telegram, open-meteo, and local scoring do not require a paid AMM service.

Optional Claude reranking uses your own Anthropic API key and may incur Anthropic charges.

## Requirements

- Windows 10/11, macOS 14+, or a modern Linux distribution
- Node.js 18+ for script/manual installs; native packages can bundle the runtime
- Chrome, Edge, or space for Playwright Chromium for job collection
- Microsoft WebView2 Runtime for the native Windows dashboard (normally present; the Windows installer provisions it when missing)
- An internet connection while collecting jobs
- A machine that is awake at the scheduled time

Telegram, Gmail, and a hiring.cafe account are optional. Signing into hiring.cafe is recommended for better deduplication.

---

## Troubleshooting

### No jobs appear

Make sure you added search terms or company-board sources. Fresh v5 installs intentionally begin without someone else's searches. Then check the latest `data/daily-batch-*.log`.

### hiring.cafe is signed out or blocked

Open **System → hiring.cafe → Sign in**, or run:

```bash
npm run login
```

### Telegram does not respond

Confirm Telegram is enabled in **System**, validate the bot token and chat, then restart AMM from the tray menu.

### The resume picker does not open

Enter the file path manually or use the dashboard upload. Headless sessions may not support a native file picker.

### Need more help?

Check the [open issues](https://github.com/7ustoo/automatic-munyun-machine/issues) or create one with your OS, AMM version, and the relevant log excerpt. Remove personal details and tokens before posting logs.

---

## Contributing

Contributions are welcome. Useful areas include:

- Job-source adapters under `scripts/sources/`
- Resume vocabulary in `scripts/cv-keywords.json`
- Cross-platform installer and scheduler testing
- hiring.cafe selector updates

Before opening a pull request:

```bash
npm run check
npm test
npm run test:ui
```

See [CHANGELOG.md](CHANGELOG.md) for release history and [CONTEXT.md](CONTEXT.md) for the current architecture.

## License

[MIT](LICENSE)
