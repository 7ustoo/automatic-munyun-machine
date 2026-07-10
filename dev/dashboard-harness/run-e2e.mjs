import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const html = path.join(repo, 'wrapper', 'dashboard.html');
const stub = spawn(process.execPath, [path.join(here, 'stub-server.mjs'), html], { stdio: ['ignore', 'pipe', 'inherit'] });

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('dashboard stub did not start')), 10000);
    stub.stdout.on('data', d => {
      if (String(d).includes('8767')) { clearTimeout(timeout); resolve(); }
    });
    stub.on('exit', code => reject(new Error(`dashboard stub exited ${code}`)));
  });
  const child = spawn(process.execPath, [path.join(here, 'e2e.mjs'), repo], { stdio: 'inherit' });
  const code = await new Promise(resolve => child.on('exit', resolve));
  process.exitCode = code ?? 1;
} finally {
  stub.kill();
}
