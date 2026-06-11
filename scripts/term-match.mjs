#!/usr/bin/env node
/**
 * CV-term regex helpers (v2.0).
 *
 * One implementation shared by daily-batch.mjs (job scoring) and
 * resume-parser.mjs (CV keyword extraction) — both previously built
 * `'\\b' + escRx(term) + '\\b'` inline, which has a silent hole:
 * \b after a non-word character matches NOTHING, so any term ending in
 * '+' or another symbol (Security+, C++, A+, Network+) could never match.
 * Jobs mentioning Security+ got zero cert credit, and the resume parser
 * never extracted those certs from CVs in the first place.
 *
 * termRegex() anchors a word boundary only against edges that are word
 * characters, so 'Security+' matches in "CompTIA Security+ required" but
 * 'C++' still refuses to match inside "ABC++".
 */

export function escRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function termRegex(term, flags = 'i') {
  const start = /^\w/.test(term) ? '\\b' : '';
  const end = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(start + escRx(term) + end, flags);
}
