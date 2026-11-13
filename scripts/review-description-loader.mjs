import { readHiringCafeDescription } from './hcafe-descriptions.mjs';
import { createRequestPacer } from './hcafe-apply-links.mjs';
import { employerBoardPosting } from './employer-description.mjs';

const closedBrowser = error => /browser.*closed|context.*closed|target.*closed|has been closed|browser.*disconnected/i.test(String(error?.message));

// One shared launch per generation. If Chrome exits, replace the dead context;
// never keep handing the same rejected/closed context to thousands of jobs.
export function createReviewDescriptionLoader({ openContext, employerLoader, cache = {},
  read = readHiringCafeDescription, pacer = createRequestPacer({ intervalMs: 1200 }), maxRestarts = 2 }) {
  let opening, generation = 0, closing = false, sourceBlockedUntil = 0;
  const contexts = new Set();
  const context = async () => {
    if (!opening) {
      if (generation > maxRestarts) throw Object.assign(new Error('The description browser stopped repeatedly. Completed work is saved; continue to retry.'), { code: 'DESCRIPTION_WORKER_FAILED' });
      generation++;
      const pending = Promise.resolve().then(openContext);
      opening = pending;
      pending.then(ctx => {
        contexts.add(ctx);
        ctx.on?.('close', () => { contexts.delete(ctx); if (opening === pending) opening = null; });
      }, () => { if (opening === pending) opening = null; });
    }
    return opening;
  };
  const load = async job => {
    const cached = cache[job.href];
    if (cached?.jdText && cached.descriptionQuality === 'full' && Date.now() - cached.at < 86400000) return cached;
    if (!job.href) return employerLoader(job);
    if (employerBoardPosting(job.directUrl, job.sourceId)) return employerLoader(job);
    if (Date.now() < sourceBlockedUntil && job.directUrl) return employerLoader(job);
    let lastError;
    for (let attempt = 0; attempt < 2 && !closing; attempt++) {
      let ctx, page;
      try {
        ctx = await context();
        page = await ctx.newPage();
        return await read(page, job.href, { beforeRequest: async()=>{
          await pacer.wait();
          if(Date.now()<sourceBlockedUntil)throw new Error('HiringCafe is cooling down; trying the employer instead.');
        }, onThrottle: ms=>{sourceBlockedUntil=Math.max(sourceBlockedUntil,Date.now()+ms);} });
      } catch (error) {
        lastError = error;
        if (error.code === 'DESCRIPTION_WORKER_FAILED') throw error;
        if (!closedBrowser(error)) break;
        // Clear only the generation that actually failed. Another worker may
        // already have started its replacement.
        const current = opening;
        if (current && await current.catch(() => null) === ctx) opening = null;
      } finally { await page?.close().catch(() => {}); }
    }
    // A blocked HiringCafe page need not prevent a direct employer read.
    if (job.directUrl) return employerLoader(job);
    throw lastError || new Error('Description loading stopped.');
  };
  load.close = async () => {
    closing = true;
    await opening?.catch(() => {});
    await Promise.all([...contexts].map(ctx => ctx.close().catch(() => {})));
    opening = null;
    await employerLoader.close?.();
  };
  return load;
}
