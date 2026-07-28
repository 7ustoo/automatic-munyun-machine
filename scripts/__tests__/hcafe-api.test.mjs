// node --test — hiring.cafe search API adapter (v7.10). Pure builders only;
// the fetch loop needs a live page and is exercised by a real scrape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hcafeJobUrl, publishDateToAgeToken, hitCardText, normalizeHcafeHit, isLastPage
} from '../sources/hcafe-api.mjs';
import { parseAgeToDays } from '../job-recency.mjs';

const NOW = Date.parse('2026-07-28T00:00:00.000Z');
const ago = (days) => new Date(NOW - days * 86400000).toISOString();

const HIT = {
  id: 'workday___caci___senior-cloud-security',
  apply_url: 'https://caci.wd1.myworkdayjobs.com/external/job/123',
  is_expired: false,
  job_information: { title: 'Senior Cloud Security & Cryptography Engineer' },
  v5_processed_job_data: {
    company_name: 'Caci',
    formatted_workplace_location: 'United States',
    min_industry_and_role_yoe: 8,
    estimated_publish_date: ago(3),
    workplace_type: 'Remote',
    yearly_min_compensation: 114600,
    yearly_max_compensation: 252100,
    seniority_level: 'Senior Level',
    requirements_summary: 'Active TS/SCI clearance, 8+ years cloud engineering',
    technical_tools: ['Python', 'Terraform'],
    licenses_or_certifications: ['gcp professional cloud security engineer'],
    role_activities: ['designing solutions'],
    company_tagline: 'A defense contractor'
  }
};

test('normalizeHcafeHit maps the API shape onto the pipeline card shape', () => {
  const c = normalizeHcafeHit(HIT, NOW);
  assert.equal(c.href, 'https://hiring.cafe/job/workday___caci___senior-cloud-security');
  assert.equal(c.title, 'Senior Cloud Security & Cryptography Engineer');
  assert.equal(c.company, 'Caci');           // the DOM heuristic often produced ''
  assert.equal(c.yoe, 8);                    // structured, not regex-guessed
  assert.equal(c.postedAge, '3d');
  assert.equal(c.directUrl, HIT.apply_url);  // already-resolved apply link
  assert.equal(c.workplaceType, 'Remote');
  assert.equal(c.salaryMinK, 115);
  assert.equal(c.salaryMaxK, 252);
});

test('normalizeHcafeHit rejects unusable hits', () => {
  assert.equal(normalizeHcafeHit(null, NOW), null);
  assert.equal(normalizeHcafeHit({ id: 'x' }, NOW), null);                       // no title
  assert.equal(normalizeHcafeHit({ job_information: { title: 'T' } }, NOW), null); // no id
});

test('normalizeHcafeHit falls back to enriched company name', () => {
  const h = { ...HIT, v5_processed_job_data: { ...HIT.v5_processed_job_data, company_name: '' },
              enriched_company_data: { name: 'CACI' } };
  assert.equal(normalizeHcafeHit(h, NOW).company, 'CACI');
});

test('missing yoe / salary / date degrade to safe values, never NaN', () => {
  const c = normalizeHcafeHit({ id: 'a', job_information: { title: 'Engineer' }, v5_processed_job_data: {} }, NOW);
  assert.equal(c.yoe, null);        // null = "unknown", which the YOE filter keeps
  assert.equal(c.postedAge, '');    // '' = "unknown age", which the recency filter keeps
  assert.equal(c.salaryMinK, 0);
  assert.equal(c.company, '');
});

test('publishDateToAgeToken emits tokens the recency filter already parses', () => {
  const cases = [[0.25, 'h'], [3, 'd'], [21, 'w'], [120, 'mo'], [800, 'y']];
  for (const [days, unit] of cases) {
    const tok = publishDateToAgeToken(ago(days), NOW);
    assert.ok(tok.endsWith(unit), `${days}d ago → ${tok}, expected unit ${unit}`);
    assert.notEqual(parseAgeToDays(tok), null, `${tok} must be parseable by job-recency`);
  }
  assert.equal(publishDateToAgeToken('not-a-date', NOW), '');
  assert.equal(publishDateToAgeToken(undefined, NOW), '');
});

test('publishDateToAgeToken round-trips to roughly the right age', () => {
  for (const days of [1, 5, 30, 200]) {
    const back = parseAgeToDays(publishDateToAgeToken(ago(days), NOW));
    assert.ok(Math.abs(back - days) <= days * 0.2 + 1, `${days}d → ${back}d is too far off`);
  }
});

test('hitCardText concatenates the fields that carry matching signal', () => {
  const t = hitCardText(HIT);
  for (const needle of ['Senior Cloud Security', 'Caci', 'Python', 'Terraform', 'TS/SCI', 'gcp professional']) {
    assert.ok(t.includes(needle), `card text missing "${needle}"`);
  }
  assert.ok(t.length <= 4000);
});

test('hitCardText survives a hit with no processed data', () => {
  assert.equal(hitCardText({}), '');
  assert.equal(hitCardText(null), '');
});

test('isLastPage honors the explicit flag and an empty page', () => {
  assert.equal(isLastPage({ ssrIsLastPage: true }, 40), true);
  assert.equal(isLastPage({ ssrIsLastPage: false }, 0), true);   // no hits = done
  assert.equal(isLastPage({ ssrIsLastPage: false }, 40), false); // keep going
  assert.equal(isLastPage(null, 40), true);                      // no payload = stop
});

test('hcafeJobUrl builds the canonical job link used for dedup', () => {
  assert.equal(hcafeJobUrl('abc'), 'https://hiring.cafe/job/abc');
  assert.equal(hcafeJobUrl(' abc '), 'https://hiring.cafe/job/abc');
});
