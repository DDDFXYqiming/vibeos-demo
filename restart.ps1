# Restart the VibeOS demo.
# Script must be run from the vibeos-demo project root.
# Stops any existing listener on port 8765, waits one second, then starts a fresh server.
$ErrorActionPreference = 'SilentlyContinue'
# Get-NetTCPConnection returns a non-terminating error when nothing matches.
# Suppress it inline so a clean restart does not show a red CIM stack.
$listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $listener) {
  Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Host "Created .env from .env.example. Edit it to set your API key before use." -ForegroundColor Yellow
}
Write-Host "Starting VibeOS demo..." -ForegroundColor Cyan
node src/server.js
