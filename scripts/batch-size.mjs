/**
 * Deliverable batch-size options (v4.5).
 *
 * Single source of truth for "how many ranked jobs make the final batch". The
 * Dashboard Settings offers the familiar presets plus a custom positive whole
 * number. Available job supply and the description evaluation budget determine
 * how many jobs can actually be delivered.
 */

export const BATCH_SIZE_OPTIONS = [50, 100, 150, 200];
export const DEFAULT_BATCH_SIZE = 200;
export const MAX_KEYWORD_BATCH_SIZE = 1000;

/**
 * Coerce any stored/typed value to a positive safe integer.
 * - garbage / missing → DEFAULT_BATCH_SIZE
 */
export function clampBatchSize(value) {
  // Only genuine numbers or numeric strings count. null/''/[]/{} all coerce to
  // a finite Number() in JS ('' and null → 0), which would wrongly pass as 0;
  // treat anything that isn't clearly a number as "unset" → default.
  const raw = typeof value === 'number' ? value
            : (typeof value === 'string' && value.trim() !== '') ? Number(value)
            : NaN;
  const n = Math.round(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_BATCH_SIZE;
}

export function parseRankedBatchSize(value) {
  const text = typeof value === 'number' ? String(value) : String(value || '').trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export function parseKeywordBatchSize(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_KEYWORD_BATCH_SIZE ? n : null;
}
