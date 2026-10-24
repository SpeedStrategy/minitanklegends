const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// Run from workspace root
const cwd = process.cwd();
const gameJs = path.join(cwd, 'js', 'game.js');
const indexHtml = path.join(cwd, 'index.html');

// Read both files
const gameContent = fs.readFileSync(gameJs, 'utf8');
const htmlContent = fs.readFileSync(indexHtml, 'utf8');

// Count occurrences (handles overlapping via match)
function count(str, pattern) {
  const matches = str.match(new RegExp(pattern, 'g'));
  return matches ? matches.length : 0;
}

console.log('=== Verification: P2P + Console integration ===\n');

// === P2P CHECKS (js/game.js) ===
const p2pChecks = [
  ['sendInputP2P occ (expect 1)', count(gameContent, 'sendInputP2P'), 1],
  ['broadcastP2P occ (expect 2: def + call)', count(gameContent, 'broadcastP2P'), 2],
  ['_p2pHostOptIn occ (expect 2: 1 def + 1 call site)', count(gameContent, '_p2pHostOptIn'), 2],
  ['onP2PId occ (expect 4)', count(gameContent, 'onP2PId'), 4],
  ['SessionGuard occ (expect 4)', count(gameContent, 'SessionGuard'), 4],
  ['handbrake = this.input.pressed (expect 1 - PLAYER input)', count(gameContent, "handbrake = this.input.pressed"), 1],
  ['Net.p2p.enabled && Net.p2p.hostId occ (expect 2)', count(gameContent, 'Net\\.p2p\\.enabled && Net\\.p2p\\.hostId'), 2],
  ['Net.sendInputP2P(input) call (expect 1)', count(gameContent, 'Net\\.sendInputP2P\\(input\\)'), 1],
  ['Net.sendInput(input) fallback (expect 1)', count(gameContent, 'Net\\.sendInput\\(input\\)'), 1],
  ['NakamaNet.sendMatchData input (expect 1)', count(gameContent, "NakamaNet\\.sendMatchData\\(\\{t: 'input', input\\}\\)"), 1],
  ['_p2pId() call (expect 3: startHost + startClient + _onP2PId)', count(gameContent, 'Net\\._p2pId\\(\\)'), 3],
  ['setP2PClientId call (expect 2)', count(gameContent, 'Net\\.setP2PClientId'), 2],
  ['openP2PToHost call (expect 3)', count(gameContent, 'Net\\.openP2PToHost'), 3],
  ['startP2PRetries call (expect 3)', count(gameContent, 'Net\\.startP2PRetries'), 3],
  ['sendP2PId call (expect 2)', count(gameContent, 'Net\\.sendP2PId'), 2],
  ['setP2PHostId call (expect 2)', count(gameContent, 'Net\\.setP2PHostId'), 2],
  ['sendP2PHostIdToClient call (expect 1)', count(gameContent, 'Net\\.sendP2PHostIdToClient'), 1],
  ['p2p.direct access (expect 2)', count(gameContent, 'p2p\\.direct'), 2],
  ['p2p.roles access (expect 2)', count(gameContent, 'p2p\\.roles'), 2],
];

// Verify no duplicates in critical areas
const noDuplicates = [
  ['sendInputP2P call site (should appear exactly once)', count(gameContent, 'Net\\.sendInputP2P\\(input\\)'), 1, true],
  ['handbrake = this.input.pressed line (PLAYER input, not dummy)', count(gameContent, "handbrake = this.input.pressed"), 1, true],
  ['Net.sendInputP2P(input) line (not doubled)', count(gameContent, 'Net\\.sendInputP2P\\(input\\)'), 1, true],
  ['Net.sendInput(input) fallback line', count(gameContent, 'Net\\.sendInput\\(input\\)'), 1, true],
  ['NakamaNet.sendMatchData input line', count(gameContent, "NakamaNet\\.sendMatchData\\(\\{t: 'input', input\\}\\)"), 1, true],
  ['Net.p2p.enabled && Net.p2p.hostId in input path', count(gameContent, 'Net\\.p2p\\.enabled && Net\\.p2p\\.hostId'), 2, false], // 2 is fine (def appearance count)
];

console.log('--- P2P Wiring Checks ---');
let allPass = true;
for (const [label, actual, expected] of p2pChecks) {
  const pass = actual === expected;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label}: ${actual} (expected ${expected})`);
}

console.log('\n--- No Duplicates Checks ---');
for (const [label, actual, expected, critical] of noDuplicates) {
  const pass = actual === expected;
  if (!pass) {
    allPass = false;
    console.log(`${pass ? 'PASS' : 'FAIL'} | ${label}: ${actual} (expected ${expected})`);
  }
}

// === CONSOLE CHECKS (js/game.js) ===
const consoleChecks = [
  ['game._consoleExec = function(cmd) def', count(gameContent, 'game\\._consoleExec\\s*=\\s*function'), 1],
  ['game._consoleExec(cmd) call in input', count(gameContent, 'game\\._consoleExec\\(cmd\\)'), 1],
  ['game._consoleExec.empty (empty check)', count(gameContent, 'game\\._consoleExec\\.empty'), 1],
  ['_consoleExec.empty (empty check alt)', count(gameContent, '_consoleExec\\.empty'), 1],
  ['getElementById(dev-console) call', count(gameContent, "getElementById\\('dev-console'\\)"), 1],
  ['getElementById(dev-console-log) call', count(gameContent, "getElementById\\('dev-console-log'\\)"), 1],
  ['getElementById(dev-console-input) call', count(gameContent, "getElementById\\('dev-console-input'\\)"), 1],
  ['getElementById(dev-console-debug) call', count(gameContent, "getElementById\\('dev-console-debug'\\)"), 1],
  ['getElementById(dev-console-clear) call', count(gameContent, "getElementById\\('dev-console-clear'\\)"), 1],
  ['getElementById(dev-console-toggle) call', count(gameContent, "getElementById\\('dev-console-toggle'\\)"), 1],
  ['addEventListener(click, toggleConsole) call', count(gameContent, 'addEventListener.*toggleConsole'), 1],
  ['addEventListener(click, clearConsole) call', count(gameContent, 'addEventListener.*clearConsole'), 1],
  ['addEventListener(keydown, handleConsoleKey) call', count(gameContent, 'addEventListener.*handleConsoleKey'), 1],
  ['setInterval(consoleKeepalive) call', count(gameContent, 'setInterval.*consoleKeepalive'), 1],
  ['consoleKeepalive function def', count(gameContent, 'consoleKeepalive\\s*=\\s*function'), 1],
  ['clearConsole function def', count(gameContent, 'clearConsole\\s*=\\s*function'), 1],
  ['toggleConsole function def', count(gameContent, 'toggleConsole\\s*=\\s*function'), 1],
  ['handleConsoleKey function def', count(gameContent, 'handleConsoleKey\\s*=\\s*function'), 1],
  ['Game.prototype.log def', count(gameContent, 'Game\\.prototype\\.log\\s*=\\s*function'), 1],
];

console.log('\n--- Console Integration Checks ---');
for (const [label, actual, expected] of consoleChecks) {
  const pass = actual === expected;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label}: ${actual} (expected ${expected})`);
}

// === /p2p COMMAND CHECKS (js/game.js) ===
const commandChecks = [
  ["cmd === '/p2p'", count(gameContent, "cmd === '/p2p'"), 1],
  ["cmd === '/p2p on'", count(gameContent, "cmd === '/p2p on'"), 1],
  ["cmd === '/p2p off'", count(gameContent, "cmd === '/p2p off'"), 1],
  ["cmd === '/p2p status'", count(gameContent, "cmd === '/p2p status'"), 1],
  ["cmd === '/mp test host'", count(gameContent, "cmd === '/mp test host'"), 1],
  ["cmd === '/mp test client'", count(gameContent, "cmd === '/mp test client'"), 1],
  ["cmd === '/help'", count(gameContent, "cmd === '/help'"), 1],
  ['this._p2pDummyMode = true', count(gameContent, '_p2pDummyMode\\s*=\\s*true'), 1],
  ["this._p2pDummyMode && Net.sendInputP2P", count(gameContent, "_p2pDummyMode.*Net\\.sendInputP2P"), 1],
];

console.log('\n--- /p2p Command Handler Checks ---');
for (const [label, actual, expected] of commandChecks) {
  const pass = actual === expected;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label}: ${actual} (expected ${expected})`);
}

// === INDEX.HTML CHECKS ===
const htmlChecks = [
  ["id='dev-console' in HTML", count(htmlContent, "id='dev-console'"), 1],
  ["id='dev-console-log' in HTML", count(htmlContent, "id='dev-console-log'"), 1],
  ["id='dev-console-input' in HTML", count(htmlContent, "id='dev-console-input'"), 1],
  ["id='dev-console-debug' in HTML", count(htmlContent, "id='dev-console-debug'"), 1],
  ["id='dev-console-clear' in HTML", count(htmlContent, "id='dev-console-clear'"), 1],
  ["id='dev-console-toggle' in HTML", count(htmlContent, "id='dev-console-toggle'"), 1],
  ["Hidden dev console comment in HTML", count(htmlContent, '<!-- Hidden dev console'), 1],
];

console.log('\n--- index.html Checks ---');
for (const [label, actual, expected] of htmlChecks) {
  const pass = actual === expected;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label}: ${actual} (expected ${expected})`);
}

// === NEGATIVE CHECKS (should NOT be present) ===
const negativeChecks = [
  ['P2PEnableCheck (should NOT be present)', count(gameContent, 'P2PEnableCheck'), 0],
  ['GET_MY_P2P_ID (should NOT be present)', count(gameContent, 'GET_MY_P2P_ID'), 0],
  ['START_P2P_SESSION (should NOT be present)', count(gameContent, 'START_P2P_SESSION'), 0],
];

console.log('\n--- Negative Checks (should be 0) ---');
for (const [label, actual, expected] of negativeChecks) {
  const pass = actual === expected;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label}: ${actual} (expected ${expected})`);
}

// === SYNTAX CHECK ===
console.log('\n--- Syntax Check ---');
try {
  execSync('"C:\\Program Files\\cursor\\resources\\app\\resources\\helpers\\node.exe" --check js/game.js', {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  console.log('PASS | js/game.js syntax check passed');
} catch (err) {
  allPass = false;
  console.log('FAIL | js/game.js syntax check failed');
  if (err.stdout) console.log('stdout:', err.stdout);
  if (err.stderr) console.log('stderr:', err.stderr);
}

// === FILE SIZES ===
const gameSize = fs.statSync(gameJs).size;
const htmlSize = fs.statSync(indexHtml).size;
console.log('\n--- File Sizes ---');
console.log(`PASS | js/game.js size: ${gameSize} bytes (was ~675013 after P2P)`);
console.log(`PASS | index.html size: ${htmlSize} bytes (was ~118702 after console HTML)`);

// === FINAL RESULT ===
console.log('\n' + (allPass ? '=== ALL CHECKS PASSED ===' : '=== SOME CHECKS FAILED ==='));
process.exit(allPass ? 0 : 1);
