# Changelog

All notable changes to Automatic Munyun Machine.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [7.9.0] — 2026-07-28

### Fixed

- **hiring.cafe pagination stopped less than halfway through the results.** Every keyword now walks to the true end of its result set. The old loop slept a flat 2.5s after clicking Next, then checked **once** for the Next button — so a page that was still rendering looked exactly like the end of the results (short card count, no Next link) and the query quit silently. Measured on `iam` (Remote): hiring.cafe reports **899 jobs**, the scrape collected **398**. On `cloud security` (Remote): **1,824 available, 869 collected**. Roughly half the job supply was being dropped before scoring ever ran, and the log reported it as a clean finish.
  - Page turns now wait for the results grid to *actually* change (anchored on the first card's link) instead of a wall-clock guess, then wait for the card count to hold steady across polls so a half-populated grid is never mistaken for a final short page.
  - "No more pages" must now survive **5 checks across ~12 seconds** before it's believed; a short page and a zero-new-cards page each get a second read after a longer pause before they're allowed to end a query.
  - Every query logs why it stopped (`"iam" complete: 552 jobs (Next stayed gone after 5 checks over ~12s — end of results)`), so a premature stop is visible instead of silent.
  - `maxPagesPerQuery` default raised 50 → 300. It is a runaway guard, not a target — hiring.cafe stops offering a Next link at 15–25 pages, so the site's real end is what ends the loop. The old 50 sat close enough to real page counts to look like a legitimate stopping point.
  - Verified end-to-end on the real scraper: the same `iam` search went **398 → 552 jobs (+39%)**.

### Known limitation

- hiring.cafe caps how deep its own pagination goes (the Next link disappears around page 15–25, and the exact point moves between runs), so a search with 1,824 matches cannot be fully walked by clicking Next — roughly 600–1,000 is reachable per query. Splitting one broad search into narrower ones ("cloud security" → "cloud security engineer", "cloud security architect", "aws security") gets under that ceiling and is the way to reach the rest.

## [7.8.0] — 2026-07-23

### Fixed

- **Cloudflare's "Verify you are human" checkbox no longer loops forever.** Clicking it would spin, reload, and re-challenge indefinitely — because the browser was self-identifying as automation *before* the click was ever evaluated. Two stacked signals, both removed:
  1. Playwright launches Chrome with `--enable-automation` by default (the "Chrome is being controlled by automated test software" infobar), which also sets `navigator.webdriver = true`. Every launch site passed `--disable-blink-features=AutomationControlled` but never dropped this switch, so the two cancelled out. `browserLaunchOptions()` now returns `ignoreDefaultArgs: ['--enable-automation']` — one helper, inherited by all five launch sites (scrape, hiring.cafe login, job actions, Dice login, Dice probe). Verified: `navigator.webdriver` is now `false`.
  2. Every launch pinned a hardcoded `Chrome/147` user agent while the installed Chrome had moved on (150 here). Modern Chrome also emits `Sec-CH-UA` client hints built from the real binary, so the pinned UA contradicted Chrome's own headers — precisely the mismatch anti-bot services flag. The override is gone; real Chrome now introduces itself, UA and client hints agreeing by construction.
- The Dice auth probe ran headless, leaking `HeadlessChrome` in its user agent on top of the stale override. It now runs headful parked off-screen at `10000,10000` — the same trick unattended scrapes already used — so it stays invisible while the browser looks entirely ordinary.
- New regression tests pin that no detection path (installed Chrome, Edge, bundled Chromium, or the null fallback) can reintroduce `--enable-automation`, and that the ignore list is a fresh array per call.

## [7.7.0] — 2026-07-21

### Added

- **✕ a job to keep it out of every send.** Each ranked job on the Jobs page now has an ✕ button: spot a duplicate or a job you don't want your VA touching, click ✕, and it's dropped from **Export (txt/csv/xlsx), the Email send, Open All, and the Telegram /export** — no more downloading the file and hand-editing it. Excluded jobs stay visible (grayed, struck through) with a ↩ restore button, and the table footer counts them. Exclusions live server-side per profile (`data/profiles/<profile>/batch-exclusions.json`), keyed to the batch — a fresh scrape always starts clean. Scrape-time auto-email is untouched (it sends before you've had a chance to review). Archived snapshots export exactly as delivered.

## [7.6.0] — 2026-07-20

### Changed

- **Dice now walks every result page.** v7.5 fetched a fixed 3 pages per term; now the fetch keeps paging until Dice runs out of new jobs (it repeats results past the end — the loop detects that and stops), with a 20-page runaway guard (~600 jobs/term). Live test: the same remote-only 7-day search that returned 93 jobs on 3 pages returns **657** walking all pages.
- Already-applied tracking for Dice needs no new machinery — it's been in place since the source shipped: every delivered job's link (Dice included) is persisted to the local seen-jobs store after each successful run and excluded from future batches for 60 days (`scoring.seenJobsFreshnessDays`), independent of Telegram/email delivery. The funnel line ("skipped N previously seen") shows it working.

## [7.5.0] — 2026-07-20

### Fixed

- **Dice now pulls real volume — the "2 jobs" bug.** Dice searches ignored your filters: page 1 came back nationwide with every workplace type, and the client-side workplace filter then discarded nearly all of it (a Remote-only user saw 3 remote jobs out of 35, surviving as 2 after dedup). Your workplace types, location (with a 30-mile radius, for local searches), and recency window now ride the Dice search URL itself (`filters.workplaceTypes`, `location`/`radius`, `filters.postedDate` — all verified live), and each term paginates up to 3 pages instead of 1. Same remote-only search now returns ~90+ matching jobs before scoring. The client-side filter stays as a backstop for Dice's occasional filter bleed.
- **Watch now works for Dice scrapes.** Dice is fetched directly (no browser), so clicking Watch used to show nothing — on a Dice-only scrape no window ever appeared. Now, when Watch is on and any terms route to Dice, AMM opens a browser window and mirrors every Dice search page it requests, in order, as the fetch runs — you see exactly what Dice is being asked, page by page. Purely cosmetic: a failed mirror never affects the scrape, and the window closes when the Dice fetch finishes.

## [7.4.0] — 2026-07-20

### Changed

- **Dice is now fully built in — the enable toggle is gone.** v7.3 shipped Dice as an opt-in source, which also hid the Dice sign-in card and the scrape-source controls until you found the checkbox. That's fixed: Dice gets the same first-class treatment as hiring.cafe. The **"What to scrape"** selector (Both / hiring.cafe only / Dice only) is always on the Searches page, every search term always shows its **both / cafe / dice** routing tag, and the **Dice.com sign-in card** is always on the System page right next to hiring.cafe's — sign in once and Dice apply links open logged in. Under the hood `sources.dice.enabled` is retired; term routing (`search.scrapeSources` + `queries[].engines`) is the only control, and a scrape with zero Dice-routed terms simply doesn't touch Dice.

## [7.3.0] — 2026-07-20

### Added

- **Dice.com job source.** Toggle "Dice.com" on the Searches page (Job sources card) and every scrape also runs your configured search terms against dice.com — no login, no API key, no extra browser work. Jobs arrive with structured data straight from Dice's server-rendered pages: real salary ranges (fed into the existing salary tie-breaker), posted dates, workplace type (Remote/Hybrid/On-Site, honored by your workplace preference filter), and a JD summary; the top results per term additionally get their full job description fetched so JD-pass scoring sees real posting text. Dice cards ride the same filter → dedup → score → rank pipeline as every other source (`sources.dice.enabled` in config; `scripts/sources/dice.mjs`; parsing is pure and fixture-tested, fetching is best-effort so a Dice outage can never break a scrape).
- **Pick what each scrape runs.** With Dice on, a "What to scrape" selector appears on the Searches page: both sources, hiring.cafe only, or Dice only (`search.scrapeSources`). A Dice-only scrape skips launching the browser entirely — it's pure fetch, so it's fast. And each search term gets its own source tag (click to cycle **both → cafe → dice**), so "iam engineer" can run everywhere while "dice-only niche term" stays off hiring.cafe (`queries[].engines`, routed by `scripts/query-engines.mjs`).
- **Ranked jobs say where they came from.** Every job in the dashboard's ranked list now carries a source badge — **cafe** for hiring.cafe, **dice** for dice.com (company boards keep their ATS name). The "Save on hiring.cafe" button only renders on hiring.cafe jobs, since saving a Dice job there makes no sense (`src` field in `last-batch.json`).
- **Sign in to Dice — same flow as hiring.cafe.** A Dice.com card on the System page (visible when the Dice source is on) with the identical UX: Sign in launches a browser window at Dice's login page using the same persistent profile, closing it triggers a headless probe (`/home-feed` redirect check — the dice.com twin of hiring.cafe's `/saved` probe), status is cached to `data/dice-auth.json` with a Re-check button. Optional: search scraping works signed out; signing in makes Dice apply links open already logged in so Easy Apply and Dice's saved/applied tracking work for you or your VA. (`scripts/dice-login.mjs`, `scripts/dice-auth-probe.mjs`, `scripts/dice-session.mjs`.)

## [7.2.0] — 2026-07-20

### Added

- **Previous scrapes — re-scraping never loses jobs again.** Every scrape now saves a full snapshot of the batch (all jobs, scores, and links) to the active profile's `data/profiles/<profile>/batch-archive/`, kept for 30 days. A new "Previous scrapes" section on the dashboard's Jobs page lists every saved scrape (when, job count, average match, strong matches) with per-scrape downloads in all three formats (`.txt`, `.csv`, `.xlsx` — filenames carry the scrape's timestamp so same-day downloads don't collide) and an inline viewer that expands any snapshot's full job list with clickable apply links. New endpoints: `GET /api/archive` (index), `GET /api/archive/batch?id=` (one snapshot), and `GET /api/export?format=…&archive=<id>` (export a previous scrape). Archive ids are strictly validated in both the Node and Go layers (path-traversal guard), archiving is non-fatal by design (a write failure can never break a scrape), and expired snapshots are pruned automatically on each run.

## [7.1.0] — 2026-07-20

### Fixed

- **Updates no longer reset your settings.** Root cause found and killed: CI's test step creates a `config.json` in the build checkout, the Windows installer packaged the repo root without excluding it, and Inno Setup's `ignoreversion` then overwrote the user's real `config.json` on every update — wiping blocked companies, the Smart match API key, schedule, and email settings (profiles and the scanned resume live in `data/`, which was always excluded, so they survived). Four defenses now stand between an update and your settings:
  1. The installer excludes the payload-root `config.json` (`\config.json` in `amm.iss`).
  2. The release workflow scrubs `config.json`, `data/`, and `.env` from the checkout before the installer is built.
  3. `self-update` snapshots `config.json` into `data/backups/` (`pre-update`) right before every update, joining the existing pre-restore/pre-delete/pre-setup snapshots (last 10 kept, restorable from System → Backups).
  4. Self-heal: if `config.json` is ever missing while backups exist, the newest valid snapshot is restored automatically instead of resetting to defaults.
- A new regression test file (`update-safety.test.mjs`) pins all four layers so this bug class can't quietly return.

## [7.0.0] — 2026-07-20

### Changed

- **Bolder dashboard hierarchy pass.** The Jobs view now leads with its numbers: the KPI tiles (jobs in batch, average match, strong matches, batch date) use larger, heavier hero figures, and **Strong matches** is rendered in the same green the match meter already uses for strong jobs — making "is today worth my time?" the first thing the eye lands on. Match percentages in the ranked table are larger and heavier, the match meter is slightly taller, and the view title is stronger. Column headers and stat labels were darkened one step, which also fixes a light-theme WCAG AA contrast shortfall on those labels. All changes stay inside the existing design tokens — no new colors, gradients, or radii — and apply to both light and dark themes.

### Smart match (AI) accuracy overhaul

- **The rerank now reads your actual resume.** When a Smart match API key is set, the model receives the raw resume text the parser already stores (first ~6 KB) instead of only the extracted keyword arrays — so it can judge experience, tenure, and seniority, not just word overlap. Keyword arrays ride along as a supplement, and older `cv-parsed.json` files without stored text fall back to keyword-summary mode unchanged.
- **Fuller job descriptions.** Each reranked candidate now carries up to 2,200 characters of the real posting (was 900), so requirements the model is grading against are actually in front of it.
- **Rubric scoring.** The model must score `skills`, `seniority`, and `role` fit (0–100 each) before committing to an overall fit — decomposed judgments are measurably more accurate than one opaque number. The subscores are saved to `last-batch.json` (`aiSub`) and shown in the Why panel next to the Smart match reason.
- **The AI's opinion counts for more.** With the real resume and fuller descriptions in hand, the blend moved from 45% keywords / 55% AI to 35% / 65%.

### Email batch format

- **Your format preference now sticks — and the morning auto-send honors it.** v6.2 added per-send format choice on manual emails but the automatic morning send stayed hard-coded to `.txt` and nothing persisted. A new saved preference (`email.format`: txt | csv | xlsx, set from System → Email's "Send batch as" select) now drives the **morning auto-send** and serves as the **default for manual sends**; the per-send Email menu still overrides for one-offs. The .xlsx carries clickable apply links.

### Accessibility & polish

- The keyboard focus ring on the match-strength filter (All / ≥70% / 50–69% / <50%) is no longer clipped by the segmented control's `overflow: hidden`; it now draws inset so keyboard users can see the focused band.
- The dashboard error banner is now announced by screen readers (`role="alert"`), and the header status chip (connecting / healthy / stale) announces changes politely (`aria-live`).
- Typographic craft: headings use `text-wrap: balance` for even line breaks, body/hint prose uses `text-wrap: pretty` to avoid orphans, and macOS/Firefox get `-moz-osx-font-smoothing: grayscale`. All degrade gracefully where unsupported.
- A **zero** strong-matches count now renders muted instead of green — a green "0" would misread as good news for a bad state. The batch-date tile is sized as secondary context rather than a hero number, which also keeps it from wrapping on narrow windows. The header status chip only rewrites its text on an actual state change, so its `aria-live` region won't re-announce an unchanged status.

## [6.2.0] — 2026-07-13

### Added

- Manual dashboard emails can now attach the ranked apply-link list as plain text (`.txt`), CSV (`.csv`), or an Excel workbook (`.xlsx`) with clickable application links. The format is selectable from both the Jobs toolbar and the System email card; automatic morning email remains `.txt`.

## [6.1.0] — 2026-07-13

### Added

- Added an **Open All** action to the Jobs dashboard that confirms the batch size, then opens every job's direct application link in the default browser.

## [6.0.0] — 2026-07-12

### Added

- **Native Windows dashboard window.** `AMM.exe` now hosts the existing local dashboard in Microsoft WebView2, giving Automatic Munyun Machine its own taskbar identity, icon, and pinnable shortcut instead of grouping the dashboard under Chrome. External apply, OAuth, and release links continue to open in the user's default browser.
- The Windows installer detects the Evergreen WebView2 Runtime and silently runs Microsoft's Authenticode-verified bootstrapper only when the shared runtime is missing.

### Changed

- Windows dashboard windows use a dedicated local WebView2 profile under `data/native-window/`. Chrome/Edge app mode remains a compatibility fallback, while macOS and Linux retain their existing browser-hosted dashboard behavior.

## [5.2.0] — 2026-07-11

### Changed

- Rewrote the README around the current desktop-first v5 experience: configurable 50–200-job batches, profession-agnostic resume matching, optional company-board sources, Telegram/email as opt-in delivery, accurate privacy details, and a shorter setup/troubleshooting path.
- Aligned package-lock and local wrapper/installer fallback versions with 5.2.0, refreshed contributor context, modernized installer/package descriptions, and explicitly ignored local app-window browser data.

## [5.0.1] — 2026-07-11

### Fixed

- CI green for the v5.0 line. A pre-existing scoring test hardcoded the old `salaryFloorUsd` default (90000) and failed on a clean checkout now that v5.0 ships a `0` floor (no floor until you set one); the below-floor assertion is now derived from the actual floor and skipped when none is set. `SALARY_FLOOR_K` is exported for testability. (v5.0.0's release build failed on this before publishing artifacts; v5.0.1 is the first published build of the line.)

## [5.0.0] — 2026-07-11

> **AMM is for everyone now — not just one security engineer.** v5.0 removes every default that was tailored to the original owner, teaches the resume parser 8 non-tech fields, lets you search on-site/hybrid jobs (not just remote), pulls jobs straight from company ATS boards, and fixes 20 bugs the review turned up. A nurse, a sales rep, or an accountant can now install AMM and get relevant jobs from their very first scrape.

### Added

- **Works for any profession, not just tech.** The resume parser learned 8 non-tech domains — **Healthcare & Nursing, Sales, Finance & Accounting, Marketing, Education, Human Resources, Administrative, and Skilled Trades** — with ~200 new titles/skills/certs and matching search-term suggestions. A registered nurse's resume now parses to a `healthcare` primary cluster and suggests *Registered Nurse / Nurse Practitioner / ICU Nurse* (not *IAM Engineer*). The tech-centric "off-family" scoring penalty now applies **only when the user's own field is tech**, so a sales rep's sales roles are never demoted.
- **Workplace type + location search.** Remote was hardcoded — you can now search **Remote / Hybrid / On-Site** (Settings → Workplace type) and set a **location** for local jobs. Default stays Remote-only, so nothing changes unless you opt in.
- **Job sources — pull straight from company ATS boards.** New adapters for **Greenhouse, Lever, and Ashby** fetch jobs directly from companies' own public, official career-board feeds (no login, no scraping, more reliable than any single aggregator). Add company slugs on the Searches page. Off until you list companies — additive to hiring.cafe, never a replacement. Includes an optional **remotely-updatable source config** URL so a board change can be fixed same-day without an app update. (`scripts/sources/*`, 8 unit tests.)
- **DNS-rebinding hardening.** Read-only dashboard endpoints (`/api/status`, `/api/batch`, `/api/settings`, …) now enforce a loopback-Host check (`guardGet`), so a malicious web page can't read your job data, resume keywords, or VA email even if it guesses the port.

### Changed

- **Fresh installs ship blank, not owner-shaped.** Removed the owner's personal company blocklist (AMD/ECS/…), personal title-drop list (Manager/Director/Marketing/Frontend/…), the 15 hardcoded IAM search terms, and the Miami/Fahrenheit/name/$90k defaults from `config.example.json`. A new install now derives its searches from **your** resume; with no resume it stays empty and prompts you to add terms (never someone else's field). Gov-clearance filtering now defaults **off** (opt-in).
- **Salary parsing goes international + hourly.** `parseSalaryK` now handles £/€ (K-suffix and full-form, comma **and** dot thousands, currency suffixes) and **hourly rates** (annualized at 2080 h/yr) — so a London £55k role or a $45/hr contract parses instead of showing no salary.

### Fixed

- **AI rerank fed each job the wrong description.** After the shortlist sort, the opt-in Claude rerank paired every candidate with a *different* job's JD (an index-alignment bug). Now the JD travels with its job.
- **Search-style toggle silently reverted.** `search.mode` (titles vs keywords) was written to a config location `read()` never looked at, so flipping it did nothing; `search`/`sources` are now profile-scoped and a one-time migration relocates orphaned keys.
- **Dashboard could freeze on launch.** An unguarded `localStorage` read in the boot chain threw (and killed the 5s poll loop) when a browser blocks site data — every storage access is now guarded.
- **Trends page rendered blank** when reached via the address bar / back button (hashchange never loaded it).
- **Tour** drew a phantom highlight in the corner when started from a non-Jobs page; it now shows the Jobs view first and skips hidden steps.
- **Duplicate & stale desktop notifications.** The browser notification duplicated the always-on tray toast (and re-fired a stale failure on every launch) — the redundant browser layer was removed; the tray owns OS toasts.
- **Email button** desynced hash and view (breaking the `/` shortcut); it now uses `navTo`.
- **Search leaderboard** showed the mangled internal query key (`SeniorSecurityEngine`) instead of the real search term.
- Batch-history search leaderboard now keys on the human search term; the source pill on each job matches.

### Notes

- **Deferred (not in this release):** OS-keychain storage for secrets (native code across three OSes, deferred to a focused security pass) and full UI localization/i18n (awaiting a target language). Code signing and multi-client mode were explicitly out of scope.
- `CLAUDE.md`'s dependency note now lists Greenhouse/Lever/Ashby public JSON feeds as optional, user-enabled job sources.

## [4.6.0] — 2026-07-11

> **See how the hunt is going, tune it from the dashboard, and hear about every batch.** Salary on every job card, a light theme, blocked companies without touching Telegram, desktop notifications even when the app is closed, and a new Trends page that finally remembers yesterday.

### Added

- **Salary on job rows.** The salary AMM already parses from each posting (e.g. `~$140k`) now shows under the company name on the Jobs list, with a **Show salary on jobs** toggle in Settings (`display.showSalary`, new profile-scoped `display` config block, default on). Best-effort — postings without a listed salary simply show no badge. Your VA's link-only file is unchanged by design.
- **Blocked companies in the dashboard.** A new card on the Searches page manages `filters.skipCompanies` (add/remove chips) — previously Telegram-only via `/skip`/`/unskip`. Jobs from blocked companies are dropped before scoring; matching is a case-insensitive prefix ("Google" also blocks "Google LLC"). New guarded POST routes `/api/skip/{add,remove}` → `dashboard-api.mjs` `skip-add`/`skip-remove`.
- **Light theme.** The dashboard now has a full light palette alongside the original dark one, with a sun/moon toggle in the top bar. First run follows your OS preference; an explicit pick is remembered (`localStorage amm-theme`) and applied before first paint — no flash. Fixed the topbar being hardcoded dark while theming.
- **Desktop notifications — batch ready & scrape failed.** Two layers: (1) the always-running tray app watches `data/scrape-status.json` and fires a **native OS toast** (Windows WinRT toast / macOS osascript / Linux notify-send, dependency-free) even when the dashboard is closed — the 7am break finally reaches you; (2) with the dashboard open in a background tab, a browser notification fires too (asked for permission on your first Scrape click; suppressed while you're actively viewing). New `wrapper/notify.go`; the tray seeds the last outcome at startup so stale statuses never toast.
- **Trends page — the app finally remembers yesterday.** Every scrape now appends a compact daily snapshot to the profile's `batch-history.json` (new `scripts/batch-history.mjs`, capped at 90 days, same-day re-runs replace that day). The new **Trends** view charts jobs delivered + average match per day (self-contained SVG, no chart library) and a **Search leaderboard** ranking your search terms by the match quality of the jobs they bring (jobs, avg match, strong count, share — weak terms dimmed, with a pointer to prune them on Searches). Falls back to the current batch on day one. New GET `/api/history` in the Go wrapper.

## [4.5.0] — 2026-07-10

### Added

- **Choose how many jobs each batch delivers — 50, 100, 150, or 200.** A new **Jobs per batch** picker in dashboard Settings (and `/batchsize N` in the Telegram bot) controls the size of every batch, scheduled or manual. Default stays **100**, so nothing changes unless you pick a new size. Larger batches naturally take longer to build (each delivered job's apply-URL page is visited during resolution, and — when signed in — marked Viewed on your hiring.cafe account) and may deliver fewer than the target on low-supply days once fresh jobs above the match floor run out. New shared module `scripts/batch-size.mjs` is the single source of truth for the options; the stored `scoring.targetJobsPerBatch` is clamped to the nearest offered value everywhere it's read, so a hand-edited config can't make the resolve pass visit an unbounded number of pages. `last-batch.json`'s funnel gains `targetJobsPerBatch` so the dashboard/`/why` can show "delivered N of your chosen size."

## [4.4.2] — 2026-07-11

### Changed

- Automatic Telegram and email `.txt` attachments now use the same compact `apply-links(date).txt` format as `/export`: number, job title, and direct apply link only. The detailed `jobs(date).txt` remains available locally.

## [4.4.1] — 2026-07-10

### Fixed

- Accept Google's standard downloaded Desktop OAuth credential JSON (`installed.client_id` / `installed.client_secret`) in addition to AMM's release-build format.

### Added

- Add an explicit live Gmail verification command (`npm run test:gmail-live -- --to <address>`) that exercises real Google consent, token exchange, and a labeled Gmail API send without exposing credentials.

## [4.4.0] — 2026-07-10

### Added

- **Connect Gmail with Google.** The desktop dashboard now uses Google's installed-app OAuth flow with PKCE and a loopback callback. AMM requests only identity plus `gmail.send`, sends through the Gmail API, refreshes access automatically, stores authorization locally, and removes it on Disconnect. Existing Gmail App Password SMTP setup remains under Advanced as a backward-compatible fallback.
- **Dashboard browser E2E in CI.** A deterministic Playwright harness now boots the real dashboard against local fixture APIs, renders jobs and profiles, expands match reasoning, and completes a mocked Gmail OAuth popup/callback. CI installs Chromium and runs `npm run test:e2e` without touching hiring.cafe, Telegram, or Google accounts.
- **OAuth release injection.** Release jobs can bundle a desktop OAuth client from `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` GitHub Actions secrets; source builds can provide the same names in `.env`.

### Fixed

- **Cross-platform watchdog recovery.** The macOS/Linux watchdog no longer attempts to launch Windows PowerShell and Task Scheduler; it terminates the heartbeat PID with `SIGTERM` and restarts the bot through the shared scheduler abstraction. Watchdog and missed-batch Telegram alerts now use the running Node executable instead of relying on `node` being present on `PATH`.
- **Profile-aware supply diagnostics.** Dry-query warnings now read the active profile's `query-stats.json` instead of the removed global location, and the role-suggester CLI reads the active profile's parsed CV.

### Changed

- Runtime heartbeats, poll offsets, update state, watchdog state, parsed CV output, and daily batch artifacts now use atomic writes so a crash cannot expose truncated JSON or a partially published batch file. The synchronous file-lock retry ceiling was increased to avoid false failures under heavy concurrent writes.
- Added regression coverage for Gmail PKCE, token exchange, MIME attachments, dry-query detection, and OS command/scheduler resolution (192 tests total).

## [4.3.0] — 2026-07-09

> **Seen jobs follow your hiring.cafe account now — setup help lives in the header — and you can email each batch to a helper.** Sign in once and AMM asks hiring.cafe itself to hide everything you've already saved, applied to, or been shown — so switching computers no longer re-delivers old jobs. Setup and the tour moved to the top bar where you can always find them, a fresh install opens straight into the walkthrough with zero dashboard flash, and you can now hand the daily batch off by email to a VA who applies for you.

### Added

- **Account-based dedup (signed-in installs).** When the persistent browser profile is signed in to hiring.cafe, every scrape sends `searchState.hideJobTypes: ["Saved","Applied","Viewed"]` so the *server* filters out jobs your account has already seen — dedup that follows your account to any computer. Delivered jobs are marked **Viewed** on your account automatically: hiring.cafe fires `POST /api/markJobViewed` whenever a signed-in session opens a job page, and the scraper already visits every shortlisted job page during apply-URL resolution (probed and confirmed live 2026-07-09: visited jobs vanish from a hide-viewed search; unvisited controls stay). Signed out, nothing changes — the local `seen-jobs.json` memory keeps working exactly as before, as it also does as a belt-and-suspenders safety net while signed in. Known tradeoff (accepted): the account marks jobs Viewed at *visit* time, so a run that fails after the resolve pass still hides its ~130 shortlisted jobs from future signed-in scrapes — the "persist seen-jobs only after delivery" crash-safety rule protects only the local store, and the local 60-day decay doesn't apply to the account's memory. New knob `scoring.accountDedup` (default `true`); disabling it switches every surface to an honest "local (account dedup disabled in settings)" line rather than a sign-in nag. A transient sign-in probe failure runs that batch signed-out but leaves the cached dashboard pill untouched (a probe *error* is not a confirmed "signed out"). The scrape start now logs which mode is active, `last-batch.json`'s funnel gains `accountDedup`, and the scrape refreshes the dashboard's `data/hcafe-auth.json` sign-in pill on every run. New shared module `scripts/hcafe-session.mjs` (sign-in probe + auth cache) — `job-action.mjs` and `dashboard-api.mjs` now use it too.
- **Sign-in nudge.** Signed-out installs see a dismissible dashboard banner ("Sign in to hiring.cafe so AMM remembers seen jobs on your account"), an honest line in the Telegram batch header and `jobs(DATE).txt`, and a `Dedup:` line in `/diagnose`'s seen-jobs section. Dismissing the banner lasts for the session; the System page's hiring.cafe card remains the permanent surface.
- **Setup + Tour in the top bar.** **Setup** (run setup walkthrough) and **Tour** (take a tour) buttons now live in the header next to Scrape now — always visible from every view, icon-only on narrow windows. The tour gained a final step pointing at them.
- **Boot veil — the walkthrough is the first paint on a fresh install.** Machines that never finished (or skipped) onboarding boot behind a neutral logo veil until the first status check decides; the welcome splash is the first thing ever painted — the empty dashboard no longer flashes for ~half a second first. Known-onboarded machines never see the veil (localStorage check inline in `<head>`-adjacent script), connection errors always drop it, and a 6s safety net guarantees it can't stick. Installs upgrading from pre-v4.3 (which have batches but no onboarding flag) are marked onboarded on their first boot so the veil never mounts again.
- **Email the batch to a helper (`scripts/email.mjs`).** A new "**Email**" button sits next to **Export** in the Jobs toolbar and sends the current batch `.txt` to your chosen recipient on demand. A one-time **Email** card on the System page connects it: paste your Gmail address + a Gmail **App Password**, AMM verifies the sign-in and sends a test message before saving. Turn on **Auto-send** to also email the batch automatically right after each morning scrape (wired into `daily-batch.mjs` next to the Telegram send — independent and non-fatal, so an email failure never aborts the run or the seen-jobs write). Sends through Gmail SMTP (`smtp.gmail.com:465`) via the new **nodemailer** dependency (zero-dep, vendored). New config block `email` (`enabled` / `to` / `from` / `subject` with `{DATE}` / `autoSend`), profile-scoped so different profiles can email different people. Credentials live in `.env` (`SMTP_USER` / `SMTP_APP_PASSWORD`), never in `config.json` and never in logs — the app password is scrubbed from every response and log line. Gmail requires 2-Step Verification + a 16-char App Password (a normal password is rejected); the setup card explains this and errors map to plain-language fixes.

### Changed

- **System page "Getting started" card removed** — replaced by the always-visible topbar buttons (the Jobs empty-state buttons remain).
- **The batch header's auth line is truthful now.** It used to say "✓ logged in" unconditionally (stale since v1.0.x went unauth); it now reports the actual dedup mode — account-synced vs local-only with a sign-in pointer. Still gated by `telegram.showAuthIndicator`.
- **`/forget all` / `/forget last` note the account.** Both still clear only the local store; when you're signed in they now warn that hiring.cafe's account-side memory may keep those jobs hidden.
- **`hideJobTypes` returns, auth-gated.** v1.0.x removed it because the scrape ran unauthenticated and the field only works signed-in; v4.3 sends it exactly when a run has verified a signed-in session (`buildSearchState`, unit-tested in `scripts/__tests__/search-state.test.mjs`).
- **New optional channel: Gmail (SMTP).** `CLAUDE.md`'s "no third-party APIs beyond hiring.cafe / open-meteo / Telegram" scope note now includes Gmail as an optional, user-connected fourth channel — the project's first mail dependency (`nodemailer`, zero-dep, vendored).

---

## [4.2.1] — 2026-07-09

> **The walkthrough now actually shows up.** v4.2.0's onboarding only appeared on a truly blank install (no `config.json`). If an earlier setup attempt left a config behind — which is exactly what happened after the Node bug — the wizard silently never opened and there was no way to launch it. Fixed.

### Fixed

- **First-run walkthrough was unreachable when a `config.json` already existed.** The welcome/setup overlay was gated purely on `needsSetup` (config missing), so a machine with a leftover/partial config never saw it and had no manual way in. Now: (1) the walkthrough **auto-opens once** on any install that has never produced a job batch, even if a config exists (`__hasBatch` gate — it never pops over an already-working install); (2) the **Jobs empty state** ("No batch yet") gained **Set up AMM** and **Take a tour** buttons; (3) the **System page** has a permanent **Getting started** card with **Run setup walkthrough** and **Take a tour**. Re-opening the wizard on an already-configured machine and hitting "Skip" now just closes it — it never overwrites your existing `config.json`.

---

## [4.2.0] — 2026-07-09

> **A real first-run walkthrough — and a fresh PC just works.** New installs open with a "Welcome to Automatic Munyun Machine" screen, a guided setup you can skip anytime, and a short tour of the app afterward. Plus: the `.exe` installer bundles its own Node runtime, so scraping and hiring.cafe sign-in work immediately with no separate Node install.

### Added

- **First-run welcome + guided walkthrough.** The dashboard's setup overlay opens on a friendly welcome splash ("Your automatic job machine" — what AMM does, in four points) before asking for anything. Two clear choices: **Let's set it up →** or **Skip for now**.
- **Skip setup.** A persistent "Skip setup for now" link (and a Skip button on the welcome screen) writes safe defaults and drops you onto the dashboard to explore. A persistent **Finish setup** banner nudges you back into the wizard whenever you're ready. Skipping does *not* schedule the daily scrape, so a half-finished install never fires a failing 7am run.
- **"Here's what we'll hunt for" preview.** After scanning your resume, the suggested searches are framed as exactly what AMM will search each morning — with a **Job titles ↔ Keywords** toggle right there so you choose the search style at the moment it matters (re-runs suggestions live; backed by a new optional `mode` hint on `/api/resume/upload` → `resume-parse`).
- **Post-setup tour.** Finishing setup kicks off a short coach-mark tour that rings the sidebar, **Scrape now**, your match stats, and the **System** page (sign-in/health), so first-time users know their way around. Dismissible; "Skip tour" ends it.

### Fixed

- **The `.exe` installer never provisioned Node.** `AMM.exe` shells out to Node helpers for every Scrape / Sign-in / update action, but the Inno installer only bundled `node_modules` — never the Node *runtime* itself. On a machine without Node already installed, every action failed with *"Could not run the helper. Is Node installed?"* (the `iwr | iex` one-liner was unaffected — it winget-installs Node.) The installer now ships a portable Node runtime at `{app}\runtime\node.exe` (fetched + checksum-verified against Node's official `SHASUMS256.txt` during the release build) and everything that spawns Node prefers it: the wrapper's `findNode()` (`wrapper/supervisor.go`), the `start-bot.cmd` / `run-daily-batch.cmd` scheduled-task launchers, and the installer's own Chromium post-install + uninstall steps. System Node, if present, still works as a fallback.

---

## [4.1.0] — 2026-07-07

> **You can see what's happening now.** Sign in to hiring.cafe straight from the dashboard — a permanent status pill tells you whether you're connected — and every batch shows exactly where the raw scrape went before it became your 100 jobs.

### Added

- **Hiring.cafe sign-in status on the dashboard.** The System page gains a permanent **Hiring.cafe** card showing whether you're signed in (✓ Signed in / ✗ Not signed in / Unknown) with a **Sign in to hiring.cafe** button and a **Re-check** link. Signing in reuses the first-run login flow (visible Chromium via `login-once.mjs`). Status is cached to `data/hcafe-auth.json` and read instantly on load — the live probe (`job-action.mjs auth`, ~5-10s Playwright) runs only on demand, never on the frequent status poll. New endpoints `GET /api/hcafe/auth` (cached) + `POST /api/hcafe/auth/refresh` (live), backed by `dashboard-api.mjs` subcommands `hcafe-auth-get` / `hcafe-auth-check`.
- **Funnel transparency — "3,000 raw but only 100 jobs, where'd they go?"** Every batch now shows the full breakdown on Telegram, the `jobs(DATE).txt` header, and the dashboard: `raw → after filters → fresh (−already seen) → above floor → delivered`. All numbers come from the funnel object already written to `last-batch.json`; passed through `/api/batch` and rendered by `funnelLine`/`funnelLineJS`.

---

## [4.0.0] — 2026-07-06

> **The matching gets smart.** v3 made the dashboard a real application; v4.0 makes the ranking deserve it. The scorer finally reads the actual job posting — not just the search-result card — kills the "Palo Alto, CA" class of false positives, optionally gets a second opinion from Claude, and coaches you on what your resume is missing. Plus the reliability round: failed scrapes are announced on the dashboard, settings are snapshotted before anything rewrites them, and updates are checksum-verified.

### Added — Matching accuracy

- **Two-pass scoring: the full job description is finally read.** Pass 1 shortlists ~130 candidates on card text (as before). Pass 2 re-scores each on the REAL posting text (title + description + requirements summary), captured during the apply-URL resolution pass the scraper already runs — near-zero extra cost. Final % = 40% card + 60% description (`scoring.jdRescore`, default on; new `jdScoreToPercent` bands calibrated for the longer text).
- **The "Palo Alto" fix.** Ambiguous CV terms (palo alto, chef, puppet, salt) only score when their disambiguating context appears in the text — "Palo Alto **Networks** / PAN-OS / firewall" counts, "Palo Alto, **CA**" in a location line doesn't (`AMBIGUOUS_TERM_CONTEXT` + `termAllowedInText`).
- **Role-family gate.** A job whose title is clearly non-technical (marketing, sales, HR, …) is multiplied down ×0.35 instead of climbing on keyword crumbs — unless the title itself carries one of your CV's cluster terms, or your CV has no detected clusters (fail-open).
- **Salary is a tie-breaker, not score points.** `salaryBonus`/`salaryPenalty` no longer inflate irrelevant jobs past your floor; among equal match %, known salary ≥ your floor ranks by amount, unknown is neutral, below-floor sorts last (`compareJobs`/`salaryRank`).
- **Smart match (AI rerank) — opt-in, off by default.** New Settings card: paste your own Anthropic API key and the top ~40 jobs get one batched Claude call (`claude-opus-4-8` default, structured JSON output) returning true fit 0-100 + a one-line reason. Final % blends keyword 45% / AI 55%. Fail-open: any error leaves keyword ranks; the key lives only in local config.json, is never returned by the API layer (`aiHasKey` boolean only), and is never logged. New `scripts/ai-rerank.mjs`, zero new dependencies (raw fetch).
- **The Why panel tells the whole story.** Score journey (`Card scan 71% → Full description 84% → AI check 87% → Final`), matched terms, **"The job asks for — not on your resume"** miss-chips with one-click **+ search** (adds as search term) and **mute** (never score this term again — `scoring.mutedTerms`, `/api/score/mute`), and the Smart match reason when AI ran. `last-batch.json` jobs carry `cardPct/jdPct/aiPct/aiReason/missing/salaryK`.
- **Thin-CV warning.** If fewer than 8 terms were extracted from your resume, the Resume card says so instead of letting every match read 12%.

### Added — Reliability

- **Failed scrapes are no longer silent on the desktop.** `daily-batch` writes `data/scrape-status.json` on every exit path (success, empty-CV, hiring.cafe block, crash — with a canary-style plain-language reason); the dashboard shows a red **FAILED** banner with the reason and a **Try again** button. A scrape started anywhere (7am scheduler, Telegram, tray) also lights the progress bar via `data/scrape.lock` freshness (`lastScrape` + `scrapeRunning` on `/api/status`).
- **Settings backups + restore.** Config is snapshotted to `data/backups/` (keep 10) before first-run setup, profile rename/delete, and restores; the Profiles page gains a **Settings backups** card with one-click restore (`snapshotConfig`/`listConfigSnapshots`/`restoreConfigSnapshot`, `/api/config/{backups,restore}`).
- **Checksum-verified updates.** `self-update` now downloads the release's `SHA256SUMS.txt` and verifies the installer's sha256 before running it; mismatch or unverifiable → download discarded, nothing installed.
- **Applied-marks survive reloads.** Per-batch localStorage persistence (v3 was session-only).

### Changed

- Dashboard behavioral test harness committed to `dev/dashboard-harness/` (`npm run test:ui`, local — needs Chrome/Edge); the static integrity contract (ids/CSRF placeholder/symbols/offline) is now a CI test (`dashboard-static.test.mjs`).
- Suite: 162 node tests + 4 new Go tests (scrape-status parsing, running-lock detection).

### Deferred (noted honestly)

- Telegram-setup UI dedupe (it exists twice in dashboard.html) and centralizing hiring.cafe selectors into one module — invisible refactors, punted to keep v4.0 reviewable.

---

## [3.0.2] — 2026-07-06

### Fixed

- **Auto-update no longer "loses" your profiles.** The silent installer ran without a `/DIR` flag, so on installs that never went through the installer's own registry entry (git-based installs from `install.ps1`) it installed a **fresh copy** to the default `%LOCALAPPDATA%\automatic-munyun-machine` and relaunched *that* — a blank app with no `config.json`, no `.env`, no profiles. It looked exactly like "the update deleted my profiles," but nothing was ever deleted: the wrong copy was running while your real data sat untouched in the original folder. The updater now passes `/DIR="<current install root>"` so every update lands **in place**, keeping config, profiles, Telegram token, and job history. ⚠️ *Note: this fix takes effect for updates applied **from** v3.0.2 onward — the update **to** v3.0.2 still runs the old updater. Git-based installs should apply this one with `git pull`; installer-based installs are unaffected either way (Inno's registry already pins their directory).*
- **Updating is now a clean window handoff.** Clicking **Update now** used to leave the old dashboard window sitting there dead ("you can close this window") while the relaunched AMM opened a second one. Now: the banner switches to *"Installing the update — this window will close and the updated app will reopen by itself"*, an **Installing the update…** splash covers the app the moment the installer takes over, and the old window **closes itself** — then the relaunched AMM (v2.9's `--after-update`) opens the fresh one. Close happens via two independent mechanisms: the wrapper force-closes the app window it spawned ~4s after the update starts (new `closeAppWindows()`, PID tracked at launch), and the page also closes itself when the wrapper stops answering (in-page navigation switched from hash-pushes to `history.replaceState` so the window keeps the single history entry Chrome requires for `window.close()`). While an update is applying, the "Could not reach the wrapper" error banner is suppressed — losing the wrapper is the install working, not a failure.

### Notes

- Verified: production-faithful Playwright run (real `--app` window, single history entry) — navigate across views, click Update, kill the wrapper → splash appears and **the window closes itself**; fresh-batch banner regression re-passed; 2 new Go tests for `closeAppWindows` (real child process killed; dead-PID no-op). Suites: 153 node + full Go green.

---

## [3.0.1] — 2026-07-06

### Fixed

- **The dashboard now notices every scrape — not just its own.** When a batch finished from the 7am scheduler, Telegram's `/scrape`, or the tray menu, the dashboard sat stale until you refreshed by hand (its only completion-watcher was tied to the page's own Scrape button). The 5s status poll now watches the batch's `generatedAt` stamp: the moment a fresh batch lands — started from *anywhere* — the job list and stat tiles auto-refresh and a green **"Scrape complete — N jobs ranked"** banner appears with a **View jobs** button (plus a toast). The banner stays until dismissed, so a 7am batch still greets you when you sit down at 9. First page load only records a baseline — an old batch doesn't get celebrated as new. The Scrape button's private 12×12s polling loop is gone (the detector owns completion for all sources); its progress bar now clears on batch-land or a 45-min safety timeout. Front-end only — `generatedAt` was already in the status payload.

---

## [3.0.0] — 2026-07-06

> **The dashboard grows up.** v2.x bolted a control surface onto a status page — one long scroll where the jobs you actually came for sat below the fold, behind status cards and settings forms. v3.0 is a ground-up redesign of `wrapper/dashboard.html` into a real application: sidebar navigation, a jobs-first layout, search/filter/sort over the whole batch, and professional interaction polish throughout. **Zero backend changes** — every wrapper route, API payload, and CSRF check is byte-identical to v2.9; this is a pure front-end release, which is also why nothing about scraping, scheduling, Telegram, or profiles needs re-verifying.

### Added

- **App shell with sidebar navigation.** Six views — **Jobs · Searches · Resume · Profiles · System · Settings** — instead of one endless scroll. Navigation is hash-routed (`#jobs`, `#settings`, …) so a refresh or profile switch keeps your place. The sidebar shows live badges (job count, search-term count) and collapses to an icon rail on narrow windows. The topbar carries the active profile, live health chip, the 👁 Watch toggle, and the one primary action: **Scrape now**.
- **The Jobs view is a real explorer.** Stat tiles up top (jobs in batch · average match · strong matches ≥ 70% · batch date). Below: live **search** across title/company/source (press `/` from anywhere), a **match-strength filter** (All · ≥ 70% · 50–69% · < 50%), and **sorting** by rank, match %, title, company, or YOE. Each row now shows a **match meter** (thin colored bar + %), the job's **YOE requirement**, and the **source query** that found it — data the scraper always captured but v2.x never displayed.
- **Session-sticky Applied state.** Marking a job applied greys it out and strikes the title; the mark survives list refreshes and the mid-scrape re-polls (v2.x reset the button on every render). "Why" expanders survive re-renders too.
- **Custom modal system.** Native `confirm()`/`prompt()` dialogs (Clear-all terms, profile rename/delete) are gone — replaced with in-app modals that match the design, support Esc/Enter/backdrop-click, and return focus where you left it.
- **Scrape progress feedback.** A slim indeterminate progress bar runs under the topbar while a scrape is in flight; polling stops early and toasts "Fresh batch loaded — N jobs" the moment a new batch lands, instead of always burning the full 12 polls.
- **Manual update check.** System page gains a "Check for updates" button (the 30-min auto-check and the update banner are unchanged).
- **Skeleton loading, empty states, richer toasts.** First batch load shimmers instead of flashing empty; a no-batch state offers a one-click Scrape; toasts carry status icons and are `aria-live` polite.

### Changed

- **Design system rebuilt** — deeper background, layered surface tokens, consistent radii/shadows, feather-style inline SVG icon set (self-contained, still zero external resources — the page works fully offline), `prefers-reduced-motion` respected, focus-visible rings throughout.
- **First-run setup wizard restyled** to match: numbered stepper with labels and connecting lines, same five steps, same wiring — every element ID, API call, and gating rule from v2.7 is preserved verbatim.
- **Export is a dropdown menu** (.txt / .csv / .xlsx with format hints) instead of three separate buttons.

### Notes

- Verified end-to-end against a stubbed wrapper: all six views, the setup overlay, modals, filters/sort, export menu, and the narrow-viewport rail screenshot-reviewed; zero console errors. Static checks: all 114 JS-referenced element IDs present, CSRF placeholder exactly once (Go test also asserts this), all SVG symbols defined. Suites: 153 node tests + full Go wrapper suite green.

---

## [2.9.0] — 2026-07-05

### Added

- **Watch the scrape happen.** The scraper browser was always a real (non-headless) Chromium, but it was parked off-screen at `(10000,10000)` so the daily 7am run never covers your desktop — which also meant you could never *see* it work. New **👁 Watch** checkbox next to "Scrape now": tick it and the scrape runs with the browser window on-screen (at `60,60`), so you can watch it open hiring.cafe, type each search term, and page through results. Unticked (and the scheduled run, and the tray trigger) stay off-screen as before. Implemented with an `AMM_SHOW_BROWSER=1` env flag the wrapper sets on the child scrape — no config, no new schema.

### Fixed

- **After an auto-update, the dashboard now pops back up — not just a tray icon.** The updater relaunches the freshly-installed AMM, but a just-upgraded dashboard's HTTP server can start a beat after the process, so opening the window immediately raced it and left you with a tray icon and no dashboard. The post-update relaunch now passes `--after-update`, and the wrapper waits for its own dashboard to actually answer (`/api/status` 200, up to ~12s) before opening the app window. (`waitForDashboardReady()`, 3 new Go tests.)

---

## [2.8.0] — 2026-07-05

### Added

- **"Clear all" button for your search terms.** The "What we search for" card now has a **Clear all** button next to Add — one click (with a confirm) empties the whole list, instead of removing terms one × at a time. Backed by a new `/api/jobs/clear` route + `jobs-clear` subcommand; profile-scoped, so it only clears the active profile's list.

### Changed

- **The keyword/titles toggle finally makes sense.** The old "Suggest searches as" dropdown was buried in Settings, barely mentioned "keywords," and did nothing visible when you flipped it — it only changed how a *future* resume rescan phrased its suggestions, with no hint of that. It's now **"Search style" and lives in the Resume card**, right next to Rescan and the suggestions it shapes, with a plain-language note. Flipping it **instantly re-suggests from your already-scanned resume** (no re-upload) as click-to-apply chips — Job titles → full roles like "IAM Engineer", Keywords → short terms like "iam". The note spells out that it shapes suggestions only and that you still apply terms + hit Scrape to see results. (New read-only `/api/suggest` route + `suggest-current` subcommand; new pure `suggestTermsForMode()` helper, 6 unit tests. Suite: 153 green.)

---

## [2.7.0] — 2026-07-04

### Added

- **Setup happens in the dashboard, not a terminal.** First-run onboarding is now a five-step interactive panel in the dashboard's app window — the terminal wizard (a black cmd box with `Press Enter…` prompts) is gone from the user-facing surface. Step 1 uploads your resume + picks search terms from the parsed CV; step 2 sets your name / YOE / salary / city (with live geocode lookup) / scrape time / all filter toggles in one form; step 3 opens the required hiring.cafe warmup browser (Cloudflare cleared + optional sign-in) and polls until the child exits; step 4 optionally connects Telegram or skips; step 5 saves everything and registers the daily scheduled scrape. The wrapper's tray poll detects the freshly-written `config.json` on its own and transitions out of "needs setup" mode — no new IPC. Installer no longer spawns a terminal window; the tray's Setup menu item opens the dashboard instead. `scripts/setup-wizard.mjs` survives as a dev/CI escape hatch via `npm run setup`. (New: `scripts/scheduler-register.mjs` extracted from the wizard so both surfaces can register tasks; five new `dashboard-api.mjs` subcommands and matching `/api/setup/*` routes; `needsSetup: bool` on `/api/status`. 16 new unit tests across the setup builder + scheduler platform selector.)

---

## [2.6.0] — 2026-07-03

### Added

- **Manage profiles from the dashboard.** The Profile card is now a full CRUD panel — add a new profile with a name of your choice, switch between profiles, rename, or delete. Multi-profile was already wired end-to-end (per-profile CV, queries, filters, scoring, last-batch — landed in v1.0) but the desktop UI was read-only, so you had to use the Telegram bot's `/profile` commands to manage them. Now the dashboard reaches parity. A newly-added profile inherits your current settings + CV; switch to it and upload a different resume from the Resume card to specialize it. (`/api/profile/{list,add,rename,delete,switch}`; new `renameProfile()` in `scripts/profile-store.mjs`.)

---

## [2.5.0] — 2026-07-03

### Added

- **Recency filter — control how recent jobs must be.** New "Job recency" dropdown in the dashboard settings: Any time (default) · Posted today · Last 3 days · This week · This month. Filters on the posted-age token hiring.cafe shows on each card (`5h`/`3d`/`2w`/`1mo`), captured by the scraper (`scripts/job-recency.mjs`). Deliberately client-side rather than guessing hiring.cafe's private date param — a wrong guess there silently returns zero jobs. Fail-open: a job whose age can't be read is never hidden. Config: `filters.maxJobAge`.
- **Rescan resume from the dashboard.** New "Resume" card: upload a new PDF/DOCX/MD/TXT, and AMM re-parses it into your CV (updating scoring) and suggests fresh search terms from it — pick which to keep and they replace your search list in one click. No wizard re-run. (`/api/resume/upload` + `/api/resume/apply`, backed by the existing resume parser + role/keyword suggester.)
- **Automatic update detection + one-click install.** The dashboard checks GitHub for a newer release on load (and every 30 min) and shows a prominent banner when one exists. One click downloads the new installer and runs it silently (per-user, no UAC) — it stops the running app, upgrades in place, and relaunches, all without leaving the dashboard. No more manually re-downloading the `.exe`. Windows gets the seamless path; macOS/Linux link to the release page. (`scripts/self-update.mjs`, `/api/update/check` + `/api/update/apply`.)

---

## [2.4.1] — 2026-07-02

### Added

- **`.xlsx` export with clickable apply links.** CSV is plain text (RFC 4180) — it structurally cannot mark a cell as a hyperlink, so the `.csv` export's links are inert text in Excel. The new `.xlsx` export is a real Excel workbook where the Apply Link column is native clickable hyperlinks (blue, underlined), verified end-to-end by opening the generated file in Excel via COM automation. Available as a third dashboard button (`⬇ Export .xlsx`) and `/export xlsx` on Telegram. Built by a new zero-dependency writer (`scripts/xlsx-writer.mjs` — hand-rolled OOXML parts in a STORED-entry ZIP with table-driven CRC-32, ~200 lines instead of a multi-megabyte spreadsheet library), covered by 9 unit tests including the standard CRC-32 check vector and XML-escaping of scraped titles.

---

## [2.4.0] — 2026-07-02

Full project audit + the launch chain fixed for real: double-clicking AMM always brings up the dashboard window, and installer upgrades actually replace the running app. Plus a new minimal export: your apply links as .txt or Excel .csv.

### Added

- **Apply-links export as .txt or Excel .csv.** The dashboard's download button is now two: **Export .txt** and **Export .csv** (`GET /api/export?format=txt|csv`), and Telegram gained `/export csv`. Both produce a minimal list of exactly three things per job — number, job title, apply link (the resolved direct ATS URL, falling back to the hiring.cafe page) — built on demand from the active profile's `last-batch.json` so numbering matches the dashboard table. The CSV ships with a UTF-8 BOM + CRLF rows so Excel opens it cleanly. New `scripts/export-batch.mjs` (pure builders, unit-tested); the detailed `jobs(date).txt` archive written at scrape time is unchanged.
- Fixed in passing: Telegram's `/export` had been reading the pre-multi-profile `data/` path since v1.0 — it now exports the active profile's latest batch like everything else.

### Fixed

- **The single-instance lock never worked on Windows — the root cause behind ghost launches.** The liveness probe used the POSIX `kill -0` idiom (`os.Process.Signal(0)`), which on Windows *always* errors for processes the checker didn't spawn — so a live AMM always looked dead, its lock always looked stale, and double-clicking the icon quietly booted a second full instance (two tray icons, two dashboards) instead of surfacing the running one. Caught by a live launch test; the probe is now a real Win32 `OpenProcess` + `GetExitCodeProcess` check. (`wrapper/platform_windows.go`)
- **Double-click now always opens the dashboard window.** With the lock actually working, a second launch hands off to the healthy running instance: it health-probes the running dashboard (2s), opens its window, and exits. If the running instance can't serve a window — a stale binary from a pre-v2.2 install, or a crashed dashboard — the new launch **takes over**: kills the stale process tree, grabs the lock, and starts as the primary with the window. No more "double-click does nothing." (`wrapper/main.go`, `wrapper/appwindow.go`)
- **Installer upgrades now replace a running AMM.** Windows locks running executables, so installing over a live AMM silently kept the OLD `AMM.exe` running until reboot — which made every "fixed in this release" look broken on upgraded machines. `PrepareToInstall` now stops the AMM process tree (`taskkill /T /F`) before copying files. (`installer/amm.iss`)
- **Half-configured Telegram can no longer take down the whole tray app.** The wrapper considered Telegram "on" if a token existed; the bot demanded token *and* chat ID — so a token without a chat id made the supervisor spawn a bot that died instantly, burn its 3-per-hour restart budget, and exit the wrapper. Both sides now share one definition (valid token shape *and* numeric chat id), and the bot exits `0` with friendly guidance instead of crashing when Telegram isn't configured. (`wrapper/main.go`, `scripts/telegram-bot.mjs`)
- **Dashboard job actions hardened**: hiring.cafe URLs are shape-validated before being handed to a child process, and `applications.md` writes are serialized with the same `proper-lockfile` discipline as `config.json` — a dashboard "Applied" click during a running scrape can no longer race the batch's dedup read. (`scripts/dashboard-api.mjs`)
- **Setup wizard survives a missing/corrupt config template** at the finalize step instead of crashing. (`scripts/setup-wizard.mjs`)
- **`npm test` no longer trips over Chrome's own files.** The app-window browser profile (`data/app-window/`) contains extension files named `*.test.js`, which the bare `node --test` runner happily picked up. The runner is now scoped to `scripts/__tests__`.

### Changed

- The dashboard removes its `dashboard-port.txt` breadcrumb on clean shutdown, and stale ports are health-probed before any window opens against them.
- `daily-batch.mjs` header/comments updated to describe the v2.3 full-scan default (docs drift).

---

## [2.3.0] — 2026-06-14

Three fixes: it searches every keyword now, the tray shows the AMM logo, and the dashboard window reliably opens after install.

### Fixed

- **The scraper now searches every keyword, fully.** It used to stop scraping additional keywords once it had ~1.5× the target candidates (`targetJobsPerBatch`), so later keywords were never searched — which is why plenty of real jobs were missed and queries looked empty. New default `scoring.searchAllQueries: true` searches **every** configured keyword to the end (each paginated to `maxPagesPerQuery`), then moves on. Set it `false` to restore the old early-stop. The daily scheduled run's time budget was raised 20 → 45 min to accommodate the fuller scan.
- **The tray icon is the AMM logo**, not a gray square. It also no longer shows as "dead" when Telegram is off — with Telegram optional there's no bot heartbeat by design, so the tray now reads "running — Telegram off (desktop dashboard)" with the logo, instead of a red/gray error state. (New `scripts/build/make-tray-ico.mjs` generates a BMP/DIB `logo-tray.ico` — the system-tray loader can't read the PNG-compressed `logo.ico` used for the installer/favicon.)
- **The dashboard window reliably opens right after setup.** The wizard used to fire two launches (the `--background` scheduled task + a direct one) that raced for the single-instance lock — when the background one won, nothing opened and AMM just sat in the tray. Now setup launches the app once, with no flag, so the window comes up. The scheduled task stays registered for quiet auto-start at future logins.

---

## [2.2.0] — 2026-06-14

It's a real app now: launching AMM opens a proper window with the dashboard, instead of running only in the background.

### Added

- **AMM opens as an actual application window.** Double-click the desktop icon and a standalone, titled window comes up with the dashboard and the AMM logo in the title bar — no browser tabs, no address bar. Under the hood it's the installed Chrome/Edge in app-mode with its own isolated profile (nothing extra to bundle), so it looks and behaves like a native app. If it's already running quietly in the background, clicking the icon brings the window up. The login auto-start stays quiet in the tray (`--background`) so a window doesn't pop on every boot.
- **Download the jobs `.txt` from the app.** A “⬇ Download .txt” button in the Ranked jobs card serves the newest `jobs(<date>).txt` — the full, search-friendly batch — straight from the dashboard. (`GET /api/jobs-txt`.)

### Notes

- Verified live: the window opens via the resolved browser in app-mode, `--background` opens no window, the favicon serves the AMM logo, and the `.txt` downloads with the right filename. 5 new Go tests (browser resolution, app-mode args, port parsing).

---

## [2.1.0] — 2026-06-13

Desktop-first: the local dashboard is now a full control surface — see your ranked jobs, apply/save/track, tune settings, manage searches — and Telegram is an optional add-on you turn on from the GUI.

### Added

- **The dashboard is now a complete job-application UI.** The ranked batch renders as a full list (all 100, not a top-10 glance), each row with **Apply** (opens the direct ATS link), **Why** (expands the CV keywords that matched), **Save**, and **Mark applied** (records locally so the job is deduped from future batches, plus a best-effort hiring.cafe action). New `scripts/dashboard-api.mjs` backs every action; the wrapper execs it and relays JSON. New endpoints: `GET /api/batch`, `POST /api/job/action`.
- **Settings panel in the dashboard.** Edit max YOE, salary floor, match floor, daily scrape time, clearance filter, application-form filter, and search-suggestion mode — written through the profile-aware `config-rw`. New `GET /api/settings`, `POST /api/settings/set`.
- **Search-term management in the dashboard.** See, add, and remove the terms AMM searches (titles or keywords) as chips. New `POST /api/jobs/{add,remove,mode}`.
- **Telegram is now optional.** AMM runs fully without it — the batch still scrapes, scores, and lands in the dashboard + `jobs(date).txt`. The setup wizard's first step is now a single "Set up Telegram phone notifications now? [y/N]" (default **no**), which skips the @BotFather token dance entirely for anyone who just wants the desktop app. "Is Telegram on?" is defined in one place (`scripts/telegram-config.mjs#telegramConfigured` — token + chat present and well-shaped); the wizard, `daily-batch.mjs`, and the Go wrapper all agree on it.
- **Set up Telegram from the dashboard.** The dashboard's Telegram card is now interactive: paste your bot token → Validate → "send your bot a message" → Detect my chat (or paste the chat id) → Save & enable. A Disable button turns it back off. Backed by `scripts/telegram-setup.mjs` (validate/detect/save/disable) — all Telegram API talk stays in Node; the wrapper just relays its JSON.
- **"Scrape now" button in the dashboard.** Trigger a fresh batch from the GUI (same as the tray's "Run scrape now"), so the dashboard is a self-contained control surface — no need to reach for Telegram or the tray.
- **Localhost CSRF protection** for the new state-changing endpoints: the wrapper mints a per-process token, injects it into the served page, and requires it (plus a loopback `Host`) on every POST. A random web page can reach `127.0.0.1` but can't read the page, so it can't forge the token. Covered by Go tests.

### Changed

- **The wrapper supervises the bot poller only while Telegram is enabled.** A desktop-only install no longer crash-loops a token-less bot — the supervisor idles and the dashboard runs. Enabling Telegram from the GUI brings the poller up within a few seconds (no restart); disabling it stops the poller immediately. The first-run "needs setup" gate is now keyed on `config.json` existing, decoupled from Telegram (`isSetUp` vs `telegramEnabled` in the wrapper).
- **Setup wizard messaging is desktop-first** — the closing screen points at the dashboard ("Open dashboard → Scrape now") and only mentions Telegram if you connected it. The "AMM is running" verification now also accepts the dashboard coming up (via `data/dashboard-port.txt`), so it works for token-less installs too.

### Notes

- Existing installs are unaffected: a `.env` with a token = Telegram stays on, exactly as before.
- 19 new tests (Go CSRF guard + token injection + the setup/telegram split; node `telegramConfigured`).

---

## [2.0.4] — 2026-06-13

### Fixed

- **AMM now actually starts when setup finishes.** The wizard's last step used to fire only `schtasks /run` and could end with nothing running — the user had to find and double-click the desktop icon themselves, with no hint that AMM must be running for the bot to respond. Now the wizard ALSO direct-launches the tray wrapper binary (safe to fire alongside the scheduler: the wrapper's PID-based single-instance lock makes a duplicate launch exit cleanly), verifies via the bot log, and says it plainly in the console and the Telegram ping: "🟢 AMM is running in your system tray. Keep it running — I only answer while it's up." On failure, both surfaces now point at the desktop icon instead of a bare `npm run bot`.
- **Installer upgrades over a configured install get a "Start AMM" checkbox** on the finish page (only shown when `.env` already exists — fresh installs are handled by the wizard launch above). Previously an upgrade that skipped the wizard ended with AMM stopped until next login.

---

## [2.0.3] — 2026-06-12

### Added

- **Keyword search mode.** New `search.mode` config (`titles` | `keywords`) controls what `/jobs suggest` and wizard step 5 propose: full job titles ("IAM Engineer" — precise searches, the default and previous behavior) or short domain keywords ("iam", "m365", "linux", "cloud security" — broader nets, with the CV-match scorer and `matchFloorPercent` doing the precision work). New `/jobs mode titles|keywords` bot command switches anytime; `/settings` shows the current mode. Every cluster in `role-suggester.mjs` now carries a curated keyword list alongside its title list (`suggestKeywords()` shares the same signal-density ranking as `suggestRoles()`). The scraper is unchanged — it searches whatever strings are in `queries[]`, so titles and keywords can be mixed freely via `/jobs add`.

---

## [2.0.2] — 2026-06-12

### Changed

- **Custom AMM logo on everything user-facing.** The full money-printer logo (`wrapper/logo.png`) is now the icon for the setup exe, `AMM.exe` (embedded via go-winres), Start-menu/desktop shortcuts, and Add/Remove Programs. New `scripts/build/make-ico.mjs` converts any PNG to a multi-size Windows `.ico` (256→16 px) using a headless run of the system browser — zero new dependencies. The color-coded tray icons (`icon-{green,yellow,red,gray}.ico`) are unchanged: those signal live bot status.

---

## [2.0.1] — 2026-06-12

> **Fast installs + branding.** The Windows installer's multi-minute silent "Installing dependencies" step is gone: AMM now drives your already-installed Chrome or Edge instead of downloading its own 150 MB Chromium, and `node_modules` ships inside the installer. Plus the setup exe and shortcuts finally carry the AMM icon.

### Changed

- **AMM uses your installed browser.** New `scripts/browser-launcher.mjs` resolves a browser at launch: installed Google Chrome → Microsoft Edge (preinstalled on every Windows 10/11 machine) → Playwright's downloaded Chromium → a clear error with instructions. All three Playwright launch sites (`daily-batch.mjs`, `job-action.mjs`, `login-once.mjs`) go through it. AMM still uses its **own** profile in `data/browser-profile` — only the browser *binary* is borrowed; your personal tabs, cookies, and sessions are untouched, and it runs fine while your own Chrome is open. Override per profile in `config.json`: `browser.channel` (`auto`/`chrome`/`msedge`) or `browser.executablePath` (Brave, distro chromium, portable installs). 12 unit tests.
- **Installer ships `node_modules`.** All runtime deps are pure JS, so CI's `npm ci` output is packaged into the installer instead of re-downloaded by every user. The `npm install` post-install step is deleted outright.
- **Chromium download is now conditional + visible.** Only runs when no Chrome/Edge exists (effectively never on Windows), and without `runhidden` so Playwright's real progress bar shows instead of a static "this may take a few minutes" message. Same conditional logic added to the git-based `install.ps1`.
- **Icons.** The setup exe gets the AMM icon (`SetupIconFile`), Start-menu/desktop shortcuts and Add/Remove Programs point at `wrapper/icon-green.ico`, and `make build-win` now embeds the icon into `AMM.exe` itself via go-winres (pinned `v0.3.3`, runs at build time in CI; config in `wrapper/winres/winres.json`).

### Notes

- If you switch browsers later (e.g. Chromium profile → Chrome) and scraping misbehaves, delete `data/browser-profile` and re-run `npm run login` — the profile is just Cloudflare cookies and rebuilds in ~30 seconds.

---

## [2.0.0] — 2026-06-11

> **Audit remediation.** A full repo audit found four classes of silent failure that survived every release since v0.5. All fixed, with regression tests pinning each one down. Also ships the hiring.cafe `/viewjob/` → `/job/` path migration that was sitting in Unreleased.

### Fixed — Hiring.cafe path migration (`/viewjob/` → `/job/`)

- **`scripts/daily-batch.mjs`, `scripts/login-once.mjs`** — hiring.cafe migrated their job-page path from `/viewjob/<id>` to `/job/<id>`. Every scrape since the upstream change failed the browsability gate (`a[href^="/viewjob/"]` matched zero cards) and emitted the misleading "Hiring.cafe session expired. Run npm run login" message — running `login-once` couldn't fix it because the warmup poller used the same dead selector. Updated the three scrape-side selectors and the warmup poller to `/job/`.
- **`scripts/telegram-bot.mjs`** — the bot's id → URL builder (`'https://hiring.cafe/viewjob/' + id`) now emits `/job/`. The `/history` and `/saved` regex parsers accept both the legacy `/viewjob/` and current `/job/` paths so a pre-v1.3 `applications.md` / `saved.md` still dedupes and renders.
- **`scripts/daily-batch.mjs`** — `loadAppliedHrefs()` regex widened to `(?:viewjob|job)`, canonicalizes to `/job/` on the way out so dedup matches regardless of which path the URL was originally stored under.

### Fixed — Audit remediation

- **`/update` actually works now.** Since v0.5, typing `/update` silently ran a *scrape* instead of the update flow — `update` was still listed as a scrape alias from the pre-v0.5 days, and the scrape dispatcher matches first. The alias is gone; `/update`, `/update skip`, `/update check`, and `/update notes` all reach the real handler for the first time in five releases.
- **Scoring: CV terms ending in `+` never matched.** `Security+`, `C++`, `A+` and friends could never score — the trailing `\b` word boundary after a non-word character matches nothing. Jobs mentioning `Security+` got zero cert credit, and `resume-parser` never extracted those terms from CVs either. New shared `scripts/term-match.mjs#termRegex()` anchors word boundaries only against word-character edges; both the scorer (exact + phrase-fallback paths) and the resume parser use it. Covered by `scripts/__tests__/term-match.test.mjs`.
- **`setup-tasks.ps1` failed to parse under Windows PowerShell 5.1.** The em-dash in a v1.2 status string, read as ANSI (the file had no BOM), decodes to a smart-quote that *terminates the string* — the whole script failed to parse, so the wizard's task-registration step broke on stock Windows. String is ASCII now, and `setup-tasks.ps1`, `uninstall.ps1`, and `install.ps1` all carry a UTF-8 BOM so PS 5.1 can never mis-decode them again.
- **Setup wizard verifies the bot actually started.** It used to fire the scheduler, wait 3 seconds blind, and declare "🎉 setup complete!" — a dead bot behind a success banner was the #1 silent failure mode. The wizard now watches `data/telegram-bot.log` for fresh output for up to 20s; on failure it prints recovery steps and adds a warning to the Telegram ping.
- **409 Conflict no longer looks like a dead bot.** An `{ok:false}` poll response (e.g. a second bot instance fighting over the token) used to be silently skipped — the loop re-polled at full speed forever. Non-ok responses now back off like network errors, and a 409 logs the cause + pings the chat once: "Another copy of the bot is running."
- **`/update` rolls back on failure.** If `npm install` fails (or the freshly installed deps can't actually be imported — a fresh-process import probe gates the restart), the repo is `git reset --hard` back to the pre-pull commit and the old bot keeps running. Previously the bot exited into new code with missing deps and crash-looped.
- **Concurrent scrapes can no longer trample each other.** The 7am scheduled task and a `/scrape` from Telegram run in separate processes; both could previously run at once — duplicate batches, and the loser's seen-jobs read-modify-write clobbering the winner's. `daily-batch.mjs` now takes `data/scrape.lock` (proper-lockfile; auto-refreshed mtime so the 30s stale ceiling tolerates multi-minute scrapes), and the loser skips with a friendly Telegram note.
- **Stripped-PATH strike three: bare `node` and `git` spawns.** The wizard, `/save`/`/applied`, `/reauth` (POSIX), `/scrape` (POSIX), and `/uninstall` all spawned `node` by name; `/update` spawned `git` by name. All self-spawns now use `process.execPath` (zero PATH dependency); `/update` resolves git via the new `os-paths.mjs#gitCmd()` (PATH probe → known install locations → clear error). The `.cmd` launchers gained a `%ProgramFiles%\nodejs` fallback. Also fixed: `os-paths.mjs#npmCmd()` called `require()` inside an ESM module — the APPDATA guess always threw (silently) and never worked; it now also prefers the `npm.cmd` sitting next to `node.exe`.
- **Wizard hang points removed.** Browser warmup (10 min), browsable-verify (90s), file-picker dialog (5 min — all three platform backends), and the token/chat-detection/final-ping fetches (15–20s) all have timeouts; any of them could previously freeze setup forever with no feedback.
- **Oversized Telegram messages can't kill a batch send.** A single block with no blank lines longer than ~3900 chars used to be sent as-is — Telegram rejects > 4096 and the whole batch send died. `chunkMessage()` (now exported + tested) hard-splits oversized blocks on line boundaries.
- **Telegram client hardening.** Non-JSON poll responses (HTML 502s from Telegram's CDN) now produce a named error instead of `Unexpected token <`; the bot token is scrubbed centrally inside `log()` so no call site can leak it; `data/telegram-bot.log` rotates at 5 MB (previous generation kept as `.1`).
- **Installer hangs de-mystified.** The ~150 MB Chromium download and `npm install` no longer run silenced — their progress output shows (an invisible multi-minute download is indistinguishable from a frozen installer). winget installs pin `--source winget` (the msstore source can throw an interactive prompt that hangs piped `iex` sessions) and check exit codes with clear manual-install fallbacks.

### Added

- `scripts/term-match.mjs` — shared term-matching regex builder (see Fixed above).
- `scripts/check-syntax.mjs` + `npm run check` — `node --check` parse gate over every script + test; wired into CI ahead of the test step.
- 11 new regression tests (`term-match.test.mjs`, `chunk-message.test.mjs`) — suite now at 76.
- `process.title = 'munyun-bot'` so the node child is identifiable in process lists.

### Changed

- CI/release workflows: `actions/checkout` and `actions/setup-node` bumped v4 → v5 (GitHub retires the Node 20 action runtime on 2026-06-16).
- `/update`'s npm install budget raised from 2 to 3 minutes.

---

## [1.3.0] — 2026-05-18

> **"AMM has a face now."** v1.2 made AMM look like a real app in the tray; v1.3 gives the tray a "Open dashboard" item that pops a local-only status page in your default browser. No new daemon, no extra port to open in your firewall — the dashboard binds 127.0.0.1 on an OS-chosen port and shuts down with the wrapper.

### Added — Local dashboard

- **`wrapper/dashboard.go`** — small HTTP server (Go stdlib `net/http`, no new deps) bound to `127.0.0.1` on an OS-assigned port at wrapper startup. Two routes:
  - `GET /` → single-page HTML, embedded via `//go:embed` so the binary stays self-contained (no CDN, works fully offline)
  - `GET /api/status` → JSON aggregation of `data/heartbeat.json` + `config.json` + `data/profiles/<active>/last-batch.json`, refreshed by the page every 5 seconds.
- **`wrapper/dashboard.html`** — self-contained page with a dark theme. Shows: bot state (alive / stale / dead — same thresholds as `scripts/watchdog.mjs`), Telegram connection (last poll OK + consecutive failure count), active profile + all-profiles list, last batch summary with the top 10 jobs (title / company / query / match %) and a direct-apply link. Auto-refreshes via `fetch` polling.
- **Tray menu**: new **Open dashboard** item between Status and Run scrape now. Reads the wrapper's bound port and opens `http://127.0.0.1:<port>` in the user's default browser via the existing cross-platform `openURL` helper.
- **`data/dashboard-port.txt`** — written by the wrapper at startup so external tooling (CLI checks, ops scripts) can find the dashboard URL without parsing wrapper logs.
- **`wrapper/dashboard_test.go`** — 9 table-driven tests for the pure `buildStatus()` aggregator: empty install, alive heartbeat, stale heartbeat, dead heartbeat, malformed heartbeat JSON, multi-profile enumeration with deterministic sort, last-batch job-limit cap, last-batch skipped without active profile, malformed last-batch JSON.

### Changed — Installer version sync

- **`installer/amm.iss`** — `MyAppVersion` is now injected by CI via `iscc /DMyAppVersion=<package.json version>`, with an `#ifndef` fallback for local dev runs. Fixes the recurring "installer .exe filename ships with a stale version" bug (e.g., v1.2.3 release had `amm-setup-v1.2.0.exe`). Going forward, the Windows installer asset name always tracks the tagged version.
- **`.github/workflows/release.yml`** — Windows job reads `package.json` and passes `/DMyAppVersion=...` to `ISCC.exe`.

### Security note

The dashboard binds to `127.0.0.1` only — it is not reachable from the LAN or the internet, regardless of firewall settings. There are no state-changing endpoints in MVP; all writes still go through the tray menu or Telegram. If you want to access the dashboard from another device, use an SSH tunnel rather than rebinding the listener.

---

## [1.2.3] — 2026-05-12

### Fixed

- **Linux .AppImage build (FUSE).** `appimagetool` is itself an AppImage and would mount itself via FUSE 2 to run — but Ubuntu 24.04 ships only libfuse3 by default, so `dlopen(): error loading libfuse.so.2`. Passing `--appimage-extract-and-run` to the appimagetool invocation tells its AppImage runtime to extract to a temp dir and exec the payload instead of mounting, sidestepping FUSE entirely. Works on any Linux runner regardless of libfuse2 presence.

---

## [1.2.2] — 2026-05-12

### Fixed

- **Linux .AppImage build.** `scripts/build/appimage.sh` was constructing the Node.js download URL as `node-v20.18.0-linux-x86_64.tar.xz` (the kernel uname), but the official Node.js tarballs use `linux-x64` / `linux-arm64`. The substitution `${ARCH/amd64/x64}` only handled the `amd64` alias, not `x86_64`. Replaced with an explicit `case "$ARCH"` map. Windows + macOS jobs in v1.2.1 succeeded; this gets Linux back in the mix.

No source-code changes vs v1.2.1. Pure release-pipeline patch (third in a row, but each one was a different latent CI bug).

---

## [1.2.1] — 2026-05-12

### Fixed

- **CI release pipeline.** Two fixes so `npm test` and Linux signing prereqs both pass on the GitHub Actions runners:
  - `package.json#scripts.test` now uses bare `node --test` (auto-discovers `**/*.test.mjs` from cwd). Node 20's `--test` doesn't expand globs as positional args, and Windows pwsh preserves the glob as a literal string — so the prior `node --test "scripts/__tests__/*.test.mjs"` failed on Windows with `Could not find ...*.test.mjs`. Verified locally: all 65 tests pass.
  - Dropped `dpkg-sig` from the Linux build's `apt-get install` line. Ubuntu 24.04 removed the package from its default repos; `scripts/build/sign-linux.sh` already probes for it at runtime and skips `.deb` signing gracefully when absent.
- **Release-asset hygiene.** The `.github/workflows/release.yml` no longer uploads the bare `AMM.exe` wrapper as a standalone Release asset — only the full one-click installers (`.exe` / `.dmg` / `.deb` / `.AppImage`). Avoids the "user downloads bare wrapper, gets a broken tray icon" confusion.

No source-code changes vs v1.2.0 — same wrapper, same node bot, same tray UX. Pure release-pipeline patch.

---

## [1.2.0] — 2026-05-11

> **"AMM as a real app."** v1.1 made AMM cross-platform; v1.2 makes it visible. The bot no longer launches as a minimized cmd window — it runs under a small Go wrapper (`AMM.exe` / `AMM-darwin-{arm64,amd64}` / `amm-tray`) that owns a system-tray icon, supervises the node bot as a child process, and shows up as a real app in Task Manager / Start menu / Apps & Features / Mac menubar / Linux app launchers.

### Added — Tray wrapper (Go binary)

- **`wrapper/`** — new Go module (single dep: `fyne.io/systray@v1.12.1`) producing a small native executable that owns the user-facing UX:
  - **System tray icon** with heartbeat-driven color: 🟢 green (< 5 min since last heartbeat), 🟡 yellow (5–10 min, stale-warning), 🔴 red (≥ 10 min, dead), ⚫ gray (initial). Staleness thresholds match `scripts/watchdog.mjs` so wrapper + watchdog agree on "dead."
  - **Tray menu**: Status (read-only label with pid / uptime / poll-fail count), Run scrape now, Pause/Resume daily batch, Open Telegram chat, View logs, Open install folder, Restart bot, Quit AMM.
  - **Supervises node bot as child process** with 3-strikes-per-hour respawn throttle, mirroring `watchdog.mjs:42-44` semantics. On exhausted budget the wrapper exits cleanly; the platform scheduler restarts it.
  - **Single-instance lock** at `data/wrapper.lock` (PID-based, cross-platform liveness probe via `Signal(0)`) prevents double-tray-icons when the scheduler races with a healthy wrapper.
  - **No console window** on Windows (`-H windowsgui` ldflag + `CREATE_NO_WINDOW` for child node spawns) — the user sees a clean tray icon instead of a flashing cmd window.
- **`wrapper/Makefile`** with `build`, `build-win`, `build-mac` (arm64 + amd64), `build-linux` targets. Auto-detects host platform on bare `make build`. Documents the CGO requirement for Mac/Linux (Cocoa + GTK native bindings — cross-compilation from Windows alone doesn't work; CI matrix handles it).
- **`wrapper/README.md`** — architecture, file layout, build instructions, single-instance lock semantics, the CGO/cross-compile caveat.
- **`package.json#scripts.build:wrapper`** convenience target → `cd wrapper && make build`.

### Changed — Scheduler launchers

- **Windows** (`scripts/setup-tasks.ps1`): `munyun-bot` scheduled task now launches `wrapper\dist\AMM.exe` (the tray wrapper), with a fallback to `scripts\start-bot.cmd` if the wrapper hasn't been built yet (fresh source checkout). The wrapper internally spawns node.
- **macOS** (`scripts/setup-tasks-mac.sh`): `com.amm.bot` LaunchAgent's `ProgramArguments` picks `AMM-darwin-arm64` → `amd64` → direct node, in that order.
- **Linux** (`scripts/setup-tasks-linux.sh`): `munyun-bot.service` `ExecStart` picks `wrapper/dist/amm-tray` if executable, else direct node. Adds `graphical-session.target` to `After=` so the tray has a desktop to live on.

### Changed — Installers + CI

- **Inno Setup** (`installer/amm.iss`): `MyAppVersion` → `1.2.0`; `MyAppExeName` → `AMM.exe` (was `node.exe`); Start menu + desktop shortcuts launch `AMM.exe` with the wrapper's own icon; `UninstallDisplayIcon` → `AMM.exe`. New preprocess-time `#error` if `wrapper\dist\AMM.exe` is missing so `iscc` fails loud instead of producing a broken installer.
- **macOS .dmg** (`scripts/build/mac.sh`): rsync exclude switched from `dist/` to `/dist/` so wrapper/dist/ binaries pass through. Auto-builds via `make build-mac` if not pre-built. Both arm64 + amd64 wrappers bundled.
- **Linux .deb** (`scripts/build/deb.sh`): same exclude fix. New `/usr/share/applications/automatic-munyun-machine.desktop` so GNOME/KDE app launchers list AMM. `/usr/local/bin/amm` wrapper gets a new `tray` subcommand.
- **Linux .AppImage** (`scripts/build/appimage.sh`): same exclude fix + auto-build. `AppRun` bare-call now launches the tray wrapper.
- **`.github/workflows/release.yml`**: each platform job sets up Go and runs `make build-{win,mac,linux}` before the installer step. AMM.exe is signed via `sign-windows.ps1` BEFORE Inno Setup packs it so the installer contains a signed inner .exe (required for SmartScreen reputation). Ubuntu job installs `gcc + libgtk-3-dev + libayatana-appindicator3-dev` for the systray CGO build.
- **`.github/workflows/ci.yml`**: smoke-test matrix now compiles + runs the wrapper's `--version` flag on every PR so CGO header / SDK issues surface at PR time instead of release time.

### Changed — Orphan cleanup

- **`scripts/watchdog.mjs`**: cmdline-match regex extended so an orphan `AMM.exe` (whose supervisor lost its node child without cleaning up) gets killed as a last-resort. Defense-in-depth — the wrapper's own supervisor + single-instance lock handle this in practice.
- **`scripts/uninstall.mjs`**: same regex extension on both Win32 (`ProcessName -eq 'AMM'`) and POSIX (`AMM-darwin|amm-tray`). Uninstall now fully cleans up tray-wrapper processes too.

### Architecture note

The v1.1 watchdog (`scripts/watchdog.mjs`) is **unchanged** and still works. It reads `data/heartbeat.json` (written by the node child) and restarts the scheduled task on stale heartbeat. The wrapper supervises its own child; the watchdog supervises the wrapper. Two layers, neither redundant — the wrapper handles fast respawn (node crashes within seconds), the watchdog handles wrapper-level death (whole process tree gone).

### Dependencies

Added Go ≥ 1.21 as a **build-time** prerequisite (not runtime — the compiled binary has no runtime deps). End users installing via the `.exe` / `.dmg` / `.deb` / `.AppImage` never need Go.

### Risks acknowledged

- **Linux tray icon depends on desktop environment.** GNOME requires the "AppIndicator and KStatusNotifierItem Support" extension; KDE works out of the box; minimal X11/Wayland window managers (i3, sway) may not show tray icons at all. If tray init fails, the wrapper still spawns the bot and writes logs — degrades to "invisible but functional," same UX as v1.1.
- **Wrapper updates require re-running the installer.** The bot's `/update` command (git pull + npm install + restart task) still works for JS-only changes. Wrapper binary changes need a fresh installer download.
- **Unsigned macOS wrapper hits Gatekeeper.** Until Apple Developer ID is configured, Mac users will see "AMM cannot be opened" on first launch — workaround is right-click → Open. Same friction as the unsigned .dmg in v1.1; v1.2 just shifts the surface one level inward.

---

## [1.1.0] — 2026-05-08

> **"Cross-platform + hardened."** Two parallel tracks bundled into one release: every HIGH-severity bug from the v1.0 code review closed, and Mac launchd + Linux systemd ports landed alongside a GitHub Actions release pipeline. Ships as one PR — no per-phase branches.

### Added — Cross-platform support

- **macOS** runs via launchd. New `scripts/setup-tasks-mac.sh` renders four LaunchAgent plists into `~/Library/LaunchAgents/` (`com.amm.bot` with `RunAtLoad`+`KeepAlive(Crashed)`, `com.amm.daily` with `StartCalendarInterval`, `com.amm.watchdog` with `StartInterval=300`, `com.amm.batch-missed` with `StartCalendarInterval`+1h).
- **Linux** runs via systemd user units. New `scripts/setup-tasks-linux.sh` renders four units into `~/.config/systemd/user/` and enables linger so they fire when the user isn't logged in.
- **Cross-platform installer** at `install.sh` mirroring `install.ps1`. Auto-detects platform via `uname -s`, installs missing prereqs (git, node ≥ 18) via `brew` / `apt-get` / `dnf`, clones into `~/Library/Application Support/automatic-munyun-machine` (Mac) or `~/.local/share/automatic-munyun-machine` (Linux), runs `npm install` + `npx playwright install chromium`, hands off to the wizard.
- **Bash launcher trio** (`scripts/start-bot.sh`, `scripts/run-daily-batch.sh`, `scripts/login-once.sh`) symmetric to the existing `.cmd` launchers.
- **Native file picker on macOS + Linux** via `osascript "choose file"` (Mac) / `zenity` (GNOME) / `kdialog` (KDE), with typed-path fallback when no GUI dialog backend is available.
- **`scripts/os-paths.mjs`** — single source of truth for system-binary paths (`POWERSHELL`/`CMD_EXE`/`SCHTASKS` on Win32, `BASH`/`LAUNCHCTL`/`SYSTEMCTL`/`OSASCRIPT` on POSIX), `npmCmd()` / `nodeCmd()` resolution, and scheduler abstractions (`runScheduledTask` / `disableScheduledTask` / `enableScheduledTask` / `scheduledTaskExists` / `deleteScheduledTask` — internally branch by `process.platform`). User-facing helper-name strings (`LOGIN_HELPER_DOC`, `SETUP_HELPER_DOC`, `RESTART_HINT_DOC`, `INSTALL_DIR_HINT`) resolve to the right per-platform path so Telegram messages render correctly across all three platforms.
- **`scripts/io-helpers.mjs`** — atomic write helpers (`atomicWriteText`, `atomicWriteJson`, `atomicUpdateJson`) with NTFS EPERM/EACCES/EBUSY retry, plus `withFileLock` / `lockedUpdateJson` / `lockedUpdateJsonSync` via `proper-lockfile` for cross-process serialization of `config.json` and per-profile JSON file writes.

### Added — Code signing + CI

- **`docs/SIGNING.md`** — maintainer playbook covering Microsoft Trusted Signing (Windows), Apple Developer ID + notarization (macOS), and GPG self-signed (Linux .deb / .AppImage).
- **`scripts/build/sign-windows.ps1`** — AzureSignTool wrapper.
- **`scripts/build/notarize-mac.sh`** — `xcrun notarytool submit --wait` + `xcrun stapler staple`.
- **`scripts/build/sign-linux.sh`** — `dpkg-sig` for `.deb`, detached GPG `.sig` for AppImages.
- All three signers degrade gracefully: missing secrets log `[skip signing — env:X not set]` and exit 0; releases still ship unsigned-but-functional artifacts.
- **`scripts/build/mac.sh`** — `hdiutil`-based `.dmg` builder. Stages source tree (excludes `node_modules`/`data`/`.env`/`cv.*`/`.planning`); embeds a "Run Setup.command" double-click target that runs `npm install` + `playwright install` + wizard on first launch.
- **`scripts/build/deb.sh`** — `dpkg-deb` builder. Installs to `/opt/automatic-munyun-machine` + `/usr/local/bin/amm` wrapper exposing `setup`/`daily`/`bot`/`login`/`uninstall` subcommands. Depends: `nodejs >= 18`, `git`. Recommends: `zenity | kdialog`.
- **`scripts/build/appimage.sh`** — `appimagetool` builder with a bundled Node 20 runtime so the AppImage works on minimal distros without system Node.
- **`.github/workflows/ci.yml`** — matrix CI on `(windows-latest, macos-latest, ubuntu-latest) × (Node 18, 20)`. Per-PR + per-push. Runs `npm test` on every leg + an `os-paths` import smoke test.
- **`.github/workflows/release.yml`** — triggered by `v*.*.*` tag push. Three parallel build jobs. Each runs tests, builds the platform installer, conditionally signs (best-effort), uploads as artifact. Final `publish` job downloads all artifacts, computes `SHA256SUMS.txt`, creates GitHub Release with auto-generated notes.

### Added — Tests

41 new unit tests bringing the total from 24 → 65 (all passing on Windows). Same suite runs on Mac + Linux via the CI matrix.

- **`scripts/__tests__/callback-router.test.mjs`** (18 tests) — `makeCallback` / `parseAndVerify` round-trip, sig determinism, action/idx/token-divergence checks, `requireToken` throw, `KNOWN_ACTIONS` whitelist, timing-safe sig compare via `crypto.timingSafeEqual`, malformed-input handling, full round-trip with `writeCallbackTable` + sig verification, stale-rotation rejection.
- **`scripts/__tests__/io-helpers.test.mjs`** (16 tests) — atomic write semantics, lock release on success/throw, `withFileLock` serializes `Promise.all` of three incrementers (final v=3, no lost updates), and the cross-process integration test: 3 child node processes × 30 increments each → final v=90 with no lost updates. (Pre-Phase 2 this routinely lost updates on Windows.)
- **`scripts/__tests__/watchdog.test.mjs`** (7 tests) — healthy heartbeat → no kill; stale → kill + start + recovery alert; F-M7 failed-start does NOT increment restarts; MAX_RESTARTS gives up with single alert; alert is suppressed on second consecutive give-up within 1h window; `pruneRestarts` drops old timestamps; no-heartbeat short-circuit.

### Changed — Cross-platform plumbing

- `telegram-bot.mjs` `/pause` / `/resume-bot` / `/reauth` / `/schedule` / `/update` restart all branch through `os-paths` instead of hardcoding PowerShell + schtasks. `/status` scheduled-tasks probe goes through `scheduledTaskExists`.
- `setup-wizard.mjs` `registerSchedulerForPlatform()` picks `setup-tasks.ps1` (Win32) / `setup-tasks-mac.sh` (Darwin) / `setup-tasks-linux.sh` (Linux) and `startBotForPlatform()` uses `runScheduledTask('bot')`. `POWERSHELL_EXE` retained as a Win32-only alias.
- `uninstall.mjs` cross-platform: launchctl bootout + plist removal on Mac, `systemctl --user disable --now` + unit removal on Linux. POSIX `process.kill` + `pgrep -f` cmdline cleanup replaces the PowerShell `Stop-Process` orphan-killer on non-Windows.
- All `config.json` and per-profile JSON writes (`seen-jobs.json`, `last-batch.json`, `last-batch-callbacks.json`, `auth-state.json`, `query-stats.json`) now route through `atomicWriteJson` / `lockedUpdateJsonSync`. The TOCTOU window in `cfgRW.set` / `appendUnique` / `removeFromArray` is closed.
- User-facing Telegram strings that referenced `scripts\login-once.cmd` / `scripts\setup-tasks.ps1` / `%LOCALAPPDATA%` now read from the platform-aware `LOGIN_HELPER_DOC` / `SETUP_HELPER_DOC` / `RESTART_HINT_DOC` / `INSTALL_DIR_HINT` constants.

### Fixed — Hardening (v1.0 code review findings)

Closes 9 HIGH + 7 MEDIUM findings from the GSD `gsd-code-reviewer` audit (`.planning/REVIEW.md`):

- **F-H1: HTML injection via unescaped `directUrl`** in batch + browser + history + saved messages. Added `escHtmlAttr()` helper that escapes `"` for href-attribute contexts (Telegram HTML mode does NOT auto-escape `"`); applied to every `<a href="…">` interpolation. `resolveOnePage` now rejects malformed `apply_url` values upstream via regex sanity check.
- **F-H2: Token scrubbing missing in `daily-batch.mjs` error paths.** Hoisted `SCRUB(s)` helper that tokenizes `TG_TOKEN` to `<TOKEN>`. Applied to `log()`, `tg()` throws, `tgDocument()` throws, the CLI outer catch, the bot's `unhandledRejection` handler, the resume-upload network error, and `setup-wizard.mjs` token validation. Local log files + Telegram-bound error messages no longer leak the token via fetch-internal `cause` chains.
- **F-H3: `fs.renameSync` not atomic on NTFS when destination exists.** `config-rw.mjs#atomicWrite` got an EPERM/EACCES/EBUSY retry loop with 50/100/150/200 ms backoff and unique tmp-file suffix. Phase 2 layered `proper-lockfile` advisory locking on top via `lockedUpdateJsonSync` so concurrent writers serialize cleanly. Cross-process integration test (3 children × 30 writes) confirms zero lost updates.
- **F-H4: HMAC keying defaults to literal `'no-token'` if missing.** `callback-router.mjs#requireToken` throws if the token is missing or < 10 chars; `parseAndVerify` returns `{ok:false}` for missing tokens instead of trusting a fallback-keyed sig.
- **F-H5: Browser context not closed on `scrape()` / `resolveAll()` failure.** Both wrapped in `try/finally` with `ctx.close().catch(() => {})` in `finally`. A page-1 navigation failure no longer leaves a Chromium LevelDB lockfile that blocks the next run.
- **F-H6: `unhandledRejection` handler brittle if `TG_TOKEN` undefined.** Defensive `SCRUB(s)` checks `TG_TOKEN` truthiness before `replace`; eliminates the `String.replace(undefined, …)` substring-replace failure mode.
- **F-H7: `loadAppliedHrefs()` case-sensitive viewjob ID regex.** Added `/i` flag + `.toLowerCase()` normalization at the boundary so an upstream ID-case shift doesn't silently re-show applied jobs. Same for `/history` callback URL parsing.
- **F-H8: `/forget last` writes seen-jobs without atomic.** Now goes through `atomicWriteJson(seenPath, seen)` — no more torn-write window where a concurrent scrape's `saveSeenStore` clobbers the user's `/forget last`.
- **F-H9: `addProfile` produces a broken first batch.** When `addProfile(slug, opts)` runs, it now copies `cv-parsed.json` from the source profile so the new persona inherits a working CV. `daily-batch.mjs` checks for an empty CV at startup and pings Telegram with a `/resume` nudge instead of running an all-zeros batch.
- **F-M1: `escHtml(e.message)` at 4 sites** that interpolated raw error text into `parse_mode:'HTML'` replies (weather / settings / geocoding / forget last).
- **F-M2: HMAC sig comparison uses `crypto.timingSafeEqual`** instead of `===`. Flagged for cryptographic-primitive correctness even though the practical timing-oracle risk is essentially nil here.
- **F-M3: `KNOWN_ACTIONS` whitelist** gates `makeCallback` and `parseAndVerify` before the HMAC compute.
- **F-M5: Decay-then-add race in `saveSeenStore`.** Dropped the belt-and-suspenders `blockedSet` rewrite that reset `firstSeenAt` for near-expired entries. The documented "60-day decay since first sighting" promise now actually holds — preserves original `firstSeenAt` by reading the pre-decay store.
- **F-M6: Watchdog cmdline regex anchored to `telegram-bot\.mjs`** (was a bare substring match — could collateral-kill an editor process whose CLI happened to contain "telegram-bot"). Same anchor fix in `uninstall.mjs#killBot`.
- **F-M7: Watchdog only counts a successful restart** toward `MAX_RESTARTS`. A transient scheduler failure no longer burns one of the three retry slots when no restart actually happened.
- **F-M10: Profile-store migration rename failure** now `console.error`s instead of silently swallowing — stranded data files would have looked like an empty new install after migration.
- **F-M13: `/jobs add` fallback slug for non-Latin terms.** Empty key would silently collide with another non-Latin query in `results[key]`; now derives `q<timestamp>` if the slug collapses to empty.

### Removed

- `setup-tasks.ps1` legacy `career-ops-*` Task Scheduler migration block (was gated on "until v1.x"; we are now v1.x). Anyone upgrading from v0.1 must `schtasks /delete /tn career-ops-*` by hand. The block was a no-op on every install ≥ v0.2.

### Added — Dependencies

- `proper-lockfile@^4.0.0` — single new prod dep (~30 KB), used for advisory file locking around `config.json` + per-profile JSON writes.

---

## [1.0.0] (post-release patches — superseded by v1.1)

### Fixed — v1.0 post-release patch

- **Daily batch was running only the 3 default queries instead of the user's full list (and weather + filters were silently disabled).** Regression introduced by E5 multi-profile migration: `daily-batch.mjs`, `batch-missed-watcher.mjs`, and `setup-tasks.ps1` had their own raw `JSON.parse(fs.readFileSync('config.json'))` reads that didn't know about the new `{active_profile, profiles: {<slug>: {...}}}` schema. After migration, `CFG.queries` / `CFG.weather` / `CFG.filters` / `CFG.scoring` resolved to `undefined`, which fell through to hardcoded defaults — 3 queries (`IAM Engineer`, `Cloud Security Engineer`, `Cybersecurity Engineer`) and the weather-unavailable fallback. Fixed by routing all three through `readActiveConfig()` (in `daily-batch.mjs` and `batch-missed-watcher.mjs`) and adding a profile-aware schedule lookup in `setup-tasks.ps1`. Verified end-to-end: live `/scrape` now fires all 16 of this dev's queries (raw=409 vs the 116 the bug produced) and surfaces 38 fresh jobs with weather + dropTitlePatterns + skipCompanies filters all active.
- **Direct ATS apply URLs were silently 100% broken.** `resolveOne()` used Node `fetch()` to read viewjob HTML and regex-extract `apply_url`. Hiring.cafe (Cloudflare in front) returns 403 to plain HTTP fetches — even authenticated `APIRequestContext` with the bot's session cookies gets 403. The function caught the error and returned null, so every batch fell back to hiring.cafe links via `directUrls[i] || r.href`. Today's pre-fix log showed `resolved=0/38`. **Fixed** by replacing `resolveAll` with a Playwright-based resolver that reuses the persistent `browser-profile/` (auth carries over), spawns 5 concurrent `page.goto()` workers, and extracts `apply_url` from the rendered HTML. Verified live: `resolved=59/59` on the post-fix scrape. Cost: ~30s for 60 jobs (was ~5s but failing); acceptable for a daily cron.

### Added — v1.0 post-release patch

- **Pagination across hiring.cafe search results.** The scraper now clicks the `a[aria-label*="next" i]` pagination link to pull pages 2..N per query, up to `MAX_PAGES_PER_QUERY` (default **50**, configurable via new `config.scoring.maxPagesPerQuery`). Stops early when Next disappears OR a new page returns zero new cards (per-query dedup against viewjobUrl). Live verification: `cloud security` query alone went from 40 cards (page 1 only) to 80 cards (2 pages of unique results); `iam` went 40 → 120 across 3 pages; `IAM Engineer` went 40 → 120; `M365 Administrator` 40 → 115. Total run: raw=698 vs 409 pre-fix (+70%), fresh-after-dedup 74 vs 40 (+85%), 59 jobs delivered vs 38.
- **Target-driven cross-query early stop.** New `config.scoring.targetJobsPerBatch` (default 100). After each query's pagination, the bot computes a running fresh-after-dedup estimate. Once it hits `target × 1.5` (50% headroom for filter+floor losses), the QUERIES loop exits early. On heavy-supply days this cuts batch time dramatically — live verification: scrape ran only 1/16 queries (IAM Engineer paginated 8 pages to 301 raw cards) and stopped early. Total scrape time: ~55 sec vs ~3 min.
- **`/saved` command.** New paginated browser of locally-bookmarked jobs (`data/profiles/<active>/saved.md`), 5 per page, `⬅️/➡️` inline-button navigation. Counterpart to `/history`. Used by `/save N` and the `[💾 Save]` callback button.

### Changed — v1.0 post-release patch

- **Hiring.cafe scrape is now auth-OPTIONAL.** Replaced the Google sign-in dance in `scripts/login-once.mjs` with a passive Cloudflare warmup: a visible Chromium window loads `hiring.cafe/`, waits up to 45s for Cloudflare's bot challenge to auto-resolve (job cards become visible), and saves the persistent profile. **No Google sign-in required.** Hiring.cafe lets logged-out users browse jobs; the only blocker for headless scrapes was Cloudflare's challenge, which a real-browser visit clears. The persistent profile keeps the "challenge passed" cookie for subsequent headless runs. Verified: a fresh, never-signed-in profile passes Cloudflare in ~20 seconds and returns full 40-card pages on `cloud security` queries, plus extracts `apply_url` from individual viewjob pages successfully.
- **`scripts/daily-batch.mjs::checkLogin()` → `checkBrowsable()`.** Probes a search URL and waits up to 25s for cards to render. Returns true if the search UI works at all — the only thing the scraper actually needs. Old `checkLogin` visited `/saved` (auth-only); replaced because we no longer require auth.
- **`searchState.hideJobTypes` field removed** from search URL building. That field only takes effect for logged-in users; we now scrape unauth. Local `seen-jobs.json` + `applications.md` cover the dedup we actually need. Side benefit: hiring.cafe returns more results per query because nothing's filtered server-side based on an account's history.
- **`/save N` and `/applied N` are now local-first.** They write to `saved.md` / `applications.md` *first* (source of truth), then attempt the hiring.cafe-side click as a best-effort. New exit code `7` from `job-action.mjs` means "not signed in — skipping hiring.cafe action" and the bot replies `✅ Saved/Applied locally. (Run /reauth to also act on hiring.cafe.)`. Users without a hiring.cafe account get full local bookmarking + applied-tracking; the hiring.cafe-side button-click is opt-in via `/reauth`.
- **Setup wizard Step 3 copy** rewritten: no longer mentions Google sign-in. Tells the user to wait for jobs to render and close the window. Sign-in inside the window is documented as optional (enables hiring.cafe-side `/save` and `/applied`).
- **`/help` text** updated: `/auth` and `/reauth` now noted as optional; `/saved` added.
- **Supply-diagnostics banner** in the morning batch now includes a dedup-pressure callout when ≥50% of filter-passing cards were dropped as already-seen, with a direct pointer to `seenJobsFreshnessDays` (the actual lever) instead of generic "try /forget last."

### Added

### Changed

---

## [1.0.0] — 2026-05-06

> **"Trustworthy and shareable on Windows."** Six sequenced epics (E1–E6) closing the foundational gaps the v0.5 audit surfaced: silent-death reliability, depth-blind scoring, IAM-bias, supply that decayed to nothing, single-user wall, and the install/uninstall lifecycle. Telegram-first remains the thesis; the planned-then-cut Tauri GUI does not return.

### Added — v1.0 E6 (Distribution + uninstall lifecycle)

- **Inno Setup `.exe` installer.** New `installer/amm.iss` builds an `amm-setup-vX.Y.Z.exe` that bundles `npm install` + `npx playwright install chromium` + the setup wizard. Standard Add/Remove Programs uninstaller works. Unsigned for v1.0 (signing arrives in v1.1).
- **`/uninstall` Telegram command** with inline confirmation buttons. `[⚠️ Pause only]` stops the bot + unregisters all four scheduled tasks but preserves data. `[☠️ Wipe everything]` does pause steps + deletes `data/`, `config.json`, `.env`, browser session. Bot can't delete its own dir; final message tells the user to remove the install dir by hand if they want the code gone.
- **`scripts/uninstall.mjs`** — orchestrator with `--mode=pause|wipe`. Idempotent — safe to re-run on partial state. Kills the bot via PID match (cleanest) + cmdline-match cleanup. Unregisters all four `munyun-*` Task Scheduler entries. Wipe mode also wipes data + secrets.
- **`scripts/uninstall.ps1`** — PowerShell wrapper for `iwr | iex` users. Symmetric to the install one-liner.
- **README rewrite** — `.exe` installer leads as the recommended path; one-liner kept as Option 2 for developers; manual install as Option 3. Old "Want to start over from scratch" troubleshooting section replaced with three uninstall paths (Telegram, Add/Remove, PowerShell).

### Added — v1.0 E5 (Multi-profile)

- **Multi-profile support.** One install, multiple personas. Each profile has its own CV, queries, filters, scoring, schedule, and seen-jobs memory. Browser session (`data/browser-profile/`), bot heartbeat, and machine-level state stay shared. New `/profile list / add <slug> / switch <slug> / delete <slug>` Telegram commands.
- **`config.json` schema migration.** v0.x flat shape (`{user, queries, filters, ...}`) auto-wrapped on first load into `{active_profile: "default", profiles: {default: {...}}}`. Migration is idempotent — safe to call from any script entry point. Existing per-profile data files (`cv-parsed.json`, `seen-jobs.json`, `last-batch.json`, `last-batch-callbacks.json`, `applications.md`, `query-stats.json`) relocated into `data/profiles/default/`.
- **`scripts/profile-store.mjs`** — single module owning profile CRUD, migration, and path resolution. `paths(slug?)` returns the canonical per-profile file slots; `addProfile` clones the active profile's config so a new persona inherits queries/filters and just needs a fresh `/resume` upload.
- **Profile-aware `config-rw.mjs`.** Existing dot-path setters (`set('user.salaryFloorUsd', X)`, `appendUnique('filters.skipCompanies', X)`) auto-route under `profiles[active].*` after migration. Existing `read()` returns a flattened view of the active profile so consumers like `daily-batch.mjs` keep working unchanged.
- **Per-profile data layout.** `data/profiles/<slug>/{cv-parsed.json, seen-jobs.json, last-batch.json, last-batch-callbacks.json, applications.md, query-stats.json}` — `/profile switch` swaps the entire active state cleanly. Today's TSV (`today-batch-{date}.tsv`) and downloadable jobs txt also live under the active profile dir.
- **Mid-batch switch handling.** If a user runs `/profile switch` while a batch is in flight, the switch is queued via the existing `runningJob` lock — surface message tells them to wait until the current scrape completes.
- **5 new profile-store smoke tests** in `scripts/__tests__/profile-store.test.mjs`. Total test count: 24 (was 19).

### Fixed — v1.0 E5
- **`/forget last` and `/settings` count are now schema-aware** — work against both the v0.x `{ids: [...]}` shape and the v1.0 `{jobs: {url: {...}}}` shape so users mid-migration aren't broken.

### Added — v1.0 E4
- **Inline-button paginated batch browser.** New `/batch [N]` command opens a tap-friendly job browser. Each page renders one job with action buttons `[💾 Save] [✅ Applied] [❓ Why] [🚫 Skip co]` and `[⬅️] [N/M] [➡️]` navigation. Replaces having to remember "save 42, applied 7" job numbers across a 100-message scroll-back.
- **Per-batch CTA after morning push.** Daily batch ends with a `🎯 Tap to act` message carrying `[📋 Open batch browser] [📊 Diagnose supply]` buttons — opens the new browser without typing.
- **`/history [N]` command.** Paginated past-application list read from `data/applications.md`, 5 entries/page. Inline `⬅️/➡️` nav.
- **Inline-keyboard inline-button-tap actions** for save/applied/why/skip-company. Tapping `[💾 Save]` runs the same `job-action.mjs save <url>` path that `/save N` uses; tapping `[🚫 Skip co]` adds the company to `filters.skipCompanies`.
- **Telegram `callback_query` handling.** Bot now subscribes to `callback_query` updates and dispatches via the new `scripts/callback-router.mjs` module. Each callback is HMAC-signed at mint time (`<action>:<idx>:<sig>` where sig = first 8 hex of HMAC-SHA256(token, action+idx+url)) so stale callbacks from rotated batches are rejected with "this batch has expired" rather than silently acting on the wrong job.
- **`data/last-batch-callbacks.json`** — per-batch callback table (idx → {url, company, title, directUrl, matchPct, score, yoe, q}). 7-day TTL. Written at end of each batch, read on every callback dispatch.
- **`tgEditMessage` + `tgAnswerCallback` helpers** — pagination edits the bubble in place rather than piling up new messages; callback acks turn off the loading spinner with optional toast text.

### Added — v1.0 E3
- **Match floor (FIXES "0% jobs in batch").** Default 25%; jobs below the threshold are dropped *before* the top-100 cut, so the bot never ships filler when supply is short. New `config.scoring.matchFloorPercent` field. New `/floor N` Telegram command (`/floor 0` to disable, `/floor 50` to be picky).
- **Seen-jobs freshness window (FIXES "only 7 jobs after a few weeks").** Schema upgraded from `{ids: string[]}` (boolean has-seen, grew forever) to `{jobs: {url: {firstSeenAt, lastSeenAt}}}`. Default 60-day decay: unapplied previously-seen jobs roll back into the supply pool. Applied jobs (read from `applications.md`) are always blocked. Old schema auto-migrates on first load. New `config.scoring.seenJobsFreshnessDays` field.
- **Phrase-proximity scoring + term-frequency cap.** Multi-token CV phrases that don't match exactly now get half-credit if all tokens appear anywhere in the JD ("AWS … 50 words … RDS" no longer scores zero). Matches are counted up to 3 occurrences (TF cap) so a JD mentioning "AWS" 8 times no longer ties one mentioning it once.
- **Cluster-aware scoring (kills the IAM-bias problem).** New `clusters` field in `cv-keywords.json` defines 11 role domains (iam, cloudsec, m365, devops, softwareEng, data, soc, networking, design, mobile, product) with signal terms. Resume parser computes hits per cluster and picks top-2 as `primaryClusters`. At scoring time, terms outside primary clusters get half weight — backend/data CVs no longer get IAM-biased rankings. New `cv-parsed.json#primaryClusters` and `clusterScores` fields.
- **Salary parser rewrite.** New `parseSalaryK()` exports handle `$120k–$160K`, `$120,000-$160,000`, em-dash + en-dash, `USD 120K-160K`, and rejects implausible numbers. The old regex extracted bare digits and accidentally matched "K" inside words like "Kotlin". 10 fixtures pin down the new behavior.
- **Supply-diagnostics banner.** When `afterDedup < 30`, the morning batch prepends a banner to the Telegram message: `⚠️ Limited supply today: 14 fresh jobs (typical: 50–80)` with actionable hints (`/forget last`, lowering `/floor`, expanding `/jobs add`). Decisions surface to the user instead of being buried in logs.
- **Per-query dry-run warning.** If any single search query has averaged 0 cards over 3+ consecutive runs, the next batch's banner names the dry queries: `⚠️ Dry queries (3+ days at 0 cards): "M365 Sec Engineer". Likely typo — edit via /jobs remove + /jobs add.`
- **First test suite.** `scripts/__tests__/salary.test.mjs`, `phrase-proximity.test.mjs`, `role-cluster.test.mjs` — 19 tests using built-in `node:test` runner. New `npm test` script.
- **Title heuristic hardened.** Card extraction now validates candidate titles against a non-title blacklist (`/^(full[- ]?time|part[- ]?time|remote|hybrid|onsite|contract|w2|c2c|us only|usa)$/i`) and falls through to the next candidate if the primary line is metadata bleed. Prevents `(untitled)` and "Full Time" / "Remote, US" titles in batches.

### Fixed — v1.0 E3
- **Seen-jobs persistence race.** `seen-jobs.json` was previously written at the top of the post-Telegram block but the variable mutation happened separately. The new write happens *only* after Telegram chunked-message delivery succeeded for the batch and only stamps the surfaced jobs.
- **`scoreJob` and `parseSalaryK` are now safe to import** — `daily-batch.mjs` gates its top-level pipeline IIFE behind a CLI-vs-imported check (`IS_CLI`) so test files can pull engine functions without triggering a real scrape + Telegram push at module load. `.env` validation also gated on CLI invocation.

### Added — v1.0 E2
- **Heartbeat + out-of-process watchdog.** Bot writes `data/heartbeat.json` every poll iteration with `{ts, pid, version, lastPollOk, consecutiveFailures}`. New `scripts/watchdog.mjs` runs every 5 minutes via Task Scheduler entry `munyun-watchdog` — if the heartbeat is stale > 10 min, it kills the bot, restarts the `munyun-bot` task, and pings Telegram via `scripts/telegram-send.mjs` (independent process, so a corrupt bot module can't take the alerter down). Throttled to 3 restart attempts per hour; after the limit, sends a single "give up — human needed" alert and stops trying. Solves the silent-death failure mode (we hit it during v0.5 release work — bot died without surfacing).
- **`/status` command.** One-screen bot health snapshot: process uptime, last heartbeat, last batch (date + count + funnel + score band), last auth-OK, batch-in-progress lock state, scheduled-task state. Read by user; structured similarly by the watchdog.
- **`/diagnose` command.** Answers "why am I getting only N jobs?" directly. Surfaces the last batch's funnel (raw → keptAfterFilter → afterDedup → sent), seen-jobs total, and per-query 7-day average card count with low-supply queries flagged. If the batch was below typical supply (< 30 fresh jobs), `/diagnose` includes hint actions (`/forget last`, `/jobs add`).
- **Per-query supply history.** New `data/query-stats.json` written by `daily-batch.mjs` after each scrape — rolling 7-day window of `{date, cards}` per query term. Read by `/diagnose`.
- **Funnel persistence in `data/last-batch.json`.** New `funnel: {raw, keptAfterFilter, droppedClearance, afterDedup, scored, sent, topPct, medianPct, bottomPct}` field. Read by `/status` and `/diagnose`.
- **Batch-missed watcher.** New `scripts/batch-missed-watcher.mjs` + Task Scheduler entry `munyun-batch-missed`. Runs 1 hour after configured batch time on configured days. If today's `data/today-batch-{date}.tsv` is missing, pings Telegram. Idempotent — won't re-alert for the same date. File-existence check is the truth; doesn't parse logs.
- **Initial heartbeat at bot startup** so the watchdog sees a fresh boot as alive within seconds, not after the first 30s long-poll round-trip.

### Fixed — v1.0 E2
- **`recordAuthOk()` no longer lies on a failed scrape.** Was previously called immediately after `/saved` loaded successfully, even if the subsequent scrape loop returned zero cards across all 15 queries. Now deferred to after the loop completes AND at least one card was extracted. `/status` and `/diagnose` no longer show "auth OK" when the user is effectively broken.

### Changed — v1.0 E2
- `setup-tasks.ps1` now registers four Task Scheduler entries instead of two: `munyun-bot`, `munyun-daily-batch`, `munyun-watchdog`, `munyun-batch-missed`. The watchdog runs every 5 min; the batch-missed watcher runs at scheduled-time + 1 hour on scheduled days.
- `scripts/telegram-bot.mjs` header comment refreshed in v1.0 E1 was missing 20+ commands shipped after v0.2; now lists the full set.

### Removed — v1.0 E1

- Stale `career-ops` references in `scripts/telegram-bot.mjs` (header comment + Task Scheduler entry name) and `scripts/telegram-send.mjs` (default test message). The dual-directory `career-ops/` ↔ AMM workflow described in `CONTEXT.md` was de facto deprecated; this commit cleans up the references and rewrites the relevant CONTEXT sections.

---

## [0.5.0] — 2026-05-06

### Added

- **Version everywhere.** The bot's startup ping now reads `🤖 Automatic Munyun Machine v0.5.0 — online`. Same for the `/help` header. Single source of truth: `package.json`'s `version` field.
- **`/version` command.** Shows running version + latest version on GitHub. Hint to run `/update` if behind.
- **`/update` command.** Pulls latest from `main` via `git pull`, runs `npm install` if deps changed, restarts the bot — all from Telegram. No more "open PowerShell, paste one-liner, walk wizard." Sub-commands: `/update` (run it), `/update skip` (don't notify me about this version again), `/update check` (re-check now), `/update notes` (show release notes).
- **Update notification on bot startup + once per day.** Bot polls GitHub Releases API on startup (after a 5s delay) and every 24h. If a newer version exists and you haven't dismissed it, you get a Telegram message: `🆕 Update available: v0.4.1 → v0.5.0` with what's new + the install command. No telemetry — outbound only, no auth, no identifying info.
- **Post-update confirmation.** After a successful `/update`, the new bot detects the upgrade and replies `✅ Updated to v0.5.0 (was v0.4.1)` instead of the generic startup ping. Clear signal that the upgrade worked.
- New `scripts/update-checker.mjs` module — handles GitHub API polling, semver comparison, dismissed-version persistence in `data/update-state.json`, and the post-update flag (`data/.updating`).

### Changed

- **`checkForUpdate` results cached for 5 minutes** to avoid hammering the GitHub API when a user spams `/version`, `/update check`, etc. `/update check` passes `{ force: true }` to bypass the cache when the user explicitly asks for a fresh check.
- Removed unused `getDismissed` import in `telegram-bot.mjs` (the `dismissed` field on `checkForUpdate`'s return value is what's actually used).

### Fixed

- **Bot commands that spawn Windows tools no longer fail with `exit -2` on stripped PATH.** Surfaced when a tester ran `/pause` and got `❌ Could not pause (exit -2)`. Same root cause as the v0.4.1 wizard PATH bug: `spawn('powershell', ...)` and `spawn('cmd.exe', ...)` rely on `PATH` lookup, which is missing `C:\Windows\System32` on some Windows installs we're seeing in the wild. Replaced every bare-binary spawn in `telegram-bot.mjs` with absolute paths resolved from `%SystemRoot%`. Affects `/pause`, `/resume-bot`, `/schedule`, `/reauth`, `/scrape`, and the `/update` restarter. Also surfaces spawn-error details to Telegram (e.g. `<i>spawn error: ENOENT</i>`) instead of just `exit -2` so the cause is visible.
- **`consumePostUpdateFlag` guards against false-positive "✅ Updated to vX.Y.Z" messages.** If `markUpdating` wrote the flag but the actual upgrade never landed (git pull/npm install failed before `process.exit`, or the bot restarted from stale code), the next bot boot would have lied about the upgrade succeeding. Now verifies `flag.to === currentVersion()` before reporting success — if mismatched, silently consumes the flag.

---

## [0.4.1] — 2026-05-05

### Added

- **Native Windows file picker for the resume step.** New `scripts/file-picker.mjs` spawns a real Windows OpenFileDialog from PowerShell. The wizard now offers three choices: pick from disk via dialog (default), upload via Telegram later, or type the path manually as a fallback. Eliminates the most error-prone step of the wizard for non-technical users.
- **Telegram-only setup path.** Users can skip the resume step in the wizard entirely and upload it later via the existing `/resume` Telegram command. The final wizard banner and the closing Telegram ping both nudge them. Useful when the resume isn't on the same machine as the install.
- **Friendlier error recovery for task registration.** If the Task Scheduler spawn fails, the wizard prints the exact one-line command needed to register manually instead of just dying.

### Fixed

- **Wizard no longer crashes at Task Scheduler step on stripped-down Windows installs.** The wizard's call to `spawn('powershell', ...)` relied on `powershell.exe` being on `PATH`. Some user environments — notably one that surfaced this in the wild — don't include `C:\Windows\System32` in `PATH`, so spawn returned `ENOENT` and the wizard exited mid-setup. Now uses the absolute path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, with friendly fall-through error messaging if the spawn still fails.
- **Wizard no longer prints `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` on shutdown.** The bot-start spawn used `detached: true` with default piped stdio, so the parent process held references to the child's stdin/stdout/stderr pipes. Combined with an explicit `process.exit(0)` at the wizard's end, libuv (Node's async I/O layer) hit an internal assertion at `src/win/async.c:76` because the event loop tried to operate on handles that were already closing. Two-part fix: spawn now uses `stdio: 'ignore'` + explicit `child.unref()` so the parent never tracks the child's pipes, and the wizard no longer force-exits — Node drains the event loop naturally.
- **Bot survives transient Telegram outages instead of silently dying.** Surfaced when the bot died during a 3-minute network blip and stayed dead until a manual restart. Three-part hardening to `telegram-bot.mjs`: (1) added `unhandledRejection` and `uncaughtException` process handlers so a single weird-shaped error never kills the process — gets logged with token scrubbed and the bot keeps polling; (2) exponential backoff in the poll loop (5s → 10s → 20s → 30s cap) so we don't hammer Telegram during outages; (3) recovery detection that logs `Telegram reachable again — recovered after N failed polls` when polls start succeeding again, plus a `📶 Bot reconnected after ~Xm of poll failures` Telegram ping if the outage was ≥ 60s so you know the bot was offline. Also wrapped `log()`'s file write in try/catch so a locked log file can't crash the bot.

---

## [0.4.0] — 2026-05-04

### Added

- **Downloadable batch as `.txt` attachment.** Every morning push now ends with a `jobs(YYYY-MM-DD).txt` file sent via Telegram `sendDocument`. Same data the message bubbles contain (rank, title, company, YOE, score, matched keywords, apply URL, view-on-hiring.cafe URL), but consolidated into one file you can open in any text app, search with Cmd+F, and keep forever in your Telegram chat history.
- **`/export` command.** Pull today's `jobs(YYYY-MM-DD).txt` on demand. If today's batch hasn't run yet, falls back to the most recent dated file with a label noting which day it's from. Replies "no batches yet" if `data/` is empty.
- Updated `/help` and bot top-of-file dispatch comment to list `/export`.

### Fixed

- `setup-tasks.ps1` no longer crashes on shells that interpret UTF-8 em-dashes oddly — em-dashes replaced with ASCII hyphens.

---

## [0.3.0] — 2026-05-04

### Added — bot commands

- `/scrape` (alias for `/daily`) — explicit name signaling on-demand scraping is fine, run as often as you want.
- `/why N` — explain why job #N got its match %, listing the matched CV keywords.
- `/settings` — full config dump in one Telegram message.
- `/resume` — upload a new resume as a Telegram document attachment; bot re-parses skills/certs/titles automatically.
- `/jobs` family — `/jobs` (list), `/jobs add "Title"`, `/jobs remove "Title"`, `/jobs suggest` (auto-suggest titles from CV).
- `/yoe N` — set max years of experience filter.
- `/salary N` — set salary floor in $K.
- `/clearance on/off` — toggle gov clearance filter.
- `/forms all|simple|long` — toggle hiring.cafe `applicationFormEase` filter.
- `/skip <company>` / `/unskip <company>` — manage company skip list.
- `/city <name>` — change weather city, auto-geocoded via open-meteo.
- `/schedule HH:MM` — change daily push time, auto-re-registers Task Scheduler.
- `/forget all` — wipe seen-jobs memory.
- `/forget last` — un-memorize the most recent batch.
- `/cancel` — cancel multi-step interactions like `/resume`.

### Added — wizard

- Setup wizard expanded from 5 steps to **10 steps**:
  - Step 5: auto-suggested job titles from parsed CV (accept all / pick subset / skip)
  - Step 6: max YOE
  - Step 7: salary floor
  - Step 8: clearance filter on/off
  - Step 9: city geocoding (auto-finds lat/lon)
  - Step 10: schedule + finalize (was step 5)

### Added — internals

- `scripts/config-rw.mjs` — atomic `config.json` read/write helper used by all settings commands.
- `scripts/geocode.mjs` — open-meteo geocoding wrapper (no API key, free).
- `scripts/role-suggester.mjs` — CV → suggested job titles by domain cluster (IAM, Cloud Sec, M365, DevOps, Software, Data, etc.).
- `daily-batch.mjs` writes `data/last-batch.json` with per-job match details, used by `/why N`.
- Wider `cv-keywords.json` dictionary (~1,500 terms) covering software, data, ML/AI, design, mobile, ops in addition to original IAM/cloud/security.
- `applicationFormEase` field in `config.json` for the new `/forms` filter.

### Fixed (v0.3.0 patch)

- `/weather` now reads from `config.json` instead of hardcoded Miami coordinates — was a regression where `/scrape` showed your real city but `/weather` always showed Miami.
- `.env` missing now produces a friendly error message pointing at the setup wizard, instead of crashing with `ENOENT`.
- `/resume` pending-state has a 10-minute timeout — stale `/resume` invocations no longer block all future attachments.
- `/save`, `/applied`, `/pause`, `/resume-bot`, `/schedule` spawn calls have a 30-60 second timeout — bot no longer hangs forever if a child process gets stuck.
- `runningJob` lock auto-resets after 5 minutes if the daily-batch subprocess is killed externally — was previously sticking until bot restart.
- `parseResume()` output is now validated before formatting the success reply — corrupted PDFs no longer crash the attachment handler.
- Telegram bot token no longer surfaced in caught error messages or log lines (defense-in-depth scrubbing).
- Allowed chat ID now masked in startup log (`***1234` instead of full ID).
- `setup-tasks.ps1` logs a warning if `config.json` is missing (was silently using defaults).

### Branding

- Task Scheduler entries renamed `career-ops-*` → `munyun-*` (auto-migrates on next `setup-tasks.ps1` run).
- `start-bot.cmd` window title renamed `"career-ops bot"` → `"munyun bot"`.
- `setup-wizard.mjs` final-step function renamed `step5Finalize` → `step10Finalize` for accuracy.

### Documentation

- `README.md` rewritten with full v0.3 command reference and updated 10-step wizard description.
- Roadmap updated to show v0.2 + v0.3 as shipped, future work listed for v0.4 / v1.0 / v2.0.
- `CHANGELOG.md` added (this file).

---

## [0.2.0] — 2026-05-02

### Added

- Initial public release of Automatic Munyun Machine.
- 5-step setup wizard (`scripts/setup-wizard.mjs`).
- One-liner installer (`install.ps1`).
- Telegram bot with daily 7am push of 100 ranked jobs (`scripts/telegram-bot.mjs`).
- hiring.cafe scraper using Playwright off-screen Chromium (`scripts/daily-batch.mjs`).
- Resume parser with curated keyword dictionary (`scripts/resume-parser.mjs`, `scripts/cv-keywords.json`).
- Persistent browser profile for hiring.cafe Google SSO login (`scripts/login-once.mjs`).
- Telegram commands: `/daily`, `/save`, `/applied`, `/auth`, `/reauth`, `/pause`, `/resume-bot`, `/test`, `/help`, `/weather`.
- CV-aware scoring with Option B calibrated percentage bands (30+ → 90-100%, 20-29 → 75-89%, etc.).
- Government clearance filter (drops Top Secret, TS/SCI, Public Trust, DoD).
- Local seen-jobs memory (`data/seen-jobs.json`) — never see the same job twice across runs.
- Auto-detect login state on each scrape; alert via Telegram if session expired.
- Branded Windows Task Scheduler entries: `munyun-daily-batch` (07:00 Mon-Fri) + `munyun-bot` (at logon).

[Unreleased]: https://github.com/7ustoo/automatic-munyun-machine/compare/v6.2.0...HEAD
[6.2.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v6.1.0...v6.2.0
[6.1.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v6.0.0...v6.1.0
[6.0.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v5.2.0...v6.0.0
[5.2.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v5.0.1...v5.2.0
[5.0.1]: https://github.com/7ustoo/automatic-munyun-machine/compare/v5.0.0...v5.0.1
[5.0.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v4.6.0...v5.0.0
[4.6.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v4.5.0...v4.6.0
[4.5.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v4.4.2...v4.5.0
[4.4.2]: https://github.com/7ustoo/automatic-munyun-machine/compare/v4.4.1...v4.4.2
[4.4.1]: https://github.com/7ustoo/automatic-munyun-machine/compare/v4.4.0...v4.4.1
[4.4.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v4.3.0...v4.4.0
[4.3.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v4.2.1...v4.3.0
[4.2.1]: https://github.com/7ustoo/automatic-munyun-machine/compare/v4.2.0...v4.2.1
[4.2.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v4.1.0...v4.2.0
[4.1.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v3.0.2...v4.0.0
[3.0.2]: https://github.com/7ustoo/automatic-munyun-machine/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/7ustoo/automatic-munyun-machine/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.9.0...v3.0.0
[2.9.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.8.0...v2.9.0
[2.8.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.7.0...v2.8.0
[2.7.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.4.1...v2.5.0
[2.4.1]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.0.4...v2.1.0
[2.0.4]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/7ustoo/automatic-munyun-machine/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v1.3.0...v2.0.0
[1.3.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/7ustoo/automatic-munyun-machine/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/7ustoo/automatic-munyun-machine/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/7ustoo/automatic-munyun-machine/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.5.0...v1.0.0
[0.5.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/7ustoo/automatic-munyun-machine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/7ustoo/automatic-munyun-machine/releases/tag/v0.3.0
[0.2.0]: https://github.com/7ustoo/automatic-munyun-machine/releases/tag/v0.2.0
