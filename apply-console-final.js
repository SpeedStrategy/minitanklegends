const fs = require('fs');
const path = 'js/game.js';
let src = fs.readFileSync(path, 'utf8');

// This patch is FULLY SELF-CONTAINED: it appends a complete hidden dev-console
// implementation after the bootstrap try/catch. The console has its own input
// handler, its own /p2p command parser, and its own P2P_MODE_GUARD. It depends
// on NOTHING that isn't already in the committed base ( Game.prototype.log,
// window._game, document.getElementById ).
//
// Anchors robustly on the bootstrap catch block (tries spaced, compact, and
// line-scan forms), then appends the entire console block in one shot.

const bootstrapAnchors = [
  `  } catch (e) { console.warn('session guard could not start:', e); }\n`,
  `  } catch(e){ console.warn('session guard could not start:', e); }\n`,
  `  } catch (e) { console.warn('session guard could not start:', e); }` + '\n',
];

let anchor = null;
for (const a of bootstrapAnchors) {
  if (src.includes(a)) { anchor = a; break; }
}
if (!anchor) {
  // line-scan fallback
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("console.warn('session guard could not start:'")) {
      anchor = lines[i] + '\n';
      console.log(`[info] using fallback bootstrap anchor at line ${i + 1}`);
      break;
    }
  }
}
if (!anchor) {
  console.error('ERROR: bootstrap anchor not found');
  process.exit(1);
}

// If the console block is already present, skip entirely.
if (src.includes('// ---- Hidden dev console (buffy) ----')) {
  console.log('[skip] hidden dev console already present — no changes');
  process.exit(0);
}

const consoleBlock = `
    // ---- Hidden dev console (buffy) ----
    (function(){
      var _logEl = document.getElementById('dev-console-log');
      var _inEl  = document.getElementById('dev-console-input');
      var _dbgEl = document.getElementById('dev-console-debug');
      var _outEl = document.getElementById('dev-console');
      var _togEl = document.getElementById('dev-console-toggle');
      var _clrEl = document.getElementById('dev-console-clear');

      var _open = false;

      function log(msg){
        if(!_logEl) return;
        var line = document.createElement('div');
        line.textContent = String(msg);
        _logEl.appendChild(line);
        _logEl.scrollTop = _logEl.scrollHeight;
      }

      // Expose the executor on window.game so the console input handler and
      // any external caller can eval arbitrary JS in the page context.
      window.game._consoleExec = function(cmd){
        if(typeof cmd !== 'string' || cmd.trim().length === 0) return;
        var trimmed = cmd.trim();
        log('> ' + trimmed);
        try {
          var result = eval.call(window, trimmed);
          log('= ' + result);
        } catch(e) {
          log('! ' + (e && e.message ? e.message : String(e)));
        }
      };

      window.game._consoleExec.empty = function(){
        if(!_logEl) return;
        _logEl.innerHTML = '';
        log('console cleared');
      };

      function toggleConsole(){
        _open = !_open;
        if(_outEl)  _outEl.style.display = _open ? 'block' : 'none';
        if(_inEl)   _inEl.disabled = !_open;
        if(_dbgEl)  _dbgEl.style.display = _open ? 'block' : 'none';
        if(_togEl)  _togEl.textContent = _open ? 'Hide console' : 'Show console';
        if(_open && _inEl) _inEl.focus();
      }

      function clearConsole(){
        if(!_logEl) return;
        _logEl.innerHTML = '';
        log('console cleared');
      }

      // ---- buffy: hidden console commands ----
      // Parsed inside the Enter-key handler below. Kept as a separate function
      // so the /p2p handlers are easy to read and extend.
      function runConsoleCommand(cmd){
        if (cmd === '/p2p') {
          log('P2P fast path: ' + (typeof Net !== 'undefined' && Net.p2p ? (Net.p2p.enabled ? 'ON' : 'configured, currently OFF') : 'not available') + '. Use /p2p on or /p2p off.');
        } else if (cmd === '/p2p on') {
          if (typeof Net !== 'undefined' && Net.p2p) {
            Net.p2p.enabled = true;
            log('P2P fast path turned ON for this match (host must still opt in).');
          } else {
            log('P2P not available in this build.');
          }
        } else if (cmd === '/p2p off') {
          if (typeof Net !== 'undefined' && Net.p2p) {
            Net.p2p.enabled = false;
            log('P2P fast path turned OFF; traffic goes back to the relay.');
          } else {
            log('P2P not available in this build.');
          }
        } else if (cmd === '/p2p status') {
          if (typeof Net !== 'undefined' && Net.p2p) {
            var e = Net.p2p.enabled;
            var h = Net.p2p.hostId;
            var my = Net.p2p.myId;
            var direct = Net.p2p.direct && Net.p2p.direct[h];
            log('P2P status: enabled=' + e + ' myId=' + (my || '-') + ' hostId=' + (h || '-') + ' directOpen=' + (direct && direct.open ? 'yes' : 'no'));
          } else {
            log('P2P not available in this build.');
          }
        } else if (cmd === '/mp test host') {
          log(' multiplayer test: starting a host session would go here (not wired yet).');
        } else if (cmd === '/mp test client') {
          log(' multiplayer test: joining as a client would go here (not wired yet).');
        } else if (cmd === '/help') {
          log('Hidden console commands: /p2p, /p2p on, /p2p off, /p2p status, /mp test host, /mp test client, /help.');
        }
      }

      function handleConsoleKey(e){
        if(!_open) return;
        if(e.key === 'Enter' && _inEl === document.activeElement){
          e.preventDefault();
          if(_inEl){
            var text = _inEl.value;
            if(typeof text === 'string' && text.trim().length > 0){
              var cmd = text.trim().toLowerCase();
              runConsoleCommand(cmd);
            }
            window.game._consoleExec(_inEl.value.trim());
            _inEl.value = '';
          }
        }
      }

      function consoleKeepalive(){
        if(!_open) return;
        if(_dbgEl) _dbgEl.textContent = (window.game ? 'game: ok' : 'game: not ready');
      }

      if(_togEl) _togEl.addEventListener('click', toggleConsole);
      if(_clrEl) _clrEl.addEventListener('click', clearConsole);
      if(_inEl)  _inEl.addEventListener('keydown', handleConsoleKey);
      setInterval(consoleKeepalive, 2000);

      // expose a minimal API on window.game so the console can interrogate the game
      if(window.game && !window.game.console){
        window.game.console = {
          exec: window.game._consoleExec,
          log: log,
          toggle: toggleConsole,
          clear: clearConsole,
          open: function(){ if(!_open) toggleConsole(); },
          close: function(){ if(_open) toggleConsole(); },
          isOpen: function(){ return _open; }
        };
      }

      // ---- buffy: P2P_MODE_GUARD ----
      // When the hidden console flips this client into a 'dummy' P2P client,
      // its own input is forwarded to the host and the local tank is driven
      // by the host's snapshots instead. Guard the real player input path.
      var _origForwardInput = window.game.prototype._forwardInput;
      // If the game already has the dummy-mode flag wired by a prior patch,
      // guard the existing input path. Otherwise install the guard at the
      // localTank.setInput call site inside _forwardInput (if present).
      try {
        var _gt = window.game.prototype;
        if(typeof _gt._forwardInput === 'function'){
          var _fwd = _gt._forwardInput;
          _gt._forwardInput = function(){
            // call through to the original
            var args = arguments;
            var ret = _fwd.apply(this, args);
            // After the original forwards input, if we are in dummy mode,
            // blank out the local input so the local tank does not drive itself.
            if(this._p2pDummyMode){
              if(this.localTank){
                this.localTank.setInput({ throttle: 0, turn: 0, turretWorldAngle: 0, fire: false, handbrake: false });
              }
            }
            return ret;
          };
        }
      } catch(_) {}
    })();
`;

src = src.replace(anchor, anchor + consoleBlock);

fs.writeFileSync(path, src, 'utf8');
console.log(`Wrote ${path} (${(src.length).toLocaleString()} bytes)`);
console.log('[applied] hidden dev console (self-contained: exec + /p2p commands + P2P_MODE_GUARD)');
