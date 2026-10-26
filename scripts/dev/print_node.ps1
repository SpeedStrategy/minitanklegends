$dirs = @(
  "C:\Program Files\nodejs",
  "C:\Program Files (x86)\nodejs",
  "$env:LOCALAPPDATA\nvm",
  "$env:ProgramFiles\nodejs",
  "$env:LOCALAPPDATA\Programs\nodejs"
)
$found = $null
foreach ($d in $dirs) {
  $e = Join-Path $d "node.exe"
  if (Test-Path $e) {
    $found = $e
    break
  }
}
if ($null -eq $found) {
  Write-Error "NO_NODE_FOUND"
  exit 1
}
Write-Output $found
$v = & $found --version 2>&1
Write-Output "version=$v"
