/**
 * Deliverable batch-size options (v4.5).
 *
 * Single source of truth for "how many ranked jobs make the final batch". The
 * dashboard Settings picker offers exactly these values; the API validator and
 * the scraper both clamp the stored config through `clampBatchSize` so a
 * hand-edited `config.json` can never make the apply-URL resolve pass visit an
 * unbounded number of job pages (each delivered job's page is visited during
 * resolution, and — when signed in — marked Viewed on the hiring.cafe account).
 */

export const BATCH_SIZE_OPTIONS = [50, 100, 150, 200];
export const DEFAULT_BATCH_SIZE = 100;

/**
 * Coerce any stored/typed value to one of BATCH_SIZE_OPTIONS.
 * - exact option → itself
 * - other finite number → nearest option (ties round up: 125 → 150)
 * - garbage / missing → DEFAULT_BATCH_SIZE
 */
export function clampBatchSize(value) {
  // Only genuine numbers or numeric strings count. null/''/[]/{} all coerce to
  // a finite Number() in JS ('' and null → 0), which would wrongly snap to 50;
  // treat anything that isn't clearly a number as "unset" → default.
  const raw = typeof value === 'number' ? value
            : (typeof value === 'string' && value.trim() !== '') ? Number(value)
            : NaN;
  const n = Math.round(raw);
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE;
  if (BATCH_SIZE_OPTIONS.includes(n)) return n;
  let best = DEFAULT_BATCH_SIZE, bestDist = Infinity;
  for (const opt of BATCH_SIZE_OPTIONS) {
    const d = Math.abs(opt - n);
    if (d < bestDist || (d === bestDist && opt > best)) { best = opt; bestDist = d; }
  }
  return best;
}
