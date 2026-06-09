import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tryParseJson,
  normalizeModelResult,
  generateWithParseRetry,
  stripUnsafeHtml,
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

// ── stripUnsafeHtml: style-preserving truncation ──────────────────────────

test('stripUnsafeHtml returns short input unchanged', () => {
  const html = '<style>.x{color:red}</style><main>hello</main>';
  assert.equal(stripUnsafeHtml(html, 16000), html);
});

test('stripUnsafeHtml keeps <style> block intact when only body overflows the budget', () => {
  const style = '<style>.browser{background:#fff;color:#241f31;font-family:Ubuntu;}.browser a{color:#77216f}</style>';
  const filler = '<p>' + 'word '.repeat(4000) + '</p>'; // ~20k chars
  const out = stripUnsafeHtml(style + filler, 16000);

  assert.match(out, /<style>[\s\S]*?\.browser\{background:#fff[\s\S]*?<\/style>/);
  assert.match(out, /<!-- body clipped -->/);
  // The full style block must appear in order near the start, not chopped in half
  assert.ok(out.indexOf('</style>') < out.indexOf('<!-- body clipped -->') || out.indexOf('<main>') !== -1);
  // Total length must not exceed budget
  assert.ok(out.length <= 16000 + '<style></style>'.length + '<!-- body clipped -->'.length, `len=${out.length}`);
});

test('stripUnsafeHtml preserves multiple <style> blocks when body overflows', () => {
  const s1 = '<style>.a{color:red}</style>';
  const s2 = '<style>.b{color:blue}</style>';
  const body = '<div>' + 'x'.repeat(20000) + '</div>';
  const out = stripUnsafeHtml(s1 + s2 + body, 16000);

  assert.match(out, /<style>\.a\{color:red\}<\/style>/);
  assert.match(out, /<style>\.b\{color:blue\}<\/style>/);
  assert.match(out, /<!-- body clipped -->/);
});

test('stripUnsafeHtml clips oversized <style> blocks when CSS itself overflows the budget', () => {
  const css = '.r{color:' + '#aabbcc;'.repeat(2000) + '}'; // ~20k chars of CSS
  const html = `<style>${css}</style><main>body</main>`;
  const out = stripUnsafeHtml(html, 16000);

  assert.match(out, /<style>[\s\S]*?css clipped[\s\S]*?<\/style>/);
  assert.match(out, /<main>body<\/main>/);
  // Each style block must be closed before the body — never dangling
  const lastStyleClose = out.lastIndexOf('</style>');
  const bodyIndex = out.indexOf('<main>');
  assert.ok(lastStyleClose !== -1 && bodyIndex !== -1 && lastStyleClose < bodyIndex, 'style block must close before body');
});

test('stripUnsafeHtml strips <script> and inline event handlers before truncation', () => {
  const html = '<style>.x{}</style><main><script>alert(1)</script><button onclick="evil()">go</button></main>';
  const out = stripUnsafeHtml(html, 16000);
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /onclick=/i);
  assert.match(out, /<style>\.x\{\}<\/style>/);
  assert.match(out, /<button>go<\/button>/);
});

test('stripUnsafeHtml without <style> falls back to plain slice', () => {
  const body = 'a'.repeat(20000);
  const out = stripUnsafeHtml(body, 16000);
  assert.equal(out.length, 16000);
  assert.doesNotMatch(out, /<style/);
});

test('stripUnsafeHtml removes javascript: protocol everywhere', () => {
  const html = '<style>.x{background:url(javascript:alert(1))}</style><a href="javascript:bad()">x</a>';
  const out = stripUnsafeHtml(html, 16000);
  assert.doesNotMatch(out, /javascript:/i);
});
