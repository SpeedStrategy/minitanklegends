$dirs = @(
  "C:\Program Files\nodejs",
  "C:\Program Files (x86)\nodejs",
  "$env:LOCALAPPDATA\nvm",
  "$env:ProgramFiles\nodejs",
  "$env:LOCALAPPDATA\Programs\nodejs"
)
foreach ($d in $dirs) {
  $e = Join-Path $d "node.exe"
  if (Test-Path $e) {
    Write-Output $e
    $v = & $e --version 2>$null
    Write-Output "version=$v"
    exit 0
  }
}
Write-Output 'NO_NODE_FOUND'
