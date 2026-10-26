const fs = require('fs');
const path = 'js/game.js';
let src = fs.readFileSync(path, 'utf8');

const PATCHES = [
  // 1. Console exec — appended after the bootstrap try/catch so it is available
  //    on window._game once the game is live.
  {
    name: 'hidden console exec',
    test: () => src.includes('game._consoleExec = function(cmd)'),
    apply: () => {
      // Anchor on the bootstrap try/catch end.
      // IMPORTANT: the anchor must match the EXACT whitespace in the file.
      // The actual file uses SPACES here, not tabs, and has a trailing newline.
      const anchor = `  } catch (e) { console.warn('session guard could not start:', e); }\n`;
      if (!src.includes(anchor)) {
        // Fallback: try to find the anchor with flexible whitespace
        console.error('ERROR: bootstrap anchor not found with expected whitespace');
        console.error('Searching for alternative anchors...');
        // Try to find any line containing 'session guard could not start'
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes("console.warn('session guard could not start:'")) {
            console.error(`Found at line ${i + 1}: ${JSON.stringify(lines[i])}`);
            // Use this exact line as the anchor
            const actualAnchor = lines[i] + '\n';
            const template = `
    // ---- Hidden dev console (buffy) ----
    (function(){
      const _logEl = document.getElementById('dev-console-log');
      const _inEl  = document.getElementById('dev-console-input');
      const _dbgEl = document.getElementById('dev-console-debug');
      const _outEl = document.getElementById('dev-console');
      const _togEl = document.getElementById('dev-console-toggle');
      const _clrEl = document.getElementById('dev-console-clear');

      let _open = false;

      function log(msg){
        if(!_logEl) return;
        const line = document.createElement('div');
        line.textContent = String(msg);
        _logEl.appendChild(line);
        _logEl.scrollTop = _logEl.scrollHeight;
      }

      window.game._consoleExec = function(cmd){
        if(typeof cmd !== 'string' || cmd.trim().length === 0) return;
        const trimmed = cmd.trim();
        log('> ' + trimmed);
        try {
          // eslint-disable-next-line no-eval
          const result = eval.call(window, trimmed);
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

      function handleConsoleKey(e){
        if(!_open) return;
        if(e.key === 'Enter' && _inEl === document.activeElement){
          e.preventDefault();
          if(_inEl){
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
          open: ()=>{ if(!_open) toggleConsole(); },
          close: ()=>{ if(_open) toggleConsole(); },
          isOpen: ()=> _open,
        };
      }
    })();
`;
            src = src.replace(actualAnchor, actualAnchor + template);
            console.log('Applied console patch using fallback anchor at line', i + 1);
            return;
          }
        }
        process.exit(1);
      }
      const template = `
    // ---- Hidden dev console (buffy) ----
    (function(){
      const _logEl = document.getElementById('dev-console-log');
      const _inEl  = document.getElementById('dev-console-input');
      const _dbgEl = document.getElementById('dev-console-debug');
      const _outEl = document.getElementById('dev-console');
      const _togEl = document.getElementById('dev-console-toggle');
      const _clrEl = document.getElementById('dev-con
