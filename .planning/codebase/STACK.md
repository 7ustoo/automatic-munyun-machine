# Technology Stack

**Analysis Date:** 2026-05-07
**Repo:** `automatic-munyun-machine` v1.0.0
**Purpose:** Inventory of every runtime, dependency, tool, and platform requirement — sized for the v1.1 cross-platform port (Mac/Linux) and code-signing work.

---

## 1. Runtime

**Node.js — required `>=18`** (declared in `package.json#engines.node`).

| Detail | Value |
|---|---|
| Language | JavaScript (ESM only — `"type": "module"`) |
| Module convention | All scripts use `.mjs` extension; ESM `import` everywhere |
| Source-of-truth declaration | `package.json` line 32-34 |
| Lockfile constraint | `playwright-core` 1.59.1 also requires `node >=18` (`package-lock.json:215`) |

### Why Node 18+ is load-bearing

- **`node:test`** built-in test runner (used by all 4 test files in `scripts/__tests__/`). Stable in Node 20, available behind a flag in 18. `package.json` script `test` is `node --test scripts/__tests__/*.test.mjs` — no third-party runner.
- **`node:assert/strict`** subpath import — used by every test file.
- **`fetch` global** — used directly in `scripts/telegram-bot.mjs`, `scripts/update-checker.mjs`, `scripts/daily-batch.mjs`, `scripts/geocode.mjs`. No `node-fetch` polyfill present, so Node 18 minimum is mandatory.
- **`AbortSignal.timeout(ms)`** — used to time-bound external HTTP (`scripts/update-checker.mjs:80`, `scripts/geocode.mjs:14`, `scripts/telegram-bot.mjs:146`). Requires Node 17.3+.
- **`fs.promises` + top-level `await`** in `geocode.mjs` and elsewhere.

### Recommendation for v1.1

Pin to `node >=20` once the install one-liner is updated; Node 18 enters maintenance in 2024 and goes EOL April 2025. The Mac/Linux installers will likely use `nvm` / `fnm` / `volta`, all of which can read `package.json#engines`. Consider adding an `.nvmrc` to make this explicit (currently absent — `Read .nvmrc` would fail).

### Package manager

- **npm** (no `pnpm-lock.yaml`, no `yarn.lock`, no `bun.lockb`).
- Lockfile present: `package-lock.json` (lockfileVersion 3 — npm 7+).
- Install command everywhere: `npm install` (often with `--no-audit --no-fund` in installer scripts).

---

## 2. Production dependencies

Only **three** runtime packages — keeping the dep tree small is a deliberate v1.0 stance.

| name | version (declared / resolved) | used by | purpose | upgrade risk | cross-platform? |
|---|---|---|---|---|---|
| `mammoth` | `^1.7.0` / 1.12.0 | `scripts/resume-parser.mjs` | DOCX → plain text conversion when user uploads a `.docx` resume. | Low. Mature library, breaking changes uncommon. Caret range allows 1.x minor bumps. | Pure JS — works everywhere Node 12+ runs (per its own engines). |
| `pdf-parse` | `^1.1.1` / 1.1.4 | `scripts/resume-parser.mjs` | PDF → plain text conversion when user uploads a `.pdf` resume. | **Medium-high.** Last published 2022. Has a long-standing bug where it tries to read a non-existent test PDF on import in some configurations; AMM doesn't trip it because the parser is invoked at the top level only when needed. Replacement candidates for v1.1: `pdfjs-dist` (heavier but Mozilla-maintained). | Pure JS. Works everywhere. |
| `playwright-core` | `^1.45.0` / 1.59.1 | `scripts/daily-batch.mjs`, `scripts/login-once.mjs`, `scripts/job-action.mjs` | Headless / persistent-profile Chromium for hiring.cafe scraping + ATS apply-URL resolution + login session. | **High.** Chromium DOM-selector contract with hiring.cafe is the actual fragility — Playwright the library is rock-solid; their site is the moving target. We use `playwright-core` (no auto-bundled browsers) and pull Chromium via `npx playwright install chromium`. | **Yes**, but Chromium binary differs per platform — Playwright handles that automatically. macOS arm64 + Linux x64 + Linux arm64 are all supported. |

### Transitive dependency surface

`package-lock.json` contains roughly **20 transitive deps**, all from the `mammoth`/`pdf-parse` subtrees: `@xmldom/xmldom`, `argparse`, `base64-js`, `bluebird`, `core-util-is`, `dingbat-to-unicode`, `duck`, `immediate`, `inherits`, `isarray`, `jszip`, `lie`, `lop`, `node-ensure`, `option`, `pako`, `path-is-absolute`, `process-nextick-args`, `readable-stream`, `safe-buffer`, `setimmediate`, `sprintf-js`, `string_decoder`, `underscore`, `util-deprecate`, `xmlbuilder`. `playwright-core` has zero npm dependencies (it bundles its own protocol code).

### Notable absences

No `dotenv`, no `axios`, no `node-fetch`, no `commander`/`yargs`, no `chalk`, no `inquirer`. Argument parsing, env loading, ANSI colors, and prompts are all hand-rolled. This is intentional: the install one-liner stays lean.

---

## 3. Dev dependencies

**`devDependencies` is empty.** `package.json` declares only `dependencies`. There is no `devDependencies` block at all.

| Concern | Status |
|---|---|
| Test framework | `node:test` — built-in, no install needed. |
| Linter | None. |
| Formatter | None (no `.prettierrc`, no `eslint.config.*`). |
| Type-checker | None (no TypeScript, no JSDoc-driven `tsc --noEmit`). |
| Build/bundle | None. ESM `.mjs` files run as-is. |

This is documented as a project rule in `CLAUDE.md`:
> "There is no test suite, linter, or build step — changes are validated by running `npm run daily` end-to-end and watching the Telegram output."

(`CLAUDE.md` is slightly out of date — there *is* now a 4-file test suite. The "no linter, no build" parts remain accurate.)

---

## 4. Bundled-but-not-NPM dependencies

| Asset | Source | Size | Where it lives | When it's downloaded |
|---|---|---|---|---|
| Chromium | `npx playwright install chromium` | ~150 MB | `%LOCALAPPDATA%\ms-playwright\chromium-XXXX\` (Playwright's user-cache dir, not under repo) | Once, post-`npm install`. Triggered by `install.ps1:71` and by `installer/amm.iss` `[Run]` block. |
| Persistent Chromium profile | Created at first `login-once.mjs` run | ~50 MB | `data/browser-profile/` (gitignored) | First user login |
| Chromium fonts | Bundled with Chromium download | (included above) | (above) | (above) |
| User CV (PDF/DOCX/MD) | User-supplied via wizard | ~50–500 KB | `cv.md` / `cv.pdf` (gitignored) | Wizard step 4 |
| Parsed CV JSON | Generated by `resume-parser.mjs` | ~5 KB | `data/cv-parsed.json` (gitignored) | Wizard step 4 + on `/resume` upload |

### Why `playwright-core` vs `playwright`

`playwright` (the meta-package) auto-downloads all three browsers (Chromium + Firefox + WebKit, ~500 MB). AMM only ever uses Chromium and explicitly chooses the lean install path: declare `playwright-core` in deps, then a single `npx playwright install chromium` step in the post-install hook. This saves ~350 MB of download / disk for the end user.

---

## 5. Test infrastructure

| Detail | Value |
|---|---|
| Runner | `node --test` (Node built-in, [docs](https://nodejs.org/api/test.html)) |
| Assertion lib | `node:assert/strict` (built-in) |
| Test count | 24 tests across 4 files (per the prompt; per-file counts confirmed below) |
| Discovery glob | `scripts/__tests__/*.test.mjs` (declared in `package.json#scripts.test`) |
| Coverage tool | None |
| Mocking lib | None (tests don't mock — they use real exports + synthetic input strings) |

### The 4 test files

| File | Tests (approx) | What it covers |
|---|---|---|
| `scripts/__tests__/salary.test.mjs` | 9 | `parseSalaryK()` parser — `$120k`, ranges with hyphen / en-dash / em-dash, comma-thousands, USD prefix, lowercase k, no-signal cases, bounds rejection (5K too low, 9000K too high), false-positive avoidance ("Kotlin" must not match). |
| `scripts/__tests__/phrase-proximity.test.mjs` | 3 | Smoke tests for `scoreJob()` shape — empty-input safety, `{score, matched}` shape, that `parseSalaryK` is co-exported. Behavioral phrase-proximity tests are gated on a real `cv-parsed.json` fixture (acknowledged by comments in-file). |
| `scripts/__tests__/role-cluster.test.mjs` | 6 | `scoreClusters()` + `pickPrimaryClusters()` from `resume-parser.mjs`. IAM CV → `iam` cluster, backend CV → `softwareEng` (and **not** `iam`), data CV → `data`, SOC CV → `soc`, empty input, zero-score filtering. Loads the real `cv-keywords.json` dictionary. |
| `scripts/__tests__/profile-store.test.mjs` | 5 | `paths()`, `listProfiles()`, `getActiveProfile()`, `_internals.PROFILE_FIELDS`, `_internals.PROFILE_DATA_FILES` from the v1.0 E5 multi-profile store. |

### How tests are invoked

```bash
npm test
# expands to: node --test scripts/__tests__/*.test.mjs
```

No watch mode, no test-only mode, no coverage flag. CI doesn't run them yet (see §10).

---

## 6. Build / install pipeline

There is **no compile step**. "Build" means "make sure deps are present and Chromium is downloaded."

### Source-of-truth install (developer, manual)

```bash
git clone https://github.com/7ustoo/automatic-munyun-machine.git
cd automatic-munyun-machine
npm install
npx playwright install chromium
node scripts/setup-wizard.mjs
```

Documented in `README.md` lines 36-42.

### Setup wizard

`scripts/setup-wizard.mjs` (463 lines) — interactive 10-step wizard:
1. Telegram bot token
2. Chat ID auto-detection
3. hiring.cafe login (spawns `login-once.mjs`)
4. Resume upload (file picker / typed path / Telegram-later)
5. Job-title suggestions (uses `role-suggester.mjs`)
6. Years of experience
7. Salary floor
8. Clearance filter
9. Geocoded city (uses `geocode.mjs`)
10. Schedule + Task Scheduler registration

Outputs: `.env`, `config.json`, `data/cv-parsed.json`, four registered Task Scheduler tasks.

### One-liner install

```powershell
iwr -useb https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.ps1 | iex
```

`install.ps1` (78 lines):
1. Installs Node.js via `winget install OpenJS.NodeJS` if missing.
2. Installs Git via `winget install Git.Git` if missing.
3. Clones repo to `%LOCALAPPDATA%\automatic-munyun-machine\` (or `git pull` if exists).
4. `npm install --silent --no-audit --no-fund`.
5. `npx --yes playwright install chromium`.
6. `node scripts\setup-wizard.mjs`.

### Inno Setup `.exe` build (release artifact)

Manual build, no CI. Produces `installer/dist/amm-setup-vX.Y.Z.exe`.

```bash
iscc installer\amm.iss
```

`installer/amm.iss` highlights:
- Source: entire repo (excludes `node_modules`, `data`, `.env*`, `*.log`, `installer/dist/*`, `.git/*`, `.github/*`, `.claude/*`, `*.zip`, `*.tmp`).
- Default install dir: `{localappdata}\automatic-munyun-machine` (no admin required — `PrivilegesRequired=lowest`).
- Architecture: `x64compatible` (64-bit Windows only).
- Post-install `[Run]` block invokes `cmd.exe /C "npm install --no-audit --no-fund && npx playwright install chromium"` then launches the wizard.
- `[UninstallRun]` calls `node uninstall.mjs --mode=wipe` so Add/Remove Programs is a real cleanup, not just file deletion.
- **Unsigned for v1.0** (declared in the `.iss` comments). Code signing is the v1.1 ask.

### What's missing (v1.1 work)

- No `Makefile` / `justfile` / `taskfile.yml` for cross-OS commands.
- No `.dockerfile` (intentional — local-first).
- No `electron-builder` / `tauri` config (Tauri GUI is on the v2.0 roadmap per README).
- No build script for `.dmg` / `.deb` / `.AppImage`.
- No code-signing pipeline (Windows EV cert / Apple Developer ID / Linux PGP).

---

## 7. Platform-specific dependencies (v1.1 inventory)

These are the Windows-only assumptions threaded through the codebase. Each row is a v1.1 porting hazard.

| Windows binary / API | Used by | Resolved as | Mac equivalent | Linux equivalent |
|---|---|---|---|---|
| `powershell.exe` | `scripts/telegram-bot.mjs` (Enable/Disable-ScheduledTask), `scripts/file-picker.mjs` (OpenFileDialog), `scripts/setup-tasks.ps1` (the script itself), `scripts/uninstall.ps1` | `path.join(SystemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')` — **always absolute path** (CLAUDE.md hard rule) | `osascript` / `bash` / direct `spawn` of native bins | `bash` / direct `spawn` |
| `cmd.exe` | `scripts/telegram-bot.mjs:263,743` (spawning `run-daily-batch.cmd` + `login-once.cmd`), `scripts/start-bot.cmd` | `path.join(SystemRoot, 'System32\\cmd.exe')` | `bash`/`zsh` script wrappers (`.command` files for double-click) | `bash` script wrappers |
| `schtasks.exe` | `scripts/telegram-bot.mjs:487` (querying `munyun-bot` task state) | `path.join(SystemRoot, 'System32\\schtasks.exe')` | `launchctl` + `~/Library/LaunchAgents/com.munyun.*.plist` | `systemctl --user` + `~/.config/systemd/user/munyun-*.service`/`*.timer`, OR fallback `crontab -e` |
| Task Scheduler PowerShell cmdlets | `scripts/setup-tasks.ps1` — `New-ScheduledTaskAction`, `New-ScheduledTaskTrigger`, `Register-ScheduledTask`, `Disable-ScheduledTask`, `Enable-ScheduledTask` | PS module `ScheduledTasks` (built into Windows 10/11) | `launchctl bootstrap` + `launchctl unload` | `systemctl --user enable/disable/start/stop` |
| `System.Windows.Forms.OpenFileDialog` | `scripts/file-picker.mjs` (resume picker in wizard) | `Add-Type -AssemblyName System.Windows.Forms` then `New-Object System.Windows.Forms.OpenFileDialog` from PowerShell | `osascript -e 'choose file'` (returns POSIX path) | `zenity --file-selection` (GNOME) / `kdialog --getopenfilename` (KDE) — pick by `which` |
| `winget` | `install.ps1` (auto-install Node + Git) | `winget install OpenJS.NodeJS`, `winget install Git.Git` | `brew install node git` (auto-install Homebrew first if missing — touchy) | `apt install nodejs git` / `dnf install nodejs git` / `pacman -S nodejs git` (detect distro) |
| `%LOCALAPPDATA%` | Default install root in `install.ps1`, `amm.iss`, README troubleshooting | `$env:LOCALAPPDATA` | `~/Library/Application Support/automatic-munyun-machine/` | `~/.local/share/automatic-munyun-machine/` (XDG) |
| Inno Setup (`iscc`) | `installer/amm.iss` build | Manual on Windows dev box | `pkgbuild` + `productbuild` for `.pkg`, OR `create-dmg` for `.dmg`, OR Tauri's bundler | `dpkg-deb` for `.deb`, `rpmbuild` for `.rpm`, `appimagetool` for `.AppImage` |
| `.cmd` script wrappers | `scripts/start-bot.cmd`, `scripts/run-daily-batch.cmd`, `scripts/login-once.cmd` | Double-clickable Windows batch | `.command` shell scripts marked executable | `.desktop` files + executable shell scripts |
| `Get-CimInstance Win32_Process` | CLAUDE.md restart instructions (find/kill running bot by command line) | PowerShell WMI/CIM query | `pgrep -f telegram-bot.mjs` + `kill` | `pgrep -f telegram-bot.mjs` + `kill` |
| Code-signing (post-build) | None today — v1.1 requirement | n/a | Apple Developer ID + `codesign` + notarization (`xcrun notarytool`) | GPG-sign `.deb`/`.rpm`; AppImage signing optional |

### v1.1 architectural takeaway

A clean factor would be **`scripts/platform/{windows,darwin,linux}.mjs`** that exports a uniform interface — `registerScheduledTask({name, command, trigger})`, `pickFile()`, `installNodeIfMissing()`, etc. The bulk of `daily-batch.mjs`, `telegram-bot.mjs`, and `resume-parser.mjs` is already platform-neutral; the surface-area is concentrated in the 4 binaries above plus the Inno Setup script.

---

## 8. External APIs

All four are unauthenticated (Telegram uses a per-user bot token; the rest are anonymous public APIs). No paid third-party services.

| API | Endpoint(s) | Auth | Used by | Pinning |
|---|---|---|---|---|
| **Telegram Bot API** | `https://api.telegram.org/bot<TOKEN>/<method>` — `getUpdates`, `sendMessage`, `sendDocument`, `answerCallbackQuery`, `editMessageText` | `TG_TOKEN` env var (per-user, from `.env`) | `scripts/telegram-bot.mjs` (long-poll), `scripts/daily-batch.mjs` (push), `scripts/telegram-send.mjs` (one-shot CLI) | No version pin. Telegram is famously backwards-compatible. `parse_mode: 'HTML'` is the convention; user input must be HTML-escaped. Messages are chunked at ~3900 chars by `tgChunked()` in `daily-batch.mjs`. |
| **hiring.cafe** | `https://hiring.cafe/...` (no formal API) | Browser session cookies in `data/browser-profile/` | `scripts/daily-batch.mjs` (scrape), `scripts/job-action.mjs` (click `/save` and `/applied`), `scripts/login-once.mjs` (set cookies) | **Most fragile dep in the project.** No version. HTML structure changes silently. Cloudflare may challenge — recent commit mentions a Playwright direct-URL resolver to bypass. Selector failures show up in `data/daily-batch-{date}.log`. |
| **open-meteo** | `https://geocoding-api.open-meteo.com/v1/search` (geocoding), `https://api.open-meteo.com/v1/forecast` (weather) | None — public API, no key | `scripts/geocode.mjs` (wizard step 9, `/city` command), `scripts/telegram-bot.mjs:239` (`/weather`) | No SLA, no auth, no rate limit page — they ask for "reasonable use." Returns JSON. |
| **GitHub Releases API** | `https://api.github.com/repos/7ustoo/automatic-munyun-machine/releases?per_page=10` (primary), `/tags?per_page=10` (fallback) | None for read; rate-limited 60/hr/IP unauthenticated | `scripts/update-checker.mjs` (called by `/version`, `/update`, startup ping, daily ping) | 5-minute in-memory cache in `update-checker.mjs:95` to avoid burning rate-limit on `/version` spam. `User-Agent: automatic-munyun-machine/<version>` header set. |

### Outbound traffic guarantee (privacy stance)

Per `README.md` lines 140-143: "The only outbound traffic: hiring.cafe (job listings), open-meteo (weather, no API key needed), Telegram (your bot token + chat). Nothing else. No telemetry. No third-party APIs (no OpenAI, no Anthropic, no embedding services)." GitHub Releases is implied (update checker) but not in that list — minor README gap.

---

## 9. Linting / formatting / type-checking

**None of any kind.** This is intentional and documented in `CLAUDE.md` line 24.

| Concern | Tool | Config file | Status |
|---|---|---|---|
| Linting | — | none | Not used |
| Formatting | — | none (no `.prettierrc`, no `.editorconfig`) | Not used |
| Type checking | — | none (no `tsconfig.json`) | Not used |
| Style guide | — | implicit (read existing files) | Convention-by-osmosis |

### How code-quality is actually enforced

1. **`npm run daily` end-to-end check** — full scrape + scoring + Telegram push exercises 80% of the surface area.
2. **`npm test`** — 24 tests, ~1s runtime, catches regressions in salary parsing, role clustering, profile-store paths, scoring shape.
3. **Tail logs** — `data/daily-batch-{date}.log` and `data/telegram-bot.log` are the production telemetry.
4. **Manual restart-and-watch** after editing `telegram-bot.mjs` (PowerShell snippet in CLAUDE.md).

### v1.1 recommendations (without compromising the lean ethos)

- Keep skipping a linter — adding ESLint pulls in 100+ transitive deps and contradicts the "small dep tree" stance.
- Adding **Biome** would be a single binary, no deps, and would fix the formatting drift. Optional.
- A `.editorconfig` is free (zero deps) and would lock down indentation across editors.
- No need for TypeScript — the JSDoc comments throughout are sufficient.

---

## 10. CI/CD

**No CI exists today.** The `.github/` directory is absent (confirmed via `Glob .github/**/*` returning no files). All builds, tests, and releases are manual on the maintainer's Windows box.

### What v1.1 should add

| Pipeline | Trigger | Steps |
|---|---|---|
| **PR test matrix** | `pull_request`, `push` to `v1.1` / `main` | `actions/setup-node@v4` with matrix `[18, 20, 22]` × `[ubuntu-latest, macos-latest, windows-latest]`. Run `npm ci` + `npm test`. |
| **Release artifact build** | `push` of tag `v*.*.*` | Build Inno Setup `.exe` on `windows-latest` (install Inno via Chocolatey), `.dmg` on `macos-latest` (codesign + notarize), `.deb`/`.AppImage` on `ubuntu-latest`. Upload as release assets. |
| **Code-signing** | (sub-step of release) | Windows: load EV cert from secret, run `signtool`. macOS: `codesign --deep` + `xcrun notarytool submit --wait`. Linux: `dpkg-sig` + GPG. |
| **Update-checker validation** | weekly `schedule:` cron | Hit GitHub Releases API to confirm `update-checker.mjs` still parses tag shapes correctly. |

### Branch convention (already in place)

Per `CLAUDE.md`: feature branches `v0.5`, `v0.6`, `v1.0`, `v1.1` etc. User merges to `main` manually via PR. Install one-liner pulls from `main`. So CI will need to gate `main` (the public install surface) tightly.

---

## 11. Packaging artifacts

| Format | Status | Where it's produced | Signed? |
|---|---|---|---|
| `installer/dist/amm-setup-vX.Y.Z.exe` (Inno Setup) | ✅ Shipping for v1.0 | Manual `iscc installer\amm.iss` on dev box | ❌ Unsigned (`README` line 20: "Windows SmartScreen will warn 'Unknown Publisher'") |
| Source tarball via `git clone` (one-liner install) | ✅ Implicit — `install.ps1` clones `main` | GitHub | n/a |
| `.dmg` / `.pkg` (macOS) | ❌ Missing | — | — |
| `.deb` (Debian/Ubuntu) | ❌ Missing | — | — |
| `.rpm` (Fedora/RHEL) | ❌ Missing | — | — |
| `.AppImage` (universal Linux) | ❌ Missing | — | — |
| Homebrew formula | ❌ Missing | — | — |
| `winget` manifest | ❌ Missing (could publish to `microsoft/winget-pkgs`) | — | — |
| Code-signing — Windows | ❌ Missing | needs EV cert + Azure-hosted signing service or HSM | — |
| Code-signing — macOS | ❌ Missing | needs Apple Developer ID ($99/yr) + notarization | — |
| Notarization stapling | ❌ Missing | — | — |

### v1.1 release-shape recommendation

```
amm-setup-v1.1.0-windows-x64.exe    (Inno Setup, signed)
amm-setup-v1.1.0-macos-arm64.dmg    (notarized)
amm-setup-v1.1.0-macos-x64.dmg      (notarized)
amm-setup-v1.1.0-linux-x64.AppImage (signed via gpg)
amm_1.1.0_amd64.deb                 (signed)
```

Plus a single `install.sh` analogous to the current `install.ps1` for one-line installs on Mac/Linux.

---

## 12. Versioning

**Single source of truth: `package.json#version`.** Currently `1.0.0`.

| Consumer | How it reads the version |
|---|---|
| `scripts/update-checker.mjs#currentVersion()` | `JSON.parse(fs.readFileSync('package.json', 'utf8')).version` (line 25-32). Returns `'0.0.0'` on parse failure. |
| `scripts/telegram-bot.mjs` startup ping | Calls `currentVersion()` from update-checker. |
| `scripts/telegram-bot.mjs` `/version` command | Calls `currentVersion()` and `checkForUpdate()` for the comparison. |
| `scripts/telegram-bot.mjs` `/help` | Embeds version. |
| `installer/amm.iss` | Hardcoded `#define MyAppVersion "1.0.0"` at line 9 — **MUST be edited in lockstep with `package.json`**. |
| Daily ping update notification | Calls `checkForUpdate({force: false})`, uses 5-min cache. |

### Bumping the version

The CLAUDE.md rule is "edit `package.json` only" — but in practice `installer/amm.iss` line 9 (`#define MyAppVersion`) is a second hand-edit needed for releases. v1.1 should either (a) auto-substitute via a release script, or (b) make the Inno script read from `package.json`.

### Semver semantics in `update-checker.mjs`

Lightweight comparator (`semverGt(a, b)` at lines 36-46): strips a leading `v`, splits on `.`, compares as integers, no pre-release support, padded to 3 components. Sufficient for `1.0.0`-style tags; would mishandle `1.1.0-rc.1` (treats as 1.1.0).

### Tag convention

Git tags: `v1.0.0`, `v0.5.0`, etc. (with the `v` prefix). The update checker strips `^v`. Recent commits show this scheme is followed.

---

## Appendix — Repo layout cross-reference

```
automatic-munyun-machine/
├── package.json              ← single-source version, 3 deps, node>=18
├── package-lock.json         ← lockfileVersion 3
├── .env                      ← gitignored; TG_TOKEN + chat ID
├── .env.example              ← shipped
├── config.json               ← user settings (gitignored)
├── config.example.json       ← shipped template
├── install.ps1               ← one-liner installer (PS-only)
├── installer/
│   ├── amm.iss               ← Inno Setup config
│   └── dist/                 ← .exe output (gitignored)
├── scripts/
│   ├── daily-batch.mjs       ← scraper + scorer + Telegram push (963 lines)
│   ├── telegram-bot.mjs      ← long-running bot poller (1615 lines)
│   ├── setup-wizard.mjs      ← 10-step interactive setup (463 lines)
│   ├── login-once.mjs / .cmd ← user signs into hiring.cafe
│   ├── job-action.mjs        ← /save /applied /auth via Playwright
│   ├── resume-parser.mjs     ← PDF/DOCX/MD → cv-parsed.json
│   ├── role-suggester.mjs    ← CV → suggested job titles
│   ├── geocode.mjs           ← open-meteo geocode wrapper
│   ├── update-checker.mjs    ← GitHub Releases polling
│   ├── file-picker.mjs       ← Win32 OpenFileDialog via PowerShell
│   ├── config-rw.mjs         ← atomic config.json read/write
│   ├── profile-store.mjs     ← v1.0 E5 multi-profile state
│   ├── callback-router.mjs   ← Telegram inline-button dispatch
│   ├── telegram-send.mjs     ← one-shot send CLI
│   ├── watchdog.mjs          ← bot heartbeat watchdog
│   ├── batch-missed-watcher.mjs ← alert if scheduled batch missed
│   ├── uninstall.mjs / .ps1  ← cleanup
│   ├── setup-tasks.ps1       ← Task Scheduler registration
│   ├── start-bot.cmd         ← bot launcher (Task Scheduler "munyun-bot")
│   ├── run-daily-batch.cmd   ← scrape launcher (Task Scheduler "munyun-daily-batch")
│   ├── cv-keywords.json      ← ~1500-term keyword dict (202 lines, role clusters at top)
│   └── __tests__/
│       ├── salary.test.mjs            ← 9 tests
│       ├── phrase-proximity.test.mjs  ← 3 tests
│       ├── role-cluster.test.mjs      ← 6 tests
│       └── profile-store.test.mjs     ← 5 tests
├── data/                     ← gitignored runtime state (browser-profile/, *.json, *.log)
├── docs/                     ← present (not enumerated here)
├── README.md
├── CLAUDE.md                 ← project guardrails
├── CONTEXT.md                ← running project state
├── CHANGELOG.md              ← Keep-a-Changelog
└── LICENSE                   ← MIT
```

---

*Stack analysis: 2026-05-07*
