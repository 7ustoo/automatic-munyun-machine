#!/usr/bin/env node
/**
 * Resume parser for Automatic Munyun Machine.
 *
 * Reads a resume file (PDF, DOCX, MD, or TXT), extracts skills/certs/titles/compliance
 * by matching against scripts/cv-keywords.json, and writes structured output to
 * data/cv-parsed.json.
 *
 * Used by:
 *   - setup-wizard.mjs (Step 4: resume upload)
 *   - daily-batch.mjs (loads parsed keywords for scoring)
 *
 * Usage:
 *   node scripts/resume-parser.mjs <path-to-resume>
 *   node scripts/resume-parser.mjs data/cv.md      ← re-parse stored CV
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './profile-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

import { termRegex } from './term-match.mjs';

function findHits(text, dictionary) {
  const seen = new Set();
  const hits = [];
  for (const term of dictionary) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    // termRegex (term-match.mjs) — plain \b…\b silently never matched
    // terms ending in non-word chars (Security+, C++), so those certs
    // were never extracted from CVs.
    if (termRegex(term).test(text)) {
      hits.push(term);
      seen.add(key);
    }
  }
  return hits;
}

export async function readResumeText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);

  if (ext === '.pdf') {
    const { default: pdfParse } = await import('pdf-parse');
    const data = await pdfParse(buf);
    return data.text;
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  }
  if (ext === '.md' || ext === '.txt' || ext === '.markdown') {
    return buf.toString('utf8');
  }
  throw new Error(`Unsupported resume format: ${ext}. Use PDF, DOCX, MD, or TXT.`);
}

// Score the CV against each cluster's signal terms. Returns an object mapping
// cluster name → number of distinct hits. Used to pick `primaryClusters` so
// scoring in daily-batch.mjs can deemphasize off-domain matches (e.g. a
// backend dev's handful of IAM matches don't drag their non-IAM jobs).
export function scoreClusters(text, clusters) {
  const scores = {};
  for (const [name, def] of Object.entries(clusters || {})) {
    if (!def || !Array.isArray(def.terms)) continue;
    scores[name] = findHits(text, def.terms).length;
  }
  return scores;
}

// Pick the top N clusters by hit count, dropping zeros.
export function pickPrimaryClusters(clusterScores, n = 2) {
  return Object.entries(clusterScores)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name]) => name);
}

export async function parseResume(filePath) {
  const dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'cv-keywords.json'), 'utf8'));
  const text = await readResumeText(filePath);
  const clusterScores = scoreClusters(text, dict.clusters);
  const primaryClusters = pickPrimaryClusters(clusterScores, 2);
  return {
    sourceFile: path.resolve(filePath),
    parsedAt: new Date().toISOString(),
    titles: findHits(text, dict.titles),
    certs: findHits(text, dict.certs),
    skills: findHits(text, dict.skills),
    compliance: findHits(text, dict.compliance),
    primaryClusters,
    clusterScores,
    raw: text.slice(0, 8000) // first 8KB of raw text for debugging / future use
  };
}

export function writeParsedCV(parsed, profileSlug) {
  // v1.0 E5: writes to data/profiles/<active>/cv-parsed.json by default;
  // pass an explicit slug to write into a specific profile.
  const outPath = paths(profileSlug).cvParsed;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2));
  return outPath;
}

// CLI entrypoint — fileURLToPath handles Windows / Unix differences
const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(thisFile) === invokedFile) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node resume-parser.mjs <path-to-resume>');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(2);
  }
  const parsed = await parseResume(file);
  const out = writeParsedCV(parsed);
  console.log(`✓ Parsed ${file}`);
  console.log(`  Titles:     ${parsed.titles.length}`);
  console.log(`  Certs:      ${parsed.certs.length}`);
  console.log(`  Skills:     ${parsed.skills.length}`);
  console.log(`  Compliance: ${parsed.compliance.length}`);
  if (parsed.primaryClusters?.length) {
    console.log(`  Primary clusters: ${parsed.primaryClusters.join(', ')}`);
    const top5 = Object.entries(parsed.clusterScores || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top5.length) console.log(`  Cluster scores:   ${top5.map(([n, c]) => `${n}=${c}`).join(', ')}`);
  }
  console.log(`  Saved to:   ${out}`);
}
