#!/usr/bin/env node
/**
 * v4.0: optional AI rerank for the daily batch ("Smart match").
 *
 * One batched call to the Claude API scores the top keyword-ranked candidates
 * against a summary of the user's CV, returning fit (0-100) + a one-line
 * reason per job. daily-batch blends this with the keyword score.
 *
 * Design constraints (AMM conventions):
 *  - Raw fetch, zero new deps (Node >= 18 global fetch, same as telegram-bot).
 *  - Fail-open: ANY error throws; the caller logs and keeps keyword ranks.
 *  - The API key must never be logged — it travels in the header only, and
 *    error messages thrown from here never embed it.
 *  - Structured output via output_config.format (json_schema) so the reply
 *    is guaranteed-parseable JSON — no prose to strip.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_AI_MODEL = 'claude-opus-4-8';

export function candidateBatches(candidates, size = 40) {
  const safeSize = Math.max(1, Math.min(100, Number(size) || 40));
  const out = [];
  for (let i = 0; i < (candidates || []).length; i += safeSize) {
    out.push(candidates.slice(i, i + safeSize));
  }
  return out;
}

// Strict schema: {ratings:[{n,fit,reason,skills,seniority,role}]}.
// v7.0: rubric subscores force the model to decompose the judgment (skills
// coverage / seniority match / role family) before committing to an overall
// fit — measurably more accurate than one opaque number, and the Why panel
// can show the breakdown. additionalProperties:false is required by the API
// on every object. Exported for testability.
export const RATINGS_SCHEMA = {
  type: 'object',
  properties: {
    ratings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          fit: { type: 'integer' },
          reason: { type: 'string' },
          skills: { type: 'integer' },
          seniority: { type: 'integer' },
          role: { type: 'integer' },
        },
        required: ['n', 'fit', 'reason', 'skills', 'seniority', 'role'],
        additionalProperties: false,
      },
    },
  },
  required: ['ratings'],
  additionalProperties: false,
};

export function buildPrompt(cvSummary, candidates) {
  // v7.0: when the parser's raw resume text is available, the model reads the
  // ACTUAL resume — experience, tenure, seniority — not just a keyword list.
  // Keywords ride along as a supplement either way.
  const { resumeText, ...keywords } = cvSummary || {};
  const parts = ['You are an expert recruiter scoring job postings for fit against one candidate.'];
  if (resumeText) {
    parts.push(
      'Candidate resume (verbatim; may be truncated):',
      resumeText,
      '',
      'Keyword profile extracted from the resume (supplemental):',
      JSON.stringify(keywords),
    );
  } else {
    parts.push('Resume summary (extracted keywords):', JSON.stringify(keywords));
  }
  parts.push(
    '',
    'For EACH job below, score these 0-100 integers:',
    '- skills: how well the candidate\'s demonstrated tools, skills, and experience cover the job\'s stated requirements',
    '- seniority: how well the candidate\'s level and years match what the job asks (penalize a big over- or under-shoot)',
    '- role: whether this is the candidate\'s role family at all (wrong family scores low no matter the keyword overlap)',
    'Then output overall fit 0-100 (weigh skills heaviest, then role, then seniority) and a reason under 140 characters written to the candidate ("Strong: X. Gap: Y.").',
    'Judge from what the resume actually demonstrates, not keyword overlap alone.',
    'Jobs:',
    JSON.stringify(candidates),
  );
  return parts.join('\n');
}

/**
 * @param {{apiKey:string, model?:string, cvSummary:object, candidates:Array<{n:number,title:string,company:string,text:string}>}} opts
 * @returns {Promise<Array<{n:number,fit:number,reason:string}>>}
 */
export async function aiRerank({ apiKey, model = DEFAULT_AI_MODEL, cvSummary, candidates }) {
  if (!apiKey) throw new Error('no API key configured');
  if (!candidates?.length) return [];

  const body = JSON.stringify({
    model,
    max_tokens: 8000,
    output_config: { format: { type: 'json_schema', schema: RATINGS_SCHEMA } },
    messages: [{ role: 'user', content: buildPrompt(cvSummary, candidates) }],
  });

  // One retry on retryable statuses / network errors — this runs inside the
  // (long) daily batch, so a transient 529 shouldn't cost the user the rerank.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        let detail = 'HTTP ' + res.status;
        try { const j = await res.json(); detail += ': ' + (j.error?.message || j.error?.type || ''); } catch {}
        if ([429, 500, 529].includes(res.status) && attempt === 0) {
          lastErr = new Error(detail);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        throw new Error(detail); // 401 → bad key; 400 → bad request; surfaced (scrubbed) in the batch log
      }
      const data = await res.json();
      if (data.stop_reason === 'refusal') throw new Error('model declined the request');
      if (data.stop_reason === 'max_tokens') throw new Error('response truncated (max_tokens)');
      const text = (data.content || []).find(b => b.type === 'text')?.text || '';
      const parsed = JSON.parse(text); // guaranteed-schema JSON via output_config.format
      return (parsed.ratings || []).filter(r => Number.isInteger(r.n));
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && /fetch failed|timeout|aborted/i.test(String(e.message))) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}
