# ============================================================================
#  deploy-pages.ps1 -- publish tanklg.pages.dev from this directory.
#
#  ASCII ONLY, DELIBERATELY.
#
#  Windows PowerShell 5.1 reads a .ps1 as ANSI unless it starts with a UTF-8
#  BOM. The first version of this file used em-dashes in its comments and in
#  one string; read as CP1252, the bytes E2 80 94 become "a-currency-sign and a
#  RIGHT DOUBLE QUOTATION MARK, and PowerShell accepts a curly quote as a string
#  delimiter. So an em-dash in a sentence silently terminated the string three
#  words early and the whole script died as a parse error before running a single
#  line. No type-checks, no test, nothing -- just a file that refuses to parse.
#
#  Use plain ASCII in PowerShell here. It costs nothing and it cannot happen.
#
#  WHY THIS IS A SCRIPT AND NOT A ONE-LINER
#  ---------------------------------------
#  Pages refuses a deployment if any single file in the upload exceeds 25 MiB.
#  Two files here are over that line and neither is ever fetched by the game:
#
#      assets/maps/core2.blend                      89.3 MiB   Blender source
#      .git-corrupt/objects/pack/pack-eb82f95e...   27.9 MiB   corrupt snapshot
#
#  .assetsignore LOOKS like the answer, and its own header says it solved this
#  exact error. It does not -- not for Pages. .assetsignore is read by
#  buildAssetManifest(), which is the WORKERS static-asset pipeline
#  (wrangler deploy, and tools/build-cloudflare.js for the Worker).
#
#  "wrangler pages deploy" takes a different path: validate() walks the
#  directory with a short hardcoded list -- _worker.js, _redirects, _headers,
#  _routes.json, functions, .DS_Store, node_modules, .git, .wrangler -- and
#  throws on the first oversized file it meets. .assetsignore is never opened.
#  There is no flag to skip it.
#
#  So the files have to actually be gone from the tree while the deploy runs.
#
#  WHY THEY ARE MOVED RATHER THAN DELETED
#  --------------------------------------
#  Because they are somebody's files. core2.blend is a Blender authoring source
#  that costs nothing to keep and cannot be reconstructed; the pack is the
#  evidence behind the note in .gitignore about the 2026-09-05 repository. A
#  deploy script that deletes them to make itself work is not a deploy script,
#  it is data loss with a progress bar.
#
#  They go to a holding folder for the duration and come back in a `finally`,
#  so a failed deploy, a thrown error or Ctrl+C all still restore them. On top
#  of that the restore is verified, and the script refuses to report success if
#  anything is still sitting in the holding folder afterwards.
#
#  WHAT IT CHANGED ABOUT THE UPLOAD
#  --------------------------------
#  Nothing. The same files go up as before, because the two that are moved are
#  exactly the two that could not go up anyway.
#
#  Worth knowing, though it is not changed here: the site currently publishes
#  .git-corrupt/, test/, tools/ and friends as public static files, because
#  .assetsignore does not apply to a Pages deploy. Stopping that is a real
#  improvement, but it changes what the site publishes and belongs in its own
#  deploy with its own testing, not smuggled in here as a side effect.
#
#  Run:  powershell -ExecutionPolicy Bypass -File deploy-pages.ps1
# ============================================================================

$ErrorActionPreference = 'Stop'

$Root      = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Project   = 'tanklg'
$Branch    = 'main'
$MAX_BYTES = 25MB

# ----------------------------------------------------------------------------
#  Wrangler.
#
#  Two installs exist on this machine and only one works. The copy under
#  %TEMP%\opencode\cfdeploy was bootstrapped from a tarball and is missing its
#  templates/ directory, so "wrangler pages deploy" dies with
#
#      Could not resolve ".../wrangler/templates/pages-template-worker.ts"
#
#  before it looks at a single asset. The project's own node_modules copy is
#  complete and a version newer. Require it, and fail loudly rather than
#  silently falling back to the broken one.
# ----------------------------------------------------------------------------
$Node = 'C:\Program Files\cursor\resources\app\resources\helpers\node.exe'
if (-not (Test-Path $Node)) {
  $Node = (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $Node) { throw "node not found" }

$Wrangler = Join-Path $Root 'node_modules\wrangler\bin\wrangler.js'
if (-not (Test-Path $Wrangler)) {
  throw ("wrangler not found at " + $Wrangler + ". Install it in the project:" +
         "`n`n    npm install --no-save wrangler" +
         "`n`nDo NOT point this at %TEMP%\opencode\cfdeploy\env\node_modules\wrangler." +
         "`nThat copy has no templates/ directory and cannot deploy Pages at all.")
}
$Template = Join-Path $Root 'node_modules\wrangler\templates\pages-template-worker.ts'
if (-not (Test-Path $Template)) {
  throw ("wrangler at " + $Wrangler + " is missing templates/pages-template-worker.ts." +
         "`nReinstall it:  npm install --no-save wrangler")
}

# Wrangler reads every staged asset into memory to build the upload manifest.
# Node's default heap is not enough for a tree this size.
$env:NODE_OPTIONS = '--max-old-space-size=3072'

# ----------------------------------------------------------------------------
#  Wrangler's own hardcoded excludes for "pages deploy", mirrored here.
#
#  Copied from wrangler's validate() rather than invented, because this list and
#  this script have to agree: anything this script moves must be something
#  wrangler would otherwise have tried to walk.
# ----------------------------------------------------------------------------
$WranglerSkips = @('_worker.js', '_redirects', '_headers', '_routes.json')

function Test-WranglerSkip([string]$rel) {
  if ($WranglerSkips -contains $rel) { return $true }
  if ($rel -eq 'functions' -or $rel -like 'functions/*') { return $true }
  if ($rel -like '*/node_modules/*' -or $rel -like 'node_modules/*') { return $true }
  if ($rel -like '*/.git/*'       -or $rel -like '.git/*')       { return $true }
  if ($rel -like '*/.DS_Store')    { return $true }
  if ($rel -like '.wrangler' -or $rel -like '.wrangler/*') { return $true }
  return $false
}

# ----------------------------------------------------------------------------
#  Find the oversized files.
#
#  Computed, never hardcoded. Somebody drops a 30 MB texture in here in six
#  months and this keeps working; a hardcoded list quietly stops working the day
#  the files are renamed.
# ----------------------------------------------------------------------------
$oversized = @(Get-ChildItem -LiteralPath $Root -File -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object {
    $rel = $_.FullName.Substring($Root.Length + 1) -replace '\\', '/'
    (-not (Test-WranglerSkip $rel)) -and $_.Length -gt $MAX_BYTES
  })

Write-Host "`n[1/3] Checking for files over the 25 MiB Pages limit..." -ForegroundColor Cyan
if ($oversized.Count -eq 0) {
  Write-Host "  None. Nothing to move aside." -ForegroundColor DarkGray
} else {
  Write-Host ("  Found {0}. Never fetched by the game, and Pages cannot accept them:" -f $oversized.Count)
  foreach ($f in $oversized) {
    $rel = $f.FullName.Substring($Root.Length + 1)
    Write-Host ("    {0,7:N1} MiB  {1}" -f ($f.Length / 1MB), $rel) -ForegroundColor DarkYellow
  }
}

# ----------------------------------------------------------------------------
#  Move aside, deploy, restore.
# ----------------------------------------------------------------------------
$Hold = Join-Path $env:TEMP ("mtl-pages-hold-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$moved = @()
$exit = 1

try {
  if ($oversized.Count -gt 0) {
    Write-Host "`n[2/3] Holding them aside for the duration..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $Hold -Force | Out-Null
    foreach ($f in $oversized) {
      # Mirror the relative path so two same-named files in different folders
      # cannot land on top of each other in the holding folder.
      $rel     = $f.FullName.Substring($Root.Length + 1)
      $dest    = Join-Path $Hold $rel
      $destDir = Split-Path $dest -Parent
      if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
      Move-Item -LiteralPath $f.FullName -Destination $dest -Force
      $moved += [pscustomobject]@{ From = $f.FullName; To = $dest; Rel = $rel }
      Write-Host ("    held  " + $rel) -ForegroundColor DarkGray
    }
  } else {
    Write-Host "`n[2/3] Nothing to hold." -ForegroundColor Cyan
  }

  # ==========================================================================
  #  index.html MUST KEEP ITS BYTE ORDER MARK.
  # ==========================================================================
  #  The page ships with a UTF-8 BOM and it is load-bearing enough to be worth
  #  a guard here: rewriting index.html with New-Object UTF8Encoding $false
  #  strips it, the non-ASCII count drops from 129 to 128, and nothing reports
  #  a problem. The page still renders, which is exactly why it is dangerous.
  #
  #  The count is the cheap check and the BOM is the real one, so both run.
  #  Deploying is the wrong moment to discover either.
  $indexPath = Join-Path $Root 'index.html'
  if (Test-Path -LiteralPath $indexPath) {
    $ib = [System.IO.File]::ReadAllBytes($indexPath)
    $hasBom = ($ib.Length -ge 3 -and $ib[0] -eq 0xEF -and $ib[1] -eq 0xBB -and $ib[2] -eq 0xBF)
    $nonAscii = ([regex]::Matches([System.Text.Encoding]::UTF8.GetString($ib), '[^\x00-\x7F]')).Count
    if (-not $hasBom -or $nonAscii -ne 129) {
      Write-Host ("`n  REFUSING TO DEPLOY: index.html is not in its expected encoding." ) -ForegroundColor Red
      Write-Host ("    BOM present : " + $hasBom + "   (expected True)")  -ForegroundColor Red
      Write-Host ("    non-ASCII   : " + $nonAscii  + "   (expected 129)") -ForegroundColor Red
      Write-Host ("    If you rewrote it, write it back with a BOM:") -ForegroundColor DarkYellow
      Write-Host ("      `$t = [System.IO.File]::ReadAllText(`$p, [System.Text.Encoding]::UTF8)") -ForegroundColor DarkYellow
      Write-Host ("      [System.IO.File]::WriteAllText(`$p, `$t, (New-Object System.Text.UTF8Encoding `$true))") -ForegroundColor DarkYellow
      throw "index.html encoding guard failed."
    }
    Write-Host ("  index.html encoding OK (BOM, 129 non-ASCII)") -ForegroundColor DarkGray
  }

  Write-Host ("`n[3/3] Deploying to https://" + $Project + ".pages.dev ...") -ForegroundColor Cyan
  & $Node $Wrangler pages deploy --project-name $Project --branch $Branch `
      --commit-dirty=true `
      --commit-message ("Deploy " + (Get-Date -Format 'yyyy-MM-dd HH:mm')) 2>&1
  $exit = $LASTEXITCODE

  # ==========================================================================
  #  VERIFY WHAT WENT OUT, AGAINST WHAT IS ACTUALLY SERVED.
  # ==========================================================================
  #  A deploy that "succeeds" is not evidence that the right bytes are live,
  #  and the two ways it goes wrong point in opposite directions:
  #
  #    * A missing asset returns index.html with HTTP 200 (the SPA fallback).
  #      Byte comparison catches this immediately, because an HTML page is not
  #      a GLB. Checking the status code alone reports success.
  #
  #    * An asset that WAS deployed correctly can still be served from
  #      Cloudflare's edge cache. This happened with TL_signal_map.glb: the
  #      local file was the corrected 1,728 KB and the deployed one was the
  #      older 1,328 KB, and it read exactly like a failed deploy. Sending
  #      Cache-Control: no-cache returned the right file immediately.
  #
  #  So a cache-busting query alone is NOT enough to rule the cache out -- the
  #  no-cache header is what actually does it. Both are sent.
  if ($exit -eq 0) {
    Write-Host "`n  Verifying against the live site..." -ForegroundColor Cyan
    $Stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $Probe = @{
      'js/game.js'          = 'js/game.js'
      'js/projectile.js'    = 'js/projectile.js'
      'js/world.js'         = 'js/world.js'
      'js/tank.js'          = 'js/tank.js'
      'js/capture-circle.js'= 'js/capture-circle.js'
      'js/map-voting.js'    = 'js/map-voting.js'
      'js/config.js'        = 'js/config.js'
      'assets/maps/TL_signal_map.glb' = 'assets/maps/TL_signal_map.glb'
    }
    $bad = 0
    foreach ($k in $Probe.Keys) {
      $rel  = $Probe[$k]
      $dest = Join-Path $Root ($rel -replace '/', '\')
      if (-not (Test-Path -LiteralPath $dest)) { continue }
      $tmp = Join-Path $env:TEMP ('mtlverify_' + [System.IO.Path]::GetRandomFileName())
      try {
        Invoke-WebRequest ("https://" + $Project + ".pages.dev/" + $rel + "?cb=" + $Stamp) `
            -UseBasicParsing -TimeoutSec 300 -Headers @{ 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache' } `
            -OutFile $tmp
        $same = (Get-FileHash $tmp).Hash -eq (Get-FileHash $dest).Hash
        if ($same) {
          Write-Host ("    ok    " + $rel) -ForegroundColor DarkGray
        } else {
          Write-Host ("    WRONG " + $rel + "  remote=" + (Get-Item $tmp).Length + "B local=" + (Get-Item $dest).Length + "B") -ForegroundColor Red
          $bad++
        }
      } catch {
        Write-Host ("    FAIL  " + $rel + "  " + $_.Exception.Message) -ForegroundColor Red
        $bad++
      } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      }
    }
    if ($bad -eq 0) {
      Write-Host "  Live site matches this directory." -ForegroundColor Green
    } else {
      Write-Host ("  " + $bad + " file(s) on the live site do NOT match this directory.") -ForegroundColor Red
      Write-Host "  The deploy reported success, so this is a cache or partial-upload problem." -ForegroundColor DarkYellow
    }
  }

} finally {
  # Always runs. Ctrl+C, a thrown error, a failed deploy -- the files come back.
  if ($moved.Count -gt 0) {
    Write-Host "`n  Restoring held files..." -ForegroundColor Cyan
    foreach ($m in $moved) {
      if (Test-Path -LiteralPath $m.To) {
        Move-Item -LiteralPath $m.To -Destination $m.From -Force
        Write-Host ("    back  " + $m.Rel) -ForegroundColor DarkGray
      }
    }
  }
  if (Test-Path -LiteralPath $Hold) {
    Remove-Item -LiteralPath $Hold -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ----------------------------------------------------------------------------
#  Verify. A deploy script that silently eats a file is worse than one that
#  fails, so this is checked rather than assumed.
# ----------------------------------------------------------------------------
Write-Host ""
$missing = @($moved | Where-Object { -not (Test-Path -LiteralPath $_.From) })
if ($missing.Count -gt 0) {
  Write-Host ("  THESE FILES WERE NOT PUT BACK. They are still in " + $Hold) -ForegroundColor Red
  foreach ($m in $missing) { Write-Host ("    " + $m.Rel) -ForegroundColor Red }
  Write-Host "  Do not delete that folder." -ForegroundColor Red
  exit 1
}
if ($moved.Count -gt 0) { Write-Host "  All held files are back where they belong." -ForegroundColor DarkGray }

if ($exit -ne 0) { throw ("wrangler pages deploy failed with exit code " + $exit) }

Write-Host ("`n  Deployed: https://" + $Project + ".pages.dev") -ForegroundColor Green