import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGreenhouse } from '../sources/greenhouse.mjs';
import { normalizeLever } from '../sources/lever.mjs';
import { normalizeAshby } from '../sources/ashby.mjs';
import { matchesWorkplace } from '../sources/normalize.mjs';
import { mergeSources, fetchAllSources } from '../sources/index.mjs';

// Fixtures mirror the real API shapes fetched from live endpoints.
const GH = { title: 'Backend Engineer', company_name: 'Acme', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', location: { name: 'Remote - US' }, content: '<p>Build <b>APIs</b> in Go.</p>', updated_at: '2026-07-01T00:00:00Z' };
const LEVER = { text: 'Data Analyst', categories: { location: 'Austin, TX', allLocations: ['Austin, TX'] }, hostedUrl: 'https://jobs.lever.co/acme/2', applyUrl: 'https://jobs.lever.co/acme/2/apply', descriptionPlain: 'SQL and dashboards.', workplaceType: 'onsite', salaryRange: { min: 90000, max: 120000, currency: 'USD', interval: 'per-year-salary' }, createdAt: 1719792000000 };
const ASHBY = { title: 'Product Manager', location: 'New York', jobUrl: 'https://jobs.ashbyhq.com/acme/3', applyUrl: 'https://jobs.ashbyhq.com/acme/3/application', descriptionPlain: 'Own the roadmap.', isRemote: true, workplaceType: 'Remote', publishedAt: '2026-07-05T00:00:00Z', isListed: true, compensation: { compensationTierSummary: ['$150K – $180K'] } };

test('normalizeGreenhouse: strips HTML, fills card shape, __ats flag', () => {
  const c = normalizeGreenhouse(GH, 'acme');
  assert.equal(c.source, 'greenhouse');
  assert.equal(c.title, 'Backend Engineer');
  assert.equal(c.company, 'Acme');
  assert.equal(c.href, 'https://boards.greenhouse.io/acme/jobs/1');
  assert.equal(c.directUrl, c.href);
  assert.equal(c.jdText, 'Build APIs in Go.'); // HTML stripped + whitespace collapsed
  assert.equal(c.__ats, true);
  assert.ok(c.cardText.includes('Backend Engineer'));
});

test('normalizeLever: title from text, workplaceType + salary hint in JD', () => {
  const c = normalizeLever(LEVER, 'acme');
  assert.equal(c.title, 'Data Analyst');
  assert.equal(c.location, 'Austin, TX');
  assert.equal(c.workplaceType, 'onsite');
  assert.equal(c.href, 'https://jobs.lever.co/acme/2');
  assert.match(c.jdText, /SQL and dashboards/);
  assert.match(c.jdText, /\$90000 - \$120000/); // salaryRange appended for the parser
  assert.ok(c.postedAt.startsWith('2024') || c.postedAt.includes('T')); // epoch → ISO
});

test('normalizeAshby: isRemote → Remote, compensation appended', () => {
  const c = normalizeAshby(ASHBY, 'acme');
  assert.equal(c.title, 'Product Manager');
  assert.equal(c.workplaceType, 'Remote');
  assert.equal(c.href, 'https://jobs.ashbyhq.com/acme/3');
  assert.match(c.jdText, /Own the roadmap/);
  assert.match(c.jdText, /150K/);
});

test('normalizers reject junk', () => {
  assert.equal(normalizeGreenhouse({}, 't'), null);
  assert.equal(normalizeLever({ categories: {} }, 't'), null); // no text
  assert.equal(normalizeAshby({ location: 'x' }, 't'), null);   // no title
  assert.equal(normalizeGreenhouse({ title: 'X' }, 't'), null); // no url
});

test('matchesWorkplace: unknown kept; structured filtered', () => {
  assert.equal(matchesWorkplace({ workplaceType: '' }, ['Onsite']), true); // unknown → keep
  assert.equal(matchesWorkplace({ workplaceType: 'onsite' }, ['Onsite']), true);
  assert.equal(matchesWorkplace({ workplaceType: 'remote' }, ['Onsite']), false);
  assert.equal(matchesWorkplace({ workplaceType: 'remote' }, []), true); // no pref → keep all
});

test('mergeSources: dedups local + remote per ATS', () => {
  const m = mergeSources({ greenhouse: ['a', 'b'], lever: ['x'] }, { greenhouse: ['b', 'c'], ashby: ['z'] });
  assert.deepEqual(m.greenhouse, ['a', 'b', 'c']);
  assert.deepEqual(m.lever, ['x']);
  assert.deepEqual(m.ashby, ['z']);
});

test('fetchAllSources: aggregates, dedups by href, workplace-filters (mock fetch)', async () => {
  const responders = {
    'boards-api.greenhouse.io': { jobs: [GH] },
    'api.lever.co': [LEVER],
    'api.ashbyhq.com': { jobs: [ASHBY] },
  };
  const fetchImpl = async (url) => {
    const host = new URL(url).host;
    const body = responders[host] ?? {};
    return { ok: true, json: async () => body };
  };
  const all = await fetchAllSources(
    { greenhouse: ['acme'], lever: ['acme'], ashby: ['acme'] },
    { workplaceTypes: [], fetchImpl }
  );
  assert.equal(all.length, 3);
  assert.deepEqual(all.map(j => j.source).sort(), ['ashby', 'greenhouse', 'lever']);

  // Onsite-only pref drops the remote Ashby PM + keeps Lever(onsite); Greenhouse(unknown) kept.
  const onsite = await fetchAllSources(
    { greenhouse: ['acme'], lever: ['acme'], ashby: ['acme'] },
    { workplaceTypes: ['Onsite'], fetchImpl }
  );
  assert.ok(onsite.find(j => j.source === 'lever'));
  assert.ok(!onsite.find(j => j.source === 'ashby')); // remote dropped
});

test('fetchAllSources: no configured companies → empty (inert)', async () => {
  const all = await fetchAllSources({}, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.deepEqual(all, []);
});
