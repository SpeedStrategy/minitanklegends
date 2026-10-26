$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($null -ne $cmd) {
  Write-Output "cmd-path=$($cmd.Source)"
  $v = & $cmd.Source --version 2>&1
  Write-Output "cmd-version=$v"
} else {
  Write-Output "cmd-node=not_on_path"
}

$needle = "node.exe"
$candidates = @(
  "C:\Program Files\nodejs",
  "C:\Program Files (x86)\nodejs",
  "$env:LOCALAPPDATA\nvm",
  "$env:ProgramFiles\nodejs",
  "$env:LOCALAPPDATA\Programs\nodejs"
)
$found = $null
foreach ($d in $candidates) {
  if (Test-Path (Join-Path $d $needle)) {
    $found = (Join-Path $d $needle)
    break
  }
}
if ($null -ne $found) {
  Write-Output "disk-node=$found"
  $v = & $found --version 2>&1
  Write-Output "disk-version=$v"
} else {
  $g = Get-ChildItem -Path $env:ProgramFiles, "$env:ProgramFiles (x86)", $env:LOCALAPPDATA -Recurse -File -ErrorAction SilentlyContinue -Filter $needle | Select-Object -First 1 -ExpandProperty FullName
  if ($g) {
    Write-Output "disk-node=$g"
    $v = & $g --version 2>&1
    Write-Output "disk-version=$v"
  } else {
    Write-Output "disk-node=none"
  }
}
