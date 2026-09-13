import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduledProfileSlugs } from '../scheduled-batches.mjs';

test('scheduled runner includes every enabled profile and preserves order', () => {
  const raw = { profiles: {
    engineering: { schedule: { enabled: true } },
    marketing: { schedule: { enabled: false } },
    operations: { schedule: {} },
  } };
  assert.deepEqual(scheduledProfileSlugs(raw), ['engineering', 'operations']);
});

test('missing profile map produces an empty scheduled run', () => {
  assert.deepEqual(scheduledProfileSlugs({}), []);
});
