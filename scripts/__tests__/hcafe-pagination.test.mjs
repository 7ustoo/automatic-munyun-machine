import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlSearch } from '../hcafe-pagination.mjs';

function fakePage(pages, fail = () => false) {
  let index = 0;
  const visits = [];
  return { visits,
    async goto(url) { index = Number(new URL(url).searchParams.get('page')); visits.push(index); if (fail(index, visits)) throw new Error('timeout'); },
    async waitForFunction() {}, async waitForTimeout() {},
    async evaluate() { return pages[index] || []; },
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
