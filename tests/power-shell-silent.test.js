import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const restart = fs.readFileSync(new URL('../restart.ps1', import.meta.url), 'utf8');
const stop = fs.readFileSync(new URL('../stop.ps1', import.meta.url), 'utf8');

test('restart.ps1 silently skips the CIM query when no listener exists', () => {
  assert.match(restart, /Get-NetTCPConnection[\s\S]*-ErrorAction SilentlyContinue/);
  assert.match(restart, /Stop-Process[\s\S]*-ErrorAction SilentlyContinue/);
});

test('stop.ps1 silently skips the CIM query when no listener exists', () => {
  assert.match(stop, /Get-NetTCPConnection[\s\S]*-ErrorAction SilentlyContinue/);
  assert.match(stop, /Stop-Process[\s\S]*-ErrorAction SilentlyContinue/);
});

test('restart.ps1 still waits one second and starts the node server', () => {
  assert.match(restart, /Start-Sleep -Seconds 1/);
  assert.match(restart, /node src\/server\.js/);
});

test('stop.ps1 announces it stopped listening processes', () => {
  assert.match(stop, /Write-Host "Stopped any process listening on port 8765\."/);
});
