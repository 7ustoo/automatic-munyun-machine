#!/usr/bin/env node
/**
 * Version-proof test launcher (v2.4).
 *
 * `npm test` history: bare `node --test` swept up Chrome-profile extension
 * files named *.test.js under data/app-window; a directory arg breaks on
 * Node 24 ("dir treated as a test file"); a glob arg breaks on Node 18/20
 * (runner-side glob expansion landed in Node 21) and cmd.exe never expands
 * globs itself. Explicit file arguments work on every Node version and both
 * shells — so enumerate scripts/__tests__ and hand the runner real paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(__dirname, '__tests__');

const files = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.mjs') || f.endsWith('.test.js'))
  .map(f => path.join(testDir, f));

if (files.length === 0) {
  console.error('run-tests: no test files found in ' + testDir);
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
