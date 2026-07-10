import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitCmd, nodeCmd, npmCmd, taskName } from '../os-paths.mjs';

test('runtime command resolvers return usable shapes without throwing', () => {
  assert.equal(typeof nodeCmd(), 'string');
  assert.equal(typeof npmCmd(), 'string');
  const git = gitCmd();
  assert.ok(git === null || typeof git === 'string');
});

test('scheduler abstraction resolves every logical AMM task', () => {
  for (const logical of ['bot', 'daily', 'watchdog', 'batch-missed']) {
    assert.equal(typeof taskName(logical), 'string');
    assert.ok(taskName(logical).length > 0);
  }
});
