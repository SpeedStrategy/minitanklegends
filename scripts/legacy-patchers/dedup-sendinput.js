const fs = require('fs');
const path = 'js/game.js';
let d = fs.readFileSync(path, 'utf8');

// The duplicated block looks like this (note the DOUBLE P2P check):
//
//         if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
//            typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){
//           /* sent direct */
//         } else {
//           if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
//              typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){
//           /* sent direct */
//         } else {
//           Net.sendInput(input);
//         }
//         }

const dupPattern =
`        if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
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

let idx = d.indexOf(dupPattern);
if (idx < 0) {
  console.log('DUPLICATE PATTERN NOT FOUND (already removed or different)');
  process.exit(0);
}

// Find enclosing "if(this.mode==='client'){" before this duplicate
const blockStart = d.lastIndexOf("if(this.mode==='client'){", idx);
if (blockStart < 0) {
  console.log('WARN: could not find enclosing if(this.mode===\'client\'){');
  process.exit(1);
}

// The correct (non-duplicate) version ends with:
//           Net.sendInput(input);
//         }
//       } else if(this.mode==='freeroam'...
// The duplicate version has the extra nested if/else, then the same ending.
// We want to replace the whole duplicated block (including the nested part)
// with the correct single-check version.

const correctBlock =
`        if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){
           /* sent direct */
        } else {
           Net.sendInput(input);
        }`;

// Find where this duplicate block ends - look for the SECOND "} else {" after the start
// The duplicate has: if(...) { ... } else { if(...) { ... } else { ... } }
// We need to find the end of the outer else block.

// Strategy: the duplicate block is the text from blockStart to just before
// the line "} else if(this.mode==='freeroam' && !NakamaNet.isHost){"

const freeroamMarker = "} else if(this.mode==='freeroam' && !NakamaNet.isHost){\n        NakamaNet.sendMatchData({t: 'input', input});\n      }";

// Find the FIRST freeroam marker AFTER blockStart (that's the end of our block)
let freeroamIdx = d.indexOf(freeroamMarker, blockStart);
if (freeroamIdx < 0) {
  console.log('WARN: could not find freeroam marker after block start');
  process.exit(1);
}

// The block we want to replace runs from blockStart to freeroamIdx
const blockEnd = freeroamIdx;

console.log('Found duplicate sendInput block at chars', blockStart, '..', blockEnd, '(', (blockEnd-blockStart), 'chars )');

// Replace the entire duplicated block with the correct single-check version
d = d.slice(0, blockStart) + correctBlock + d.slice(blockEnd);

fs.writeFileSync(path, d, 'utf8');
console.log('WROTE', path, 'new size', d.length, 'bytes');
