#!/usr/bin/env node
/** Run every profile whose weekday schedule is enabled, sequentially. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _internals, migrateIfNeeded } from './profile-store.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function scheduledProfileSlugs(raw = {}) {
  return Object.entries(raw.profiles || {})
    .filter(([, profile]) => profile?.schedule?.enabled !== false)
    .map(([slug]) => slug);
}

export function runProfile(slug, spawnImpl = spawn) {
  return new Promise(resolve => {
    const child = spawnImpl(process.execPath, [path.join(ROOT, 'scripts', 'daily-batch.mjs')], {
      cwd: ROOT,
      env: { ...process.env, AMM_PROFILE: slug },
      windowsHide: true,
      stdio: 'inherit',
    });
    child.on('exit', code => resolve(Number(code) || 0));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  migrateIfNeeded();
  const profiles = scheduledProfileSlugs(_internals.readRawConfig());
  if (!profiles.length) {
    console.log('Automatic Munyun Machine scheduled search: every profile is disabled.');
    return;
  }
  let failed = 0;
  for (const slug of profiles) {
    console.log(`Automatic Munyun Machine scheduled search: starting profile "${slug}".`);
    if (await runProfile(slug)) failed++;
  }
  if (failed) process.exitCode = 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
