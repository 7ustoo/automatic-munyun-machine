# AMM v1.1 — Requirements

**Milestone:** v1.1 — Cross-platform + Hardened
**Status:** scoped, pre-execution
**Source documents:** `.planning/REVIEW.md` (9 HIGH / 14 MEDIUM / 11 LOW), `.planning/codebase/CONCERNS.md` (10 categories), `.planning/codebase/QUALITY.md` (test gaps), `.planning/codebase/ARCHITECTURE.md` (Win32 coupling inventory), `.planning/codebase/STACK.md` (per-binary porting table)

Each requirement traces to its source finding(s) so the verifier can confirm it shipped.

---

## Track A — Hardening (Phase 1)

### REQ-A1: Fix HTML injection via unescaped `directUrl` (HIGH)
**Source:** REVIEW F-H1
**Where:** `scripts/daily-batch.mjs:756`, `scripts/telegram-bot.mjs:1018, 1194-1195, 1257, 1291`
**What:** Run `escHtml` on every URL interpolated into a Telegram `<a href="...">` interpolation, AND extend `escHtml` (or add `escHtmlAttr`) to escape `"` for attribute contexts. Reject malformed URLs at extraction time in `daily-batch.mjs#resolveOnePage`.
**Done when:** A test fixture with `apply_url` containing `"><b>foo` does not break the Telegram parse OR inject content; the morning batch send succeeds.

### REQ-A2: Add token scrubbing to `daily-batch.mjs` error paths (HIGH)
**Source:** REVIEW F-H2
**Where:** `scripts/daily-batch.mjs:80-110, 957-960`, `scripts/setup-wizard.mjs:108`, `scripts/telegram-send.mjs:29`
**What:** Hoist a shared `SCRUB(s)` helper that does `String(s).replace(TG_TOKEN, '<TOKEN>')`. Apply to every `log()`, every `tg()`/`tgDocument()` throw, every error-message return to user. Wizard's token-validation error path must also scrub.
**Done when:** Grep for `process.env.TELEGRAM_BOT_TOKEN` returns no log/error/print path that doesn't go through the scrubber. A test that injects a sentinel token into an error message confirms the sentinel is scrubbed.

### REQ-A3: Make config + per-profile JSON writes genuinely atomic on NTFS (HIGH)
**Source:** REVIEW F-H3, F-H8, F-M11; CONCERNS §2.1, §2.2
**Where:** `scripts/config-rw.mjs:46-50`, `scripts/profile-store.mjs:56-60`, `scripts/daily-batch.mjs:638` (seen-jobs), `scripts/daily-batch.mjs:837` (last-batch), `scripts/daily-batch.mjs:644-657` (auth-state), `scripts/telegram-bot.mjs:1167` (/forget last seen-jobs), `scripts/callback-router.mjs:113` (callback table)
**What:** Two-pronged.
- Add `atomicWriteJson(path, obj)` to a new `scripts/io-helpers.mjs` with `EPERM`/`EACCES`/`EBUSY` retry loop.
- Pull in `proper-lockfile` (single dep) and wrap every read-modify-write of `config.json` and per-profile JSON files in a `lockfile` advisory lock.
**Done when:** Concurrent-writer integration test (two child processes both calling `cfgRW.set` 100x in parallel) shows zero corruption and all writes account for in the final state. Migration block in `profile-store.mjs#migrateIfNeeded` holds a lock for the duration.

### REQ-A4: HMAC keying must throw, never fallback to `'no-token'` (HIGH)
**Source:** REVIEW F-H4, F-H6
**Where:** `scripts/callback-router.mjs:46`, `scripts/telegram-bot.mjs:104-111`
**What:** `requireToken(token)` throws if `!token || token.length < 10`; `makeCallback`/`parseAndVerify` use it. Bot's `unhandledRejection` / `uncaughtException` scrubber checks `TG_TOKEN` truthiness before calling `replace`.
**Done when:** Unit test asserts `makeCallback('s', 0, '', '')` throws; bot startup-time TG_TOKEN gate is the single source of truth for token presence.

### REQ-A5: `scrape()` and `resolveAll()` close the browser context in `finally` (HIGH)
**Source:** REVIEW F-H5
**Where:** `scripts/daily-batch.mjs:284-301, 675-697`
**What:** Wrap both function bodies in `try { ... } finally { await ctx.close().catch(() => {}); }`. Same for any other `launchBrowser` call site.
**Done when:** A simulated page.goto failure at attempt 3 still produces a clean shutdown — no leaked Chromium process, no `data/browser-profile/Default/Local Storage/leveldb/LOCK` left held.

### REQ-A6: Constant-time HMAC sig compare + action whitelist (MEDIUM, but security-adjacent)
**Source:** REVIEW F-M2, F-M3
**Where:** `scripts/callback-router.mjs:74, 80`
**What:** Replace `sig === expected` with `crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))` (with length-equality guard). Add `KNOWN_ACTIONS` whitelist; reject unknown actions before HMAC compute.
**Done when:** Unit test verifies timing-safe path and action-whitelist rejection.

### REQ-A7: Decay-then-add race fix in `saveSeenStore` (MEDIUM, advertised feature regression)
**Source:** REVIEW F-M5
**Where:** `scripts/daily-batch.mjs:616-639`
**What:** Drop the belt-and-suspenders rewrite of `blockedSet`. Preserve `firstSeenAt` of decayed-but-still-shown jobs by referencing `store.jobs[r.href]` (pre-decay) when populating `fresh[r.href]`.
**Done when:** Unit test simulating a 60-day-old job that's just-decayed and just-shown ends up with the original `firstSeenAt`, not `now`.

### REQ-A8: Fix `addProfile` so a fresh profile inherits a CV (HIGH UX regression)
**Source:** REVIEW F-H9
**Where:** `scripts/profile-store.mjs:128-153`, `scripts/daily-batch.mjs:CV load`
**What:** When `addProfile(slug, opts)` runs, copy `cloneFrom`'s `cv-parsed.json` into the new profile's data dir if present. Add a startup check in `daily-batch.mjs`: if `loadParsedCV()` returns the empty-default sentinel, send a Telegram warning + exit cleanly (don't run a 0-match batch).
**Done when:** `/profile add new --clone-from default` produces a profile that scores jobs immediately after switching; profile-store test covers the case.

### REQ-A9: Other bug fixes from REVIEW MEDIUM band (batched)
**Source:** REVIEW F-M1, F-M4, F-M6, F-M7, F-M9, F-M10, F-M13
**What:** All are short edits, batched in Phase 1. Specifically:
- F-M1: `escHtml(e.message)` in 5 sites in `telegram-bot.mjs:703, 819, 909, 1170` (1427 already correct)
- F-M4: `getScoring()` function instead of module-load const (or document the limitation explicitly)
- F-M6: Anchor watchdog regex to `telegram-bot\.mjs` not bare `telegram-bot`
- F-M7: Watchdog only counts a successful restart toward MAX_RESTARTS
- F-M9: Centralize platform-helper-name strings in user-facing Telegram messages (deferred to Phase 2's `os-paths.mjs`)
- F-M10: Replace silent `catch {}` with `console.error` in profile-store migration + daily-batch tg-failure
- F-M13: Fallback slug for non-Latin `/jobs add` queries

### REQ-A10: Doc drift cleanup
**Source:** REVIEW F-L5; CONCERNS §7
**What:** Three short doc rewrites:
- `daily-batch.mjs:3-13` header (CDP / Miami / 7 queries are all wrong)
- `telegram-bot.mjs:529-534` `/diagnose` reads `seen.jobs` not `seen.ids`; remove the "lands in v1.0 E3" line
- `README.md:3` Miami reference made non-default
- `CLAUDE.md:60` "until v1.x" → "until v2.x" (or remove the migration block; see REQ-A11)
**Done when:** No file references CDP, Miami-as-hardcoded, the v0.x `seen.ids` schema, or "v1.x" as a future version.

### REQ-A11: Remove `career-ops-*` migration block
**Source:** CONCERNS §8.1
**Where:** `scripts/setup-tasks.ps1:40-46`
**What:** Per CLAUDE.md, the block is gated on "leave alone until v1.x." We're now in v1.1. Remove the block entirely.
**Done when:** The block is gone; setup-tasks.ps1 still passes a fresh-install dry-run.

---

## Track B — Cross-platform foundation (Phase 2)

### REQ-B1: `scripts/os-paths.mjs` abstraction layer
**Source:** ARCHITECTURE §10 (Win32 coupling inventory); CONCERNS §1.1
**What:** New module exporting platform-resolved paths and helpers:
- `POWERSHELL`, `CMD_EXE`, `SCHTASKS` (Win32) → `BASH`, `LAUNCHCTL` (Mac) → `BASH`, `SYSTEMCTL_USER` (Linux)
- `LOGIN_HELPER_DOC`, `SETUP_HELPER_DOC` strings used in user-facing Telegram messages
- `INSTALL_DIR_DOC` for "where AMM lives" messaging
- `runScheduledTask(name)` / `disableScheduledTask` / `enableScheduledTask` — abstract scheduler ops
- `npmCmd()` — returns the npm binary appropriate for the current platform
**Done when:** `scripts/telegram-bot.mjs`, `scripts/watchdog.mjs`, `scripts/uninstall.mjs`, `scripts/setup-wizard.mjs`, `scripts/daily-batch.mjs` all import from `os-paths.mjs` instead of doing their own `process.env.SystemRoot` resolution. Existing Windows behavior is bit-for-bit preserved.

### REQ-B2: `scripts/io-helpers.mjs` atomic-write helper
**Source:** REVIEW F-H3, F-H8 (hardening overlap)
**What:** New module exporting `atomicWriteJson(path, obj)` and `atomicWriteText(path, str)`. Used by all per-profile JSON writes (see REQ-A3).
**Done when:** Grep for `fs.writeFileSync(seenPath` returns zero hits; same for `last-batch.json`, `last-batch-callbacks.json`, `auth-state.json`, `query-stats.json`.

### REQ-B3: Add tests for HMAC sig + watchdog + atomic-write
**Source:** QUALITY.md (HIGH gaps); REVIEW F-M14 (phrase-proximity test misnamed)
**What:** Three new test files:
- `scripts/__tests__/callback-router.test.mjs` — sig generation + verification + replay rejection + missing-token throw
- `scripts/__tests__/watchdog.test.mjs` — `pruneRestarts`, `MAX_RESTARTS` throttling, give-up-once semantic, only-count-successful-restart (REQ-A9 F-M7)
- `scripts/__tests__/io-helpers.test.mjs` — concurrent-writer integration test
Plus rename `phrase-proximity.test.mjs` → `daily-batch-shape.test.mjs` and fix the docstring per F-M14 (or implement actual phrase-proximity test by exporting a CV-injection hook).
**Done when:** `npm test` reports >35 tests passing; coverage includes the previously untested critical paths.

---

## Track C — Mac port (Phase 3)

### REQ-C1: `scripts/setup-tasks-mac.sh`
**What:** Bash script that renders four LaunchAgent plists (`com.amm.bot.plist`, `com.amm.daily.plist`, `com.amm.watchdog.plist`, `com.amm.batch-missed.plist`) into `~/Library/LaunchAgents/` and bootstraps them via `launchctl bootstrap gui/$UID/...`. Equivalent to `setup-tasks.ps1` for macOS.
**Done when:** A clean Mac install runs `bash scripts/setup-tasks-mac.sh` and produces four loaded LaunchAgents that fire on schedule.

### REQ-C2: Bash launcher equivalents
**What:** `scripts/start-bot.sh` (replaces `start-bot.cmd`), `scripts/run-daily-batch.sh` (replaces `run-daily-batch.cmd`), `scripts/login-once.sh` (replaces `login-once.cmd`). Each shells out to `node scripts/<target>.mjs` with `set -e` and proper redirection.
**Done when:** All three execute correctly on Mac and Linux; existing `.cmd` files remain for Windows.

### REQ-C3: Mac file picker via `osascript`
**Source:** CONCERNS §1.1 (`file-picker.mjs:11-28`)
**What:** Extend `scripts/file-picker.mjs` to detect `process.platform`. On `darwin`, spawn `osascript -e 'POSIX path of (choose file with prompt "...")'`. Fall back to typed input if osascript unavailable.
**Done when:** `npm run setup` on macOS shows a native file dialog when prompting for the CV.

### REQ-C4: Mac install one-liner
**What:** New top-level `install.sh` (mirrors `install.ps1`). Uses `curl -fsSL <repo-raw>/install.sh | sh` pattern. Detects platform, runs `git clone`, `npm install`, `npx playwright install chromium`, and points the user to `npm run setup`.
**Done when:** A fresh macOS box runs the one-liner and produces a working AMM install.

### REQ-C5: Mac uninstall path
**What:** Extend `scripts/uninstall.mjs` to detect platform; on `darwin` use `launchctl bootout` + `rm ~/Library/LaunchAgents/com.amm.*.plist` instead of `schtasks /delete`.
**Done when:** `node scripts/uninstall.mjs --mode=wipe` on macOS removes all four LaunchAgents and (with --mode=wipe) the data dir.

---

## Track D — Linux port (Phase 4)

### REQ-D1: `scripts/setup-tasks-linux.sh`
**What:** Bash script that renders four systemd user units (`munyun-bot.service`, `munyun-daily.service` + `munyun-daily.timer`, `munyun-watchdog.service` + `munyun-watchdog.timer`, `munyun-batch-missed.service` + `munyun-batch-missed.timer`) into `~/.config/systemd/user/`. Activates via `systemctl --user daemon-reload && systemctl --user enable --now ...`.
**Done when:** A clean Ubuntu/Fedora install runs the script and produces four loaded systemd user units.

### REQ-D2: Linux file picker via zenity/kdialog/typed-input
**What:** Extend `file-picker.mjs` to detect zenity (GTK) or kdialog (KDE); fall back to typed input. Match the macOS pattern.
**Done when:** `npm run setup` on Ubuntu (GNOME) shows a native zenity dialog; on Kubuntu shows kdialog; on a minimal install falls back to typed-input gracefully.

### REQ-D3: Linux install one-liner
**What:** Same `install.sh` as REQ-C4 — single shell script branches by `uname` for any Linux-specific setup (e.g., `apt install` hint if Node is missing).
**Done when:** Fresh Ubuntu 22.04 + Fedora 40 boxes both produce working installs from `curl ... | sh`.

### REQ-D4: Linux uninstall path
**What:** Extend `uninstall.mjs` for `linux`: `systemctl --user disable --now munyun-*.service munyun-*.timer` + remove unit files from `~/.config/systemd/user/`.
**Done when:** `node scripts/uninstall.mjs --mode=wipe` on Linux removes all units and (with --mode=wipe) the data dir.

---

## Track E — Code signing (Phase 5)

### REQ-E1: Windows installer signing
**What:** Sign the Inno Setup `amm-setup-vX.Y.Z.exe` output. Document the cert acquisition path in `docs/SIGNING.md`. Two options:
- **Recommended:** Microsoft Trusted Signing (~$10/month, Azure-based, no hardware token)
- **Alternative:** DigiCert / Sectigo OV cert with USB hardware token (~$300/year)
Add a `.iss` `[Setup]` directive `SignTool=signtool $f` plus a `signtool.exe` invocation script that runs on the maintainer's machine.
**Done when:** Built `.exe` shows "Signed" in Windows Properties; SmartScreen prompt is reduced from "unknown publisher" to a less aggressive warning.

### REQ-E2: macOS notarization
**What:** Notarize the `.dmg` (or `.app` bundle inside) via Apple `notarytool`. Requires an Apple Developer account ($99/year) and an app-specific password. Document in `docs/SIGNING.md`. Add a build step that staples the notarization ticket via `xcrun stapler staple`.
**Done when:** `spctl --assess --type install <amm.dmg>` returns "accepted: Notarized Developer ID".

### REQ-E3: Linux package signing (light-touch)
**What:** Sign `.deb` with `dpkg-sig` and `.AppImage` with the AppImage signing helper using a generated GPG key (no commercial CA needed). Publish the public key alongside the release asset.
**Done when:** `dpkg-sig --verify <amm.deb>` returns "GOODSIG".

---

## Track F — Cross-platform installers + CI (Phase 6)

### REQ-F1: macOS `.dmg` build pipeline
**What:** A `scripts/build/mac.sh` script that uses `hdiutil` to package the source tree (post-`npm install` minus `node_modules` rebuild instructions) into `amm-vX.Y.Z.dmg`. The dmg includes an AppleScript that runs `npm install && npx playwright install chromium && bash scripts/setup-tasks-mac.sh` on first launch.
**Done when:** `bash scripts/build/mac.sh` on a Mac CI runner produces a `.dmg` that installs cleanly into a clean macOS box.

### REQ-F2: Linux `.deb` + `.AppImage` build pipelines
**What:** `scripts/build/deb.sh` (uses `dpkg-deb` with a control file specifying Node ≥18 dep) and `scripts/build/appimage.sh` (uses `appimagetool` with a bundled Node runtime so AppImage works on minimal distros).
**Done when:** Both build scripts produce installable artifacts.

### REQ-F3: GitHub Actions matrix
**What:** `.github/workflows/release.yml` running on tag push (`v*.*.*`):
- Matrix: `windows-latest`, `macos-latest`, `ubuntu-latest`
- Steps: checkout → setup-node → `npm ci` → `npm test` → platform-specific build script → upload artifact to the GitHub Release
- Plus a `.github/workflows/ci.yml` running on every PR: same matrix, lint-light + tests only.
**Done when:** Tagging `v1.1.0-rc1` produces three signed release artifacts as Release assets in <10 minutes.

### REQ-F4: Per-platform smoke tests
**What:** Each platform job in CI runs `node scripts/setup-wizard.mjs --dry-run` (a new flag that exercises the wizard's logic without prompting or persisting). Then runs `node scripts/daily-batch.mjs --dry-run` (existing or new flag) that verifies the scheduler integration without performing a real scrape.
**Done when:** All three matrix legs pass end-to-end on every PR.

---

## Acceptance criteria for v1.1 milestone

The v1.1 milestone is COMPLETE when:

1. All REQ-A items have shipped, verified by passing tests + manual `npm run daily` end-to-end on Windows.
2. All REQ-B items have shipped; existing 24 tests still pass; new tests pass.
3. AMM installs cleanly on a fresh macOS box via `curl ... | sh` and produces a working batch.
4. AMM installs cleanly on a fresh Ubuntu 22.04 box via `curl ... | sh` and produces a working batch.
5. Tagging `v1.1.0` produces three signed release artifacts in the GitHub Release.
6. `CHANGELOG.md` `[1.1.0]` section names every shipped REQ-* and links to the relevant commits.
7. `CLAUDE.md`, `CONTEXT.md`, `README.md` are updated to reflect cross-platform support and the absence of the `career-ops-*` migration block.

---

*Last updated: 2026-05-07*
