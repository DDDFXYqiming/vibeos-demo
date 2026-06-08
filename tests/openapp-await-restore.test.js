import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('openApp awaits restoreClosedSession instead of treating the Promise as truthy', () => {
  // The bug: `if (restoreClosedSession(...)) return;` always returns because
  // an async function returns a Promise (always truthy). The fix is `await`.
  const line = appJs.split('\n').find(l => l.includes('restoreClosedSession') && l.includes('return'));
  assert.ok(line, 'openApp must call restoreClosedSession');
  assert.match(
    line,
    /await\s+restoreClosedSession/,
    'restoreClosedSession must be awaited; without await the Promise is always truthy and openApp never creates a window'
  );
});
