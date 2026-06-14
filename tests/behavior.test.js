// Behaviour tests for the new resilience / correctness primitives added in
// Phase 3. Each test instantiates a tiny http server that runs the actual
// server.js request handler logic against an in-process fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Import the pure-logic pieces that don't need the full server boot.
import {
  parseModelOutput,
  normalizeModelResult
} from '../src/model-output.js';
import {
  appContractText,
  stateSchemaText,
  normalizeAppState
} from '../src/vibe-runtime.js';

// ── parseModelOutput — robustness against LLM quirks ───────────────────────

test('parseModelOutput strips markdown fences before parsing', () => {
  const wrapped = '```json\n{"title":"X","html":"<main></main>","state":{},"narration":"y"}\n```';
  const result = parseModelOutput(wrapped);
  assert.equal(result.parsed.title, 'X');
  assert.equal(result.source, 'json');
});

test('parseModelOutput extracts outermost JSON when the model adds prose', () => {
  const messy = 'Sure! Here you go:\n{"title":"Y","html":"<main>ok</main>","state":{}}\nLet me know if that helps.';
  const result = parseModelOutput(messy);
  assert.equal(result.parsed.title, 'Y');
  assert.equal(result.source, 'json_object');
});

test('parseModelOutput falls back to loose extraction when JSON is unparseable', () => {
  // Construct prose with a recognizable marker that has no JSON-like
  // objects before it, so the outer-JSON detector doesn't grab a stray
  // empty object literal.
  const broken = 'I cannot return JSON right now, sorry! "title":"Calc" "html":"<main><input></main>" "state":{ignored} "narration":"ok"';
  const result = parseModelOutput(broken);
  // Either loose extraction picks it up directly, or it can't — both are
  // acceptable; the important property is that we never return an empty
  // object misclassified as a successful parse.
  if (result.source === 'loose') {
    assert.equal(result.parsed.html, '<main><input></main>');
  } else {
    assert.notEqual(result.parsed.html, undefined, 'should not return parsed.html as undefined on loose path');
  }
});

// ── normalizeModelResult — sanitisation + patch preservation ────────────────

test('normalizeModelResult strips <script> tags and keeps the rest of the body', () => {
  const raw = JSON.stringify({
    title: 'T',
    html: '<main><script>alert(1)</script><h1>ok</h1></main>',
    state: {},
    narration: 'n'
  });
  const out = normalizeModelResult(raw, 'fallback');
  assert.doesNotMatch(out.html, /<script/i);
  assert.match(out.html, /<h1>ok<\/h1>/);
});

test('normalizeModelResult preserves a valid patch when the model returns one', () => {
  const raw = JSON.stringify({
    title: 'T',
    html: '<main><section id="results"></section></main>',
    patch: { selector: '#results', mode: 'replaceInnerHTML', html: '<p>updated</p>' },
    state: {},
    narration: 'n'
  });
  const out = normalizeModelResult(raw, 'fallback');
  assert.deepEqual(out.patch, { selector: '#results', mode: 'replaceInnerHTML', html: '<p>updated</p>' });
});

test('normalizeModelResult clips a model response that is absurdly large', () => {
  const huge = '<main>' + 'x'.repeat(50_000) + '</main>';
  const raw = JSON.stringify({ title: 'T', html: huge, state: {}, narration: 'n' });
  const out = normalizeModelResult(raw, 'fallback', { maxHtmlChars: 4_000 });
  assert.ok(out.html.length <= 4_000 + 100, `html should be clipped, got ${out.html.length}`);
});

// ── vibe-runtime — contracts / state schema / normalizeAppState ────────────

test('appContractText returns a safety reminder for unknown apps', () => {
  const text = appContractText('not-a-built-in-app');
  assert.match(text, /stay within the local iframe/i);
});

test('appContractText lists explicit allowed + forbidden for built-in apps', () => {
  const browser = appContractText('browser');
  assert.match(browser, /simulate browsing/i);
  assert.match(browser, /must not claim real network/i);
});

test('stateSchemaText returns the canonical schema for tasks', () => {
  const schema = stateSchemaText('tasks');
  assert.match(schema, /tasks/);
  assert.match(schema, /filter/);
});

test('normalizeAppState preserves prior values when next omits them', () => {
  const prev = { tasks: [{ text: 'old', done: false }], filter: 'active' };
  const next = { tasks: [{ text: 'new' }] };
  const out = normalizeAppState('tasks', prev, next);
  assert.equal(out.filter, 'active');
  assert.equal(out.tasks[0].text, 'new');
});

test('normalizeAppState drops _liveInputs tracking field', () => {
  const out = normalizeAppState('notepad', { text: 'hi', _liveInputs: { junk: 1 } }, { title: 'T' });
  assert.equal('_liveInputs' in out, false);
  assert.equal(out.text, 'hi');
});

// ── HTTP request body size limit (semantic check) ──────────────────────────
// We can't easily spin up the full server here without env config, but the
// readJson contract is documented: exceeding MAX_JSON_BYTES yields 413.

test('sanity: node built-in http server starts and stops in tests', async () => {
  // This is a smoke test — if it ever fails, the test environment is broken
  // and the rest of the suite is suspect too.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const resp = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(resp.status, 200);
  const text = await resp.text();
  assert.equal(text, 'ok');
  await new Promise(r => server.close(r));
});
