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
const STRICT_YEARS_RX = /\b(?:(?:at least|minimum(?: of)?|must have|requires?)\s+(\d{1,2})\+?\s+years?|(?:(\d{1,2})\+?\s+years?(?:\s+of\s+experience)?\s+(?:is\s+)?(?:required|minimum)))\b/i;

// Controlled equivalence groups understand standard industry abbreviations
// without the false positives caused by broad edit-distance matching.
const TERM_EQUIVALENCE_GROUPS = [
  ['sso', 'single sign-on', 'single sign on', 'single signon'],
  ['oidc', 'openid connect', 'open id connect'],
  ['mfa', 'multi-factor authentication', 'multifactor authentication', 'multi factor authentication'],
  ['2fa', 'two-factor authentication', 'two factor authentication'],
  ['m365', 'microsoft 365', 'office 365', 'o365'],
  ['microsoft entra id', 'entra id', 'azure ad', 'azure active directory'],
  ['rbac', 'role-based access control', 'role based access control'],
  ['abac', 'attribute-based access control', 'attribute based access control'],
  ['saml', 'saml 2.0', 'security assertion markup language'],
  ['scim', 'system for cross-domain identity management'],
  ['iam', 'identity and access management'],
  ['iga', 'identity governance and administration'],
  ['pam', 'privileged access management'],
  ['jml', 'joiner-mover-leaver', 'joiner mover leaver'],
  ['sspr', 'self-service password reset', 'self service password reset'],
  ['pim', 'privileged identity management'],
  ['ci/cd', 'cicd', 'continuous integration and continuous delivery', 'continuous integration continuous delivery'],
  ['k8s', 'kubernetes'],
];

function surfaceKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\u2010-\u2015_/.\\-]+/g, ' ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const TERM_EQUIVALENCE = new Map();
const TERM_VARIANTS = new Map();
for (const group of TERM_EQUIVALENCE_GROUPS) {
  const concept = surfaceKey(group[0]);
  TERM_VARIANTS.set(concept, [...group]);
  for (const term of group) TERM_EQUIVALENCE.set(surfaceKey(term), concept);
}

export function canonicalTerm(term) {
  const surface = surfaceKey(term);
  return TERM_EQUIVALENCE.get(surface) || surface;
}

export function equivalentTerms(term) {
  const raw = cleanTerm(term);
  const variants = TERM_VARIANTS.get(canonicalTerm(raw)) || [];
  return [...new Set([raw, ...variants].filter(Boolean))];
}

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
      out.push({ term, key, concept: canonicalTerm(term), category, weight: CATEGORY_WEIGHT[category] || 1 });
    }
  }
  // Longer phrases claim overlapping text before their shorter aliases.
  return out.sort((a, b) => b.term.length - a.term.length);
}

function requirementContext(text, index, length) {
  const left = Math.max(
    text.lastIndexOf('.', index - 1), text.lastIndexOf(';', index - 1),
    text.lastIndexOf('\n', index - 1), text.lastIndexOf('•', index - 1),
    index - 160,
  );
  const endings = ['.', ';', '\n', '•']
    .map(mark => text.indexOf(mark, index + length))
    .filter(pos => pos >= 0);
  const right = Math.min(text.length, endings.length ? Math.min(...endings) : index + length + 160);
  const clause = text.slice(Math.max(0, left + 1), right);
  const localTerm = index - Math.max(0, left + 1);
  const nearest = (rx) => {
    const flags = rx.flags.includes('g') ? rx.flags : rx.flags + 'g';
    const probe = new RegExp(rx.source, flags);
    let best = Infinity;
    for (const m of clause.matchAll(probe)) best = Math.min(best, Math.abs((m.index ?? 0) - localTerm));
    return best;
  };
  const requiredDistance = nearest(REQUIRED_RX);
  const preferredDistance = nearest(PREFERRED_RX);
  if (requiredDistance < preferredDistance) return 'required';
  if (preferredDistance < Infinity) return 'preferred';
  return 'stated';
}

export function extractRequirements(text, dictionary, { mutedTerms = [] } = {}) {
  const body = String(text || '');
  const muted = new Set(mutedTerms.map(canonicalTerm));
  const requirements = [];
  const claimed = [];
  const conceptIndexes = new Map();
  for (const item of buildRequirementCatalog(dictionary)) {
    if (muted.has(item.concept)) continue;
    for (const match of body.matchAll(termRegex(item.term, 'gi'))) {
      const start = match.index;
      const end = start + match[0].length;
      // Do not count "Microsoft Entra ID" and the nested "Entra ID" as two
      // separate requirements when they point at the same words.
      if (claimed.some(span => start >= span.start && end <= span.end)) continue;
      claimed.push({ start, end });
      const context = requirementContext(body, start, match[0].length);
      const multiplier = context === 'required' ? 1.35 : context === 'preferred' ? 0.75 : 1;
      const candidate = { ...item, context, weighted: item.weight * multiplier };
      const existingIndex = conceptIndexes.get(item.concept);
      if (existingIndex == null) {
        conceptIndexes.set(item.concept, requirements.length);
        requirements.push(candidate);
      } else if (candidate.weighted > requirements[existingIndex].weighted) {
        // If aliases appear in multiple clauses, retain the strongest wording:
        // "SSO required" must beat "Single Sign-On preferred."
        requirements[existingIndex] = candidate;
      }
    }
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
  const resumeTerms = [
    ...(cv.titles || []), ...(cv.certs || []), ...(cv.skills || []), ...(cv.compliance || []),
  ];
  const resumeConcepts = new Map();
  for (const term of resumeTerms) {
    const exactKey = String(term).toLowerCase();
    const concept = canonicalTerm(term);
    if (!resumeConcepts.has(concept)) resumeConcepts.set(concept, []);
    resumeConcepts.get(concept).push(exactKey);
  }
  const requirements = extractRequirements(`${jobTitle}\n${text}`, dictionary, { mutedTerms });
  // Titles are evaluated separately by roleFitPercent. Counting the title in
  // requirement coverage would double-reward an exact title and punish valid
  // synonyms (for example IAM Engineer vs Identity Engineer).
  const concreteRequirements = requirements.filter(r => r.category !== 'titles');
  const rolePct = roleFitPercent(jobTitle, cv.titles || [], targetTerms);
  const yearsMatch = STRICT_YEARS_RX.exec(`${jobTitle}\n${text}`);
  const yearsRequired = Number(yearsMatch?.[1] || yearsMatch?.[2] || 0);
  const careerYears = Number(cv.careerYears || 0);
  let totalWeight = 0;
  let matchedWeight = 0;
  const matched = [];
  const missing = [];
  for (const req of concreteRequirements) {
    totalWeight += req.weighted;
    if (resumeConcepts.has(req.concept)) {
      const evidence = resumeConcepts.get(req.concept)
        .map(key => cv.experienceEvidence?.[key])
        .filter(Boolean);
      // A demonstrated skill is stronger evidence than a bare skills-list
      // mention. Older parsed resumes have no evidence map and remain fully
      // compatible instead of being penalized.
      const evidenceFactor = evidence.length && ['skills', 'compliance'].includes(req.category)
        ? (evidence.some(ev => ev.demonstratedMentions > 0) ? 1 : 0.8)
        : 1;
      matchedWeight += req.weighted * evidenceFactor;
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
  if (yearsRequired && careerYears && careerYears < yearsRequired) {
    matchPct = Math.min(matchPct, 69);
  }

  return {
    matchPct: Math.max(0, Math.min(99, matchPct)),
    coveragePct,
    rolePct,
    confidencePct,
    requirementCount: concreteRequirements.length,
    yearsRequired,
    careerYears,
    matched: matched.slice(0, 20),
    missing: missing
      .sort((a, b) => b.weighted - a.weighted)
      .slice(0, 8)
      .map(r => r.term),
  };
}
