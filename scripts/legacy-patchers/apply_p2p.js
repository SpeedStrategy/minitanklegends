const fs = require("fs");
const data = fs.readFileSync("js/game.js", "utf-8");

// =====================================================
// EDIT 1: startClient P2P wiring
// Insert BEFORE the first "Net.sendJoinInfo(" line.
// =====================================================
function plan_startClient() {
  const anchor = "Net.sendJoinInfo(";
  const idx = data.indexOf(anchor);
  if (idx < 0) return null;
  const inserter =
    "    Net.onP2PId = (msg) => this._onP2PId(msg);\n\n" +
    "    // Send our P2P id to the host as soon as we have one, over the relay (the\n" +
    "    // channel we are about to open cannot carry the first one).\n" +
    "    if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.myId){\n" +
    "      try{ if(typeof Net.sendP2PId === 'function') Net.sendP2PId(Net.p2p.myId); }catch(e){}\n" +
    "    }\n\n" +
    "    // If the host turned the P2P fast path on, take it.\n" +
    "    if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId){\n" +
    "      Net.p2p.myId = Net._p2pId();\n" +
    "      Net.p2p.roles[Net.p2p.myId] = 'client';\n" +
    "      if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, Net.p2p.myId);\n" +
    "      if(typeof Net.openP2PToHost === 'function') Net.openP2PToHost();\n" +
    "      if(typeof Net.startP2PRetries === 'function') Net.startP2PRetries();\n" +
    "    } else {\n" +
    "      // Tell the host our P2P id anyway, so if the host turns P2P on later (it does\n" +
    "      // not, but a reconnect/resume path may), the host already knows how to reach us.\n" +
    "      if(typeof Net !== 'undefined' && Net.p2p){\n" +
    "        Net.p2p.myId = Net._p2pId();\n" +
    "        if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, Net.p2p.myId);\n" +
    "        try{ if(typeof Net.sendP2PId === 'function') Net.sendP2PId(Net.p2p.myId); }catch(e){}\n" +
    "      }\n" +
    "    }\n";
  return { idx, anchor, inserter, note: "startClient P2P wiring" };
}

// =====================================================
// EDIT 2: _onP2PId + _p2pHostOptIn methods
// Insert BEFORE "  _onClientWelcome(msg){\n"
// =====================================================
function plan_methods() {
  const anchor = "  _onClientWelcome(msg){\n";
  const idx = data.indexOf(anchor);
  if (idx < 0) return null;
  const inserter =
    "  /* P2P id message arrived over the server relay. Two forms:\n" +
    "\n" +
    "     * client -> host: \"{ t:'p2p-id', p2pId }\" — this client's P2P id, so the host\n" +
    "       can address it directly.\n" +
    "     * host -> client: \"{ t:'p2p-id', to: peerId, p2pId }\" — the host's P2P id, so\n" +
    "       this client can open a direct channel to it.\n" +
    "\n" +
    "     The same callback handles both; the caller (Net.onP2PId) wires whichever form\n" +
    "     the current role expects. */\n" +
    "  _onP2PId(msg){\n" +
    "    if(!msg || typeof msg !== 'object') return;\n" +
    "    if(msg.to != null){\n" +
    "      // Host -> client: this is the host's P2P id.\n" +
    "      if(typeof Net !== 'undefined' && Net.p2p){\n" +
    "        Net.p2p.hostId = msg.p2pId || null;\n" +
    "        if(typeof Net.setP2PHostId === 'function') Net.setP2PHostId(Net.p2p.hostId);\n" +
    "        if(Net.p2p.enabled){\n" +
    "          if(typeof Net.openP2PToHost === 'function') Net.openP2PToHost();\n" +
    "          if(typeof Net.startP2PRetries === 'function') Net.startP2PRetries();\n" +
    "        }\n" +
    "      }\n" +
    "      return;\n" +
    "    }\n" +
    "    // Client -> host: this client's P2P id.\n" +
    "    if(msg.p2pId && this.mode==='host' && typeof Net !== 'undefined' && Net.p2p){\n" +
    "      if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, msg.p2pId);\n" +
    "    }\n" +
    "  }\n\n" +
    "  /* The host's P2P fast-path opt-in toggle. Read from the multiplayer networking\n" +
    "     settings, which the host sets in the menu. Returns false until the host turns\n" +
    "     the toggle on, so a match never silently goes P2P because a client's browser\n" +
    "     happens to have WebRTC — that would be an invisible, un-debuggable change. */\n" +
    "  _p2pHostOptIn(){\n" +
    "    try {\n" +
    "      return !!(this.settings && this.settings.p2pHostFastPath === true);\n" +
    "    } catch(e){\n" +
    "      return false;\n" +
    "    }\n" +
    "  }\n\n";
  return { idx, anchor, inserter, note: "_onP2PId + _p2pHostOptIn methods" };
}

// =====================================================
// EDIT 3: transport row in HUD construction
// Insert AFTER "    '<div id=\"perf-row-ping\"></div>' +\n"
// =====================================================
function plan_transport_construction() {
  const anchor = "    '<div id=\"perf-row-ping\"></div>' +\n";
  const idx = data.indexOf(anchor);
  if (idx < 0) return null;
  const inserter = "      '<div id=\"perf-row-transport\"></div>' +\n";
  return { idx, anchor, inserter, note: "transport row construction" };
}

// =====================================================
// EDIT 4: transport row update in _updatePerfOverlay
// Insert AFTER the ping line:
//       'Ping       ' + pingStr;\n
// =====================================================
function plan_transport_update() {
  const anchor = "      'Ping       ' + pingStr;\n";
  const idx = data.indexOf(anchor);
  if (idx < 0) return null;
  const inserter =
    "      'Ping       ' + pingStr;\n" +
    "    (function(){\n" +
    "      var tr = document.getElementById('perfrow-transport');\n" +
    "      if(tr){\n" +
    "        var t = 'P2P       --';\n" +
    "        try {\n" +
    "          if (typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled){\n" +
    "            var toHost = Net.p2p.direct && Net.p2p.direct[Net.p2p.hostId];\n" +
    "            var openDirect = !!(toHost && toHost.open);\n" +
    "            if(openDirect){\n" +
    "              t = 'P2P       direct to host';\n" +
    "            } else {\n" +
    "              t = 'P2P       connecting (relay)';\n" +
    "            }\n" +
    "          } else {\n" +
    "            var on = (typeof Net !== 'undefined' && Net.role === 'host') ? 'host (relay)' : 'client (relay)';\n" +
    "            t = 'P2P       ' + on;\n" +
    "          }\n" +
    "        } catch(e){}\n" +
    "        tr.textContent = t;\n" +
    "      }\n" +
    "    })();\n";
  return { idx, anchor, inserter, note: "transport row update" };
}

// =====================================================
// EDIT 5: input path
// Replace "        Net.sendInput(input);" with P2P branch.
// =====================================================
function plan_input() {
  const anchor = "        Net.sendInput(input);";
  const idx = data.indexOf(anchor);
  if (idx < 0) return null;
  const inserter =
    "        if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&\n" +
    "           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){\n" +
    "          /* sent direct */\n" +
    "        } else {\n" +
    "          Net.sendInput(input);\n" +
    "        }";
  return { idx, anchor, inserter, note: "input sendInputP2P branching" };
}

// =====================================================
// EDIT 6: snapshot path
// Replace the host's "        Net.broadcast({" with broadcastP2P branch.
// We find the right one by scanning from the end (the host snapshot is the
// last such broadcast in the match loop). Build context up to the anchor.
// =====================================================
function plan_snapshot() {
  let idx = -1;
  // Scan all occurrences from the end, pick the last one that sits inside the
  // _tick loop (the one with _netSendAcc context). Scan backwards.
  const sub = "        Net.broadcast({";
  let pos = data.length;
  while (true) {
    pos = data.lastIndexOf(sub, pos - 1);
    if (pos < 0) break;
    // Confirm it is the host snapshot by checking a window before it.
    const before = data.substring(Math.max(0, pos - 300), pos);
    if (before.includes("_netSendAcc") || before.includes("_tick") || before.includes("this.time")) {
      idx = pos;
      break;
    }
  }
  if (idx < 0) return null;
  const anchor = "        Net.broadcast({";
  const inserter =
    "        if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && typeof Net.broadcastP2P === 'function'){\n" +
    "          Net.broadcastP2P({\n" +
    "            time: this.time,\n" +
    "            glad: this.glad ? this._gladSnapshot() : null,\n" +
    "            bases: this._baseDefendMode ? BaseDefend.snapshot() : null,\n" +
    "            tanks: this.tanks.map(t => t.snapshot()),\n" +
    "            projs: this._projectileSnapshot(),\n" +
    "            cd: this._netSnapshotCountdown(),\n" +
    "          });\n" +
    "        } else {\n" +
    "          Net.broadcast({\n" +
    "            time: this.time,\n" +
    "            glad: this.glad ? this._gladSnapshot() : null,\n" +
    "            bases: this._baseDefendMode ? BaseDefend.snapshot() : null,\n" +
    "            tanks: this.tanks.map(t => t.snapshot()),\n" +
    "            projs: this._projectileSnapshot(),\n" +
    "            cd: this._netSnapshotCountdown(),\n" +
    "          });\n" +
    "        }";
  return { idx, anchor, inserter, note: "snapshot broadcastP2P branching" };
}

// =====================================================
// EDIT 7: startHost P2P block
// Insert BEFORE "    this.mode='host'; this._resetArena();\n"
// =====================================================
function plan_starthost() {
  const anchor = "    this.mode='host'; this._resetArena();\n";
  const idx = data.indexOf(anchor);
  if (idx < 0) return null;
  const inserter =
    "    /* P2P fast path. Only the host decides this, because only the host owns the\n" +
    "       simulation and only the host has a channel for every client to dial. When the\n" +
    "       host opts in, the host gets a P2P id, tells the clients what it is, and the\n" +
    "       clients open a direct channel to it. When the host does not opt in, or when\n" +
    "       WebRTC is unavailable, every byte still goes over the server relay exactly as\n" +
    "       before — there is no dead path here, only a faster one when it works.\n" +
    "\n" +
    "       The toggle the host sets in the multiplayer networking settings is the single\n" +
    "       source of truth for this match. It is NOT auto-enabled, because auto-enabling\n" +
    "       would change a match's behaviour depending on a client's browser, which is the\n" +
    "       kind of invisible change that is impossible to debug. */\n" +
    "    if(typeof Net !== 'undefined' && Net.p2p && this._p2pHostOptIn()){\n" +
    "      Net.p2p.enabled = true;\n" +
    "      Net.p2p.myId = Net._p2pId();\n" +
    "      Net.p2p.roles[Net.p2p.myId] = 'host';\n" +
    "      Net.p2p.hostId = Net.p2p.myId;\n" +
    "      if(typeof Net.setP2PHostId === 'function') Net.setP2PHostId(Net.p2p.myId);\n" +
    "      /* Tell every client the host's P2P id so they can open a direct line. This\n" +
    "         goes over the relay because the channel those clients will use is what would\n" +
    "         otherwise carry it. */\n" +
    "      const p2pPeerIds = (typeof Net.p2pPeerIds === 'function') ? Net.p2pPeerIds() : [];\n" +
    "      for(const id of p2pPeerIds){\n" +
    "        try{ if(typeof Net.sendP2PHostIdToClient === 'function') Net.sendP2PHostIdToClient(id, Net.p2p.myId); }catch(e){}\n" +
    "      }\n" +
    "      /* Clients that are already in the match get the host id as soon as they join.\n" +
    "         The onP2PId handler below will also pick them up when they send their id. */\n" +
    "    }\n\n";
  return { idx, anchor, inserter, note: "startHost P2P block" };
}

// =====================================================
// Apply. Insertions go BEFORE the anchor; replacements go
// after the anchor. We apply from highest index down so
// earlier indices stay valid.
// =====================================================
const all = [
  plan_startClient(),
  plan_methods(),
  plan_transport_construction(),
  plan_transport_update(),
  plan_input(),
  plan_snapshot(),
  plan_starthost(),
].filter(Boolean);

// Sort descending by original index so that we apply from the end of the
// file backwards. Each plan records the position in the ORIGINAL string;
// when we apply backwards, the remaining plans' indices are still correct.
all.sort((a, b) => b.idx - a.idx);

const appliedAt = new Map(); // original idx -> actual insert position after prior edits

let cur = data;
for (const e of all) {
  const idx = cur.indexOf(e.anchor);
  if (idx < 0) {
    console.log("FAIL " + e.note + " at original " + e.idx);
    process.exit(1);
  }
  let next;
  if (e.note === "startClient P2P wiring") {
    // Insert BEFORE anchor (e.idx is start of "Net.sendJoinInfo(")
    next = cur.substring(0, idx) + e.inserter + cur.substring(idx);
    console.log("APPLIED (before) " + e.note + " at char " + idx);
  } else if (e.note === "_onP2PId + _p2pHostOptIn methods") {
    // Insert BEFORE anchor
    next = cur.substring(0, idx) + e.inserter + cur.substring(idx);
    console.log("APPLIED (before) " + e.note + " at char " + idx);
  } else if (e.note === "startHost P2P block") {
    // Insert BEFORE anchor
    next = cur.substring(0, idx) + e.inserter + cur.substring(idx);
    console.log("APPLIED (before) " + e.note + " at char " + idx);
  } else if (e.note === "transport row construction") {
    // Insert AFTER anchor (which ends with " +\n")
    next = cur.substring(0, idx + e.anchor.length) + e.inserter + cur.substring(idx + e.anchor.length);
    console.log("APPLIED (after) " + e.note + " at char " + idx);
  } else if (e.note === "transport row update") {
    // Insert AFTER anchor
    next = cur.substring(0, idx + e.anchor.length) + e.inserter + cur.substring(idx + e.anchor.length);
    console.log("APPLIED (after) " + e.note + " at char " + idx);
  } else if (e.note === "input sendInputP2P branching") {
    // Replace anchor
    const after = idx + e.anchor.length;
    next = cur.substring(0, idx) + e.inserter + cur.substring(after);
    console.log("APPLIED (replace) " + e.note + " at char " + idx);
  } else if (e.note === "snapshot broadcastP2P branching") {
    // Replace anchor
    const after = idx + e.anchor.length;
    next = cur.substring(0, idx) + e.inserter + cur.substring(after);
    console.log("APPLIED (replace) " + e.note + " at char " + idx);
  } else {
    console.log("UNHANDLED plan type: " + e.note);
    process.exit(1);
  }
  cur = next;
}

fs.writeFileSync("js/game.js", cur);
console.log("WROTE js/game.js, new size " + cur.length + " bytes (was 703338)");
