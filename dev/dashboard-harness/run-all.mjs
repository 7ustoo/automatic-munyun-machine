// Local behavioral harness for wrapper/dashboard.html (not run in CI — needs
// a Chrome/Edge binary). Spawns the stub wrapper, runs the three Playwright
// suites: full-views screenshots, fresh-batch banner, update handoff.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const html = path.join(repo, 'wrapper', 'dashboard.html');
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

let fail = 0;
for (const s of ['shoot.mjs', 'shoot-banner.mjs']) {
  // Each suite gets a fresh stub clock. shoot-banner asserts the pre-scrape
  // 27-job state before the stub flips at 15s; sharing the stub with the
  // screenshot suite made that precondition depend on the first suite's
  // runtime and fail whenever it took longer than 15 seconds.
  const stub = spawn(process.execPath, [path.join(here, 'stub-server.mjs'), html], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stub startup timed out')), 10000);
      stub.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      stub.stdout.on('data', d => {
        if (String(d).includes('8767')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    execFileSync(process.execPath, [path.join(here, s), repo, shots], { stdio: 'inherit' });
  } catch {
    fail = 1;
  } finally {
    stub.kill();
    await new Promise(resolve => stub.once('close', resolve));
  }
}
// shoot-update spawns its own stub (it must kill it mid-test)
try { execFileSync(process.execPath, [path.join(here, 'shoot-update.mjs'), repo, shots], { stdio: 'inherit' }); }
catch { fail = 1; }
console.log(fail ? 'HARNESS: FAIL' : 'HARNESS: all suites passed');
process.exit(fail);
