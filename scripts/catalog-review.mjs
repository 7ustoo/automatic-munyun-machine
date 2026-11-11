import { readCatalog, updateCatalog, catalogJobState, readCatalogDescription, saveCatalogDescription } from './job-catalog.mjs';

// Every completed description and decision is durable before the next API batch.
// Dependencies are injected so interrupted runs can be tested without a browser/API.
export async function reviewCatalog({ file, directory, runId, context, loadDescription, score, review, exclusions, reuse = true, onProgress = () => {} }) {
  let snapshot = readCatalog(file);
  const run = snapshot.runs.find(r => r.id === runId);
  const ids = run.resume ? Object.keys(snapshot.jobs) : run.ids;
  await updateCatalog(file, c => { const r = c.runs.find(r => r.id === runId); r.status = 'reviewing'; if (r.resume) r.ids = ids; });
  let batch = [], failed = false;
  const flush = async () => {
    if (!batch.length) return;
    await review(batch);
    await updateCatalog(file, c => {
      const active = c.runs.find(r => r.id === runId);
      for (const row of batch) {
        const job = c.jobs[row.id];
        if (row.aiPct == null) { failed = true; continue; }
        if (!job || job.descriptionHash !== row.descriptionHash) continue;
        const decision = { context, descriptionHash: job.descriptionHash, at: new Date().toISOString(),
          matchPct: row.matchPct, aiPct: row.aiPct, kwPct: row.kwPct, reason: row.aiReason,
          score: row.score ?? 0, salaryK: row.salaryK ?? null, aiSub: row.aiSub || null, jdPct: row.kwPct,
          matched: row.matched || [], missing: row.missing || [], exclusions: exclusions(row) };
        job.reviewHistory ||= [];
        if (job.review) job.reviewHistory.push(job.review);
        job.review = decision;
        if (job.forceReviewAt === row.forceReviewAt) job.forceReview = false;
        active.reviewedIds = [...new Set([...active.reviewedIds, row.id])];
      }
    });
    batch = [];
    onProgress();
    if (failed) throw new Error('Smart Match could not finish this review. Completed decisions are saved; continue to retry the remaining jobs.');
  };
  try {
    for (let id of ids) {
      snapshot = readCatalog(file);
      if (snapshot.paused) { await flush(); break; }
      let job = snapshot.jobs[id];
      if (!job || job.appliedAt || job.override === 'excluded') continue;
      if (reuse && catalogJobState(job, context) !== 'awaiting') {
        await updateCatalog(file, c => { c.runs.find(r => r.id === runId).reusedIds.push(id); });
        continue;
      }
      let text = readCatalogDescription(directory, id);
      if (!text || job.needsDescription) {
        try {
          const loaded = await loadDescription(job);
          if (!loaded?.jdText || loaded.descriptionQuality === 'summary') throw new Error('Full description unavailable; continue to retry.');
          id = await saveCatalogDescription(file, directory, job, loaded.jdText, loaded.directUrl) || id;
          text = loaded.jdText;
        } catch (error) {
          await updateCatalog(file, c => { c.jobs[id].descriptionError = String(error.message).slice(0, 180); });
          continue;
        }
      }
      job = readCatalog(file).jobs[id];
      if (reuse && !job.forceReview && job.review?.context === context && job.review.descriptionHash === job.descriptionHash) {
        await updateCatalog(file, c => { c.runs.find(r => r.id === runId).reusedIds.push(id); });
        continue;
      }
      batch.push({ ...job, ...score(job, text), __jd: text, descriptionHash: job.descriptionHash });
      if (batch.length === 20) await flush();
    }
    await flush();
    await updateCatalog(file, c => {
      const current = c.runs.find(r => r.id === runId);
      const pending = ids.filter(id => c.jobs[id] && catalogJobState(c.jobs[id], context) === 'awaiting').length;
      current.status = c.paused ? 'paused' : pending ? 'pending' : 'complete';
      current.finishedAt = new Date().toISOString();
    });
  } catch (error) {
    await updateCatalog(file, c => {
      const current = c.runs.find(r => r.id === runId);
      current.status = 'interrupted'; current.error = String(error.message).slice(0, 240);
    });
    throw error;
  }
  return readCatalog(file);
}
