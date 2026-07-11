// v4.3: pins buildSearchState (daily-batch.mjs) — the searchState contract
// for hiring.cafe scrape URLs. The high-stakes rule: hideJobTypes (the
// account-side Saved/Applied/Viewed filter, probed working on 2026-07-09)
// is sent ONLY when the run verified a signed-in session. Sending it
// unauth is a silent no-op server-side but would misreport the dedup mode;
// omitting it authed re-delivers already-seen jobs on every machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchState, normalizeWorkplaceTypes } from '../daily-batch.mjs';

test('default: query + Remote only — no account filter, no form-ease', () => {
  assert.deepEqual(buildSearchState('security engineer'), {
    searchQuery: 'security engineer',
    workplaceTypes: ['Remote'],
  });
});

test('accountDedup adds exactly Saved/Applied/Viewed', () => {
  const s = buildSearchState('grc analyst', { accountDedup: true });
  assert.deepEqual(s.hideJobTypes, ['Saved', 'Applied', 'Viewed']);
  assert.equal(s.searchQuery, 'grc analyst');
  assert.deepEqual(s.workplaceTypes, ['Remote']);
  assert.ok(!('applicationFormEase' in s));
});

test('accountDedup false / omitted never leaks hideJobTypes', () => {
  assert.ok(!('hideJobTypes' in buildSearchState('x', { accountDedup: false })));
  assert.ok(!('hideJobTypes' in buildSearchState('x', {})));
});

test('formEaseFilter passes through unchanged', () => {
  const s = buildSearchState('soc analyst', { formEaseFilter: ['Simple'] });
  assert.deepEqual(s.applicationFormEase, ['Simple']);
  assert.ok(!('hideJobTypes' in s));
});

test('both filters combine', () => {
  const s = buildSearchState('it auditor', { formEaseFilter: ['TimeConsuming'], accountDedup: true });
  assert.deepEqual(s, {
    searchQuery: 'it auditor',
    workplaceTypes: ['Remote'],
    hideJobTypes: ['Saved', 'Applied', 'Viewed'],
    applicationFormEase: ['TimeConsuming'],
  });
});

test('the URL round-trips through encodeURIComponent + JSON like the scraper builds it', () => {
  const s = buildSearchState('cloud security', { accountDedup: true });
  const url = 'https://hiring.cafe/?searchState=' + encodeURIComponent(JSON.stringify(s));
  const decoded = JSON.parse(decodeURIComponent(url.split('searchState=')[1]));
  assert.deepEqual(decoded, s);
});

// v5.0: workplace-type + location (Critical fix — Remote was hardcoded).
test('normalizeWorkplaceTypes maps friendly labels → hiring.cafe enum; empty → Remote', () => {
  assert.deepEqual(normalizeWorkplaceTypes(['On-Site', 'Hybrid']), ['Onsite', 'Hybrid']);
  assert.deepEqual(normalizeWorkplaceTypes(['remote']), ['Remote']);
  assert.deepEqual(normalizeWorkplaceTypes([]), ['Remote']);       // default
  assert.deepEqual(normalizeWorkplaceTypes(['garbage']), ['Remote']); // invalid → default
  assert.deepEqual(normalizeWorkplaceTypes(['Remote', 'remote']), ['Remote']); // dedup
});

test('workplaceTypes passes through normalized', () => {
  const s = buildSearchState('electrician', { workplaceTypes: ['On-Site'] });
  assert.deepEqual(s.workplaceTypes, ['Onsite']);
});

test('location is appended to the query only for non-remote searches', () => {
  // remote-only: location must NOT shrink the search
  assert.equal(buildSearchState('nurse', { workplaceTypes: ['Remote'], location: 'Austin, TX' }).searchQuery, 'nurse');
  // on-site: location biases the free-text query
  assert.equal(buildSearchState('nurse', { workplaceTypes: ['On-Site'], location: 'Austin, TX' }).searchQuery, 'nurse Austin, TX');
});

test('default workplaceTypes still Remote (no behavior change for existing installs)', () => {
  assert.deepEqual(buildSearchState('x').workplaceTypes, ['Remote']);
});
