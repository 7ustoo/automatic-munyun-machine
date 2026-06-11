#!/usr/bin/env node
/**
 * Syntax-check every script with `node --check` (parse only, no execution).
 * Used by `npm run check` locally and by CI — the project has no build
 * step, so this is the cheapest "does it even parse" gate (v2.0).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const targets = [];
for (const dir of ['scripts', path.join('scripts', '__tests__')]) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full)) {
    if (f.endsWith('.mjs')) targets.push(path.join(dir, f));
  }
}

let failed = 0;
for (const rel of targets) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`  ok  ${rel}`);
  } else {
    failed++;
    console.error(`FAIL  ${rel}\n${r.stderr}`);
  }
}

console.log(failed ? `\n${failed} file(s) failed syntax check` : `\nAll ${targets.length} files parse cleanly.`);
process.exit(failed ? 1 : 0);
