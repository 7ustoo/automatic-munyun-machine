import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeywordCollection } from '../keyword-collection.mjs';
import { exportRows, buildExportCsv, buildExportTxt } from '../export-batch.mjs';

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

test('separate listings with matching company and title count separately', () => {
  const rows = ['a', 'b'].map(id => ({ href: `https://hiringcafe.com/job/${id}`, title: 'Cloud Engineer', company: 'Example' }));
  rows.push({ ...rows[0], href: 'https://hiring.cafe/job/a?ref=search#details' });
  rows.push({ href: 'https://hiringcafe.com/' });
  const { top, funnel } = buildKeywordCollection(rows, 'cloud', 1000, [{ complete: false, targetReached: true }]);
  assert.equal(top.length, 2);
  assert.equal(funnel.droppedDuplicates, 1);
  assert.equal(funnel.searchIncomplete, false);
  assert.ok(top.every(j => !/[?#]/.test(j.href)));
});

test('a 1000-listing collection exports all 1000 distinct listing links', () => {
  const rows = Array.from({ length: 1020 }, (_, id) => ({ href: `https://hiringcafe.com/job/cloud-${id}`, title: 'Cloud Engineer', company: 'Example' }));
  const { top } = buildKeywordCollection(rows, 'cloud', 1000, [{ targetReached: true }]);
  const exported = exportRows({ jobs: top.map((j, i) => ({ idx: i + 1, title: j.title, viewjobUrl: j.href })) });
  assert.equal(exported.length, 1000);
  assert.equal(new Set(exported.map(j => j.applyUrl)).size, 1000);
  assert.equal((buildExportCsv(exported, 'Listing Link').match(/https:\/\/hiringcafe\.com\/job\//g) || []).length, 1000);
  assert.equal((buildExportTxt(exported, '', 'listing link').match(/https:\/\/hiringcafe\.com\/job\//g) || []).length, 1000);
});
