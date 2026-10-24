Set-Location "C:\Users\Nojus\Downloads\TL\MiniTankLegendsCline"

$node = "C:\Program Files\cursor\resources\app\resources\helpers\node.exe"
$file = "js\game.js"

function grep-count($pattern, $file) {
    $content = Get-Content $file -Raw
    [regex]::Matches($content, $pattern).Count
}

Write-Host "`n=== Dedup verification ===" -ForegroundColor Cyan
Write-Host "size: $((Get-Item $file).Length) bytes"
Write-Host "sendInputP2P occurrences: $(grep-count 'sendInputP2P' $file)"
Write-Host "Net.sendInputP2P(input) calls (want 1): $(grep-count 'Net\.sendInputP2P\(input\)' $file)"
Write-Host "Net.sendInput(input) fallback (want 1): $(grep-count 'Net\.sendInput\(input\)' $file)"
Write-Host "_p2pHostOptIn() defs (want 1): $(grep-count '_p2pHostOptIn\(\)' $file)"
Write-Host "_onP2PId(msg) defs (want 1): $(grep-count '_onP2PId\(msg\)' $file)"
Write-Host "Net.onP2PId assignments (want 1): $(grep-count 'Net\.onP2PId = \(msg\) =>' $file)"
Write-Host "startHost P2P opt-in checks (want 1): $(grep-count 'this\._p2pHostOptIn\(\)\)' $file)"
Write-Host "broadcastP2P calls (want 1): $(grep-count 'Net\.broadcastP2P\(' $file)"
Write-Host "transport IIFE updates (want 1): $(grep-count 'document\.getElementById\(.perfrow-transport.\)' $file)"
Write-Host "perfrow-transport total refs (want 2): $(grep-count 'perfrow-transport' $file)"
Write-Host "dev-console id refs (want 0): $(grep-count 'id=.dev-console\.' $file)"
Write-Host "P2PEnableCheck refs (want 0): $(grep-count 'P2PEnableCheck' $file)"

Write-Host "`n=== Syntax check ===" -ForegroundColor Cyan
& $node --check $file 2>&1 | Select-Object -Last 1
Write-Host "node-check exit: $LASTEXITCODE"

Write-Host "`n=== Where everything landed (line numbers) ===" -ForegroundColor Cyan
$c = Get-Content $file

Write-Host "_p2pHostOptIn() defs:"
$c | Select-String "_p2pHostOptIn\(\)" | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line)" }

Write-Host "_onP2PId(msg) defs:"
$c | Select-String "_onP2PId\(msg\)" | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line)" }

Write-Host "Net.onP2PId assignments:"
$c | Select-String "Net\.onP2PId = \(msg\) =>" | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line)" }

Write-Host "startHost P2P opt-in checks (this._p2pHostOptIn()):"
$c | Select-String "this\._p2pHostOptIn\(\)\)" | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line)" }

Write-Host "broadcastP2P calls:"
$c | Select-String "Net\.broadcastP2P\(" | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line)" }

Write-Host "Net.sendInputP2P(input) calls:"
$c | Select-String "Net\.sendInputP2P\(input\)" | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line)" }

Write-Host "transport IIFE updates (perfrow-transport getElementById):"
$c | Select-String "document\.getElementById\(.perfrow-transport.\)" | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line)" }

Write-Host "Net.sendInput(input) fallback calls:"
$c | Select-String "Net\.sendInput\(input\)" | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line)" }
