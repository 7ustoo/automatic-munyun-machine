import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDryQueries } from '../daily-batch.mjs';

test('findDryQueries identifies only queries with three consecutive zero-card runs', () => {
  const stats = {
    queries: {
      dry: { history: [{ cards: 4 }, { cards: 0 }, { cards: 0 }, { cards: 0 }] },
      recovered: { history: [{ cards: 0 }, { cards: 0 }, { cards: 2 }] },
      insufficient: { history: [{ cards: 0 }, { cards: 0 }] },
      malformed: { history: [{}, { cards: null }, { cards: 0 }] }
    }
  };

  assert.deepEqual(findDryQueries(stats), ['dry']);
});

test('findDryQueries tolerates missing state and supports a custom run window', () => {
  assert.deepEqual(findDryQueries(null), []);
  assert.deepEqual(findDryQueries({ queries: { q: { history: [{ cards: 0 }, { cards: 0 }] } } }, 2), ['q']);
});
