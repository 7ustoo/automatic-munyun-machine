# AGENTS.md

Guidance for coding agents working on Automatic Munyun Machine.

## Project

Automatic Munyun Machine (AMM) is a local-first desktop job-search assistant for Windows, macOS, and Linux. It collects jobs from hiring.cafe and optional Greenhouse, Lever, and Ashby feeds, ranks 50–200 jobs against the user's resume, and presents them in a local dashboard. Telegram and Gmail delivery are optional.

The runtime is Node.js + Playwright with a small Go wrapper for the tray app, local dashboard, and process supervision. There is no hosted AMM backend.

Read `CONTEXT.md` before structural work. Keep `README.md` user-facing and update `CHANGELOG.md` for user-visible changes.

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

`npm test` runs the Node regression suite and Go tests. Use a real `npm run daily` only when live hiring.cafe validation is appropriate; it changes local batch and seen-job state.

## Architecture

```text
OS scheduler / login item
  ├─ Go wrapper (tray, dashboard, process supervision)
  │    └─ optional telegram-bot.mjs child
  ├─ daily-batch.mjs (scheduled or manual scrape)
  └─ watchdog.mjs (heartbeat recovery)
```

State is coordinated through `config.json` and `data/`.

- `scripts/daily-batch.mjs` — scrape, source merge, filtering, scoring, direct-link resolution, local publication, optional delivery
- `scripts/telegram-bot.mjs` — optional Telegram commands and polling
- `scripts/dashboard-api.mjs` — helper commands executed by the wrapper
- `wrapper/` — Go native shell and local dashboard
- `scripts/sources/` — Greenhouse, Lever, Ashby, and remote source configuration
- `scripts/resume-parser.mjs` / `role-suggester.mjs` — profession-aware resume processing
- `scripts/profile-store.mjs` — profile-scoped state and migrations
- `scripts/config-rw.mjs` — atomic config access

Keep business logic out of Go when it can live in a testable JavaScript helper.

## Required conventions

### Browser launches

Every Playwright launch must use `scripts/browser-launcher.mjs#resolveBrowser()` and spread its `launchOptions`. Never hardcode a browser executable.

### Windows system tools

Resolve Windows binaries from `%SystemRoot%` and spawn absolute paths. Some installations do not include `C:\Windows\System32` on `PATH`.

### Config and state

- Mutate `config.json` through `scripts/config-rw.mjs`.
- Use atomic I/O helpers for runtime JSON and batch artifacts.
- Respect the scrape lock; dashboard, scheduler, and Telegram may trigger work concurrently.
- Add new shipping fields to `config.example.json`.
- Keep profile-owned settings profile-scoped.

### Dashboard security

- State-changing routes use `guardPost` (CSRF token + loopback Host check).
- Read-only routes exposing local data use `guardGet`.
- The dashboard must remain bound to `127.0.0.1`.
- Do not put secrets in dashboard responses, URLs, or logs.

### Telegram and email

- Telegram output uses HTML; escape user-controlled text.
- Chunk long Telegram messages around 3900 characters.
- Never log raw bot tokens, chat IDs, SMTP credentials, Gmail OAuth tokens, or AI keys.
- Delivery integrations are optional and non-fatal to local batch publication.

### Privacy

Never commit:

- `.env`
- `config.json`
- resumes
- browser profiles
- OAuth credentials or tokens
- anything under `data/`
- `*PRIVATE*.md`

`data/app-window/` contains browser caches and Safe Browsing databases and must remain local.

### Versioning

`package.json` is authoritative. Keep lockfile metadata and local wrapper/installer fallback versions aligned with it. CI injects the package version into release builds.

## Validation

Choose checks proportional to the change:

- JavaScript/config/docs: `npm run check` and focused tests
- Runtime behavior: `npm test`
- Dashboard markup/API contracts: `npm run test:ui`
- Browser interactions: `npm run test:e2e`
- Wrapper changes: `go test ./...` in `wrapper/` and `npm run build:wrapper`
- Scraper selectors/integrations: deliberate live scrape and log review

Do not claim hiring.cafe, Telegram, Gmail, or updater behavior is verified unless the live path was actually exercised.

## Branching and commits

- Work on a version branch named for the release (e.g. `v6.1`), never directly on `main`. Clean branch names only.
- Do not commit or push unless explicitly requested.
- When the user says "push", "ship", or "merge", execute the FULL release ritual unprompted: commit → push branch → open PR → wait for CI (fix failures, don't stop) → merge → tag `vX.Y.Z` and push the tag. The user never merges or tags manually. Merge-without-tag is a bug.
- Do not include local runtime artifacts in commits.

## Documentation responsibilities

- `README.md` — product, installation, privacy, and user troubleshooting
- `CHANGELOG.md` — user-visible release notes
- `CONTEXT.md` — current architecture, schema, and project state
- `config.example.json` — complete fresh-install schema and defaults

When adding a command, file, integration, or schema field, update the relevant documentation in the same change.
