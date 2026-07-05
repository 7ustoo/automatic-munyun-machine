// node --test scripts/__tests__/suggest-mode.test.mjs
// v2.8: suggestTermsForMode() backs the dashboard "Search style" toggle and the
// /api/suggest re-suggest-from-current-CV flow. It picks the suggester flavor
// (keywords vs titles) and flattens the cluster hits to plain search strings.
// The cluster ranking itself is covered by keyword-suggester/role-cluster tests;
// here we lock down the flavor selection + output shape the toggle depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestTermsForMode } from '../dashboard-api.mjs';

// Parsed-CV shape (data/cv-parsed.json): dictionary-term arrays, not raw text.
const IAM_CV = {
  titles: ['IAM Engineer'],
  certs: ['SC-300'],
  skills: ['Okta', 'SailPoint', 'CyberArk', 'SCIM', 'SAML', 'OIDC'],
  compliance: []
};
const SPARSE_CV = { titles: [], certs: [], skills: ['Excel'], compliance: [] };

test("mode 'keywords' → short keyword terms, normalized mode", () => {
  const r = suggestTermsForMode(IAM_CV, 'keywords');
  assert.equal(r.mode, 'keywords');
  assert.ok(Array.isArray(r.suggestions));
  assert.ok(r.suggestions.includes('iam'), `expected 'iam' in ${JSON.stringify(r.suggestions)}`);
  // Keywords are short search terms, never full job titles.
  for (const k of r.suggestions) {
    assert.ok(!/engineer|administrator|architect|analyst/i.test(k), `"${k}" looks like a title`);
  }
});

test("mode 'titles' → full job-title suggestions", () => {
  const r = suggestTermsForMode(IAM_CV, 'titles');
  assert.equal(r.mode, 'titles');
  assert.ok(r.suggestions.some(t => /engineer|architect|administrator/i.test(t)),
    `expected a job title in ${JSON.stringify(r.suggestions)}`);
});

test('unknown / empty mode defaults to titles (never crashes)', () => {
  assert.equal(suggestTermsForMode(IAM_CV, 'wat').mode, 'titles');
  assert.equal(suggestTermsForMode(IAM_CV, undefined).mode, 'titles');
  assert.equal(suggestTermsForMode(IAM_CV, '').mode, 'titles');
});

test('max caps the number of suggestions', () => {
  const r = suggestTermsForMode(IAM_CV, 'keywords', 2);
  assert.ok(r.suggestions.length <= 2);
});

test('sparse CV yields an empty list, not an error', () => {
  const r = suggestTermsForMode(SPARSE_CV, 'keywords');
  assert.deepEqual(r.suggestions, []);
  assert.equal(r.mode, 'keywords');
});

test('suggestions are plain strings (ready for the search list)', () => {
  for (const t of suggestTermsForMode(IAM_CV, 'keywords').suggestions) {
    assert.equal(typeof t, 'string');
  }
});
