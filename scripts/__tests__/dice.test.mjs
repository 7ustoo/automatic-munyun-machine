import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFlightPayload, parseDiceJobs, extractFlightText, parseDiceDetailJD,
  normalizeDice, fetchDice, buildDiceSearchUrl
} from '../sources/dice.mjs';
import { fetchAllSources } from '../sources/index.mjs';

// ---- fixtures: synthetic Next.js flight pages in dice.com's real shape ----

const JOB_A = {
  id: 'aa11', guid: '95cb7fb9-416d-41d5-9e58-7323bc680a7f',
  detailsPageUrl: 'https://www.dice.com/job-detail/95cb7fb9-416d-41d5-9e58-7323bc680a7f',
  companyName: 'Disney', employmentType: 'Full-time',
  jobLocation: { displayName: 'Orlando, Florida, USA' },
  postedDate: '2026-07-19T11:38:21Z',
  salary: 'USD 135,400.00 - 181,600.00 per year',
  summary: 'We make the impossible possible. IAM, SAML, cloud security at scale.',
  title: 'Senior Security Engineer', isRemote: false, workplaceTypes: ['On-Site']
};
const JOB_B = {
  id: 'bb22', guid: '4ab2dea4-f804-4e91-8c0c-41b54b4dd24c',
  detailsPageUrl: 'https://www.dice.com/job-detail/4ab2dea4-f804-4e91-8c0c-41b54b4dd24c',
  companyName: 'EnerSys', jobLocation: { displayName: 'Remote, USA' },
  postedDate: '2026-07-20T08:00:00Z', salary: 'Competitive',
  summary: 'AppSec role.', title: 'Application Security Engineer',
  isRemote: true, workplaceTypes: ['Remote']
};

// Flight payloads escape quotes; wrap as the page would, split across two
// pushes mid-object to prove chunk joining works. JOB_A appears twice (result
// list + "similar jobs" rail) to prove guid dedup.
function flightWrap(json) {
  return json.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function searchFixture() {
  const payload = `{"jobList":{"data":[${JSON.stringify(JOB_A)},${JSON.stringify(JOB_B)}]}},"similar":[${JSON.stringify(JOB_A)}]`;
  const esc = flightWrap(payload);
  const cut = Math.floor(esc.length / 2);
  return `<html><body>` +
    `<script>self.__next_f.push([1,"${esc.slice(0, cut)}"])</script>` +
    `<script>self.__next_f.push([1,"${esc.slice(cut)}"])</script>` +
    `</body></html>`;
}
function detailFixture() {
  const jd = '\\u003cp\\u003eGreat \\u003cb\\u003eIAM\\u003c/b\\u003e job. Requires SAML &amp; OIDC.\\u003c/p\\u003e';
  const text = `4b:T${jd.length.toString(16)},${jd}`;
  const body = flightWrap(`{"jobDetail":{"description":"$4b","positionId":"X"}}`);
  return `<html><body>` +
    `<script>self.__next_f.push([1,"${flightWrap(text)}\\n"])</script>` +
    `<script>self.__next_f.push([1,"${body}"])</script>` +
    `</body></html>`;
}

// ---- parsers ----

test('extractFlightPayload joins chunks and unescapes quotes', () => {
  const flight = extractFlightPayload(searchFixture());
  assert.ok(flight.includes('"guid":"95cb7fb9-416d-41d5-9e58-7323bc680a7f"'));
  assert.ok(flight.includes('"salary":"USD 135,400.00 - 181,600.00 per year"'));
});

test('parseDiceJobs finds both jobs, dedups the similar-jobs repeat', () => {
  const jobs = parseDiceJobs(searchFixture());
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].title, 'Senior Security Engineer');
  assert.equal(jobs[1].guid, JOB_B.guid);
});

test('parseDiceJobs: no flight data → empty, never throws', () => {
  assert.deepEqual(parseDiceJobs('<html>nothing here</html>'), []);
  assert.deepEqual(parseDiceJobs(''), []);
});

test('extractFlightText resolves a hex-length text chunk', () => {
  const txt = extractFlightText(detailFixture(), '4b');
  assert.ok(txt.includes('\\u003cp\\u003e') || txt.includes('<p>')); // raw chunk, pre-decode
});

test('parseDiceDetailJD decodes \\uXXXX, strips tags and entities', () => {
  const jd = parseDiceDetailJD(detailFixture());
  assert.equal(jd, 'Great IAM job. Requires SAML OIDC.');
});

// ---- normalization ----

test('normalizeDice maps fields; salary lands in jd text for the salary parser', () => {
  const c = normalizeDice(JOB_A);
  assert.equal(c.source, 'dice');
  assert.equal(c.company, 'Disney');
  assert.equal(c.location, 'Orlando, Florida, USA');
  assert.equal(c.workplaceType, 'onsite');
  assert.equal(c.postedAt, '2026-07-19T11:38:21Z');
  assert.ok(c.jdText.includes('Salary: USD 135,400.00 - 181,600.00 per year'));
  assert.ok(c.__ats, 'dice cards skip the Playwright resolve pass');
});

test('normalizeDice: remote flag fallback; non-numeric salary omitted', () => {
  const c = normalizeDice({ ...JOB_B, workplaceTypes: [] });
  assert.equal(c.workplaceType, 'remote');
  assert.ok(!c.jdText.includes('Salary:'), 'text-only salary strings add no note');
});

test('normalizeDice: junk in → null out', () => {
  assert.equal(normalizeDice(null), null);
  assert.equal(normalizeDice({ title: 'X' }), null); // no url
});

// ---- fetch orchestration (stubbed network) ----

function stubFetch() {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const body = url.includes('/job-detail/') ? detailFixture()
      : url.includes('page=2') ? '<html></html>'
      : searchFixture();
    return { ok: true, text: async () => body, json: async () => ({}) };
  };
  return { impl, calls };
}

test('fetchDice: parses search, enriches top cards with detail JD', async () => {
  const { impl, calls } = stubFetch();
  const cards = await fetchDice('security engineer', { fetchImpl: impl, jdTop: 1 });
  assert.equal(cards.length, 2);
  // top card enriched from detail page; salary note preserved
  assert.ok(cards[0].jdText.startsWith('Great IAM job.'));
  assert.ok(cards[0].jdText.includes('Salary: USD 135,400.00'));
  // second card keeps its summary (jdTop=1)
  assert.ok(cards[1].jdText.includes('AppSec role.'));
  assert.ok(calls[0].includes('q=security+engineer')); // URLSearchParams space encoding (v7.5)
});

test('fetchDice: network failure → [] (best-effort contract)', async () => {
  const cards = await fetchDice('x', { fetchImpl: async () => { throw new Error('down'); } });
  assert.deepEqual(cards, []);
});

test('fetchAllSources: dice runs one task per query and dedups by href (always-on, v7.4)', async () => {
  const { impl } = stubFetch();
  const logs = [];
  const out = await fetchAllSources(
    {},
    { queries: ['iam', 'appsec'], fetchImpl: impl, log: l => logs.push(l), workplaceTypes: [] }
  );
  // both queries return the same 2 fixture jobs → deduped to 2
  assert.equal(out.length, 2);
  assert.ok(logs.some(l => l.includes('dice/iam: 2 jobs')));
  assert.ok(logs.some(l => l.includes('dice/appsec: 2 jobs')));
});

test('fetchAllSources: empty query list is the only dice off switch (v7.4)', async () => {
  const out = await fetchAllSources({}, { queries: [], fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(out, []);
});

test('fetchAllSources: workplace filter applies to dice cards', async () => {
  const { impl } = stubFetch();
  const out = await fetchAllSources(
    {},
    { queries: ['iam'], fetchImpl: impl, workplaceTypes: ['Remote'] }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].workplaceType, 'remote');
});

// ---- v7.5: server-side filter params + watch hook ----

test('buildDiceSearchUrl: filters ride the URL', () => {
  const u = new URL(buildDiceSearchUrl('iam engineer', {
    workplaceTypes: ['Remote'], location: 'Atlanta, GA, USA', maxAgeDays: 7, page: 2
  }));
  assert.equal(u.searchParams.get('q'), 'iam engineer');
  assert.equal(u.searchParams.get('filters.workplaceTypes'), 'Remote');
  assert.equal(u.searchParams.get('location'), null, 'remote-only search must not pin a location');
  assert.equal(u.searchParams.get('filters.postedDate'), 'SEVEN');
  assert.equal(u.searchParams.get('page'), '2');
});

test('buildDiceSearchUrl: local search carries location + radius', () => {
  const u = new URL(buildDiceSearchUrl('iam', { workplaceTypes: ['Onsite', 'Hybrid'], location: 'Atlanta, GA, USA' }));
  assert.equal(u.searchParams.get('filters.workplaceTypes'), 'On-Site|Hybrid');
  assert.equal(u.searchParams.get('location'), 'Atlanta, GA, USA');
  assert.equal(u.searchParams.get('radius'), '30');
});

test('buildDiceSearchUrl: all-or-no workplace types means no filter, age>7d omitted', () => {
  const all = new URL(buildDiceSearchUrl('iam', { workplaceTypes: ['Remote', 'Hybrid', 'Onsite'], maxAgeDays: 30 }));
  assert.equal(all.searchParams.get('filters.workplaceTypes'), null);
  assert.equal(all.searchParams.get('filters.postedDate'), null);
  const none = new URL(buildDiceSearchUrl('iam', { maxAgeDays: Infinity }));
  assert.equal(none.searchParams.get('filters.workplaceTypes'), null);
  assert.equal(none.searchParams.get('filters.postedDate'), null);
  assert.equal(none.searchParams.get('page'), null);
});

test('fetchDice: onPage watch hook sees every search page URL, and a throwing hook never breaks the fetch', async () => {
  const { impl } = stubFetch();
  const seen = [];
  const out = await fetchDice('iam', { fetchImpl: impl, pages: 2, onPage: (url, q, p) => { seen.push(p + ':' + url); throw new Error('watch died'); } });
  assert.ok(out.length > 0, 'jobs still returned despite hook throwing');
  assert.equal(seen.length, 2);
  assert.ok(seen[0].startsWith('1:https://www.dice.com/jobs?q=iam'));
  assert.ok(seen[1].includes('page=2'));
});

test('fetchDice: v7.6 pagination stops when a page adds nothing new (repeat-page guard)', async () => {
  let calls = 0;
  const impl = async (url) => {
    calls++;
    return { ok: true, text: async () => url.includes('/job-detail/') ? detailFixture() : searchFixture() };
  };
  const cards = await fetchDice('iam', { fetchImpl: impl, jdTop: 0 });
  assert.equal(cards.length, 2);
  // page 1 → 2 new; page 2 (same fixture) → 0 new → stop. No 20-page runaway.
  assert.equal(calls, 2);
});

test('fetchDice: every returned card can lazily load its full description', async () => {
  const { impl } = stubFetch();
  const cards = await fetchDice('iam', { fetchImpl: impl, pages: 2, jdTop: 0 });
  assert.equal(typeof cards[1].__loadDescription, 'function');
  const full = await cards[1].__loadDescription();
  assert.ok(full.startsWith('Great IAM job.'));
  assert.equal(cards[1].jdText, full);
});
