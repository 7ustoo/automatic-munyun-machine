// v4.3: pins dedupMode (hcafe-session.mjs) — the single branch that decides
// which seen-job dedup is in effect. The batch Telegram message, the
// jobs(date).txt header, and /diagnose all render this decision with their own
// wording; they route through dedupMode so they can never disagree (the review
// that shipped v4.3 found the old parallel ternaries conflating "signed out",
// "probe skipped by the accountDedup knob", and "sign-in unknown" — each of
// which must NOT nag a signed-in user to sign in).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupMode } from '../hcafe-session.mjs';

test('signed in + enabled → account (syncs across computers)', () => {
  assert.equal(dedupMode({ authed: true, enabled: true }), 'account');
  assert.equal(dedupMode({ authed: true }), 'account'); // enabled defaults on
});

test('knob off wins over sign-in state → local-disabled, never a sign-in nag', () => {
  assert.equal(dedupMode({ authed: true, enabled: false }), 'local-disabled');
  assert.equal(dedupMode({ authed: false, enabled: false }), 'local-disabled');
  assert.equal(dedupMode({ authed: null, enabled: false }), 'local-disabled');
});

test('confirmed signed out (enabled) → signed-out', () => {
  assert.equal(dedupMode({ authed: false, enabled: true }), 'signed-out');
  assert.equal(dedupMode({ authed: false }), 'signed-out');
});

test('unknown sign-in state (null/undefined cache) → unknown, distinct from signed-out', () => {
  assert.equal(dedupMode({ authed: null, enabled: true }), 'unknown');
  assert.equal(dedupMode({ authed: undefined, enabled: true }), 'unknown');
  assert.equal(dedupMode({}), 'unknown');
  assert.equal(dedupMode(), 'unknown');
});
