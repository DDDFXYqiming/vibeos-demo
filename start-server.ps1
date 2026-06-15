$proc = Start-Process -FilePath "node" -ArgumentList "src/server.js" -WorkingDirectory "E:\AI_Projects\vibeos-demo" -WindowStyle Hidden -PassThru
Write-Output "Started node with PID: $($proc.Id)"
Start-Sleep -Seconds 3
$conn = Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue
if ($conn) {
    Write-Output "Port 8765 listening by PID: $($conn.OwningProcess)"
} else {
    Write-Output "Port 8765 not listening"
}