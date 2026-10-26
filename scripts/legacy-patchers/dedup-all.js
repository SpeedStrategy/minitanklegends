const fs = require('fs');
const path = 'js/game.js';

let d = fs.readFileSync(path, 'utf8');
const origLen = d.length;
const changes = [];

function removeOnce(label, findStart, findEnd) {
  // findStart(str, fromIdx) -> index or -1
  // findEnd(str, fromIdx) -> index (end of block, exclusive) or -1
  let first = findStart(d, 0);
  if (first < 0) { console.log(`WARN: ${label}: first not found`); return false; }
  let second = findStart(d, first + 1);
  if (second < 0) { console.log(`WARN: ${label}: second not found (already deduped?)`); return false; }
  let end = findEnd(d, second);
  if (end < 0) { console.log(`WARN: ${label}: end not found`); return false; }
  const removed = end - second;
  d = d.slice(0, second) + d.slice(end);
  changes.push(`Removed ${label}: chars ${second}..${end} (${removed} chars)`);
  console.log(`OK ${label}: removed ${removed} chars at ${second}`);
  return true;
}

// ── 1. sendInputP2P nested duplicate ─────────────────────────────────────
// Pattern: inside if(this.mode==='client'), we have:
//   if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
//      typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){
//     /* sent direct */
//   } else {
//     if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
//        typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){
//     /* sent direct */
//   } else {
//     Net.sendInput(input);
//   }
//   }
//
// The CORRECT version has only ONE check, not nested. Find the nested dup.

const nestedDupStartFinder = (str, from) => {
  // Find the SECOND occurrence of "typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)"
  const pat = "typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)";
  let first = str.indexOf(pat, from);
  if (first < 0) return -1;
  let second = str.indexOf(pat, first + 1);
  if (second < 0) return -1;
  // The nested dup starts at the "if(typeof Net !== 'undefined'..." that precedes the second occurrence
  const outerIf = "if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&\n           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){";
  // Find the start of the nested if block: the "if(typeof Net !== 'undefined'..." immediately before second
  let nestedStart = str.lastIndexOf("if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&", second);
  if (nestedStart < 0) return -1;
  // Extend to include the full nested if line + body
  // The nested block ends at "Net.sendInput(input);" then "}" then "}" (close outer else)
  // Find "Net.sendInput(input);" after second
  let sendInput = str.indexOf("Net.sendInput(input);", second);
  if (sendInput < 0) return -1;
  // End after the closing "        }" that closes the outer else
  let afterSend = str.indexOf("}", sendInput + 18);
  if (afterSend < 0) return -1;
  // Include one more char for the newline
  let end = str.indexOf("\n", afterSend) + 1;
  if (end < 0) end = afterSend + 1;
  return { start: nestedStart, end };
};

// Simpler: find the exact duplicated text block and remove it
const dupBlockFinder = (str, from) => {
  const block = `        if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){
           /* sent direct */
         } else {
           if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
              typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){
           /* sent direct */
         } else {
           Net.sendInput(input);
         }
         }`;
  return str.indexOf(block, from);
};

const dupBlockRemover = (str, from) => {
  const block = `        if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){
           /* sent direct */
         } else {
           if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
              typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){
           /* sent direct */
         } else {
           Net.sendInput(input);
         }
         }`;
  const idx = str.indexOf(block, from);
  if (idx >= 0) {
    const end = idx + block.length;
    d = d.slice(0, idx) + d.slice(end);
    changes.push(`Removed sendInputP2P nested dup: chars ${idx}..${end} (${block.length} chars)`);
    console.log(`OK sendInputP2P nested dup: removed ${block.length} chars at ${idx}`);
    return true;
  }
  return false;
};

// Try the exact block match first
if (!dupBlockRemover(d, 0)) {
  // Fallback: find nested pattern by the double-occurrence method
  const pat = "typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)";
  const first = d.indexOf(pat);
  const second = d.indexOf(pat, first + 1);
  if (first >= 0 && second >= 0) {
    // Find the "if(typeof Net !== 'undefined'..." before the second occurrence
    const nestedStart = d.lastIndexOf("if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&", second);
    if (nestedStart >= 0) {
      // Find end: after "Net.sendInput(input);" + closing braces
      const sendInputIdx = d.indexOf("Net.sendInput(input);", second);
      if (sendInputIdx >= 0) {
        // The block ends after the next "        }" (closing outer else)
        const closeBrace = d.indexOf("\n        }\n      } else if(this.mode==='freeroam'", sendInputIdx);
        if (closeBrace >= 0) {
          const end = closeBrace + "\n        }\n".length;
          d = d.slice(0, nestedStart) + d.slice(end);
          changes.push(`Removed sendInputP2P nested dup (fallback): chars ${nestedStart}..${end}`);
          console.log(`OK sendInputP2P nested dup (fallback): removed at ${nestedStart}`);
        } else {
          console.log('WARN: could not find end of nested dup block');
        }
      }
    }
  }
}

// ── 2. _p2pHostOptIn + _onP2PId duplicate ──────────────────────────────
// These appear as two complete method definitions. Find the second copy.

const methodsBlockFinder = (str, from) => {
  // The block starts with "  _p2pHostOptIn(){" and ends before "  _onClientWelcome(msg){"
  const startMarker = "  _p2pHostOptIn(){\n    try {\n      return !!(this.settings && this.settings.p2pHostFastPath === true);\n    } catch(e){\n      return false;\n    }\n  }\n\n  /* P2P id message arrived over the server relay. Two forms:\n\n     * client -> host: \"{ t:'p2p-id', p2pId }\" — this client's P2P id, so the host\n       can address it directly.\n     * host -> client: \"{ t:'p2p-id', to: peerId, p2pId }\" — the host's P2P id, so\n       this client can open a direct channel to it.\n\n     The same callback handles both; the caller (Net.onP2PId) wires whichever form\n     the current role expects. */\n  _onP2PId(msg){\n    if(!msg || typeof msg !== 'object') return;\n    if(msg.to != null){\n      // Host -> client: this is the host's P2P id.\n      if(typeof Net !== 'undefined' && Net.p2p){\n        Net.p2p.hostId = msg.p2pId || null;\n        if(typeof Net.setP2PHostId === 'function') Net.setP2PHostId(Net.p2p.hostId);\n        if(Net.p2p.enabled){\n          if(typeof Net.openP2PToHost === 'function') Net.openP2PToHost();\n          if(typeof Net.startP2PRetries === 'function') Net.startP2PRetries();\n        }\n      }\n      return;\n    }\n    // Client -> host: this client's P2P id.\n    if(msg.p2pId && this.mode==='host' && typeof Net !== 'undefined' && Net.p2p){\n      if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, msg.p2pId);\n    }\n  }\n\n  /* The host's P2P fast-path opt-in toggle. Read from the multiplayer networking\n     settings, which the host sets in the menu. Returns false until the host turns\n     the toggle on, so a match never silently goes P2P because a client's browser\n     happens to have WebRTC — that would be an invisible, un-debuggable change. */\n  _p2pHostOptIn(){\n    try {\n      return !!(this.settings && this.settings.p2pHostFastPath === true);\n    } catch(e){\n      return false;\n    }\n  }\n\n";
  return str.indexOf(startMarker, from);
};

const methodsBlockRemover = (str, from) => {
  const startMarker = "  _p2pHostOptIn(){\n    try {\n      return !!(this.settings && this.settings.p2pHostFastPath === true);\n    } catch(e){\n      return false;\n    }\n  }\n\n  /* P2P id message arrived over the server relay. Two forms:\n\n     * client -> host: \"{ t:'p2p-id', p2pId }\" — this client's P2P id, so the host\n       can address it directly.\n     * host -> client: \"{ t:'p2p-id', to: peerId, p2pId }\" — the host's P2P id, so\n       this client can open a direct channel to it.\n\n     The same callback handles both; the caller (Net.onP2PId) wires whichever form\n     the current role expects. */\n  _onP2PId(msg){\n    if(!msg || typeof msg !== 'object') return;\n    if(msg.to != null){\n      // Host -> client: this is the host's P2P id.\n      if(typeof Net !== 'undefined' && Net.p2p){\n        Net.p2p.hostId = msg.p2pId || null;\n        if(typeof Net.setP2PHostId === 'function') Net.setP2PHostId(Net.p2p.hostId);\n        if(Net.p2p.enabled){\n          if(typeof Net.openP2PToHost === 'function') Net.openP2PToHost();\n          if(typeof Net.startP2PRetries === 'function') Net.startP2PRetries();\n        }\n      }\n      return;\n    }\n    // Client -> host: this client's P2P id.\n    if(msg.p2pId && this.mode==='host' && typeof Net !== 'undefined' && Net.p2p){\n      if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, msg.p2pId);\n    }\n  }\n\n  /* The host's P2P fast-path opt-in toggle. Read from the multiplayer networking\n     settings, which the host sets in the menu. Returns false until the host turns\n     the toggle on, so a match never silently goes P2P because a client's browser\n     happens to have WebRTC — that would be an invisible, un-debuggable change. */\n  _p2pHostOptIn(){\n    try {\n      return !!(this.settings && this.settings.p2pHostFastPath === true);\n    } catch(e){\n      return false;\n    }\n  }\n\n";
  const idx = str.indexOf(startMarker, from);
  if (idx >= 0) {
    // End is right before "  _onClientWelcome(msg){"
    const endMarker = "  _onClientWelcome(msg){\n";
    const end = str.indexOf(endMarker, idx);
    if (end >= 0) {
      d = d.slice(0, idx) + d.slice(end);
      changes.push(`Removed _p2pHostOptIn+_onP2PId dup: chars ${idx}..${end}`);
      console.log(`OK _p2pHostOptIn+_onP2PId dup: removed at ${idx}..${end}`);
      return true;
    }
  }
  return false;
};

if (!methodsBlockRemover(d, 0)) {
  console.log('WARN: could not remove _p2pHostOptIn+_onP2PId duplicate');
}

// ── 3. Net.onP2PId assignment + startClient P2P wiring duplicate ────────
// The duplicated block starts with "    Net.onP2PId = (msg) => this._onP2PId(msg);"
// and includes the full P2P id sending logic

const startClientDupFinder = (str, from) => {
  const block = `    Net.onP2PId = (msg) => this._onP2PId(msg);

    // Send our P2P id to the host as soon as we have one, over the relay (the
    // channel we are about to open cannot carry the first one).
    if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.myId){
      try{ if(typeof Net.sendP2PId === 'function') Net.sendP2PId(Net.p2p.myId); }catch(e){}
    }

    // If the host turned the P2P fast path on, take it.
    if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId){
      Net.p2p.myId = Net._p2pId();
      Net.p2p.roles[Net.p2p.myId] = 'client';
      if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, Net.p2p.myId);
      if(typeof Net.openP2PToHost === 'function') Net.openP2PToHost();
      if(typeof Net.startP2PRetries === 'function') Net.startP2PRetries();
    } else {
      // Tell the host our P2P id anyway, so if the host turns P2P on later (it does
      // not, but a reconnect/resume path may), the host already knows how to reach us.
      if(typeof Net !== 'undefined' && Net.p2p){
        Net.p2p.myId = Net._p2pId();
        if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, Net.p2p.myId);
        try{ if(typeof Net.sendP2PId === 'function') Net.sendP2PId(Net.p2p.myId); }catch(e){}
      }
    }
`;
  return str.indexOf(block, from);
};

const startClientDupRemover = (str, from) => {
  const block = `    Net.onP2PId = (msg) => this._onP2PId(msg);

    // Send our P2P id to the host as soon as we have one, over the relay (the
    // channel we are about to open cannot carry the first one).
    if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.myId){
      try{ if(typeof Net.sendP2PId === 'function') Net.sendP2PId(Net.p2p.myId); }catch(e){}
    }

    // If the host turned the P2P fast path on, take it.
    if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId){
      Net.p2p.myId = Net._p2pId();
      Net.p2p.roles[Net.p2p.myId] = 'client';
      if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, Net.p2p.myId);
      if(typeof Net.openP2PToHost === 'function') Net.openP2PToHost();
      if(typeof Net.startP2PRetries === 'function') Net.startP2PRetries();
    } else {
      // Tell the host our P2P id anyway, so if the host turns P2P on later (it does
      // not, but a reconnect/resume path may), the host already knows how to reach us.
      if(typeof Net !== 'undefined' && Net.p2p){
        Net.p2p.myId = Net._p2pId();
        if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, Net.p2p.myId);
        try{ if(typeof Net.sendP2PId === 'function') Net.sendP2PId(Net.p2p.myId); }catch(e){}
      }
    }
`;
  const idx = str.indexOf(block, from);
  if (idx >= 0) {
    d = d.slice(0, idx) + d.slice(idx + block.length);
    changes.push(`Removed startClient P2P wiring dup: chars ${idx}..${idx + block.length}`);
    console.log(`OK startClient P2P wiring dup: removed ${block.length} chars at ${idx}`);
    return true;
  }
  return false;
};

if (!startClientDupRemover(d, 0)) {
  console.log('WARN: could not remove startClient P2P wiring duplicate');
}

// ── 4. startHost P2P block duplicate ────────────────────────────────────
const startHostDupFinder = (str, from) => {
  const block = `    /* P2P fast path. Only the host decides this, because only the host owns the
       simulation and only the host has a channel for every client to dial. When the
       host opts in, the host gets a P2P id, tells the clients what it is, and the
       clients open a direct channel to it. When the host does not opt in, or when
       WebRTC is unavailable, every byte still goes over the server relay exactly as
       before — there is no dead path here, only a faster one when it works.

       The toggle the host sets in the multiplayer networking settings is the single
       source of truth for this match. It is NOT auto-enabled, because auto-enabling
       would change a match's behaviour depending on a client's browser, which is the
       kind of invisible change that is impossible to debug. */
    if(typeof Net !== 'undefined' && Net.p2p && this._p2pHostOptIn()){
      Net.p2p.enabled = true;
      Net.p2p.myId = Net._p2pId();
      Net.p2p.roles[Net.p2p.myId] = 'host';
      Net.p2p.hostId = Net.p2p.myId;
      if(typeof Net.setP2PHostId === 'function') Net.setP2PHostId(Net.p2p.myId);
      /* Tell every client the host's P2P id so they can open a direct line. This
         goes over the relay because the channel those clients will use is what would
         otherwise carry it. */
      const p2pPeerIds = (typeof Net.p2pPeerIds === 'function') ? Net.p2pPeerIds() : [];
      for(const id of p2pPeerIds){
        try{ if(typeof Net.sendP2PHostIdToClient === 'function') Net.sendP2PHostIdToClient(id, Net.p2p.myId); }catch(e){}
      }
      /* Clients that are already in the match get the host id as soon as they join.
         The onP2PId handler below will also pick them up when they send their id. */
    }

`;
  return str.indexOf(block, from);
};

const startHostDupRemover = (str, from) => {
  const block = `    /* P2P fast path. Only the host decides this, because only the host owns the
       simulation and only the host has a channel for every client to dial. When the
       host opts in, the host gets a P2P id, tells the clients what it is, and the
       clients open a direct channel to it. When the host does not opt in, or when
       WebRTC is unavailable, every byte still goes over the server relay exactly as
       before — there is no dead path here, only a faster one when it works.

       The toggle the host sets in the multiplayer networking settings is the single
       source of truth for this match. It is NOT auto-enabled, because auto-enabling
       would change a match's behaviour depending on a client's browser, which is the
       kind of invisible change that is impossible to debug. */
    if(typeof Net !== 'undefined' && Net.p2p && this._p2pHostOptIn()){
      Net.p2p.enabled = true;
      Net.p2p.myId = Net._p2pId();
      Net.p2p.roles[Net.p2p.myId] = 'host';
      Net.p2p.hostId = Net.p2p.myId;
      if(typeof Net.setP2PHostId === 'function') Net.setP2PHostId(Net.p2p.myId);
      /* Tell every client the host's P2P id so they can open a direct line. This
         goes over the relay because the channel those clients will use is what would
         otherwise carry it. */
      const p2pPeerIds = (typeof Net.p2pPeerIds === 'function') ? Net.p2pPeerIds() : [];
      for(const id of p2pPeerIds){
        try{ if(typeof Net.sendP2PHostIdToClient === 'function') Net.sendP2PHostIdToClient(id, Net.p2p.myId); }catch(e){}
      }
      /* Clients that are already in the match get the host id as soon as they join.
         The onP2PId handler below will also pick them up when they send their id. */
    }

`;
  const idx = str.indexOf(block, from);
  if (idx >= 0) {
    d = d.slice(0, idx) + d.slice(idx + block.length);
    changes.push(`Removed startHost P2P block dup: chars ${idx}..${idx + block.length}`);
    console.log(`OK startHost P2P block dup: removed ${block.length} chars at ${idx}`);
    return true;
  }
  return false;
};

if (!startHostDupRemover(d, 0)) {
  console.log('WARN: could not remove startHost P2P block duplicate');
}

// ── 5. transport row construction duplicate ─────────────────────────────
const transportConstFinder = (str, from) => {
  return str.indexOf("\n      '<div id=\"perfrow-transport\"></div>' +\n", from);
};

const transportConstRemover = (str, from) => {
  const idx = str.indexOf("\n      '<div id=\"perfrow-transport\"></div>' +\n", from);
  if (idx >= 0) {
    const end = idx + "\n      '<div id=\"perfrow-transport\"></div>' +\n".length;
    d = d.slice(0, idx) + d.slice(end);
    changes.push(`Removed transport row construction dup: chars ${idx}..${end}`);
    console.log(`OK transport row construction dup: removed at ${idx}`);
    return true;
  }
  return false;
};

if (!transportConstRemover(d, 0)) {
  console.log('WARN: could not remove transport row construction duplicate');
}

// ── 6. transport row update IIFE duplicate ──────────────────────────────
const transportUpdateFinder = (str, from) => {
  const block = `\n    (function(){
      var tr = document.getElementById('perfrow-transport');
      if(tr){
        var t = 'P2P       --';
        try {
          if (typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled){
            var toHost = Net.p2p.direct && Net.p2p.direct[Net.p2p.hostId];
            var openDirect = !!(toHost && toHost.open);
            if(openDirect){
              t = 'P2P       direct to host';
            } else {
              t = 'P2P       connecting (relay)';
            }
          } else {
            var on = (typeof Net !== 'undefined' && Net.role === 'host') ? 'host (relay)' : 'client (relay)';
            t = 'P2P       ' + on;
          }
        } catch(e){}
        tr.textContent = t;
      }
    })();
`;
  return str.indexOf(block, from);
};

const transportUpdateRemover = (str, from) => {
  const block = `\n    (function(){
      var tr = document.getElementById('perfrow-transport');
      if(tr){
        var t = 'P2P       --';
        try {
          if (typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled){
            var toHost = Net.p2p.direct && Net.p2p.direct[Net.p2p.hostId];
            var openDirect = !!(toHost && toHost.open);
            if(openDirect){
              t = 'P2P       direct to host';
            } else {
              t = 'P2P       connecting (relay)';
            }
          } else {
            var on = (typeof Net !== 'undefined' && Net.role === 'host') ? 'host (relay)' : 'client (relay)';
            t = 'P2P       ' + on;
          }
        } catch(e){}
        tr.textContent = t;
      }
    })();
`;
  const idx = str.indexOf(block, from);
  if (idx >= 0) {
    d = d.slice(0, idx) + d.slice(idx + block.length);
    changes.push(`Removed transport row update IIFE dup: chars ${idx}..${idx + block.length}`);
    console.log(`OK transport row update IIFE dup: removed ${block.length} chars at ${idx}`);
    return true;
  }
  return false;
};

if (!transportUpdateRemover(d, 0)) {
  console.log('WARN: could not remove transport row update IIFE duplicate');
}

// Write back
fs.writeFileSync(path, d, 'utf8');
console.log(`\nWROTE ${path}, new size ${d.length} bytes (was ${origLen}, removed ${origLen - d.length})`);
console.log('\nChanges:');
changes.forEach(c => console.log(`  - ${c}`));
if (changes.length === 0) console.log('  (no duplicates found)');
