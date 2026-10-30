import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeywordCollection } from '../keyword-collection.mjs';

test('keyword collection keeps unique listings without scores or seen state', () => {
  const rows = [
    { href: 'https://hiring.cafe/job/a', title: 'Cloud Engineer' },
    { href: 'https://hiring.cafe/job/a', title: 'Cloud Engineer' },
    { href: 'https://hiring.cafe/job/b', title: 'Cloud Analyst' },
    { href: 'https://evil.example/job/c', title: 'Injected' },
  ];
  const { top, funnel } = buildKeywordCollection(rows, 'cloud', 1000, [{ complete: true }]);
  assert.deepEqual(top.map(j => j.href), ['https://hiring.cafe/job/a', 'https://hiring.cafe/job/b']);
  assert.ok(top.every(j => j.q === 'cloud' && j.matchPct === undefined));
  assert.equal(funnel.sent, 2);
  assert.equal(funnel.droppedDuplicates, 1);
  assert.equal(funnel.searchIncomplete, false);
});

test('keyword collection caps results and validates its count', () => {
  const rows = [{ href: 'https://hiringcafe.com/job/a' }, { href: 'https://hiringcafe.com/job/b' }];
  assert.equal(buildKeywordCollection(rows, 'cloud', 1).top.length, 1);
  assert.throws(() => buildKeywordCollection(rows, 'cloud', 1001));
});
