import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('desktop boot does not auto-open About through LLM session creation', () => {
  assert.doesNotMatch(appJs, /openApp\(APPS\.about, \{ x: 180/);
  assert.match(appJs, /logBoot\('\[ ok \] desktop ready without startup LLM call'\)/);
});

test('iframe event payload is slim and semantic rather than full HTML dump', () => {
  assert.doesNotMatch(appJs, /documentHtml:\s*clip\(document\.body\.innerHTML/);
  assert.match(appJs, /semanticAction:/);
  assert.match(appJs, /inferSemanticAction/);
});

test('frontend queues session events and drops stale responses', () => {
  assert.match(appJs, /enqueueSessionEvent/);
  assert.match(appJs, /requestSeq/);
  assert.match(appJs, /lastAppliedSeq/);
});

test('frontend supports patch rendering and recovery buttons', () => {
  assert.match(appJs, /applyPatch/);
  assert.match(appJs, /data-vibe-action="recovery.retry"/);
  assert.match(appJs, /data-vibe-action="recovery.simplify"/);
  assert.match(appJs, /data-vibe-action="recovery.reset"/);
});

test('window manager has true minimize and closed-session restore hooks', () => {
  assert.doesNotMatch(appJs, /setTimeout\(\(\) => win\.classList\.remove\('minimized'\), 500\)/);
  assert.match(appJs, /restoreClosedSession/);
  assert.match(appJs, /state\.closedSessions/);
});
