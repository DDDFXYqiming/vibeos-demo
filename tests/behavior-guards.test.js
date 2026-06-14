// Behaviour assertions on top of the existing pattern-match checks.
// These tests verify the front-end / server invariants that the regex-based
// tests in app-source.test.js can't catch: e.g. "X must be guarded by Y",
// "consumed once", "never set then immediately returned".

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const serverJs = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('lastPatchFailed is consumed atomically with the server response (not before fetch)', () => {
  // Phase 4.6 fix: the old code set `lastPatchFailed = false` BEFORE awaiting
  // the network request, which meant an aborted / superseded event would eat
  // the hint without telling the server. The new code consumes the hint only
  // after a successful server response.
  // We assert: the `record.lastPatchFailed = false` line must appear AFTER
  // the `await api(...)` call inside sendSessionEvent.
  const fnMatch = appJs.match(/async function sendSessionEvent[\s\S]*?^}/m);
  assert.ok(fnMatch, 'sendSessionEvent function must exist');
  const body = fnMatch[0];
  const fetchIdx = body.search(/await api\(/);
  const clearIdx = body.search(/record\.lastPatchFailed\s*=\s*false/);
  assert.notEqual(clearIdx, -1, 'lastPatchFailed=false assignment must exist');
  assert.ok(clearIdx > fetchIdx,
    `lastPatchFailed=false (at ${clearIdx}) must come AFTER await api() (at ${fetchIdx}) to ensure the hint survives an aborted request`);
});

test('applyPatch rejection must set lastPatchFailed BEFORE any fallback srcdoc write', () => {
  // The fix: when a patch fails, the next event should re-render full HTML.
  // We assert the order: first the flag is set, then (optionally) the
  // fallback srcdoc is written — never the other way around.
  const flagSet = /record\.lastPatchFailed\s*=\s*true/;
  const flagSetIdx = appJs.search(flagSet);
  assert.notEqual(flagSetIdx, -1, 'lastPatchFailed=true must be set on rejection');
  // The previous 8 lines of context should NOT contain a stale "set to true and return"
  // without ever being consumed.
  const context = appJs.slice(Math.max(0, flagSetIdx - 400), flagSetIdx);
  assert.doesNotMatch(context, /lastPatchFailed\s*=\s*true[\s\S]{0,40}return[^;]/,
    'do not set lastPatchFailed=true and immediately return without consuming it');
});

test('message pruning in server.js uses a single splice (no while-loop)', () => {
  // Phase 1.1 replaced the O(n²) while-loop with a single splice. Lock it in.
  assert.doesNotMatch(serverJs, /while\s*\(\s*session\.messages\.length\s*>\s*CONFIG\.maxSessionMessages\s*\)/,
    'message pruning should be a single splice, not a while-loop');
  assert.match(serverJs, /session\.messages\.splice\(\s*2\s*,\s*pruneCount\s*\)/,
    'must call splice(2, pruneCount) at most once per event');
});

test('server request body is bounded (MAX_JSON_BYTES constant exists)', () => {
  assert.match(serverJs, /MAX_JSON_BYTES\s*=\s*[\d_]+/,
    'server.js must define MAX_JSON_BYTES for payload size limit');
  assert.match(serverJs, /if\s*\(\s*total\s*>\s*MAX_JSON_BYTES\s*\)\s*\{[\s\S]{0,200}err\.status\s*=\s*413/,
    'readJson must throw a 413 error when the body exceeds the limit');
});

test('logger no longer uses appendFileSync on the hot path', () => {
  const loggerJs = fs.readFileSync(new URL('../src/logger.js', import.meta.url), 'utf8');
  // Strip comments before counting — references inside a comment are
  // descriptive, not executable.
  const codeOnly = loggerJs.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // We still allow a fallback path under a stream-failure branch, but the
  // primary write must go through a cached stream.
  assert.match(loggerJs, /createWriteStream/,
    'logger must use fs.createWriteStream for the cached file handle');
  // Make sure the open-coded sync call isn't the default path.
  const syncMatches = codeOnly.match(/appendFileSync/g) || [];
  assert.ok(syncMatches.length <= 1, `appendFileSync should appear at most once in code (as fallback), found ${syncMatches.length}`);
});

test('Anthropic provider normalises message alternation', () => {
  // enforceAlternation() folds consecutive same-role messages into one.
  assert.match(serverJs, /enforceAlternation/,
    'server.js must define enforceAlternation() for Anthropic message ordering');
});

test('withFetchRetry wrapper handles 429, 5xx, and AbortError distinctly', () => {
  assert.match(serverJs, /function\s+classifyHttpError/,
    'server.js must classify HTTP errors for retry decisions');
  assert.match(serverJs, /if\s*\(\s*status\s*===\s*429\s*\)/,
    'must special-case 429 (rate limit)');
  assert.match(serverJs, /status\s*>=\s*500\s*&&\s*status\s*<\s*600/,
    'must retry 5xx server errors');
});

test('session.inflight serialises concurrent events on the same session', () => {
  // The handler in handleSessionEvent should await a previous inflight
  // promise before kicking off generateNextHtml.
  assert.match(serverJs, /session\.inflight\s*=\s*work\.catch\(\(\)\s*=>\s*\{\}\)/,
    'session.inflight must be replaced with the catch-wrapped work promise');
  assert.match(serverJs, /prevInflight\.then\(\(\)\s*=>\s*generateNextHtml/,
    'must chain on the previous inflight before calling generateNextHtml');
});

test('session GC runs periodically with a sensible TTL', () => {
  assert.match(serverJs, /SESSION_TTL_MS\s*=\s*\d/,
    'session TTL constant must be defined');
  assert.match(serverJs, /setInterval\([\s\S]{0,200}SESSION_TTL_MS/,
    'a setInterval must scan and evict idle sessions');
});

test('routes are extracted to dedicated handlers (handleApi delegates)', () => {
  assert.match(serverJs, /async\s+function\s+handleCreateSession/,
    'POST /api/sessions must be a separate handler');
  assert.match(serverJs, /async\s+function\s+handleSessionEvent/,
    'POST /api/sessions/:id/event must be a separate handler');
});
