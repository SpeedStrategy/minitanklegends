$ErrorActionPreference = 'SilentlyContinue'
$places = @(
  "$env:LOCALAPPDATA\tools\nodejs\node.exe",
  "$env:LOCALAPPDATA\nodejs\node.exe",
  "$env:ProgramFiles\nodejs\node.exe",
  "${env:ProgramFiles(x86)}\nodejs\node.exe",
  "C:\tools\node.exe",
  "C:\ProgramData\chocolatey\bin\node.exe",
  "$env:LOCALAPPDATA\Programs\fnm\nodejs\$((Get-Item $env:LOCALAPPDATA\AppData\Local\Programs\fnm\nodejs 2>$null).Name | Select-Object -Last 1)\node.exe"
)
Write-Output '--- scanning for node ---'
foreach ($p in $places) {
  if (Test-Path $p) { Write-Output "FOUND $p"; return }
}
Write-Output 'NO-NODE'
