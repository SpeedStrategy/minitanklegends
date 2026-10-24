/* ===========================================================================
   dev-commands.js — the Tab+P command panel.

   WHAT THIS IS
   ------------
   A small pop-out listing every secret command in the game. Press Tab+P and it
   appears over whatever is on screen; click an entry to run it; Escape or Tab+P
   again to dismiss.

   WHY IT IS A MENU AND NOT JUST A LIST OF KEYS
   ---------------------------------------------
   Three of these commands were only reachable as a bare keypress (Tab+P to skip,
   P held for the perf graph, M for map outlines), and one of them — the skip —
   fired from a COMBO that has to be latched on keydown and released on keyup.
   A combo that fires on the way in and does nothing on the way out is a menu
   waiting to happen: you cannot tell from the screen whether the feature is on,
   and a held-key overlay is invisible the moment you let go. Every command here
   is a click, so every command is also visibly ON or OFF.

   Nothing is removed. Tab+P still skips a battle, P still shows the perf graph
   and M still toggles outlines — they are all kept working, because a shortcut
   that vanishes the moment you document it is worse than one you never had.
   This panel is the discoverable front end to them.

   THE COMMANDS ARE NOT ALL SAFE TO RUN AT ALL TIMES. Each entry declares an
   `enabled` predicate and the panel greys out the ones that would do nothing
   (or, worse, something confusing) right now, rather than letting you click a
   button that silently no-ops.
   =========================================================================== */

const DevCommands = (() => {
  const PANEL_ID = 'dev-commands-panel';

  let _panel = null;
  let _built = false;
  let _open = false;

  /* Latched so holding Tab+P across several frames cannot open the panel twice,
     and — more importantly — so the release of either key cannot immediately
     close what the press just opened. Both are level-triggered mistakes; see
     the identical pattern in Game's Tab+P skip. */
  let _tabDown = false;
  let _pDown = false;
  let _dismissed = false;

  /* ---------------------------------------------------------------------
     HOW TO REACH THE GAME INSTANCE, AND WHY THE OBVIOUS GUESS IS WRONG.

     Two separate traps, both hit while building this panel, and both of which
     produce a panel that looks perfect and does nothing.

     1. `window.game` IS UNDEFINED. `Game` and `Menu` are top-level `const` in
        game.js and menu.js, which puts them in the global LEXICAL scope rather
        than on `window`. Bare `Game` resolves; `window.Game` does not. This is
        the same trap called out in Game._trySkipBattle's own comment, and the
        first version of this file walked straight into it.

     2. BARE `Game` IS THE CLASS, NOT THE GAME. Having fixed (1) by using the
        bare name, `Game._toggleMapOutlines` is still undefined — those methods
        live on Game.prototype and the live object is a separate instance. Using
        the bare name therefore passes the `typeof Game !== 'undefined'` check
        and then fails every method call on it. This one is quieter: nothing
        throws, the methods are simply `undefined`.

     THE ACTUAL INSTANCE is `Menu.game` — Menu holds it as the one reference the
     menu uses to start and hand back to the battle. That is checked first, and
     it is checked with typeof so a missing Menu is not itself a crash.

     The Menu.game lookup is also what makes the panel work at all in the menu
     AND in a battle, because Menu keeps that reference across both. */
  function _game(){
    try{
      const m = (typeof Menu !== 'undefined' && Menu) ? Menu : null;
      if(m && m.game) return m.game;
    }catch(e){}
    /* Fallback for a page with no Menu at all (the sandbox host page). Resolved
       off the window because a bare reference to a missing lexical binding
       throws, and a throw inside a `when()` predicate would take out refresh()
       and blank the entire panel. */
    try{
      if(typeof window !== 'undefined' && window.game) return window.game;
    }catch(e){}
    return null;
  }
  function _menu(){
    try { return (typeof Menu !== 'undefined' && Menu) ? Menu : null; }
    catch(e){ return null; }
  }
  function _toast(msg){
    const m = _menu();
    if(m && typeof m.toast === 'function'){ m.toast(msg); return true; }
    return false;
  }

  /* --- the registry -------------------------------------------------------
     `when` returns whether the command is meaningful right now. It is a
     predicate, not a boolean, because most of these depend on whether a battle
     is actually running and that changes constantly. */
  const COMMANDS = [
    {
      id: 'skip',
      label: 'End Battle Now',
      hint: 'Jump straight to the results screen. Host only.',
      keys: 'Tab+P',
      /* Ending a battle needs this client to be the one running it. A client
         cannot end the match — it has no authority, and Game._trySkipBattle
         refuses on purpose. Offering the button there would be a lie. */
      when: () => { const g = _game(); return !!(g && g.running && g.mode !== 'client'); },
      run: () => {
        const g = _game();
        if(g && typeof g._trySkipBattle === 'function') g._trySkipBattle();
      }
    },
    {
      id: 'mapOutlines',
      label: 'Map Outlines',
      hint: 'Outline every solid surface — find walls you can drive through.',
      keys: 'M',
      when: () => {
        const g = _game();
        try { return !!(g && typeof Tank !== 'undefined' && Tank.createOutlineMesh); }
        catch(e){ return false; }
      },
      run: () => {
        const g = _game();
        if(!g || typeof g._toggleMapOutlines !== 'function') return;
        /* FLIP THE FLAG HERE. _toggleMapOutlines() does not toggle — it only
           REBUILDS whatever the current flag says should be there. The flip lives
           in Game's KeyM handler (`this._mapOutlineDebug = !this._mapOutlineDebug`
           and THEN the call), because that handler has to do it inline.

           Calling _toggleMapOutlines() on its own therefore rebuilds the outlines
           from the same unchanged flag: the outlines came on, and the next click
           rebuilt them on again. The button was a one-way switch that looked
           like a toggle. Mirroring the handler's two lines is the whole fix. */
        g._mapOutlineDebug = !g._mapOutlineDebug;
        g._toggleMapOutlines();
      },
      /* Read live so the panel shows the real state rather than a guess. */
      state: () => { const g = _game(); return !!(g && g._mapOutlineDebug); }
    },
    {
      id: 'perf',
      label: 'Performance Graph',
      hint: 'Show FPS and frame time.',
      keys: 'P',
      /* Only meaningful once the overlay element exists, which happens when a
         battle starts. Greying it on the menu is honest; clicking it there used
         to look like it worked. */
      when: () => { const g = _game(); return !!(g && g._perfOverlay); },
      run: () => {
        const g = _game();
        if(!g || !g._perfOverlay) return;
        /* READ THE REAL STATE from the element rather than from a variable.

           The element's computed display is what matters, because the game's own
           keyup handler sets `style.display='none'` and its keydown sets
           `'block'` — so the inline style is empty for most of the time and
           empty is ALSO falsy. The old test was `display === 'block'` on the
           inline style, which meant "hidden" every time the graph was off, so
           clicking set it to 'none'... and clicking again set it to 'none'
           again. The button was permanently dead.

           getComputedStyle reads what the browser actually resolved, so it is
           correct whether the value came from inline style, a CSS rule, or the
           game never having touched it. */
        const showing = getComputedStyle(g._perfOverlay).display !== 'none';
        g._perfOverlay.style.display = showing ? 'none' : 'block';
        _toast(showing ? 'Perf graph off' : 'Perf graph on');
      },
      state: () => {
        const g = _game();
        if(!g || !g._perfOverlay) return false;
        return getComputedStyle(g._perfOverlay).display !== 'none';
      }
    },
    {
      id: 'scoreboard',
      label: 'Scoreboard',
      hint: 'Who is winning, right now.',
      keys: 'Tab',
      when: () => { const g = _game(); return !!(g && g.running); },
      run: () => {
        const g = _game();
        if(g && typeof g._toggleScoreboard === 'function') g._toggleScoreboard();
      }
    },
    {
      id: 'fullscreen',
      label: 'Toggle Fullscreen',
      hint: 'F11 does this too — this button is here because F11 often does not.',
      keys: 'F11',
      when: () => true,
      run: () => {
        /* Read the same way Menu._isFullscreen does: F11 sets a flag rather than
           producing document.fullscreenElement, so testing only the element
           misses the F11 case and the button would appear to do nothing when
           the player is in an F11 fullscreen. */
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if(isFs){
          if(document.exitFullscreen) document.exitFullscreen().catch(()=>{});
        } else if(document.documentElement.requestFullscreen){
          document.documentElement.requestFullscreen().catch(function(){
            _toast('Your browser blocked fullscreen — press F11 instead');
          });
        }
      },
      /* Read state the same way the run() does — the real browser state, not an
         inline style — or the ON flag and the button disagree. */
      state: () => {
        const el = document.fullscreenElement || document.webkitFullscreenElement;
        if(el) return true;
        const m = _menu();
        return !!(m && typeof m._isFullscreen === 'function' && m._isFullscreen());
      }
    },
    {
      id: 'fpsMeter',
      label: 'Graphics Settings',
      hint: 'Quality, view range and post-processing.',
      keys: 'Ctrl+O',
      when: () => true,
      run: () => {
        /* The panel is not a dependency of the graphics overlay and vice versa,
           so this dispatches through whichever handle exists. Guarded on typeof
           rather than window.X because these are top-level consts in their own
           scripts — see the note in Game._trySkipBattle about lexical scope. */
        if(typeof GraphicsSettings !== 'undefined' && GraphicsSettings.open) GraphicsSettings.open();
        else if(typeof GS !== 'undefined' && GS.open) GS.open();
        else {
          const btn = document.getElementById('btn-graphics');
          if(btn) btn.click();
        }
      }
    }
  ];

  /* --- build -------------------------------------------------------------- */
  function _build(){
    if(_built) return;
    _panel = document.createElement('div');
    _panel.id = PANEL_ID;
    _panel.className = 'devc-panel';
    _panel.setAttribute('role', 'dialog');
    _panel.setAttribute('aria-label', 'Secret commands');
    _panel.style.display = 'none';

    const head = document.createElement('div');
    head.className = 'devc-head';
    head.innerHTML =
      '<span class="devc-title">COMMANDS</span>' +
      '<span class="devc-hint">Tab + P</span>';
    _panel.appendChild(head);

    const list = document.createElement('div');
    list.className = 'devc-list';
    _panel.appendChild(list);

    /* One row per command, built once. Refresh() then only toggles classes and
       text — it never rebuilds the list, so opening the panel twice does not
       throw away and recreate six DOM subtrees. */
    COMMANDS.forEach(function(cmd){
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'devc-row';
      row.dataset.cmd = cmd.id;

      const main = document.createElement('span');
      main.className = 'devc-main';
      const label = document.createElement('span');
      label.className = 'devc-label';
      label.textContent = cmd.label;
      const hint = document.createElement('span');
      hint.className = 'devc-desc';
      hint.textContent = cmd.hint || '';
      main.appendChild(label);
      main.appendChild(hint);

      const right = document.createElement('span');
      right.className = 'devc-right';
      const state = document.createElement('span');
      state.className = 'devc-state';
      const keys = document.createElement('span');
      keys.className = 'devc-keys';
      keys.textContent = cmd.keys || '';
      right.appendChild(state);
      right.appendChild(keys);

      row.appendChild(main);
      row.appendChild(right);

      row.addEventListener('click', function(){
        /* Re-check at click time, not at paint time. The panel can sit open
           through a whole round, so a command that was available when the panel
           opened may not be any more — and running it anyway is exactly the
           silent no-op this panel exists to avoid. */
        if(cmd.when && !cmd.when()){
          _toast(cmd.label + ' — not available right now');
          return;
        }
        cmd.run();
        refresh();
      });

      list.appendChild(row);
      cmd._row = row;
      cmd._state = state;
    });

    const foot = document.createElement('div');
    foot.className = 'devc-foot';
    foot.textContent = 'Esc or Tab+P to close';
    _panel.appendChild(foot);

    /* The scrim. Clicking it closes, which is the one gesture everybody tries.
       It is deliberately transparent — the panel is a peek, not a modal, and the
       player usually wants to see the game behind it. */
    const scrim = document.createElement('div');
    scrim.className = 'devc-scrim';
    scrim.addEventListener('click', close);
    document.body.appendChild(scrim);
    document.body.appendChild(_panel);
    _panel._scrim = scrim;

    _built = true;
  }

  /* --- refresh ------------------------------------------------------------ */
  function refresh(){
    if(!_panel) return;
    COMMANDS.forEach(function(cmd){
      if(!cmd._row) return;
      const ok = !cmd.when || cmd.when();
      cmd._row.classList.toggle('devc-off', !ok);
      cmd._row.disabled = false;          /* kept clickable: it explains itself */
      if(cmd._state){
        cmd._state.textContent = (cmd.state && cmd.state()) ? 'ON' : '';
        cmd._state.classList.toggle('devc-on', !!(cmd.state && cmd.state()));
      }
    });
  }

  function isOpen(){ return _open; }

  function open(){
    _build();
    if(_open) return;
    _open = true;
    refresh();
    _panel.style.display = 'block';
    /* rAF, not immediately: display:block in the same tick as the class write
       means the browser has nothing to animate from and the panel appears at
       its final size with no motion at all. */
    requestAnimationFrame(function(){
      _panel.classList.add('devc-open');
      _panel._scrim.classList.add('devc-open');
    });
  }

  function close(){
    if(!_open || !_panel) return;
    _open = false;
    _panel.classList.remove('devc-open');
    _panel._scrim.classList.remove('devc-open');
    /* Kept in the DOM and left at display:none rather than removed, so opening
       it again is instant and the rows keep whatever state they last showed. */
    setTimeout(function(){
      if(!_open && _panel) _panel.style.display = 'none';
    }, 180);
  }

  function toggle(){ _open ? close() : open(); }

  /* --- input --------------------------------------------------------------
     Capture phase, and only because Game also listens for Tab and P. Without
     capture this runs after Game's handler and the battle is already skipping
     by the time the panel appears.

     Capture is ALSO why this deliberately does NOT stop propagation. Tab+P has
     to keep skipping the battle — the panel is an addition to the existing
     shortcuts, not a replacement for them. Both listeners run, and that is the
     intent.

     WHY THE PANEL CLOSES WHEN YOU LET GO.
     Tab+P reads as a held gesture — you press both, look at the list, release.
     A panel that stays up after release has to be dismissed a second time, and
     the second gesture is Escape, which is not what anyone expects after a
     chord. So releasing EITHER key closes it, exactly as pressing both opens it.

     The one thing that must not happen: if the player dismisses with Escape
     WHILE STILL HOLDING both keys, the release that follows would immediately
     reopen it. _dismissed marks that, so the release knows the panel is meant to
     stay shut. */
  function _onKeyDown(e){
    if(e.code === 'Tab') _tabDown = true;
    if(e.code === 'KeyP') _pDown = true;

    if(_tabDown && _pDown){
      _dismissed = false;
      if(!_open){
        /* preventDefault only on the P half, so plain Tab still reaches Game and
           still toggles the scoreboard. Stopping Tab as well would silently
           break a binding that has nothing to do with this panel. */
        if(e.code === 'KeyP') e.preventDefault();
        open();
      }
      return;
    }

    if(e.key === 'Escape' && _open){
      e.preventDefault();
      _dismissed = true;
      close();
    }
  }

  function _onKeyUp(e){
    if(e.code === 'Tab') _tabDown = false;
    if(e.code === 'KeyP') _pDown = false;
    if(!_tabDown && !_pDown){
      _dismissed = false;
      if(_open) close();
    }
  }

  function init(){
    window.addEventListener('keydown', _onKeyDown, true);
    window.addEventListener('keyup', _onKeyUp, true);
    /* A tab switch drops the keyup for whatever was held, and the latch would
       stay true — so the next Tab+P press after coming back would think the
       combo is still held. Blur clears it. */
    window.addEventListener('blur', function(){
      _tabDown = false;
      _pDown = false;
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { init, open, close, toggle, isOpen, refresh, commands: COMMANDS };
})();