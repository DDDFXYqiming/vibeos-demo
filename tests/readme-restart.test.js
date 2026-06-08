import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const restart = fs.readFileSync(new URL('../restart.ps1', import.meta.url), 'utf8');
const stop = fs.readFileSync(new URL('../stop.ps1', import.meta.url), 'utf8');

test('README keeps start and stop commands inside fenced powershell blocks', () => {
  assert.match(readme, /```powershell[\s\S]*Stop-Process[\s\S]*```/);
  assert.match(readme, /```powershell[\s\S]*node src\/server\.js[\s\S]*```/);
});

test('README recommends the new restart and stop helper scripts', () => {
  assert.match(readme, /\\restart\.ps1/);
  assert.match(readme, /\\stop\.ps1/);
});

test('standalone restart script kills the existing listener and starts a fresh server', () => {
  assert.match(restart, /Stop-Process -Id \$conn\.OwningProcess/);
  assert.match(restart, /Start-Sleep -Seconds 1/);
  assert.match(restart, /node src\/server\.js/);
  assert.match(restart, /Script must be run from the vibeos-demo project root/);
});

test('standalone stop script targets only the VibeOS node listener on port 8765', () => {
  assert.match(stop, /Get-NetTCPConnection -LocalPort 8765/);
  assert.match(stop, /Stop-Process -Id \$conn\.OwningProcess/);
});
