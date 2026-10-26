const fs = require('fs');
const path = 'js/game.js';
const data = fs.readFileSync(path, 'utf8');

// There are TWO complete copies of these edit blocks. Remove the SECOND copy of each.
// Strategy: split the file into "before first occurrence" and "after", then find the
// first copy's region, then find the second copy's region and remove it.

function removeSecondCopy(data, label, findStart, findEnd) {
  // findStart / findEnd are functions that take (str, fromIndex) and return index or -1
  let firstStart = findStart(data, 0);
  if (firstStart < 0) { console.warn('WARN: ' + label + ' first copy not found'); return data; }
  let firstEnd = findEnd(data, firstStart);
  if (firstEnd < 0) { console.warn('WARN: ' + label + ' first end not found'); return data; }
  // second copy starts after firstEnd
  let secondStart = findStart(data, firstEnd);
  if (secondStart < 0) { console.warn('WARN: ' + label + ' second copy not found'); return data; }
  let secondEnd = findEnd(data, secondStart);
  if (secondEnd < 0) { console.warn('WARN: ' + label + ' second end not found'); return data; }
  console.log('REMOVING 2nd ' + label + ': chars ' + secondStart + '..' + secondEnd + ' (' + (secondEnd-secondStart) + ' chars)');
  return data.slice(0, secondStart) + data.slice(secondEnd);
}

// ---- sendInputP2P duplication ----
// The duplicated block spans from "if(this.mode==='client'){" with the double P2P check
// through the "} else if(this.mode==='freeroam'..." line.
// Find by: the pattern of two consecutive identical "typeof Net.sendInputP2P" checks.

function findSendInputDupStart(str, from) {
  // The duplicated region starts where we see "if(this.mode==='client'){" followed by
  // the P2P check TWICE. Find the SECOND occurrence of the full duplicated pattern.
  const pat = "if(this.mode==='client'){\n        if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&\n           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){\n           /* sent direct */\n        } else {\n           Net.sendInput(input);\n        }\n      } else if(this.mode==='freeroam' && !NakamaNet.isHost){\n        NakamaNet.sendMatchData({t: 'input', input});\n      }";
  // The FIRST correct version ends with "Net.sendInput(input);\n        }\n      } else if..."
  // The DUPLICATE version has the P2P check TWICE:
  // "if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&\n           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){\n           /* sent direct */\n        } else {\n           if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&\n           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){\n           /* sent direct */\n        } else {\n           Net.sendInput(input);\n        }\n        }"
  // Find the duplicated inner pattern.
  const dupInner = "if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&\n           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){\n           /* sent direct */\n        } else {\n           if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&\n           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){\n           /* sent direct */\n        } else {\n           Net.sendInput(input);\n        }\n        }";
  let idx = str.indexOf(dupInner, from);
  if (idx >= 0) {
    // The dup block starts at the "if(this.mode==='client'){" that precedes this.
    let blockStart = str.lastIndexOf("if(this.mode==='client'){", idx);
    // The block ends after the second "}" that closes the else-if
    let after = str.indexOf("} else if(this.mode==='freeroam'", idx);
    if (after >= 0) {
      let blockEnd = str.indexOf("\n", str.indexOf("}", after) + 1) + 1;
      // Actually find the end of the "} else if..." line
      let lineEnd = str.indexOf("\n", after);
      return blockEnd > 0 ? blockStart : -1;
    }
  }
  return -1;
}

function findSendInputDupEnd(str, from) {
  // End is right after the duplicate's closing "}" before the freeroam else-if
  const marker = "} else if(this.mode==='freeroam' && !NakamaNet.isHost){\n        NakamaNet.sendMatchData({t: 'input', input});\n      }\n    }";
  let idx = str.indexOf(marker, from);
  if (idx >= 0) {
    return idx + marker.length;
  }
  return -1;
}

// Simpler approach: find the duplicated sendInput block by its unique double-P2P-check pattern
// and remove just that duplicate. The CORRECT block should remain.

const dupPattern = `        if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
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

let pos = data.indexOf(dupPattern);
if (pos >= 0) {
  // Find the enclosing "if(this.mode==='client'){" before this
  let blockStart = data.lastIndexOf("if(this.mode==='client'){", pos);
  // Find end: after "} else if(this.mode==='freeroam'..." line
  let freeroamIdx = data.indexOf("} else if(this.mode==='freeroam' && !NakamaNet.isHost){", pos);
  let lineEnd = data.indexOf("\n", freeroamIdx);
  let blockEnd = data.indexOf("\n", lineEnd) + 1;
  
  console.log('DUPLICATE sendInput block found at chars', blockStart, '..', blockEnd, '(', (blockEnd-blockStart), 'chars )');
  data = data.slice(0, blockStart) + data.slice(blockEnd);
} else {
  console.log('WARN: duplicate sendInput pattern not found');
}

// ---- _p2pHostOptIn + _onP2PId duplication ----
// The duplicate appears as a second copy of the _p2pHostOptIn def + _onP2PId def.
// Find the SECOND occurrence of "_p2pHostOptIn()" and remove from there to just before "_onClientWelcome".

// First, find _onClientWelcome anchor (should appear once)
const welcomeAnchor = "  _onClientWelcome(msg){\n";
let welcomeIdx = data.indexOf(welcomeAnchor);
if (welcomeIdx >= 0) {
  // Find the SECOND _p2pHostOptIn def before _onClientWelcome
  let firstOptIn = data.indexOf("_p2pHostOptIn(){\n", 0);
  let secondOptIn = data.indexOf("_p2pHostOptIn(){\n", firstOptIn + 1);
  if (secondOptIn >= 0 && secondOptIn < welcomeIdx) {
    // Remove from secondOptIn to welcomeIdx
    console.log('DUPLICATE _p2pHostOptIn/_onP2PId block found at chars', secondOptIn, '..', welcomeIdx, '(', (welcomeIdx-secondOptIn), 'chars )');
    data = data.slice(0, secondOptIn) + data.slice(welcomeIdx);
  } else {
    console.log('WARN: second _p2pHostOptIn not found before _onClientWelcome');
  }
} else {
  console.log('WARN: _onClientWelcome anchor not found');
}

// ---- Net.onP2PId duplication ----
// There are TWO "Net.onP2PId = (msg) => this._onP2PId(msg);" lines in startClient.
// Find the second one and remove the surrounding duplicate block.

const onP2PIdLine = "    Net.onP2PId = (msg) => this._onP2PId(msg);\n";
let firstOnP2PId = data.indexOf(onP2PIdLine, 0);
let secondOnP2PId = data.indexOf(onP2PIdLine, firstOnP2PId + 1);
if (secondOnP2PId >= 0) {
  // The duplicate block starts at "    Net.onP2PId = ..." and ends before the next major section.
  // Find the end: the second occurrence is followed by more P2P setup code that duplicates the first.
  // Look for the end of the duplicated startClient P2P wiring block.
  // The block ends where we see "    // If the host turned the P2P fast path on, take it." appearing twice,
  // or where we reach the original "    Net.sendJoinInfo(" after the second copy.
  
  // Find the next "Net.sendJoinInfo(" after secondOnP2PId
  let nextSendJoinInfo = data.indexOf("Net.sendJoinInfo(", secondOnP2PId);
  if (nextSendJoinInfo >= 0) {
    // The duplicate block is from secondOnP2PId to just before nextSendJoinInfo
    console.log('DUPLICATE startClient P2P block found at chars', secondOnP2PId, '..', nextSendJoinInfo, '(', (nextSendJoinInfo-secondOnP2PId), 'chars )');
    data = data.slice(0, secondOnP2PId) + data.slice(nextSendJoinInfo);
  } else {
    // Fallback: remove from secondOnP2PId to just before the next major anchor
    // Find "_sendJoinInfo" or the next function boundary
    let fallbackEnd = data.indexOf("\n    ", secondOnP2PId + 50);
    if (fallbackEnd > secondOnP2PId) {
      console.log('DUPLICATE startClient P2P block (fallback) at chars', secondOnP2PId, '..', fallbackEnd);
      data = data.slice(0, secondOnP2PId) + data.slice(fallbackEnd);
    }
  }
} else {
  console.log('WARN: second Net.onP2PId not found');
}

// Also check for duplicated startHost P2P block
const startHostAnchor = "    this.mode='host'; this._resetArena();\n";
let firstStartHost = data.indexOf(startHostAnchor, 0);
let secondStartHost = data.indexOf(startHostAnchor, firstStartHost + 1);
if (secondStartHost >= 0) {
  // The duplicate startHost block goes from the second P2P block start to the second "this.mode='host'"
  // Find the P2P block that precedes the second startHost
  let p2pBlockStart = data.lastIndexOf("    if(typeof Net !== 'undefined' && Net.p2p && this._p2pHostOptIn()){", secondStartHost);
  if (p2pBlockStart > firstStartHost && p2pBlockStart < secondStartHost) {
    console.log('DUPLICATE startHost P2P block found at chars', p2pBlockStart, '..', secondStartHost);
    data = data.slice(0, p2pBlockStart) + data.slice(secondStartHost);
  }
}

// Also remove duplicated transport row construction/update blocks
// Find second occurrence of "perf-row-transport" in construction
const perfRowTransportConst = "      '<div id=\"perfrow-transport\"></div>'";
let firstConst = data.indexOf(perfRowTransportConst, 0);
let secondConst = data.indexOf(perfRowTransportConst, firstConst + 1);
if (secondConst >= 0) {
  // Remove the second construction line (it's a single line insertion)
  let lineStart = data.lastIndexOf("\n", secondConst) + 1;
  let lineEnd = data.indexOf("\n", secondConst);
  console.log('DUPLICATE transport row construction at chars', lineStart, '..', lineEnd+1);
  data = data.slice(0, lineStart) + data.slice(lineEnd+1);
}

// Find second occurrence of transport row update block
const transportUpdateStart = "    (function(){\n      var tr = document.getElementById('perfrow-transport');";
let firstUpdate = data.indexOf(transportUpdateStart, 0);
let secondUpdate = data.indexOf(transportUpdateStart, firstUpdate + 1);
if (secondUpdate >= 0) {
  // Find the end of this IIFE block: the closing "})();\n"
  let updateEnd = data.indexOf("})();\n", secondUpdate);
  if (updateEnd >= 0) {
    updateEnd = data.indexOf("\n", updateEnd) + 1;
    console.log('DUPLICATE transport row update at chars', secondUpdate, '..', updateEnd, '(', (updateEnd-secondUpdate), 'chars )');
    data = data.slice(0, secondUpdate) + data.slice(updateEnd);
  }
}

// Write back
fs.writeFileSync(path, data, 'utf8');
console.log('WROTE ' + path + ', new size ' + data.length + ' bytes');
