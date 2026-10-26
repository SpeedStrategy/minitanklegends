$ErrorActionPreference = 'Stop'
$port = 18499
$root = 'C:\Users\Nojus\Downloads\TL\MiniTankLegendsCline'
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()
Write-Output ("SERVING " + $root)
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($rel -eq '/') { $rel = '/out-tests/aim-harness.html' }
    $file = Join-Path $root ($rel -replace '/', '\')
    if ((Test-Path $file -PathType Leaf) -and ((Resolve-Path $file).Path.StartsWith($root))) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
    } else {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('not found'); $ctx.Response.StatusCode = 404
    }
    $ct = if ($file -match '\.html$') { 'text/html; charset=utf-8' } else { 'text/javascript; charset=utf-8' }
    $ctx.Response.ContentType = $ct
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.OutputStream.Close()
  }
} finally { $listener.Stop() }
