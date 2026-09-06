# Automatic Munyun Machine — Project Context

> Current state for contributors and future development sessions.

**Version:** 10.2.0
**Active release branch:** `v10.2.0`
**Platforms:** Windows, macOS, Linux
**Last refreshed:** 2026-09-05

### v10.2 search/scoring changes

- `hcafe-pagination.mjs`: rendered-page retry traversal and company-card carousel extraction. Search sends `dateFetchedPastNDays:-1`, `sortBy:date`, configured workplace types. `scoring.searchAllPages` defaults true (5,000-page guard); false retains `maxPagesPerQuery`. Coverage snapshots in profile `search-coverage.json` record last completed and next zero-based page, not a cross-day resume token: searches restart against the changing live index.
- `ai-rerank.mjs`: Gemini `responseJsonSchema`, strict per-job validation. Caller splits truncated/malformed batches, preserves prior successful blends, and exposes partial/failure status. Strong-target stopping uses max(70, configured floor); weaker jobs remain allowed only by configured floor when evaluation ends.
- Actual `#job-description` only, two load attempts, profile `description-cache.json` (24 hours, 5,000 entries).
- `hcafe-save-queue.mjs`: profile `hcafe-save-queue.json`, selected jobs only, idempotent Saved verification after reload. `scoring.syncSavedJobs` defaults true; gated by accountDedup. Failed saves remain queued for later scrapes. No automatic Applied action.
- Local seen persistence immediately follows publication; optional delivery cannot cancel it. Last batch/archive funnel records AI, coverage, Saved and delivery outcomes. History adds `runs` (500 retained) without changing daily trends' `days` contract.
- Live probes: `node dev/live-smart-match.mjs <install-root>` uses configured secret with synthetic data only; `node dev/live-hcafe-search.mjs [term]` visits two pages in an isolated browser, without batch/seen writes.

## Product

Automatic Munyun Machine (AMM) is a local-first desktop job-search assistant. It collects jobs from hiring.cafe and optional public Greenhouse, Lever, and Ashby feeds, ranks them against a user's resume, and delivers a configurable batch of 50, 100, 150, or 200 jobs.

The local desktop dashboard is the primary interface. Telegram and Gmail delivery are optional. AMM is profession-agnostic: resume parsing and search suggestions cover technology, healthcare, sales, finance, marketing, education, HR, administration, and skilled trades.

AMM has no hosted backend. User state is stored in `config.json` and `data/`, both gitignored.

## Current release

v10.1.1 recognizes Google's new `AQ.` Gemini authorization keys as well as
legacy `AIza` keys, keeping Smart Match compatible with keys currently issued
by Google AI Studio.

v10.1.0 makes Smart Match provider-aware and key-only. It detects direct
Google Gemini, Anthropic, and OpenAI API keys, selects a maintained default
model for the detected provider, enables Smart Match when a key is saved, and
keeps keys in the existing private local secret store. The dashboard no longer
exposes a model field.

v10.0.0 adds the profile-scoped Consultant Slop Filter. Balanced and Strict
modes classify full descriptions for consulting, professional-services,
customer-facing, and required-travel work while recognizing hands-on backend
engineering evidence. Rejected candidates are replaced from deeper in the
scraped pool and are reported separately in batch diagnostics.

v9.0.3 restores automatic post-scrape email delivery for CSV and XLSX exports
by building the attachment from the batch that was just published. Requirement
matching now canonicalizes controlled industry abbreviations and expanded names
so equivalent resume and job-description terms satisfy the same requirement.

v9.0.2 repairs one-click Windows updates when scheduled AMM helpers hold the
bundled runtime open, and records installer diagnostics for future failures.

v9.0.1 includes the v9.0 matching improvements and makes macOS DMG packaging
resilient to transient Finder mount contention during release builds.

v9.0.0 removes Smart Match's 40-job total ceiling, lazily loads a full Dice
description for every evaluated candidate, structures resume employment and
skill evidence, deduplicates the same opening across sources, makes the supply
funnel explicit, hardens local dashboard/upload handling, and moves the AI key
outside config snapshots. Applied jobs also use a profile-scoped identity ledger
so cross-source URL changes do not bring the same opening back.

v8.4.0 replaces unbounded keyword accumulation with requirement-coverage and
role-fit scoring, adaptively evaluates descriptions until the strong-match
target is filled, defaults new installs to 200 matches, and stops hiding
Viewed jobs so candidates inspected but not delivered stay available.

v8.3.0 removes random Windows terminal flashes by routing scheduled background
jobs through console-free one-shot modes in the native wrapper and migrating
legacy Task Scheduler definitions during upgrade.

v8.2.0 adds profile-scoped switches that drop management/technical-lead titles
and sales titles before scoring across every configured job source.

v6.2.0 lets users choose `.txt`, `.csv`, or `.xlsx` for each manual dashboard
email send. Both the Jobs toolbar and System email card pass the selection
through the guarded local action and reuse the existing export builders.
Automatic post-scrape email remains `.txt`.

v6.1.0 adds an **Open All** action to the Jobs dashboard. After confirming the
batch size, the guarded local action opens each ranked job's direct application
URL in the default browser, falling back to its source listing when necessary.
Invalid links are skipped without weakening the dashboard's loopback and CSRF
protections.

v5.0 removes owner-specific defaults and expands the product beyond remote technology roles:

- Fresh installs begin with empty searches, no salary floor, no blocked companies, no title exclusions, and clearance filtering off.
- Resume parsing and role suggestions cover eight additional non-technical fields.
- Users can search Remote, Hybrid, and On-Site roles with an optional location.
- Greenhouse, Lever, and Ashby public company-board feeds can supplement hiring.cafe.
- Profile-scoped `search` and `sources` settings migrate from older top-level config locations.
- Full-description scoring, role-family checks, salary parsing, provider-aware Smart Match reranking, and score explanations remain in place.

v6.0.0 replaces the Chrome-hosted dashboard window on Windows with an
AMM-owned Win32 window embedding Microsoft WebView2. The wrapper launches a
window-host child mode so the existing tray main-thread loop remains isolated;
external links open in the system browser, and Chrome/Edge app mode remains a
fallback if WebView2 cannot initialize. macOS and Linux retain their existing
dashboard host.

## Runtime architecture

```text
OS scheduler / login item
        +-- Windows one-shot jobs use `AMM.exe --scheduled-task=<job>` and a hidden Node child
        │
        ▼
Go wrapper (wrapper/)
  ├─ system tray + native app window
  │    └─ Windows: AMM.exe child hosting WebView2
  ├─ local dashboard on 127.0.0.1
  ├─ guarded dashboard API
  └─ supervises Telegram poller when Telegram is enabled

Scheduled or manual scrape
        │
        ▼
scripts/daily-batch.mjs
  ├─ hiring.cafe through Playwright
  ├─ optional Greenhouse / Lever / Ashby feeds
  ├─ built-in Dice.com search (v7.4: always-on, no toggle — reuses the user's search terms; scripts/sources/dice.mjs parses the SSR flight payload, no key/login. search.scrapeSources both|hcafe|dice + per-term queries[].engines routing via scripts/query-engines.mjs; a Dice-only scrape skips Playwright; v7.5: user filters ride the Dice URL (workplace/location/recency) + exhaustive pagination (v7.6: all pages until no new jobs, 20-page cap), and Watch mirrors Dice search pages in a visible browser. Optional Dice sign-in mirrors the hcafe flow: dice-login.mjs window + dice-auth-probe.mjs headless check + data/dice-auth.json cache, System-page card)
  ├─ filter, deduplicate, and score
  ├─ write local batch + history
  └─ optional Telegram / email delivery

scripts/watchdog.mjs
  └─ checks data/heartbeat.json and performs platform-aware recovery
```

The wrapper is a thin native shell. Business logic stays in JavaScript helpers that the Go layer executes and relays.

## Core flows

### Scrape and rank

`scripts/daily-batch.mjs`:

1. Acquires the cross-process scrape lock.
2. Probes the persistent hiring.cafe browser profile.
3. Searches every configured query and configured company source.
4. Applies workplace, location, recency, company, title, clearance, form, and experience filters.
5. Deduplicates against hiring.cafe account state when signed in and local seen-job state as a fallback.
6. Uses cards for a broad recall ranking against the resume and target roles.
7. Fetches and requirement-scores descriptions in chunks until the requested
   number clear the final floor or the candidate supply is exhausted.
8. Applies the optional Consultant Slop description classifier and replaces
   rejected customer-facing, consulting, and travel roles from later chunks.
9. Optionally invokes provider-aware Smart Match reranking only for surviving candidates.
10. Resolves direct application URLs.
11. Writes `last-batch.json`, exports, scrape status, and batch history atomically. v7.2: also archives the full batch to `data/profiles/<profile>/batch-archive/` (`scripts/batch-archive.mjs`, 30-day retention, non-fatal) — the dashboard's "Previous scrapes" section lists these via `GET /api/archive`, serves one via `GET /api/archive/batch?id=`, and downloads one via `GET /api/export?format=…&archive=<id>`.
12. Optionally delivers through Telegram and email.

### Desktop dashboard

The wrapper serves `wrapper/dashboard.html` and API routes from `wrapper/dashboard.go` / `wrapper/dashboard_actions.go`. On Windows, `AMM.exe --window-host` embeds that loopback page in WebView2 with AMM's own AppUserModelID and icon. The primary process requires a readiness-file handshake before accepting the host, so synchronous or fatal WebView2 initialization failures fall back to Chrome/Edge app mode. Foreground second instances authenticate to the running primary's guarded `/api/window/open` handoff, keeping all window children owned by the tray process for quit/update cleanup. A PID/HWND/URL marker scopes single-window activation to the current installation and dashboard. The WebView2 profile lives under `data/native-window/`; outbound apply, OAuth, and release links are validated and handed to the default browser through `ShellExecuteW`, never a command shell.

Views:

- Jobs
- Searches and company sources
- Resume
- Profiles
- Trends
- System
- Settings

State-changing routes use `guardPost` with a per-process CSRF token and loopback Host validation. Read-only data routes use `guardGet`.

### Telegram

`scripts/telegram-bot.mjs` polls only when Telegram is configured. It provides scrape, save, applied, explanation, export, resume, search, profile, settings, health, update, pause, and uninstall commands.

Telegram is an optional remote control, not a setup requirement.

### Email

`scripts/email.mjs` selects Gmail OAuth or App Password SMTP. OAuth tokens and SMTP credentials remain local and gitignored. Manual sends can attach `.txt`, `.csv`, or `.xlsx`; automatic post-scrape sends use the compact `.txt` attachment.

## Configuration

`config.example.json` is the shipping schema. The active profile owns:

- `queries`
- `search`
- `sources`
- `filters`
- `scoring`
- `display`
- `email`

Profile state lives under `data/profiles/<slug>/`. Shared installation settings include scheduling and integration state where appropriate.

Important v5 defaults:

- `queries: []`
- `user.salaryFloorUsd: 0`
- `user.maxYoeAcceptable: 100`
- `filters.filterClearance: false`
- `filters.filterManagementTitles: false`
- `filters.filterSalesTitles: false`
- `filters.consultantSlopMode: off` (`off | balanced | strict`)
- `filters.skipCompanies: []`
- `filters.dropTitlePatterns: []`
- `search.workplaceTypes: ["Remote"]`
- all company-board source lists empty

All `config.json` writes must go through `scripts/config-rw.mjs`.

## Important files

### Product and runtime

- `scripts/daily-batch.mjs` — collection, filtering, scoring, resolution, and delivery
- `scripts/telegram-bot.mjs` — optional Telegram polling and commands
- `scripts/dashboard-api.mjs` — dashboard helper command implementation
- `scripts/resume-parser.mjs` — PDF/DOCX/Markdown resume parsing
- `scripts/role-suggester.mjs` — profession-aware search suggestions
- `scripts/cv-keywords.json` — resume vocabulary
- `scripts/profile-store.mjs` — profile-scoped config and migration
- `scripts/hcafe-session.mjs` — hiring.cafe sign-in probe and dedup mode
- `scripts/sources/` — Greenhouse, Lever, Ashby, and remote source configuration
- `scripts/email.mjs` / `scripts/gmail-oauth.mjs` — optional email delivery
- `scripts/self-update.mjs` / `scripts/update-checker.mjs` — update flow
- `scripts/scheduler-register.mjs` / `scripts/os-paths.mjs` — platform abstractions

### Native wrapper and packaging

- `wrapper/main.go` — wrapper entry point and supervised process
- `wrapper/native_window_windows.go` — Win32/WebView2 dashboard host and external-link bridge
- `wrapper/native_window_unix.go` — non-Windows host stubs; Chromium app mode remains in use
- `wrapper/dashboard.go` — local HTTP routes and dashboard server
- `wrapper/dashboard_actions.go` — guarded actions
- `wrapper/dashboard.html` — self-contained dashboard UI
- `installer/amm.iss` — Windows installer
- `packaging/` — macOS/Linux packaging
- `.github/workflows/ci.yml` — cross-platform checks
- `.github/workflows/release.yml` — release artifact build

### Documentation

- `README.md` — concise user-facing product and setup guide
- `CHANGELOG.md` — Keep a Changelog release history
- `CLAUDE.md` / `AGENTS.md` — coding-agent conventions
- `CONTEXT.md` — this current-state document

## Commands

```bash
npm install
npm run setup
npm run daily
npm run bot
npm run login
npm run parse-resume -- "/path/to/resume.pdf"
npm run check
npm test
npm run test:ui
npm run test:e2e
npm run build:wrapper
```

The test runner uses Node's built-in `node:test` suite and also runs Go tests. The dashboard has a static contract suite and a browser harness.

Live integrations still require deliberate manual checks:

- hiring.cafe DOM and pagination
- signed-in account deduplication
- Telegram bot delivery
- Gmail OAuth/SMTP delivery
- installer and updater behavior on each platform

## Engineering rules

- Use `scripts/browser-launcher.mjs#resolveBrowser()` at every Playwright launch site.
- Use absolute paths for Windows system binaries.
- Use `scripts/config-rw.mjs` for config mutations.
- Use atomic helpers for runtime state.
- Escape user-controlled text before Telegram HTML output.
- Scrub Telegram tokens, chat IDs, email credentials, OAuth tokens, and AI keys from logs.
- Keep the Go wrapper thin; place product logic in JavaScript helpers.
- Treat `.env`, `config.json`, resumes, browser profiles, and all of `data/` as private.
- Version is sourced from `package.json`; release builds inject it into the wrapper and installer.
- Windows shortcuts and the WebView2 host must keep the `AutomaticMunyunMachine.Desktop` AppUserModelID aligned.
- Work on feature/version branches, never directly on `main`.
- Update `README.md`, `CHANGELOG.md`, `config.example.json`, and this file when user-facing behavior or schema changes.

## Release checklist

1. Confirm `package.json` and `package-lock.json` versions match.
2. Run `npm run check`.
3. Run `npm test`.
4. Run `npm run test:ui`.
5. Run `npm run test:e2e` when Chromium is available.
6. Build the wrapper and run Go tests.
7. Perform one real hiring.cafe scrape from a clean profile.
8. Verify empty-query onboarding and a resume-generated search list.
9. Confirm the release branch is merged to `main`.
10. Tag the version and verify all platform artifacts.

## 2026-07-11 documentation cleanup

- Rewrote the README around the current desktop-first v5 product.
- Removed stale claims about 16 default searches, mandatory Telegram, Windows-only operation, and v2 being current.
- Aligned fallback wrapper/installer versions and lockfile metadata with 5.2.0.
- Added missing changelog comparison links.
- Clarified stale comments around empty searches and seen-job persistence.
- Added an explicit ignore rule for local app-window browser data.
