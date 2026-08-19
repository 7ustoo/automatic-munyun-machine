import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeJobs, sameCanonicalJob } from '../job-deduper.mjs';

test('same opening across aggregator and ATS URLs deduplicates', () => {
  const cafe = { href: 'https://hiring.cafe/job/abc', title: 'Senior Security Engineer', company: 'Acme, Inc.', location: 'Remote' };
  const ats = { href: 'https://boards.greenhouse.io/acme/jobs/42', directUrl: 'https://boards.greenhouse.io/acme/jobs/42', title: 'Senior Security Engineer', company: 'Acme', location: 'Remote', jdText: 'x'.repeat(3000) };
  assert.equal(sameCanonicalJob(cafe, ats), true);
  const result = dedupeJobs([cafe, ats]);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.dropped, 1);
  assert.equal(result.jobs[0].href, ats.href, 'richer full-description record wins');
});

test('same title at explicit different locations remains distinct', () => {
  const a = { href: 'https://a.test/1', title: 'Nurse', company: 'Hospital', location: 'Miami' };
  const b = { href: 'https://b.test/2', title: 'Nurse', company: 'Hospital', location: 'Atlanta' };
  assert.equal(sameCanonicalJob(a, b), false);
  assert.equal(dedupeJobs([a, b]).jobs.length, 2);
});
