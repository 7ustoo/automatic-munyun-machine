/** Local secret file helpers. Secrets stay out of config snapshots. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, atomicWriteText } from './io-helpers.mjs';
import { parseEnvText } from './telegram-config.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SECRET_PATH = path.join(ROOT, '.env');

export function readLocalSecrets() {
  try { return parseEnvText(fs.readFileSync(SECRET_PATH, 'utf8')); }
  catch { return {}; }
}

export function setLocalSecret(name, value) {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error('invalid secret name');
  value = String(value || '').trim();
  if (/[\r\n]/.test(value)) throw new Error('secret cannot contain a newline');
  let body = '';
  try { body = fs.readFileSync(SECRET_PATH, 'utf8'); } catch {}
  const rx = new RegExp(`^${name}=.*(?:\\r?\\n|$)`, 'm');
  body = body.replace(rx, '');
  if (value) body += (body && !body.endsWith('\n') ? '\n' : '') + `${name}=${value}\n`;
  atomicWriteText(SECRET_PATH, body);
  try { fs.chmodSync(SECRET_PATH, 0o600); } catch {}
}

export function scrubLegacyAiKeysFromSnapshots() {
  const dir = path.join(ROOT, 'data', 'backups');
  let scrubbed = 0;
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /^config-.*\.json$/.test(name)); }
  catch { return 0; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      let changed = false;
      for (const profile of Object.values(cfg.profiles || {})) {
        if (profile?.scoring?.ai?.apiKey) {
          profile.scoring.ai.apiKey = '';
          changed = true;
        }
      }
      if (cfg.scoring?.ai?.apiKey) {
        cfg.scoring.ai.apiKey = '';
        changed = true;
      }
      if (changed) {
        atomicWriteJson(file, cfg);
        scrubbed++;
      }
    } catch { /* malformed/foreign snapshot: leave it untouched */ }
  }
  return scrubbed;
}
