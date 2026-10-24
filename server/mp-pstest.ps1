$ErrorActionPreference = 'Stop'
$url = 'wss://tanklg.nojus-t.workers.dev/mp'
$chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
$script:code = 'T' + (-join ((1..4) | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] }))
Write-Output "ROOM CODE: $script:code"
$script:sockHost = $null
$script:sockClient = $null

function Open-Sock {
  param([string]$name)
  $c = New-Object System.Net.WebSockets.ClientWebSocket
  $cts = New-Object System.Threading.CancellationTokenSource([TimeSpan]::FromSeconds(15))
  $c.ConnectAsync([Uri]$url, $cts.Token).Wait()
  if($c.State -ne [System.Net.WebSockets.WebSocketState]::Open){ throw "$name failed: $($c.State)" }
  Write-Output "$name connected"
  if($name -eq 'host'){ $script:sockHost = $c }
  elseif($name -eq 'client'){ $script:sockClient = $c }
}

function Send-Msg {
  param([string]$name, $obj)
  $c = $null
  if($name -eq 'host'){ $c = $script:sockHost }
  elseif($name -eq 'client'){ $c = $script:sockClient }
  if($null -eq $c){ throw "no socket named $name" }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 6))
  $seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)
  $cts = New-Object System.Threading.CancellationTokenSource([TimeSpan]::FromSeconds(10))
  $c.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).Wait()
}

function Recv-Msg {
  param([string]$name, [int]$waitMs = 8000)
  $c = $null
  if($name -eq 'host'){ $c = $script:sockHost }
  elseif($name -eq 'client'){ $c = $script:sockClient }
  if($null -eq $c){ throw "no socket named $name" }
  $buf = New-Object byte[] 65536
  $deadline = [DateTime]::UtcNow.AddMilliseconds($waitMs)
  while([DateTime]::UtcNow -lt $deadline){
    $ms = New-Object System.IO.MemoryStream
    try {
      $cts = New-Object System.Threading.CancellationTokenSource([TimeSpan]::FromSeconds(2))
      $seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$buf)
      $n = $c.ReceiveAsync($seg, $cts.Token)
      $n.Wait()
    } catch { break }
    if($n.Result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close){ return @{ t='closed' } }
    [void]$ms.Write($buf, 0, $n.Result.Count)
    if(-not $n.Result.EndOfMessage){ continue }
    $txt = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    try { return ($txt | ConvertFrom-Json) } catch { Write-Output ("raw<< " + $txt) }
  }
  return @{ t = 'TIMEOUT' }
}

function Drain {
  param([string]$name, [int]$ms = 2500)
  $out = @()
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while($sw.ElapsedMilliseconds -lt $ms){
    $m = Recv-Msg -name $name -waitMs ([int]($ms - $sw.ElapsedMilliseconds + 50))
    if($m.t -eq 'TIMEOUT' -or $m.t -eq 'closed'){ break }
    $out += @($m)
  }
  return ,$out
}

function Sum($msgs){
  if(-not $msgs){ return '(nothing)' }
  return ($msgs | ForEach-Object { $_.t } | Select-Object -Unique) -join ','
}

Open-Sock 'host'
Send-Msg 'host' @{ t='hello'; name='TestHost'; tank='coolbuddy'; color='16711680' }
$w = Drain -name 'host' -ms 3000
$row = $w | Where-Object { $_.t -eq 'welcome' } | Select-Object -First 1
$hostId = $row.playerId
Write-Output ("HOST msgs: " + (Sum $w) + "  playerId=" + $hostId)

Send-Msg 'host' @{ t='host-room'; code=$script:code; maxPlayers=8; isPublic=$false }
$w = Drain -name 'host' -ms 4000
Write-Output ("HOST after host-room: " + (Sum $w))

Open-Sock 'client'
Send-Msg 'client' @{ t='hello'; name='TestJoin'; tank='coolbuddy'; color='65280' }
$w = Drain -name 'client' -ms 3000
$row2 = $w | Where-Object { $_.t -eq 'welcome' } | Select-Object -First 1
$clientId = $row2.playerId
Write-Output ("CLIENT msgs: " + (Sum $w) + "  playerId=" + $clientId)

Send-Msg 'client' @{ t='join-room'; code=$script:code }
$wj = Drain -name 'client' -ms 4000
Write-Output ("CLIENT after join-room: " + (Sum $wj))

$wh = Drain -name 'host' -ms 3000
Write-Output ("HOST after client join: " + (Sum $wh))

if(-not $clientId -or -not $hostId){
  Write-Output "MISSING IDS - aborting"
} else {
  Send-Msg 'client' @{ t='join'; name='TestJoin'; tank='coolbuddy'; color='65280' }
  $wh2 = Drain -name 'host' -ms 3000
  Write-Output ("HOST after client join-info: " + (Sum $wh2))

  Send-Msg 'host' @{ t='spawn'; to=$clientId; data=@{ t='testspawn'; x=5 } }
  $wc = Drain -name 'client' -ms 3000
  Write-Output ("CLIENT after host spawn: " + (Sum $wc))

  Send-Msg 'host' @{ t='state'; s=@{ t=1 } }
  $wc = Drain -name 'client' -ms 3000
  Write-Output ("CLIENT after host snapshot: " + (Sum $wc))
}

foreach($s in @($script:sockHost, $script:sockClient)){ try { $s.Dispose() } catch {} }
Write-Output "SIGNALING TEST DONE"
