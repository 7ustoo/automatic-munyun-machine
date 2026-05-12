# AMM — Project State

This is the durable project memory consulted by GSD agents at the start of each phase.

---

## Current state

- **Active milestone:** v1.1 — Cross-platform + Hardened
- **Current phase:** 1 (Hardening — not yet started)
- **Last completed phase:** none in v1.1; v1.0 milestone shipped to `main` 2026-05
- **Active branch:** `v1.0` (will cut `v1.1` from `main` once v1.0 is fully merged)
- **Repo HEAD:** `451ba7c feat(v1.0): drop Google sign-in, target-driven cross-query stop, /saved command`

---

## Milestone history

### v1.0 — shipped 2026-05
**Theme:** "Trustworthy and shareable on Windows"

Six epics shipped end-to-end as one bundled release on the `v1.0` branch:

| Epic | Title | Highlights |
|---|---|---|
| E1 | Bot polish + heartbeat | `/status`, `/diagnose`, watchdog heartbeat |
| E2 | Inline callback buttons | HMAC sig replay defense, callback-router.mjs |
| E3 | Scoring overhaul | phrase-proximity, role-cluster auto-detection, match floor, seen-jobs decay |
| E4 | Out-of-process watchdog | watchdog.mjs, telegram-send.mjs, restart throttling |
| E5 | Multi-profile | profile-store.mjs, namespaced data dirs, /profile commands |
| E6 | Distribution + uninstall | Inno Setup .iss installer, /uninstall + uninstall.{mjs,ps1}, version 1.0.0 |

Plus three post-1.0.0 patches:
- `367a8bd` daily-batch + batch-missed-watcher + setup-tasks read profile-aware config
- `8edb4d6` paginate hiring.cafe + Playwright direct-URL resolver (Cloudflare bypass)
- `451ba7c` drop Google sign-in, target-driven cross-query stop, /saved command

### v0.5 — shipped 2026-04
**Theme:** "All the user knobs the bot was missing"
Inline weather toggle, role suggester, /jobs add/remove, /yoe, geocoding, file picker, etc.

### v0.4 — shipped 2026-03
**Theme:** "Setup wizard + first non-developer install"
10-step setup wizard, first round of stripped-PATH defenses.

(Older versions: see CHANGELOG.md.)

---

## Active milestone — v1.1

### Theme
Cross-platform (Mac launchd + Linux systemd) + Hardened (zero HIGH bugs from v1.0 review carried forward).

### Phases (see ROADMAP.md for detail)
1. **Hardening** — fix all 9 HIGH REVIEW.md findings before any cross-platform work. *(not started)*
2. **Path abstraction + atomic writes** — `os-paths.mjs`, `io-helpers.mjs`, `proper-lockfile`, missing tests.
3. **Mac launchd port** — `setup-tasks-mac.sh`, shell wrappers, osascript file picker.
4. **Linux systemd port** — `setup-tasks-linux.sh`, shell wrappers, zenity/kdialog file picker.
5. **Code signing** — Microsoft Trusted Signing, Apple notarization, GPG for .deb/.AppImage.
6. **Cross-platform installers + CI** — `.dmg`, `.deb`, `.AppImage`, GitHub Actions matrix on tag push.

### Blocking dependencies
None on Phase 1 directly. Phase 5 has a wall-clock dependency on cert acquisition (Microsoft Trusted Signing approval ~1-3 days; Apple Developer enrollment ~1-3 days) — start those processes during Phase 1 so they're done by the time Phase 5 begins.

---

## Pinned facts (don't re-derive these)

These are the assumptions every v1.1 phase planner should use without re-investigating:

1. **No CRITICAL bugs in v1.0.** REVIEW.md verdict: 0 CRITICAL / 9 HIGH / 14 MEDIUM / 11 LOW. v1.0 is safe to keep running.
2. **Top 3 bug clusters:** HTML injection in batch messages (F-H1), token scrubbing missing in scraper (F-H2), `fs.renameSync` not atomic on NTFS (F-H3).
3. **Cross-platform inventory:** ~25 Win32-binary spawn sites, 3 `.cmd` launchers, 1 `.ps1` setup script, 1 `.iss` installer, 1 `System.Windows.Forms.OpenFileDialog` site. All map cleanly to launchctl + systemd + osascript + zenity/kdialog + .dmg/.deb/.AppImage.
4. **One bundled v1.1 PR.** Per user feedback, all six phases ship from a single `v1.1` branch via one PR to `main`. No per-phase branches.
5. **No new mandatory deps except `proper-lockfile`** (~30 KB, single dep). Everything else builds on Node stdlib.
6. **Single source of truth for version** is still `package.json`. Update-checker reads from it. Bump it only at tag time.
7. **Branding sentinel** is `munyun-*`. New schedule entries on Mac (`com.amm.*.plist`) and Linux (`munyun-*.service`) keep the same prefix where the OS allows it.
8. **`config.json` shape is frozen.** v1.0 E5 introduced multi-profile; v1.1 doesn't change it. `migrateIfNeeded()` already handles v0.x → v1.0; no further migration.
9. **`.planning/` is committed to git.** Per the workflow plan; the user reviews each artifact and merges manually.

---

## Recent change log (most recent first)

| Date | Phase | Action | Outcome |
|---|---|---|---|
| 2026-05-07 | pre-1 | gsd-codebase-mapper × 4 + gsd-code-reviewer ran on AMM v1.0 | Wrote `ARCHITECTURE.md` (592 lines), `STACK.md` (394), `QUALITY.md` (427), `CONCERNS.md` (497), `REVIEW.md` (545). Synthesized v1.1 milestone artifacts. |
| 2026-05-07 | pre-1 | Wrote `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md` | v1.1 milestone scoped, six phases defined |
| 2026-05 | shipped | v1.0.0 + 3 post-release patches merged to `main` | Multi-profile, Inno Setup installer, Cloudflare bypass without auth |

---

## Commands to remember

| What | How |
|---|---|
| Run all tests | `npm test` |
| Run one batch end-to-end | `npm run daily` |
| Restart the bot after editing | `Get-Process node \| Where-Object { ... -match 'telegram-bot' } \| Stop-Process -Force; Start-ScheduledTask -TaskName 'munyun-bot'` |
| Tail bot log | `Get-Content -Wait data/telegram-bot.log` |
| Tail today's batch log | `Get-Content -Wait data/daily-batch-$(Get-Date -Format yyyy-MM-dd).log` |
| Restart watchdog manually | `Start-ScheduledTask -TaskName 'munyun-watchdog'` |

---

*Last updated: 2026-05-07*
