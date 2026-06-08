# Stop the VibeOS demo listening on port 8765.
# Script must be run from the vibeos-demo project root.
$ErrorActionPreference = 'SilentlyContinue'
Get-NetTCPConnection -LocalPort 8765 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Write-Host "Stopped any process listening on port 8765."
