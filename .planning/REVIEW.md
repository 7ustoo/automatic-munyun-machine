# AMM v1.0 Code Review

**Reviewed:** 2026-05-07
**Scope:** Full repo, ~20 source files (Tier 1 deep, Tier 2/3 standard). Test files spot-checked.
**Outcome:** 0 CRITICAL / 9 HIGH / 14 MEDIUM / 11 LOW findings.

## Summary

The codebase is in better shape than its production-shipped-to-civilians status would predict. Crash safety nets, token scrubbing in the bot, atomic config writes, and the out-of-process watchdog all look thoughtfully designed; the test coverage of `parseSalaryK` is genuinely defensive. **No CRITICAL findings** — there are no token-leaking pathways with realistic triggers, no command injection sinks, and no path-traversal holes in user input.

The biggest real risks are concentrated in three places. **(1) HTML-injection in the Telegram morning-batch message** (F-H1) — `buildMessage()` in `daily-batch.mjs` interpolates the unescaped `directUrl` (from hiring.cafe's apply_url field, an attacker-controllable string) into both an `href` attribute and link text without `escHtml`. A malicious job posting could break the parse, inject Telegram formatting, or cause sendMessage to fail and the user never sees their batch. **(2) Token-scrubbing is missing in `daily-batch.mjs`'s top-level error catch** (F-H2) — the bot's belt-and-suspenders `.replace(TG_TOKEN, '<TOKEN>')` pattern is absent in the scraper, and that catch path can both log and re-send error messages back to Telegram. **(3) `fs.renameSync` is NOT atomic on Windows when the destination exists** (F-H3) — the documented "atomic config writes" assumption is wrong on NTFS, and concurrent bot+scrape writes will occasionally produce the dreaded `EEXIST`/`EPERM` followed by config corruption.

The HMAC sig check is non-constant-time (F-M2), but the practical impact is essentially nil because Telegram authenticates the callback origin upstream. The seen-jobs migration is idempotent against the documented schemas but has an unhandled edge case where decayed entries can be re-added in the same run (F-M5). v1.1 cross-platform readiness is decent — most paths flow through `path.join` — but `\\` literals in user-facing strings (F-M9) and the architectural assumption that `process.env.SystemRoot` exists everywhere are the worst offenders. Overall: ship v1.0 confidently; fix the HIGHs before the v1.1 cross-platform refactor begins so the new abstractions inherit a clean slate.

---

## CRITICAL findings

_None._ No token-disclosure paths with realistic triggers, no remote-code-execution pathways, no data-loss bugs that beat the watchdog.

---

## HIGH findings

### F-H1: HTML-injection via unescaped `directUrl` in batch message
**File:** `scripts/daily-batch.mjs:756`
**Category:** Security / Correctness
**Description:** `buildMessage()` interpolates the resolved direct ATS URL into both the `href` attribute and the link text without HTML-escaping:
```js
lines.push(`<b>${i + 1}.</b> ${title}${yoe} · <b>${pct}</b>\n<i>${co}</i>${matchedLine}\n<a href="${url}">${url}</a>`);
```
`url` is `directUrls[i]` (from `resolveOnePage`, which extracts `"apply_url":"([^"]+)"` from hiring.cafe-rendered HTML — fully attacker-controlled by the job poster) or falls back to `r.href`. The other interpolations (`title`, `co`, `matchedTop`) ARE escaped with `escHtml`. The URL is the one that isn't.

A job posting with an apply_url containing `"><b>` or even `<` will (a) break Telegram's HTML parse and bounce the entire send (caught silently by `tg`'s lack of a fallback — the user never sees their batch), or (b) inject spurious Telegram-supported HTML tags into the rendered message.
**Impact:** Hostile job posting can suppress the entire morning batch (DoS the user's only delivery channel) or inject content into the trusted bot message stream. No code execution, but high availability impact and trust violation.
**Fix:** Escape `url` everywhere it lands inside HTML. The `href` attribute also needs the apostrophe escaped to be safe, but `escHtml`'s `& < >` covers Telegram's HTML subset:
```js
const safeUrl = escHtml(url);
lines.push(`<b>${i + 1}.</b> ${title}${yoe} · <b>${pct}</b>\n<i>${co}</i>${matchedLine}\n<a href="${safeUrl}">${safeUrl}</a>`);
```
Also reject obviously-malformed URLs at extraction time in `resolveOnePage`:
```js
const m = html.match(/"apply_url":"([^"]+)"/);
if (!m) return null;
const u = m[1];
// Sanity check: must be http(s) URL with no embedded HTML
if (!/^https?:\/\/[^\s<>"]+$/i.test(u)) return null;
return u;
```

### F-H2: Token scrubbing missing in `daily-batch.mjs` error paths
**File:** `scripts/daily-batch.mjs:80, 92, 104, 958-960`
**Category:** Security
**Description:** The bot (`telegram-bot.mjs`) consistently scrubs `TG_TOKEN` from error messages before logging or surfacing them (lines 106, 110, 1471, 1498). The scraper does not. Specifically:
- `log()` writes anything passed to it into `data/daily-batch-${DATE}.log`. The top-level `catch` (line 957-960) does `log(msg)` and then `tg(msg)` where `msg = '❌ daily-batch failed: ' + (e.message || e)`. If a fetch into the Telegram API fails with a stack-trace-bearing error (e.g., Node's undici `cause` chain), the URL `https://api.telegram.org/bot<TOKEN>/sendMessage` can land in `e.message` or its toString.
- `tg()` and `tgDocument()` throw `'Telegram error: ' + JSON.stringify(json)`. Telegram's error JSON doesn't contain the token, but if an upstream error (network, DNS, AbortSignal timeout) wraps a fetch-internal error with a `cause` field, the token CAN appear in the message at `.cause.message`.
- The `setup-wizard.mjs` shows another instance: line 100-110 catches token-validation errors and prints `e.message` to stdout (and a transcript exists in some terminal histories).
**Impact:** Local log file `data/daily-batch-${DATE}.log` (and conceivably the morning-batch-failed Telegram message itself) can leak the bot token. Users routinely paste these logs when asking for help — meaning the token gets posted publicly. Once a token leaks, an attacker can read every message the user has ever sent the bot and impersonate the bot to the user.
**Fix:** Hoist a shared scrubber:
```js
const SCRUB = (s) => String(s ?? '').replace(TG_TOKEN || '__nonce__', '<TOKEN>');
function log(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${SCRUB(line)}`;
  console.log(msg);
  fs.appendFileSync(path.join(ROOT, 'data', `daily-batch-${DATE}.log`), msg + '\n');
}
// ...
} catch (e) {
  const msg = '❌ daily-batch failed: ' + SCRUB(e.message || e);
  log(msg);
  try { await tg(msg); } catch {}
  process.exit(1);
}
```
Apply the same scrubber to `tg()`'s throw, `tgDocument()`'s throw, `setup-wizard.mjs`'s `e.message` print at line 109, and `telegram-send.mjs:29`.

### F-H3: `fs.renameSync(tmp, CFG_PATH)` is not atomic on Windows when destination exists
**File:** `scripts/config-rw.mjs:46-50`, `scripts/profile-store.mjs:56-60`
**Category:** Correctness / Reliability
**Description:** The leading docstring claim ("Ensures multi-process safety… using temp-file + rename. All writes are atomic — no partial writes.") is not true on NTFS. Windows `MoveFileEx` is atomic only if the destination does not exist; with an existing destination, the call performs a non-atomic delete-then-rename. Two concurrent writers can:
1. Both write their `.tmp.<pid>` file.
2. Process A `renameSync` succeeds (deletes existing `config.json`, replaces it).
3. Process B's `renameSync` fires while NTFS still holds a transient lock on the destination from A's antivirus scan or open-handle reaper → `EPERM` / `EACCES`.
4. B's tmp file remains on disk. The bot on the next startup sees `config.json` and ignores `config.json.tmp.<pid>`. Data is not lost, but B believed its write succeeded.

Worse case: process B's `renameSync` succeeds at step (3) but partially overlaps with another reader (the wizard, the bot's `cfgRW.read()`) that has the file open — Windows can return ENOENT to the reader briefly mid-rename.
**Impact:** Concurrent bot + scrape writes (e.g., the morning batch is running and the user fires `/yoe 5`, or `/skip Acme` from the inline button + a cron-driven update) can silently drop the bot's write while Telegram reports success. User changes vanish unpredictably; the user blames "the bot is flaky."
**Fix:** Add a tiny retry-on-EPERM loop and assert post-write contents. The cheap fix:
```js
function atomicWrite(obj) {
  const json = JSON.stringify(obj, null, 2);
  const tmp = CFG_PATH + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, json);
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, CFG_PATH);
      return;
    } catch (e) {
      if (i === 4 || (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY')) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      // brief backoff for the AV/handle-cache window
      const delay = 50 * (i + 1);
      const end = Date.now() + delay;
      while (Date.now() < end) { /* spin — sync API, no setTimeout available */ }
    }
  }
}
```
The proper fix is a per-file lock (e.g., a `.lock` directory created with `fs.mkdirSync({ recursive: false })` for atomic-create-or-fail semantics) wrapping all read+modify+write sequences, since two concurrent readers each producing a divergent write is the actual data-loss scenario. For v1.0 just add the retry; for v1.1 add the lock.

### F-H4: HMAC keying defaults to literal string `'no-token'` if `TG_TOKEN` is undefined
**File:** `scripts/callback-router.mjs:46`
**Category:** Security
**Description:** `makeCallback` and `parseAndVerify` both fall back to `token || 'no-token'` for the HMAC key. If `TG_TOKEN` is ever undefined (e.g., bot started outside its own startup gate, an import-time race, or a future caller that forgets to read .env), every callback will sign + verify under the literal string `'no-token'`. Anyone who can reach the bot's chat with arbitrary callback_data can mint valid signatures by computing HMAC against `'no-token'`. The bot already gates all callbacks to `ALLOWED_CHAT`, so this is defense-in-depth, but the `'no-token'` fallback is the kind of lurking issue that becomes a CVE the moment a refactor relaxes one assumption.
**Impact:** None today (chat gate covers it); HIGH risk for v1.1 where the chat gate could be relaxed (e.g., webhook deployment, Mac/Linux multi-user installs).
**Fix:** Throw if no token; never accept the fallback for sign-or-verify operations.
```js
function requireToken(token) {
  if (!token || typeof token !== 'string' || token.length < 10) {
    throw new Error('callback-router: TG_TOKEN required for HMAC signing');
  }
  return token;
}
export function makeCallback(action, idx, viewjobUrl, token) {
  const sig = crypto
    .createHmac('sha256', requireToken(token))
    .update(`${action}:${idx}:${viewjobUrl || ''}`)
    .digest('hex')
    .slice(0, 8);
  return `${action}:${idx}:${sig}`;
}
```

### F-H5: Browser context not closed on early return in `scrape()` failure path
**File:** `scripts/daily-batch.mjs:284-301`
**Category:** Reliability / Resource leak
**Description:** `scrape()` opens a persistent context at the top, then loops over queries. If the page-1 navigation fails 3 times in a row (line 298: `if (attempt === 3) throw e`), the function throws WITHOUT calling `await ctx.close()`. The catch in the CLI block (line 957) doesn't know about `ctx`. Result: a Chromium browser instance is leaked — its lockfiles in `data/browser-profile/` will block the next scrape with "ProtocolError: connection closed" or "lockfile already taken" errors.

Same pattern in `resolveAll` (line 675-697): the `Promise.all` of pages happens inside try-less code; if any of them throw uncaught, `ctx.close()` never runs.
**Impact:** Repeated Chromium-leak after a network blip → next scheduled batch fails with a confusing lock error → user thinks the bot is broken. Compounded by the fact that the watchdog only watches the BOT, not the daily-batch process.
**Fix:** Wrap the entire `scrape()` body in try/finally. Same for `resolveAll`:
```js
async function scrape() {
  log(`Launching headless Chromium with persistent profile…`);
  const ctx = await launchBrowser();
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    // …all existing logic…
    return results;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function resolveAll(rows) {
  if (!rows.length) return [];
  log(`Launching browser for direct-URL resolution (${rows.length} jobs)…`);
  const ctx = await launchBrowser();
  try {
    // …existing logic…
    return out;
  } finally {
    await ctx.close().catch(() => {});
  }
}
```

### F-H6: Bot's `unhandledRejection` / `uncaughtException` handlers crash if `TG_TOKEN` is empty string
**File:** `scripts/telegram-bot.mjs:104-111`
**Category:** Reliability
**Description:**
```js
process.on('unhandledRejection', (e) => {
  const raw = e instanceof Error ? `${e.message}\n${e.stack || ''}` : String(e);
  log('UNHANDLED REJECTION: ' + raw.replace(TG_TOKEN, '<TOKEN>'));
});
```
`String.prototype.replace(searchString, replacement)` with `searchString = ''` replaces the FIRST EMPTY position — which is benign. But `replace(undefined, '<TOKEN>')` coerces undefined to the string `"undefined"`, which would replace literal `"undefined"` substrings. The startup gate at line 82 prevents `TG_TOKEN === undefined` (process.exit(1)), but if the .env happens to have `TELEGRAM_BOT_TOKEN=` (empty value), the gate passes (`!''` is truthy → exits)... actually, `!''` is true, so the gate catches that. Fine.

The real risk: if the bot lives long enough and someone runs `delete process.env.TELEGRAM_BOT_TOKEN` (no one does this, but…) the const `TG_TOKEN` is captured at startup so it wouldn't matter. Confirmed safe under current conditions, but the pattern is brittle.
**Impact:** None today. v1.1 risk: if cross-platform refactor moves env loading later or makes it lazy, this can silently misbehave.
**Fix:** Belt-and-suspenders — guard the scrubber:
```js
const scrub = TG_TOKEN
  ? (s) => String(s).replace(TG_TOKEN, '<TOKEN>')
  : (s) => String(s);
process.on('unhandledRejection', (e) => {
  const raw = e instanceof Error ? `${e.message}\n${e.stack || ''}` : String(e);
  log('UNHANDLED REJECTION: ' + scrub(raw));
});
```

### F-H7: `loadAppliedHrefs` regex assumes lowercase IDs; mismatch with seen-jobs would silently misbehave
**File:** `scripts/daily-batch.mjs:558`
**Category:** Correctness
**Description:**
```js
return new Set([...apps.matchAll(/hiring\.cafe\/viewjob\/([a-z0-9]+)/g)]
  .map(m => 'https://hiring.cafe/viewjob/' + m[1]));
```
The regex requires lowercase `[a-z0-9]+`. If hiring.cafe ever introduces uppercase IDs (unlikely but their fault, not yours), every applied job will be silently re-shown as fresh. Worse, the same regex pattern in `telegram-bot.mjs:1243` for /history will silently miss them.

Also: line 1156 collects URLs differently (`last.jobs[].viewjobUrl`) but the seen-jobs delete loop trusts that those URLs match what was stored. If `viewjobUrl` ever included a trailing slash on one path and not the other (it doesn't today — checked via the `r.href` source), the dedup would silently fail.
**Impact:** Latent regression risk if hiring.cafe URL scheme changes; user re-receives applied jobs and trusts the bot less.
**Fix:** Make the character class case-insensitive and document the assumption:
```js
return new Set([...apps.matchAll(/hiring\.cafe\/viewjob\/([a-z0-9]+)/gi)]
  .map(m => 'https://hiring.cafe/viewjob/' + m[1].toLowerCase()));
```
And anywhere a `viewjobUrl` is stored vs. compared, normalize once at the boundary.

### F-H8: `/forget last` writes to seen-jobs without atomic-temp-rename
**File:** `scripts/telegram-bot.mjs:1167`
**Category:** Reliability
**Description:** `/forget last` reads `seen-jobs.json`, mutates, then `fs.writeFileSync(seenPath, …)`. A concurrent daily-batch's `saveSeenStore` does the same (also non-atomic — `daily-batch.mjs:638` is a plain `writeFileSync`). If the user fires `/forget last` while a batch is running and `saveSeenStore` is mid-write, the file can be left empty or truncated. Next batch sees `JSON.parse` fail → falls back to `{ lastUpdated: null, jobs: {} }` → treats every job as new for one day.

This isn't catastrophic (the seen-jobs decay window is 60 days; one "everything is new" day produces a duplicate-heavy batch), but it's a silent regression that's hard to diagnose.
**Impact:** Occasional confusing duplicate batches; no data loss because applications.md (the actual source of truth for blocking) is still intact.
**Fix:** Push all seen-jobs writes through a single helper:
```js
// in profile-store.mjs or a new io-helpers.mjs
export function atomicWriteJson(filePath, obj) {
  const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);  // see F-H3 for the retry
}
```
Replace direct `writeFileSync(seenPath, …)` calls in `daily-batch.mjs:638` and `telegram-bot.mjs:1167`.

### F-H9: `setActiveProfile` / `addProfile` skip migration on the new profile's data dir
**File:** `scripts/profile-store.mjs:128-153`
**Category:** Correctness
**Description:** When `addProfile('newslug')` runs, it (a) clones the active profile's *config* JSON into `profiles.newslug` and (b) creates the empty data dir `data/profiles/newslug/`. It does NOT clone or initialize per-profile data files (cv-parsed.json, seen-jobs.json, applications.md). Then `setActiveProfile('newslug')` switches and the next `daily-batch` runs against:
- An empty CV → `loadParsedCV()` returns `{ titles: [], certs: [], skills: [], compliance: [] }` → every job scores 0 → all dropped by the 25% match floor → user gets `"Limited supply today: 0 fresh jobs"` and is confused.
- Empty seen-jobs is fine.
- Empty applications.md is fine.

The bot replies on /profile add: "Run /profile switch then /resume to upload a CV for this persona." — so the design contract is "switch doesn't crash, just gives weird empty results until /resume." But the empty CV path also blocks `/jobs suggest` (returns no suggestions), and the user has no clear indication that CV is the missing piece — they'll see `0 titles · 0 certs · 0 skills` in `/settings` if they look. Most won't.
**Impact:** Brand-new profile produces broken-feeling first batch. User-experience regression on a flagship feature.
**Fix:** When `addProfile` runs without `cloneFrom`, copy the active profile's `cv-parsed.json` into the new profile's dir as a starting point; then `/resume` overwrites it later. Add a check on the bot side: when running a batch, if `loadParsedCV()` returns the empty-default sentinel, fail loud:
```js
const CV = loadParsedCV();
if (!CV.titles?.length && !CV.skills?.length) {
  await tg('⚠️ <b>This profile has no parsed CV.</b> Run /resume to upload one — every job will score 0% otherwise.');
  process.exit(0);
}
```
Or, in `addProfile`:
```js
const sourceCV = path.join(PROFILES_DIR, cloneFrom, 'cv-parsed.json');
const targetCV = path.join(PROFILES_DIR, slug, 'cv-parsed.json');
if (fs.existsSync(sourceCV) && !fs.existsSync(targetCV)) {
  fs.copyFileSync(sourceCV, targetCV);
}
```

---

## MEDIUM findings

### F-M1: `e.message` interpolated into HTML-mode Telegram replies without escaping
**File:** `scripts/telegram-bot.mjs:703, 819, 909, 1170, 1427`
**Category:** Security / Correctness
**Description:** Several command handlers send raw `e.message` to Telegram with `parse_mode: 'HTML'`. Examples:
- L703: `reply(chatId, '❌ Weather fetch failed: ' + e.message)` — fetch URL contains config-derived city/coords, low risk, but if open-meteo returns an error containing `<` it breaks parse.
- L819: `reply(chatId, '❌ Could not read settings: ' + e.message)` — config file errors can contain JSON tokens which include `<` if a config field gets corrupted.
- L909: `reply(chatId, '❌ Geocoding failed: ' + e.message)` — geocode response.
- L1170: `reply(chatId, '❌ ' + e.message)` — for `/forget last`. e.message is from JSON.parse fail, could include any chars.
- L1427: `reply(chatId, '❌ ${escHtml(e.message)})` — this one IS escaped. Good, but the others are siblings.

The `reply()` wrapper has a fallback to plain text on parse failure (line 182-186), so the user does see SOMETHING — but the failure mode is "first send fails, second send retries without HTML, latency doubles, log is full of red." Worse, the code path that retries IS the same try block — if the second send also throws, the call site has no idea.
**Impact:** Mostly cosmetic (HTML parse errors), but a determined attacker controlling external services (DNS-spoofed open-meteo, MITM hiring.cafe response) could inject Telegram-recognized HTML.
**Fix:** Apply `escHtml` everywhere:
```js
catch (e) { return reply(chatId, '❌ Weather fetch failed: ' + escHtml(e.message || String(e))); }
```
Or, better, change `reply()` to escape e.message style content by default for error formatting — but that's invasive. Spot-fix the five sites for v1.0.

### F-M2: HMAC sig comparison is not constant-time
**File:** `scripts/callback-router.mjs:74, 80`
**Category:** Security
**Description:** `sig === expected` is a string `===`, which short-circuits at the first character mismatch. An attacker who can both send arbitrary callback_data AND time the response could (in theory) recover the 8-hex-char prefix one byte at a time. Practical exploitability is essentially zero because:
- Telegram routes callbacks; an attacker can't time a bot's reply with sub-microsecond precision over a network.
- The chat gate filters non-allowed-chat callbacks before reaching the verify path.
- Only 8 hex chars (32 bits of entropy) — even a constant-time check is "weak" by modern standards; the design defends only against "old button after batch rotation," not crypto-grade forgery.

Still: for a cryptographic primitive, use the right primitive.
**Impact:** Low — but flagged because checklists call it out and `crypto.timingSafeEqual` is one line.
**Fix:**
```js
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
// then: ok: safeEqual(sig, expected)
```

### F-M3: `parseAndVerify` doesn't reject unknown actions until late
**File:** `scripts/callback-router.mjs:61-81`
**Category:** Correctness
**Description:** The function accepts any 3-part `action:idx:sig` string. If `action` is something not in jobActions and not nav (e.g., a random string from a stale build), the nav-callback branch at line 79 happily computes `makeNavCallback(action, idx, '')` and verifies. Stale builds with old action codes can pass verify and reach `handleCallback`'s "Unknown action" line 1438 — but that's only after the work of HMAC verification. Worse: if a future version adds an action code and rolls it out, deprecated callers using the old code will be silently misverified.
**Impact:** Low; design-time risk for v1.1+.
**Fix:** Whitelist known actions:
```js
const KNOWN_ACTIONS = new Set(['s','a','w','k','b','bf','h','sv','cfg','uni','diag','noop']);
export function parseAndVerify(callbackData, token) {
  const parts = String(callbackData || '').split(':');
  if (parts.length !== 3) return { action: null, idx: null, ok: false };
  const [action, idxStr, sig] = parts;
  if (!KNOWN_ACTIONS.has(action)) return { action, idx: null, ok: false };
  // …rest…
}
```

### F-M4: `seenJobsFreshnessDays` is read off SCORING but `SCORING` is the FRESH-LOAD object
**File:** `scripts/daily-batch.mjs:572`
**Category:** Correctness / Cross-platform regression risk
**Description:**
```js
const SEEN_FRESHNESS_DAYS = SCORING.seenJobsFreshnessDays ?? 60;
```
`SCORING` is captured at module-load (line 430: `const SCORING = CFG.scoring || {};`) — the v1.0 E5 migration moves scoring under `profiles.<active>.scoring`. The `readActiveConfig()` flattens the active profile to top-level so `CFG.scoring` works post-migration. But `SCORING` is a CONST snapshot at import time; if `setActiveProfile` is called (via the bot) and then the same daily-batch process runs another batch, it would still use the old SCORING.

Currently each `daily-batch.mjs` invocation is its own process (cron, `/scrape` spawns a child), so this doesn't bite today. Future v1.1 cross-platform refactor that introduces a long-lived scrape worker would break here.
**Impact:** Latent regression risk for v1.1.
**Fix:** Make scoring a function not a const, or at minimum re-read at the top of each main pipeline step. The minimal fix:
```js
function getScoring() { return readActiveConfig().scoring || {}; }
// then use getScoring().seenJobsFreshnessDays where needed
```
Then leave the existing const-style for the hot path but document the limitation.

### F-M5: Decay-then-add race in `saveSeenStore` can re-add just-decayed entries
**File:** `scripts/daily-batch.mjs:616-639`
**Category:** Correctness
**Description:**
```js
function saveSeenStore(blockedSet, top) {
  const store = loadSeenStore();
  const { fresh } = decaySeenStore(store);
  // …add today's top with current timestamp…
  // Belt: also ensure everything in blockedSet (passed from caller) is recorded.
  for (const url of blockedSet) {
    if (!fresh[url]) fresh[url] = { firstSeenAt: now, lastSeenAt: now };
  }
```
`blockedSet` is computed earlier in the CLI block (line 861) by calling `loadBlockedSeen()`, which itself decays. `saveSeenStore` then iterates `blockedSet` and re-adds any URL not already in `fresh` — but `fresh` is a NEW decay pass, so something on the boundary that was fresh at line 861 but expired by the time `saveSeenStore` runs (~minutes later) gets re-added with `lastSeenAt: now`, effectively resetting its freshness window.

It's a tiny window (the time between line 861's decay and line 622's), but on day 60 it means a job that should have rolled back into supply gets bumped to day 0 again. Repeats every batch → the user never sees that job again, contrary to the "60-day decay" promise.
**Impact:** Bug in advertised feature. Users on a multi-month run won't notice missing jobs they "could have seen," but the bug is real.
**Fix:** Pass through the URLs intentionally — only add to `fresh` what was actually `top` (just-shown) plus what was ALREADY in store (don't promote near-expired entries):
```js
function saveSeenStore(blockedSet, top) {
  const store = loadSeenStore();
  const { fresh } = decaySeenStore(store);
  const now = new Date().toISOString();
  for (const r of top) {
    const existing = fresh[r.href] || store.jobs[r.href]; // keep firstSeen even if decayed
    fresh[r.href] = {
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now
    };
  }
  // Drop the belt-and-suspenders blockedSet rewrite — it's the bug.
  // …write…
}
```

### F-M6: Watchdog kills any `node` process whose command-line contains `telegram-bot`
**File:** `scripts/watchdog.mjs:113`
**Category:** Reliability
**Description:** The orphan-cleanup PowerShell does:
```
Get-Process node | … if ($cl -match 'telegram-bot') { Stop-Process -Id $_.Id -Force … }
```
`telegram-bot` is matched as a regex substring. If the user is editing `telegram-bot.mjs` in VS Code's Node-based extension host (rare), or running `node -e "console.log('telegram-bot')"`, or has any unrelated tool whose CLI includes the substring `telegram-bot`, the watchdog will terminate it. Same for the uninstaller (line 64: matches `telegram-bot|munyun`).
**Impact:** Very rare collateral damage. Worse on dev machines where the maintainer is running multiple Node processes — but the README says non-technical end users only, so the impact in production is essentially zero.
**Fix:** Anchor the match to the script PATH, not its name:
```
$cl -match 'telegram-bot\.mjs'
```
Or use the heartbeat PID exclusively (preferred — script names move in v1.1 with cross-platform abstraction).

### F-M7: Watchdog's `restarts.length >= MAX_RESTARTS` reads stale state if mid-tick
**File:** `scripts/watchdog.mjs:159-181`
**Category:** Correctness
**Description:** Watchdog runs every 5 minutes via Task Scheduler with `MultipleInstances IgnoreNew` (set in setup-tasks.ps1:70). That's a Windows-level mutex preventing overlap, so this is fine in production. But the state-write order has a subtle issue: `state.restarts.push(now)` happens AFTER `killBot()` and `startBot()`. If `killBot` succeeds but `startBot` returns false (schtasks /run failed), the restart still gets counted toward MAX_RESTARTS. Effect: a transient schtasks failure (UAC prompt, machine sleeping) burns one of the three restart attempts even though no restart actually happened.
**Impact:** Rare. If the machine has 3 transient schtasks failures in an hour, the watchdog gives up despite the bot never being restarted at all.
**Fix:** Only count successful restart attempts:
```js
killBot(hb);
await new Promise(r => setTimeout(r, 2000));
const started = startBot();
if (started) {
  state.restarts.push(now);
  state.gaveUpAt = null;
}
writeState(state);
```

### F-M8: `setup-wizard.mjs` step 10 fetches the final ping without HTML escaping for username
**File:** `scripts/setup-wizard.mjs:406-413`
**Category:** Correctness
**Description:** The final wizard ping uses `parse_mode: 'HTML'` but doesn't escape anything. Today nothing user-controlled is interpolated, but the message ends with `${resumeNudge}` and `<code>/resume</code>` etc. Static today; if anyone adds a templated step, they'll forget to escape.
**Impact:** Not a v1.0 bug; v1.1 maintenance risk.
**Fix:** Add a comment + a tiny `escHtml` helper to the wizard module so future authors don't roll their own.

### F-M9: Cross-platform-incompatible Windows path literals in user-facing text
**File:** `scripts/daily-batch.mjs:241, 853`, `scripts/telegram-bot.mjs:723, 1361, 1092`
**Category:** Cross-platform readiness
**Description:** Multiple Telegram-bound user-facing strings hardcode Windows path separators:
- `'Run scripts\\login-once.cmd to clear the Cloudflare challenge'` — should be `scripts/login-once.cmd` (cmd is win-only) or platform-conditional once v1.1 lands.
- `'Run <code>scripts\\login-once.cmd</code>'` (twice).
- `'Re-run <code>scripts\\setup-tasks.ps1</code>'` — `.ps1` is win-only; v1.1 needs branching.
- `'cd %LOCALAPPDATA%\\automatic-munyun-machine; …'` — `%LOCALAPPDATA%` and the semicolon-as-separator are pwsh idioms.

Less severe but still flagged for the v1.1 baseline:
- `installer/amm.iss` is Windows-only (Inno Setup); fine for now, just note that uninstall.ps1's "Run this script from inside the AMM install directory" message needs a Mac/Linux equivalent.
**Impact:** v1.0 is Windows-only so all messages are correct in context. v1.1 cross-platform must rewrite ALL user-facing strings — flagging now so the count of edits is known.
**Fix:** Centralize the install-helper-name strings:
```js
// in a new platform.mjs
export const LOGIN_HELPER = process.platform === 'win32'
  ? 'scripts\\login-once.cmd'
  : 'scripts/login-once.sh';
export const SETUP_HELPER = process.platform === 'win32'
  ? 'scripts\\setup-tasks.ps1'
  : 'scripts/setup-tasks.sh';
```
Reference `LOGIN_HELPER` etc. in the user-facing strings. Easier diff in v1.1.

### F-M10: Empty `catch {}` blocks that genuinely should log
**File:** `scripts/telegram-bot.mjs:765 (action local write)`, `scripts/telegram-bot.mjs:1402 (applications.md append)`, `scripts/telegram-bot.mjs:960 (tg failed)`, `scripts/daily-batch.mjs:960`, `scripts/profile-store.mjs:90`, `scripts/job-action.mjs:96`
**Category:** Quality / Observability
**Description:** Most empty/silent catches in the codebase are appropriate (the comment at log() line 95 says "never let log writes crash the bot"). A few are genuinely worrying:
- `daily-batch.mjs:960` — `try { await tg(msg); } catch {}` — the FAILURE notification of the daily batch can itself fail silently. If Telegram is down at 7am, the user has no signal that the batch failed; the local log is the only artifact.
- `profile-store.mjs:90` — `try { fs.renameSync(oldPath, newPath); moved++; } catch {}` — a failed migration rename is silently ignored; the data file is left in the v0.x location, and later code expects the v1.0 location → empty load → empty results.
- `job-action.mjs:96` — `await ctx.close().catch(() => {})` in finally is fine; the action itself completed. OK.

The bot's `setInterval` cleanup (line 335-340) is fine.
**Impact:** Diagnosis pain when things go silently wrong. Profile migration silent-fail is worst because the user gets a "Resume not parsed" state that they didn't trigger.
**Fix:**
```js
// profile-store.mjs:88-91
for (const f of PROFILE_DATA_FILES) {
  const oldPath = path.join(ROOT, 'data', f);
  const newPath = path.join(targetDir, f);
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    try { fs.renameSync(oldPath, newPath); moved++; }
    catch (e) { console.error(`profile-store: failed to migrate ${f}: ${e.message}`); }
  }
}
```

### F-M11: `recordAuthOk` / `recordAuthFail` not atomic
**File:** `scripts/daily-batch.mjs:644-657`
**Category:** Correctness
**Description:** `auth-state.json` writes are plain `writeFileSync` — if a /auth runs while a daily-batch is between `recordAuthFail` and a later `recordAuthOk`, the file can be left in a partially written state. A subsequent JSON.parse failure → `try/catch` returns "auth: unknown" in /status. Not data loss, but a confusing UX glitch.
**Impact:** Cosmetic, but worth fixing as part of the F-H8 atomic-write helper rollout.
**Fix:** Use the atomic-write helper (see F-H8).

### F-M12: `setInterval(notifyIfUpdateAvailable, 24h)` keeps event loop alive on its own
**File:** `scripts/telegram-bot.mjs:1548`
**Category:** Reliability
**Description:** `setInterval` is unref'd by default in some Node configurations but not others; in long-running bot use this is the desired behavior, but if the bot ever needs to gracefully shut down, the interval prevents the event loop from exiting. The poll loop's `while (true)` is the main keepalive, so this is moot today; flagging for the eventual graceful-shutdown work.
**Impact:** None in v1.0.
**Fix:** `setInterval(...).unref()` if/when graceful shutdown is implemented.

### F-M13: `/jobs add "title"` regex slug derivation can produce empty key
**File:** `scripts/telegram-bot.mjs:935`
**Category:** Correctness
**Description:**
```js
const key = term.replace(/[^a-z0-9]/gi, '').slice(0, 20);
```
If the user runs `/jobs add 中文工程师` or `/jobs add !!!`, the resulting `key` is `''`. Then the queries array gets `{ key: '', term: '中文工程师' }`. `daily-batch.mjs` uses `key` as the dictionary key in `results[key]`, so two empty-key queries collide silently — second one overwrites the first.
**Impact:** Edge case (Western users dominate), but a non-Latin job title silently disables a previously-added query.
**Fix:**
```js
const key = (term.replace(/[^a-z0-9]/gi, '').slice(0, 20)) || `q${Date.now().toString(36)}`;
```

### F-M14: `phrase-proximity.test.mjs` doesn't actually test phrase proximity
**File:** `scripts/__tests__/phrase-proximity.test.mjs:21-37`
**Category:** Test quality
**Description:** The file is named `phrase-proximity.test.mjs` and the docstring claims it "validates that the v1.0 E3 scoring closes the AWS once vs deep AWS gap." But the actual tests just verify the SHAPE of `scoreJob`'s return value:
- "scoreJob returns {score, matched} shape"
- "scoreJob handles empty job text safely"
- "parseSalaryK is the same export used by scoreJob (smoke)"

None of these tests verify that phrase proximity actually works. The author even acknowledged this in the comment at line 39-41 ("True per-CV behavioral tests… are gated on the CV-parsed.json fixture"), but the file is still in the test suite under its misleading name.
**Impact:** The test count of 24 (claimed in `package.json`'s test script context) overstates real coverage. CI passing == "module imports cleanly," not "phrase proximity works."
**Fix:** Either rename the file to `daily-batch-shape.test.mjs` and rewrite the docstring, or actually exercise phrase-proximity by building a fake CV at test time:
```js
import { scoreJob } from '../daily-batch.mjs';
import { _setCV } from '../daily-batch.mjs'; // would need to be exported

test('phrase proximity: tokens-anywhere gets half credit', () => {
  _setCV({ titles: [], certs: [], skills: ['AWS RDS'], compliance: [] });
  const close = scoreJob({ title: '', cardText: 'We use AWS RDS daily.' });
  const far   = scoreJob({ title: '', cardText: 'We deploy AWS infrastructure for our RDS-like analytics.' });
  assert.ok(close.score > far.score, 'exact phrase scores higher than tokens-only');
});
```
Requires `daily-batch.mjs` to export a CV-injection hook, which it doesn't today.

---

## LOW findings

| ID    | File:Line | Issue | Fix |
|-------|-----------|-------|-----|
| F-L1  | `daily-batch.mjs:265` | `MAX_PAGES_PER_QUERY` defaults to 50 — at ~40 cards/page that's a 2,000-card ceiling per query, way past the 1.5x target headroom early-stop. Effectively dead code in normal operation. | Drop the default to 10; document that early-stop is the real limit. |
| F-L2  | `daily-batch.mjs:391` | `escRx(s)` doesn't handle `null`/`undefined` — calling with null → TypeError. Currently called only with config-derived strings, so OK today. | Add `if (s == null) return ''` guard. |
| F-L3  | `daily-batch.mjs:519-524` | `scoreToPercent` magic numbers (30, 90, 0.5, etc.) repeated nowhere else but are tightly coupled to the `_percentBands` config comment. | Extract to a `BANDS` const at top of file with the comment inline. |
| F-L4  | `daily-batch.mjs:529` | `CLEARANCE_RX` is huge and unanchored — easy to introduce false positives (the term "clearance" alone matches in unrelated security-budget discussions). | Add tests that lock down at least the obvious negatives. |
| F-L5  | `telegram-bot.mjs:530-534` | `/diagnose` checks `seen?.ids` which is the v0.x schema, but v1.0 E3 migrated to `seen.jobs`. The else branch ("empty") fires for everyone post-migration — but the message under `seen?.ids` says "Freshness window lands in v1.0 E3" which is now ALREADY landed. Stale narrative. | Read `seen.jobs` count instead and remove the v1.0 E3 promise. |
| F-L6  | `telegram-bot.mjs:1097` | `npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'` — but `npm.cmd` resolution on the stripped-PATH environment that this codebase repeatedly defends against will fail. | Resolve via `path.join(process.env.APPDATA || '', 'npm', 'npm.cmd')` as a fallback. |
| F-L7  | `update-checker.mjs:39-46` | `semverGt` doesn't handle pre-release tags (e.g., `1.1.0-beta.1`). If an upstream release ever uses one, the comparison is undefined behavior — sometimes "newer," sometimes not, depending on string-coercion of `'0-beta'`. | Either parse tags as proper semver or document "no pre-releases supported." |
| F-L8  | `telegram-bot.mjs:1029` | `/forget all` uses `fs.unlinkSync` but doesn't error-check separately from "no file" — message says "you're already at a clean slate" even if the unlink failed for permissions. | Distinguish ENOENT from EPERM in the catch. |
| F-L9  | `setup-wizard.mjs:127` | `getUpdates?offset=-1` — Telegram's API treats negative offset as "tail," but it doesn't acknowledge / clear updates. A user who messaged the bot 10 minutes before running the wizard will have their message picked up. Not a bug; just non-obvious. | Comment that this is intentional — most installs will benefit from picking up the bot's own /start. |
| F-L10 | `role-suggester.mjs:111-122` | CLI entrypoint detection (`file.endsWith('role-suggester.mjs')`) is fragile — works today, but if anything else imports this module from a path that string-matches, the CLI block fires. The pattern in `resume-parser.mjs:112-114` is robust (`path.resolve` comparison). | Use the resume-parser pattern uniformly. |
| F-L11 | `scripts/start-bot.cmd:11` | `start "munyun bot" /min cmd /c "node scripts\telegram-bot.mjs"` — quoting of the whole `cmd /c` string can fail if `node` isn't on PATH. The bot itself defends against stripped-PATH but the launcher doesn't. | Use absolute node path: `start "munyun bot" /min "%LOCALAPPDATA%\Programs\nodejs\node.exe" "%~dp0telegram-bot.mjs"` or similar. |

---

## Findings deferred to v1.2+

- **Embeddings-based scoring.** Keyword scoring + cluster bias is the right v1.0 choice but plateaus around 70% precision against semantic-similar job titles. A `data/cv-embeddings.json` computed once at /resume time + `pgvector`-style cosine score against per-job embeddings would meaningfully improve "Why did this match?" explanations. Out of scope for v1.1 (cross-platform first).
- **Per-profile heartbeat.** `data/heartbeat.json` is shared across profiles by design (one bot process), but switching profiles mid-day would not show in the heartbeat. The watchdog wouldn't know about a stuck "switch but no new batch since" state. Defer until profile-switch frequency justifies the added complexity.
- **Webhook-based Telegram delivery.** The poll loop's 5/10/20/30s backoff is fine for hobby use. A webhook deployment (requires a public HTTPS endpoint) would eliminate the entire `outageStartedAt` tracking. Out of scope; AMM is local-first by design.
- **Rate limiting on `/scrape` from the bot.** `runningJob` lock prevents concurrent scrapes but doesn't throttle "user clicks /scrape 50 times rapidly." Each click spawns a new run-daily-batch.cmd that immediately exits because the lock is held — but the spawn churn is observable. Add a 30s debounce.
- **Browser-profile isolation between /save and /scrape.** Both share `data/browser-profile/` and run concurrently in some scenarios (user fires /save while a batch is mid-resolveAll). Playwright's persistent context allows this but lockfile contention has been observed once-or-twice anecdotally. A two-profile (one for scrape, one for actions) split would isolate cleanly. Defer.
- **Test fixture for cv-parsed.** Most behavioral tests can't run because `daily-batch.mjs`'s scoreJob captures CV at module-load. A `_setCV()` test hook (or making CV a function) unlocks the test suite that the repo needs. Touches a hot path; defer to a planned refactor.

---

_Reviewed: 2026-05-07_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep (Tier 1), standard (Tier 2/3)_
