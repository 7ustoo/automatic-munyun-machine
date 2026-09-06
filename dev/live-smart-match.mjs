// Opt-in provider contract probe. Sends synthetic data only, never the resume.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnvText } from '../scripts/telegram-config.mjs';
import { aiRerank, detectAiProvider } from '../scripts/ai-rerank.mjs';
const root = process.argv[2] || process.cwd();
const env = parseEnvText(fs.readFileSync(path.join(root, '.env'), 'utf8'));
const key = env.AMM_AI_KEY;
if (!key) throw new Error('No configured AI key');
try {
  const result = await aiRerank({ apiKey: key,
    cvSummary: { resumeText: 'Backend engineer. Five years building Node.js APIs, PostgreSQL and single sign-on (SSO) integrations.' },
    candidates: [{ n: 0, title: 'Backend Engineer', company: 'Synthetic test', text: 'Build Node.js APIs with PostgreSQL and SSO. Three years experience.' }],
  });
  console.log(JSON.stringify({ provider: detectAiProvider(key)?.label, validatedRatings: result.length, success: true }));
} catch (e) {
  // Deliberately do not print provider payloads or credential values.
  console.error(JSON.stringify({ success: false, kind: /HTTP (\d+)/.exec(String(e.message))?.[0] || 'response validation or network failure' }));
  process.exitCode = 1;
}
