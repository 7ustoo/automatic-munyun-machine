import test from 'node:test';
import assert from 'node:assert/strict';
import { aiRerank } from '../ai-rerank.mjs';

const ratings = [{ n: 0, fit: 91, reason: 'Strong fit.', skills: 93, seniority: 88, role: 94 }];
const options = {
  cvSummary: { skills: ['Node.js'] },
  candidates: [{ n: 0, title: 'Backend Engineer', company: 'A', text: 'Build APIs.' }],
};

function okJson(data, inspect) {
  return async (url, init) => {
    inspect(url, init, JSON.parse(init.body));
    return { ok: true, json: async () => data };
  };
}

test('Gemini key selects Google endpoint, model, schema, and response parser', async () => {
  const key = `AIza${'g'.repeat(32)}`;
  const result = await aiRerank({
    ...options,
    apiKey: key,
    fetchImpl: okJson({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ratings }) }] } }] }, (url, init, body) => {
      assert.match(url, /generativelanguage\.googleapis\.com/);
      assert.match(url, /gemini-flash-latest/);
      assert.equal(init.headers['x-goog-api-key'], key);
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.deepEqual(body.generationConfig.responseSchema.required, ['ratings']);
    }),
  });
  assert.deepEqual(result, ratings);
});

test('Anthropic key selects Messages API and its automatic model', async () => {
  const key = `sk-ant-${'a'.repeat(32)}`;
  const result = await aiRerank({
    ...options,
    apiKey: key,
    fetchImpl: okJson({ content: [{ type: 'text', text: JSON.stringify({ ratings }) }] }, (url, init, body) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(init.headers['x-api-key'], key);
      assert.equal(body.model, 'claude-sonnet-4-6');
    }),
  });
  assert.deepEqual(result, ratings);
});

test('OpenAI key selects Chat Completions and its automatic model', async () => {
  const key = `sk-proj-${'o'.repeat(32)}`;
  const result = await aiRerank({
    ...options,
    apiKey: key,
    fetchImpl: okJson({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ratings }) } }] }, (url, init, body) => {
      assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(init.headers.authorization, `Bearer ${key}`);
      assert.equal(body.model, 'gpt-5-mini');
      assert.equal(body.response_format.type, 'json_schema');
    }),
  });
  assert.deepEqual(result, ratings);
});

test('unrecognized key fails before sending it anywhere', async () => {
  let called = false;
  await assert.rejects(
    aiRerank({ ...options, apiKey: 'this-is-not-a-provider-key-but-long', fetchImpl: async () => { called = true; } }),
    /unsupported API key/,
  );
  assert.equal(called, false);
});
