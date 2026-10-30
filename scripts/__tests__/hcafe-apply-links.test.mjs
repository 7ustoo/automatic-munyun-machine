import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLinkFromJobData, createApplyLinkCollector, directApplyUrl, createRequestPacer, retryDelayMs, resolveJobApplyLink,
  embeddedSearchJobs, keywordSearchExtractor } from '../hcafe-apply-links.mjs';

test('apply URL comes from the requested job and JSON escapes are decoded', () => {
  const payload = JSON.parse('{"props":{"pageProps":{"job":{"apply_url":"https://employer.example/apply?job=123\\u0026lang=en"},"similarJobs":[{"apply_url":"https://wrong.example/other"}]}}}');
  assert.equal(applyLinkFromJobData(payload).directUrl, 'https://employer.example/apply?job=123&lang=en');
  assert.equal(applyLinkFromJobData({ props: { pageProps: { similarJobs: [{ apply_url: 'https://wrong.example/other' }] } } }).status, 'missing');
  payload.props.pageProps.job.is_expired = true;
  assert.equal(applyLinkFromJobData(payload).status, 'expired');
});

test('direct apply URLs reject listing fallbacks, unsafe schemes, and malformed escapes', () => {
  for (const url of ['https://hiring.cafe/job/a', 'https://hiringcafe.com/job/a', 'javascript:alert(1)', 'https://user:pass@employer.example/apply', 'https://employer.example/a\\u0026b', 'https://localhost/apply']) {
    assert.equal(directApplyUrl(url), '', url);
  }
  assert.equal(directApplyUrl('https://jobs.example/apply/123?lang=en'), 'https://jobs.example/apply/123?lang=en');
});

test('collector replaces missing, expired and duplicate apply links using later candidates', async () => {
  let closed = 0;
  const context = { newPage: async () => ({ close: async () => { closed++; } }) };
  const results = {
    a: { status: 'resolved', directUrl: 'https://jobs.example/1' },
    b: { status: 'missing' }, c: { status: 'expired' },
    d: { status: 'resolved', directUrl: 'https://jobs.example/1?utm_source=cafe' },
    e: { status: 'resolved', directUrl: 'https://jobs.example/2' },
  };
  const collector = createApplyLinkCollector({ context, limit: 2, concurrency: 2,
    resolve: async (_page, href) => results[href.split('/').pop()] });
  const rows = ids => ids.map(id => ({ href: `https://hiringcafe.com/job/${id}` }));
  await collector.collect(rows(['a', 'b', 'c', 'd']));
  assert.equal(collector.count(), 1);
  await collector.collect(rows(['a', 'e']));
  assert.equal(collector.count(), 2);
  assert.deepEqual(collector.rows().map(row => row.directUrl), ['https://jobs.example/1', 'https://jobs.example/2']);
  assert.equal(collector.stats.missing, 1);
  assert.equal(collector.stats.expired, 1);
  assert.equal(collector.stats.duplicates, 1);
  await collector.close();
  assert.equal(closed, 2);
});

test('shared pacing spaces requests and honors a server cooldown', async () => {
  let clock = 0;
  const pacer = createRequestPacer({ intervalMs: 1000, now: () => clock, sleep: async ms => { clock += ms; } });
  await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()]);
  assert.equal(clock, 2000);
  pacer.pause(5000);
  await pacer.wait();
  assert.equal(clock, 7000);
  assert.equal(retryDelayMs('15'), 15000);
  assert.equal(retryDelayMs('bad'), 60000);
});

test('rate-limited job pages back off before retrying', async () => {
  let requests = 0, pauses = [];
  const page = {
    goto: async () => ({ status: () => ++requests === 1 ? 429 : 200, ok: () => true, headers: () => ({ 'retry-after': '10' }) }),
    waitForFunction: async () => {},
    evaluate: async () => ({ props: { pageProps: { job: { apply_url: 'https://jobs.example/1' } } } }),
  };
  const result = await resolveJobApplyLink(page, 'https://hiring.cafe/job/a', { onThrottle: ms => { pauses.push(ms); } });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(pauses, [10000]);
});

test('a valid cached apply link is reused without another request', async () => {
  const cache = { '/job/a': { directUrl: 'https://jobs.example/1', at: Date.now() } };
  const collector = createApplyLinkCollector({ context: { newPage: async () => ({ close: async () => {} }) }, limit: 1, cache,
    resolve: async () => { throw new Error('cached job must not be requested'); } });
  await collector.collect([{ href: 'https://hiringcafe.com/job/a' }]);
  assert.equal(collector.count(), 1);
  assert.equal(collector.stats.cached, 1);
  await collector.close();
});

test('embedded search results retain the correct job/apply association without reading recommendations', async () => {
  const job = (id, title) => ({ id, apply_url: `https://employer.example/apply/${id}?lang=en&job=${id}`,
    job_information: { title }, v5_processed_job_data: { company_name: 'Example' } });
  const data = { props: { pageProps: { ssrHits: [{ jobs: [job('a', 'Cloud Engineer'), job('b', 'Cloud Architect')] }], similarJobs: [job('wrong', 'Wrong job')] } } };
  const rows = embeddedSearchJobs(data);
  assert.deepEqual(rows.map(row => [row.sourceId, row.title]), [['a', 'Cloud Engineer'], ['b', 'Cloud Architect']]);
  const document = { querySelector: () => ({ textContent: JSON.stringify(data) }) };
  assert.deepEqual(Function('document', `return ${keywordSearchExtractor('[]')}`)(document), rows);
  const collector = createApplyLinkCollector({ context: { newPage: async () => ({ close: async () => {} }) }, limit: 2,
    resolve: async () => { throw new Error('embedded links must not load individual job pages'); } });
  await collector.collect(rows);
  assert.equal(collector.count(), 2);
  assert.equal(collector.stats.embedded, 2);
  await collector.close();
});
