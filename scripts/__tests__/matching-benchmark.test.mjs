import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { matchRequirements } from '../requirement-matcher.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(here, '..', '__fixtures__', 'matching-benchmark.json'), 'utf8'));
const dictionary = {
  titles: ['Cloud Security Engineer', 'Account Executive'],
  certs: ['CISSP'],
  skills: ['AWS', 'Terraform', 'Python'],
  compliance: [],
};
const cv = {
  titles: ['Cloud Security Engineer'],
  certs: [],
  skills: ['AWS', 'Terraform', 'Python'],
  compliance: [],
  careerYears: 7,
  experienceEvidence: {
    aws: { demonstratedMentions: 2 },
    terraform: { demonstratedMentions: 1 },
    python: { demonstratedMentions: 1 },
  },
};

for (const fixture of cases) {
  test(`matching benchmark: ${fixture.name}`, () => {
    const result = matchRequirements({
      jobTitle: fixture.jobTitle,
      text: fixture.jobText,
      cv,
      dictionary,
      targetTerms: ['Cloud Security Engineer'],
    });
    assert.ok(result.matchPct >= fixture.min, `${result.matchPct} < ${fixture.min}`);
    assert.ok(result.matchPct <= fixture.max, `${result.matchPct} > ${fixture.max}`);
  });
}
