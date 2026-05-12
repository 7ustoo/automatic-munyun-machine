# AMM — Project Context

**Repo:** `automatic-munyun-machine` (`7ustoo/automatic-munyun-machine` on GitHub)
**Type:** Brownfield, multi-version, single-author
**Current version:** 1.0.0 (shipped to `main` 2026-05)
**Active milestone:** v1.1 — *Cross-platform + Hardened*
**Working branch convention:** feature/version branches merged to `main` via GitHub PRs (user merges manually; never commit directly to `main`)

---

## What AMM is

AMM is a local-first Windows-only tool that scrapes hiring.cafe daily, ranks 100 jobs against the user's CV, and pushes them to Telegram with one-tap save / applied / why / skip-company actions. Pure Node.js + Playwright; no server, no cloud, no third-party APIs beyond hiring.cafe / open-meteo / Telegram. Targets non-technical end users via a one-line PowerShell installer.

Three independent processes share one filesystem:

1. **`scripts/daily-batch.mjs`** — the scraper. Persistent-profile Chromium → multi-query pagination → CV scoring → top-100 → Telegram push. Triggered by Task Scheduler weekdays at 07:00.
2. **`scripts/telegram-bot.mjs`** — long-running bot (~30 commands, inline callbacks). Started at logon by Task Scheduler.
3. **`scripts/watchdog.mjs`** — every 5 minutes, kills + restarts the bot if its heartbeat is stale. Independent telegram-send.mjs alerter for "bot dead" pings.

State coordination: filesystem only. `data/heartbeat.json`, `data/profiles/<slug>/*.json`, `config.json`. No daemon, no IPC, no shared memory.

---

## Validated requirements (shipped in v1.0.0)

These are NOT being re-implemented; they're load-bearing context for v1.1 design decisions.

| Capability | Where shipped | Source |
|---|---|---|
| Daily scrape of hiring.cafe with persistent Chromium profile | v0.2 | CHANGELOG `[0.2.0]` |
| CV-keyword-based ranking (titles / certs / skills / compliance) | v0.3 | `scripts/cv-keywords.json`, `scripts/resume-parser.mjs` |
| Telegram push with chunked messages + TSV attachment | v0.3 | `daily-batch.mjs#tgChunked`, `tgDocument` |
| 30+ Telegram bot commands (history, save, applied, settings, etc.) | v0.4–v0.5 | `README.md` command tables |
| Inline callback buttons with HMAC sig replay defense | v1.0 E2 | `scripts/callback-router.mjs` |
| Phrase-proximity + role-cluster scoring (closes "AWS once vs deep AWS" gap) | v1.0 E3 | `daily-batch.mjs#scoreJob`, `cv-keywords.json#clusters` |
| Out-of-process watchdog with 3-restarts/hour throttle | v1.0 E4 | `scripts/watchdog.mjs` |
| Multi-profile support (`config.profiles.<slug>`, per-profile data dirs) | v1.0 E5 | `scripts/profile-store.mjs` |
| Inno Setup `.exe` installer + uninstall lifecycle | v1.0 E6 | `installer/amm.iss`, `scripts/uninstall.{mjs,ps1}` |
| 24 unit tests (parseSalaryK, role-cluster, profile-store, scoreJob smoke) | v1.0 | `scripts/__tests__/*.test.mjs` |
| Cloudflare-bypass scraping without hiring.cafe auth | v1.0 post-release patch | `scripts/login-once.mjs` rewrite, commit 451ba7c |
| Pagination + target-driven cross-query early stop (1.5x headroom) | v1.0 post-release patch | `daily-batch.mjs` pagination loop |

---

## Why v1.1

Two parallel tracks:

**Track A — Hardening (must-do).** v1.0 code review surfaced 9 HIGH-severity findings: HTML-injection via unescaped `directUrl` in batch messages, token-scrubbing missing in scraper error paths, `fs.renameSync` not actually atomic on NTFS, HMAC-key fallback to literal `'no-token'`, browser-context leaks on scrape failure, and four others. Plus 14 MEDIUM findings. None are CRITICAL — v1.0 is safe to keep running — but every HIGH should ship before the cross-platform refactor begins, so the new platform abstractions inherit a clean baseline rather than carrying the bugs forward into 3x more code paths.

**Track B — Cross-platform (the headline feature).** v1.0 is structurally Windows-only — 25+ source-code-level couplings to PowerShell, cmd.exe, schtasks, OpenFileDialog, and Inno Setup. v1.1 adds Mac (launchd) and Linux (systemd) ports plus signed installers. This is what end-users will see in the changelog. The hardening work in Track A is the prerequisite — without it, every v1.0 bug becomes a v1.0+Mac+Linux bug.

---

## Out of scope for v1.1 (deferred to v1.2+ or permanently cut)

| Item | Status | Notes |
|---|---|---|
| Tauri / Electron GUI | **Permanently cut** | Telegram-first thesis won; would add a dependency tree the size of the rest of the codebase |
| Scam-listing detection | v1.2 | Needs labeled corpus + small classifier |
| Salary database | v1.2 | Wide-scope feature beyond hiring.cafe |
| LLM / embeddings semantic match | v2.0+ | Re-evaluate after v1.1 ships if scoring complaints persist |
| Webhook-based Telegram delivery | Indefinite | AMM is local-first by design; webhooks need public HTTPS |
| Multi-user / shared-machine ACL hardening | Indefinite | Solo-user thesis; document as known limitation |
| Structured logging / metrics dashboard | v1.2+ | Current plain-text logs are adequate for solo use |
| Application-status tracking beyond append-only `applications.md` | v1.2+ | (rejected / interviewed / offer states) |

---

## Constraints carried into v1.1

These shape every v1.1 design decision:

1. **No CLAUDE.md drift.** v1.0 conventions stay: Win32 absolute paths for all system-binary spawns (now extended to platform-aware abstractions in `os-paths.mjs`), atomic config writes, Telegram chunking via `tgChunked`, token scrubbing on every `log()` and Telegram-bound error path, branding sentinel (`munyun-*` Task Scheduler entries; their cross-platform equivalents must use the same prefix).
2. **`config.json` shape stays backward-compatible.** v1.0 E5 introduced `{active_profile, profiles: {<slug>: {...}}}`. v1.1 adds nothing to the top level. `migrateIfNeeded()` already handles v0.x → v1.0; v1.1 must not require another migration.
3. **No new mandatory deps.** v1.0's prod dep set is `dotenv`, `node-fetch`, `playwright`. Cross-platform adds `proper-lockfile` (single dep, ~30 KB, well-maintained) for advisory locking. No GUI deps, no LLM deps, no telemetry deps.
4. **One bundled release.** Per user feedback ("make all of the changes into one release, dont make hella seperate branches"), v1.1 ships as a single PR to `main` from a `v1.1` branch. Phases progress on the same branch with atomic commits — no per-phase branches.
5. **End-user installation stays a one-liner.** Windows: `iwr ... | iex` (unchanged). Mac/Linux: `curl ... | sh` (new). Both must work on a stripped PATH, which is why v1.0 hardcoded `%SystemRoot%` paths and v1.1 needs the same discipline for `/usr/bin`, `/bin`, and `which`-resolved binaries.

---

## Roadmap

See `.planning/ROADMAP.md` for the phase-by-phase breakdown. Six phases:

1. **Hardening** — fix the 9 HIGH-severity REVIEW.md findings + the worst doc-drift items.
2. **Path abstraction + atomic-write layer** — `os-paths.mjs`, `io-helpers.mjs`, `proper-lockfile`, missing tests.
3. **Mac launchd port** — `setup-tasks-mac.sh`, shell wrappers, `osascript` file picker.
4. **Linux systemd port** — `setup-tasks-linux.sh`, shell wrappers, `zenity`/`kdialog` file picker.
5. **Code signing** — sign Windows `.exe`, notarize Mac `.dmg`.
6. **Cross-platform installers + CI** — `.dmg`, `.deb`, `.AppImage`, GitHub Actions matrix.

---

## Branching convention for v1.1

- All work on the `v1.1` branch (already exists or will be cut from `main` post-v1.0 merge).
- One commit per atomic change.
- User merges to `main` via GitHub PR after the full v1.1 milestone is verified.
- Feature flags / behind-a-toggle work is **not** the AMM convention — phases ship complete or stay on the branch.

---

*Last updated: 2026-05-07*
