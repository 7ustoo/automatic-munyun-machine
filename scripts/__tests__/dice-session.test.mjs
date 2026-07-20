import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DICE_AUTH_CACHE, writeDiceAuthCache, readDiceAuthCache, isDiceSignedIn } from '../dice-session.mjs';

// The probe itself needs a browser; its DECISION logic is a pure function of
// the landed URL, so exercise it with a fake Playwright page.
function fakePage(finalUrl) {
  return {
    goto: async () => {},
    waitForTimeout: async () => {},
    url: () => finalUrl
  };
}

test('isDiceSignedIn: login redirect → signed out', async () => {
  assert.equal(await isDiceSignedIn(fakePage('https://www.dice.com/dashboard/login?redirectUrl=%2Fhome-feed')), false);
});

test('isDiceSignedIn: home-feed survives → signed in', async () => {
  assert.equal(await isDiceSignedIn(fakePage('https://www.dice.com/home-feed')), true);
});

test('auth cache round-trip and unknown state', () => {
  const had = fs.existsSync(DICE_AUTH_CACHE) ? fs.readFileSync(DICE_AUTH_CACHE, 'utf8') : null;
  try {
    writeDiceAuthCache(true);
    let c = readDiceAuthCache();
    assert.equal(c.authed, true);
    assert.ok(c.checkedAt);
    writeDiceAuthCache(false);
    c = readDiceAuthCache();
    assert.equal(c.authed, false);
    fs.rmSync(DICE_AUTH_CACHE, { force: true });
    c = readDiceAuthCache();
    assert.equal(c.authed, null, 'missing cache reads as unknown, not signed-out');
  } finally {
    if (had !== null) fs.writeFileSync(DICE_AUTH_CACHE, had);
    else fs.rmSync(DICE_AUTH_CACHE, { force: true });
  }
});
