/**
 * Shared normalizer for ATS source adapters (v5.0).
 *
 * Produces a card in the same shape daily-batch.mjs works with (href / title /
 * company / cardText / jdText / directUrl), plus a `__ats` flag so the resolve
 * pass skips the Playwright navigation (ATS feeds already carry the JD + apply
 * URL). Pure and fixture-testable.
 */

export function normalizeCard({ source, title, company, location = '', url = '', jd = '', postedAt = '', workplaceType = '' }) {
  title = String(title || '').trim();
  url = String(url || '').trim();
  if (!title || !url) return null;
  const loc = String(location || '').trim();
  const jdText = String(jd || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
  const co = String(company || '').trim();
  const cardText = [title, co, loc, jdText.slice(0, 1200)].filter(Boolean).join(' — ');
  return {
    source,
    href: url,
    directUrl: url,
    title,
    company: co,
    location: loc,
    workplaceType: String(workplaceType || '').trim(),
    yoe: null,
    postedAge: '',              // ATS feeds are current; recency keeps unknown-age jobs
    postedAt: String(postedAt || ''),
    cardText,
    jdText,
    __ats: true
  };
}

// Filter an ATS card by the user's workplace preference. Lever/Ashby expose a
// structured workplaceType; Greenhouse doesn't (empty → kept). `want` is the
// normalized enum e.g. ['Remote'] or ['Onsite','Hybrid'].
export function matchesWorkplace(card, want) {
  if (!Array.isArray(want) || !want.length) return true;
  const raw = (card.workplaceType || '').toLowerCase().trim();
  if (!raw || raw === 'unspecified') return true; // unknown → keep
  const map = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'Onsite', 'on-site': 'Onsite', 'on site': 'Onsite' };
  const norm = map[raw];
  if (!norm) return true;
  return want.includes(norm);
}
