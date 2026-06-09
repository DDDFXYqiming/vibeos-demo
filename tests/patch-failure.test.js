import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const serverJs = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('sendSessionEvent surfaces a lastPatchFailed hint and consumes it once per request', () => {
  // The frontend must attach lastPatchFailed to the outbound payload so the model
  // can switch back to a full-HTML render after a broken patch.
  assert.match(appJs, /payload\.lastPatchFailed\s*=\s*true/);
  assert.match(appJs, /record\.lastPatchFailed\s*=\s*false/);
});

test('applyPatch rejection marks the session record so the next event can recover', () => {
  // When the model returned a patch but the selector did not match, the client
  // must record the failure so the next event tells the model to render fully.
  assert.match(appJs, /usedPatch\s*&&\s*!patchOk/);
  assert.match(appJs, /record\.lastPatchFailed\s*=\s*true/);
});

test('server eventPrompt injects a PATCH FEEDBACK section when lastPatchFailed is set', () => {
  // The server must include explicit recovery guidance in the next prompt,
  // not just consume the flag silently.
  assert.match(serverJs, /event\.lastPatchFailed/);
  assert.match(serverJs, /PATCH FEEDBACK/);
  assert.match(serverJs, /you MUST return a complete "html" field/);
});
