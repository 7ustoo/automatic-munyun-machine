import { readCatalog, updateCatalog, catalogJobState, readCatalogDescription, saveCatalogDescriptions } from './job-catalog.mjs';

// Bounded pools overlap website reads with AI requests. Completed decisions are
// checkpointed independently, even if another in-flight batch fails or pauses.
export async function reviewCatalog({ file, directory, runId, context, loadDescription, score, review, exclusions,
  reuse = true, onProgress = () => {}, descriptionConcurrency = 4, reviewConcurrency = 3, batchSize = 40 }) {
  const limit = (value, fallback, max) => Math.max(1, Math.min(max, Math.floor(Number(value)) || fallback));
  descriptionConcurrency = limit(descriptionConcurrency, 4, 8);
  reviewConcurrency = limit(reviewConcurrency, 3, 4);
  batchSize = limit(batchSize, 40, 100);
  let snapshot = readCatalog(file);
  const run = snapshot.runs.find(r => r.id === runId);
  if (!run) throw new Error('Saved review run is missing.');
  const ids = [...new Set(run.resume ? Object.keys(snapshot.jobs) : run.ids)];
  // A broken link must never hold up jobs whose descriptions are already here.
  ids.sort((a, b) => Number(!snapshot.jobs[a]?.descriptionHash || snapshot.jobs[a]?.needsDescription)
    - Number(!snapshot.jobs[b]?.descriptionHash || snapshot.jobs[b]?.needsDescription));
  const progress = { total: ids.length, checked: 0, descriptionErrors: 0, activeDescriptions: 0, activeReviews: 0 };
  const inFlight = new Set(), scheduled = new Set();
  let failure, stopped = snapshot.paused;
  const pulse = async () => {
    await updateCatalog(file, c => {
      stopped ||= c.paused;
      const active = c.runs.find(r => r.id === runId);
      active.heartbeatAt = new Date().toISOString();
      active.progress = { ...progress, reviewed: active.reviewedIds.length, reused: active.reusedIds.length };
    });
  };
  await updateCatalog(file, c => {
    const active = c.runs.find(r => r.id === runId);
    Object.assign(active, { status: 'reviewing', workerPid: process.pid, error: '', heartbeatAt: new Date().toISOString() });
    delete active.finishedAt;
    if (active.resume) active.ids = ids;
  });
  // Keep long API requests visibly alive; drain heartbeat writes before finish.
  let heartbeatWrite;
  const heartbeat = setInterval(() => {
    if (!heartbeatWrite) heartbeatWrite = pulse().catch(error => { failure ||= error; }).finally(() => { heartbeatWrite = null; });
  }, 5000);
  heartbeat.unref?.();

  const prepare = async (id, job) => {
    if (failure || stopped) return null;
    if (!job || job.appliedAt || job.override === 'excluded') { progress.checked++; return null; }
    if (reuse && catalogJobState(job, context) !== 'awaiting') {
      progress.checked++; return { id, reused: true };
    }
    let text = readCatalogDescription(directory, id), loaded;
    if (!text || job.needsDescription) {
      progress.activeDescriptions++;
      try {
        loaded = await loadDescription(job);
        if (!loaded?.jdText || loaded.descriptionQuality === 'summary') throw new Error('Full description unavailable; continue to retry.');
        text = loaded.jdText;
      } catch (error) {
        progress.descriptionErrors++; progress.checked++;
        // A dead shared browser is an infrastructure failure, not thousands
        // of independent unavailable job descriptions.
        if (error.code === 'DESCRIPTION_WORKER_FAILED') throw error;
        return { id, error: String(error.message).slice(0, 180) };
      } finally { progress.activeDescriptions--; }
    }
    progress.checked++;
    return { id, job, text, loaded };
  };

  const flush = async batch => {
    progress.activeReviews++;
    let batchError;
    try { await review(batch); } catch (error) { batchError = error; }
    try {
      await updateCatalog(file, c => {
        const active = c.runs.find(r => r.id === runId);
        for (const row of batch) {
          const job = c.jobs[row.id];
          if (row.aiPct == null) { batchError ||= new Error('Smart Match could not finish this review. Completed decisions are saved; continue to retry the remaining jobs.'); continue; }
          if (!job || job.appliedAt || job.override === 'excluded' || job.descriptionHash !== row.descriptionHash) continue;
          const decision = { context, descriptionHash: job.descriptionHash, at: new Date().toISOString(),
            matchPct: row.matchPct, aiPct: row.aiPct, kwPct: row.kwPct, reason: row.aiReason,
            score: row.score ?? 0, salaryK: row.salaryK ?? null, aiSub: row.aiSub || null, jdPct: row.kwPct,
            matched: row.matched || [], missing: row.missing || [], exclusions: exclusions(row) };
          job.reviewHistory ||= [];
          if (job.review) job.reviewHistory.push(job.review);
          job.review = decision;
          if (job.forceReviewAt === row.forceReviewAt) job.forceReview = false;
          if (!active.reviewedIds.includes(row.id)) active.reviewedIds.push(row.id);
        }
      });
      if (batchError) throw batchError;
    } finally {
      progress.activeReviews--;
      await pulse();
      await onProgress({ ...progress });
    }
  };

  try {
    // Pack successful jobs across preparation windows. Previously a window
    // with 39 failed links sent a one-job AI request, repeating that overhead.
    let pending = [];
    const dispatch = async final => {
      while (pending.length && (final || pending.length >= batchSize) && !failure && !stopped) {
        if (inFlight.size >= reviewConcurrency) await Promise.race(inFlight);
        if (failure || stopped) break;
        const batch = pending.splice(0, batchSize);
        let task;
        task = flush(batch).catch(error => { failure ||= error; }).finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    };
    for (let offset = 0; offset < ids.length && !failure && !stopped; offset += batchSize) {
      snapshot = readCatalog(file);
      if (snapshot.paused) { stopped = true; break; }
      const window = ids.slice(offset, offset + batchSize), ready = new Array(window.length);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(descriptionConcurrency, window.length) }, async () => {
        while (cursor < window.length && !failure && !stopped) {
          const index = cursor++;
          try { ready[index] = await prepare(window[index], snapshot.jobs[window[index]]); }
          catch (error) { failure ||= error; }
        }
      }));
      const prepared = ready.filter(Boolean);
      const saved = await saveCatalogDescriptions(file, directory,
        prepared.filter(r => r.loaded).map(r => ({ job: r.job, ...r.loaded })), c => {
          const active = c.runs.find(r => r.id === runId);
          for (const row of prepared) {
            if (row.error && c.jobs[row.id]) c.jobs[row.id].descriptionError = row.error;
            if (row.reused && !active.reusedIds.includes(row.id)) active.reusedIds.push(row.id);
          }
        });
      const current = readCatalog(file);
      const reused = [];
      for (const row of prepared) {
        if (row.reused || row.error || (row.loaded && !saved[row.id])) continue;
        const id = saved[row.id] || row.id, job = current.jobs[id];
        if (!job || job.appliedAt || job.override === 'excluded' || scheduled.has(id)) continue;
        if (reuse && !job.forceReview && job.review?.context === context && job.review.descriptionHash === job.descriptionHash) {
          reused.push(id); continue;
        }
        scheduled.add(id);
        pending.push({ ...job, ...score(job, row.text), __jd: row.text, descriptionHash: job.descriptionHash });
      }
      if (reused.length) await updateCatalog(file, c => {
        const active = c.runs.find(r => r.id === runId);
        active.reusedIds = [...new Set([...active.reusedIds, ...reused])];
      });
      await dispatch(false);
      await pulse();
    }
    await dispatch(true);
  } catch (error) { failure ||= error; }
  finally {
    await Promise.all(inFlight);
    clearInterval(heartbeat);
    await heartbeatWrite;
  }
  await updateCatalog(file, c => {
    const current = c.runs.find(r => r.id === runId);
    const pending = current.ids.filter(id => c.jobs[id] && catalogJobState(c.jobs[id], context) === 'awaiting').length;
    if (failure?.code === 'SUBSCRIPTION_LIMIT') c.paused = true;
    current.status = failure?.code === 'SUBSCRIPTION_LIMIT' || c.paused ? 'paused' : failure ? 'interrupted' : pending ? 'pending' : 'complete';
    current.error = failure ? String(failure.message).slice(0, 240) : '';
    current.finishedAt = current.heartbeatAt = new Date().toISOString();
    current.progress = { ...progress, reviewed: current.reviewedIds.length, reused: current.reusedIds.length };
  });
  if (failure) throw failure;
  return readCatalog(file);
}
