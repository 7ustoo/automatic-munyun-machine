/**
 * Requirement-aware resume matcher.
 *
 * The legacy scorer rewards every repeated resume keyword in a posting. That
 * is useful for recall, but long descriptions saturate near 100%. This module
 * instead asks a bounded question: of the concrete requirements mentioned by
 * the job, how many appear in the candidate's resume, and does the job title
 * belong to a role the candidate is actually targeting?
 */

import { termRegex } from './term-match.mjs';

const CATEGORY_WEIGHT = { titles: 4, certs: 3, skills: 1, compliance: 1.5 };
const TITLE_STOP = new Set([
  'senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'associate',
  'entry', 'level', 'i', 'ii', 'iii', 'iv', 'the', 'a', 'an', 'and', 'of',
]);
const REQUIRED_RX = /\b(required|must|minimum|need(?:ed)?|qualification|you have|at least)\b/i;
const PREFERRED_RX = /\b(preferred|nice to have|bonus|ideally|desired|plus)\b/i;

function cleanTerm(term) {
  return String(term || '').trim();
}

function titleTokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9+#.]+/g)
    ?.filter(t => t.length > 1 && !TITLE_STOP.has(t)) || []);
}

function overlapScore(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return Math.round(100 * shared / Math.max(a.size, b.size));
}

export function roleFitPercent(jobTitle, candidateTitles = [], targetTerms = []) {
  const title = String(jobTitle || '').trim();
  if (!title) return 0;
  const lower = title.toLowerCase();
  const jobTokens = titleTokens(title);
  let best = 0;
  for (const candidate of [...candidateTitles, ...targetTerms]) {
    const value = cleanTerm(candidate).toLowerCase();
    if (!value) continue;
    if (lower === value) best = Math.max(best, 100);
    else if (lower.includes(value) || value.includes(lower)) best = Math.max(best, 92);
    else best = Math.max(best, overlapScore(jobTokens, titleTokens(value)));
  }
  return best;
}

export function buildRequirementCatalog(dictionary = {}) {
  const seen = new Set();
  const out = [];
  for (const category of ['titles', 'certs', 'skills', 'compliance']) {
    for (const raw of dictionary[category] || []) {
      const term = cleanTerm(raw);
      const key = term.toLowerCase();
      if (!term || seen.has(key)) continue;
      seen.add(key);
      out.push({ term, key, category, weight: CATEGORY_WEIGHT[category] || 1 });
    }
  }
  // Longer phrases claim overlapping text before their shorter aliases.
  return out.sort((a, b) => b.term.length - a.term.length);
}

function requirementContext(text, index, length) {
  const around = text.slice(Math.max(0, index - 110), Math.min(text.length, index + length + 110));
  if (REQUIRED_RX.test(around)) return 'required';
  if (PREFERRED_RX.test(around)) return 'preferred';
  return 'stated';
}

export function extractRequirements(text, dictionary, { mutedTerms = [] } = {}) {
  const body = String(text || '');
  const muted = new Set(mutedTerms.map(t => String(t).toLowerCase()));
  const requirements = [];
  const claimed = [];
  for (const item of buildRequirementCatalog(dictionary)) {
    if (muted.has(item.key)) continue;
    const match = termRegex(item.term, 'i').exec(body);
    if (!match) continue;
    const start = match.index;
    const end = start + match[0].length;
    // Do not count "Microsoft Entra ID" and the nested "Entra ID" as two
    // separate requirements when they point at the same words.
    if (claimed.some(span => start >= span.start && end <= span.end)) continue;
    claimed.push({ start, end });
    const context = requirementContext(body, start, match[0].length);
    const multiplier = context === 'required' ? 1.35 : context === 'preferred' ? 0.75 : 1;
    requirements.push({ ...item, context, weighted: item.weight * multiplier });
  }
  return requirements;
}

export function matchRequirements({
  jobTitle = '',
  text = '',
  cv = {},
  dictionary = {},
  targetTerms = [],
  mutedTerms = [],
  fallbackPercent = 0,
} = {}) {
  const resumeTerms = new Set([
    ...(cv.titles || []), ...(cv.certs || []), ...(cv.skills || []), ...(cv.compliance || []),
  ].map(t => String(t).toLowerCase()));
  const requirements = extractRequirements(`${jobTitle}\n${text}`, dictionary, { mutedTerms });
  // Titles are evaluated separately by roleFitPercent. Counting the title in
  // requirement coverage would double-reward an exact title and punish valid
  // synonyms (for example IAM Engineer vs Identity Engineer).
  const concreteRequirements = requirements.filter(r => r.category !== 'titles');
  const rolePct = roleFitPercent(jobTitle, cv.titles || [], targetTerms);
  let totalWeight = 0;
  let matchedWeight = 0;
  const matched = [];
  const missing = [];
  for (const req of concreteRequirements) {
    totalWeight += req.weighted;
    if (resumeTerms.has(req.key)) {
      matchedWeight += req.weighted;
      matched.push(req.term);
    } else {
      missing.push(req);
    }
  }

  const coveragePct = totalWeight ? Math.round(100 * matchedWeight / totalWeight) : 0;
  const confidencePct = Math.min(100, concreteRequirements.length * 9);
  let matchPct;
  if (concreteRequirements.length) {
    matchPct = Math.round(coveragePct * 0.65 + rolePct * 0.25 + confidencePct * 0.10);
  } else {
    // Sparse cards still need to reach the description pass. Keep the old
    // lexical score as a small recall signal, never as the final authority.
    matchPct = Math.round(rolePct * 0.70 + Math.min(75, fallbackPercent) * 0.30);
  }

  // A clearly unrelated title cannot become a strong match on body keywords.
  if (rolePct < 25) matchPct = Math.min(matchPct, 49);
  // A certification explicitly called required is a real gap, not something
  // twenty unrelated skills should wash away.
  if (missing.some(r => r.category === 'certs' && r.context === 'required')) {
    matchPct = Math.min(matchPct, 69);
  }

  return {
    matchPct: Math.max(0, Math.min(99, matchPct)),
    coveragePct,
    rolePct,
    confidencePct,
    requirementCount: concreteRequirements.length,
    matched: matched.slice(0, 20),
    missing: missing
      .sort((a, b) => b.weighted - a.weighted)
      .slice(0, 8)
      .map(r => r.term),
  };
}
