// node --test scripts/__tests__/keyword-suggester.test.mjs
// v2.0.3: suggestKeywords() must propose short search keywords from the same
// cluster ranking suggestRoles() uses — an IAM-heavy CV yields "iam"-family
// keywords, an M365 CV yields "m365", a sparse CV yields nothing, and terms
// shared by multiple clusters dedupe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestRoles, suggestKeywords } from '../role-suggester.mjs';

// Inputs use the parsed-CV shape (data/cv-parsed.json): arrays of dictionary
// terms, not raw resume text.
const IAM_CV = {
  titles: ['IAM Engineer'],
  certs: ['SC-300'],
  skills: ['Okta', 'SailPoint', 'CyberArk', 'SCIM', 'SAML', 'OIDC'],
  compliance: []
};

const M365_CV = {
  titles: [],
  certs: ['MS-102'],
  skills: ['Microsoft 365', 'Intune', 'SharePoint', 'Exchange'],
  compliance: []
};

const SPARSE_CV = { titles: [], certs: [], skills: ['Excel'], compliance: [] };

test('IAM-heavy CV → keywords include iam-family terms', () => {
  const out = suggestKeywords(IAM_CV, { max: 12 }).map(s => s.title);
  assert.ok(out.includes('iam'), `expected 'iam' in ${JSON.stringify(out)}`);
  assert.ok(out.includes('okta'), `expected 'okta' in ${JSON.stringify(out)}`);
});

test('M365 CV → keywords include m365', () => {
  const out = suggestKeywords(M365_CV, { max: 12 }).map(s => s.title);
  assert.ok(out.includes('m365'), `expected 'm365' in ${JSON.stringify(out)}`);
});

test('keywords are short search terms, not job titles', () => {
  const out = suggestKeywords(IAM_CV, { max: 12 }).map(s => s.title);
  for (const k of out) {
    assert.ok(!/engineer|administrator|architect|analyst/i.test(k),
      `keyword "${k}" looks like a job title`);
  }
});

test('sparse CV (under 2 cluster signals) → no suggestions in either mode', () => {
  assert.equal(suggestKeywords(SPARSE_CV).length, 0);
  assert.equal(suggestRoles(SPARSE_CV).length, 0);
});

test('keywords dedupe across overlapping clusters', () => {
  // CyberArk + SailPoint light up both IAM and PAM/IGA clusters; shared
  // keywords must appear once.
  const out = suggestKeywords(IAM_CV, { max: 20 }).map(s => s.title.toLowerCase());
  assert.equal(out.length, new Set(out).size, `duplicates in ${JSON.stringify(out)}`);
});

test('suggestRoles unchanged: IAM CV still yields title suggestions', () => {
  const out = suggestRoles(IAM_CV, { max: 12 }).map(s => s.title);
  assert.ok(out.includes('IAM Engineer'), `expected 'IAM Engineer' in ${JSON.stringify(out)}`);
});

test('max caps the keyword list', () => {
  const out = suggestKeywords(IAM_CV, { max: 3 });
  assert.ok(out.length <= 3);
});

test('every suggestion carries cluster + signalsHit metadata', () => {
  for (const s of suggestKeywords(IAM_CV)) {
    assert.equal(typeof s.cluster, 'string');
    assert.ok(Array.isArray(s.signalsHit) && s.signalsHit.length >= 2);
  }
});
