import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExperienceEvidence, calculateCareerYears, enrichParsedResume, extractEmployment } from '../resume-parser.mjs';

test('resume evidence distinguishes demonstrated use and stated years', () => {
  const text = 'Built and deployed Terraform modules across AWS for 6 years.';
  const evidence = buildExperienceEvidence(text, { skills: ['Terraform', 'AWS'] });
  assert.equal(evidence.terraform.demonstratedMentions, 1);
  assert.equal(evidence.terraform.statedYears, 6);
  assert.ok(evidence.aws.contexts[0].includes('Terraform'));
});

test('career years merge overlaps without counting gaps as experience', () => {
  assert.equal(calculateCareerYears([
    { startYear: 2010, endYear: 2012 },
    { startYear: 2020, endYear: 2022 },
    { startYear: 2021, endYear: 2024 },
  ]), 6);
});

test('legacy v8 parsed resume gains structured evidence without re-upload', () => {
  const upgraded = enrichParsedResume({
    raw: 'Security Engineer\n2019 - Present\nBuilt Terraform on AWS.',
    titles: ['Security Engineer'], certs: [], skills: ['Terraform', 'AWS'], compliance: [],
  });
  assert.ok(upgraded.careerYears > 0);
  assert.equal(upgraded.experienceEvidence.terraform.demonstratedMentions, 1);
});

test('employment parser captures dated roles and current work', () => {
  const text = [
    'Acme Corporation',
    'Security Engineer',
    '2018 - 2022',
    'Example LLC',
    'Senior Security Engineer',
    '2022 - Present',
  ].join('\n');
  const roles = extractEmployment(text, 2026);
  assert.equal(roles.length, 2);
  assert.equal(roles[0].startYear, 2018);
  assert.equal(roles[1].current, true);
  assert.equal(roles[1].endYear, 2026);
});
