# dedup-all.ps1 — remove duplicated P2P blocks from js/game.js
Set-Location "C:\Users\Nojus\Downloads\TL\MiniTankLegendsCline"

$node = "C:\Program Files\cursor\resources\app\resources\helpers\node.exe"
$gameJs = "js\game.js"

function Get-ContentRaw($path) {
    return [System.IO.File]::ReadAllText($path)
}

function Set-ContentRaw($path, $content) {
    [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
}

function Find-Pattern($content, $pattern, $startIndex = 0) {
    $idx = $content.IndexOf($pattern, $startIndex, [StringComparison]::Ordinal)
    return $idx
}

function Count-Pattern($content, $pattern) {
    $count = 0
    $idx = 0
    while (($idx = $content.IndexOf($pattern, $idx, [StringComparison]::Ordinal)) -ge 0) {
        $count++
        $idx += $pattern.Length
    }
    return $count
}

$content = Get-ContentRaw $gameJs
$originalLen = $content.Length
$changes = @()

# ── 1. sendInputP2P duplicate ──────────────────────────────────────────────
# There are TWO "typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)"
# inside the same if(this.mode==='client') block. Find the SECOND occurrence
# and remove the nested duplicate.

$pat1 = "typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)"
$first = Find-Pattern $content $pat1
$second = Find-Pattern $content $pat1, $first + 1

if ($second -ge 0) {
    # The duplicate nested block starts at the second "if(typeof Net !== 'undefined'..."
    # Find the start of that nested if (search backwards from second occurrence)
    $nestedIfStart = $content.LastIndexOf("if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&", $second)
    if ($nestedIfStart -ge 0) {
        # Find the end of this nested block: the "} else {" that closes it,
        # then the final "Net.sendInput(input);" and closing "}"
        # The nested block ends at "} else { Net.sendInput(input); }" followed by "        }" (closing outer if)
        $afterNested = $content.IndexOf("Net.sendInput(input);", $second)
        if ($afterNested -ge 0) {
            $endOfNested = $content.IndexOf("}", $afterNested + 16)
            if ($endOfNested -ge 0) {
                # Remove from nestedIfStart to endOfNested+1
                $removed = $endOfNested + 1 - $nestedIfStart
                $content = $content.Substring(0, $nestedIfStart) + $content.Substring($endOfNested + 1)
                $changes += "Removed nested sendInputP2P duplicate at char $nestedIfStart (removed $removed chars)"
                Write-Host "Removed nested sendInputP2P duplicate (chars $nestedIfStart..$endOfNested, $removed chars)" -ForegroundColor Green
            }
        }
    }
}

# Re-read content after first change
$content = Get-ContentRaw $gameJs

# ── 2. _p2pHostOptIn + _onP2PId duplicate ──────────────────────────────────
# There are TWO definitions of each. Find the second _p2pHostOptIn() def.

$pat2 = "`n  _p2pHostOptIn(){`n    try {`n      return !!(this.settings && this.settings.p2pHostFastPath === true);`n    } catch(e){`n      return false;`n    }`n  }`n"
$first2 = Find-Pattern $content $pat2
$second2 = Find-Pattern $content $pat2, $first2 + 1

if ($second2 -ge 0) {
    # Find the _onP2PId def that follows
    $onP2PIdPat = "`n  _onP2PId(msg){`n    if(!msg || typeof msg !== 'object') return;`n    if(msg.to != null){`n      // Host -> client: this is the host's P2P id.`n      if(typeof Net !== 'undefined' && Net.p2p){`n        Net.p2p.hostId = msg.p2pId || null;`n        if(typeof Net.setP2PHostId === 'function') Net.setP2PHostId(Net.p2p.hostId);`n        if(Net.p2p.enabled){`n          if(typeof Net.openP2PToHost === 'function') Net.openP2PToHost();`n          if(typeof Net.startP2PRetries === 'function') Net.startP2PRetries();`n        }`n      }`n      return;`n    }`n    // Client -> host: this client's P2P id.`n    if(msg.p2pId && this.mode==='host' && typeof Net !== 'undefined' && Net.p2p){`n      if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, msg.p2pId);`n    }`n  }`n"
    $onP2PIdIdx = Find-Pattern $content $onP2PIdPat, $second2
    if ($onP2PIdIdx -ge 0) {
        # Remove from second2 to onP2PIdIdx (the duplicate _p2pHostOptIn + _onP2PId)
        $removed = $onP2PIdIdx + $onP2PIdPat.Length - $second2
        $content = $content.Substring(0, $second2) + $content.Substring($onP2PIdIdx + $onP2PIdPat.Length)
        $changes += "Removed duplicate _p2pHostOptIn+_onP2PId at char $second2 (removed $removed chars)"
        Write-Host "Removed duplicate _p2pHostOptIn+_onP2PId (chars $second2..$($onP2PIdIdx + $onP2PIdPat.Length), $removed chars)" -ForegroundColor Green
    } else {
        Write-Host "WARN: could not find _onP2PId after second _p2pHostOptIn" -ForegroundColor Yellow
    }
}

# ── 3. Net.onP2PId assignment duplicate ────────────────────────────────────
$pat3 = "    Net.onP2PId = (msg) => this._onP2PId(msg);`n`n    // Send our P2P id to the host as soon as we have one, over the relay (the`n    // channel we are about to open cannot carry the first one).`n    if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.myId){`n      try{ if(typeof Net.sendP2PId === 'function') Net.sendP2PId(Net.p2p.myId); }catch(e){}`n    }`n`n    // If the host turned the P2P fast path on, take it.`n    if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId){`n      Net.p2p.myId = Net._p2pId();`n      Net.p2p.roles[Net.p2p.myId] = 'client';`n      if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, Net.p2p.myId);`n      if(typeof Net.openP2PToHost === 'function') Net.openP2PToHost();`n      if(typeof Net.startP2PRetries === 'function') Net.startP2PRetries();`n    } else {`n      // Tell the host our P2P id anyway, so if the host turns P2P on later (it does`n      // not, but a reconnect/resume path may), the host already knows how to reach us.`n      if(typeof Net !== 'undefined' && Net.p2p){`n        Net.p2p.myId = Net._p2pId();`n        if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, Net.p2p.myId);`n        try{ if(typeof Net.sendP2PId === 'function') Net.sendP2PId(Net.p2p.myId); }catch(e){}`n      }`n    }`n"
$first3 = Find-Pattern $content $pat3
$second3 = Find-Pattern $content $pat3, $first3 + 1

if ($second3 -ge 0) {
    $removed = $pat3.Length
    $content = $content.Substring(0, $second3) + $content.Substring($second3 + $pat3.Length)
    $changes += "Removed duplicate Net.onP2PId block at char $second3 (removed $removed chars)"
    Write-Host "Removed duplicate Net.onP2PId block (chars $second3..$($second3 + $pat3.Length), $removed chars)" -ForegroundColor Green
}

# ── 4. startHost P2P block duplicate ───────────────────────────────────────
$pat4 = "`n    /* P2P fast path. Only the host decides this, because only the host owns the`n       simulation and only the host has a channel for every client to dial. When the`n       host opts in, the host gets a P2P id, tells the clients what it is, and the`n       clients open a direct channel to it. When the host does not opt in, or when`n       WebRTC is unavailable, every byte still goes over the server relay exactly as`n       before — there is no dead path here, only a faster one when it works.`n`n       The toggle the host sets in the multiplayer networking settings is the single`n       source of truth for this match. It is NOT auto-enabled, because auto-enabling`n       would change a match's behaviour depending on a client's browser, which is the`n       kind of invisible change that is impossible to debug. */`n    if(typeof Net !== 'undefined' && Net.p2p && this._p2pHostOptIn()){`n      Net.p2p.enabled = true;`n      Net.p2p.myId = Net._p2pId();`n      Net.p2p.roles[Net.p2p.myId] = 'host';`n      Net.p2p.hostId = Net.p2p.myId;`n      if(typeof Net.setP2PHostId === 'function') Net.setP2PHostId(Net.p2p.myId);`n      /* Tell every client the host's P2P id so they can open a direct line. This`n         goes over the relay because the channel those clients will use is what would`n         otherwise carry it. */`n      const p2pPeerIds = (typeof Net.p2pPeerIds === 'function') ? Net.p2pPeerIds() : [];`n      for(const id of p2pPeerIds){`n        try{ if(typeof Net.sendP2PHostIdToClient === 'function') Net.sendP2PHostIdToClient(id, Net.p2p.myId); }catch(e){}`n      }`n      /* Clients that are already in the match get the host id as soon as they join.`n         The onP2PId handler below will also pick them up when they send their id. */`n    }`n`n"
$first4 = Find-Pattern $content $pat4
$second4 = Find-Pattern $content $pat4, $first4 + 1

if ($second4 -ge 0) {
    $removed = $pat4.Length
    $content = $content.Substring(0, $second4) + $content.Substring($second4 + $pat4.Length)
    $changes += "Removed duplicate startHost P2P block at char $second4 (removed $removed chars)"
    Write-Host "Removed duplicate startHost P2P block (chars $second4..$($second4 + $pat4.Length), $removed chars)" -ForegroundColor Green
}

# ── 5. transport row construction duplicate ────────────────────────────────
$pat5 = "`n      '<div id=`"perfrow-transport`"></div>' +`n"
$first5 = Find-Pattern $content $pat5
$second5 = Find-Pattern $content $pat5, $first5 + 1

if ($second5 -ge 0) {
    # Remove the single line
    $lineEnd = $content.IndexOf("`n", $second5 + $pat5.Length)
    if ($lineEnd -ge 0) {
        $removed = $lineEnd + 1 - $second5
        $content = $content.Substring(0, $second5) + $content.Substring($lineEnd + 1)
        $changes += "Removed duplicate transport row construction at char $second5 (removed $removed chars)"
        Write-Host "Removed duplicate transport row construction (chars $second5..$lineEnd, $removed chars)" -ForegroundColor Green
    }
}

# ── 6. transport row update IIFE duplicate ─────────────────────────────────
$pat6 = "`n    (function(){`n      var tr = document.getElementById('perfrow-transport');`n      if(tr){`n        var t = 'P2P       --';`n        try {`n          if (typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled){`n            var toHost = Net.p2p.direct && Net.p2p.direct[Net.p2p.hostId];`n            var openDirect = !!(toHost && toHost.open);`n            if(openDirect){`n              t = 'P2P       direct to host';`n            } else {`n              t = 'P2P       connecting (relay)';`n            }`n          } else {`n            var on = (typeof Net !== 'undefined' && Net.role === 'host') ? 'host (relay)' : 'client (relay)';`n            t = 'P2P       ' + on;`n          }`n        } catch(e){}`n        tr.textContent = t;`n      }`n    })();`n"
$first6 = Find-Pattern $content $pat6
$second6 = Find-Pattern $content $pat6, $first6 + 1

if ($second6 -ge 0) {
    $removed = $pat6.Length
    $content = $content.Substring(0, $second6) + $content.Substring($second6 + $pat6.Length)
    $changes += "Removed duplicate transport row update IIFE at char $second6 (removed $removed chars)"
    Write-Host "Removed duplicate transport row update IIFE (chars $second6..$($second6 + $pat6.Length), $removed chars)" -ForegroundColor Green
}

Set-ContentRaw $gameJs $content

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "Original size: $originalLen bytes"
Write-Host "New size: $($content.Length) bytes"
Write-Host "Chars removed: $($originalLen - $content.Length)"
Write-Host "`nChanges made:" -ForegroundColor Cyan
$changes | ForEach-Object { Write-Host "  - $_" }

if ($changes.Count -eq 0) {
    Write-Host "  (no duplicates found — file may already be clean)" -ForegroundColor Yellow
}
