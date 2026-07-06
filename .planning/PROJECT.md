# AMM — Project Context

**Repo:** `automatic-munyun-machine` (`7ustoo/automatic-munyun-machine` on GitHub)
**Type:** Brownfield, multi-version, single-author
**Current version:** **2.9.0** (shipped 2026-07-05)
**Active milestone:** none — v2.9 shipped, working tree clean. Next feature starts a new `vX.Y` milestone.
**Working branch convention:** feature/version branches merged to `main` via GitHub PRs (user merges manually; never commit directly to `main`)

---

## What AMM is

AMM is a local-first, **cross-platform** (Windows / macOS / Linux) tool that scrapes hiring.cafe daily, ranks 100 jobs against the user's CV, and surfaces them in a **local desktop dashboard** — with Telegram push as an optional add-on. Pure Node.js + Playwright for the payload, a small Go tray wrapper for the native shell; no server, no cloud, no third-party APIs beyond hiring.cafe / open-meteo / Telegram / GitHub Releases. Targets non-technical end users installed via a one-liner; setup is dashboard-driven.

**Desktop-first since v2.1.** The primary surface is a titled app-window dashboard (installed Chrome/Edge in app-mode, isolated profile) served by the tray wrapper. Users see, filter, apply-to, save, and track jobs there; onboarding happens in a 5-step dashboard panel (v2.7). Telegram is opt-in and configured from the same GUI.

Four independent processes share one filesystem (`config.json`, `data/*.json`):

1. **`AMM.exe`** — Go tray wrapper (`wrapper/`, since v1.2). Owns the tray icon + app window, serves the localhost dashboard (state-changing POST routes behind a per-process CSRF token), and supervises the bot as a child **only while Telegram is enabled**.
2. **`scripts/daily-batch.mjs`** — the scraper. Persistent-profile Chromium → multi-query pagination → CV scoring → top-100 → `last-batch.json` + `jobs(date).txt`, plus optional Telegram push. Triggered at the configured time by the platform scheduler, by the dashboard/tray "Scrape now," or `npm run daily`.
3. **`scripts/telegram-bot.mjs`** — long-running bot (~30 commands, inline callbacks). Runs only while Telegram is configured.
4. **`scripts/watchdog.mjs`** — every 5 minutes, restarts on stale heartbeat.

State coordination: filesystem only. No daemon beyond the wrapper's supervision, no IPC, no shared memory.

---

## Shipped milestones (v1.0 → v2.9)

The v1.0 milestone (Windows-only, Telegram-first) was the baseline this `.planning/` directory was originally written against. Everything below shipped since and defines the current product. Full detail: `CHANGELOG.md`; milestone table: `STATE.md`.

| Milestone | Headline |
|---|---|
| v1.1 | Cross-platform (macOS launchd + Linux systemd), code signing, CI matrix; hardening (9 HIGH + 7 MEDIUM review findings closed); `os-paths.mjs` + `io-helpers.mjs` |
| v1.2 | Go tray wrapper `AMM.exe` — real app in the tray/Task Manager, supervises the bot |
| v1.3 | Local read-only dashboard embedded in the wrapper |
| v2.0 | Audit remediation + `/viewjob/`→`/job/` scrape migration |
| v2.0.1–2.0.4 | Drive installed Chrome/Edge (no bundled Chromium); AMM icon everywhere; keyword search mode; auto-start on setup finish |
| v2.1 | **Desktop-first pivot** — dashboard is a full control surface; Telegram optional + GUI setup |
| v2.2–2.3 | Real app window; search-every-keyword; tray logo |
| v2.4–2.4.1 | Apply-links export (.txt/.csv/.xlsx); single-instance lock + launch-chain fix |
| v2.5–2.6 | Recency filter, resume rescan, self-update; profile CRUD in dashboard |
| v2.7–2.9 | Dashboard-driven setup; clear-all + search-style toggle; watch-the-scrape + post-update reopen |

---

## Out of scope / not yet built

| Item | Status | Notes |
|---|---|---|
| Cross-platform (Mac/Linux) | **Shipped v1.1** | Was the v1.1 headline; now a solved constraint |
| Native desktop GUI | **Shipped** (differently than once planned) | Not Tauri/Electron — a Go tray wrapper + dashboard served to an app-mode browser window. Zero heavy GUI dep tree, as intended. |
| Scam-listing detection | Not built | Would need a labeled corpus + small classifier |
| Salary database | Not built | Wide-scope beyond hiring.cafe |
| LLM / embeddings semantic match | Not built | Re-evaluate if keyword-scoring complaints persist |
| Webhook-based Telegram delivery | Indefinite | AMM is local-first; webhooks need public HTTPS |
| Multi-user / shared-machine ACL hardening | Indefinite | Solo-user thesis; documented limitation |
| Application-status tracking beyond append-only `applications.md` | Not built | (rejected / interviewed / offer states) |

---

## Constraints (current)

These shape every design decision (see `CLAUDE.md` for the authoritative conventions):

1. **Desktop-first, Telegram optional.** New user-facing capability lands in the dashboard first; Telegram is a mirror, not the primary. "Is Telegram on" = `telegramConfigured` (valid token + numeric chat id), single-sourced.
2. **Cross-platform discipline.** All system-tool spawns resolve through `scripts/os-paths.mjs`; all Playwright launches through `scripts/browser-launcher.mjs#resolveBrowser()`. Never hardcode PowerShell/cmd/schtasks or a browser binary.
3. **`config.json` shape stays backward-compatible.** Multi-profile (`{active_profile, profiles: {<slug>: {...}}}`) is frozen; `migrateIfNeeded()` handles legacy configs. No new mandatory migration.
4. **Minimal deps.** Prod deps: `mammoth`, `pdf-parse`, `playwright-core`, `proper-lockfile`. Go wrapper: `fyne.io/systray`. No LLM/telemetry deps.
5. **One bundled release per version.** Work happens on a single `vX.Y` branch with atomic commits; the user merges to `main` via one GitHub PR. No per-phase branches.
6. **End-user installation stays a one-liner**, per platform, and must survive a stripped PATH.
7. **Never reimplement Telegram in Go**; all Telegram API talk stays in Node and the wrapper relays JSON.

---

## Branching convention

- All work on a `vX.Y` branch cut from `main`.
- One commit per atomic change.
- User merges to `main` via GitHub PR after the milestone is verified.
- Feature-flag/toggle work is not the AMM convention — features ship complete or stay on the branch.

---

*Last updated: 2026-07-06 — synced to shipped v2.9.0*
