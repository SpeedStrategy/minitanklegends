$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\Nojus\Downloads\TL\MiniTankLegendsCline'

# Files whose working-tree copies currently hold unfinished merge-conflict
# markers. Deploy-line (cf-dist) code is what production actually runs, so for
# each of these the working tree is reset to the CURRENT BRANCH's committed
# version (deploy-p2p-fix / origin/main) — which is also what was deployed.
# Files NOT in this list (game.js, tank.js, net.js) keep their working-tree
# versions, which are the verified deploy-line code carrying the netcode fix.
$files = @(
  'js/audio.js','js/auth.js','js/config.js','js/input.js','js/menu.js',
  'js/models.js','js/net.js','js/projectile.js','js/tank-editor.js',
  'js/world.js','index.html','css/style.css','wrangler.toml'
)
git checkout HEAD -- $files
if ($LASTEXITCODE -ne 0) { Write-Output "CHECKOUT_FAILED exit=$LASTEXITCODE"; exit 1 }

Write-Output '--- Remaining merge-marker files:'
$bad = @()
foreach ($f in @((Get-ChildItem -Path js -Filter *.js | Select-Object -ExpandProperty FullName) + @((Join-Path (Get-Location) 'index.html'), (Join-Path (Get-Location) 'css\style.css'), (Join-Path (Get-Location) 'wrangler.toml')))) {
  if ((Get-Content $f -Raw -ErrorAction SilentlyContinue) -match '<<<<<<< Updated upstream') {
    $bad += (Split-Path $f -Leaf)
  }
}
if ($bad.Count) { Write-Output ($bad -join ', '); exit 1 } else { Write-Output 'NONE' }

Write-Output '--- Fix markers still present in deploy-line files:'
$t = Select-String -Path js\tank.js -Pattern 'y: this._allowFall' -SimpleMatch
$g = Select-String -Path js\game.js -Pattern 'snapInterval = 0.05' -SimpleMatch
Write-Output ("tank.js y-marker: " + ($t -ne $null) + "  game.js rate-marker: " + ($g -ne $null))
if (-not $t -or -not $g) { exit 1 }
