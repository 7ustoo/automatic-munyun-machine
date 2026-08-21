/**
 * Description-level classifier for customer-facing consulting work.
 *
 * This is intentionally deterministic and conservative: known consulting,
 * client-service, and required-travel language is scored alongside evidence
 * that the role owns and builds production software. It works locally without
 * Smart Match and exposes reasons for funnel diagnostics and regression tests.
 */

export const CONSULTANT_SLOP_MODES = ['off', 'balanced', 'strict'];

export function normalizeConsultantSlopMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'true' || mode === 'on') return 'balanced';
  return CONSULTANT_SLOP_MODES.includes(mode) ? mode : 'off';
}

const TITLE_SIGNALS = [
  [/\b(?:implementation|solutions?|presales?|pre-sales|professional services) consultant\b/i, 8, 'consultant title'],
  [/\bconsultant\b/i, 6, 'consultant title'],
  [/\b(?:solutions?|sales|customer|field) engineer\b/i, 5, 'customer solutions title'],
  [/\btechnical account manager\b/i, 7, 'technical account title'],
  [/\b(?:customer success|client services?)\b/i, 7, 'customer success title'],
];

const CUSTOMER_SIGNALS = [
  [/\b(?:customer|client)[ -]facing\s+(?:role|position|experience|responsibilit(?:y|ies)|work|engagements?|communication)\b/i, 5, 'explicitly customer-facing'],
  [/\b(?:you\s+(?:will|are)|must|expected\s+to)\s+(?:be\s+)?(?:customer|client)[ -]facing\b/i, 5, 'explicitly customer-facing'],
  [/\b(?:work|partner|collaborate|engage|interact|meet)\s+(?:directly\s+)?with\s+(?:our\s+|enterprise\s+)?(?:customers|clients)\b/i, 4, 'works directly with customers'],
  [/\b(?:present|demonstrate|demo|train|advise)\w*\s+(?:solutions?\s+)?(?:to|for)\s+(?:customers|clients)\b/i, 4, 'customer presentations or training'],
  [/\btrusted advisor\b/i, 4, 'trusted-advisor work'],
  [/\b(?:customer|client)\s+(?:workshops?|discovery sessions?|requirements? sessions?)\b/i, 4, 'customer discovery or workshops'],
  [/\bmanage\s+(?:customer|client)\s+(?:relationships?|expectations?|stakeholders?)\b/i, 4, 'manages customer relationships'],
  [/\b(?:primary|technical)\s+(?:technical\s+)?point of contact\s+for\s+(?:customers|clients)\b/i, 4, 'customer technical contact'],
];

const CONSULTING_SIGNALS = [
  [/\bprofessional services\b/i, 5, 'professional services'],
  [/\b(?:consulting|client) engagements?\b/i, 4, 'consulting engagements'],
  [/\b(?:billable|utilization target|billable utilization)\b/i, 5, 'billable consulting work'],
  [/\b(?:statement of work|statements of work|SOWs?)\b/i, 4, 'statements of work'],
  [/\b(?:pre-sales|presales|post-sales|postsales)\b/i, 5, 'pre/post-sales work'],
  [/\b(?:implement|configure|deploy|onboard)\w*\s+(?:the\s+)?(?:solution|platform|product|environment)\s+(?:for|at)\s+(?:customers|clients)\b/i, 4, 'implements customer environments'],
  [/\bmultiple\s+(?:customers|clients|engagements)\b/i, 3, 'multiple client engagements'],
  [/\b(?:consulting practice|delivery practice|engagement manager)\b/i, 4, 'consulting practice'],
];

const ENGINEERING_SIGNALS = [
  [/\b(?:build|develop|design|maintain|operate)\w*\s+(?:backend|distributed|production|internal)\s+(?:services?|systems?|platforms?|apis?)\b/i, 3],
  [/\b(?:backend services?|microservices?|rest(?:ful)? apis?|service ownership)\b/i, 2],
  [/\b(?:code reviews?|pull requests?|unit tests?|integration tests?)\b/i, 2],
  [/\b(?:sprint|backlog|engineering tickets?|jira tickets?)\b/i, 2],
  [/\b(?:on-call|production incidents?|debugging|root cause analysis)\b/i, 2],
  [/\b(?:ci\/cd|continuous integration|deployments?|release pipelines?)\b/i, 2],
  [/\b(?:own|ownership of)\s+(?:services?|systems?|production|architecture)\b/i, 2],
];

const TRAVEL_NEGATIONS = [
  /\bno\s+(?:business\s+)?travel\s+(?:is\s+)?required\b/gi,
  /\btravel\s+(?:is\s+)?not\s+required\b/gi,
  /\b0\s*%\s*travel\b/gi,
  /\bno\s+travel\b/gi,
];

const TRAVEL_SIGNALS = [
  /\b(?:travel\s+(?:is\s+)?required|required\s+travel)\b/i,
  /\b(?:ability|willingness|available|willing)\s+to\s+travel\b/i,
  /\btravel\s+(?:up\s+to\s+|approximately\s+|about\s+)?\d{1,3}\s*%/i,
  /\b\d{1,3}\s*%\s+(?:business\s+)?travel\b/i,
  /\btravel\s+to\s+(?:customer|client)\s+sites?\b/i,
  /\b(?:regular|frequent|weekly|monthly)\s+(?:business\s+)?travel\b/i,
  /\bmust\s+(?:live|reside)\s+(?:near|within[^.]{0,30})\s+(?:an?\s+)?(?:major\s+)?airport\b/i,
];

function scoreSignals(text, signals) {
  let score = 0;
  const reasons = [];
  for (const [rx, weight, reason] of signals) {
    if (!rx.test(text)) continue;
    score += weight;
    reasons.push(reason);
  }
  return { score, reasons };
}

function engineeringScore(text) {
  return ENGINEERING_SIGNALS.reduce((score, [rx, weight]) => score + (rx.test(text) ? weight : 0), 0);
}

function travelRequired(text) {
  let probe = text;
  for (const rx of TRAVEL_NEGATIONS) probe = probe.replace(rx, ' ');
  return TRAVEL_SIGNALS.some(rx => rx.test(probe));
}

export function analyzeConsultantSlop({ title = '', text = '' } = {}, requestedMode = 'off') {
  const mode = normalizeConsultantSlopMode(requestedMode);
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  const heading = String(title || '').replace(/\s+/g, ' ').trim();
  const titleResult = scoreSignals(heading, TITLE_SIGNALS);
  const customer = scoreSignals(body, CUSTOMER_SIGNALS);
  const consulting = scoreSignals(`${heading}\n${body}`, CONSULTING_SIGNALS);
  const travel = travelRequired(body);
  const engineering = engineeringScore(body);
  const consultingScore = titleResult.score + customer.score + consulting.score + (travel ? 3 : 0);

  let excluded = false;
  if (mode === 'balanced') {
    const obviousTitle = titleResult.score >= 6;
    const explicitCustomerFacing = customer.score >= 5;
    const multiSignal = consultingScore >= 8
      || (customer.score >= 4 && consulting.score >= 4)
      || (travel && (customer.score >= 4 || consulting.score >= 4));
    // Strong hands-on engineering evidence rescues generic customer wording,
    // but never an explicit consultant title or a multi-signal client role.
    excluded = obviousTitle || explicitCustomerFacing
      || (multiSignal && !(engineering >= 8 && consultingScore < 11));
  } else if (mode === 'strict') {
    excluded = titleResult.score >= 5 || customer.score >= 4 || consulting.score >= 4 || travel;
  }

  const reasons = [...titleResult.reasons, ...customer.reasons, ...consulting.reasons];
  if (travel) reasons.push('required travel');
  return {
    mode,
    excluded,
    consultingScore,
    engineeringScore: engineering,
    customerFacing: customer.score > 0,
    consulting: titleResult.score > 0 || consulting.score > 0,
    travelRequired: travel,
    reasons: [...new Set(reasons)],
  };
}
