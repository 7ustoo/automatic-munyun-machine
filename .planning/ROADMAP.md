# AMM v1.1 — Roadmap

**Milestone:** v1.1 — Cross-platform + Hardened
**Branch:** `v1.1` (single branch; phases ship as atomic commits, not separate branches)
**Phases:** 6
**Estimated effort:** 30-50 maintainer-hours across phases (excluding wall-clock for cert acquisition + Mac/Linux test boxes)

| Phase | Title | Reqs | Phase goal | Success criterion |
|---|---|---|---|---|
| 1 | Hardening | REQ-A1…A11 | Zero HIGH-severity REVIEW.md findings outstanding | All 9 HIGH findings closed; new tests cover the regressions; `npm run daily` end-to-end on Windows still produces a clean batch |
| 2 | Path abstraction + atomic writes | REQ-B1…B3 | Foundation for cross-platform; every spawn flows through `os-paths.mjs`; every per-profile write is atomic-and-locked | All Win32-binary spawns import from `os-paths.mjs`; concurrent-writer test passes; HMAC + watchdog tests added |
| 3 | Mac launchd port | REQ-C1…C5 | AMM installs and runs on macOS | Clean macOS box: `curl ... \| sh` → setup wizard → batch fires at scheduled time → Telegram delivery succeeds |
| 4 | Linux systemd port | REQ-D1…D4 | AMM installs and runs on Ubuntu + Fedora | Clean Ubuntu 22.04 box: same flow as Phase 3 succeeds |
| 5 | Code signing | REQ-E1…E3 | Reduced-warning installs across all three platforms | Windows SmartScreen no longer says "unknown publisher"; macOS Gatekeeper says "notarized"; Linux `.deb` verifies against the published GPG key |
| 6 | Cross-platform installers + CI | REQ-F1…F4 | Tagging produces signed binaries on all three platforms via GitHub Actions | `git tag v1.1.0 && git push --tags` → three signed Release assets uploaded automatically; per-PR CI passes on all three matrix legs |

---

## Phase 1 — Hardening

**Why first:** every HIGH-severity bug carries forward into 3x the surface area once Mac+Linux ports land. Fix on Windows where every existing test runs, then carry the fixes into the cross-platform abstraction.

### Requirements
- REQ-A1 (HTML injection)
- REQ-A2 (token scrubbing in scraper)
- REQ-A3 (atomic writes — partial; full version in Phase 2)
- REQ-A4 (HMAC fallback removal)
- REQ-A5 (browser context cleanup)
- REQ-A6 (constant-time HMAC compare)
- REQ-A7 (decay-then-add race fix)
- REQ-A8 (addProfile copies CV)
- REQ-A9 (batched MEDIUM fixes — F-M1, F-M4, F-M6, F-M7, F-M10, F-M13)
- REQ-A10 (doc drift)
- REQ-A11 (remove career-ops migration block)

### Out of scope for Phase 1
- F-M9 (centralized platform-helper strings) — deferred to Phase 2 where `os-paths.mjs` lands
- F-M14 (rename/refactor `phrase-proximity.test.mjs`) — deferred to Phase 2 with the rest of the test work

### Success criterion
A re-run of the gsd-code-reviewer agent on the Phase 1 commit returns:
- 0 CRITICAL, 0 HIGH (down from 0/9)
- ≤8 MEDIUM (down from 14)
- LOW count unchanged or reduced

Plus: `npm run daily` on Windows produces a batch with no observable regression vs. v1.0.

### Estimated effort
6-10 hours. Most of these are surgical edits in the 1-10-line range. F-M14 (real phrase-proximity test) is the one that requires a refactor (export a CV-injection hook in `daily-batch.mjs`); it's deferred to keep Phase 1 focused.

---

## Phase 2 — Path abstraction + atomic-write layer

**Why second:** Phase 3-4 (Mac/Linux ports) need both `os-paths.mjs` (so they don't have to re-derive POSIX paths in every script) and `io-helpers.mjs` (so the per-profile write hardening from Phase 1 lands once instead of being re-done in each ported script). This phase makes Phase 3-4 a series of tiny changes instead of large rewrites.

### Requirements
- REQ-B1 (`os-paths.mjs`)
- REQ-B2 (`io-helpers.mjs` + `proper-lockfile`)
- REQ-B3 (HMAC + watchdog + io-helpers tests)
- F-M9 (rolled in: centralized platform-helper strings)
- F-M14 (rolled in: real phrase-proximity test or rename)

### Specific deliverables
1. `scripts/os-paths.mjs` exports:
   - `POWERSHELL`, `CMD_EXE`, `SCHTASKS` (Win32 only)
   - `LAUNCHCTL`, `OSASCRIPT` (darwin only)
   - `SYSTEMCTL_USER`, `ZENITY`, `KDIALOG` (linux only)
   - Cross-platform: `npmCmd()`, `nodeCmd()`, `shellCmd()`
   - User-facing string helpers: `LOGIN_HELPER_DOC`, `SETUP_HELPER_DOC`, `INSTALL_DIR_DOC`
   - Scheduler abstractions: `runScheduledTask(name)`, `disableScheduledTask(name)`, `enableScheduledTask(name)`, `scheduledTaskExists(name)`
2. `scripts/io-helpers.mjs` exports:
   - `atomicWriteJson(path, obj)` — temp+rename with EPERM/EACCES/EBUSY retry
   - `atomicWriteText(path, str)` — same for text
   - `withFileLock(path, fn)` — `proper-lockfile` wrapper for read-modify-write of config.json and per-profile files
3. `package.json` adds `proper-lockfile` to dependencies
4. Three new test files in `scripts/__tests__/`:
   - `callback-router.test.mjs`
   - `watchdog.test.mjs`
   - `io-helpers.test.mjs`
5. All call sites in `daily-batch.mjs`, `telegram-bot.mjs`, `watchdog.mjs`, `uninstall.mjs`, `setup-wizard.mjs`, `profile-store.mjs`, `config-rw.mjs`, `callback-router.mjs` migrated to the new helpers.

### Success criterion
- Grep for `process.env.SystemRoot` returns hits ONLY in `os-paths.mjs`
- Grep for `fs.renameSync` (in user code, not deps) returns hits ONLY in `io-helpers.mjs` and `profile-store.mjs#migrateIfNeeded`
- Grep for `fs.writeFileSync(...JSON.stringify` returns zero hits outside `io-helpers.mjs`
- `npm test` reports ≥35 passing tests
- `npm run daily` on Windows produces a batch with no observable regression

### Estimated effort
8-12 hours.

---

## Phase 3 — Mac launchd port

### Requirements
- REQ-C1 (`setup-tasks-mac.sh`)
- REQ-C2 (`.sh` launcher trio)
- REQ-C3 (osascript file picker)
- REQ-C4 (`install.sh` one-liner)
- REQ-C5 (Mac uninstall path)

### Specific deliverables
1. `scripts/setup-tasks-mac.sh` — bash script with embedded plist heredocs for the four LaunchAgents
2. `scripts/start-bot.sh`, `scripts/run-daily-batch.sh`, `scripts/login-once.sh`
3. `scripts/file-picker.mjs` extended with darwin/linux branches
4. `install.sh` at repo root (mirror of `install.ps1`)
5. `scripts/uninstall.mjs` extended with darwin branch (launchctl bootout + plist rm)
6. `scripts/setup-wizard.mjs` extended to spawn `setup-tasks-mac.sh` on darwin instead of `setup-tasks.ps1`
7. `README.md` updated with Mac install instructions

### Success criterion
On a clean macOS 14+ box (intel and arm64 both verified):
- `curl -fsSL https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.sh | sh` succeeds
- `npm run setup` produces a working config with native `osascript` file picker
- Four LaunchAgents loaded; `launchctl list | grep amm` shows all four
- Scheduled batch fires at the configured time and delivers via Telegram

### Estimated effort
8-12 hours (driven by Mac box availability + plist iteration).

---

## Phase 4 — Linux systemd port

Mirrors Phase 3 with systemd-specific units.

### Requirements
- REQ-D1 (`setup-tasks-linux.sh`)
- REQ-D2 (zenity/kdialog file picker)
- REQ-D3 (`install.sh` Linux branch — single file with platform branches)
- REQ-D4 (Linux uninstall path)

### Specific deliverables
1. `scripts/setup-tasks-linux.sh` with embedded `.service` + `.timer` units for all four jobs
2. `file-picker.mjs` extended with zenity/kdialog/typed-input fallback
3. `install.sh` Linux branch
4. `uninstall.mjs` linux branch
5. `setup-wizard.mjs` extended

### Success criterion
On clean Ubuntu 22.04 + Fedora 40 boxes:
- One-liner install succeeds
- `systemctl --user list-units 'munyun-*'` shows four loaded units
- Scheduled batch fires and delivers

### Estimated effort
6-10 hours (lighter than Phase 3 because most plumbing is shared).

---

## Phase 5 — Code signing

### Requirements
- REQ-E1 (Windows .exe signing)
- REQ-E2 (macOS notarization)
- REQ-E3 (Linux .deb / .AppImage GPG signing)

### Specific deliverables
1. `docs/SIGNING.md` — cert acquisition path for each platform, key rotation procedure, what happens when the cert expires
2. `scripts/build/sign-windows.ps1` — `signtool sign /tr ... /td sha256 /fd sha256` invocation
3. `scripts/build/notarize-mac.sh` — `notarytool submit --apple-id ... --wait` + `xcrun stapler staple`
4. `scripts/build/sign-linux.sh` — `dpkg-sig --sign builder`, AppImage signing
5. Pre-shipped public GPG key at `keys/amm-release.gpg`
6. CI integration deferred to Phase 6

### Success criterion
- Locally-built `.exe` shows "Signed" in Windows Properties dialog
- Locally-built `.dmg` passes `spctl --assess --type install` as "Notarized Developer ID"
- Locally-built `.deb` verifies against `keys/amm-release.gpg`

### Estimated effort
**Wall-clock dependent.** Microsoft Trusted Signing setup: 1-3 days for verification. Apple Developer enrollment + first notarization: 1-2 days. GPG keypair gen + CI integration: 30 minutes. Maintainer-hours: 4-8.

---

## Phase 6 — Cross-platform installers + CI

### Requirements
- REQ-F1 (.dmg build)
- REQ-F2 (.deb + .AppImage build)
- REQ-F3 (GitHub Actions matrix)
- REQ-F4 (per-platform smoke tests)

### Specific deliverables
1. `scripts/build/mac.sh` — `hdiutil`-based `.dmg` builder with embedded post-install AppleScript
2. `scripts/build/deb.sh` — `dpkg-deb` builder
3. `scripts/build/appimage.sh` — `appimagetool` builder with bundled Node runtime
4. `.github/workflows/ci.yml` — per-PR matrix (windows-latest, macos-latest, ubuntu-latest); steps: checkout → setup-node → `npm ci` → `npm test` → smoke-test
5. `.github/workflows/release.yml` — on tag push: matrix → build platform-specific artifact → invoke signing script (with secrets in GH Actions) → upload to Release
6. `--dry-run` flag added to `setup-wizard.mjs` and `daily-batch.mjs` for the smoke tests (per REQ-F4)
7. `README.md` updated with per-platform install one-liners + checksum verification instructions

### Success criterion
- `git tag v1.1.0 && git push --tags` produces three signed release artifacts in the GitHub Release within 15 minutes
- A fresh PR runs the matrix and all three legs pass within 10 minutes
- Each artifact, downloaded and run on a clean box of the matching platform, produces a working AMM install

### Estimated effort
6-10 hours.

---

## Phase dependency graph

```
1 ──► 2 ──► 3 ──► 5 ──► 6
            │
            └──► 4 ──┘
```

- Phase 2 depends on Phase 1 (atomic-write helpers extend the F-H3/F-H8 fixes)
- Phase 3 and Phase 4 are independent of each other; can run in parallel if maintainer has both Mac and Linux test boxes
- Phase 5 depends on Phases 3+4 (need the platform installers to sign them)
- Phase 6 depends on Phases 3+4+5 (matrix needs the build scripts and signing scripts to exist)

In practice: ship sequentially 1→2→3→4→5→6 to keep commits coherent and the v1.1 PR reviewable.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Microsoft Trusted Signing approval delays | Start Phase 5 cert acquisition during Phase 1; cert can be in-flight while bug-fix work proceeds |
| Apple Developer enrollment requires phone-based ID verification (1-3 days) | Same — start enrollment during Phase 1 |
| `proper-lockfile` doesn't work on a network-mounted home dir on Linux | Document as known limitation; fall back to flock(2)-based lock if available; AMM is local-first so this is rare |
| Tester has no Mac box | Use GitHub Actions macos-latest runner for all Phase 3 verification; final manual test on borrowed hardware before tagging |
| Tester has no Linux box | Same — use ubuntu-latest runner; manually verify on a Ubuntu 22.04 VM (free via Multipass on the maintainer's Windows machine) |
| `proper-lockfile` adds a single new dep — supply chain risk | Pin to exact version in package.json; vendor if necessary; the alternative (rolling our own with mkdir-based lock) is buggy enough that the dep is the safer choice |
| Cross-platform commit volume bloats the v1.1 PR beyond reviewability | Keep commits atomic + topical; each REQ-* lands as 1-3 commits; PR description links REQ-* IDs to commit hashes |
| Per-profile multi-process tests are flaky on Windows due to AV scanning | Document the retry strategy; use a unique tmp-file suffix (PID + timestamp) to reduce collision; AV-skip the test directory in CI |

---

*Last updated: 2026-05-07*
