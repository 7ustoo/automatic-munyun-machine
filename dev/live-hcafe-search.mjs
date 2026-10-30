// Opt-in, read-only live search probe. Isolated browser; no batch/seen writes.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowser } from '../scripts/browser-launcher.mjs';
import { crawlSearch } from '../scripts/hcafe-pagination.mjs';
import { buildKeywordCollection } from '../scripts/keyword-collection.mjs';
import { parseKeywordBatchSize } from '../scripts/batch-size.mjs';
import { createApplyLinkCollector, directApplyKey, pruneApplyLinkCache, keywordSearchExtractor, keywordCandidateKey } from '../scripts/hcafe-apply-links.mjs';
import { atomicWriteJson, atomicWriteText } from '../scripts/io-helpers.mjs';
const target = process.argv[3] ? parseKeywordBatchSize(process.argv[3]) : 0;
if (target === null) throw new Error('Target must be a whole number from 1 to 1000.');
const browser = await resolveBrowser();
const ctx = await chromium.launch({ ...browser.launchOptions, headless: false,
  args: ['--window-position=10000,10000', '--disable-blink-features=AutomationControlled'] });
try {
  const page = await ctx.newPage();
  const source = fs.readFileSync(new URL('../scripts/daily-batch.mjs', import.meta.url), 'utf8');
  // Use production extraction without importing daily-batch's profile migration.
  const raw = source.match(/const EXTRACT_FN = `([\s\S]*?)`;/)?.[1];
  if (!raw) throw new Error('extractor not found');
  const extract = Function('return `' + raw + '`')();
  const state = { searchQuery: process.argv[2] || 'iam', workplaceTypes: ['Remote'], dateFetchedPastNDays: -1, sortBy: 'date' };
  const cachePath = fileURLToPath(new URL('../data/live-apply-link-cache.json', import.meta.url));
  let cache = {};
  try { cache = pruneApplyLinkCache(JSON.parse(fs.readFileSync(cachePath, 'utf8'))); } catch {}
  const applyCollector = target ? createApplyLinkCollector({ context: ctx, limit: target, log: console.log, cache,
    checkpoint: progress => {
      atomicWriteJson(cachePath, pruneApplyLinkCache(progress.cache));
      atomicWriteJson(fileURLToPath(new URL('../data/live-keyword-apply-progress.json', import.meta.url)), { rows: progress.rows, stats: progress.stats });
      atomicWriteText(fileURLToPath(new URL('../data/live-keyword-links.txt', import.meta.url)), progress.rows.map(j => j.directUrl).join('\n') + '\n');
    } }) : null;
  const result = await crawlSearch({ page, url: 'https://hiringcafe.com/?searchState=' + encodeURIComponent(JSON.stringify(state)),
    extract: target ? keywordSearchExtractor(extract) : extract, maxPages: target ? 5000 : 2, ...(target ? { targetJobs: target, jobKey: keywordCandidateKey,
      expandGroups: rows => !rows.some(row => row.embeddedApplyLink),
      processPageRows: applyCollector.collect, targetCount: applyCollector.count,
      beforeRequest: applyCollector.beforeRequest, onThrottle: applyCollector.backoff } : {}), log: console.log });
  console.log(JSON.stringify({ coverage: result.coverage, jobs: result.rows.length }));
  if (target) {
    result.coverage.applyResolution = { ...applyCollector.stats };
    const collection = buildKeywordCollection(applyCollector.rows(), state.searchQuery, target, [result.coverage]);
    const output = fileURLToPath(new URL('../data/live-keyword-collection.json', import.meta.url));
    atomicWriteJson(output, collection);
    atomicWriteText(fileURLToPath(new URL('../data/live-keyword-links.txt', import.meta.url)), collection.top.map(j => j.directUrl).join('\n') + '\n');
    console.log(JSON.stringify({ saved: collection.top.length, uniqueDirectLinks: new Set(collection.top.map(j => directApplyKey(j.directUrl))).size, output }));
    await applyCollector.close();
    if (collection.top.length !== target) process.exitCode = 1;
  } else if (result.coverage.pages !== 2 || !result.rows.length) process.exitCode = 1;
  if (!target && result.rows.length) {
    await page.goto(result.rows[0].href, { waitUntil: 'domcontentloaded' });
    await page.locator('#job-description').waitFor({ timeout: 20000 });
    console.log(JSON.stringify({ descriptionCharacters: (await page.locator('#job-description').innerText()).length }));
  }
} finally { await ctx.close(); }
