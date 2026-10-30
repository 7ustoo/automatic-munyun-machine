import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlSearch, selectNextSearchUrl } from '../hcafe-pagination.mjs';

function fakePage(pages, fail = () => false, missingNavigation = false) {
  let index = 0;
  const visits = [];
  return { visits,
    async goto(url) { index = Number(new URL(url).searchParams.get('page')); visits.push(index); if (fail(index, visits)) throw new Error('timeout'); },
    async waitForFunction() {}, async waitForTimeout() {},
    async evaluate(expression) {
      if (typeof expression === 'string') return pages[index] || [];
      return { total: new Set(pages.flat().map(r => r.href)).size, empty: !pages[index]?.length,
        nextDisabled: index === pages.length - 1,
        links: missingNavigation || index === pages.length - 1 ? [] : [
          { label: 'Next job at this company', disabled: true },
          { label: 'Next page', href: `https://hiringcafe.com/classic?page=${index + 1}` },
        ] };
    },
    locator(selector) {
      if (selector.includes('.bg-white')) return { count: async () => 0 };
      return { first: () => ({ isVisible: async () => index < pages.length - 1, isEnabled: async () => true, getAttribute: async () => null }) };
    },
  };
}
const row = href => ({ href });
test('pagination retries interrupted page, retaining earlier pages', async () => {
  const page = fakePage([[row('a')], [row('b')], [row('c')]], (i, visits) => i === 1 && visits.filter(x => x === 1).length === 1);
  const r = await crawlSearch({ page, url: 'https://hiringcafe.com/', extract: '' });
  assert.deepEqual(page.visits, [0, 1, 1, 2]);
  assert.equal(r.coverage.complete, true);
  assert.deepEqual(r.rows.map(r => r.href), ['a', 'b', 'c']);
});

test('result navigation ignores company arrows and can follow numbered links', () => {
  const url = 'https://hiringcafe.com/?searchState=cloud&page=0';
  const next = 'https://hiringcafe.com/classic?searchState=cloud&page=1';
  const carousel = { label: 'Next job at this company', href: next, disabled: false };
  assert.equal(selectNextSearchUrl([carousel], url, 0), '');
  assert.equal(selectNextSearchUrl([carousel, { label: 'Next page', href: next }], url, 0), next);
  assert.equal(selectNextSearchUrl([{ text: '2', href: next }], url, 0), next);
  assert.equal(selectNextSearchUrl([{ label: 'Next page', href: next.replace('cloud', 'different') }], url, 0), '');
  assert.equal(selectNextSearchUrl([{ label: 'Next page', href: next.replace('hiringcafe.com', 'evil.example') }], url, 0), '');
});

test('collector continues over overlapping pages until the unique target is reached', async () => {
  const page = fakePage([[row('a'), row('b')], [row('b'), row('c')], [row('d')]]);
  const r = await crawlSearch({ page, url: 'https://hiringcafe.com/', extract: '', targetJobs: 3 });
  assert.deepEqual(page.visits, [0, 1]);
  assert.equal(r.rows.length, 3);
  assert.equal(r.coverage.targetReached, true);
  assert.equal(r.coverage.complete, false);
  assert.match(r.coverage.reason, /requested job count/);
});

test('missing navigation with remaining reported jobs is incomplete', async () => {
  const page = fakePage([[row('a')], [row('b')]], () => false, true);
  const r = await crawlSearch({ page, url: 'https://hiringcafe.com/', extract: '' });
  assert.equal(r.coverage.complete, false);
  assert.equal(r.rows.length, 1);
  assert.match(r.coverage.reason, /end of results not verified/);
});

test('paging target can count resolved apply links instead of raw listings', async () => {
  let resolved = 0;
  const page = fakePage([[row('a'), row('b')], [row('c'), row('d')], [row('e')]]);
  const result = await crawlSearch({ page, url: 'https://hiringcafe.com/', extract: '', targetJobs: 2,
    processPageRows: async rows => { resolved += rows.filter(row => ['a', 'c'].includes(row.href)).length; },
    targetCount: () => resolved });
  assert.deepEqual(page.visits, [0, 1]);
  assert.equal(result.rows.length, 4);
  assert.equal(result.coverage.targetReached, true);
});

test('different source jobs sharing apply URLs do not masquerade as a repeated result page', async () => {
  const links = new Set();
  const page = fakePage([[{ href: 'same', sourceId: '1' }], [{ href: 'same', sourceId: '2' }], [{ href: 'new', sourceId: '3' }]]);
  const result = await crawlSearch({ page, url: 'https://hiringcafe.com/', extract: '', targetJobs: 2,
    jobKey: row => row.sourceId, processPageRows: async rows => { rows.forEach(row => links.add(row.href)); }, targetCount: () => links.size });
  assert.deepEqual(page.visits, [0, 1, 2]);
  assert.equal(result.coverage.targetReached, true);
});
test('persistent timeout is incomplete, not exhausted; checkpoint retains next page', async () => {
  const page = fakePage([[row('a')], [row('b')]], i => i === 1);
  let checkpoint;
  const r = await crawlSearch({ page, url: 'https://hiringcafe.com/', extract: '', checkpoint: s => { checkpoint = s; } });
  assert.equal(r.coverage.complete, false);
  assert.equal(checkpoint.nextPage, 1);
  assert.match(checkpoint.reason, /timeout/);
  assert.equal(r.rows.length, 1);
});
test('overlapping results do not stop pagination; repeated pages are incomplete', async () => {
  const page = fakePage([[row('a')], [row('a'), row('b')], [row('c')]]);
  const r = await crawlSearch({ page, url: 'https://hiringcafe.com/', extract: '' });
  assert.equal(r.rows.length, 3);
  const repeated = await crawlSearch({ page: fakePage([[row('a')], [row('a')]]), url: 'https://hiringcafe.com/', extract: '' });
  assert.equal(repeated.coverage.complete, false);
});
test('safety cap is incomplete, never reported as end of supply', async () => {
  const r = await crawlSearch({ page: fakePage([[row('a')], [row('b')]]), url: 'https://hiringcafe.com/', extract: '', maxPages: 1 });
  assert.equal(r.coverage.complete, false);
  assert.match(r.coverage.reason, /safety/);
});
