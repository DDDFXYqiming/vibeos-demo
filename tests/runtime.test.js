import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appContractText,
  cacheKeyForApp,
  getCachedInitialResult,
  getStaticAppResult,
  normalizeAppState,
  selectThinkingLevel,
  storeCachedInitialResult
} from '../src/vibe-runtime.js';

test('static about returns local HTML without requiring an LLM call', () => {
  const result = getStaticAppResult({ appId: 'about', title: 'About VibeOS' });
  assert.equal(result.title, 'About VibeOS');
  assert.match(result.html, /VibeOS/);
  assert.deepEqual(result.state, { section: 'about' });
});

test('built-in initial app cache is keyed by provider model thinking and intent', () => {
  const app = { appId: 'browser', title: 'Vibe Browser', intent: 'search app' };
  const provider = { provider: 'openai', model: 'mimo-v2.5-pro' };
  const key = cacheKeyForApp(app, provider, 'high');
  assert.match(key, /browser/);
  assert.equal(getCachedInitialResult(app, provider, 'high'), null);
  storeCachedInitialResult(app, provider, 'high', { title: 'Cached', html: '<main>cached</main>', state: { currentUrl: 'home' }, narration: 'cached' });
  assert.equal(getCachedInitialResult(app, provider, 'high').title, 'Cached');
  assert.equal(getCachedInitialResult(app, provider, 'low'), null);
});

test('contracts describe simulated capability boundaries for risky apps', () => {
  assert.match(appContractText('browser'), /simulate browsing/i);
  assert.match(appContractText('browser'), /must not claim real network/i);
  assert.match(appContractText('terminal'), /must not execute local commands/i);
  assert.match(appContractText('files'), /must not read the real disk/i);
});

test('known app state schemas preserve previous values and normalize missing fields', () => {
  const prev = { tasks: [{ id: 't1', text: 'old', done: false }], filter: 'active' };
  const next = { tasks: [{ text: 'new' }] };
  const state = normalizeAppState('tasks', prev, next);
  assert.equal(state.filter, 'active');
  assert.equal(state.tasks[0].id, 'task_1');
  assert.equal(state.tasks[0].done, false);
});

test('thinking level is selected by app and event while respecting configured maximum', () => {
  assert.equal(selectThinkingLevel({ appId: 'calculator', eventType: 'click', configured: 'high' }), 'off');
  assert.equal(selectThinkingLevel({ appId: 'tasks', eventType: 'change', configured: 'high' }), 'low');
  assert.equal(selectThinkingLevel({ appId: 'custom', eventType: 'submit', configured: 'high' }), 'high');
  assert.equal(selectThinkingLevel({ appId: 'custom', eventType: 'submit', configured: 'medium' }), 'medium');
});
