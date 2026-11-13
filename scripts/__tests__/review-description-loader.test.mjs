import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReviewDescriptionLoader } from '../review-description-loader.mjs';

const job = { href: 'https://hiringcafe.com/job/one', directUrl: 'https://jobs.example.com/one' };
const full = { jdText: 'Full Linux engineer responsibilities and requirements.', descriptionQuality: 'full' };
const pacer = { wait: async () => {}, pause: () => {} };
const page = () => ({ close: async () => {} });

test('concurrent reads share initialization and replace a closed description context', async () => {
  let opens = 0;
  const contexts = [];
  const load = createReviewDescriptionLoader({ pacer, openContext: async () => {
    const ctx = new EventEmitter(), generation = ++opens;
    ctx.newPage = async () => { if (generation === 1) throw new Error('browserContext.newPage: Target page, context or browser has been closed'); return page(); };
    ctx.close = async () => ctx.emit('close'); contexts.push(ctx); return ctx;
  }, read: async () => full, employerLoader: async () => assert.fail('Recovered source should supply its description') });
  const results = await Promise.all([load(job), load(job), load(job)]);
  assert.equal(opens, 2); assert.ok(results.every(r => r.jdText === full.jdText));
  await load.close();
});

test('unavailable source descriptions can use the direct employer while fresh full cache avoids both', async () => {
  let employers = 0;
  const ctx = { newPage: async () => page(), close: async () => {} };
  const load = createReviewDescriptionLoader({ pacer, openContext: async () => ctx,
    read: async () => { throw new Error('HTTP 403'); }, employerLoader: async () => { employers++; return full; },
    cache: { 'https://hiringcafe.com/job/cached': { ...full, at: Date.now() } } });
  assert.equal((await load(job)).jdText, full.jdText); assert.equal(employers, 1);
  await load({ ...job, href: 'https://hiringcafe.com/job/cached' }); assert.equal(employers, 1);
  await load.close();
});

test('repeated browser crashes stop as an infrastructure failure instead of poisoning remaining jobs', async () => {
  const load = createReviewDescriptionLoader({ pacer, maxRestarts: 0, openContext: async () => ({
    newPage: async () => { throw new Error('browser context has been closed'); }, close: async () => {} }),
    employerLoader: async () => full });
  await assert.rejects(() => load(job), error => error.code === 'DESCRIPTION_WORKER_FAILED');
  await load.close();
});

test('a source cooldown sends other jobs to employers instead of sleeping the entire queue',async()=>{
 let sourceReads=0,employers=0;
 const load=createReviewDescriptionLoader({pacer:{wait:async()=>{},pause:()=>assert.fail('Cooldown must not block all workers')},
  openContext:async()=>({newPage:async()=>page(),close:async()=>{}}),
  read:async(_page,_href,{beforeRequest,onThrottle})=>{await beforeRequest();sourceReads++;onThrottle(60000);throw new Error('HTTP 429');},
  employerLoader:async()=>{employers++;return full;}});
 await load(job);await load({...job,href:'https://hiringcafe.com/job/two'});
 assert.equal(sourceReads,1);assert.equal(employers,2);await load.close();
});
