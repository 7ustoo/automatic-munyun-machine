// v4.3: pins the pure helpers in email.mjs — the email-to-VA delivery channel.
// No network / no SMTP here; sending is exercised end-to-end manually (needs a
// real Gmail app password). These guard the credential gate, the scrubber (so
// an app password can never reach a log/response), and the subject template.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emailConfigured, isEmailAddress, emailScrub, renderSubject, friendlyError
} from '../email.mjs';

test('emailConfigured requires a well-formed Gmail address + a password', () => {
  assert.equal(emailConfigured({ SMTP_USER: 'me@gmail.com', SMTP_APP_PASSWORD: 'abcd efgh ijkl mnop' }), true);
  assert.equal(emailConfigured({ SMTP_USER: 'me@gmail.com', SMTP_APP_PASSWORD: '' }), false);
  assert.equal(emailConfigured({ SMTP_USER: '', SMTP_APP_PASSWORD: 'x' }), false);
  assert.equal(emailConfigured({ SMTP_USER: 'not-an-email', SMTP_APP_PASSWORD: 'x' }), false);
  assert.equal(emailConfigured({}), false);
  assert.equal(emailConfigured(), false);
  // whitespace-only is not configured
  assert.equal(emailConfigured({ SMTP_USER: '  ', SMTP_APP_PASSWORD: '  ' }), false);
});

test('isEmailAddress accepts real addresses, rejects junk', () => {
  for (const ok of ['a@b.co', 'assistant@example.com', 'x.y+z@sub.domain.io']) assert.equal(isEmailAddress(ok), true, ok);
  for (const bad of ['', 'plain', 'a@b', 'a b@c.com', '@no.com', 'no@', null, undefined]) assert.equal(isEmailAddress(bad), false, String(bad));
});

test('emailScrub removes the app password from any string', () => {
  const pass = 'abcd efgh ijkl mnop';
  const leaked = `SMTP auth failed for user with pass ${pass} at line 3`;
  const clean = emailScrub(leaked, pass);
  assert.ok(!clean.includes(pass), 'password must not survive scrubbing');
  assert.ok(clean.includes('<APP_PASSWORD>'));
  // no password given → passthrough, never throws
  assert.equal(emailScrub('hello', ''), 'hello');
  assert.equal(emailScrub(null, 'x'), '');
});

test('renderSubject expands {DATE} and falls back sanely', () => {
  assert.equal(renderSubject('Job batch — {DATE}', '2026-07-10'), 'Job batch — 2026-07-10');
  assert.equal(renderSubject('Daily jobs', '2026-07-10'), 'Daily jobs');
  assert.equal(renderSubject('', '2026-07-10'), 'Job batch — 2026-07-10');
  assert.equal(renderSubject('{DATE}', ''), 'Job batch'); // empty after expand → safe default
  assert.equal(renderSubject(undefined, undefined), 'Job batch —'); // default template, trimmed
});

test('friendlyError maps the common SMTP failures to actionable text', () => {
  assert.match(friendlyError({ code: 'EAUTH' }), /App Password/i);
  assert.match(friendlyError({ responseCode: 535 }), /App Password/i);
  assert.match(friendlyError({ code: 'EENVELOPE' }), /recipient/i);
  assert.match(friendlyError({ code: 'ETIMEDOUT' }), /internet|reach/i);
  // unknown errors pass their message through
  assert.match(friendlyError({ message: 'weird failure xyz' }), /weird failure xyz/);
});
