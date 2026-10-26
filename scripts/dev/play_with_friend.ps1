param([switch]$NoBrowser)

Write-Host "=== Mini Tank Legends - Multiplayer Launcher ===" -ForegroundColor Cyan
Write-Host ""

$GameDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "..\..")).Path
Set-Location $GameDir

# Kill existing node on port 3120
$existing = netstat -ano 2>&1 | Select-String ":3120 "
if ($existing) {
    $pidToKill = $existing -replace '.*\s+(\d+)\s*$', '$1'
    if ($pidToKill -match '^\d+$') {
        Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
        Start-Sleep 1
    }
}

# Start node server
Write-Host "Starting game server..." -ForegroundColor Yellow
$nodeJob = Start-Job -ScriptBlock { param($d) Set-Location $d; node server.js } -ArgumentList $GameDir
Start-Sleep 3

# Check server
try {
    $r = Invoke-WebRequest -Uri http://localhost:3120/ -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    Write-Host "✓ Server running on port 3120" -ForegroundColor Green
} catch {
    Write-Host "✗ Server failed to start!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Try serveo tunnel
Write-Host "Creating internet tunnel (this may take a moment)..." -ForegroundColor Yellow
$tunnelJob = Start-Job -ScriptBlock {
    ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:127.0.0.1:3120 serveo.net 2>&1
}
Start-Sleep 12

$tunnelOut = Receive-Job $tunnelJob -Keep 2>&1
$urlMatch = [regex]::Match($tunnelOut, 'https://[a-z0-9-]+\.serveousercontent\.com')
$tunnelUrl = ""

if ($urlMatch.Success) {
    $tunnelUrl = $urlMatch.Value
    Write-Host ""
    Write-Host "══════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  GAME IS LIVE! Share this link with your friend:" -ForegroundColor Green
    Write-Host "  $tunnelUrl" -ForegroundColor White -BackgroundColor Black
    Write-Host "══════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "One player clicks HOST, the other clicks JOIN." -ForegroundColor Yellow
    Write-Host "The host shares their 6-character room code." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "NOTE: This tunnel has no uptime guarantee." -ForegroundColor DarkYellow
    Write-Host "      Keep this window open while playing!" -ForegroundColor DarkYellow
    Write-Host ""
    
    if (-not $NoBrowser) {
        Start-Process $tunnelUrl
        Write-Host "Opened browser to game URL" -ForegroundColor Green
    }
    
    Write-Host "Press Ctrl+C to stop the server and tunnel." -ForegroundColor Magenta
    Write-Host ""
    
    # Keep the tunnel alive - monitor it
    while ($true) {
        Start-Sleep 30
        $tState = Get-Job -Id $tunnelJob.Id -ErrorAction SilentlyContinue | Select-Object -ExpandProperty State
        $nState = Get-Job -Id $nodeJob.Id -ErrorAction SilentlyContinue | Select-Object -ExpandProperty State
        if ($tState -eq 'Failed') {
            Write-Host "Tunnel disconnected. Restarting..." -ForegroundColor Red
            # Could try to restart here
        }
        if ($nState -eq 'Failed') {
            Write-Host "Server crashed!" -ForegroundColor Red
            break
        }
        Write-Host "." -NoNewline -ForegroundColor DarkGreen
    }
} else {
    Write-Host "✗ Failed to create tunnel" -ForegroundColor Red
    Write-Host "Output: $tunnelOut" -ForegroundColor DarkRed
    Write-Host ""
    Write-Host "Alternative: Your friend can connect directly if you:" -ForegroundColor Yellow
    Write-Host "  1. Forward port 3120 on your router" -ForegroundColor Yellow
    Write-Host "  2. Share your public IP:port" -ForegroundColor Yellow
    Write-Host "  Your local game is at: http://localhost:3120" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
}

# Cleanup on exit
Stop-Job $nodeJob -ErrorAction SilentlyContinue
Stop-Job $tunnelJob -ErrorAction SilentlyContinue
