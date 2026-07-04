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
import { fileURLToPath } from 'node:url';
import * as cfgRW from './config-rw.mjs';
import { paths as profilePaths } from './profile-store.mjs';
import { parseResume, writeParsedCV } from './resume-parser.mjs';
import { suggestRoles, suggestKeywords } from './role-suggester.mjs';
import { withFileLock } from './io-helpers.mjs';
import { loadExport } from './export-batch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// ---- settings ----
// The subset of config the dashboard exposes for editing. Kept small +
// explicit so the UI never has to understand the full profile structure.
function settingsGet() {
  const cfg = cfgRW.read();
  out({
    ok: true,
    settings: {
      maxYoeAcceptable: cfg.user?.maxYoeAcceptable ?? 5,
      salaryFloorUsd: cfg.user?.salaryFloorUsd ?? 90000,
      filterClearance: cfg.filters?.filterClearance !== false,
      applicationFormEase: cfg.filters?.applicationFormEase || 'all',
      matchFloorPercent: cfg.scoring?.matchFloorPercent ?? 25,
      scheduleTime: cfg.schedule?.time || '07:00',
      searchMode: cfg.search?.mode === 'keywords' ? 'keywords' : 'titles',
      maxJobAge: cfg.filters?.maxJobAge || 'any',
      queries: (cfg.queries || []).map(q => q.term)
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
    'scoring.matchFloorPercent', 'schedule.time', 'search.mode'
  ]);
  if (!allowed.has(dotPath)) return out({ ok: false, error: 'not an editable setting: ' + dotPath });
  // Light validation for the numeric / enum ones.
  if (dotPath === 'user.maxYoeAcceptable') value = Math.max(0, Math.min(30, parseInt(value) || 0));
  if (dotPath === 'user.salaryFloorUsd') value = Math.max(0, Math.min(900000, parseInt(value) || 0));
  if (dotPath === 'scoring.matchFloorPercent') value = Math.max(0, Math.min(100, parseInt(value) || 0));
  if (dotPath === 'filters.filterClearance') value = (value === true || value === 'true' || value === 'on');
  if (dotPath === 'filters.applicationFormEase' && !['all', 'simple', 'long'].includes(value)) value = 'all';
  if (dotPath === 'filters.maxJobAge' && !['today', '3days', 'week', 'month', 'any'].includes(value)) value = 'any';
  if (dotPath === 'search.mode') value = value === 'keywords' ? 'keywords' : 'titles';
  if (dotPath === 'schedule.time' && !/^\d{1,2}:\d{2}$/.test(String(value))) return out({ ok: false, error: 'time must be HH:MM' });
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
async function resumeParse(filePath) {
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
  writeParsedCV(parsed);
  const mode = cfgRW.read().search?.mode === 'keywords' ? 'keywords' : 'titles';
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

const [, , cmd, a, b] = process.argv;
(async () => {
  switch (cmd) {
    case 'settings-get': return settingsGet();
    case 'settings-set': return settingsSet(a, b);
    case 'jobs-add':     return jobsAdd(a);
    case 'jobs-remove':  return jobsRemove(a);
    case 'jobs-mode':    return jobsMode(a);
    case 'job-action':   return jobAction(a, b);
    case 'resume-parse': return resumeParse(a);
    case 'resume-apply': return resumeApply(a);
    // v2.4: minimal export (number · title · apply link) as txt or csv.
    case 'export':       return out(loadExport(a));
    default:
      out({ ok: false, error: 'usage: dashboard-api.mjs <settings-get|settings-set|jobs-add|jobs-remove|jobs-mode|job-action|resume-parse|resume-apply> [args]' });
      process.exit(2);
  }
})().catch(e => { out({ ok: false, error: String(e.message || e) }); process.exit(1); });
