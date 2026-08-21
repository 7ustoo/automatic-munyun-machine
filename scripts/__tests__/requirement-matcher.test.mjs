import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequirementCatalog,
  canonicalTerm,
  equivalentTerms,
  extractRequirements,
  matchRequirements,
  roleFitPercent,
} from '../requirement-matcher.mjs';

const dictionary = {
  titles: ['Cloud Security Engineer', 'Security Engineer', 'Account Executive'],
  certs: ['CISSP', 'Security+'],
  skills: ['AWS', 'Azure', 'Terraform', 'Kubernetes', 'Python'],
  compliance: ['SOC 2'],
};
const cv = {
  titles: ['Cloud Security Engineer'],
  certs: ['Security+'],
  skills: ['AWS', 'Terraform', 'Python'],
  compliance: ['SOC 2'],
};

test('catalog deduplicates terms and keeps weighted categories', () => {
  const catalog = buildRequirementCatalog({ ...dictionary, skills: ['AWS', 'aws'] });
  assert.equal(catalog.filter(x => x.key === 'aws').length, 1);
  assert.equal(catalog.find(x => x.key === 'cissp').category, 'certs');
});

test('nested aliases in the same phrase count as one requirement', () => {
  const reqs = extractRequirements('Cloud Security Engineer wanted', dictionary);
  assert.deepEqual(reqs.filter(r => r.category === 'titles').map(r => r.term), ['Cloud Security Engineer']);
});

test('standard abbreviations and their expanded names share one concept', () => {
  assert.equal(canonicalTerm('SSO'), canonicalTerm('Single Sign-On'));
  assert.equal(canonicalTerm('Azure AD'), canonicalTerm('Microsoft Entra ID'));
  assert.ok(equivalentTerms('SSO').includes('single sign-on'));
  assert.notEqual(canonicalTerm('OAuth'), canonicalTerm('OIDC'));
});

test('resume abbreviations satisfy expanded job requirements', () => {
  const result = matchRequirements({
    jobTitle: 'Cloud Security Engineer',
    text: 'Single Sign-On is required.',
    cv: { ...cv, skills: [...cv.skills, 'SSO'] },
    dictionary: { ...dictionary, skills: [...dictionary.skills, 'SSO', 'Single Sign-On'] },
  });
  assert.equal(result.coveragePct, 100);
  assert.deepEqual(result.matched, ['Single Sign-On']);
  assert.deepEqual(result.missing, []);
});

test('expanded resume terms satisfy abbreviated requirements', () => {
  const result = matchRequirements({
    jobTitle: 'Cloud Security Engineer',
    text: 'SSO is required.',
    cv: { ...cv, skills: [...cv.skills, 'Single Sign-On'] },
    dictionary: { ...dictionary, skills: [...dictionary.skills, 'SSO', 'Single Sign-On'] },
  });
  assert.equal(result.coveragePct, 100);
  assert.deepEqual(result.matched, ['SSO']);
});

test('an expanded term plus its abbreviation count as one requirement', () => {
  const reqs = extractRequirements(
    'Experience with Single Sign-On (SSO) is required.',
    { skills: ['SSO', 'Single Sign-On'] },
  );
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].concept, canonicalTerm('SSO'));
});

test('required alias wording wins over a preferred equivalent', () => {
  const reqs = extractRequirements(
    'Single Sign-On preferred. SSO is required.',
    { skills: ['SSO', 'Single Sign-On'] },
  );
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].context, 'required');
});

test('role fit recognizes target titles but rejects unrelated sales roles', () => {
  assert.ok(roleFitPercent('Senior Cloud Security Engineer', cv.titles) >= 90);
  assert.equal(roleFitPercent('Account Executive', cv.titles), 0);
});

test('requirement coverage does not reward repeated buzzwords', () => {
  const once = matchRequirements({
    jobTitle: 'Cloud Security Engineer',
    text: 'Required: AWS, Terraform, Azure, Kubernetes and CISSP.',
    cv, dictionary,
  });
  const repeated = matchRequirements({
    jobTitle: 'Cloud Security Engineer',
    text: 'Required: AWS AWS AWS, Terraform Terraform, Azure, Kubernetes and CISSP.',
    cv, dictionary,
  });
  assert.equal(repeated.matchPct, once.matchPct);
  assert.equal(repeated.coveragePct, once.coveragePct);
});

test('missing required certification prevents a strong score', () => {
  const result = matchRequirements({
    jobTitle: 'Cloud Security Engineer',
    text: 'CISSP is required. AWS and Terraform experience required.',
    cv, dictionary,
  });
  assert.ok(result.matchPct < 70);
  assert.ok(result.missing.includes('CISSP'));
});

test('unrelated title cannot become strong from body keyword overlap', () => {
  const result = matchRequirements({
    jobTitle: 'Account Executive',
    text: 'AWS Terraform Python SOC 2 AWS Terraform Python',
    cv, dictionary,
  });
  assert.ok(result.matchPct < 50);
});

test('required and preferred labels stay scoped to their own clauses', () => {
  const reqs = extractRequirements('CISSP preferred. AWS is required.', dictionary);
  assert.equal(reqs.find(r => r.term === 'CISSP').context, 'preferred');
  assert.equal(reqs.find(r => r.term === 'AWS').context, 'required');
});

test('strict years requirement caps a resume with less career evidence', () => {
  const result = matchRequirements({
    jobTitle: 'Cloud Security Engineer',
    text: 'Must have 10 years of experience. AWS and Terraform are required.',
    cv: { ...cv, careerYears: 6 }, dictionary,
  });
  assert.equal(result.yearsRequired, 10);
  assert.ok(result.matchPct < 70);
});

test('trailing required wording also identifies a strict years gap', () => {
  const result = matchRequirements({
    jobTitle: 'Cloud Security Engineer',
    text: '10+ years of experience required. AWS and Terraform.',
    cv: { ...cv, careerYears: 6 }, dictionary,
  });
  assert.equal(result.yearsRequired, 10);
  assert.ok(result.matchPct < 70);
});

test('demonstrated skill evidence outranks a bare skills-list mention', () => {
  const listed = matchRequirements({
    jobTitle: 'Cloud Security Engineer', text: 'Required: AWS and Terraform.',
    cv: { ...cv, experienceEvidence: { aws: { demonstratedMentions: 0 }, terraform: { demonstratedMentions: 0 } } }, dictionary,
  });
  const demonstrated = matchRequirements({
    jobTitle: 'Cloud Security Engineer', text: 'Required: AWS and Terraform.',
    cv: { ...cv, experienceEvidence: { aws: { demonstratedMentions: 2 }, terraform: { demonstratedMentions: 1 } } }, dictionary,
  });
  assert.ok(demonstrated.matchPct > listed.matchPct);
});
