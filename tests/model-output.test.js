import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tryParseJson,
  normalizeModelResult,
  generateWithParseRetry,
  timeoutForModel
} from '../src/model-output.js';

test('tryParseJson repairs invalid JSON backslash escapes inside HTML strings', () => {
  const raw = '{"title":"Bad Escape","html":"<style>.icon::before{content:\\★}</style>","state":{},"narration":"ok"}';

  const parsed = tryParseJson(raw);

  assert.equal(parsed.title, 'Bad Escape');
  assert.match(parsed.html, /content:★/);
});

test('normalizeModelResult loosely extracts HTML when the model output cannot be parsed as JSON', () => {
  const raw = '{"title":"Loose Browser","html":"<main class=\\"browser\\"><h1>Search</h1></main>","state":{},"narration":"ok"';

  const normalized = normalizeModelResult(raw, 'Fallback Title');

  assert.equal(normalized.title, 'Loose Browser');
  assert.match(normalized.html, /<main class="browser">/);
  assert.doesNotMatch(normalized.html, /Model returned non-JSON output/);
});

test('generateWithParseRetry asks the model again after invalid JSON and returns the repaired result', async () => {
  const calls = [];
  const invalid = 'The result is almost ready, but not a JSON object.';
  const valid = '{"title":"Recovered","html":"<main>OK</main>","state":{"ready":true},"narration":"retried"}';

  const result = await generateWithParseRetry({
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    callLlm: async (messages) => {
      calls.push(messages);
      return calls.length === 1 ? invalid : valid;
    },
    fallbackTitle: 'Fallback',
    retryPrompt: 'Return valid JSON only.'
  });

  assert.equal(calls.length, 2);
  assert.equal(result.title, 'Recovered');
  assert.deepEqual(result.state, { ready: true });
  assert.match(calls[1].at(-1).content, /Return valid JSON only/);
});

test('timeoutForModel gives pro or thinking models enough time while preserving explicit higher timeout', () => {
  assert.equal(timeoutForModel({ model: 'mimo-v2.5-pro', thinkingLevel: 'high', baseTimeoutMs: 45_000 }), 120_000);
  assert.equal(timeoutForModel({ model: 'mimo-v2.5', thinkingLevel: 'off', baseTimeoutMs: 45_000 }), 45_000);
  assert.equal(timeoutForModel({ model: 'mimo-v2.5-pro', thinkingLevel: 'high', baseTimeoutMs: 180_000 }), 180_000);
});

test('normalizeModelResult preserves safe local patch metadata for partial rendering', () => {
  const raw = '{"title":"Patch","html":"<main><section id=\\"results\\"></section></main>","patch":{"selector":"#results","mode":"replaceInnerHTML","html":"<p>Updated</p>"},"state":{},"narration":"patched"}';

  const normalized = normalizeModelResult(raw, 'Fallback');

  assert.deepEqual(normalized.patch, { selector: '#results', mode: 'replaceInnerHTML', html: '<p>Updated</p>' });
});
