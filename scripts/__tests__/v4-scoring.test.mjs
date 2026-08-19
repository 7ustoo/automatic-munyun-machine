// v4.0 scoring mechanics: ambiguous-term guard, off-family gate regex,
// JD percentage bands, salary tie-breaking, and the AI prompt builder.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  termAllowedInText, AMBIGUOUS_TERM_CONTEXT, OFF_FAMILY_RX, FAMILY_PENALTY,
  jdScoreToPercent, salaryRank, compareJobs, SALARY_FLOOR_K,
} from '../daily-batch.mjs';
import { buildPrompt, candidateBatches, DEFAULT_AI_MODEL, RATINGS_SCHEMA } from '../ai-rerank.mjs';

test('ambiguous guard: Palo Alto the city does NOT count', () => {
  assert.equal(termAllowedInText('Palo Alto', 'Marketing Manager — Palo Alto, CA · $120k'), false);
});
test('ambiguous guard: Palo Alto Networks DOES count', () => {
  assert.equal(termAllowedInText('palo alto', 'experience with Palo Alto Networks firewalls (PAN-OS)'), true);
});
test('ambiguous guard: firewall context alone unlocks the term', () => {
  assert.equal(termAllowedInText('Palo Alto', 'manage NGFW firewall policies'), true);
});
test('ambiguous guard: non-listed terms always pass', () => {
  assert.equal(termAllowedInText('Okta', 'anything at all'), true);
});
test('ambiguous map covers the known trap terms', () => {
  for (const k of ['palo alto', 'chef', 'puppet', 'salt']) assert.ok(AMBIGUOUS_TERM_CONTEXT[k]);
});

test('off-family regex: marketing/sales/HR titles hit; technical titles do not', () => {
  assert.ok(OFF_FAMILY_RX.test('Marketing Operations Manager'));
  assert.ok(OFF_FAMILY_RX.test('Senior Account Executive'));
  assert.ok(OFF_FAMILY_RX.test('Customer Success Specialist'));
  assert.ok(!OFF_FAMILY_RX.test('IAM Engineer'));
  assert.ok(!OFF_FAMILY_RX.test('Cloud Security Architect'));
  assert.ok(FAMILY_PENALTY < 1 && FAMILY_PENALTY > 0);
});

test('jd bands are continuous at boundaries and monotone', () => {
  assert.equal(jdScoreToPercent(48), 90);
  assert.equal(jdScoreToPercent(32), 75);
  assert.equal(jdScoreToPercent(16), 50);
  assert.equal(jdScoreToPercent(8), 30);
  assert.equal(jdScoreToPercent(0), 0);
  let prev = -1;
  for (let s = 0; s <= 90; s++) {
    const p = jdScoreToPercent(s);
    assert.ok(p >= prev, `band not monotone at ${s}`);
    prev = p;
  }
  assert.ok(jdScoreToPercent(500) <= 100);
});

test('salary breaks ties but never outranks match %', () => {
  const hiMatch = { matchPct: 80, salaryK: 0 };
  const loMatchRich = { matchPct: 70, salaryK: 500 };
  assert.ok(compareJobs(hiMatch, loMatchRich) < 0, 'higher match wins regardless of salary');
  const a = { matchPct: 70, salaryK: 150 }, b = { matchPct: 70, salaryK: 120 };
  assert.ok(compareJobs(a, b) < 0, 'equal match: higher salary first');
  // Below-floor penalty is only exercised when a floor is configured. v5.0's
  // default floor is 0 (no floor) — a clean install penalizes no salary — so
  // derive the "below" value from the actual floor and skip when there is none.
  if (SALARY_FLOOR_K > 0) {
    const unknown = { matchPct: 70, salaryK: 0 }, below = { matchPct: 70, salaryK: Math.max(1, SALARY_FLOOR_K - 5) };
    assert.ok(salaryRank(below) < 0, 'a salary below the floor is penalized');
    assert.ok(salaryRank(unknown) > salaryRank(below), 'unknown salary ranks above a below-floor salary');
  }
});

test('ai prompt embeds cv summary + jobs and model default is opus 4.8', () => {
  const p = buildPrompt({ skills: ['iam'] }, [{ n: 0, title: 'IAM Engineer', company: 'X', text: 'body' }]);
  assert.ok(p.includes('"iam"') && p.includes('IAM Engineer') && p.includes('fit 0-100'));
  assert.equal(DEFAULT_AI_MODEL, 'claude-opus-4-8');
});

// v7.0: Smart match reads the real resume + scores a rubric, not just keywords.
test('ai prompt embeds verbatim resume text when provided (keywords become supplemental)', () => {
  const p = buildPrompt(
    { skills: ['iam'], resumeText: 'Ran IAM at BigBank for 5 years; led Okta rollout.' },
    [{ n: 0, title: 'IAM Engineer', company: 'X', text: 'body' }]
  );
  assert.ok(p.includes('BigBank'), 'real resume text is in the prompt');
  assert.ok(p.includes('supplemental'), 'keywords are marked supplemental');
  assert.ok(!p.includes('"resumeText"'), 'resumeText is not double-embedded in the keyword JSON');
  assert.ok(p.includes('- skills:') && p.includes('- seniority:') && p.includes('- role:'), 'rubric subscores are requested');
});

test('ai prompt without resume text falls back to keyword-summary mode', () => {
  const p = buildPrompt({ skills: ['iam'] }, [{ n: 0, title: 'IAM Engineer', company: 'X', text: 'body' }]);
  assert.ok(p.includes('Resume summary (extracted keywords):'));
});

test('ratings schema requires rubric subscores', () => {
  const req = RATINGS_SCHEMA.properties.ratings.items.required;
  for (const k of ['n', 'fit', 'reason', 'skills', 'seniority', 'role']) {
    assert.ok(req.includes(k), `schema requires ${k}`);
  }
  assert.equal(RATINGS_SCHEMA.properties.ratings.items.additionalProperties, false);
});

test('Smart Match batches all candidates instead of stopping at 40', () => {
  const jobs = Array.from({ length: 205 }, (_, n) => ({ n }));
  const batches = candidateBatches(jobs, 40);
  assert.deepEqual(batches.map(b => b.length), [40, 40, 40, 40, 40, 5]);
  assert.deepEqual(batches.flat(), jobs);
});
