# Stop the VibeOS demo listening on port 8765.
# Script must be run from the vibeos-demo project root.
$ErrorActionPreference = 'SilentlyContinue'
# Get-NetTCPConnection returns a non-terminating error when nothing matches.
# Suppress it inline so an empty restart path does not show a red CIM stack.
$listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $listener) {
  Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
}
Write-Host "Stopped any process listening on port 8765."
