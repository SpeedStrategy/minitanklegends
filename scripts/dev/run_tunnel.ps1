param([int]$Port=3120)
$url = ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:$Port serveo.net 2>&1 | Select-String -Pattern 'https://[a-z0-9-]+\.serveousercontent\.com'
if ($url) {
  $url -match 'https://[a-z0-9-]+\.serveousercontent\.com' | Out-Null
  $tunnelUrl = $matches[0]
  Write-Output "TUNNEL_URL: $tunnelUrl"
  # Keep script running until interrupted
  while ($true) { Start-Sleep 10 }
} else {
  Write-Output "Failed to create tunnel"
}
