$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 20+ is required. Install from https://nodejs.org/ and rerun this script." -ForegroundColor Red
  exit 1
}

$nodeVersionText = node -v
$major = [int]($nodeVersionText.TrimStart('v').Split('.')[0])
if ($major -lt 20) {
  Write-Host "Node.js 20+ is required. Current: $nodeVersionText" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example. Default provider is mock mode." -ForegroundColor Yellow
}

Write-Host "Starting VibeOS demo..." -ForegroundColor Cyan
node src/server.js
