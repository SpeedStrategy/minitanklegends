const fs = require('fs');
const path = 'js/game.js';
let src = fs.readFileSync(path, 'utf8');

const PATCHES = [
  // 1. Console exec (append a full hidden dev-console implementation after the
  //    bootstrap try/catch so it is available on window._game once the game is live).
  {
    name: 'hidden console exec',
    test: () => src.includes('game._consoleExec = function(cmd)'),
    apply: () => {
      // Anchor on the bootstrap try/catch end so the console init runs after window._game is set.
      const anchor = `  } catch(e){ console.warn('session guard could not start:', e); }\n`;
      if (!src.includes(anchor)) {
        console.error('ERROR: bootstrap anchor not found');
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
      src = src.replace(anchor, anchor + template);
    },
  },

  // 2. /p2p command handlers (insert into the text-input dispatcher so they are
  //    reachable from the same place the console reads typed input).
  {
    name: '/p2p on / off / status + /mp test host / client + /help',
    test: () => src.includes("cmd === '/p2p on'"),
    apply: () => {
      // Anchor on the line that splits incoming text into cmd.  We need the UNIQUE
      // occurrence inside the console's own input handler (the one that reads from
      // #dev-console-input).  That line is the first occurrence of this exact pattern
      // that sits inside the hidden console block we just injected; but since the
      // console block is unique, we can anchor on the combination.
      const anchor = `        const cmd = (text || '').trim().toLowerCase();\n`;
      // Make sure we only patch the FIRST occurrence (the one inside the console).
      if (!src.includes(anchor)) {
        console.error('ERROR: cmd anchor not found');
        process.exit(1);
      }
      const block = [
        `        const cmd = (text || '').trim().toLowerCase();`,
        ``,
        `        // ---- buffy: hidden console commands ----`,
        `        if (cmd === '/p2p') {`,
        `          this.log('P2P fast path: ' + (Net && Net.p2p ? (Net.p2p.enabled ? 'ON' : 'configured, currently OFF') : 'not available') + '. Use /p2p on or /p2p off.');`,
        `        } else if (cmd === '/p2p on') {`,
        `          if (Net && Net.p2p) {`,
        `            Net.p2p.enabled = true;`,
        `            this.log('P2P fast path turned ON for this match (host must still opt in).');`,
        `          } else {`,
        `            this.log('P2P not available in this build.');`,
        `          }`,
        `        } else if (cmd === '/p2p off') {`,
        `          if (Net && Net.p2p) {`,
        `            Net.p2p.enabled = false;`,
        `            this.log('P2P fast path turned OFF; traffic goes back to the relay.');`,
        `          } else {`,
        `            this.log('P2P not available in this build.');`,
        `          }`,
        `        } else if (cmd === '/p2p status') {`,
        `          if (Net && Net.p2p) {`,
        `            const e = Net.p2p.enabled;`,
        `            const h = Net.p2p.hostId;`,
        `            const my = Net.p2p.myId;`,
        `            const direct = Net.p2p.direct && Net.p2p.direct[h];`,
        `            this.log('P2P status: enabled=' + e + ' myId=' + (my || '-') + ' hostId=' + (h || '-') + ' directOpen=' + (direct && direct.open ? 'yes' : 'no'));`,
        `          } else {`,
        `            this.log('P2P not available in this build.');`,
        `          }`,
        `        } else if (cmd === '/mp test host') {`,
        `          this.log(' multiplayer test: starting a host session would go here (not wired yet).');`,
        `        } else if (cmd === '/mp test client') {`,
        `          this.log(' multiplayer test: joining as a client would go here (not wired yet).');`,
        `        } else if (cmd === '/help') {`,
        `          this.log('Hidden console commands: /p2p, /p2p on, /p2p off, /p2p status, /mp test host, /mp test client, /help.');`,
        `        }`,
      ].join('\n');
      src = src.replace(anchor, block);
    },
  },

  // 3. P2P_MODE_GUARD — when the hidden console flips the local player into a
  //    "dummy" P2P client, its own input is forwarded to the host and the local
  //    tank is driven by the host's snapshots instead.
  {
    name: 'P2P_MODE_GUARD (dummy P2P client input forwarding)',
    test: () => src.includes('if (this._p2pDummyMode) {'),
    apply: () => {
      const anchor = `        this.localTank.setInput(input);\n`;
      // Guard against applying to the wrong place: there should be exactly one
      // occurrence inside the _forwardInput block.  If there's more than one we
      // still patch the first (the real one) but log a warning.
      const firstIdx = src.indexOf(anchor);
      if (firstIdx < 0) {
        console.error('ERROR: this.localTank.setInput(input) anchor not found');
        process.exit(1);
      }
      const injection = [
        `        this.localTank.setInput(input);`,
        ``,
        `        // buffy: hidden console can flip this client into a P2P 'dummy' that`,
        `        // only forwards its own inputs to the host and never drives its own tank.`,
        `        if (this._p2pDummyMode) {`,
        `          if (typeof Net !== 'undefined' && Net.sendInputP2P) {`,
        `            try { Net.sendInputP2P(input); } catch (_) {}`,
        `          }`,
        `          input = { throttle: 0, turn: 0, turretWorldAngle: 0, fire: false, handbrake: false };`,
        `        }`,
      ].join('\n');
      src = src.replace(anchor, injection);
    },
  },
];

let changed = false;
for (const p of PATCHES) {
  if (p.test()) {
    console.log(`[skip] ${p.name} (already present)`);
    continue;
  }
  p.apply();
  console.log(`[applied] ${p.name}`);
  changed = true;
}

if (!changed) {
  console.log('[info] no patches needed');
}

fs.writeFileSync(path, src, 'utf8');
console.log(`Wrote ${path} (${(src.length).toLocaleString()} bytes)`);
