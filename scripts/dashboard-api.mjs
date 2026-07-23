#!/usr/bin/env node
/**
 * Dashboard control-surface helper (v2.1).
 *
 * The desktop dashboard (wrapper/dashboard.html, served by the Go wrapper)
 * is the primary UI. The wrapper execs THIS script for every state-changing
 * action so all the job/config logic stays in Node — the wrapper never
 * reimplements it. Each subcommand prints ONE line of JSON to stdout.
 *
 * Subcommands:
 *   settings-get                    → { ok, settings:{...} }   editable knobs + queries
 *   settings-set <dotPath> <json>   → { ok }                   coerced + config-rw.set
 *   jobs-add <term>                 → { ok, added, list }
 *   jobs-remove <term>              → { ok, removed, list }
 *   jobs-mode <titles|keywords>     → { ok, mode }
 *   job-action <save|applied> <idx> → { ok, hcafe, output }    acts on a batch job by index
 *
 * job-action resolves the job from the ACTIVE profile's last-batch.json,
 * runs the hiring.cafe action via job-action.mjs (best-effort — works only
 * when signed in), and for "applied" always records it locally in
 * applications.md so it's deduped out of future batches even if you weren't
 * signed in.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cfgRW from './config-rw.mjs';
import {
  paths as profilePaths,
  listProfiles,
  getActiveProfile,
  addProfile,
  setActiveProfile,
  deleteProfile,
  renameProfile,
  _internals as profileInternals
} from './profile-store.mjs';
import { parseResume, writeParsedCV } from './resume-parser.mjs';
import { suggestRoles, suggestKeywords } from './role-suggester.mjs';
import { withFileLock, atomicWriteJson } from './io-helpers.mjs';
import { writeHcafeAuthCache, readHcafeAuthCache } from './hcafe-session.mjs';
import { readDiceAuthCache } from './dice-session.mjs';
import { normalizeEngines, normalizeScrapeSources } from './query-engines.mjs';
import { loadExport } from './export-batch.mjs';
import { listArchives, readArchive } from './batch-archive.mjs';
import { readExclusions, writeExclusion } from './batch-exclusions.mjs';
import { clampBatchSize } from './batch-size.mjs';
import {
  emailConfigured, readEmailEnv, writeEmailEnv,
  verifyLogin, sendEmail, sendConfiguredEmail, disconnectEmail,
  emailDeliveryStatus, oauthAvailable, emailScrub, friendlyError, isEmailAddress, renderSubject
} from './email.mjs';
import { beginOAuth, completeOAuth } from './gmail-oauth.mjs';
import { geocode } from './geocode.mjs';
import { registerSchedulerForPlatform } from './scheduler-register.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// ---- settings ----
// The subset of config the dashboard exposes for editing. Kept small +
// explicit so the UI never has to understand the full profile structure.
function settingsGet() {
  const cfg = cfgRW.read();
  const delivery = emailDeliveryStatus(readEmailEnv());
  out({
    ok: true,
    settings: {
      maxYoeAcceptable: cfg.user?.maxYoeAcceptable ?? 5,
      salaryFloorUsd: cfg.user?.salaryFloorUsd ?? 90000,
      filterClearance: cfg.filters?.filterClearance !== false,
      applicationFormEase: cfg.filters?.applicationFormEase || 'all',
      skipCompanies: cfg.filters?.skipCompanies || [], // v4.6: blocked-companies UI
      matchFloorPercent: cfg.scoring?.matchFloorPercent ?? 25,
      targetJobsPerBatch: clampBatchSize(cfg.scoring?.targetJobsPerBatch),
      showSalary: cfg.display?.showSalary !== false, // v4.6: default on
      scheduleTime: cfg.schedule?.time || '07:00',
      searchMode: cfg.search?.mode === 'keywords' ? 'keywords' : 'titles',
      // v5.0: workplace-type + location search, and ATS source boards.
      workplaceTypes: (Array.isArray(cfg.search?.workplaceTypes) && cfg.search.workplaceTypes.length) ? cfg.search.workplaceTypes : ['Remote'],
      searchLocation: cfg.search?.location || '',
      sources: {
        greenhouse: cfg.sources?.greenhouse || [],
        lever: cfg.sources?.lever || [],
        ashby: cfg.sources?.ashby || [],
        remoteConfigUrl: cfg.sources?.remoteConfigUrl || ''
      },
      maxJobAge: cfg.filters?.maxJobAge || 'any',
      queries: (cfg.queries || []).map(q => q.term),
      queryEngines: Object.fromEntries((cfg.queries || []).map(q => [q.term, normalizeEngines(q.engines)])), // v7.3
      scrapeSources: normalizeScrapeSources(cfg.search?.scrapeSources), // v7.3
      // v4.0: Smart match (AI) — the key itself is NEVER returned, only
      // whether one is stored. Plus muted terms + a thin-CV signal.
      aiEnabled: !!cfg.scoring?.ai?.enabled,
      aiHasKey: !!(cfg.scoring?.ai?.apiKey),
      aiModel: cfg.scoring?.ai?.model || 'claude-opus-4-8',
      mutedTerms: cfg.scoring?.mutedTerms || [],
      // v4.3: email-to-VA. The app password is NEVER returned — only whether
      // Gmail credentials are present in .env (hasCreds).
      email: {
        enabled: !!cfg.email?.enabled,
        to: cfg.email?.to || '',
        from: cfg.email?.from || '',
        subject: cfg.email?.subject || 'Job batch — {DATE}',
        autoSend: !!cfg.email?.autoSend,
        format: ['txt', 'csv', 'xlsx'].includes(cfg.email?.format) ? cfg.email.format : 'txt', // v7.0
        hasCreds: delivery.connected,
        provider: delivery.provider,
        connectedEmail: delivery.email,
        oauthAvailable: oauthAvailable(readEmailEnv())
      },
      cvTermCount: (() => {
        try {
          const cv = JSON.parse(fs.readFileSync(profilePaths().cvParsed, 'utf8'));
          return (cv.titles?.length || 0) + (cv.certs?.length || 0) + (cv.skills?.length || 0) + (cv.compliance?.length || 0);
        } catch { return null; }
      })()
    }
  });
}

// Coerce the incoming JSON value to the right type for known paths, then set.
function settingsSet(dotPath, jsonValue) {
  let value;
  try { value = JSON.parse(jsonValue); } catch { value = jsonValue; }
  const allowed = new Set([
    'user.maxYoeAcceptable', 'user.salaryFloorUsd',
    'filters.filterClearance', 'filters.applicationFormEase', 'filters.maxJobAge',
    'scoring.matchFloorPercent', 'scoring.targetJobsPerBatch', 'schedule.time', 'search.mode',
    'search.workplaceTypes', 'search.location', // v5.0
    'sources.greenhouse', 'sources.lever', 'sources.ashby', 'sources.remoteConfigUrl', // v5.0
    'search.scrapeSources', // v7.3: what to scrape — both/hcafe/dice (v7.4: the only Dice knob — the enable toggle is gone)
    'display.showSalary',
    'scoring.ai.enabled', 'scoring.ai.apiKey', 'scoring.ai.model', 'scoring.jdRescore',
    // v4.3: email-to-VA. Credentials (SMTP_USER/SMTP_APP_PASSWORD) are NOT set
    // here — they go through email-save into .env. These are the plain knobs.
    'email.autoSend', 'email.subject', 'email.to',
    'email.format' // v7.0: attachment format for the batch email (txt | csv | xlsx)
  ]);
  if (!allowed.has(dotPath)) return out({ ok: false, error: 'not an editable setting: ' + dotPath });
  if (dotPath === 'scoring.targetJobsPerBatch') value = clampBatchSize(value);
  if (dotPath === 'display.showSalary') value = (value === true || value === 'true' || value === 'on');
  if (dotPath === 'scoring.ai.enabled' || dotPath === 'scoring.jdRescore') value = (value === true || value === 'true' || value === 'on');
  if (dotPath === 'search.scrapeSources') value = normalizeScrapeSources(value); // v7.3
  if (dotPath === 'email.autoSend') value = (value === true || value === 'true' || value === 'on');
  if (dotPath === 'email.format') {
    value = String(value || '').trim().toLowerCase();
    if (!['txt', 'csv', 'xlsx'].includes(value)) return out({ ok: false, error: 'format must be txt, csv, or xlsx' });
  }
  if (dotPath === 'email.subject') { value = String(value || '').trim().slice(0, 120) || 'Job batch — {DATE}'; }
  if (dotPath === 'email.to') {
    value = String(value || '').trim();
    if (value && !isEmailAddress(value)) return out({ ok: false, error: 'that does not look like an email address' });
  }
  if (dotPath === 'scoring.ai.apiKey') {
    value = String(value || '').trim();
    if (value && !/^[\x21-\x7e]{20,200}$/.test(value)) return out({ ok: false, error: 'that does not look like an API key' });
  }
  if (dotPath === 'scoring.ai.model') {
    value = String(value || '').trim();
    if (!/^[a-z0-9.-]{5,60}$/i.test(value)) value = 'claude-opus-4-8';
  }
  // Light validation for the numeric / enum ones.
  if (dotPath === 'user.maxYoeAcceptable') value = Math.max(0, Math.min(30, parseInt(value) || 0));
  if (dotPath === 'user.salaryFloorUsd') value = Math.max(0, Math.min(900000, parseInt(value) || 0));
  if (dotPath === 'scoring.matchFloorPercent') value = Math.max(0, Math.min(100, parseInt(value) || 0));
  if (dotPath === 'filters.filterClearance') value = (value === true || value === 'true' || value === 'on');
  if (dotPath === 'filters.applicationFormEase' && !['all', 'simple', 'long'].includes(value)) value = 'all';
  if (dotPath === 'filters.maxJobAge' && !['today', '3days', 'week', 'month', 'any'].includes(value)) value = 'any';
  if (dotPath === 'search.mode') value = value === 'keywords' ? 'keywords' : 'titles';
  if (dotPath === 'schedule.time' && !/^\d{1,2}:\d{2}$/.test(String(value))) return out({ ok: false, error: 'time must be HH:MM' });
  // v5.0: workplace types — keep only valid friendly labels; never empty.
  if (dotPath === 'search.workplaceTypes') {
    const ok = ['Remote', 'Hybrid', 'On-Site'];
    value = (Array.isArray(value) ? value : []).filter(w => ok.includes(w));
    if (!value.length) value = ['Remote'];
  }
  if (dotPath === 'search.location') value = String(value || '').trim().slice(0, 80);
  // v5.0: ATS source token lists — sanitize each board slug (letters/digits/hyphen).
  if (dotPath === 'sources.greenhouse' || dotPath === 'sources.lever' || dotPath === 'sources.ashby') {
    value = (Array.isArray(value) ? value : []).map(t => String(t || '').trim()).filter(t => /^[a-z0-9][a-z0-9-]{0,59}$/i.test(t)).slice(0, 100);
  }
  if (dotPath === 'sources.remoteConfigUrl') {
    value = String(value || '').trim();
    if (value && !/^https:\/\/[^\s]+$/i.test(value)) return out({ ok: false, error: 'remote config URL must start with https://' });
  }
  cfgRW.set(dotPath, value);
  out({ ok: true, path: dotPath, value });
}

// ---- search terms ----
function jobsAdd(term) {
  term = (term || '').trim();
  if (!term) return out({ ok: false, error: 'empty term' });
  const key = (term.replace(/[^a-z0-9]/gi, '').slice(0, 20)) || `q${Date.now().toString(36)}`;
  const r = cfgRW.appendUnique('queries', { key, term });
  out({ ok: true, added: r.added, list: r.list.map(q => q.term) });
}
function jobsRemove(term) {
  const r = cfgRW.removeFromArray('queries', (term || '').trim());
  out({ ok: true, removed: r.removed, list: r.list.map(q => q.term) });
}
function jobsMode(mode) {
  const m = mode === 'keywords' ? 'keywords' : 'titles';
  cfgRW.set('search.mode', m);
  out({ ok: true, mode: m });
}
// v2.8: clear the whole search-term list in one shot (dashboard "Clear all").
function jobsClear() {
  cfgRW.set('queries', []);
  out({ ok: true, list: [] });
}

// v7.7: batch exclusions — the ✕ next to each ranked job. Keyed to the live
// batch's generatedAt so a fresh scrape always starts with zero exclusions.
function currentBatchStamp() {
  try {
    return JSON.parse(fs.readFileSync(profilePaths().lastBatch, 'utf8')).generatedAt || '';
  } catch { return ''; }
}
function exclusionsGet() {
  const stamp = currentBatchStamp();
  out({ ok: true, excluded: stamp ? [...readExclusions(profilePaths().batchExclusions, stamp)] : [] });
}
function jobExclude(idx, excluded) {
  const stamp = currentBatchStamp();
  if (!stamp) return out({ ok: false, error: 'No batch yet — run a scrape first.' });
  const n = parseInt(idx, 10);
  if (!Number.isInteger(n) || n <= 0) return out({ ok: false, error: 'bad job index' });
  const on = excluded === true || excluded === 'true';
  const list = writeExclusion(profilePaths().batchExclusions, stamp, n, on);
  out({ ok: true, idx: n, excluded: on, list });
}

// v7.3: route one search term to a source — 'both' (default), 'hcafe', 'dice'.
function jobsEngine(term, engines) {
  term = (term || '').trim();
  const e = normalizeEngines(engines);
  const cfg = cfgRW.read();
  const queries = (cfg.queries || []).map(q =>
    q.term === term ? { ...q, engines: e } : q
  );
  if (!queries.some(q => q.term === term)) return out({ ok: false, error: 'unknown term: ' + term });
  cfgRW.set('queries', queries);
  out({ ok: true, term, engines: e });
}

// v4.6: blocked-companies management from the dashboard (was Telegram-only via
// /skip and /unskip). Same filters.skipCompanies array the scraper drops on in
// its pre-score filter (daily-batch's SKIP_CO: case-insensitive prefix match
// anchored at the start of the company name, so "Google" blocks "Google LLC").
function skipAdd(company) {
  company = (company || '').trim();
  if (!company) return out({ ok: false, error: 'empty company' });
  const r = cfgRW.appendUnique('filters.skipCompanies', company);
  out({ ok: true, added: r.added, list: r.list });
}
function skipRemove(company) {
  const r = cfgRW.removeFromArray('filters.skipCompanies', (company || '').trim());
  out({ ok: true, removed: r.removed, list: r.list });
}

// v2.8: pick the suggester flavor and flatten to plain search strings. Pure —
// unit-tested. Any mode string other than 'keywords' means titles (precise).
export function suggestTermsForMode(parsed, mode, max = 12) {
  const flavor = mode === 'keywords' ? 'keywords' : 'titles';
  const raw = flavor === 'keywords'
    ? suggestKeywords(parsed, { max })
    : suggestRoles(parsed, { max });
  return { mode: flavor, suggestions: raw.map(s => s.title) };
}

// v2.8: re-suggest search terms from the ALREADY-parsed CV (no re-upload),
// in the requested flavor. Powers the "Search style" toggle so flipping
// titles↔keywords immediately shows fresh suggestions to apply. Mode is
// passed explicitly (the caller's dropdown value) to avoid racing the
// separate search.mode save. Read-only — never touches config.
function suggestCurrent(modeArg) {
  const cvPath = profilePaths().cvParsed;
  if (!fs.existsSync(cvPath)) {
    return out({ ok: false, error: 'No scanned resume yet — upload one in the Resume card first.' });
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(cvPath, 'utf8')); }
  catch { return out({ ok: false, error: 'Could not read your scanned resume — rescan it in the Resume card.' }); }
  out({ ok: true, ...suggestTermsForMode(parsed, modeArg) });
}

// ---- per-job actions ----
function loadBatchJob(idx) {
  const lbPath = profilePaths().lastBatch;
  const lb = JSON.parse(fs.readFileSync(lbPath, 'utf8'));
  return (lb.jobs || []).find(j => j.idx === idx) || null;
}

function spawnJobAction(action, url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'job-action.mjs'), action, url],
      { cwd: ROOT, windowsHide: true });
    let outBuf = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ code: -1, output: 'timed out' }); }, 90000);
    child.stdout.on('data', d => outBuf += d.toString());
    child.stderr.on('data', d => outBuf += d.toString());
    child.on('error', e => { clearTimeout(timer); resolve({ code: -2, output: String(e.message || e) }); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, output: outBuf.trim() }); });
  });
}

async function jobAction(action, idxRaw) {
  const idx = parseInt(idxRaw);
  if (!['save', 'applied'].includes(action) || !(idx > 0)) return out({ ok: false, error: 'usage: job-action <save|applied> <idx>' });
  let job;
  try { job = loadBatchJob(idx); } catch { return out({ ok: false, error: 'No batch on disk yet — run a scrape first.' }); }
  if (!job) return out({ ok: false, error: `Job #${idx} not in the latest batch.` });
  const url = job.viewjobUrl || ('https://hiring.cafe/viewjob/' + job.id);
  // v2.4: never hand an arbitrary string from last-batch.json to a child
  // process — the batch is built from scraped page content. viewjob URLs
  // have exactly one shape; anything else is refused.
  if (!/^https:\/\/hiring\.cafe\/viewjob\/[A-Za-z0-9_-]+$/.test(url)) {
    return out({ ok: false, error: 'Job has a malformed hiring.cafe URL — re-run a scrape.' });
  }

  // "applied" always records locally so the job is deduped from future
  // batches, even if hiring.cafe isn't signed in.
  if (action === 'applied') {
    try {
      const line = `\n| - | ${new Date().toISOString().slice(0, 10)} | ${job.company || ''} | ${job.title || ''} | - | APPLIED | - | - | via dashboard | ${url} |`;
      const apps = profilePaths().applications;
      fs.mkdirSync(path.dirname(apps), { recursive: true });
      // v2.4: serialize with other writers (a mid-scrape batch reads this
      // file for dedup; Telegram /applied appends to it too) — same
      // proper-lockfile discipline as config.json.
      await withFileLock(apps, () => { fs.appendFileSync(apps, line); });
    } catch (e) { /* local log best-effort */ }
  }

  const r = await spawnJobAction(action, url);
  // hiring.cafe action succeeds only when signed in; not fatal for "applied".
  const hcafe = r.code === 0;
  if (action === 'save' && !hcafe) {
    return out({ ok: false, hcafe, error: 'Saving on hiring.cafe needs you signed in there (optional). Use Open to apply directly.', output: r.output.slice(0, 200) });
  }
  out({ ok: true, hcafe, output: r.output.slice(0, 200) });
}

// ---- resume rescan (v2.5) ----
// Re-parse an uploaded resume into the active profile's cv-parsed.json, then
// suggest fresh search terms from it (titles or keywords per search.mode).
// The Go wrapper saves the upload to a temp file and passes its path here.
async function resumeParse(filePath, modeArg) {
  if (!filePath || !fs.existsSync(filePath)) return out({ ok: false, error: 'resume file not found' });
  let parsed;
  try {
    parsed = await parseResume(filePath);
  } catch (e) {
    return out({ ok: false, error: 'Could not parse that file: ' + String(e.message || e) });
  }
  if (!parsed.titles.length && !parsed.skills.length && !parsed.certs.length && !parsed.compliance.length) {
    return out({ ok: false, error: 'No recognizable skills/titles found in that resume. Try a text-based PDF/DOCX (not a scan).' });
  }
  // v2.7: on a fresh install (dashboard setup step 1 — config.json not
  // written yet), cfgRW.read() and profilePaths() would copy the example
  // config into place as a side effect, flipping the wrapper's needsSetup
  // mid-setup. Write the CV to the explicit 'default' profile (skips the
  // active-profile config read) and default the mode; setup-init owns
  // config.json creation at the final step.
  const freshInstall = !fs.existsSync(path.join(ROOT, 'config.json'));
  writeParsedCV(parsed, freshInstall ? 'default' : undefined);
  // v4.1.1: the setup preview lets the user flip titles↔keywords at scan time.
  // An explicit modeArg (from the step-1 toggle) wins; otherwise fall back to
  // the config's mode (rescans) or 'titles' (fresh install, no config yet).
  const wanted = (modeArg === 'keywords' || modeArg === 'titles') ? modeArg : null;
  const mode = wanted
    ? wanted
    : (freshInstall ? 'titles' : (cfgRW.read().search?.mode === 'keywords' ? 'keywords' : 'titles'));
  const suggestions = (mode === 'keywords' ? suggestKeywords(parsed, { max: 12 }) : suggestRoles(parsed, { max: 12 }))
    .map(s => s.title);
  out({
    ok: true,
    parsed: {
      titles: parsed.titles.length, certs: parsed.certs.length,
      skills: parsed.skills.length, compliance: parsed.compliance.length,
      primaryClusters: parsed.primaryClusters || []
    },
    mode,
    suggestions
  });
}

// Replace the search-term list with the given terms (used by "Apply these"
// after a rescan). Empty/blank terms ignored; dedup by lowercased term.
function resumeApply(termsJson) {
  let terms;
  try { terms = JSON.parse(termsJson); } catch { terms = null; }
  if (!Array.isArray(terms)) return out({ ok: false, error: 'expected a JSON array of terms' });
  const clean = [];
  const seen = new Set();
  for (const t of terms) {
    const term = String(t || '').trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    clean.push({ key: (term.replace(/[^a-z0-9]/gi, '').slice(0, 20)) || `q${clean.length}`, term });
  }
  if (!clean.length) return out({ ok: false, error: 'no valid terms to apply' });
  cfgRW.set('queries', clean);
  out({ ok: true, list: clean.map(q => q.term) });
}

// ---- setup (v2.7) ----
// Powers the dashboard-native first-run flow. Replaces the terminal wizard's
// step 3 (hiring.cafe warmup), step 9 (city geocode), step 10 (schedule +
// scheduler registration + config write). Together with the existing
// resume-parse / resume-apply subcommands and the /api/telegram/* flow, the
// entire onboarding lives in the dashboard.

// setup-geocode: proxy to open-meteo. Same as the wizard's step 9. Pure
// lookup — no filesystem side effects. Returns exactly the geocode() shape.
async function setupGeocode(query) {
  const q = String(query || '').trim();
  if (!q) return out({ ok: false, error: 'city name is required' });
  try {
    const r = await geocode(q);
    if (!r) return out({ ok: false, error: 'no match for "' + q + '"' });
    out({ ok: true, ...r });
  } catch (e) { out({ ok: false, error: String(e.message || e) }); }
}

// setup-hcafe-login-start: spawn login-once.mjs detached and return the PID.
// The child owns a Playwright browser window that the user closes when the
// Cloudflare challenge clears. The dashboard polls setup-hcafe-login-status
// until the PID exits, then verifies auth. Persists PID under data/ so a
// dashboard refresh mid-flight doesn't lose track of the child.
function setupHcafeLoginStart() {
  try {
    const scriptPath = path.join(ROOT, 'scripts', 'login-once.mjs');
    if (!fs.existsSync(scriptPath)) return out({ ok: false, error: 'login-once.mjs missing — corrupt install?' });
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    const pidPath = path.join(ROOT, 'data', 'hcafe-login.pid');
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(child.pid));
    out({ ok: true, pid: child.pid });
  } catch (e) { out({ ok: false, error: String(e.message || e) }); }
}

// pidIsAlive: cross-platform "is this PID running." process.kill(pid, 0)
// throws ESRCH when the process is gone, EPERM when it exists but we can't
// signal it (still counts as alive for our purpose — child was spawned by
// the same user).
function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// setup-hcafe-login-status: while running → {running:true}. On exit → run
// job-action.mjs auth and report {running:false, authed}. The dashboard uses
// authed=true as the gate to advance past step 3; authed=false re-arms the
// Launch button so the user can retry.
async function setupHcafeLoginStatus() {
  const pidPath = path.join(ROOT, 'data', 'hcafe-login.pid');
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10); }
  catch { return out({ ok: true, running: false, authed: false, started: false }); }

  if (pidIsAlive(pid)) return out({ ok: true, running: true, pid });

  // Child exited — verify hiring.cafe auth. Reuses the wizard's step 3 check.
  const r = await spawnJobAction('auth', '');
  const authed = r.code === 0;
  writeHcafeAuthCache(authed); // keep the dashboard's status pill fresh post-login
  out({ ok: true, running: false, authed, output: (r.output || '').slice(0, 300) });
}

// ---- hiring.cafe auth status (v4.1) ----
// The dashboard shows a permanent "signed into hiring.cafe?" pill. The live
// probe (job-action.mjs auth) spins up Playwright (~5-10s), far too heavy for
// the frequent /api/status poll — so the result is cached to
// data/hcafe-auth.json and read back instantly. v4.3: the cache read/write
// moved to hcafe-session.mjs so the scraper (which now refreshes the cache on
// every run) shares the exact same file and schema.

// hcafe-auth-get: read the cached status instantly (no browser spawn). Missing
// or unreadable cache → authed:null so the UI can show "unknown" and offer a
// re-check rather than a misleading "signed out".
function hcafeAuthGet() {
  const c = readHcafeAuthCache();
  out({ ok: true, authed: c.authed, checkedAt: c.checkedAt, cached: c.authed !== null });
}

// hcafe-auth-check: run the live probe, persist it, and return the fresh
// result. Fired by the dashboard's "Re-check" button and after a login
// completes. Same ~90s worst-case budget as setup-hcafe-login-status.
async function hcafeAuthCheck() {
  const r = await spawnJobAction('auth', '');
  const authed = r.code === 0;
  writeHcafeAuthCache(authed);
  out({ ok: true, authed, checkedAt: new Date().toISOString(), cached: false, output: (r.output || '').slice(0, 300) });
}

// ---- Dice sign-in (v7.3) — the hcafe login flow, cloned for dice.com ----
// Same shape end to end: start spawns a visible sign-in window (PID file),
// status polls the PID and probes auth after the window closes, get reads
// the cache instantly, check runs the live probe on demand.

function diceLoginStart() {
  try {
    const scriptPath = path.join(ROOT, 'scripts', 'dice-login.mjs');
    if (!fs.existsSync(scriptPath)) return out({ ok: false, error: 'dice-login.mjs missing — corrupt install?' });
    const child = spawn(process.execPath, [scriptPath], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    const pidPath = path.join(ROOT, 'data', 'dice-login.pid');
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(child.pid));
    out({ ok: true, pid: child.pid });
  } catch (e) { out({ ok: false, error: String(e.message || e) }); }
}

// Spawn the headless probe (writes data/dice-auth.json itself); exit 0 = in.
function spawnDiceProbe() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dice-auth-probe.mjs')], { cwd: ROOT, windowsHide: true });
    let output = '';
    child.stdout.on('data', d => output += d);
    child.stderr.on('data', d => output += d);
    const t = setTimeout(() => { try { child.kill(); } catch {} }, 90000);
    child.on('close', code => { clearTimeout(t); resolve({ code, output }); });
    child.on('error', e => { clearTimeout(t); resolve({ code: 1, output: String(e.message || e) }); });
  });
}

async function diceLoginStatus() {
  const pidPath = path.join(ROOT, 'data', 'dice-login.pid');
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10); }
  catch { return out({ ok: true, running: false, authed: false, started: false }); }
  if (pidIsAlive(pid)) return out({ ok: true, running: true, pid });
  const r = await spawnDiceProbe();
  out({ ok: true, running: false, authed: r.code === 0, output: (r.output || '').slice(0, 300) });
}

function diceAuthGet() {
  const c = readDiceAuthCache();
  out({ ok: true, authed: c.authed, checkedAt: c.checkedAt, cached: c.authed !== null });
}

async function diceAuthCheck() {
  const r = await spawnDiceProbe();
  out({ ok: true, authed: r.code === 0, checkedAt: new Date().toISOString(), cached: false, output: (r.output || '').slice(0, 300) });
}

// buildInitConfig: pure merge of user-collected setup input over config
// defaults. Exported so unit tests can exercise the merge/normalization
// logic without touching real config.json. Kept separate from setupInit so
// the file-write side effect and the transformation are testable in isolation.
//
// Blob shape:
//   {
//     "user":     { name, maxYoeAcceptable, salaryFloorUsd },
//     "filters":  { filterClearance, applicationFormEase, maxJobAge },
//     "weather":  { city, lat, lon, timezone },
//     "schedule": { time, days? },
//     "queries":  ["IAM Engineer", "Cloud Security", ...],
//     "search":   { mode: "titles" | "keywords" }
//   }
export function buildInitConfig(input, defaults = {}) {
  const src = input || {};
  const def = { ...defaults };
  delete def._comment;

  // Convert the client's plain string[] queries into the {key, term} shape
  // config-rw expects. Same key-derivation as jobsAdd(). If the user left it
  // empty, preserve the shipping default (also empty in v5.0) so a fresh
  // install never inherits searches tailored to another profession.
  const inputQueries = Array.isArray(src.queries) ? src.queries : [];
  const queries = inputQueries.length
    ? inputQueries
        .map(t => String(t || '').trim())
        .filter(Boolean)
        .map((term, i) => ({
          key: (term.replace(/[^a-z0-9]/gi, '').slice(0, 20)) || `q${i}`,
          term
        }))
    : (def.queries || []);

  const profile = {
    user: { ...(def.user || {}), ...(src.user || {}) },
    queries,
    search: { ...(def.search || {}), ...(src.search || {}) },
    filters: { ...(def.filters || {}), ...(src.filters || {}) },
    scoring: def.scoring || {},
    weather: { ...(def.weather || {}), ...(src.weather || {}) },
    schedule: { ...(def.schedule || {}), ...(src.schedule || {}) },
    telegram: def.telegram || {}
  };

  const cfg = {
    _comment: 'Written by AMM dashboard setup (v2.7). Edit via the dashboard or npm run setup.',
    active_profile: 'default',
    profiles: { default: profile }
  };
  if (def.browser) cfg.browser = def.browser;
  return cfg;
}

// setup-init: one-shot write of config.json in the v1.0 profile shape. Called
// from the dashboard finish step with a JSON blob of user-collected fields.
// Merges over config.example.json defaults so scoring weights, drop patterns,
// and skipCompanies land at sensible values without requiring the user to
// touch them.
function setupInit(jsonBlob) {
  let input;
  try { input = JSON.parse(jsonBlob || '{}'); }
  catch { return out({ ok: false, error: 'invalid JSON payload' }); }

  let defaults = {};
  try {
    defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  } catch { /* fall through with empty defaults */ }

  const cfg = buildInitConfig(input, defaults);

  try {
    atomicWriteJson(path.join(ROOT, 'config.json'), cfg);
    out({ ok: true });
  } catch (e) { out({ ok: false, error: String(e.message || e) }); }
}

// setup-finalize: register the scheduler tasks. config.json must already be
// written (the platform scripts read schedule.time / days from it), so this
// runs AFTER setup-init. The wrapper's tray poll picks up the newly-written
// config.json on its own and transitions out of needs-setup mode — no extra
// IPC.
async function setupFinalize() {
  try {
    const r = await registerSchedulerForPlatform();
    if (r.code === 0) return out({ ok: true });
    out({ ok: false, error: 'scheduler registration failed', detail: (r.out || '').slice(0, 400) });
  } catch (e) { out({ ok: false, error: String(e.message || e) }); }
}

// ---- profiles (v2.6) ----
// The Telegram bot has had /profile add|switch|delete|list since v1.0; the
// dashboard was read-only for profiles until v2.6. These handlers mirror
// the bot's commands so both surfaces stay in sync via the same store.

function profileList() {
  try {
    const active = getActiveProfile();
    const slugs = listProfiles();
    const raw = profileInternals.readRawConfig();
    const items = slugs.map(slug => {
      const p = raw.profiles?.[slug] || {};
      const cvPath = profilePaths(slug).cvParsed;
      return {
        slug,
        active: slug === active,
        userName: p.user?.name || '',
        hasCV: fs.existsSync(cvPath)
      };
    });
    out({ ok: true, active, profiles: items });
  } catch (e) { out({ ok: false, error: String(e.message || e) }); }
}

function profileAdd(slug) {
  try {
    const r = addProfile(String(slug || '').trim(), {});
    out({ ok: true, slug: r.slug, clonedFrom: r.clonedFrom, cvCloned: r.cvCloned });
  } catch (e) { out({ ok: false, error: String(e.message || e) }); }
}

function profileRename(oldSlug, newSlug) {
  try {
    const r = renameProfile(String(oldSlug || '').trim(), String(newSlug || '').trim());
    out({ ok: true, renamed: r.renamed, from: r.from, dataMoved: r.dataMoved });
  } catch (e) { out({ ok: false, error: String(e.message || e) }); }
}

function profileDelete(slug) {
  try {
    // Wipe data by default — leaving stranded data/profiles/<slug>/ dirs
    // after a delete would confuse the next user who reuses the slug.
    const r = deleteProfile(String(slug || '').trim(), { wipeData: true });
    out({ ok: true, deleted: r.deleted, dataWiped: r.dataWiped });
  } catch (e) { out({ ok: false, error: String(e.message || e) }); }
}

function profileSwitch(slug) {
  try {
    const s = setActiveProfile(String(slug || '').trim());
    out({ ok: true, active: s });
  } catch (e) { out({ ok: false, error: String(e.message || e) }); }
}

// ---- email-to-VA (v4.3) ----
export function normalizeEmailFormat(format) {
  return format === 'csv' || format === 'xlsx' ? format : 'txt';
}

// Turn the existing, tested dashboard export payload into an email attachment.
// XLSX rides the helper boundary as base64; email providers accept the decoded
// Buffer directly. TXT/CSV stay strings so their exact encoding/BOM survives.
export function emailAttachmentFromExport(ex) {
  if (!ex?.ok) return ex || { ok: false, error: 'No batch yet — run a scrape first.' };
  const content = ex.format === 'xlsx'
    ? Buffer.from(ex.contentBase64 || '', 'base64')
    : ex.content;
  return { ok: true, format: ex.format, filename: ex.filename, date: ex.date, count: ex.count, content };
}

function resolveBatchAttachment(format) {
  return emailAttachmentFromExport(loadExport(normalizeEmailFormat(format)));
}

// Step 1: confirm the Gmail app password can log in (no message sent).
async function emailValidate(user, pass) {
  user = String(user || '').trim(); pass = String(pass || '').trim();
  if (!emailConfigured({ SMTP_USER: user, SMTP_APP_PASSWORD: pass }))
    return out({ ok: false, error: 'Enter your Gmail address and a 16-character App Password.' });
  return out(await verifyLogin({ SMTP_USER: user, SMTP_APP_PASSWORD: pass }));
}

function emailOAuthStart(redirectUri, to, subject, autoSend) {
  to = String(to || '').trim();
  if (!isEmailAddress(to)) return out({ ok: false, error: 'Enter the recipient email address.' });
  try {
    const started = beginOAuth({
      redirectUri, to,
      subject: String(subject || '').trim().slice(0, 120) || 'Job batch — {DATE}',
      autoSend: autoSend === true || autoSend === 'true' || autoSend === 'on'
    });
    return out({ ok: true, authUrl: started.authUrl });
  } catch (e) {
    return out({ ok: false, error: String(e.message || e) });
  }
}

async function emailOAuthComplete(code, state, redirectUri) {
  try {
    const connected = await completeOAuth({ code, state, redirectUri });
    if (!isEmailAddress(connected.to)) throw new Error('Recipient was lost during Google connection. Start again.');
    await sendConfiguredEmail({
      to: connected.to, from: connected.email,
      subject: '✅ Automatic Munyun Machine connected',
      text: 'This is a test from Automatic Munyun Machine. Your daily ranked job-batch .txt will be emailed to this address so you can apply. — AMM'
    });
    cfgRW.set('email.from', connected.email);
    cfgRW.set('email.to', connected.to);
    cfgRW.set('email.subject', connected.subject || 'Job batch — {DATE}');
    cfgRW.set('email.autoSend', !!connected.autoSend);
    cfgRW.set('email.enabled', true);
    return out({ ok: true, email: connected.email, to: connected.to });
  } catch (e) {
    return out({ ok: false, error: String(e.message || e) });
  }
}

// Step 2: verify login, send a test to the recipient, THEN persist (.env creds
// + config knobs). Never persists something that didn't just work.
async function emailSave(user, pass, to, subject, autoSend) {
  user = String(user || '').trim(); pass = String(pass || '').trim();
  to = String(to || '').trim();
  subject = String(subject || '').trim().slice(0, 120) || 'Job batch — {DATE}';
  const on = (autoSend === true || autoSend === 'true' || autoSend === 'on');
  if (!emailConfigured({ SMTP_USER: user, SMTP_APP_PASSWORD: pass }))
    return out({ ok: false, error: 'Enter your Gmail address and a 16-character App Password.' });
  if (!isEmailAddress(to)) return out({ ok: false, error: 'Enter the recipient email address.' });
  const v = await verifyLogin({ SMTP_USER: user, SMTP_APP_PASSWORD: pass });
  if (!v.ok) return out(v);
  try {
    await sendEmail({
      env: { SMTP_USER: user, SMTP_APP_PASSWORD: pass }, to, from: user,
      subject: '✅ Automatic Munyun Machine connected',
      text: 'This is a test from Automatic Munyun Machine. Your daily ranked job-batch .txt will be emailed to this address so you can apply. — AMM'
    });
  } catch (e) {
    return out({ ok: false, error: emailScrub('Could not send the test email: ' + friendlyError(e), pass) });
  }
  writeEmailEnv({ user, pass });
  cfgRW.set('email.from', user);
  cfgRW.set('email.to', to);
  cfgRW.set('email.subject', subject);
  cfgRW.set('email.autoSend', on);
  cfgRW.set('email.enabled', true);
  return out({ ok: true, to });
}

// Manual "Email batch" actions: email the current batch in the format chosen
// for this send, defaulting to the saved email.format preference. Automatic
// post-scrape delivery honors the same preference (v7.0).
async function emailSend(format) {
  const env = readEmailEnv();
  const delivery = emailDeliveryStatus(env);
  if (!delivery.connected) return out({ ok: false, error: 'Email isn’t connected yet — set it up in System → Email.' });
  const cfg = cfgRW.read();
  const to = String(cfg.email?.to || '').trim();
  if (!isEmailAddress(to)) return out({ ok: false, error: 'No recipient set — add one in System → Email.' });
  // v7.0: an explicit per-send choice (menu click) wins; otherwise fall back
  // to the saved email.format preference — same default the auto-send uses.
  const att = resolveBatchAttachment(format || cfg.email?.format);
  if (!att.ok) return out({ ok: false, error: att.error || 'No batch yet — run a scrape first.' });
  const subject = renderSubject(cfg.email?.subject, att.date);
  try {
    await sendConfiguredEmail({
      env, to, from: cfg.email?.from || delivery.email, subject,
      text: `Attached: ${att.filename} — today's ranked job batch from Automatic Munyun Machine.`,
      attachments: [{ filename: att.filename, content: att.content }]
    });
    return out({ ok: true, to, filename: att.filename });
  } catch (e) {
    return out({ ok: false, error: emailScrub('Send failed: ' + friendlyError(e), env.SMTP_APP_PASSWORD) });
  }
}

// Disconnect: strip creds from .env (backed up) + turn the knobs off.
function emailDisable() {
  try { disconnectEmail(); } catch {}
  try { cfgRW.set('email.enabled', false); cfgRW.set('email.autoSend', false); } catch {}
  return out({ ok: true });
}

// Only dispatch CLI when this file was invoked directly (not imported by a
// test that just wants buildInitConfig). ESM main-module check via
// pathToFileURL so Windows backslash paths don't false-negative.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const [, , cmd, a, b, a3, a4, a5] = process.argv;
if (isMain) (async () => {
  switch (cmd) {
    case 'settings-get': return settingsGet();
    case 'settings-set': return settingsSet(a, b);
    // v4.0: mute a term from the Why panel; list/restore config backups.
    case 'score-mute': {
      const term = (a || '').trim().toLowerCase();
      if (!term) return out({ ok: false, error: 'empty term' });
      const cfg = cfgRW.read();
      const muted = [...new Set([...(cfg.scoring?.mutedTerms || []).map(t => String(t).toLowerCase()), term])];
      cfgRW.set('scoring.mutedTerms', muted);
      return out({ ok: true, muted });
    }
    case 'config-backups': return out({ ok: true, backups: cfgRW.listConfigSnapshots() });
    case 'config-restore': {
      try { cfgRW.restoreConfigSnapshot(a); return out({ ok: true }); }
      catch (e) { return out({ ok: false, error: String(e.message || e) }); }
    }
    case 'skip-add':     return skipAdd(a);
    case 'skip-remove':  return skipRemove(a);
    case 'jobs-add':     return jobsAdd(a);
    case 'jobs-remove':  return jobsRemove(a);
    case 'jobs-clear':   return jobsClear();
    case 'jobs-mode':    return jobsMode(a);
    case 'suggest-current': return suggestCurrent(a);
    case 'job-action':   return jobAction(a, b);
    case 'resume-parse': return resumeParse(a, b);
    case 'resume-apply': return resumeApply(a);
    // v2.4: minimal export (number · title · apply link) as txt or csv.
    // v7.2: optional second arg = archive id to export a previous scrape.
    case 'export':       return out(loadExport(a, b));
    // v7.2: previous scrapes (full-batch snapshots, 30-day retention).
    case 'archive-list': return out({ ok: true, archives: listArchives(profilePaths().batchArchiveDir) });
    // v7.7: per-batch job exclusions ("don't send this one").
    case 'exclusions-get': return exclusionsGet();
    case 'job-exclude':    return jobExclude(a, b);
    case 'archive-get': {
      const batch = readArchive(profilePaths().batchArchiveDir, a);
      return out(batch ? { ok: true, batch } : { ok: false, error: 'That archived scrape is no longer available.' });
    }
    // v2.6: profile CRUD from the dashboard.
    case 'profile-list':   return profileList();
    case 'profile-add':    return profileAdd(a);
    case 'profile-rename': cfgRW.snapshotConfig('pre-rename'); return profileRename(a, b);
    case 'profile-delete': cfgRW.snapshotConfig('pre-delete'); return profileDelete(a);
    case 'profile-switch': return profileSwitch(a);
    // v2.7: first-run setup subcommands.
    case 'setup-geocode':            return setupGeocode(a);
    case 'setup-hcafe-login-start':  return setupHcafeLoginStart();
    case 'setup-hcafe-login-status': return setupHcafeLoginStatus();
    // v4.1: persistent hiring.cafe sign-in status for the main dashboard.
    case 'hcafe-auth-get':           return hcafeAuthGet();
    case 'hcafe-auth-check':         return hcafeAuthCheck();
    // v7.3: Dice sign-in — same flow as hcafe.
    case 'dice-login-start':         return diceLoginStart();
    case 'dice-login-status':        return diceLoginStatus();
    case 'dice-auth-get':            return diceAuthGet();
    case 'dice-auth-check':          return diceAuthCheck();
    case 'jobs-engine':              return jobsEngine(a, b);
    case 'setup-init':               cfgRW.snapshotConfig('pre-setup'); return setupInit(a);
    case 'setup-finalize':           return setupFinalize();
    // v4.3: email-to-VA setup + send.
    case 'email-oauth-start': return emailOAuthStart(a, b, a3, a4);
    case 'email-oauth-complete': return emailOAuthComplete(a, b, a3);
    case 'email-validate': return emailValidate(a, b);
    case 'email-save':     return emailSave(a, b, a3, a4, a5);
    case 'email-send':     return emailSend(a);
    case 'email-disable':  return emailDisable();
    default:
      out({ ok: false, error: 'usage: dashboard-api.mjs <settings-get|settings-set|jobs-add|jobs-remove|jobs-clear|jobs-mode|skip-add|skip-remove|suggest-current|job-action|resume-parse|resume-apply|profile-list|profile-add|profile-rename|profile-delete|profile-switch|setup-geocode|setup-hcafe-login-start|setup-hcafe-login-status|hcafe-auth-get|hcafe-auth-check|setup-init|setup-finalize|email-oauth-start|email-oauth-complete|email-validate|email-save|email-send|email-disable> [args]' });
      process.exit(2);
  }
})().catch(e => { out({ ok: false, error: String(e.message || e) }); process.exit(1); });
