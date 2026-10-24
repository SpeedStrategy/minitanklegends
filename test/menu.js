/* ============================================================
   menu.js — All UI: main menu, multiplayer, host/join, hidden
   code (copy + 5s toast), collections, settings (rebindable keys
   + aim-line opacity/color + view-range width), map editor
   launcher, ESC menu, background images, host map selection.
   ============================================================ */

/* ============================================================
   BOX_DROP_TABLE — SINGLE SOURCE OF TRUTH for crate drops.
   _openBox() rolls against this table AND the info panel
   (ⓘ button) renders from it, so displayed chances never lie.
   weight = relative odds (summed automatically), amounts = the
   exact pools the roll picks from.
   ============================================================ */
const BOX_DROP_TABLE = [
  { name:'Coins', icon:'assets/currency/coin.png', key:'coins', weight:60, amounts:[200,350,500,750,1000] },
  { name:'Cash',  icon:'assets/currency/cash.png', key:'cash',  weight:30, amounts:[50,100,150,200,300] },
  { name:'Gold',  icon:'assets/currency/gold.png', key:'gold',  weight:10, amounts:[500,750,1000,1500,2000,3000] },
];
const BOX_DROP_TOTAL_WEIGHT = BOX_DROP_TABLE.reduce(function(s, e){ return s + e.weight; }, 0);

/* How long the queue waits for another player before filling the rest with bots.

   WAS `const SEARCH_SECONDS = 5`, with a comment claiming it "must match
   QueueWait on the server". It did not: the server waits 15 seconds. So the
   button sat on "SEARCHING 5s+" for ten seconds while the player was still being
   matched — a timer that is both wrong and, being a local constant, wrong in a
   way nothing could report.

   The number now comes from the server, in the `queued` reply
   (`botFillDelayMs`), and is read via TDMMatchmaker.queueDelayMs. Nothing here
   needs to be kept in step with the server any more, which is the entire point:
   a constant that must match a remote value is a constant that will not. */

/* TDMMatchmaker is a top-level `const` in matchmaking.js. A top-level const is
   NOT a property of window, so `window.TDMMatchmaker` is ALWAYS undefined and
   any guard written against it silently disables the queue for every mode.
   That is exactly why "multiplayer was not working": the existence check
   failed, the code fell through to the local no-queue path, and two players
   pressing PLAY each got their own private match. Probe the bare identifier. */
/* "Multiplayer is available" no longer means "a URL is configured".

   It used to check CONFIG.MATCHMAKING_URL, which is just location.origin --
   true on every page that is served over http, whether or not anything is
   listening behind it. So the two multiplayer modes always looked ready, went
   through the queue, and then failed at the first request. The real question is
   whether the transport can reach a match server, and the only honest answer is
   to have tried: Net.connect() resolves on success and rejects on failure. */
function tdmReady(){
  return (typeof TDMMatchmaker !== 'undefined' && !!TDMMatchmaker)
      && (typeof Net !== 'undefined' && !!Net && typeof Net.joinQueue === 'function');
}

/* Has a match server actually answered? Resolves to a boolean rather than
   throwing, and is safe to call before anything has connected. Used to decide
   whether to bother queueing at all: if there is no server, queueing can only
   fail slowly, and a clear "offline" beats a 15 second search that goes
   nowhere. */
const _tdmServerProbe = (function(){
  let p = null;
  return function(){
    if(typeof Net === 'undefined' || typeof Net.connect !== 'function') return Promise.resolve(false);
    if(p) return p;
    p = Net.connect().catch(() => false);
    /* Do not cache a failure forever: the player may start the server, or the
       tunnel may come back, without reloading the page. */
    p = p.then(ok => { if(!ok) p = null; return ok; });
    return p;
  };
})();

/* Escape for an HTML attribute value AND for text content. The trophy names go
   into a title="" as well as into the cell body, and a name containing a quote
   would otherwise break out of the attribute and take the rest of the markup
   with it. Trophy names are authored in config.js today and contain neither
   character, which is exactly why this has to be here before the first one does. */
function escAttr(v){
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const Menu = {
  settings: loadSettings(),
  hostCfg: { maxPlayers:8, isPublic:true, fakePlayers:4, code:'------', useCustomMap:false, gamemode:'deathmatch' },
  escOpen: false,


  init(game){
    this.game = game;
    console.log('[MENU] init() starting, game:', !!game);
    document.body.classList.add(this._detectPlatform() === 'desktop' ? 'is-desktop' : 'is-mobile');
    try { Audio.init(); } catch(e){ console.warn('Audio.init failed:', e); }
    try { Audio.hookButtons(); } catch(e){ console.warn('Audio.hookButtons failed:', e); }
    try { SHOP_DATA.init(); } catch(e){ console.warn('SHOP_DATA.init failed:', e); }
    try { this._preloadCrateVideo(); } catch(e){ console.warn('preloadCrateVideo failed:', e); }
    try { this._checkWeeklyReset(); } catch(e){ console.warn('checkWeeklyReset failed:', e); }
    try { this._checkDailyClanXP(); } catch(e){ console.warn('checkDailyClanXP failed:', e); }
    try { this._wireButtons(); } catch(e){ console.error('Menu._wireButtons failed:', e); }
    try { this._renderBinds(); } catch(e){}
    try { this._renderAimSettings(); } catch(e){}
    try { this._renderViewSettings(); } catch(e){}
    try { this._renderXraySettings(); } catch(e){}
    try { this._renderCamSettings(); } catch(e){}
    try { this._renderCameraSettings(); } catch(e){}
    try { this._renderGraphicsSettings(); } catch(e){}
    try { this._renderOtherSettings(); } catch(e){}
    try { this._loadCollectionsFromStorage(); } catch(e){}
    try { this._renderCollections(); } catch(e){}
    try { this._wireSettingsTabs(); } catch(e){}
    try { this._initRangeStyling(); } catch(e){}
    try { this._renderProfile(); } catch(e){}
    try { this._applyBackgrounds(); } catch(e){}
    try { this._wireEsc(); } catch(e){}
    try { this._wirePeerPresence(); } catch(e){}
    try { this._wireMinimapKey(); } catch(e){}
    try { this._updateMapHint(); } catch(e){}
    try { this._wireCodes(); } catch(e){}
    try { this._wireNightMode(); } catch(e){}
    try { this._initFullscreen(); } catch(e){ console.error('Menu._initFullscreen failed:', e); }
    try { this._initScaling(); } catch(e){ console.error('Menu._initScaling failed:', e); }
    try { this._loadClanData(); } catch(e){}
    // Tab: instantly return to the main menu from any screen (ignored during a match)
    window.addEventListener('keydown', (e) => {
      if(e.key === 'Tab'){
        e.preventDefault();
        if(this.game && this.game.running) return;
        this.show('menu-main');
      }
    });
    try { this.show('menu-main'); } catch(e){ console.error('Menu.show(menu-main) failed:', e); }
    console.log('[MENU] init() complete');
    // Auto-join from URL param ?room=CODE
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    if(roomCode && roomCode.length >= 4 && this.game){
      setTimeout(() => this.game.startClient(roomCode.toUpperCase()), 500);
    }
  },

  /* ============================================================
     Fullscreen / Orientation system
     ============================================================ */

  /* --- Platform detection --- */
  _detectPlatform(){
    const ua = navigator.userAgent;
    // iPadOS 13+ reports as Mac but has touch support
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(ua) && 'ontouchstart' in window && navigator.maxTouchPoints > 0);
    const isAndroid = /Android/i.test(ua);
    if(isIOS) return 'ios';
    if(isAndroid) return 'android';
    return 'desktop';
  },

  /* ============================================================================
     FULLSCREEN DETECTION — WHY THIS NEEDS HELP

     `_isFullscreen` used to read only the element-fullscreen properties, which
     is correct and useless at the same time. Those properties describe ONE
     thing: the Fullscreen API, where a specific element is expanded over the
     page.

     F11 is not that. F11 is the BROWSER hiding its own chrome, and no API
     reports it, on any browser. So:

       * the player presses F11 — the exact thing the prompt tells them to do
       * no fullscreenchange event fires
       * a resize fires, because the viewport really did change
       * _isFullscreen() says false, correctly, about a thing nobody can observe
       * the prompt is raised again

     In Chrome that resolves itself by accident, because pressing F11 while the
     element-fullscreen request from the button is still settling sometimes
     fires fullscreenchange. In Firefox it does not, at all: F11 is invisible,
     resize keeps firing, and the prompt keeps coming back. The player is stuck
     in a loop with a "press F11" hint that provokes the loop.

     So F11 is tracked explicitly. The keydown is the reliable signal; the
     viewport check catches the player who leaves fullscreen with Esc or with
     the browser's own menu instead of pressing F11 again. Both are needed —
     either one alone leaves a hole.
     ============================================================================ */
  _fsIsElementFullscreen(){
    return !!(document.fullscreenElement || document.webkitFullscreenElement ||
              document.mozFullScreenElement || document.msFullscreenElement);
  },

  /* True when the viewport has taken the whole screen. Chrome, Firefox and
     Edge all report innerHeight ~= screen.height in browser fullscreen, and all
     of them keep the gap between the window and the viewport small. The
     tolerance is loose on purpose: this only ever runs on a resize, and a
     false positive just means we do not nag someone who is already wide. */
  _fsLooksFullscreen(){
    try {
      const gapY = Math.abs((window.screen.height - window.innerHeight));
      const gapX = Math.abs((window.screen.width - window.innerWidth));
      return window.innerHeight >= window.screen.height - 24 &&
             gapY <= 160 && gapX <= 160;
    } catch(e){ return false; }
  },

  _isFullscreen(){
    return this._fsIsElementFullscreen() || this._fsF11 === true || this._fsLooksFullscreen();
  },

  /* ============================================================================
     REQUEST FULLSCREEN — AND ACTUALLY REPORT FAILURE

     This used to be:

         el.requestFullscreen().catch(() => {});

     The `.catch(() => {})` is the bug. A rejected request is the NORMAL
     outcome on a fair number of setups — Firefox refuses when the document is
     not focused, when the gesture was consumed, or when the origin has no
     fullscreen permission — and swallowing it meant the button hid the overlay
     regardless, so the player was told nothing, left in a window, and then had
     the prompt raised at them again a second later. It looked like the button
     did nothing at all.

     Now it returns a promise. The caller decides what to do about a failure,
     and the default is to say so and keep the prompt up rather than silently
     pretend.
     ============================================================================ */
  _requestFullscreen(){
    const el = document.documentElement;
    const attempts = [
      el.requestFullscreen,
      el.webkitRequestFullscreen,
      el.mozRequestFullScreen,
      el.msRequestFullscreen,
    ].filter(f => typeof f === 'function');

    /* No API at all — which is every iPhone and iPad in Safari. Saying so is
       the whole point; the previous version called nothing and reported
       success. */
    if(!attempts.length) return Promise.reject(new Error('no-fullscreen-api'));

    let lastErr = null;
    /* Sequential rather than parallel: the prefixed names are the same
       function on modern browsers, so trying them at once fires several
       requests and Firefox rejects all but the first. */
    return attempts.reduce((chain, fn) => chain.catch(() => {
      try { return Promise.resolve(fn.call(el)); }
      catch(e){ lastErr = e; throw e; }
    }), Promise.reject(lastErr || new Error('no-attempt')))
      .then(() => { this._fsF11 = true; return true; })
      .catch((err) => {
        /* A rejected element request still leaves F11 available, so the honest
           message points at F11 rather than leaving the player stuck. */
        throw err;
      });
  },

  /* Shown when a fullscreen request fails. Kept in one place so the wording is
     the same wherever it is triggered. */
  /* Shown when a fullscreen request fails, or CLEARED when it succeeds.
     `reason` of null means "nothing is wrong, take the message away" — which is
     why it is handled first and explicitly. It used to fall through to the
     refusal branch, so every DISMISS of the prompt printed "your browser
     refused the fullscreen request" on the card the player had just closed,
     which is both untrue and the last thing they read before playing. */
  _fullscreenFailed(reason){
    const el = document.getElementById('fs-status');
    if(!el) return;
    if(reason == null){
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    const noApi = (reason === 'no-fullscreen-api');
    el.textContent = noApi
      ? 'This browser cannot go fullscreen on this device — Safari on iPhone and iPad does not support it. "Add to Home Screen" is the way to play fullscreen there.'
      : 'Your browser refused the fullscreen request. Press F11 instead — it works even where the button does not.';
    el.classList.remove('hidden');
    if(this.toast) this.toast(noApi ? 'Fullscreen unavailable on this device' : 'Fullscreen blocked — press F11');
  },
  _fullscreenOk(){ this._fullscreenFailed(null); },

  /* --- Show only one section inside the overlay --- */
  _showSection(id){
    document.querySelectorAll('.fs-section').forEach(s => s.classList.add('hidden'));
    const el = document.getElementById(id);
    if(el) el.classList.remove('hidden');
  },

  /* --- Orientation polling --- */
  _startOrientationPoll(callback, interval){
    this._stopOrientationPoll();
    this._orientTimer = setInterval(() => {
      const result = callback();
      if(result === 'stop'){
        this._stopOrientationPoll();
      }
    }, interval || 200);
  },

  _stopOrientationPoll(){
    if(this._orientTimer){
      clearInterval(this._orientTimer);
      this._orientTimer = null;
    }
  },

  /* --- UI scaling --- */
  _initScaling(){
    const update = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Always treat viewport as landscape: longer side = width, shorter = height
      const vpW = Math.max(w, h);
      const vpH = Math.min(w, h);
      const scale = Math.min(vpW / 896, vpH / 414, 1.5); // cap at 1.5x
      document.documentElement.style.setProperty('--ui-scale', scale);
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', () => setTimeout(update, 200));
  },

/* --- Init: entry point --- */
  _initFullscreen(){
    this._fsDismissed = false;
    this._fsF11 = false;
    const overlay = document.getElementById('menu-fullscreen-prompt');
    if(!overlay){
      /* No overlay in the document at all. Point the refresh hook at a no-op
         rather than leaving the placeholder that HIDES the overlay — the boot
         watchdog looks for a function here and would report a working feature
         for one that was never on the page. */
      this._refreshFullscreenState = function(){};
      return;
    }
    this._fullscreenOverlay = overlay;

    /* ONE definition of "dismissed".
       The old code repeated the same four lines in six places, and they were
       not the same four lines: the close button and the inline HTML handlers
       did not set _fsDismissed the way the menu.js buttons did. So the prompt
       could be closed and then come straight back on the next resize, which is
       the "I dismissed it and it came back" behaviour. Everything funnels
       through here now. */
    const dismiss = (remember) => {
      overlay.classList.add('hidden');
      if(remember !== false) this._fsDismissed = true;
      try { this._fullscreenFailed(null); } catch(e){}
      try { this._checkRenderingTips(); } catch(e){}
    };

    /* --- BUTTONS FIRST, BEFORE ANY DETECTION. ---
       _initFullscreen is called inside a try/catch at init, so anything that
       throws further down used to leave every button on the card dead while
       the card stayed on screen — a modal with nothing working on it. The
       buttons must not depend on a heuristic initialising successfully. */
    const enterBtn = document.getElementById('btn-enter-fullscreen');
    if(enterBtn) enterBtn.onclick = (e) => {
      if(e && e.stopPropagation) e.stopPropagation();
      try { this._fullscreenOk(); } catch(err){}
      /* The prompt stays up until the request actually SUCCEEDS. Hiding it
         first and hoping is precisely what made a rejected request look like
         a working button that had entered fullscreen. */
      this._requestFullscreen().then(() => {
        dismiss();
      }).catch((err) => {
        try { this._fullscreenFailed(err && err.message); } catch(e2){}
        /* Prompt stays. F11 is offered in the message and is bound below, so
           there is always a way forward. */
      });
    };

    const wireDismiss = (id) => {
      const b = document.getElementById(id);
      if(b) b.onclick = (e) => { if(e && e.stopPropagation) e.stopPropagation(); dismiss(); };
    };
    wireDismiss('btn-dismiss-fullscreen');
    wireDismiss('btn-fs-close');
    wireDismiss('btn-ios-rotate-dismiss');
    wireDismiss('btn-android-rotate-dismiss');
    wireDismiss('btn-ios-dismiss');
    /* This button was in the markup with NO handler anywhere in the codebase,
       so on the Android fullscreen card the only working control was the one
       that could fail. */
    wireDismiss('btn-android-play');

    const androidFsBtn = document.getElementById('btn-android-fullscreen');
    if(androidFsBtn) androidFsBtn.onclick = (e) => {
      if(e && e.stopPropagation) e.stopPropagation();
      try { this._fullscreenOk(); } catch(err){}
      this._requestFullscreen().then(() => dismiss()).catch((err) => {
        try { this._fullscreenFailed(err && err.message); } catch(e2){}
      });
    };

    /* --- F11 AND ESCAPE ---
       Escape was named in a comment here ("Close button & Escape key") and had
       never actually been bound. */
    document.addEventListener('keydown', (e) => {
      const isF11 = (e.key === 'F11' || e.key === 'f11' || e.keyCode === 122);
      if(isF11){
        /* NO preventDefault. It does not reliably cancel the browser's own
           fullscreen toggle and in some builds it stops it outright — so the
           player pressed the key the card tells them to press and nothing
           happened, which is the most confusing version of this bug there is.
           All we need is to KNOW they pressed it. */
        if(!this._fsIsElementFullscreen()) this._fsF11 = true;
        /* Pressing F11 IS choosing fullscreen, so the prompt has done its job.
           Hiding it here is what breaks the loop: no prompt means no resize
           handler fighting the player. */
        if(!overlay.classList.contains('hidden')) dismiss();
        /* If the browser is still windowed a moment later the key was swallowed
           — some Linux window managers and kiosk shells do that. Say so and
           bring the prompt back rather than leaving it hidden and unexplained. */
        setTimeout(() => {
          if(!this._isFullscreen()){
            try { this._fullscreenFailed(null); } catch(e){}
            if(overlay.classList.contains('hidden')){
              this._showSection('fs-desktop');
              overlay.classList.remove('hidden');
            }
          }
        }, 450);
        return;
      }
      if(e.key === 'Escape' && !overlay.classList.contains('hidden')){
        /* An explicit, discoverable way out. This is not a bypass — the card
           offers declining in three other ways; Escape is the fourth. */
        dismiss();
      }
    });

    /* --- DETECTION, once the buttons are safe --- */
    const update = (forceShow) => {
      if(this._fsDismissed){ overlay.classList.add('hidden'); return; }
      if(!forceShow && this._fsPromptShownOnce) return;
      if(this._isFullscreen()){ overlay.classList.add('hidden'); return; }

      const isLandscape = window.innerWidth > window.innerHeight;
      const plat = this._detectPlatform();
      const isMobile = plat === 'ios' || plat === 'ios-standalone' || plat === 'android';
      const root = document.documentElement;
      const canFS = typeof root.requestFullscreen === 'function' ||
                    typeof root.webkitRequestFullscreen === 'function';

      this._fsPromptShownOnce = true;

      if(isMobile){
        if(isLandscape){
          /* Landscape. Only nag about fullscreen where it is actually
             possible. iOS cannot do element fullscreen at all, so offering the
             button there is worse than not offering it. Android gets its own
             card — which was UNREACHABLE before, because nothing anywhere ever
             called _showSection('fs-android-buttons'). */
          if(plat === 'android' && !this._fsIsElementFullscreen() && canFS){
            this._showSection('fs-android-buttons');
            overlay.classList.remove('hidden');
            return;
          }
          overlay.classList.add('hidden');
          return;
        }
        this._showSection(plat === 'android' ? 'fs-android-rotate' : 'fs-ios-rotate');
        overlay.classList.remove('hidden');
        return;
      }

      if(!canFS){
        /* A desktop browser with no fullscreen API. Do not show a card whose
           main button cannot work — say why and move on. */
        this._fullscreenFailed('no-fullscreen-api');
        overlay.classList.add('hidden');
        return;
      }
      this._showSection('fs-desktop');
      overlay.classList.remove('hidden');
    };

    this._refreshFullscreenState = update;

    /* Re-evaluate the F11 flag on every resize. This is what catches LEAVING
       fullscreen with Esc or the browser's own menu — transitions no keydown
       we can observe will ever report, and the reason the old loop felt random:
       it depended entirely on whether the player happened to press F11 again. */
    const onResize = () => {
      if(this._fsIsElementFullscreen()){
        this._fsF11 = false;                 /* element fullscreen is authoritative */
        overlay.classList.add('hidden');
        return;
      }
      if(this._fsLooksFullscreen()){
        this._fsF11 = true;
        overlay.classList.add('hidden');
        return;
      }
      if(this._fsF11) this._fsF11 = false;   /* left fullscreen by Esc */
      if(this._fsDismissed) return;
      if(this.game && this.game.running) return;   /* never interrupt a match */
      update(true);
    };
    window.addEventListener('resize', onResize);

    const fsChange = () => {
      if(this._isFullscreen()){ overlay.classList.add('hidden'); return; }
      if(this._fsDismissed) return;
      if(this.game && this.game.running) return;
      update(true);
    };
    document.addEventListener('fullscreenchange', fsChange);
    document.addEventListener('webkitfullscreenchange', fsChange);
    document.addEventListener('mozfullscreenchange', fsChange);
    document.addEventListener('MSFullscreenChange', fsChange);

    /* Clicking the dimmed area outside the card closes it. Previously the
       backdrop swallowed the click and did nothing, so a prompt that appeared
       over a menu the player was using looked stuck and uninteractive. */
    overlay.addEventListener('click', (e) => {
      if(e.target === overlay) dismiss();
    });

    /* Initial check. */
    update(true);
    try { this._checkRenderingTips(); } catch(e){}
  },

  /* --- Rendering tips (mobile, after fullscreen/orientation prompt) --- */
  _checkRenderingTips: function(){
    var rt = document.getElementById('rendering-tips');
    if(!rt || rt.classList.contains('hidden') === false) return;
    var plat = this._detectPlatform();
    var isMobile = plat === 'ios' || plat === 'ios-standalone' || plat === 'android';
    if(!isMobile) return;
    if(localStorage.getItem('tankparty_rt_dismissed')) return;
    // Don't show if fullscreen overlay is still visible
    if(this._fullscreenOverlay && !this._fullscreenOverlay.classList.contains('hidden')) return;

    rt.classList.remove('hidden');
    document.getElementById('rt-check-row').onclick = function(){
      document.getElementById('rt-checkbox').classList.toggle('checked');
    };
    document.getElementById('rt-understood').onclick = function(){
      if(document.getElementById('rt-checkbox').classList.contains('checked')){
        localStorage.setItem('tankparty_rt_dismissed', '1');
      }
      document.getElementById('rendering-tips').classList.add('hidden');
    };
  },

  /* Re-check when returning to a menu or during gameplay */
  _refreshFullscreenState(){}, // placeholder, overridden in _initFullscreen

  _loadMysteryImg(){
    const img = new Image();
    img.src = 'mystery_mtl.png';
    this._mysteryImg = img;
  },

  _wireNightMode(){
    const btn = document.getElementById('night-mode-btn');
    if(!btn) return;
    const isNight = localStorage.getItem('nightMode') === '1';
    const isStrong = localStorage.getItem('nightModeStrong') === '1';
    btn.classList.toggle('night', isNight);
    document.body.classList.toggle('night', isNight);
    if(isNight && isStrong) document.body.classList.add('strong');
    btn.onclick = () => {
      Audio.click();
      const nowNight = btn.classList.toggle('night');
      localStorage.setItem('nightMode', nowNight ? '1' : '0');
      document.body.classList.toggle('night', nowNight);
      if(!nowNight) document.body.classList.remove('strong');
    };
  },

  hideTouchControls(){
    document.querySelectorAll('.joystick-container, #cam-rotate-btns').forEach(el =>
      el.classList.add('joystick-hidden')
    );
  },

  _cinematicTransition(callback){
    const overlay = document.getElementById('menu-transition-overlay');
    if(!overlay){ callback(); return; }
    overlay.classList.remove('cinematic-fade-out', 'flash', 'cinematic-fade-in');
    overlay.style.display = 'block';
    void overlay.offsetWidth;
    overlay.classList.add('cinematic-fade-in');
    setTimeout(() => {
      if(callback) callback();
      overlay.classList.remove('cinematic-fade-in');
      void overlay.offsetWidth;
      overlay.classList.add('cinematic-fade-out');
      setTimeout(() => {
        overlay.classList.remove('cinematic-fade-out');
        overlay.style.display = 'none';
      }, 600);
    }, 450);
  },

  show(id, opts={}){
    // Release pointer lock so cursor is visible in menus
    if(document.pointerLockElement) document.exitPointerLock();

    // Touch controls are gameplay-only: any menu hides them (covers every
    // exit path, even ones that skip leaveToMenu).
    this.hideTouchControls();
    // Full-screen overlays replace the menu background, so the main preview
    // (garage) is stopped there; card menus (codes, settings, …) sit on top
    // of the menu layer and keep the garage running behind them.
    if(['menu-collections','menu-store','menu-shop-buy','menu-shop-receive',
        'menu-platoon','menu-preview','menu-clan-ui','menu-missions',
        'menu-sandbox'].indexOf(id) >= 0 ||
       id === 'menu-custom-full'){
      this._stopMainPreview();
    }
    /* Opening the Sandbox panel wires its buttons exactly once (the module
       guards on its own `built` flag) and refreshes the room if one is already
       running, so coming back from a battle shows the state you left. */
    if(id === 'menu-sandbox' && window.SandboxRoom){
      try{ SandboxRoom.init(); SandboxRoom.refresh(); }catch(e){ console.warn('Sandbox panel:', e); }
    }
    // Unmount MissionsBG particle animation when leaving missions menu
    if(id !== 'menu-missions' && window.MissionsBG) window.MissionsBG.unmount();
    const _switch = () => {
      document.querySelectorAll('.menu').forEach(m=> m.classList.add('hidden'));
      if(this._collectionsKeyHandler){
        window.removeEventListener('keydown', this._collectionsKeyHandler);
        this._collectionsKeyHandler = null;
      }
      document.getElementById(id).classList.remove('hidden');
      if(!opts.skipReveal) document.getElementById(id).classList.add('cinematic-menu');
      document.getElementById('hud').classList.add('hidden');
      document.getElementById('ui-layer').classList.remove('game-active');
    };
    const hud = document.getElementById('hud');
    const fromGameplay = opts.cinematic !== false && hud && !hud.classList.contains('hidden');
    if(fromGameplay && !this._transitionBusy){
      this._transitionBusy = true;
      this._cinematicTransition(() => {
        _switch();
        this._postMenuShow(id);
      });
    } else {
      _switch();
      this._postMenuShow(id);
    }
  },

  _postMenuShow(id){
    /* Tell the watchdog what is happening BEFORE doing any of it. If the main
       thread wedges inside this function, the report on the next load names
       this exact menu instead of just "the game froze". Cheap, synchronous, and
       the only thing that can attribute a main-thread hang. */
    try { if(window.__mtlMark) window.__mtlMark('menu:open:' + id); } catch(e){}
    if(id !== 'menu-store' && id !== 'menu-shop-buy' && id !== 'menu-shop-receive'){
      if(this._shopTimer){ clearInterval(this._shopTimer); this._shopTimer = null; }
      /* Same reason as Escape: any hold or reveal still running belongs to a
         screen we have just left. */
      this._cancelShopHold(true);
      this._clearShopReceiveTimers();
    }
    // Re-evaluate fullscreen overlay when returning to any menu
    if(this._refreshFullscreenState) this._refreshFullscreenState();
    if(id === 'menu-main'){
      try { if(window.__mtlMark) window.__mtlMark('menu:main:preview'); } catch(e){}
      Audio.playMusic('assets/menu.mp3');
      if(!this._customMenuActive()){
        if(!(window.Garage && Garage.active)) this._startMainPreview();
      }
      if(this._customMenuActive()) this._renderCustomMainMenu();
      else this._restoreDefaultMainMenu();
      this._renderProfile();
    }
    if(id === 'menu-clans'){
      // When already in a clan, only allow searching for other clans (create is hidden)
      const createBtn = document.getElementById('btn-create-clan-menu');
      if(createBtn) createBtn.style.display = this._clanData ? 'none' : '';
      const hint = document.getElementById('clan-current-hint');
      if(hint){
        if(this._clanData){
          hint.style.display = '';
          hint.innerHTML = 'You are in clan: <b>' + this._clanData.name + '</b>';
        } else {
          hint.style.display = 'none';
        }
      }
    }
    if(id === 'menu-store'){
      Audio.playMusic('assets/shop/shop.mp3');
      this._renderShop();
    }
    if(id === 'menu-collections'){
      setTimeout(() => {
        this._renderCollections();
      }, 50);
    }
    if(id === 'menu-storage'){
      this._initStorageGrid();
      this._updateCurrencies();
    }
    if(id === 'menu-codes'){
      const revertBtn = document.getElementById('btn-revert-map');
      if(revertBtn) this._refreshRevertBtn(revertBtn);
    }
    if(id === 'menu-missions'){
      if(window.Missions) Missions.render('daily');
    }
    if(id !== 'menu-tank'){
      if(window.TankMenu) TankMenu.destroy();
    }
    this._transitionBusy = false;
  },
  _customMenuActive(){ return localStorage.getItem('tankparty_custommainmenu') === '1'; },

  _renderCustomMainMenu(){
    const useCustom = localStorage.getItem('tankparty_custommainmenu') === '1';
    if(!useCustom) return;
    let data;
    try{ data = JSON.parse(localStorage.getItem('tankparty_menueditor')); }catch(e){}
    if(!data || !data.length){
      localStorage.removeItem('tankparty_custommainmenu');
      return;
    }
    // Hide sidebar, crates, and play button, show custom card
    const side = document.getElementById('main-menu-side');
    if(side) side.style.display = 'none';
    const crates = document.getElementById('main-menu-crates');
    if(crates) crates.style.display = 'none';
    const play = document.getElementById('btn-play');
    if(play) play.style.display = 'none';
    const card = document.getElementById('menu-custom-card');
    if(!card) return;
    card.classList.remove('hidden');
    card.innerHTML = '';
    card.style.cssText = 'width:100%;max-width:100%;height:100%;border:none;background:transparent;backdrop-filter:none;box-shadow:none;padding:0;position:relative;overflow:hidden';
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;inset:0;overflow:hidden';
    data.forEach(d=>{
      if(d.type === 'image' && d.imageData){
        const img = document.createElement('img');
        img.src = d.imageData;
        img.style.cssText = `position:absolute;left:${d.x}px;top:${d.y}px;width:${d.w}px;height:${d.h}px;pointer-events:none`;
        container.appendChild(img);
      } else if(d.type === 'button'){
        const btn = document.createElement('div');
        btn.textContent = d.label || 'Button';
        const hx = d.hitbox?.x != null ? d.hitbox.x : 0;
        const hy = d.hitbox?.y != null ? d.hitbox.y : 0;
        const hw = d.hitbox?.w || d.w;
        const hh = d.hitbox?.h || d.h;
        btn.style.cssText = `position:absolute;left:${d.x+hx}px;top:${d.y+hy}px;width:${hw}px;height:${hh}px;margin:0;background:${d.bgColor||'#383838'};color:#fff;display:flex;align-items:center;justify-content:center;border-radius:12px;cursor:pointer;font-weight:600;font-size:15px;letter-spacing:.5px;transition:.15s`;
        btn.onmouseover = ()=> btn.style.background = '#444';
        btn.onmouseout = ()=> btn.style.background = d.bgColor || '#383838';
        if(d.command && d.command !== 'none'){
          btn.onclick = ()=>{
            if(d.command === 'back'){
              localStorage.removeItem('tankparty_custommainmenu');
              Menu.show('menu-main');
              return;
            }
            if(d.command === 'singleplayer' && Menu.game){ Menu.game.startSingleplayer(); return; }
            if(d.command === 'preview'){ Menu.show('menu-preview'); return; }
            const el = document.querySelector(`[data-open="${d.command}"]`);
            if(el) el.click();
          };
        }
        container.appendChild(btn);
      }
    });
    const resetBtn = document.createElement('div');
    resetBtn.textContent = '← Default Menu';
    resetBtn.style.cssText = 'position:absolute;bottom:10px;left:50%;transform:translateX(-50%);color:var(--muted);font-size:12px;cursor:pointer;padding:8px 16px';
    resetBtn.onclick = ()=>{
      localStorage.removeItem('tankparty_custommainmenu');
      this.show('menu-main');
    };
    container.appendChild(resetBtn);
    card.appendChild(container);
  },

  _restoreDefaultMainMenu(){
    const side = document.getElementById('main-menu-side');
    if(side) side.style.display = '';
    const crates = document.getElementById('main-menu-crates');
    if(crates) crates.style.display = '';
    const play = document.getElementById('btn-play');
    if(play) play.style.display = '';
    const card = document.getElementById('menu-custom-card');
    if(card) card.classList.add('hidden');
  },
  refreshProfile(){
    this._renderProfile();
  },
  /* THE AVATAR, IN BOTH SLOTS IT APPEARS IN.

     There are two of them: the badge on the main menu and the 64px box on the
     profile card. They each used to pick "the first trophy you happen to own" on
     their own, so the two could show different pictures and neither of them
     could show a CHOICE — equipping one was impossible because nothing recorded
     the choice. Both now read the equipped id through the same two helpers in
     config.js, and both are written from here, so a click in the trophy menu
     repaints them together. */
  _paintAvatar(){
    const face = (typeof getEquippedTrophy === 'function') ? getEquippedTrophy() : null;
    const owned = (typeof ownedTrophyIds === 'function') ? ownedTrophyIds() : (this.settings.trophyOwnedIds || []);
    const html = face
      ? '<img src="' + face.icon + '" alt="" draggable="false">'
      : '<span class="profile-avatar-empty">+</span>';
    const title = face
      ? 'Avatar: ' + face.name + (owned.length ? ' — ' + owned.length + ' earned' : '')
      : 'No trophies yet — earn one to pick an avatar';
    for(const id of ['profile-strip-avatar', 'pcard-avatar']){
      const el = document.getElementById(id);
      if(!el) continue;
      el.innerHTML = html;
      /* `has-trophies` is what the stylesheet keys the greyed-out look off, so
         it has to mean "there is a real trophy to show" and not "some trophy
         exists somewhere in the catalogue". */
      el.classList.toggle('has-trophies', !!face);
      el.title = title;
    }
  },

  _renderProfile(){
    const s = this.settings;
    const nameEl = document.getElementById('profile-name');
    const clanEl = document.getElementById('profile-clan');
    const cashEl = document.getElementById('profile-cash-num');
    const goldEl = document.getElementById('profile-gold-num');
    const coinEl = document.getElementById('profile-coins-num');

    /* THE BADGE AVATAR.

       This row used to open with a hard-coded trophy emoji. It is now the real
       avatar — the trophy the player has actually equipped — so the thing on the
       main menu that says "who am I and what have I got" is telling the truth
       instead of printing a constant. With nothing owned it shows a dimmed
       empty slot rather than a trophy nobody has earned.

       It is a button because the profile screen is where the full trophy list
       lives, and this is the shortest route there from the screen the player is
       already looking at. */
    this._paintAvatar();
    const stripAvatar = document.getElementById('profile-strip-avatar');
    if(stripAvatar && !stripAvatar._wired){
      stripAvatar._wired = true;
      stripAvatar.onclick = () => { try { this.show('menu-profile'); } catch(e){} };
    }

    if(nameEl){
      nameEl.textContent = s.playerName || 'Player';
    }
    if(clanEl){
      clanEl.textContent = s.playerClan ? '[' + s.playerClan + ']' : '';
    }
    const trophyEl = document.querySelector('#profile .profile-trophy');
    const trophyCount = (s.trophyCount || 0);
    if(trophyEl) trophyEl.style.display = trophyCount > 0 ? '' : 'none';
    if(cashEl) cashEl.textContent = (s.cash||0);
    if(goldEl) goldEl.textContent = (s.gold||0);
    if(coinEl) coinEl.textContent = (s.coins||0);
    const profileEl = document.getElementById('profile');
    if(profileEl) profileEl.onclick = (e) => {
      if(e.target.closest('.profile-name')) return;
      Audio.click();
      this.show('menu-profile');
      this._renderProfileCard();
    };
  },
  bumpStat(key, n){
    try{
      const s = this.settings;
      s.stats = s.stats || {};
      if(key === 'createdAt' && !s.stats.createdAt) s.stats.createdAt = Date.now();
      else s.stats[key] = (s.stats[key] || 0) + (n || 1);
      saveSettings(s);
    }catch(e){}
  },
  _renderProfileCard(){
    const s = this.settings;
    s.stats = s.stats || {};
    if(!s.stats.createdAt) s.stats.createdAt = Date.now();
    const nameEl = document.getElementById('pcard-name-text');
    const clanEl = document.getElementById('pcard-clan');
    const accEl = document.getElementById('pcard-account');
    /* ONE NAME. NEVER TWO.

       This used to print the locally generated nickname as the heading and let
       the account line underneath print the real one, so a signed-in player saw
       a bold "Player8459" with "Account: Vostok" under it. Two names for one
       person is not a feature, and it read as a bug because it was one.

       So the heading shows whichever single name applies, and the line below is
       a status rather than a second name: "Guest" while playing without an
       account, nothing at all once there is one — because by then the heading
       is already the account name and repeating it underneath adds nothing. */
    const auth = window.Auth;
    const signedIn = !!(auth && typeof auth.loggedIn === 'function' && auth.loggedIn());
    const username = signedIn && auth.user ? (auth.user.username || '') : '';
    if(nameEl) nameEl.textContent = username || s.playerName || 'Player';
    if(clanEl) clanEl.textContent = s.playerClan ? '[' + s.playerClan + ']' : '';
    if(accEl){
      const status = signedIn ? '' : 'Guest';
      accEl.textContent = status;
      accEl.classList.toggle('hidden', !status);
    }
    const trophyEl = document.querySelector('#menu-profile .profile-trophy');
    const trophyCount = (s.trophyCount || 0);
    if(trophyEl) trophyEl.style.display = trophyCount > 0 ? '' : 'none';

    /* ONE control opens the menu, and it is the avatar.

         The second box beside it — a dashed "add trophy" slot — is gone. It
         duplicated the avatar's job, it could not add anything (trophies are
         earned in a match, not attached by hand), and it pushed the player's
         name a whole 64px to the right for nothing. It is not merely
         un-referenced here: the element is out of the markup, so nothing in
         this file looks for it any more and the two files cannot disagree about
         how many controls this row has. */
      const avatar = document.getElementById('pcard-avatar');
      const pop = document.getElementById('pcard-trophy-pop');
      if(pop){
      const roster = (typeof getTrophyCatalog === 'function') ? getTrophyCatalog() : [];
      const owned = new Set((typeof ownedTrophyIds === 'function') ? ownedTrophyIds() : (s.trophyOwnedIds || []));
      const equippedId = (typeof getEquippedTrophyId === 'function') ? getEquippedTrophyId() : null;

      /* OWNED FIRST, THEN EVERYTHING ELSE, AND NOTHING PADDED IN.

         The old build padded the grid out to a minimum of sixteen cells so it
         would not look empty. That invented trophies that do not exist: the
         catalogue is supposed to be "every trophy in the game, locked ones
         included", and padding it with blanks makes a player who owns one of
         two think there are sixteen to earn. The grid is five across and as
         tall as the list needs, with the scroll doing the rest.

         Every trophy in the catalogue is drawn whatever the player owns — the
         locked ones are what makes the list worth looking at. */
      const ownedList = roster.filter(t => owned.has(t.id));
      const lockedList = roster.filter(t => !owned.has(t.id));
      const ordered = ownedList.concat(lockedList);

      /* The avatar slot is written by _paintAvatar, which both slots share, so
         the badge on the main menu and this card cannot show two different
         pictures and equipping one updates the other. */
      this._paintAvatar();

      /* THE CELL IS THE EQUIP BUTTON.

         Owned cells are gold and clickable; locked cells are dark grey and
         shake when clicked, because a locked trophy that silently ignores the
         click reads as a broken menu rather than as a trophy you have not
         earned. The chosen one carries `.equipped` and an ON badge. */
      pop.innerHTML =
        '<div class="trophy-grid">' + ordered.map(t => {
          const isOwned = owned.has(t.id);
          const isOn = isOwned && t.id === equippedId;
          const note = isOn ? ' — equipped'
                    : isOwned ? ' — click to equip'
                    : (t.hint ? ' — ' + t.hint + ' (locked)' : ' — locked');
          return '<div class="trophy-cell' + (isOwned ? ' owned' : ' locked') + (isOn ? ' equipped' : '') + '"' +
                   ' data-trophy="' + escAttr(t.id) + '"' +
                   ' title="' + escAttr(t.name + note) + '">' +
            (isOn ? '<span class="trophy-cell-on" aria-hidden="true">ON</span>' : '') +
            '<img class="trophy-cell-icon" src="' + t.icon + '" alt="" draggable="false">' +
            '<span class="trophy-cell-name">' + escAttr(t.name) + '</span>' +
          '</div>';
        }).join('') + '</div>' +
        '<div class="trophy-pop-foot">' +
          (owned.size
            ? owned.size + ' of ' + roster.length + ' earned — click one to wear it'
            : 'None earned yet — they unlock as you play') +
        '</div>';

      const grid = pop.querySelector('.trophy-grid');
      if(grid){
        grid.onclick = (e) => {
          const cell = e.target.closest('.trophy-cell');
          if(!cell) return;
          const id = cell.getAttribute('data-trophy');
          if(!id) return;
          if(!owned.has(id)){
            Audio.click();
            cell.classList.remove('denied');
            void cell.offsetWidth;
            cell.classList.add('denied');
            return;
          }
          if(typeof setEquippedTrophy !== 'function' || !setEquippedTrophy(id)) return;
          Audio.click();
          /* Move the ring in place instead of re-running _renderProfileCard.
             Re-rendering would rebind the document-level dismiss listener below
             on every click, and the menu would start needing two clicks to
             close after a few equips. */
          pop.querySelectorAll('.trophy-cell').forEach(c => {
            const on = c.getAttribute('data-trophy') === id;
            c.classList.toggle('equipped', on);
            const badge = c.querySelector('.trophy-cell-on');
            if(on && !badge){
              const b = document.createElement('span');
              b.className = 'trophy-cell-on';
              b.setAttribute('aria-hidden', 'true');
              b.textContent = 'ON';
              c.insertBefore(b, c.firstChild);
            } else if(!on && badge){
              badge.remove();
            }
          });
          this._paintAvatar();
          if(typeof window.refreshAvatarIcons === 'function') window.refreshAvatarIcons();
        };
      }
        '</div>';

      /* THE MENU OPENS AT THE CURSOR.

         Opened from the click point rather than from the avatar's box, and
         FLIPPED when it would run off an edge. Both halves matter: anchored to
         the box it can only ever appear in one place, and near the right-hand
         edge of the window a naive left/top drops it off-screen, which is how
         "click the trophy and nothing happens" is reported. */
      const canPop = () => !document.fullscreenElement && !(this.game && this.game.running);
      const place = (cx, cy) => {
        const r = pop.getBoundingClientRect();
        const w = r.width || 300, h = r.height || 200;
        const GAP = 14;
        let x = cx + GAP, y = cy + GAP;
        if(x + w > window.innerWidth - 8) x = Math.max(8, cx - GAP - w);
        if(y + h > window.innerHeight - 8) y = Math.max(8, cy - GAP - h);
        pop.style.left = Math.round(x) + 'px';
        pop.style.top = Math.round(y) + 'px';
      };
      const open = (cx, cy) => {
        if(!canPop()) return;
        pop.classList.remove('hidden');
        /* Measured AFTER it is shown, so the flip uses its real size — a menu
           measured while display:none is 0x0 and always thinks it fits. */
        place(cx, cy);
      };
      const close = () => pop.classList.add('hidden');

      const toggleAt = (e) => {
        e.stopPropagation();
        if(pop.classList.contains('hidden')) open(e.clientX, e.clientY);
        else close();
      };
      if(avatar){ avatar.onclick = toggleAt; }

      /* Click-away and Escape both dismiss it. Left open it covers the very
         stats it is describing, and there is no other way back to the screen
         underneath. */
      this._trophyDismiss = (e) => {
        if(pop.contains(e.target) || (avatar && avatar.contains(e.target))) return;
        close();
      };
      document.addEventListener('pointerdown', this._trophyDismiss, true);
      this._trophyEscape = (e) => { if(e.key === 'Escape') close(); };
      document.addEventListener('keydown', this._trophyEscape);

      /* Close it when the screen itself goes away, or the listener outlives the
         overlay and the next profile visit stacks a second one on top. */
      const card = pop.closest('#menu-profile');
      if(card && !card._trophyHooked){
        card._trophyHooked = true;
        const obs = new MutationObserver(() => {
          if(card.classList.contains('hidden')) this._closeTrophyMenu();
        });
        obs.observe(card, { attributes: true, attributeFilter: ['class'] });
      }
    }
    if(accEl){
      const logged = typeof Auth !== 'undefined' && Auth.loggedIn ? Auth.loggedIn() : false;
      accEl.textContent = logged && Auth.user ? 'Account: ' + Auth.user.username : 'Local player';
    }
    const tanksOwned = (s.unlockedTanks || ['coolbuddy']).length;
    const totalTanks = typeof TANKS === 'object' ? Object.keys(TANKS).filter(k => k !== 'tankdisplay' && k !== 'dummy').length : 0;
    const playSec = s.stats.playSec || 0;
    const h = Math.floor(playSec / 3600), m = Math.floor((playSec % 3600) / 60), sec = playSec % 60;
    const playStr = (h ? h + 'h ' : '') + (m || h ? m + 'm ' : '') + sec + 's';
    const created = new Date(s.stats.createdAt).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
    const cash = s.cash || 0, gold = s.gold || 0, coins = s.coins || 0;
    const grid = document.getElementById('pcard-grid');
    if(grid){
      grid.innerHTML =
        this._statTile('Account created', created) +
        this._statTile('Time played', playStr) +
        this._statTile('Tanks owned', tanksOwned + ' / ' + totalTanks) +
        this._statTile('Battles', (s.stats.battles || 0) + '', '🏆') +
        this._statTile('Victories', (s.stats.wins || 0) + '', '⭐') +
        '<div class="stat-tile"><div class="stat-label">Gold</div><div class="stat-value"><img class="cur-img cur-lg" src="assets/currency/gold.png" alt="gold"> ' + gold + '</div></div>' +
        '<div class="stat-tile"><div class="stat-label">Cash</div><div class="stat-value"><img class="cur-img cur-lg" src="assets/currency/cash.png" alt="cash"> ' + cash + '</div></div>' +
        '<div class="stat-tile"><div class="stat-label">Coins</div><div class="stat-value"><img class="cur-img cur-lg" src="assets/currency/coin.png" alt="coins"> ' + coins + '</div></div>';
    }
  },
  _statTile(label, value, emoji){
    return '<div class="stat-tile"><div class="stat-label">' + (emoji ? emoji + ' ' : '') + label + '</div><div class="stat-value">' + value + '</div></div>';
  },
  showHUD(){
    if(this._shopTimer){ clearInterval(this._shopTimer); this._shopTimer = null; }
    // A match is starting: drop the menu preview (garage or legacy) so the
    // hidden canvas stops rendering behind the game.
    if(window.Garage) Garage.stop();
    this._stopMainPreview();
    document.querySelectorAll('.menu').forEach(m=> m.classList.add('hidden'));
    document.querySelectorAll('.menu').forEach(m=> m.classList.remove('cinematic-menu'));
    const overlay = document.getElementById('menu-transition-overlay');
    if(overlay){ overlay.classList.remove('cinematic-fade-in','cinematic-fade-out','flash'); overlay.style.display = 'none'; }
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('ui-layer').classList.add('game-active');
    Audio.playMusic('assets/1.mp3');
  },

  toast(msg){
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(()=> t.classList.add('hidden'), 5000);
  },

  /* ---------- background images (auto-detect; falls back to gradient) ---------- */
  _applyBackgrounds(){
    const tryImg = (url, el)=>{
      const i = new Image();
      i.onload = ()=>{ el.style.backgroundImage = `linear-gradient(rgba(10,10,10,.55),rgba(10,10,10,.75)), url(${url})`; el.style.backgroundSize='cover'; el.style.backgroundPosition='center'; };
      i.onerror = ()=>{};
      i.src = url;
    };
    tryImg('tank party.jpg', document.getElementById('menu-main'));
    tryImg('tank party.jpg', document.getElementById('menu-multiplayer'));
  },

  /* ---------- free roam ---------- */
  _startFreeRoam(){
    if(typeof NakamaNet === 'undefined'){
      this.toast('Nakama not available — use Battle Mode → Private Room');
      return;
    }
    if(!NakamaNet.socket || !NakamaNet.socket.isConnected){
      this.toast('Connecting to world server...');
      NakamaNet.connectSocket().then(() => {
        this.game.startFreeRoam();
      }).catch(e => {
        this.toast('Could not connect: ' + (e.message || 'server offline'));
      });
      return;
    }
    this.game.startFreeRoam();
  },

  /* ---------- wiring ---------- */
  _wireButtons(){
    document.querySelectorAll('[data-open]').forEach(b=>{
      b.onclick = ()=>{
        const t = b.dataset.open;
        if(t==='singleplayer'){ this.game.startSingleplayer(); return; }
        if(t==='clans'){
          // If already in a clan, go straight to the clan UI layout
          if(this._clanData){
            this.show('menu-clan-ui');
            this._renderClanUI();
            return;
          }
          this.show('menu-clans');
          return;
        }
        this.show('menu-'+t);
      };
    });
    document.querySelectorAll('[data-back]').forEach(b=>{
      b.onclick = ()=>{
        let t = b.dataset.back;
        const cur = b.closest('.menu');
        if(t === 'menu-main' && cur && cur.id === 'menu-collections' && this._platoonReturn){
          t = 'menu-platoon';
        }
        if(t === 'menu-main') this._platoonReturn = false;
        this.show(t);
      };
    });

    // platoon button
    const platoonBtn = document.getElementById('btn-platoon');
    if(platoonBtn) platoonBtn.onclick = ()=>{
      Audio.click();
      this.show('menu-platoon');
    };

    // multiplayer screen
    document.getElementById('btn-host-room').onclick = ()=>{
      this.hostCfg.code = Net.staticCode();
      this._refreshHostCode();
      this._refreshMapChoice();
      this.show('menu-host');
    };
    document.getElementById('btn-join-room').onclick = async ()=>{
      this.show('menu-join');
      const list = document.getElementById('room-list');
      list.innerHTML = '<div class="muted">Searching for public rooms…</div>';
      const rooms = await Net.listPublicRooms();
      if(!rooms.length){
        list.innerHTML = '<div class="muted">No public rooms found.<br>You can host one, or join a hidden room with a code.</div>';
        return;
      }
      list.innerHTML='';
      rooms.forEach(r=>{
        const row = document.createElement('div'); row.className='room-row';
        row.innerHTML = `<div><div class="rn">Room ${r.code}</div><div class="rm">${r.name||'Public'} • ${r.count||0}/${r.max||8}</div></div><div>Join →</div>`;
        row.onclick = ()=> this.game.startClient(r.code);
        list.appendChild(row);
      });
    };
    document.getElementById('btn-join-hidden').onclick = ()=> this.show('menu-join-hidden');

    // host settings
    document.querySelectorAll('.seg-opt').forEach(o=>{
      o.onclick = ()=>{
        o.parentElement.querySelectorAll('.seg-opt').forEach(x=>x.classList.remove('active'));
        o.classList.add('active');
        this.hostCfg.isPublic = (o.dataset.vis === 'public');
        document.getElementById('host-code-row').classList.toggle('hidden', this.hostCfg.isPublic);
      };
    });
    // host gamemode toggle (Deathmatch / Gladiator)
    const hostModeSeg = document.getElementById('host-gamemode-seg');
    if(hostModeSeg){
      hostModeSeg.querySelectorAll('.seg-opt').forEach(o=>{
        o.onclick = ()=>{
          hostModeSeg.querySelectorAll('.seg-opt').forEach(x=>x.classList.remove('active'));
          o.classList.add('active');
          this.hostCfg.gamemode = o.dataset.mode;
        };
      });
    }
    document.getElementById('host-maxplayers').oninput = e=> this.hostCfg.maxPlayers = Math.max(1,Math.min(20,+e.target.value||1));
    document.getElementById('host-fakeplayers').oninput = e=> this.hostCfg.fakePlayers = Math.max(0,Math.min(20,+e.target.value||0));
    document.getElementById('host-code').onclick = ()=> this._copyCode();
    document.getElementById('btn-copy-link').onclick = ()=> this._copyInviteLink();
    document.getElementById('btn-start-host').onclick = ()=>{
      this.game.setUseCustomMap(this.hostCfg.useCustomMap);
      this.game.startHost(this.hostCfg);
    };
    // map choice in host screen
    const mapBig = document.getElementById('host-map-big');
    const mapMine = document.getElementById('host-map-mine');
    if(mapBig) mapBig.onclick = ()=>{ this.hostCfg.useCustomMap=false; this._refreshMapChoice(); };
    if(mapMine) mapMine.onclick = ()=>{ this.hostCfg.useCustomMap=true; this._refreshMapChoice(); };

    // hidden join
    document.getElementById('btn-connect-hidden').onclick = ()=>{
      const code = document.getElementById('hidden-code-input').value.trim().toUpperCase();
      if(code.length<4){ this.toast('Enter a valid code'); return; }
      this.game.startClient(code);
    };
    document.getElementById('bigmap-close').onclick = ()=>{
      document.getElementById('bigmap').classList.add('hidden');
      if(this.game && this.game.cameraMode === 'dynamic'){
        const c = this.game.renderer && this.game.renderer.domElement;
        if(c) c.requestPointerLock();
      }
    };
      document.getElementById('minimap-btn').onclick = ()=> this.game.toggleBigMap();
      document.getElementById('menu-btn').onclick = ()=>{
        if(this.game && this.game.running){
          this.game._showScoreboard();
        } else {
          this.toggleEsc();
        }
      };
    // Scoreboard bottom buttons
    var sbResume = document.getElementById('sb-resume');
    if(sbResume) sbResume.onclick = ()=> document.getElementById('scoreboard-overlay').classList.add('hidden');
    var sbExit = document.getElementById('sb-exit');
    if(sbExit) sbExit.onclick = ()=>{
      document.getElementById('scoreboard-overlay').classList.add('hidden');
      if(this.game) this.game.leaveToMenu();
    };
    /* The shop's Buy and Back are wired where they are used, in _showShopBuy
       and _shopReceive. There used to be a block here looking up
       `shop-buy-cancel` and `shop-receive-ok` — neither id has ever existed in
       the markup, so it never bound anything. Removed rather than left as a
       rule that reads like it is doing something. */

    // Play buttons
    const btnPlay = document.getElementById('btn-play');
    if(btnPlay) btnPlay.onclick = ()=> this.startSelectedGamemode();
    
    // Gamemode button
    const btnGamemode = document.getElementById('btn-gamemode');
    if(btnGamemode) btnGamemode.onclick = ()=> this.show('menu-gamemode-select');
    
    // Gamemode squares (legacy)
    document.querySelectorAll('.gamemode-square').forEach(square => {
      square.onclick = ()=> this._selectGamemode(square.dataset.gamemode);
    });
    // Fullscreen gamemode cards
    document.querySelectorAll('.gm-card').forEach(card => {
      card.onclick = ()=> this._selectGamemode(card.dataset.gamemode);
    });
    /* Only modes that actually have a card can be selected. This also stops a
       mode card being clicked while the map vote is open, which used to stack a
       second mode start on top of the one already loading. */
    document.querySelectorAll('.gamemode-square').forEach(sq => {
      if(!document.querySelector('.gm-card[data-gamemode="' + sq.dataset.gamemode + '"]')){
        sq.classList.add('disabled');
        sq.title = 'Not available yet';
      }
    });
    /* ------------------------------------------------------------------
       THE ONE PLAYABLE MODE

       Capture the Circle is the only finished mode, so it is the only one
       offered. The others are commented out of index.html; this is the second
       half of that lock, and it matters because the mode is persisted.

       Without it, a player who selected Sandbox in a previous session still has
       'sandbox' in localStorage. Their cards are gone, so nothing can change
       the selection, but PLAY would still read the stored value and start a
       mode they cannot see and that cannot end -- pressing PLAY then appears to
       do nothing at all, which is exactly the "game is broken" symptom.

       Note that merely changing the FALLBACK is not enough. The stored value
       has to be validated against the modes that actually have a card, or it
       wins and the lock does nothing. That was the first version of this fix and
       it did not work.

       To re-enable a mode: uncomment its card in index.html. Nothing else here
       needs changing. */
    const storedMode = localStorage.getItem('tankparty_gamemode');
    const modeAvailable = (m) => !!document.querySelector('.gm-card[data-gamemode="' + m + '"]');
    this._selectedGamemode = (storedMode && modeAvailable(storedMode))
      ? storedMode
      : 'captureTheCircle';
    if(storedMode && !modeAvailable(storedMode)){
      console.warn('[gamemode] stored mode "' + storedMode + '" is no longer available, using captureTheCircle');
      localStorage.setItem('tankparty_gamemode', 'captureTheCircle');
    }
    this._syncGamemodeIcon();
    document.querySelectorAll('.gamemode-square').forEach(sq =>
      sq.classList.toggle('active', sq.dataset.gamemode === this._selectedGamemode)
    );
    document.querySelectorAll('.gm-card').forEach(c =>
      c.classList.toggle('selected', c.dataset.gamemode === this._selectedGamemode)
    );
    // Gladiator result overlay buttons
    const gladPlay = document.getElementById('glad-play-btn');
    if(gladPlay) gladPlay.onclick = ()=>{
      document.getElementById('glad-result').classList.add('hidden');
      try {
        if(this.game) this.game.startGladiator();
      } catch(err){
        // Never dead-end the player on a failed restart: drop back to the menu.
        console.error('Play again failed:', err);
        try { if(this.game) this.game.leaveToMenu(); } catch(e2){ console.error('menu fallback:', e2); }
        this.toast('Could not restart — back to menu');
      }
    };
    const gladWatch = document.getElementById('glad-watch-btn');
    if(gladWatch) gladWatch.onclick = ()=>{
      document.getElementById('glad-result').classList.add('hidden');
      if(this.game && this.game._startSpectate) this.game._startSpectate();
    };
    const gladExit = document.getElementById('glad-exit-btn');
    if(gladExit) gladExit.onclick = ()=>{
      try { if(this.game) this.game.leaveToMenu(); }
      catch(err){
        console.warn('Exit to menu failed:', err);
        document.getElementById('glad-result').classList.add('hidden');
        this.show('menu-main');
      }
    };
    // Free Roam / Battle Mode (index.html)
    const btnPlayFree = document.getElementById('btn-play-freeroam');
    if(btnPlayFree) btnPlayFree.onclick = ()=>{ if(this.game) this._startFreeRoam(); };
    const btnPlayBattle = document.getElementById('btn-play-battle');
    if(btnPlayBattle) btnPlayBattle.onclick = ()=> this.show('menu-battle-select');
    const btnBattleSP = document.getElementById('btn-battle-sp');
    if(btnBattleSP) btnBattleSP.onclick = ()=>{
      if(!this.game) return;
      const self = this;
      MapVoting.showVote(function(winner){
        self._votedMap = winner;
        self.game.startSingleplayer();
      }, {multiplayer:false, humans:1});
    };
    const btnBattleMP = document.getElementById('btn-battle-mp');
    if(btnBattleMP) btnBattleMP.onclick = ()=> this.show('menu-multiplayer');
    const btnPlayBack = document.getElementById('btn-play-back');
    if(btnPlayBack) btnPlayBack.onclick = ()=> this.show('menu-main');
    // Legacy (tank-party.html)
    const btnPlaySP = document.getElementById('btn-play-sp');
    if(btnPlaySP) btnPlaySP.onclick = ()=>{
      if(!this.game) return;
      const self = this;
      MapVoting.showVote(function(winner){
        self._votedMap = winner;
        self.game.startSingleplayer();
      }, {multiplayer:false, humans:1});
    };
    const btnPlayMP = document.getElementById('btn-play-mp');
    if(btnPlayMP) btnPlayMP.onclick = ()=> this.show('menu-multiplayer');

    // Settings: reset and save&exit
    const btnReset = document.getElementById('btn-settings-reset');
    const btnSaveExit = document.getElementById('btn-settings-saveexit');
    if(btnReset) btnReset.onclick = ()=>{
      this.settings = resetSettings();
      saveSettings(this.settings);
      this._renderBinds();
      this._renderAimSettings();
      this._renderViewSettings();
      this._renderXraySettings();
this._renderCamSettings();
      this._renderGraphicsSettings();
      this._renderOtherSettings();
      this._wireSettingsTabs();
      if(this.game) this.game.applySettings(this.settings);
      this._updateMapHint();
      this.toast('Settings reset to defaults');
    };
    if(btnSaveExit) btnSaveExit.onclick = ()=>{
      saveSettings(this.settings);
      this.show('menu-main');
    };

    // Preview back button
    const pb = document.getElementById('btn-preview-back');
    if(pb) pb.onclick = ()=>{ this._closePreview(); this.show('menu-main'); };

    // ESC menu buttons
    document.getElementById('esc-yes').onclick = ()=>{ this._closeEsc(); this.game.leaveToMenu(); };
    document.getElementById('esc-no').onclick  = ()=> this._resumeGame();

    // Clan system buttons
    document.getElementById('btn-create-clan-menu').onclick = ()=> this.show('menu-create-clan');
    document.getElementById('btn-search-clans-menu').onclick = ()=> this.show('menu-search-clans');
    
    // Clan visibility toggle
    document.querySelectorAll('.clan-visibility-seg .seg-opt').forEach(o=>{
      o.onclick = ()=>{
        o.parentElement.querySelectorAll('.seg-opt').forEach(x=>x.classList.remove('active'));
        o.classList.add('active');
      };
    });

    // Create clan submit
    document.getElementById('btn-create-clan-submit').onclick = ()=> this._createClan();

    // Search public clans
    document.getElementById('btn-search-public-clans').onclick = ()=> this._searchPublicClans();
    
    // Join hidden clan
    document.getElementById('btn-join-hidden-clan').onclick = ()=> this._joinHiddenClan();

    // Clan UI actions
    document.getElementById('btn-copy-clan-code').onclick = ()=> this._copyClanCode();
    document.getElementById('btn-leave-clan').onclick = ()=> this._leaveClan();
    document.getElementById('btn-send-chat').onclick = ()=> this._sendChatMessage();
    
    // Chat input enter key
    const chatInput = document.getElementById('clan-chat-input');
    if(chatInput){
      chatInput.onkeydown = (e)=>{
        if(e.code === 'Enter') this._sendChatMessage();
      };
    }
  },

  /* ---------- Tank Preview ---------- */
  _previewRenderer: null,
  _previewScene: null,
  _previewCamera: null,
  _previewTank: null,
  _previewLoopId: null,

  _initPreview(){
    this._closePreview(); // cleanup any previous
    const id = this.settings.selectedTank;
    const def = TANKS[id];
    if(!def) return;

    document.getElementById('preview-name').textContent = def.name;
    document.getElementById('preview-loading').style.display = 'flex';
    const relText = def.magSize ? `Mag ${def.magSize} / Reload ${def.magReload}s (burst ${def.reload}s)` : `Reload ${def.reload}s`;
    document.getElementById('preview-stats').innerHTML =
      `HP ${def.hp} &bull; DMG ${def.damage} &bull; Speed ${def.speed} &bull; ${relText}<br>Mass ${def.mass} &bull; View Range ${def.viewRange}m`;

    const host = document.getElementById('preview-canvas-host');
    const W = host.clientWidth || 480;
    const H = host.clientHeight || 320;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x20242a);
    this._previewScene = scene;

    const cam = new THREE.PerspectiveCamera(40, W/H, 0.1, 100);
    cam.position.set(8, 6, 8);
    cam.lookAt(0, 0, 0);
    this._previewCamera = cam;

    const renderer = new THREE.WebGLRenderer({antialias: true, alpha: false});
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    host.innerHTML = '';
    host.appendChild(renderer.domElement);
    this._previewRenderer = renderer;

    // Lights
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x55502e, 1.2);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4dc, 1.5);
    sun.position.set(10, 20, 10);
    sun.castShadow = true;
    scene.add(sun);
    scene.add(sun.target);
    const amb = new THREE.AmbientLight(0x6a6a78, 0.5);
    scene.add(amb);

    // Ground plane
    const groundGeo = new THREE.PlaneGeometry(16, 16);
    groundGeo.rotateX(-Math.PI/2);
    const groundMat = Toon.mat({
      color: 0x2a2f2a
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    scene.add(ground);

    // Build tank
    const previewTank = new THREE.Group();
    const bodyMat = Toon.mat({
      color: def.color
    });
    const b = def.body;
    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.l), bodyMat);
    bodyMesh.position.y = b.h/2;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    previewTank.add(bodyMesh);
    try{ previewTank.add(Tank.createOutlineMesh(bodyMesh)); }catch(e){}
    // Treads
    const treadMat = Toon.mat({color: 0x222226});
    [-1, 1].forEach(s => {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, b.l+0.2), treadMat);
      t.position.set(s*(b.w/2+0.05), 0.25, 0);
      t.castShadow = true;
      previewTank.add(t);
    });

    // Turret
    const turretGroup = new THREE.Group();
    const tDef = def.turret;
    const turretMat = Toon.mat({
      color: def.turretColor
    });
    const turretMesh = new THREE.Mesh(new THREE.BoxGeometry(tDef.w, tDef.h, tDef.l), turretMat);
    turretMesh.position.y = tDef.h/2;
    turretMesh.castShadow = true;
    turretGroup.add(turretMesh);
    try{ turretGroup.add(Tank.createOutlineMesh(turretMesh)); }catch(e){}

    // Barrel
    const barrelMat = Toon.mat({color: 0x2a2a2e});
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(def.barrelR, def.barrelR, def.barrelLen, 10),
      barrelMat
    );
    barrel.rotation.x = Math.PI/2;
    barrel.position.set(0, tDef.h*0.4, tDef.l/2 + def.barrelLen/2);
    barrel.castShadow = true;
    turretGroup.add(barrel);

    turretGroup.position.y = b.h;
    previewTank.add(turretGroup);
    previewTank.position.y = 0;

    scene.add(previewTank);
    this._previewTank = previewTank;

    document.getElementById('preview-loading').style.display = 'none';

    // Animation loop
    let angle = 0;
    const loop = () => {
      this._previewLoopId = requestAnimationFrame(loop);
      angle += 0.008;
      previewTank.rotation.y = angle;
      turretGroup.rotation.y = Math.sin(angle * 0.7) * 0.4;
      renderer.render(scene, cam);
    };
    loop();
  },

  _closePreview(){
    if(this._previewLoopId){
      cancelAnimationFrame(this._previewLoopId);
      this._previewLoopId = null;
    }
    if(this._previewRenderer){
      this._previewRenderer.dispose();
      this._previewRenderer = null;
    }
    this._previewScene = null;
    this._previewCamera = null;
    this._previewTank = null;
  },

  /* ---------- Main Menu Inline Preview ---------- */
  _mainPreviewRenderer: null,
  _mainPreviewScene: null,
  _mainPreviewCam: null,
  _mainPreviewTank: null,
  _mainPreviewLoopId: null,
  _mainPreviewTurretGroup: null,

  _startMainPreview(){
    const host = document.getElementById('main-menu-preview-canvas');
    if(!host) return;

    /* ONE PREVIEW, ALWAYS.

       Every main-menu visit calls this. It builds a whole second WebGLRenderer
       and its own requestAnimationFrame loop. It never used to stop whatever was
       already running first, so returning to the main menu after visiting a
       submenu left the previous renderer AND its loop alive: a full-rate 3D
       render loop rendering into a canvas that had been pulled out of the DOM,
       with its scene, textures and context all retained.

       That is a permanent CPU/GPU tax that compounds on every menu visit, and
       browsers cap live WebGL contexts (around 16). Past the cap the browser
       force-loses the OLDEST context -- which is the MAIN GAME's renderer, not
       the preview's. The result is the main game going black or locking up
       after a certain number of menu visits, which is very hard to connect back
       to browsing menus.

       Stopping first makes the limit structural instead of hopeful: there can
       never be more than one preview renderer, no matter how the player
       navigates. */
    this._stopMainPreview();
    // Default: the classic void scene with a drifting tank (legacy preview).
    // Switch to the WoT-style garage by typing 'garage' in the Codes menu.
    const wantGarage = localStorage.getItem('tankparty_garage_preview') === '1';
    if(wantGarage && window.Garage){
      const def = TANKS && (TANKS[this.settings.selectedTank] || TANKS.coolbuddy);
      try{
        if(Garage.start(host, def ? this.settings.selectedTank : 'coolbuddy') !== false) return;
      }catch(e){ console.warn('Garage start failed:', e); }
    }
    this._startMainPreviewLegacy(host);
  },

  async _startMainPreviewLegacy(host){
    if(!host) return;
    const def = TANKS[this.settings.selectedTank];
    if(!def) return;

    /* IN-FLIGHT GUARD.

       This function is `async` and awaits Models.load() before it builds
       anything. It is reachable from three different call sites, and nothing
       stopped two of them overlapping. When they did:

         * two WebGLRenderers were created and left in the DOM at once
         * two rAF loops ran forever
         * _stopMainPreview() only cancels the loop id it knows about, so the
           other one survived -- running full time forever, rendering into a
           canvas nobody can see, with its scene and renderer retained

       Two rAF loops each rendering a full 3D tank plus a leaked WebGL context
       is a permanent CPU tax that gets worse every time the tank selection is
       opened, and it presents as the menu getting slower and slower and then
       hanging. Bailing out if another start is already in progress costs
       nothing: the one that is running is building the thing we want. */
    if(this._mainPreviewStarting){
      return;
    }
    this._mainPreviewStarting = true;
    try {
      await this._startMainPreviewLegacyInner(host, def);
    } finally {
      /* Always cleared, including on a throw. A guard left set by a failed
         start would permanently disable the preview instead. */
      this._mainPreviewStarting = false;
    }
  },

  /* Find the node the preview's aim loop is allowed to yaw: an actual turret,
     named as such by the exporter. Returns null when the model has no separate
     turret, which is the common case, and null means "leave the tank alone"
     rather than "yaw whatever is handy". */
  _findPreviewTurret(root){
    let found = null;
    try {
      root.traverse(o => {
        if(found || !o.name) return;
        if(/turret|tur[^a-z]/i.test(String(o.name))) found = o;
      });
    } catch(e){}
    return found;
  },

  async _startMainPreviewLegacyInner(host, def){
    const W = host.clientWidth || 320;
    const H = host.clientHeight || 220;

    const scene = new THREE.Scene();
    scene.background = null;
    this._mainPreviewScene = scene;

    const previewDist = 7, previewH = previewDist*0.78+3;
    const cam = new THREE.PerspectiveCamera(55, W/H, 0.1, 100);
    cam.position.set(0, previewH, -previewDist);
    cam.lookAt(0, 1.2, 0);
    this._mainPreviewCam = cam;

    const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.innerHTML = '';
    host.appendChild(renderer.domElement);
    this._mainPreviewRenderer = renderer;

    const hemi = new THREE.HemisphereLight(0xdfeaff, 0xbbbbbb, 0.8);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(10, 20, 10);
    scene.add(sun);
    const amb = new THREE.AmbientLight(0xaaaaaa, 0.6);
    scene.add(amb);

    const previewTank = new THREE.Group();
    this._mainPreviewTank = previewTank;
    this._mainPreviewTurretGroup = null;
    this._mainPreviewTrails = [];
    
    // Try to load real tank model
    let modelLoaded = false;
    if(def.model && window.Models && window.Models.hasModel(def.model)){
      try{
        const grp = await window.Models.load(def.model);
        if(grp && previewTank && scene){
          const scale = (def.modelScale || 1.0) * 2.0;
          grp.scale.setScalar(scale);
          
          if(def.modelYaw != null){
            grp.rotation.y = def.modelYaw * Math.PI / 180;
          }
          if(def.modelFlipY){
            grp.rotation.y += Math.PI;
          }
          
          const box3 = new THREE.Box3().setFromObject(grp);
          const center = box3.getCenter(new THREE.Vector3());
          grp.position.y -= center.y;
          
          grp.traverse(child => {
            if(child.isMesh){
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          
          previewTank.add(grp);
          /* THE PREVIEW'S AIM LOOP YAWS WHATEVER THIS POINTS AT.

             It used to be handed `grp` — the entire model — because that was the
             easiest object to hold. The loop then wrote `rotation.y` on it every
             frame to make the tank appear to aim, which for a loaded model means
             the WHOLE TANK swings round as if it were a turret, on top of the
             `previewTank.rotation.y = heading` it is already being given for
             driving. On top of that it lerped a group whose rotation.y was set
             to modelYaw, so a -90 degree authored facing was immediately dragged
             toward ~0 and the tank presented its side.

             Only an actual turret node may be yawed. Most of the roster is
             authored without a separate one (the battle loader splits those parts
             out by height at runtime), and for those the honest answer is no
             turret sway at all — which looks far better than the whole hull
             pivoting in place. */
          this._mainPreviewTurretGroup = this._findPreviewTurret(grp);
          modelLoaded = true;
        }
      }catch(err){
        console.warn('Failed to load tank model for preview:', def.model, err);
      }
    }
    
    if(!modelLoaded){
      // Fallback to box tank
      const bodyMat = Toon.mat({color: def.color});
      const b = def.body;
      const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.l), bodyMat);
      bodyMesh.position.y = b.h/2;
      bodyMesh.castShadow = true;
      previewTank.add(bodyMesh);
      try{ previewTank.add(Tank.createOutlineMesh(bodyMesh)); }catch(e){}

      const treadMat = Toon.mat({color: 0x222226});
      [-1, 1].forEach(s => {
        const t = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, b.l+0.2), treadMat);
        t.position.set(s*(b.w/2+0.05), 0.25, 0);
        t.castShadow = true;
        previewTank.add(t);
      });

      const turretGroup = new THREE.Group();
      const tDef = def.turret;
      const turretMat = Toon.mat({color: def.turretColor});
      const turretMesh = new THREE.Mesh(new THREE.BoxGeometry(tDef.w, tDef.h, tDef.l), turretMat);
      turretMesh.position.y = tDef.h/2;
      turretMesh.castShadow = true;
      turretGroup.add(turretMesh);
      try{ turretGroup.add(Tank.createOutlineMesh(turretMesh)); }catch(e){}

      const barrelMat = Toon.mat({color: 0x2a2a2e});
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(def.barrelR, def.barrelR, def.barrelLen, 10), barrelMat);
      barrel.rotation.x = Math.PI/2;
      barrel.position.set(0, tDef.h*0.4, tDef.l/2 + def.barrelLen/2);
      barrel.castShadow = true;
      turretGroup.add(barrel);

      turretGroup.position.y = b.h;
      previewTank.add(turretGroup);
      this._mainPreviewTurretGroup = turretGroup;
    }
    
    scene.add(previewTank);
    let trailTimer = 0;
    let turretAim = 0;
    let turretTimer = 0;

    let t = 0;
    let heading = 0;
    const turnSpeed = 1.5;

    const loop = () => {
      if(!this._mainPreviewTrails){ cancelAnimationFrame(this._mainPreviewLoopId); return; }
      this._mainPreviewLoopId = requestAnimationFrame(loop);
      t += 0.016;

      const fwd = Math.max(0.02, 0.4 + 0.55 * Math.sin(t * 0.05));
      let turnDir = 0;
      const turnPulse = Math.sin(t * 0.045) + Math.sin(t * 0.033) + Math.sin(t * 0.019);
      if(Math.abs(turnPulse) > 2.15) turnDir = Math.sign(turnPulse) * 0.6;
      heading += turnDir * turnSpeed * 0.016;
      const sx = Math.sin(heading) * fwd * 3.5 * 0.016;
      const sz = Math.cos(heading) * fwd * 3.5 * 0.016;
      const px = previewTank.position.x + sx;
      const pz = previewTank.position.z + sz;
      previewTank.position.set(px, 0, pz);
      previewTank.rotation.y = heading;
      turretTimer += 0.016;
      if(turretTimer > 2.5 + Math.sin(t * 0.11) * 1.2){
        turretTimer = 0;
        turretAim = Math.sin(t * 0.23) * 0.9 + Math.sin(t * 0.09) * 0.3;
      }
      const turret = this._mainPreviewTurretGroup;
      if(turret) turret.rotation.y += (turretAim - turret.rotation.y) * 0.045;

      cam.position.lerp(new THREE.Vector3(
        px - Math.sin(heading) * previewDist,
        previewH,
        pz - Math.cos(heading) * previewDist
      ), 0.08);
      cam.lookAt(px, 1.2, pz);

      // Track trails
      const spd = Math.abs(fwd) * 3.5;
      if(spd > 0.5){
        trailTimer += 0.016;
        if(trailTimer >= Math.max(0.05, 0.8 / spd)){
          trailTimer = 0;
          if(!Menu._trailGeo){
            Menu._trailGeo = new THREE.BoxGeometry(0.35, 0.02, 0.5);
          }
          const off = def.body.w/2 + 0.05;
          const back = -def.body.l/2;
          const ch = Math.cos(heading), sh = Math.sin(heading);
          const order = this._mainPreviewTrails.length;
          [-1, 1].forEach(side => {
            const mat = new THREE.MeshBasicMaterial({color:0x1a1a1a, transparent:true, opacity:0.45, depthWrite:false});
            const mesh = new THREE.Mesh(Menu._trailGeo, mat);
            mesh.position.set(px + side*off*ch + back*sh, 0.01, pz - side*off*sh + back*ch);
            mesh.rotation.y = heading;
            mesh.renderOrder = order;
            scene.add(mesh);
            this._mainPreviewTrails.push({mesh, life:2, maxLife:2});
          });
        }
      }

      for(let i=this._mainPreviewTrails.length-1; i>=0; i--){
        const seg = this._mainPreviewTrails[i];
        seg.life -= 0.016;
        seg.mesh.material.opacity = (seg.life / seg.maxLife) * 0.45;
        if(seg.life <= 0){
          scene.remove(seg.mesh);
          seg.mesh.material.dispose();
          this._mainPreviewTrails.splice(i, 1);
        }
      }
      while(this._mainPreviewTrails.length > 200){
        const old = this._mainPreviewTrails.shift();
        scene.remove(old.mesh);
        old.mesh.material.dispose();
      }

      renderer.render(scene, cam);
    };

    // Resize handler for orientation changes
    const onResize = () => {
      const w = host.clientWidth || 320;
      const h = host.clientHeight || 220;
      renderer.setSize(w, h);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    };
    window.addEventListener('resize', onResize);
    this._mainPreviewResizeHandler = onResize;

    loop();
  },

  _stopMainPreview(){
    if(window.Garage) Garage.stop();
    if(this._mainPreviewResizeHandler){
      window.removeEventListener('resize', this._mainPreviewResizeHandler);
      this._mainPreviewResizeHandler = null;
    }
    if(this._mainPreviewLoopId){
      cancelAnimationFrame(this._mainPreviewLoopId);
      this._mainPreviewLoopId = null;
    }
    if(this._mainPreviewRenderer){
      /* dispose() releases the renderer's own objects but does NOT surrender the
         WebGL context. The browser keeps that context alive until it is either
         garbage collected or explicitly lost, and it counts against a hard
         per-page limit. forceContextLoss() is what actually frees the slot --
         without it, every preview renderer this page ever made is still
         occupying one. */
      try { this._mainPreviewRenderer.dispose(); } catch(e){}
      try {
        const gl = this._mainPreviewRenderer.getContext && this._mainPreviewRenderer.getContext();
        const ext = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
        if(ext && ext.loseContext) ext.loseContext();
        else if(this._mainPreviewRenderer.forceContextLoss) this._mainPreviewRenderer.forceContextLoss();
      } catch(e){}
      this._mainPreviewRenderer = null;
    }
    if(this._mainPreviewTrails){
      this._mainPreviewTrails.forEach(s => {
        if(this._mainPreviewScene) this._mainPreviewScene.remove(s.mesh);
        s.mesh.material.dispose();
      });
      this._mainPreviewTrails = null;
    }
    this._mainPreviewScene = null;
    this._mainPreviewCam = null;
    this._mainPreviewTank = null;
    this._mainPreviewTurretGroup = null;
    const host = document.getElementById('main-menu-preview-canvas');
    if(host) host.innerHTML = '';
  },

  toggleMainPreviewMode(){
    const on = localStorage.getItem('tankparty_garage_preview') === '1';
    localStorage.setItem('tankparty_garage_preview', on ? '0' : '1');
    this.toast(on ? 'Main menu preview: classic void tank' : 'Main menu preview: garage');
    if(window.Garage){ try{ Garage.stop(); }catch(e){} }
    this._stopMainPreview();
    this._startMainPreview();
  },

  _refreshHostCode(){
    document.getElementById('host-code').textContent = this.hostCfg.code;
    document.getElementById('host-code-row').classList.toggle('hidden', this.hostCfg.isPublic);
  },
  _refreshMapChoice(){
    const big = document.getElementById('host-map-big');
    const mine = document.getElementById('host-map-mine');
    if(!big || !mine) return;
    big.classList.toggle('selected', !this.hostCfg.useCustomMap);
    mine.classList.toggle('selected', this.hostCfg.useCustomMap);
    mine.classList.toggle('disabled', !hasCustomMap());
    if(!hasCustomMap() && this.hostCfg.useCustomMap){ this.hostCfg.useCustomMap=false; big.classList.add('selected'); }
  },

  async _copyCode(){
    try{
      await navigator.clipboard.writeText(this.hostCfg.code);
      this.toast('Copied to clipboard');
    }catch(e){
      const ta=document.createElement('textarea'); ta.value=this.hostCfg.code;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      this.toast('Copied to clipboard');
    }
  },

  _copyInviteLink(){
    const url = window.location.origin + window.location.pathname + '?room=' + this.hostCfg.code;
    try{
      navigator.clipboard.writeText(url).then(() => this.toast('Invite link copied!')).catch(() => this._fallbackCopy(url));
    }catch(e){
      this._fallbackCopy(url);
    }
  },
  _fallbackCopy(text){
    const ta=document.createElement('textarea'); ta.value=text;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    this.toast('Invite link copied!');
  },

  /* ---------- ESC menu (works anywhere) ---------- */
  _wireEsc(){
    var self = this;
    window.addEventListener('keydown', e=>{
      if(e.code!=='Escape') return;
      if(document.activeElement && /input|textarea/i.test(document.activeElement.tagName)) return;
      // If big map is open, close it on Escape
      if(!document.getElementById('bigmap').classList.contains('hidden')){
        document.getElementById('bigmap').classList.add('hidden');
        if(self.game && self.game.cameraMode === 'dynamic'){
          const c = self.game.renderer && self.game.renderer.domElement;
          if(c) c.requestPointerLock();
        }
        return;
      }
      // If scoreboard is open, close it on Escape
      var sbOv = document.getElementById('scoreboard-overlay');
      if(sbOv && !sbOv.classList.contains('hidden')){
        sbOv.classList.add('hidden');
        return;
      }
      // Escape: exit immediately when the match result overlay is up
      var gladOv = document.getElementById('glad-result');
      if(gladOv && !gladOv.classList.contains('hidden')){
        if(self.game) self.game.leaveToMenu();
        return;
      }
      // Escape: close big map or pop settings menu to main menu
      var visibleMenu = document.querySelector('.menu:not(.hidden)');
      if(visibleMenu){
        var mid = visibleMenu.id;
        if(mid === 'menu-settings' && self.settings) saveSettings(self.settings);
        if(mid === 'menu-store' || mid === 'menu-shop-buy' || mid === 'menu-shop-receive'){
          /* Leaving mid-hold must not leave a rAF loop running against a screen
             that is no longer on top of anything: the purchase would fire while
             the player is on the main menu. */
          self._cancelShopHold(true);
          self._clearShopReceiveTimers();
          self.show('menu-main');
          return;
        }
        if(mid === 'menu-storage' || mid === 'menu-profile'){
          self.show('menu-main');
          return;
        }
        if(mid === 'menu-collections'){
          self.show(self._platoonReturn ? 'menu-platoon' : 'menu-main');
          self._platoonReturn = false;
          return;
        }
        if(mid === 'menu-platoon'){
          self._platoonReturn = false;
          self.show('menu-main');
          return;
        }
        /* Closing the Sandbox panel must not leave a hosted room running in the
           background holding a peer open -- that is a live connection nobody can
           see and nobody asked for any more. */
        if(mid === 'menu-sandbox'){
          if(window.SandboxRoom) { try{ SandboxRoom.leave(); }catch(e){} }
          self.show('menu-main');
          return;
        }
        return;
      }
      // No menu open — toggle ESC/pause menu during gameplay
      if(self.game && self.game.running){
        self.toggleEsc();
      }
    });
  },
  _wireMinimapKey(){
    if(document.body.classList.contains('is-mobile')) return;
    const self = this;
    window.addEventListener('keydown', e=>{
      if(document.activeElement && /input|textarea/i.test(document.activeElement.tagName)) return;
      if(e.code !== (self.settings.binds.minimap || 'KeyM')) return;
      if(document.getElementById('hud').classList.contains('hidden')){
        var _specHud2 = document.getElementById('spectator-hud');
        if(!_specHud2 || _specHud2.classList.contains('hidden')) return;
      }
      self.game.toggleBigMap();
    });
  },
  _updateMapHint(){
    if(document.body.classList.contains('is-mobile')) return;
    const el = document.querySelector('.map-key-hint');
    if(el) el.textContent = this._keyLabel(this.settings.binds.minimap || 'KeyM');
  },
  toggleEsc(){
    if(this.escOpen){ this._closeEsc(); }
    else{
      // Release pointer lock when opening esc menu
      if(document.pointerLockElement) document.exitPointerLock();
      document.getElementById('esc-menu').classList.remove('hidden');
      this.escOpen = true;
    }
  },
  _closeEsc(){
    document.getElementById('esc-menu').classList.add('hidden');
    this.escOpen = false;
  },
  _resumeGame(){
    this._closeEsc();
    // Re-lock pointer when resuming gameplay
    if(this.game && this.game.cameraMode === 'dynamic'){
      const c = this.game.renderer && this.game.renderer.domElement;
      if(c) c.requestPointerLock();
    }
  },

  /* ---------- settings binds ---------- */
  _renderBinds(){
    const wrap = document.getElementById('bind-list');
    wrap.innerHTML='';
    const isMobile = document.body.classList.contains('is-mobile');
    if(isMobile){
      const info = document.createElement('div');
      info.className = 'bind-row touch-controls-hint';
      info.innerHTML = '<div class="bl"><b>Touch controls</b><br><span class="hint">Left joystick: drive &amp; turn the hull — like W / A / S / D on PC<br>Right joystick: aim the turret &amp; fire<br>The camera is locked behind your tank hull</span></div>';
      wrap.appendChild(info);
      return;
    }
    Object.keys(DEFAULT_BINDS).forEach(action=>{
      if(isMobile && action === 'minimap') return;
      const row = document.createElement('div'); row.className='bind-row';
      row.innerHTML = `<div class="bl">${DEFAULT_BINDS[action].label}</div><div class="bind-key" data-action="${action}">${this._keyLabel(this.settings.binds[action])}</div>`;
      wrap.appendChild(row);
    });
    wrap.querySelectorAll('.bind-key').forEach(el=>{
      el.onclick = async ()=>{
        el.classList.add('binding'); el.textContent='Press a key / wheel…';
        const captured = await Input.captureBind();
        this.settings.binds[el.dataset.action] = captured;
        saveSettings(this.settings);
        el.classList.remove('binding');
        el.textContent = this._keyLabel(captured);
        this.game.applySettings(this.settings);
        this._updateMapHint();
      };
    });
  },
  _keyLabel(k){
    if(k==='LMB') return 'LMB';
    if(k==='RMB') return 'RMB';
    if(k==='MMB') return 'MMB';
    if(k==='WheelUp') return 'Wheel ↑';
    if(k==='WheelDown') return 'Wheel ↓';
    if(k==='Space') return 'Space';
    if(k.startsWith('Key')) return k.slice(3);
    if(k.startsWith('Arrow')) return k.slice(5)+' arrow';
    return k;
  },

  /* ---------- aim line settings ---------- */
  /* ── Stylised settings sliders ────────────────────────────────────────
     The filled part of a slider track is painted from a CSS custom
     property (--pct), since a range input cannot fill itself. One
     delegated listener plus one MutationObserver keep it right for every
     slider that exists now and for any panel that gets re-rendered later. */
  _syncRange(el){
    if(!el || el.type !== 'range') return;
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '100');
    const span = (max - min) || 1;
    let p = ((parseFloat(el.value) - min) / span) * 100;
    if(!isFinite(p)) p = 0;
    p = Math.max(0, Math.min(100, p));
    el.style.setProperty('--pct', p.toFixed(1) + '%');
  },

  _initRangeStyling(){
    if(this._rangeStylingOn) return;
    this._rangeStylingOn = true;
    const syncTree = (root) => {
      if(!root) return;
      if(root.nodeType === 1 && root.matches && root.matches('input[type=range]')) this._syncRange(root);
      if(root.querySelectorAll){
        const list = root.querySelectorAll('input[type=range]');
        for(let i = 0; i < list.length; i++) this._syncRange(list[i]);
      }
    };
    syncTree(document);
    document.addEventListener('input', (e) => {
      if(e.target && e.target.matches && e.target.matches('input[type=range]')) this._syncRange(e.target);
    }, true);
    if(window.MutationObserver && document.body){
      new MutationObserver((muts) => {
        for(const m of muts){
          const added = m.addedNodes;
          for(let i = 0; i < added.length; i++){
            const n = added[i];
            if(!n || n.nodeType !== 1) continue;
            if(n.matches && n.matches('input[type=range]')) this._syncRange(n);
            else if(n.querySelector && n.querySelector('input[type=range]')) syncTree(n);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  },

  _renderAimSettings(){
    const wrap = document.getElementById('aim-settings');
    if(!wrap) return;
    const des = this.settings.aimLineDesign || 'default';
    const sty = this.settings.aimLineStyle || 'fade';
    wrap.innerHTML = `
      <label>Trajectory line opacity: <span id="aim-op-val">${Math.round(this.settings.aimLineOpacity*100)}%</span></label>
      <input type="range" id="aim-op" min="0" max="100" value="${Math.round(this.settings.aimLineOpacity*100)}">
      <label>Trajectory line color</label>
      <input type="color" id="aim-color" value="${this.settings.aimLineColor}">
      <label>Trajectory line design</label>
      <div class="seg">
        <div class="seg-opt${des==='default'?' active':''}" data-aimdes="default">Default</div>
        <div class="seg-opt${des==='professional'?' active':''}" data-aimdes="professional">Professional</div>
      </div>
      <label style="margin-top:18px">
        <input type="checkbox" id="rico-toggle" ${this.settings.ricochetIndicator?'checked':''}>
        Ricochet indicator <span style="color:var(--muted);font-size:11px">(colored lines on target)</span>
      </label>
      <label style="margin-top:18px">Trajectory line style</label>
      <button type="button" class="aim-styles-btn" id="aim-styles-btn" aria-expanded="false">Styles ▾</button>
      <div class="aim-styles-panel" id="aim-styles-panel" hidden>
        <div class="aim-style-card${sty==='fade'?' active':''}" data-aimstyle="fade">
          <canvas class="aim-style-canvas"></canvas><span class="aim-style-name">Fade tail</span>
        </div>
        <div class="aim-style-card${sty==='breakup'?' active':''}" data-aimstyle="breakup">
          <canvas class="aim-style-canvas"></canvas><span class="aim-style-name">Break-up</span>
        </div>
        <div class="aim-style-card${sty==='taper'?' active':''}" data-aimstyle="taper">
          <canvas class="aim-style-canvas"></canvas><span class="aim-style-name">Taper</span>
        </div>
        <div class="aim-style-card${sty==='dots'?' active':''}" data-aimstyle="dots">
          <canvas class="aim-style-canvas"></canvas><span class="aim-style-name">Dots</span>
        </div>
        <div class="aim-style-card${sty==='zigzag'?' active':''}" data-aimstyle="zigzag">
          <canvas class="aim-style-canvas"></canvas><span class="aim-style-name">Zigzag</span>
        </div>
        <div class="aim-style-card${sty==='wedge'?' active':''}" data-aimstyle="wedge">
          <canvas class="aim-style-canvas"></canvas><span class="aim-style-name">Wedge</span>
        </div>
        <div class="aim-style-card${sty==='pulse'?' active':''}" data-aimstyle="pulse">
          <canvas class="aim-style-canvas"></canvas><span class="aim-style-name">Pulse</span>
        </div>
      </div>`;
    document.getElementById('aim-op').oninput = e=>{
      this.settings.aimLineOpacity = +e.target.value/100;
      document.getElementById('aim-op-val').textContent = e.target.value+'%';
      this._commitAimSettings();
    };
    document.getElementById('aim-color').oninput = e=>{
      this.settings.aimLineColor = e.target.value;
      this._commitAimSettings();
    };
    wrap.querySelectorAll('[data-aimdes]').forEach(el=>{
      el.onclick = ()=>{
        wrap.querySelectorAll('[data-aimdes]').forEach(x=>x.classList.remove('active'));
        el.classList.add('active');
        this.settings.aimLineDesign = el.dataset.aimdes;
        this._commitAimSettings();
      };
    });
    const ricoToggle = document.getElementById('rico-toggle');
    if(ricoToggle) ricoToggle.onchange = e=>{
      this.settings.ricochetIndicator = e.target.checked;
      this._commitAimSettings();
    };

    // ---- "Styles" button: opens the three clickable line previews ----
    const stylesBtn = document.getElementById('aim-styles-btn');
    const stylesPanel = document.getElementById('aim-styles-panel');
    const paintCards = ()=>{
      stylesPanel.querySelectorAll('.aim-style-card').forEach(card=>{
        this._drawAimStylePreview(card.querySelector('canvas'), card.dataset.aimstyle);
      });
    };
    if(stylesBtn && stylesPanel){
      stylesBtn.onclick = ()=>{
        const opening = stylesPanel.hasAttribute('hidden');
        if(opening){ stylesPanel.removeAttribute('hidden'); paintCards(); }
        else stylesPanel.setAttribute('hidden','');
        stylesBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
        stylesBtn.textContent = opening ? 'Styles ▴' : 'Styles ▾';
      };
      stylesPanel.querySelectorAll('[data-aimstyle]').forEach(el=>{
        el.onclick = ()=>{
          stylesPanel.querySelectorAll('[data-aimstyle]').forEach(x=>x.classList.remove('active'));
          el.classList.add('active');
          this.settings.aimLineStyle = el.dataset.aimstyle;
          this._commitAimSettings();
        };
      });
      if(!stylesPanel.hasAttribute('hidden')) paintCards();
    }
  },

  _commitAimSettings(){
    saveSettings(this.settings);
    if(this.game && this.game.applySettings) this.game.applySettings(this.settings);
  },

  /* ---------- x-ray: see the part of a tank that is behind something ---------- */

  /* The six patterns, named for the settings screen. The values are the same
     strings xray.js keeps in Xray.STYLES and the same strings config.js
     allow-lists on save, so all three have to agree — hence read off Xray
     rather than retyped, which is what stops a rename in one place silently
     breaking the other two. */
  _xrayStyles(){
    if(typeof Xray !== 'undefined' && Xray && Xray.STYLES) return Xray.STYLES.slice();
    return ['stripes','scanlines','hatch','dots','solid','pulse'];
  },

  _renderXraySettings(){
    const wrap = document.getElementById('xray-settings');
    if(!wrap) return;
    const s = this.settings;
    const sty = this._xrayStyles().indexOf(s.xrayStyle) >= 0 ? s.xrayStyle : 'stripes';
    const names = { stripes:'Diagonal stripes', scanlines:'Scanlines', hatch:'Cross-hatch',
                    dots:'Dotted grid', solid:'Solid silhouette', pulse:'Travelling pulse' };
    const op = Math.round((s.xrayOpacity != null ? s.xrayOpacity : 0.92) * 100);

    wrap.innerHTML = `
      <label style="margin-top:0">
        <input type="checkbox" id="xray-on" ${s.xrayEnabled !== false ? 'checked' : ''}>
        Show hidden tank parts
        <span style="color:var(--muted);font-size:11px">(white stripes over whatever is in front)</span>
      </label>
      <label>Hidden-part opacity: <span id="xray-op-val">${op}%</span></label>
      <input type="range" id="xray-op" min="0" max="100" value="${op}"${s.xrayEnabled === false ? ' disabled' : ''}>
      <label>Hidden-part color</label>
      <input type="color" id="xray-color" value="${s.xrayColor || '#ffffff'}"${s.xrayEnabled === false ? ' disabled' : ''}>
      <label style="margin-top:18px">Which tank</label>
      <div style="color:var(--muted);font-size:11px;line-height:1.6">Always your own, and nothing else on the field. The camera is bolted to your tank, so its turret and gun barrel hide parts of your own hull — those parts are what gets the stripes. Teammates and enemies are never striped.</div>
      <label style="margin-top:18px">Hidden-part pattern</label>
      <button type="button" class="aim-styles-btn" id="xray-styles-btn" aria-expanded="false">Patterns ▾</button>
      <div class="aim-styles-panel" id="xray-styles-panel" hidden>
        ${this._xrayStyles().map(id => `
          <div class="aim-style-card${sty === id ? ' active' : ''}" data-xraystyle="${id}">
            <canvas class="aim-style-canvas"></canvas><span class="aim-style-name">${names[id] || id}</span>
          </div>`).join('')}
      </div>`;

    const commit = () => { saveSettings(this.settings); if(this.game && this.game.applySettings) this.game.applySettings(this.settings); };
    const on = document.getElementById('xray-on');
    const opEl = document.getElementById('xray-op');
    const colEl = document.getElementById('xray-color');

    if(on) on.onchange = e => {
      this.settings.xrayEnabled = e.target.checked;
      /* Grey the controls out rather than hide them: the pattern a player has
         chosen stays visible while it is switched off, so turning it back on
         returns to exactly what they had set up. */
      [opEl, colEl].forEach(el => { if(el) el.disabled = !e.target.checked; });
      commit();
    };
    if(opEl) opEl.oninput = e => {
      this.settings.xrayOpacity = +e.target.value / 100;
      const v = document.getElementById('xray-op-val');
      if(v) v.textContent = e.target.value + '%';
      commit();
    };
    if(colEl) colEl.oninput = e => { this.settings.xrayColor = e.target.value; commit(); };

    wrap.querySelectorAll('[data-xrayscope]').forEach(el => {
      el.onclick = () => {
        wrap.querySelectorAll('[data-xrayscope]').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
        this.settings.xrayScope = el.dataset.xrayscope;
        commit();
      };
    });

    const btn = document.getElementById('xray-styles-btn');
    const panel = document.getElementById('xray-styles-panel');
    const paint = () => {
      panel.querySelectorAll('.aim-style-card').forEach(card => {
        this._drawXrayPreview(card.querySelector('canvas'), card.dataset.xraystyle, this.settings.xrayColor);
      });
    };
    if(btn && panel){
      btn.onclick = () => {
        const opening = panel.hasAttribute('hidden');
        if(opening){ panel.removeAttribute('hidden'); paint(); }
        else panel.setAttribute('hidden', '');
        btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
        btn.textContent = opening ? 'Patterns ▴' : 'Patterns ▾';
      };
      panel.querySelectorAll('[data-xraystyle]').forEach(el => {
        el.onclick = () => {
          panel.querySelectorAll('[data-xraystyle]').forEach(x => x.classList.remove('active'));
          el.classList.add('active');
          this.settings.xrayStyle = el.dataset.xraystyle;
          commit();
          /* Repaint: the preview is drawn in the player's colour, and the
             colour sits right above this panel. */
          paint();
        };
      });
      if(!panel.hasAttribute('hidden')) paint();
    }
  },

  /* Preview of one hidden-part pattern.

     The SAME arithmetic as the fragment shader in xray.js — same pitch, same
     thresholds, same branch per style — drawn straight into a canvas. A preview
     drawn any other way would be a picture of what the setting claims rather
     than of what it does, which is the one thing a preview must never be.

     The tank silhouette behind the bands is a rough blocky stand-in, not the
     real model: the card is a few hundred pixels wide and the point of it is
     the pattern, not the tank. */
  _drawXrayPreview(cv, style, color){
    if(!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(240, Math.round(cv.clientWidth || 300));
    const H = 88;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    if(!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // the wall the tank is hiding behind
    g.fillStyle = '#39414d';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.045)';
    for(let i = 0; i < W; i += 26) g.fillRect(i, 0, 13, H);

    const P = (typeof Xray !== 'undefined' && Xray && Xray.PERIOD_CSS) ? Xray.PERIOD_CSS : 17;
    const col = color || '#ffffff';

    /* A tank seen from the side, as a set of rectangles, clipped to the card.
       Same shape as the real thing's silhouette in plan: hull, track run, turret,
       barrel. */
    g.save();
    g.beginPath();
    const bw = W * 0.42, bx = W * 0.29, by = H * 0.44;
    g.rect(bx - bw * 0.5, by, bw, H * 0.26);                       // hull
    g.rect(bx - bw * 0.56, by + H * 0.02, bw * 0.12, H * 0.22);    // track
    g.rect(bx + bw * 0.44, by + H * 0.02, bw * 0.12, H * 0.22);
    g.rect(bx - bw * 0.17, by - H * 0.17, bw * 0.34, H * 0.17);    // turret
    g.rect(bx + bw * 0.17, by - H * 0.13, bw * 0.52, H * 0.055);   // barrel
    g.clip();

    const img = g.createImageData(Math.round(W), Math.round(H));
    const d = img.data;
    const rgb = [parseInt(col.slice(1, 3), 16) || 255,
                 parseInt(col.slice(3, 5), 16) || 255,
                 parseInt(col.slice(5, 7), 16) || 255];
    for(let y = 0; y < img.height; y++){
      for(let x = 0; x < img.width; x++){
        let m = 0;
        if(style === 'stripes')      m = ((x + y) / P % 1) >= 0.5 ? 1 : 0;
        else if(style === 'scanlines') m = ((y / (P * 0.55)) % 1) >= 0.5 ? 1 : 0;
        else if(style === 'hatch'){
          const a = ((x + y) / P % 1) >= 0.62 ? 1 : 0;
          const b = ((x - y) / P % 1) >= 0.62 ? 1 : 0;
          m = (a || b) ? 1 : 0;
        }
        else if(style === 'dots'){
          const gx = ((x / P) % 1) - 0.5, gy = ((y / P) % 1) - 0.5;
          m = Math.hypot(gx, gy) < 0.30 ? 1 : 0;
        }
        else if(style === 'solid')    m = 1;
        else                          m = ((x + y) / P % 1) >= 0.5 ? 1 : 0;   // pulse: still frame
        const o = (y * img.width + x) * 4;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2];
        d[o + 3] = m ? 255 : 0;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = img.width; tmp.height = img.height;
    tmp.getContext('2d').putImageData(img, 0, 0);
    g.drawImage(tmp, 0, 0, W, H);
    g.restore();
  },

  /* Static preview of one trajectory-line style, drawn the same way the real
     line is drawn (per-pixel alpha + width) so the card never lies. */
  _drawAimStylePreview(cv, style){
    if(!cv) return;
    const H = 88;
    const W = Math.max(240, Math.round(cv.clientWidth || 300));   // real box, not a guess
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); // bitmap matches the CSS box
    const g = cv.getContext('2d');
    g.setTransform(dpr,0,0,dpr,0,0);

    g.fillStyle = '#39443a'; g.fillRect(0,0,W,H);
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
    for(let i=1;i<4;i++){ const y=i*H/4; g.beginPath(); g.moveTo(0,y); g.lineTo(W,y); g.stroke(); }
    g.strokeStyle = 'rgba(0,0,0,0.16)';
    for(let i=1;i<9;i++){ const x=i*W/9; g.beginPath(); g.moveTo(x,0); g.lineTo(x,H); g.stroke(); }

    const x0 = 52, x1 = W - 20, y = Math.round(H*0.5);
    const span = x1 - x0;
    const pxPerM = span / 65;
    const x50 = x0 + span*(50/65);
    g.save(); g.setLineDash([4,5]); g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.beginPath(); g.moveTo(x50, 6); g.lineTo(x50, H-6); g.stroke(); g.restore();

    // little tank at the muzzle
    g.save(); g.translate(22, y);
    g.fillStyle = '#20242a'; g.strokeStyle = '#0d0f12'; g.lineWidth = 2;
    g.beginPath(); (g.roundRect ? g.roundRect(-20,-12,40,24,5) : g.rect(-20,-12,40,24)); g.fill(); g.stroke();
    g.fillStyle = '#2b3138'; g.beginPath(); g.arc(0,0,9,0,Math.PI*2); g.fill(); g.stroke();
    g.fillStyle = '#20242a';
    g.beginPath(); (g.roundRect ? g.roundRect(4,-3,24,6,3) : g.rect(4,-3,24,6)); g.fill(); g.stroke();
    g.restore();

    // the line itself - one screen column at a time
    const BASE_PX = { fade:4.5, breakup:4.5, taper:8, dots:6, zigzag:4.5, wedge:9, pulse:5.5 };
    const base = BASE_PX[style] || 4.5;
    const styleAt = (d) => {
      if(d < 0) return {a:1, w:1};
      if(style === 'breakup'){
        if(d <= 50) return {a:1, w:1};
        const k = Math.min(1,(d-50)/15);
        const ph = ((d-50) % 4) / 4;
        if(ph > 0.60) return {a:0, w:1};
        const soft = Math.min(1, ph/0.10, (0.60-ph)/0.10);
        return {a:(0.95 - 0.78*k*k)*soft, w: 1 - 0.5*k};
      }
      if(style === 'taper'){
        const k = Math.min(1, d/65);
        let a = 1 - 0.35*Math.pow(k,1.8);
        if(d > 50) a *= 1 - 0.30*Math.min(1,(d-50)/15);
        return {a, w: 0.10 + 0.90*Math.pow(1 - k, 1.15)};
      }
      if(style === 'dots'){
        const k = Math.min(1, d/65);
        const ph = d % 4;
        if(ph > 1.5) return {a:0, w:1};
        const soft = Math.min(1, ph/0.35, (1.5-ph)/0.35);
        let a = (1 - 0.28*k*k)*soft;
        if(d > 55) a *= 1 - 0.55*Math.min(1,(d-55)/10);
        return {a, w:1};
      }
      if(style === 'wedge'){
        const k = Math.min(1, d/65);
        let a = 1;
        if(d > 55) a = 1 - 0.45*Math.min(1,(d-55)/10);
        return {a, w: 0.14 + 0.86*Math.pow(k,0.85)};
      }
      if(style === 'pulse'){
        const wave = 34;                                    // frozen mid-travel for the still
        const gg = Math.exp(-Math.pow((d - wave)/5.5, 2));
        let a = 0.82 + 0.18*gg;
        if(d > 55) a *= 1 - 0.45*Math.min(1,(d-55)/10);
        return {a, w: 0.80 + 0.75*gg};
      }
      if(style === 'zigzag'){
        if(d <= 50) return {a:1, w:1};
        const k = Math.min(1,(d-50)/15);
        return {a: 1 - 0.85*k*k, w:1};
      }
      if(d <= 50) return {a:1, w:1};
      const k = Math.min(1,(d-50)/15);
      return {a: 1 - 0.90*k*k, w: 1 - 0.30*k};
    };
    for(let px = x0; px <= x1; px++){
      const d = ((px - x0)/span)*65;
      const st = styleAt(d);
      if(st.a <= 0.01) continue;
      const w = Math.max(1, base*st.w);
      const dy = (style === 'zigzag') ? Math.sin(d * (Math.PI/6.5)) * 1.5 * pxPerM : 0;
      g.fillStyle = 'rgba(255,255,255,' + Math.min(1,st.a).toFixed(3) + ')';
      g.fillRect(px, y - w/2 + dy, 1.1, w);
    }
    g.font = '700 11px "Segoe UI",Arial'; g.textAlign = 'right';
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText('65 m', x1, H - 6);
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillText('50 m', x50 + 4, 14);
  },

  /* Tab switching for settings */
  _wireSettingsTabs(){
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const content = document.getElementById('tab-' + tab.dataset.tab);
        if(content) content.classList.add('active');
      };
    });
  },

  /* ---------- view-range settings (opacity + color + WIDTH) ---------- */
  _renderViewSettings(){
    const wrap = document.getElementById('view-settings');
    if(!wrap) return;
    const w = Math.round(this.settings.viewRangeWidth * 100);
    wrap.innerHTML = `
      <label>View-range circle opacity: <span id="view-op-val">${Math.round(this.settings.viewRangeOpacity*100)}%</span></label>
      <input type="range" id="view-op" min="0" max="100" value="${Math.round(this.settings.viewRangeOpacity*100)}">
      <label>View-range circle color</label>
      <input type="color" id="view-color" value="${this.settings.viewRangeColor}">
      <label>View-range circle width (0% = thin ring, 100% = fat ring): <span id="view-width-val">${w}%</span></label>
      <input type="range" id="view-width" min="0" max="100" value="${w}">`;
    document.getElementById('view-op').oninput = e=>{
      this.settings.viewRangeOpacity = +e.target.value/100;
      document.getElementById('view-op-val').textContent = e.target.value+'%';
      saveSettings(this.settings); this.game.applySettings(this.settings);
    };
    document.getElementById('view-color').oninput = e=>{
      this.settings.viewRangeColor = e.target.value;
      saveSettings(this.settings); this.game.applySettings(this.settings);
    };
    document.getElementById('view-width').oninput = e=>{
      this.settings.viewRangeWidth = +e.target.value/100;
      document.getElementById('view-width-val').textContent = e.target.value+'%';
      saveSettings(this.settings); this.game.applySettings(this.settings);
    };
  },

  /* ---------- camera rotation (arrows / auto / swipe) ---------- */
  _renderCamSettings(){
    const wrap = document.getElementById('cam-settings');
    if(!wrap) return;
    const isMobile = document.body.classList.contains('is-mobile');
    if(isMobile){
      const pz = this.settings.pinchZoom !== false;
      wrap.innerHTML = `
      <label>Camera Rotation</label>
      <div class="hint">In game, use the ◀ ▶ buttons at the bottom of the screen to rotate the camera</div>
      <label style="margin-top:18px">Two-Finger Zoom</label>
      <div class="seg">
        <div class="seg-opt${pz?' active':''}" data-pinchzoom="1">On</div>
        <div class="seg-opt${pz?'':' active'}" data-pinchzoom="0">Off</div>
      </div>
      <div class="hint">Pinch with two fingers anywhere on the free screen (not on the joysticks) to zoom the camera</div>`;
      wrap.querySelectorAll('[data-pinchzoom]').forEach(el=>{
        el.onclick = ()=>{
          this.settings.pinchZoom = el.dataset.pinchzoom === '1';
          saveSettings(this.settings);
          if(this.game) this.game.applySettings(this.settings);
          this._renderCamSettings();
        };
      });
      return;
    }
    const mode = this.settings.camMode || 'arrows';
    const seg = (m, label) => `<div class="seg-opt${mode===m?' active':''}" data-cammode="${m}">${label}</div>`;
    const kL = this.settings.binds && this.settings.binds.camLeft;
    const kR = this.settings.binds && this.settings.binds.camRight;
    const rk = (l, r, label) => {
      const on = (kL === l && kR === r) || ((l === 'ArrowLeft' && !kL && !kR));
      return `<div class="seg-opt${on?' active':''}" data-camkeys="${l}">${label}</div>`;
    };
    let body = '';
    if(mode === 'arrows'){
      body = `
      <div class="cam-rotate-row">
        <span class="cam-rotate-btn" id="cam-rotate-left">←</span>
        <span class="cam-rotate-label">rotate left / right</span>
        <span class="cam-rotate-btn" id="cam-rotate-right">→</span>
      </div>
      <div class="hint">Keyboard: ArrowLeft / ArrowRight (rebindable in Controls above)</div>
      <label style="margin-top:16px">Rotation Keys</label>
      <div class="seg">
        ${rk('ArrowLeft', 'ArrowRight', '← →')}
        ${rk('KeyQ', 'KeyE', 'Q / E')}
        ${rk('KeyA', 'KeyD', 'A / D')}
      </div>
      <div class="hint">Choose which keys rotate the camera (your custom binds are overridden by this preset)</div>
      <label style="margin-top:16px">Invert Rotation Direction</label>
      <div class="seg">
        <div class="seg-opt${this.settings.invertCamRot?' active':''}" data-invcam="1">On</div>
        <div class="seg-opt${this.settings.invertCamRot?'':' active'}" data-invcam="0">Off</div>
      </div>
      <div class="hint">Swap the direction: Left rotates right, Right rotates left</div>`;
    } else if(mode === 'auto'){
      body = `<div class="hint">The camera always stays behind your tank hull — it rotates automatically, no input needed</div>`;
    } else {
      body = `<div class="hint">Swipe with one finger to rotate the camera (e.g. swipe right → left rotates the camera right) — on desktop: hold the mouse button and drag</div>`;
    }
    wrap.innerHTML = `
      <label>Camera Rotation</label>
      <div class="seg">
        ${seg('arrows','Arrows')}
        ${seg('auto','Auto')}
        ${seg('swipe','Swipe')}
      </div>` + body;
    const wrapAngle = (a) => ((a % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
    const btnL = document.getElementById('cam-rotate-left');
    const btnR = document.getElementById('cam-rotate-right');
    if(btnL) btnL.onclick = ()=>{
      this.settings.camRotation = wrapAngle((this.settings.camRotation || 0) - Math.PI/4);
      saveSettings(this.settings);
      if(this.game) this.game.applySettings(this.settings);
    };
    if(btnR) btnR.onclick = ()=>{
      this.settings.camRotation = wrapAngle((this.settings.camRotation || 0) + Math.PI/4);
      saveSettings(this.settings);
      if(this.game) this.game.applySettings(this.settings);
    };
    wrap.querySelectorAll('[data-cammode]').forEach(el=>{
      el.onclick = ()=>{
        this.settings.camMode = el.dataset.cammode;
        saveSettings(this.settings);
        if(this.game) this.game.applySettings(this.settings);
        this._renderCamSettings();
      };
    });
    wrap.querySelectorAll('[data-camkeys]').forEach(el=>{
      el.onclick = ()=>{
        const map = { 'ArrowLeft':['ArrowLeft','ArrowRight'], 'KeyQ':['KeyQ','KeyE'], 'KeyA':['KeyA','KeyD'] };
        const pair = map[el.dataset.camkeys];
        if(!pair) return;
        this.settings.binds = Object.assign({}, this.settings.binds);
        this.settings.binds.camLeft = pair[0];
        this.settings.binds.camRight = pair[1];
        saveSettings(this.settings);
        if(this.game) this.game.applySettings(this.settings);
        this._renderBinds();
        this._renderCamSettings();
      };
    });
    wrap.querySelectorAll('[data-invcam]').forEach(el=>{
      el.onclick = ()=>{
        wrap.querySelectorAll('[data-invcam]').forEach(x=>x.classList.remove('active'));
        el.classList.add('active');
        this.settings.invertCamRot = el.dataset.invcam === '1';
        saveSettings(this.settings);
        if(this.game) this.game.applySettings(this.settings);
      };
    });
  },

  /* ---------- camera behavior (Dynamic / Automatic / Hull Follow / Arrows / Swipe) ---------- */
  _renderCameraSettings(){
    const wrap = document.getElementById('camera-settings');
    if(!wrap) return;
    const camBehavior = this.settings.cameraMode || 'dynamic';
    const seg = (m, label) => `<div class="seg-opt${camBehavior===m?' active':''}" data-cammode="${m}">${label}</div>`;
    wrap.innerHTML = `
      <label>Camera Behavior</label>
      <div class="seg" style="display:grid; grid-template-columns:repeat(3,1fr); gap:4px;">
        ${seg('dynamic','Dynamic')}
        ${seg('automatic','Auto (Turret)')}
        ${seg('hull','Auto (Hull)')}
        ${seg('arrows','Manual (Arrows)')}
        ${seg('swipe','Swipe')}
      </div>
      <div class="hint" id="camera-hint"></div>
      <label style="margin-top:16px">Invert Rotation Direction</label>
      <div class="seg">
        <div class="seg-opt${this.settings.invertCamRot?' active':''}" data-invcam="1">On</div>
        <div class="seg-opt${this.settings.invertCamRot?'':' active'}" data-invcam="0">Off</div>
      </div>
      <div class="hint">Swap the direction: Left rotates right, Right rotates left</div>
      <label style="margin-top:16px">Mouse Rotate (No LMB)</label>
      <div class="seg">
        <div class="seg-opt${this.settings.cameraMouseRotate?' active':''}" data-mouserot="1">On</div>
        <div class="seg-opt${this.settings.cameraMouseRotate?'':' active'}" data-mouserot="0">Off</div>
      </div>
      <div class="hint">Rotate camera by moving mouse cursor without holding LMB</div>`;
    
    const hints = {
      dynamic: 'Tanki Online style: mouse rotates camera, turret aims where crosshair points. Scroll to zoom. >=35 = Top-Down.',
      automatic: 'When zoomed in (20°–30°), camera smoothly follows turret. Otherwise manual.',
      hull: 'Camera always stays behind tank hull (follows hull rotation).',
      arrows: 'Use arrow keys (or rebound keys) to rotate camera manually.',
      swipe: 'Swipe/drag to rotate camera. On desktop: hold mouse button and drag.'
    };
    
    wrap.querySelectorAll('[data-cammode]').forEach(el=>{
      el.onclick = ()=>{
        this.settings.cameraMode = el.dataset.cammode;
        // Also update legacy camMode for compatibility
        if(el.dataset.cammode === 'hull') this.settings.camMode = 'auto';
        else if(el.dataset.cammode === 'arrows') this.settings.camMode = 'arrows';
        else if(el.dataset.cammode === 'swipe') this.settings.camMode = 'swipe';
        else this.settings.camMode = 'arrows';
        saveSettings(this.settings);
        if(this.game) this.game.applySettings(this.settings);
        this._renderCameraSettings();
        this._renderCamSettings();
      };
    });
    
    wrap.querySelectorAll('[data-invcam]').forEach(el=>{
      el.onclick = ()=>{
        wrap.querySelectorAll('[data-invcam]').forEach(x=>x.classList.remove('active'));
        el.classList.add('active');
        this.settings.invertCamRot = el.dataset.invcam === '1';
        saveSettings(this.settings);
        if(this.game) this.game.applySettings(this.settings);
      };
    });
    
    wrap.querySelectorAll('[data-mouserot]').forEach(el=>{
      el.onclick = ()=>{
        wrap.querySelectorAll('[data-mouserot]').forEach(x=>x.classList.remove('active'));
        el.classList.add('active');
        this.settings.cameraMouseRotate = el.dataset.mouserot === '1';
        saveSettings(this.settings);
        if(this.game) this.game.applySettings(this.settings);
        this._renderCameraSettings();
      };
    });
    
    const hintEl = document.getElementById('camera-hint');
    if(hintEl) hintEl.textContent = hints[camBehavior] || '';
  },

  /* ---------- graphics quality ---------- */
  _renderGraphicsSettings(){
    const wrap = document.getElementById('graphics-settings');
    if(!wrap) return;
    const q = this.settings.graphicsQuality || 'default';
    wrap.innerHTML = `
      <label>Graphics Quality</label>
      <div class="seg">
        <div class="seg-opt${q==='default'?' active':''}" data-gfx="default">Default</div>
        <div class="seg-opt${q==='fancy'?' active':''}" data-gfx="fancy">Fancy</div>
        <div class="seg-opt${q==='ultra'?' active':''}" data-gfx="ultra">Ultra</div>
      </div>
      <div class="hint">Fancy enables ground shadows &amp; longer view distance.<br>
        <b>Ultra</b> turns on the full particle set, the shader fireball, the biggest muzzle flash and
        dense bullet trails, at the sharpest resolution. Ultra is very recommended to run with
        <b>WebGPU</b> (Settings &rarr; Other), which handles it best.</div>`;
    wrap.querySelectorAll('[data-gfx]').forEach(el=>{
      el.onclick = ()=>{
        const pick = el.dataset.gfx;
        wrap.querySelectorAll('[data-gfx]').forEach(x=>x.classList.remove('active'));
        el.classList.add('active');
        this.settings.graphicsQuality = pick;
        saveSettings(this.settings);
        if(this.game) this.game.applySettings(this.settings);
        if(pick === 'ultra'){
          const gpu = window._game ? !!window._game._webgpuAvailable : !!(navigator && navigator.gpu);
          const msg = 'ULTRA graphics is very recommended — your device runs it very well with ' +
            (gpu ? 'WebGPU.' : 'WebGL 2 (this device reports no WebGPU support, so Ultra will still work).') +
            '\n\nUltra needs the game to reload before it takes effect. Reload now?';
          if(confirm(msg)) location.reload();
        }
      };
    });
  },

  /* ---------- other settings (screen shake / muzzle FX / FPS) ---------- */
  _renderOtherSettings(){
    const wrap = document.getElementById('other-settings');
    if(!wrap) return;
    const camSen = Math.round(this.settings.cameraSensitivity != null ? this.settings.cameraSensitivity : 100);
    const sh = Math.round(this.settings.screenShake != null ? this.settings.screenShake : 100);
    const mf = this.settings.muzzleFx !== false;
    const sf = !!this.settings.showFps;
    const nm = localStorage.getItem('nightMode') === '1';
    const nmi = localStorage.getItem('nightModeStrong') === '1';
    // Graphics backend: what is running, and whether this device can do WebGPU.
    const rb = ['auto','webgpu','webgl2'].indexOf(this.settings.rendererBackend) >= 0 ? this.settings.rendererBackend : 'auto';
    const gpuOk = !!(window._game ? window._game._webgpuAvailable : (typeof navigator !== 'undefined' && navigator.gpu));
    const curBackend = (window._game && window._game._backend) ? window._game._backend : 'not started yet';
    wrap.innerHTML = `
      <label>Camera sensitivity: <span id="camsen-val">${camSen}%</span></label>
      <input type="range" id="camsen-op" min="10" max="300" value="${camSen}">
      <label style="margin-top:18px">Screen shake strength: <span id="shake-val">${sh}%</span></label>
      <input type="range" id="shake-op" min="0" max="100" value="${sh}">
      <label style="margin-top:18px">Muzzle effects (flash &amp; smoke)</label>
      <div class="seg">
        <div class="seg-opt${mf?' active':''}" data-muzzle="1">On</div>
        <div class="seg-opt${mf?'':' active'}" data-muzzle="0">Off</div>
      </div>
      <label style="margin-top:18px">Night mode</label>
      <div class="seg">
        <div class="seg-opt${nm?' active':''}" data-night="1">On</div>
        <div class="seg-opt${nm?'':' active'}" data-night="0">Off</div>
      </div>
      <div id="night-intensity-wrap" style="margin-top:12px;${nm?'':'display:none'}">
        <label>Night intensity</label>
        <div class="seg">
          <div class="seg-opt${!nmi?' active':''}" data-nightstr="0">Weak</div>
          <div class="seg-opt${nmi?' active':''}" data-nightstr="1">Strong</div>
        </div>
      </div>
      <label style="margin-top:18px">FPS counter</label>
      <div class="seg">
        <div class="seg-opt${sf?' active':''}" data-fps="1">On</div>
        <div class="seg-opt${sf?'':' active'}" data-fps="0">Off</div>
      </div>
      <div class="hint">Shows frames per second in the top-right corner during a match</div>
      <label style="margin-top:18px">Graphics backend</label>
      <div class="seg">
        <div class="seg-opt${rb==='auto'?' active':''}" data-backend="auto">Auto</div>
        <div class="seg-opt${rb==='webgpu'?' active':''}" data-backend="webgpu"${gpuOk?'':' style="opacity:.45"'}>WebGPU</div>
        <div class="seg-opt${rb==='webgl2'?' active':''}" data-backend="webgl2">WebGL 2</div>
      </div>
      <div class="hint">Auto uses WebGPU when this device really supports it, and WebGL 2 when it does not.
        ${gpuOk?'':'This browser/device reports no WebGPU support, so WebGL 2 will be used either way.'}
        Running now: <b>${curBackend}</b>. A new choice is used the next time the game loads.</div>`;
    document.getElementById('camsen-op').oninput = e=>{
      this.settings.cameraSensitivity = +e.target.value;
      document.getElementById('camsen-val').textContent = e.target.value+'%';
      saveSettings(this.settings);
      if(this.game) this.game.applySettings(this.settings);
    };
    document.getElementById('shake-op').oninput = e=>{
      this.settings.screenShake = +e.target.value;
      document.getElementById('shake-val').textContent = e.target.value+'%';
      saveSettings(this.settings);
      if(this.game) this.game.applySettings(this.settings);
    };
    wrap.querySelectorAll('[data-muzzle]').forEach(el=>{
      el.onclick = ()=>{
        this.settings.muzzleFx = el.dataset.muzzle === '1';
        saveSettings(this.settings);
        if(this.game) this.game.applySettings(this.settings);
        this._renderOtherSettings();
      };
    });
    wrap.querySelectorAll('[data-night]').forEach(el=>{
      el.onclick = ()=>{
        const on = el.dataset.night === '1';
        localStorage.setItem('nightMode', on ? '1' : '0');
        document.body.classList.toggle('night', on);
        const iw = document.getElementById('night-intensity-wrap');
        if(iw) iw.style.display = on ? '' : 'none';
        if(!on) document.body.classList.remove('strong');
        Audio.click();
        this._renderOtherSettings();
      };
    });
    wrap.querySelectorAll('[data-nightstr]').forEach(el=>{
      el.onclick = ()=>{
        const strong = el.dataset.nightstr === '1';
        localStorage.setItem('nightModeStrong', strong ? '1' : '0');
        document.body.classList.toggle('strong', strong);
        Audio.click();
        this._renderOtherSettings();
      };
    });
    wrap.querySelectorAll('[data-fps]').forEach(el=>{
      el.onclick = ()=>{
        this.settings.showFps = el.dataset.fps === '1';
        saveSettings(this.settings);
        if(this.game) this.game.applySettings(this.settings);
        this._renderOtherSettings();
      };
    });
    wrap.querySelectorAll('[data-backend]').forEach(el=>{
      el.onclick = ()=>{
        this.settings.rendererBackend = el.dataset.backend;
        saveSettings(this.settings);
        Audio.click();
        this._renderOtherSettings();
      };
    });
  },

  /* ---------- collections ---------- */
  /* THIS LIST IS THE COLLECTIONS MENU. It is written out by hand, so a tank
     added to TANKS and TANK_ORDER does NOT appear here on its own — it has to
     be placed in a row or the garage is simply missing it, with no error and
     nothing in the console to explain why. That is exactly what happened to the
     Mortar: it was fully playable, fully in the roster, and invisible.

     If you add a tank, add it here too. Collection 3 is the heavy/artillery
     line, which is where the Mortar belongs. */
  _COLLECTIONS: [
    { id: 1, tanks: ['coolbuddy','demolisher','predator',null,'grom'] },
    { id: 2, tanks: ['helix','striker','double','burst',null] },
    { id: 3, tanks: ['ghost','sturmratte','mortar',null,null] },
  ],

  _loadCollectionsFromStorage(){
    try {
      const raw = localStorage.getItem('tankparty_collections');
      if(raw){
        const saved = JSON.parse(raw);
        if(Array.isArray(saved) && saved.length === 3){
          /* MERGE, do not replace.
             This key is only ever written by the collection editor, so anyone
             who has ever opened it has a saved layout — and a plain assignment
             would silently hide every tank added to the game since they last
             opened the editor, with no way to get it back short of clearing
             localStorage by hand.

             So the saved layout wins wherever it has an opinion (a slot it
             actually filled), and any tank from the built-in list that is
             missing from it gets put back into the first genuinely empty slot
             of its own collection. Their arrangement survives; new tanks still
             turn up. */
          const built = this._COLLECTIONS.map(c => c.tanks.filter(t => t));
          const home = new Map();
          built.forEach((list, ci) => list.forEach(id => { if(!home.has(id)) home.set(id, ci); }));
          this._COLLECTIONS = this._COLLECTIONS.map((defCol, ci) => {
            const src = Array.isArray(saved[ci] && saved[ci].tanks) ? saved[ci].tanks : defCol.tanks;
            const merged = src.slice();
            /* A tank only counts as placed if it is in the collection it
               BELONGS to. Anything else in a saved layout is either a duplicate
               or a leftover, and it is dropped rather than honoured — because
               honouring it is what let one tank appear in three collections at
               once and pushed a real tank out of the menu entirely.

               Consequence worth knowing: the collection editor can no longer
               move a tank to a DIFFERENT collection and have it stick. Tanks
               live in the collection declared above. */
            const placed = new Set();
            merged.forEach((t, i) => {
              if(t && home.get(t) === ci) placed.add(t);
              else merged[i] = null;
            });
            /* Anything that belongs here and is not placed goes in a free slot. */
            built[ci].forEach(id => {
              if(placed.has(id)) return;
              const slot = merged.indexOf(null);
              if(slot >= 0) merged[slot] = id;
              else if(merged.length < 5) merged.push(id);
              placed.add(id);
            });
            return { id: (saved[ci] && saved[ci].id) || defCol.id, tanks: merged };
          });
        }
      }
    } catch(e){}
  },

  _renderCollections(){
    const track = document.getElementById('collections-track');
    if(!track) return;
    track.innerHTML = '';
    const isUnlocked = (id) => id && (this.settings.allUnlocked || (this.settings.unlockedTanks||[]).includes(id));
    const isTankSelected = (id) => id && this.settings.selectedTank === id;

    this._COLLECTIONS.forEach((col, ci) => {
      if(ci > 0){
        const lockDiv = document.createElement('div');
        lockDiv.className = 'collection-lock';
        const allOwned = col.tanks.every(t => isUnlocked(t));
        if(allOwned) lockDiv.classList.add('open');
        lockDiv.innerHTML = `<div class="lock-big">${allOwned ? '&#x1F513;' : '&#x1F512;'}</div><div class="lock-text">${allOwned ? 'Unlocked' : 'Locked'}</div>`;
        track.appendChild(lockDiv);
      }

      const card = document.createElement('div');
      card.className = 'collection-card';

      const label = document.createElement('div');
      label.className = 'collection-label';
      label.textContent = col.id + ' Collection';
      card.appendChild(label);

      const topRow = document.createElement('div');
      topRow.className = 'tank-row row-top';
      const botRow = document.createElement('div');
      botRow.className = 'tank-row row-bot';

      col.tanks.forEach((tankId, ti) => {
        const slot = document.createElement('div');
        slot.className = 'tank-slot';
        if(tankId && isUnlocked(tankId)){
          slot.classList.add('unlocked');
          if(isTankSelected(tankId)) slot.classList.add('selected');
        } else if(!tankId || !isUnlocked(tankId)){
          if(!tankId) slot.classList.add('locked');
        }

        if(tankId && isUnlocked(tankId)){
          const t = TANKS[tankId];
          if(t){
            const bodyColor = '#' + t.color.toString(16).padStart(6,'0');
            const turtColor = '#' + t.turretColor.toString(16).padStart(6,'0');
            slot.innerHTML = `<div class="tank-slot-body" style="background:${bodyColor}"></div><div class="tank-slot-turret" style="background:${turtColor}"></div><div class="tank-slot-barrel" style="background:#2a2a2e"></div><div class="tank-name">${t.name}</div>`;
          }
        } else if(!tankId){
          slot.classList.add('locked');
          slot.innerHTML = `<div class="lock-icon">&#x1F512;</div><div class="tank-name">Coming Soon</div>`;
        } else {
          slot.classList.add('locked');
          slot.innerHTML = `<div class="lock-icon">&#x1F512;</div><div class="tank-name">Locked</div>`;
        }

        slot.addEventListener('click', ()=>{
          if(tankId && isUnlocked(tankId)){
            this.show('menu-tank');
            if(window.TankMenu) TankMenu.show(tankId);
          } else if(!tankId){
            this.toast('Coming Soon!');
          } else {
            this.toast('Tank locked! Play to unlock.');
          }
        });

        if(ti < 3) topRow.appendChild(slot);
        else botRow.appendChild(slot);
      });

      card.appendChild(topRow);
      card.appendChild(botRow);
      track.appendChild(card);
    });

    // LMB drag scroll + MMB fast scroll
    const scroll = document.getElementById('collections-scroll');
    if(scroll && !scroll._dragWired){
      scroll._dragWired = true;
      let dragging = false, dragX = 0, scrollLeft = 0, fastMode = false;
      scroll.addEventListener('mousedown', (e)=>{
        if(e.button === 0 || e.button === 1){
          e.preventDefault();
          dragging = true;
          fastMode = (e.button === 1);
          dragX = e.clientX;
          scrollLeft = scroll.scrollLeft;
          scroll.style.cursor = 'grabbing';
        }
      });
      window.addEventListener('mousemove', (e)=>{
        if(!dragging) return;
        const dx = e.clientX - dragX;
        const speed = fastMode ? 3 : 1;
        scroll.scrollLeft = scrollLeft - dx * speed;
      });
      window.addEventListener('mouseup', ()=>{
        dragging = false;
        fastMode = false;
        if(scroll) scroll.style.cursor = '';
      });
      scroll.addEventListener('wheel', (e)=>{
        e.preventDefault();
        scroll.scrollLeft += e.deltaY * 2;
      }, {passive: false});
    }
  },

  showConnecting(msg){ document.getElementById('connecting').querySelector('h2').textContent = msg||'Connecting…';
    document.getElementById('connecting').classList.remove('hidden'); },
  hideConnecting(){ document.getElementById('connecting').classList.add('hidden'); },

  /* ---------- Codes ---------- */
  _wireCodes(){
    const input = document.getElementById('codes-input');
    const btn = document.getElementById('btn-redeem-code');
    if(!btn) return;
    btn.onclick = ()=>{
      const code = input.value.trim();
      if(code === 'ghadwg3u23989syf9ewnasduiuwghda'){
        this.toast('Code redeemed! Opening Menu Editor...');
        MenuEditor.open();
      } else if(code === 'editor123'){
        console.log('editor123: typeof Editor123 =', typeof Editor123);
        if(typeof Editor123 === 'undefined' || !Editor123.open){
          this.toast('Error: Editor123 not loaded. Check console.');
          return;
        }
        this.toast('Code redeemed! Opening Editor Suite...');
        try { Editor123.open(); } catch(e){ console.error(e); this.toast('Error: '+e.message); }
      } else if(code === 'op321'){
        this.settings.allUnlocked = true;
        this.settings.unlockedTanks = Array.from(new Set([...(this.settings.unlockedTanks||[]), 'demolisher', 'predator', 'double', 'burst', 'grom', 'coolbuddy', 'striker', 'ghost', 'sturmratte', 'helix', 'mortar']));
        saveSettings(this.settings);
        this.toast('All tanks unlocked!');
        setTimeout(() => this._renderCollections(), 50);
      } else if(code === 'reset1'){
        this.settings = resetSettings();
        this.toast('Progress reset!');
        this.show('menu-main');
      } else if(code === 'revertmap'){
        this._revertMap();
      } else if(code.toLowerCase() === 'box999'){
        // Bonus code — grant 50 boxes through the normal storage path so they
        // show up in the crate grid exactly like earned boxes do.
        input.value = '';
        for(var bi = 0; bi < 50; bi++) addClanItem('box', { source:'code', code:'box999' });
        this._initStorageGrid();
        this._updateCurrencies();
        this.toast('Bonus code redeemed — 50 Boxes added!');
      } else if(code.toLowerCase() === 'garage'){
        input.value = '';
        this.toggleMainPreviewMode();
      } else if(code.toLowerCase() === 'fc'){
        input.value = '';
        if(window.Garage && Garage.active){
          const on = Garage.freecam();
          this.toast(on ? 'Freecam ON — WASD/arrows move, drag look, wheel speed, ESC exit' : 'Freecam OFF');
        }else if(window.Garage){
          this.toast('Opening the garage… type fc again');
          this._startMainPreview();
        }else{
          this.toast('Freecam unavailable');
        }
      } else if(code === '/code'){
        // Handle clan code command
        if(this._handleCodeCommand(code)){
          input.value = '';
        }
      } else {
        this.toast('Invalid code');
      }
    };
    input.onkeydown = (e)=>{
      if(e.code==='Enter') btn.click();
    };
    // Revert map button
    const revertBtn = document.getElementById('btn-revert-map');
    if(revertBtn){
      revertBtn.onclick = ()=>{ this._revertMap(); };
      this._refreshRevertBtn(revertBtn);
    }
  },
  _revertMap(){
    if(!hasMainMap()){
      this.toast('No saved main map to revert.');
      return;
    }
    clearMainMap();
    this.toast('Main map reverted to original!');
    const revertBtn = document.getElementById('btn-revert-map');
    if(revertBtn) revertBtn.style.display = 'none';
  },
  _refreshRevertBtn(el){
    el.style.display = hasMainMap() ? '' : 'none';
  },

  /* ---------- storage ---------- */
  _checkWeeklyReset(){
    const s = Menu.settings;
    const wk = getWeekKey();
    if(s.clanWeekKey && s.clanWeekKey !== wk){
      checkClanWeeklyBox(s.clanWeekKey);
      s.clanWeeklyXP = 0;
      s.clanWeekKey = wk;
      s.clanWeeklyRewarded = false;
      s.clanWeekWins = 0;
      s.clanWeekWinsBonus = false;
      s.clanWeekLoginXP = 0;
      saveSettings(s);
    }
  },
  /* Daily login Clan XP: once per day while in a clan (100/day, 700/week cap,
     TL+ subscribers earn 300/day). */
  _checkDailyClanXP(){
    const s = Menu.settings;
    if(!isInClan()) return;
    const day = Math.floor(Date.now() / 86400000);
    if(s.clanLastLoginDay === day) return;
    s.clanLastLoginDay = day;
    const wk = getWeekKey();
    if(s.clanWeekKey !== wk){
      checkClanWeeklyBox(s.clanWeekKey);
      s.clanWeeklyXP = 0;
      s.clanWeekKey = wk;
      s.clanWeeklyRewarded = false;
      s.clanWeekWins = 0;
      s.clanWeekWinsBonus = false;
      s.clanWeekLoginXP = 0;
    }
    const daily = s.tlPlus ? CLAN_TLPLUS_DAILY : CLAN_LOGIN_DAILY;
    const amt = Math.min(daily, CLAN_LOGIN_WEEK_CAP - (s.clanWeekLoginXP || 0));
    if(amt > 0){
      s.clanWeekLoginXP = (s.clanWeekLoginXP || 0) + amt;
      saveSettings(s);
      addClanXP(amt);
      this.toast('+' + amt + ' daily Clan XP' + (s.tlPlus ? ' (TL+ bonus!)' : ''));
    }
  },
  _initStorageGrid(){
    const grid = document.getElementById('storage-grid');
    if(!grid) return;
    grid.innerHTML = '';
    const items = loadClanStorage();
    const boxes = items.filter(it => it.type === 'box');
    const others = items.filter(it => it.type !== 'box');
    if(boxes.length > 0){
      const slot = document.createElement('div');
      slot.className = 'storage-slot';
      slot.style.position = 'relative';
      slot.style.color = '#ffb12b';
      slot.style.fontSize = '28px';
      slot.style.border = '2px solid rgba(255,177,43,0.3)';
      slot.style.cursor = 'pointer';
      slot.title = boxes.length + ' box' + (boxes.length > 1 ? 'es' : '') + ' — click to open';
      slot.innerHTML = '';
      const boxImg = document.createElement('img');
      boxImg.src = 'assets/crate_icon.png';
      boxImg.style.cssText = 'width:60%;height:60%;object-fit:contain;pointer-events:none;';
      boxImg.onerror = function(){ slot.textContent = '\u{1F4E6}'; };
      slot.appendChild(boxImg);
      const badge = document.createElement('div');
      badge.style.cssText = 'position:absolute;bottom:3px;right:4px;font-size:13px;font-weight:bold;color:#fff;background:rgba(0,0,0,0.8);border:1px solid rgba(255,177,43,0.5);border-radius:8px;padding:2px 6px;line-height:1.2;pointer-events:none;font-family:Arial,sans-serif;';
      badge.textContent = 'x' + boxes.length;
      slot.appendChild(badge);
      slot.addEventListener('click', ()=> this._openBox());
      slot.addEventListener('mousedown', ()=> { this._holdTimer = setTimeout(()=> this._holdOpen = true, 400); });
      slot.addEventListener('mouseup', ()=> { clearTimeout(this._holdTimer); this._holdOpen = false; });
      slot.addEventListener('mouseleave', ()=> { clearTimeout(this._holdTimer); this._holdOpen = false; });
      slot.addEventListener('touchstart', ()=> { this._holdTimer = setTimeout(()=> this._holdOpen = true, 400); }, {passive:true});
      slot.addEventListener('touchend', ()=> { clearTimeout(this._holdTimer); this._holdOpen = false; });
      grid.appendChild(slot);
    }
    for(let i = 0; i < others.length; i++){
      const slot = document.createElement('div');
      slot.className = 'storage-slot';
      slot.style.color = '#ffb12b';
      slot.style.fontSize = '14px';
      slot.style.border = '2px solid rgba(255,177,43,0.3)';
      slot.textContent = others[i].type;
      grid.appendChild(slot);
    }
    for(let i = boxes.length + others.length; i < 48; i++){
      const slot = document.createElement('div');
      slot.className = 'storage-slot';
      slot.title = 'Empty slot';
      grid.appendChild(slot);
    }
  },
  _preloadCrateVideo(){
    if(this._crateVidPreloaded) return;
    this._crateVidPreloaded = true;
    try {
      var v = document.createElement('video');
      v.preload = 'auto';
      v.muted = true;
      v.playsInline = true;
      v.src = 'assets/crate_opening.mp4';
      v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;top:-9999px;';
      document.body.appendChild(v);
      window._preloadedCrateVid = v;
    } catch(e){}
  },
  _cleanupBoxOverlay(){
    if(this._boxInfoEsc){
      document.removeEventListener('keydown', this._boxInfoEsc, true);
      this._boxInfoEsc = null;
    }
    var old = document.getElementById('box-overlay');
    if(old){
      var vid = old.querySelector('video');
      if(vid && vid !== window._preloadedCrateVid){
        vid.pause();
        vid.removeAttribute('src');
        vid.load();
      } else if(vid === window._preloadedCrateVid){
        vid.pause();
        vid.currentTime = 0;
        vid.onended = null;
        vid.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;top:-9999px;';
        document.body.appendChild(vid);
      }
      old.remove();
    }
    this._boxOpening = false;
  },
  _openBox(count){
    count = count || 1;
    if(this._boxOpening) return;
    this._boxOpening = true;
    this._cleanupBoxOverlay();
    var items = loadClanStorage();
    var totalBoxes = items.filter(function(it){ return it.type === 'box'; }).length;
    if(totalBoxes <= 0){ this._boxOpening = false; return; }
    if(count > totalBoxes) count = totalBoxes;
    for(var i = 0; i < count; i++){
      var idx = items.findIndex(function(it){ return it.type === 'box'; });
      if(idx !== -1) removeClanItem(idx);
    }

    var isBulk = count > 1;
    var bulkMult = isBulk ? Math.min(3, 1 + Math.log2(count) * 0.3) : 1;
    var rolls = [];
    for(var ri = 0; ri < count; ri++){
      var rw = Menu._rollBoxReward();
      var baseAmt = rw.amounts[Math.floor(Math.random()*rw.amounts.length)];
      rolls.push({ name:rw.name, icon:rw.icon, amount:Math.round(baseAmt * bulkMult), key:rw.key });
    }

    var self = this;
    var overlay = document.createElement('div');
    overlay.id = 'box-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:rgba(0,0,0,0.95);display:flex;align-items:center;justify-content:center;flex-direction:column;';
    document.body.appendChild(overlay);

    var vid = null;
    if(window._preloadedCrateVid){
      vid = window._preloadedCrateVid;
      vid.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;z-index:1;';
      overlay.appendChild(vid);
    }

    var rewardDiv = document.createElement('div');
    rewardDiv.style.cssText = 'position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;gap:16px;opacity:0;transition:opacity 0.5s ease, filter 0.4s ease;';

    var title = document.createElement('div');
    title.textContent = isBulk ? (count + ' Boxes Opened!') : 'Congratulations!';
    title.style.cssText = 'font-size:' + (isBulk ? '32px' : '38px') + ';font-weight:bold;color:#ffb12b;letter-spacing:2px;';
    rewardDiv.appendChild(title);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:row;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;';

    if(isBulk){
      var totals = {};
      for(var ti = 0; ti < rolls.length; ti++){
        var rr = rolls[ti];
        if(!totals[rr.key]) totals[rr.key] = {name:rr.name, icon:rr.icon, amount:0, count:0};
        totals[rr.key].amount += rr.amount;
        totals[rr.key].count++;
      }
      var tArr = Object.values(totals);
      for(var tj = 0; tj < tArr.length; tj++){
        var t = tArr[tj];
        var card = document.createElement('div');
        card.style.cssText = 'text-align:center;';
        card.innerHTML = '<div style="width:110px;height:110px;border:3px solid #ffb12b;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,177,43,0.08);gap:2px;margin:0 auto;"><img src="' + t.icon + '" style="width:44px;height:44px;" loading="eager"><div style="font-size:20px;font-weight:bold;color:#ffb12b;">+' + t.amount.toLocaleString() + '</div></div><div style="font-size:13px;color:#aaa;margin-top:6px;">' + t.name + ' x' + t.count + '</div>';
        row.appendChild(card);
      }
    } else {
      var single = rolls[0];
      var card2 = document.createElement('div');
      card2.style.cssText = 'text-align:center;';
      card2.innerHTML = '<div style="width:110px;height:110px;border:3px solid #ffb12b;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,177,43,0.08);gap:2px;"><img src="' + single.icon + '" style="width:44px;height:44px;" loading="eager"><div style="font-size:20px;font-weight:bold;color:#fff;">+' + single.amount.toLocaleString() + '</div></div><div style="font-size:13px;color:#aaa;margin-top:6px;">' + single.name + '</div>';
      row.appendChild(card2);
    }
    rewardDiv.appendChild(row);
    overlay.appendChild(rewardDiv);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'position:relative;z-index:2;display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;justify-content:center;opacity:0;transition:opacity 0.4s ease, filter 0.4s ease;';

    var claimBtn = document.createElement('div');
    claimBtn.style.cssText = 'padding:12px 36px;background:linear-gradient(135deg,#ffb12b,#e6951a);color:#1a1a1a;font-size:16px;font-weight:bold;border-radius:25px;cursor:pointer;font-family:Arial,sans-serif;letter-spacing:1px;';
    claimBtn.textContent = 'CLAIM';
    btnRow.appendChild(claimBtn);

    var remaining = loadClanStorage().filter(function(it){ return it.type === 'box'; }).length;
    var openOpts = [];
    if(remaining >= 3) openOpts.push({label:'Open 3x', val:3});
    if(remaining >= 5) openOpts.push({label:'Open 5x', val:5});
    if(remaining >= 10) openOpts.push({label:'Open 10x', val:10});
    if(remaining > 1) openOpts.push({label:'Open All (' + remaining + ')', val:remaining});
    for(var oi = 0; oi < openOpts.length; oi++){
      (function(opt){
        var b = document.createElement('div');
        b.style.cssText = 'padding:10px 18px;background:rgba(255,255,255,0.1);border:2px solid rgba(255,255,255,0.25);border-radius:20px;color:#fff;font-size:13px;font-weight:bold;cursor:pointer;font-family:Arial,sans-serif;';
        b.textContent = opt.label;
        b.addEventListener('click', function(){
          self._holdOpen = false;
          self._cleanupBoxOverlay();
          self._openBox(opt.val);
        });
        btnRow.appendChild(b);
      })(openOpts[oi]);
    }
    overlay.appendChild(btnRow);

    /* ⓘ info button — top-left, revealed ONLY together with the rewards */
    var infoBtn = document.createElement('div');
    infoBtn.className = 'box-info-btn';
    infoBtn.title = 'Show reward chances';
    infoBtn.style.opacity = '0';
    infoBtn.style.pointerEvents = 'none';
    infoBtn.innerHTML = '<span class="box-info-btn-ico">i</span><span>REWARD CHANCES</span>';
    infoBtn.addEventListener('click', function(){ self._showBoxInfo(); });
    overlay.appendChild(infoBtn);

    var rewardsShown = false;
    function showRewards(){
      // Idempotent: the video's `ended` handler and the stall watchdog below
      // can both fire, and a second run would wire up CLAIM twice (granting
      // the rewards a second time).
      if(rewardsShown) return;
      rewardsShown = true;
      rewardDiv.style.opacity = '1';
      infoBtn.style.opacity = '1';
      infoBtn.style.pointerEvents = 'auto';
      setTimeout(function(){ btnRow.style.opacity = '1'; }, 300);
      setTimeout(function(){
        claimBtn.addEventListener('click', function(){
          self._holdOpen = false;
          self._cleanupBoxOverlay();
          for(var ci = 0; ci < rolls.length; ci++){
            self.settings[rolls[ci].key] = (self.settings[rolls[ci].key] || 0) + rolls[ci].amount;
          }
          saveSettings(self.settings);
          self._initStorageGrid();
          self._updateCurrencies();
          self._boxOpening = false;
        });
      }, isBulk ? 100 : 600);
    }

    /* Watchdog — the ⓘ REWARD CHANCES button is only revealed by
       showRewards(), which normally waits for the crate video's `ended`
       event. If that video stalls or autoplay is blocked, the rewards and
       the info button would never appear at all. Reveal them anyway. */
    var rewardFallback = setTimeout(function(){
      if(!document.body.contains(overlay)) return;
      if(vid){
        vid.style.filter = 'blur(12px)';
        vid.style.opacity = '0.4';
        try { vid.pause(); } catch(e){}
      }
      showRewards();
    }, 9000);

    if(vid){
      vid.currentTime = 0;
      vid.playbackRate = this._holdOpen ? 2 : 1;
      vid.play().catch(function(){});
      vid.onended = function(){
        vid.onended = null;
        vid.style.filter = 'blur(12px)';
        vid.style.opacity = '0.4';
        showRewards();
        if(self._holdOpen){
          var remaining = loadClanStorage().filter(function(it){ return it.type === 'box'; }).length;
          if(remaining > 0){
            setTimeout(function(){ self._cleanupBoxOverlay(); self._openBox(1); }, 300);
          }
        }
      };
    } else {
      showRewards();
      if(self._holdOpen){
        var remaining2 = loadClanStorage().filter(function(it){ return it.type === 'box'; }).length;
        if(remaining2 > 0){
          setTimeout(function(){ self._cleanupBoxOverlay(); self._openBox(1); }, 200);
        }
      }
    }
  },

  /* Weighted roll against BOX_DROP_TABLE — the exact same table
     the ⓘ info panel displays, so the shown odds are never a lie. */
  _rollBoxReward(){
    var t = Math.random() * BOX_DROP_TOTAL_WEIGHT;
    for(var i = 0; i < BOX_DROP_TABLE.length; i++){
      t -= BOX_DROP_TABLE[i].weight;
      if(t < 0) return BOX_DROP_TABLE[i];
    }
    return BOX_DROP_TABLE[BOX_DROP_TABLE.length - 1];
  },

  /* ---------- ⓘ reward-chances panel (inside box-overlay) ----------
     Slides in from the left, blurs the video/rewards behind it. */
  _showBoxInfo(){
    var overlay = document.getElementById('box-overlay');
    if(!overlay || overlay.querySelector('.box-info-panel')) return;
    try { Audio.click(); } catch(e){}
    var self = this;

    var scrim = document.createElement('div');
    scrim.className = 'box-info-scrim';
    overlay.appendChild(scrim);
    scrim.addEventListener('click', function(){ self._closeBoxInfo(); });

    var DICE_SVG = '<svg class="box-info-dice" viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="4.5" stroke="currentColor" stroke-width="2"/>' +
      '<circle cx="8.5" cy="8.5" r="1.7" fill="currentColor"/>' +
      '<circle cx="12" cy="12" r="1.7" fill="currentColor"/>' +
      '<circle cx="15.5" cy="15.5" r="1.7" fill="currentColor"/></svg>';

    var rows = BOX_DROP_TABLE.map(function(e){
      var pct = Math.round((e.weight / BOX_DROP_TOTAL_WEIGHT) * 1000) / 10;
      var min = Math.min.apply(null, e.amounts);
      var max = Math.max.apply(null, e.amounts);
      return '<div class="box-info-row">' +
               '<div class="box-info-chance">' + DICE_SVG + '<span>' + pct + '%</span></div>' +
               '<div class="box-info-items">' +
                 '<div class="box-info-item">' +
                   '<div class="box-info-ico"><img src="' + e.icon + '" alt="' + e.name + '" loading="eager"></div>' +
                   '<div class="box-info-name">' + e.name + '</div>' +
                   '<div class="box-info-amount">' + min.toLocaleString() + ' &ndash; ' + max.toLocaleString() + '</div>' +
                 '</div>' +
               '</div>' +
             '</div>';
    }).join('');

    var panel = document.createElement('div');
    panel.className = 'box-info-panel';
    panel.innerHTML =
      '<div class="box-info-head">' +
        '<div class="box-info-title">BOX REWARDS</div>' +
        '<div class="box-info-close" title="Close (Esc)">&times;</div>' +
      '</div>' +
      '<div class="box-info-sub">Every box contains <b>ONE</b> of these rewards</div>' +
      rows +
      '<div class="box-info-note">Bulk opening (3x / 5x / 10x / All) multiplies the amount you get &mdash; up to <b>x3</b> &mdash; but the drop chances above never change.</div>';
    overlay.appendChild(panel);
    panel.querySelector('.box-info-close').addEventListener('click', function(){ self._closeBoxInfo(); });

    overlay.classList.add('box-info-open');
    this._boxInfoEsc = function(ev){
      if(ev.key === 'Escape'){
        ev.stopImmediatePropagation();
        ev.preventDefault();
        self._closeBoxInfo();
      }
    };
    document.addEventListener('keydown', this._boxInfoEsc, true);

    /* Force a style/layout flush first so the browser registers the
       panel's start position (translateX -105%) before we slide it in —
       works even in background tabs where rAF is frozen. */
    void panel.offsetWidth;
    panel.classList.add('open');
  },
  _closeBoxInfo(){
    if(this._boxInfoEsc){
      document.removeEventListener('keydown', this._boxInfoEsc, true);
      this._boxInfoEsc = null;
    }
    var overlay = document.getElementById('box-overlay');
    if(!overlay) return;
    var panel = overlay.querySelector('.box-info-panel');
    var scrim = overlay.querySelector('.box-info-scrim');
    try { Audio.click(); } catch(e){}
    overlay.classList.remove('box-info-open');
    if(panel) panel.classList.remove('open');
    if(scrim) scrim.classList.add('hide');
    setTimeout(function(){
      if(panel && panel.parentNode) panel.parentNode.removeChild(panel);
      if(scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
    }, panel ? 360 : 0);
  },

  /* ============================================================
     SHOP
     ============================================================ */
  _renderShop(){
    Audio.click();
    if(this._shopTimer){ clearInterval(this._shopTimer); this._shopTimer = null; }
    this._shopShowSidebar();
    this._updateCurrencies();
    this._renderDeals();
    this._renderBundles();
    this._renderFreeOffer();
    this._updateShopTimer();
    this._wireShopSidebar();
    document.getElementById('shop-back-main').onclick = () => { Audio.click(); this.show('menu-main'); };
    this._shopTimer = setInterval(() => this._updateShopTimer(), 60000);
  },

  _updateCurrencies(){
    const s = Menu.settings;
    const ce = document.getElementById('shop-coins');
    const ge = document.getElementById('shop-gold');
    const ca = document.getElementById('shop-cash');
    if(ce) ce.textContent = s.coins || 0;
    if(ge) ge.textContent = s.gold || 0;
    if(ca) ca.textContent = s.cash || 0;
  },

  /* Guarantee the left store sidebar is always visible in every section */
  _shopShowSidebar(){
    const sb = document.querySelector('.shop-sidebar');
    if(sb){
      sb.classList.remove('hidden');
      sb.style.display = '';
      sb.style.visibility = 'visible';
    }
    document.querySelectorAll('.shop-sidebar-section').forEach(x => {
      x.classList.remove('hidden');
      x.style.display = '';
      x.style.visibility = 'visible';
    });
  },

  _wireShopSidebar(){
    document.querySelectorAll('.shop-sidebar-section').forEach(el => {
      el.onclick = () => {
        Audio.click();
        this._shopShowSidebar();
        document.querySelectorAll('.shop-sidebar-section').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
        document.querySelectorAll('.shop-page').forEach(p => p.classList.add('hidden'));
        const page = document.getElementById('shop-page-' + el.dataset.section);
        if(page) page.classList.remove('hidden');
        /* Bundles are fetched live and depend on being logged in, so the page
           is rebuilt on every visit rather than once when the store opened. */
        if(el.dataset.section === 'bundles') this._renderBundles();
      };
    });
  },

  _renderDeals(){
    const container = document.getElementById('shop-deals');
    if(!container) return;
    container.innerHTML = '';
    const offers = SHOP_DATA.getOffers();
    
    // Prepend free spray if not owned
    const ownedSprays = getOwnedSprays ? getOwnedSprays() : [];
    const allOffers = [];
    if(!ownedSprays.includes('first_spray')){
      allOffers.push({ reward:'first_spray', amount:1, price:0, currency:'gold', stock:1, free:true, name:'First Spray', desc:'A simple gray square spray. Free for all players!' });
    }
    /* Tank styles are ALWAYS on the shelf while you do not own them — the
       daily rotation must not be able to hide a permanent product. Already-
       owned styles are dropped from the picks below the same way. */
    const ownedStylesSet = new Set(window.TankStyles ? TankStyles.LIST.filter(id => TankStyles.ownsStyle(id)) : []);
    const STYLE_OFFERS = {
      style_woodland_camo: { amount:1, price:1200, currency:'gold', name:'Woodland Camo', desc:'Olive-drab military woodland pattern for your tank.' },
      style_desert_camo:   { amount:1, price:1200, currency:'gold', name:'Desert Storm',  desc:'Sandy desert pattern with brown blotches.' },
      style_tiger_stripes: { amount:1, price:1800, currency:'gold', name:'Tiger Stripes',  desc:'Loud orange paint job with black stripes.' },
    };
    const prependedStyles = new Set();
    Object.keys(STYLE_OFFERS).forEach(reward => {
      const styleId = reward.slice('style_'.length);
      if(!ownedStylesSet.has(styleId)){
        allOffers.push(Object.assign({ reward, stock:99, priority:1 }, STYLE_OFFERS[reward]));
        prependedStyles.add(reward);
      }
    });
    offers.forEach(o => {
      if(o.reward && prependedStyles.has(o.reward)) return;       /* already on the shelf above */
      if(o.reward && o.reward.indexOf('style_') === 0){
        const styleId = o.reward.slice('style_'.length);
        if(ownedStylesSet.has(styleId)) return;                    /* owned — do not sell twice */
      }
      allOffers.push(o);
    });
    
    allOffers.forEach((offer, idx) => {
      const card = document.createElement('div');
      const soldOut = offer.stock === 0;
      card.className = 'shop-deal-card' + (soldOut ? ' sold-out' : '');
      /* Through the shared table, so an offer card and the buy screen for the
         same offer cannot disagree about what the item looks like. */
      const art = this._shopRewardArt(offer.reward);
      const img = art.img;
      const label = art.label;
      const curFile = offer.currency === 'gold' ? 'gold' : (offer.currency === 'coins' ? 'coin' : 'cash');
      card.innerHTML =
        '<div class="shop-deal-image" style="background-image:url(\'' + img + '\')"></div>' +
        '<div class="shop-deal-amount">' + offer.amount + '</div>' +
        '<div class="shop-deal-label">' + label + '</div>' +
        '<div class="shop-deal-price' + (offer.currency === 'coins' ? ' coins' : '') + '"><img class="cur-mini" src="assets/currency/' + curFile + '.png" alt=""><span>' + (offer.price === 0 ? 'FREE' : offer.price) + '</span></div>' +
        (offer.stock > 0 && offer.stock < 99 ? '<div class="shop-deal-stock">' + offer.stock + ' left</div>' : '') +
        (soldOut ? '<div class="shop-deal-stock">SOLD OUT</div>' : '');
      if(!soldOut){
        card.onclick = () => this._showShopBuy(offer);
      }
      container.appendChild(card);
    });
  },

  /* ---------- REAL-MONEY BUNDLES ----------

     The MAIN page above sells virtual currency you earn in game. This page
     sells the same currencies for actual money through Stripe, and it is a
     different kind of card on purpose: the price is a fixed euro figure, the
     card shows what the bundle CONTAINS rather than a currency icon, and
     clicking it hands off to Stripe instead of going through the hold-to-buy.

     The prices and the contents are not written here. They come from the
     server's product table (/pay/products), so the shop and the charge can
     never disagree, and a tampered client cannot invent its own price. */

  _renderBundles(){
    const container = document.getElementById('shop-bundles');
    const note = document.getElementById('shop-real-note');
    if(!container) return;
    if(!window.PAYMENTS) return;
    container.innerHTML = '';

    /* window.Auth, not a bare Auth: the store must still draw if auth.js ever
       fails to load, rather than throwing and taking the whole store down. */
    if(!window.Auth || !Auth.loggedIn()){
      if(note) note.innerHTML = 'Log in to buy bundles — a purchase is delivered to your account.';
      return;
    }
    if(note) note.innerHTML = 'Paid with Stripe. Delivered to your account and kept if you clear this browser.';

    PAYMENTS.products().then(list => {
      container.innerHTML = '';
      if(!list.length){
        container.innerHTML = '<div class="shop-coming-soon">Nothing for sale right now</div>';
        return;
      }
      list.forEach(p => {
        const card = document.createElement('div');
        card.className = 'shop-deal-card shop-bundle-card';
        /* One icon per currency in the bundle, from the game's existing
           currency art — a two-currency bundle needs no new image. */
        const icons = (p.icons || []).map(src =>
          '<img class="cur-mini" src="' + src + '" alt="">').join('');
        card.innerHTML =
          '<div class="shop-bundle-icons">' + icons + '</div>' +
          '<div class="shop-deal-label">' + p.name + '</div>' +
          '<div class="shop-deal-sub">' + p.description + '</div>' +
          '<div class="shop-bundle-price">' + this._formatBundlePrice(p) + '</div>';
        card.onclick = () => {
          Audio.click();
          /* The button greys out for the whole trip: the redirect is a full
             page load, so nothing would un-grey it on failure. The label goes
             back if the request itself fails and we stay put. */
          card.classList.add('busy');
          const label = card.querySelector('.shop-bundle-price');
          const was = label ? label.textContent : '';
          if(label) label.textContent = 'Opening Stripe…';
          PAYMENTS.buy(p.id).catch(err => {
            card.classList.remove('busy');
            if(label) label.textContent = was;
            this.toast(err.message || 'Could not start the purchase');
          });
        };
        container.appendChild(card);
      });
    }).catch(err => {
      container.innerHTML = '<div class="shop-coming-soon">' + (err.message || 'Store unavailable') + '</div>';
    });
  },

  /* Cents to a readable euro figure. Stripe counts in the smallest unit, so
     300 is EUR 3.00 — never show "300". */
  _formatBundlePrice(p){
    const major = (p.price / 100).toFixed(2);
    const symbol = p.currency === 'eur' ? '\u20AC' : (p.currency === 'usd' ? '$' : '');
    return symbol + major;
  },

  _renderFreeOffer(){
    const el = document.getElementById('shop-free-offer');
    if(!el) return;
    const claimed = SHOP_DATA.isFreeClaimed();
    el.innerHTML =
      '<div class="shop-free-card' + (claimed ? ' claimed' : '') + '">' +
      '<div class="shop-free-icon"><img class="cur-img cur-lg" src="assets/currency/cash.png" alt="cash"></div>' +
      '<div><div style="font-weight:700;font-size:16px">Daily Free</div>' +
      '<div class="shop-free-info">' + (claimed ? 'Claimed today' : 'Get ' + SHOP_DATA.FREE_OFFER.amount + ' cash free') + '</div></div>' +
      '<div class="shop-free-btn">' + (claimed ? 'Done' : 'Claim') + '</div></div>';
    if(!claimed){
      el.querySelector('.shop-free-card').onclick = () => {
        if(SHOP_DATA.claimFree()){
          Audio.click();
          this._updateCurrencies();
          Menu.toast('Claimed ' + SHOP_DATA.FREE_OFFER.amount + ' cash!');
          this._renderFreeOffer();
        }
      };
    }
  },

  _updateShopTimer(){
    const el = document.getElementById('shop-timer');
    if(!el) return;
    const now = Date.now();
    const nextDay = Math.ceil(now / 86400000) * 86400000;
    const remaining = nextDay - now;
    const hrs = Math.floor(remaining / 3600000);
    const mins = Math.floor((remaining % 3600000) / 60000);
    el.textContent = 'New deals in ' + hrs + 'h ' + mins + 'm';
  },

/* WHAT A REWARD LOOKS LIKE.

     One table, four places: the offer card, the buy screen, the reveal, and the
     amount line. It used to be copied inline into each of those, which is how the
     crates ended up pointing at assets/rewards/basic_crate.png — a file that has
     never existed, so every crate offer rendered as an empty box. Both crates now
     point at the crate art that IS in the project. */
  _shopRewardArt(reward){
    return {
      cash:        { img:'assets/currency/cash.png', label:'Cash' },
      coins:       { img:'assets/currency/coin.png', label:'Coins' },
      gold:        { img:'assets/currency/gold.png', label:'Gold' },
      /* Was rewards/basic_crate.png and rewards/rare_crate.png — neither file
         exists in the project. assets/crate_icon.png is the crate artwork that
         is actually here. */
      basic_crate: { img:'assets/crate_icon.png', label:'Basic Crate' },
      rare_crate:  { img:'assets/crate_icon.png', label:'Rare Crate' },
      first_spray: { img:'assets/sprays/first_spray.png', label:'First Spray' },
      /* Tank styles: the texture IS the card art. */
      style_woodland_camo: { img:'assets/styles/woodland_camo.png?v=2', label:'Woodland Camo' },
      style_desert_camo:   { img:'assets/styles/desert_camo.png?v=2', label:'Desert Storm' },
      style_tiger_stripes: { img:'assets/styles/tiger_stripes.png?v=2', label:'Tiger Stripes' },
    }[reward] || { img:'', label:reward || '' };
  },
  _shopCurrencyIcon(currency){
    return currency === 'gold' ? 'assets/currency/gold.png'
         : currency === 'coins' ? 'assets/currency/coin.png'
         : 'assets/currency/cash.png';
  },
  /* The count line: "x750" for a stack of one thing, "x2" for two crates. Always
     prefixed, so the number beside the icon is never just a bare figure. */
  _shopRewardCount(offer){
    return 'x' + (offer.amount || 1);
  },

  /* ---------- THE BUY SCREEN ---------- */

  _showShopBuy(offer){
    Audio.click();
    if(!offer || offer.stock === 0) return;

    /* Anything still running from a previous visit has to be stopped by hand:
       a hold that is mid-count when the player hits Back would fire the
       purchase for the NEXT offer they look at. */
    this._cancelShopHold(true);

    this._currentBuyOffer = offer;
    const art = this._shopRewardArt(offer.reward);
    const canAfford = SHOP_DATA.canAfford(offer);

    const wrap = document.getElementById('shop-buy-wrapper');
    if(wrap) wrap.classList.remove('done');

    const img = document.getElementById('shop-buy-image');
    if(img){ img.src = art.img; img.alt = art.label; }
    const count = document.getElementById('shop-buy-count');
    if(count) count.textContent = this._shopRewardCount(offer);
    const name = document.getElementById('shop-buy-name');
    if(name) name.textContent = offer.name || art.label;

    /* A free offer has no currency to show, so the cost line says FREE and
       carries no icon. */
    const isFree = (offer.price === 0);
    const cost = document.getElementById('shop-buy-cost');
    if(cost){
      cost.innerHTML = isFree
        ? '<span>FREE</span>'
        : '<img class="cur-mini" src="' + this._shopCurrencyIcon(offer.currency) + '" alt="">'
          + '<span>' + offer.price + '</span>';
    }

    const btn = document.getElementById('shop-buy-btn');
    if(btn){
      btn.classList.toggle('locked', !canAfford);
      /* _wireShopHold resets the label to "Hold to buy" as its first act, so the
         "not enough X" wording has to be applied AFTER it, not before. */
      this._wireShopHold(btn, offer, canAfford);
      if(!canAfford){
        const label = document.getElementById('shop-buy-btn-text');
        if(label){
          label.textContent = 'Not enough ' + (offer.currency === 'gold' ? 'gold' : offer.currency === 'coins' ? 'coins' : 'cash');
        }
      }
    }

    document.getElementById('shop-back-buy').onclick = () => {
      Audio.click();
      this._cancelShopHold(true);
      this.show('menu-store');
    };
    this.show('menu-shop-buy');
  },

  /* HOLD TO BUY.

     Three seconds of continuous pointer-down. The fill is painted from a
     rAF loop against a wall-clock start time rather than by a CSS animation,
     because the purchase has to fire on the JS clock — an animation that is
     throttled or restarted would desync from the moment money actually leaves.

     Releasing early rewinds the fill from where it is, rather than snapping to
     zero, so letting go at 90% reads as "nearly" instead of "no". */
  _wireShopHold(btn, offer, canAfford){
    const fill = document.getElementById('shop-buy-fill');
    const label = document.getElementById('shop-buy-btn-text');

    /* Reset first, ALWAYS.

       A previous hold leaves the label reading "Keep holding 0s" and the fill at
       whatever it was when it stopped. Opening an offer you cannot afford skips
       the arming code entirely, so without this the button greys out while
       still claiming you are two seconds from a purchase you cannot make. */
    if(btn._shopRaf){ cancelAnimationFrame(btn._shopRaf); btn._shopRaf = 0; }
    btn.classList.remove('pressing');
    if(fill){ fill.style.transition = ''; fill.style.width = '0%'; }
    if(label) label.textContent = 'Hold to buy';
    btn.onpointerdown = btn.onpointerup = btn.onpointerleave = btn.onpointercancel = null;
    if(btn._shopHoldWindowStop){
      window.removeEventListener('pointerup', btn._shopHoldWindowStop);
      btn._shopHoldWindowStop = null;
    }

    if(!canAfford) return;

    const HOLD_MS = 3000;
    const self = this;
    let start = 0, fired = false;

    const paint = (now) => {
      const t = Math.max(0, Math.min(1, (now - start) / HOLD_MS));
      if(fill) fill.style.width = (t * 100).toFixed(2) + '%';
      /* Seconds left. HOLD_MS is milliseconds, so this divides by 1000: dividing by
         100 counted tenths of a second and printed "15s" when 1.5s remained. */
      if(label) label.textContent = t > 0 ? 'Keep holding ' + Math.ceil((1 - t) * HOLD_MS / 1000) + 's' : 'Hold to buy';
      if(t >= 1 && !fired){
        fired = true;
        self._cancelShopHold(true);
        self._shopBuyConfirm(offer);
        return;
      }
      if(!fired) btn._shopRaf = requestAnimationFrame(paint);
    };

    btn.onpointerdown = (e) => {
      if(fired) return;
      /* Only the primary button starts a hold. A right-click drag would
         otherwise arm a three-second purchase nobody asked for. */
      if(e.button != null && e.button !== 0) return;
      e.preventDefault();
      start = performance.now();
      fired = false;
      btn.classList.add('pressing');
      Audio.click();
      if(btn._shopRaf) cancelAnimationFrame(btn._shopRaf);
      btn._shopRaf = requestAnimationFrame(paint);
    };

    const stop = () => {
      if(fired || !btn._shopRaf) return;
      cancelAnimationFrame(btn._shopRaf);
      btn._shopRaf = 0;
      btn.classList.remove('pressing');
      /* Rewind rather than snap: the fill shrinking quickly back to zero is the
         "that did not count" signal. */
      if(fill){
        fill.style.transition = 'width .18s ease-out';
        fill.style.width = '0%';
        setTimeout(() => { if(!btn._shopRaf) fill.style.transition = ''; }, 200);
      }
      if(label) label.textContent = 'Hold to buy';
    };

    btn.onpointerup = stop;
    btn.onpointerleave = stop;
    btn.onpointercancel = stop;
    /* A pointer released anywhere outside the button still ends the hold —
       otherwise dragging off the button and letting go would hold forever. */
    btn._shopHoldWindowStop = (e) => { if(!btn.contains(e.target)) stop(); };
    window.addEventListener('pointerup', btn._shopHoldWindowStop);
  },

  _cancelShopHold(hard){
    const btn = document.getElementById('shop-buy-btn');
    if(btn){
      if(btn._shopRaf){ cancelAnimationFrame(btn._shopRaf); btn._shopRaf = 0; }
      btn.classList.remove('pressing');
      btn.onpointerdown = btn.onpointerup = btn.onpointerleave = btn.onpointercancel = null;
      if(btn._shopHoldWindowStop){
        window.removeEventListener('pointerup', btn._shopHoldWindowStop);
        btn._shopHoldWindowStop = null;
      }
    }
    const fill = document.getElementById('shop-buy-fill');
    if(fill && hard){ fill.style.transition = ''; fill.style.width = '0%'; }
  },

  _shopBuyConfirm(offer){
    if(!offer) return;
    /* The hold already stopped itself; this clears the button state for good
       measure so a failure path cannot leave it looking pressed. */
    this._cancelShopHold(true);
    const ok = SHOP_DATA.purchase(offer);
    if(!ok){ this.toast('Purchase failed'); this.show('menu-store'); return; }
    Audio.click();
    this._currentRewardOffer = offer;

    /* THE BOUGHT SCREEN: the same wagon, the controls gone, CONGRADITIONS and
       Back alone. This is the state the hold hands over to. */
    const wrap = document.getElementById('shop-buy-wrapper');
    if(wrap){
      wrap.classList.add('done');
      const congrats = wrap.querySelector('.shop-buy-congrats');
      if(congrats){
        /* Re-trigger the pop animation: the class is already on the element
           from the previous purchase, and CSS animations only fire on a change
           of computed style. */
        congrats.style.animation = 'none';
        void congrats.offsetWidth;
        congrats.style.animation = '';
      }
    }
    this._updateCurrencies();
  },

  /* ---------- THE REVEAL ---------- */

  _shopReceive(offer){
    const wrap = document.getElementById('shop-receive-wrapper');
    if(!wrap) return;
    /* Clear anything a previous reveal left behind, including its timers —
       visiting two offers in a row would otherwise stack two flash animations
       and two "finished" overlays on top of each other. */
    this._clearShopReceiveTimers();
    wrap.classList.remove('lit', 'finished', 'flash');

    const art = this._shopRewardArt(offer.reward);
    const img = document.getElementById('shop-receive-image');
    if(img){ img.src = art.img; img.alt = art.label; }
    const amount = document.getElementById('shop-receive-amount');
    if(amount) amount.textContent = this._shopRewardCount(offer) + ' ' + art.label;

    document.getElementById('shop-receive-back').onclick = () => {
      Audio.click();
      this._clearShopReceiveTimers();
      wrap.classList.remove('lit', 'finished', 'flash');
      this._updateCurrencies();
      this.show('menu-store');
    };

    this.show('menu-shop-receive');

    /* The sequence. flash (a beat) -> lit (wagon dims, item grows to 1.3x, rays
       spin up, count fades in) -> finished (everything but Back and
       CONGRADITIONS). */
    this._shopReceiveTimers = [
      setTimeout(() => { wrap.classList.add('flash'); }, 40),
      setTimeout(() => {
        wrap.classList.add('lit');
        Audio.playMusic && Audio.playMusic('assets/shop/shop.mp3');
      }, 260),
      setTimeout(() => { wrap.classList.add('finished'); }, 1900),
    ];
  },

  _clearShopReceiveTimers(){
    if(this._shopReceiveTimers){
      this._shopReceiveTimers.forEach(t => clearTimeout(t));
      this._shopReceiveTimers = null;
    }
  },

  /* ---------- Clan System ---------- */
  _clanData: null,

  _loadClanData(){
    const saved = localStorage.getItem('tankparty_clan');
    if(saved){
      try{
        this._clanData = JSON.parse(saved);
        if(this._clanData && this._clanData.name && !this.settings.playerClan){
          this._syncClanTag(this._clanData.name);
        }
      } catch(e){
        console.error('Failed to load clan data:', e);
        this._clanData = null;
      }
    }
  },

  _createClan(){
    const nameInput = document.getElementById('clan-name-input');
    const name = nameInput.value.trim();
    
    // Check if user is already in a clan
    if(this._clanData){
      this.toast('You are already in a clan. Leave your current clan first.');
      return;
    }
    
    if(name.length < 3){
      this.toast('Clan name must be at least 3 letters');
      return;
    }

    // Check if clan name already exists
    if(this._clanNameExists(name)){
      this.toast('A clan with this name already exists.');
      return;
    }

    const visibilitySeg = document.querySelector('.clan-visibility-seg .active');
    const isHidden = visibilitySeg && visibilitySeg.dataset.vis === 'hidden';

    // Generate clan code
    const clanCode = this._generateClanCode();

    // Create clan data
    this._clanData = {
      name: name,
      code: clanCode,
      isHidden: isHidden,
      owner: this.settings.playerName || 'Player',
      members: [{ name: this.settings.playerName || 'Player', rank: 'owner', xp: 0 }],
      chat: [],
      createdAt: Date.now()
    };

    // Save to localStorage
    this._saveClanData();
    this._syncClanTag(name);

    // Register clan in the real public registry (shared across tabs)
    this._registerClan(this._clanData);

    // Announce to the shared clan lobby so other devices can find it
    if(typeof Net !== 'undefined' && Net.announceClan){
      Net.announceClan(this._clanData).catch(()=>{});
    }
    // Announce to the persistent cloud registry (works even when nobody hosts a lobby)
    this._apiAnnounceClan(this._clanData);

    // Add clan name to global clan names list
    this._addClanName(name);

    // Copy code to clipboard if hidden
    if(isHidden){
      this._copyToClipboard(clanCode);
      this.toast('Clan created! Code copied to clipboard.');
    } else {
      this.toast('Clan created successfully!');
    }

    // Show clan UI
    this.show('menu-clan-ui');
    this._renderClanUI();
  },

  _clanNameExists(name){
    // Get all clan names from localStorage
    const clanNames = JSON.parse(localStorage.getItem('tankparty_clan_names') || '[]');
    return clanNames.some(clanName => clanName.toLowerCase() === name.toLowerCase());
  },

  _addClanName(name){
    // Add clan name to global list
    const clanNames = JSON.parse(localStorage.getItem('tankparty_clan_names') || '[]');
    clanNames.push(name);
    localStorage.setItem('tankparty_clan_names', JSON.stringify(clanNames));
  },

  _removeClanName(name){
    // Remove clan name from global list
    const clanNames = JSON.parse(localStorage.getItem('tankparty_clan_names') || '[]');
    const index = clanNames.findIndex(clanName => clanName.toLowerCase() === name.toLowerCase());
    if(index !== -1){
      clanNames.splice(index, 1);
      localStorage.setItem('tankparty_clan_names', JSON.stringify(clanNames));
    }
  },

  _generateClanCode(){
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for(let i = 0; i < 8; i++){
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  },

  async _searchPublicClans(){
    const searchInput = document.getElementById('public-clan-search');
    const searchTerm = (searchInput ? searchInput.value : '').trim().toLowerCase();

    const list = document.getElementById('public-clan-list');
    list.innerHTML = '<div class="muted">Searching for clans...</div>';

    // Local registry (this browser) + persistent cloud registry + shared lobby
    const all = this._getClanRegistry();
    const remote = await this._apiFetchClans();
    const seen = new Set(all.map(c => c.code));
    remote.forEach(c => {
      if(c && c.code && !seen.has(c.code)){ all.push(c); seen.add(c.code); }
    });
    try{
      if(typeof Net !== 'undefined' && Net.fetchClans){
        const lobbyClans = await Net.fetchClans();
        lobbyClans.forEach(c => {
          if(c && c.code && !seen.has(c.code)){ all.push(c); seen.add(c.code); }
        });
      }
    }catch(e){}
    const publicClans = all.filter(c => !c.isHidden);

    const filteredClans = searchTerm
      ? publicClans.filter(c => (c.name || '').toLowerCase().includes(searchTerm))
      : publicClans;

    if(filteredClans.length === 0){
      list.innerHTML = '<div class="muted">No public clans found matching your search.</div>';
      return;
    }

    list.innerHTML = '';
    filteredClans.forEach(clan => {
      const item = document.createElement('div');
      item.className = 'clan-list-item';
      item.innerHTML = `
        <div>
          <div class="clan-list-item-name">${clan.name}</div>
          <div class="clan-list-item-info">${(clan.members || []).length} members &bull; Owner: ${clan.owner}</div>
        </div>
        <div class="clan-list-item-action">Join</div>
      `;
      item.onclick = () => this._joinClanFromRegistry(clan);
      list.appendChild(item);
    });
  },

  async _joinHiddenClan(){
    const codeInput = document.getElementById('hidden-clan-code');
    const code = (codeInput ? codeInput.value : '').trim().toUpperCase();

    if(code.length < 4){
      this.toast('Enter a valid clan code');
      return;
    }

    this.toast('Searching for clan...');

    // Find the clan by its secret join code: local registry first, then the
    // persistent cloud registry, then the shared lobby as a last resort
    let entry = this._getClanRegistry().find(c => (c.code || '').toUpperCase() === code);
    if(!entry) entry = await this._apiFetchClan(code);
    if(!entry && typeof Net !== 'undefined' && Net.fetchClans){
      try{
        const remote = await Net.fetchClans();
        entry = remote.find(c => (c.code || '').toUpperCase() === code);
      }catch(e){}
    }
    if(!entry){
      this.toast('No clan found with that code.');
      return;
    }
    this._joinClanFromRegistry(entry, true);
  },

  _joinClan(clan){
    this._joinClanFromRegistry(clan);
  },

  _renderClanUI(){
    if(!this._clanData) return;

    // Pull any newer member data from the shared registry (other tabs)
    this._syncClanFromRegistry();

    // Update clan name
    document.getElementById('clan-ui-name').textContent = this._clanData.name.toUpperCase();

    // Update rank badge
    const playerRank = this._getPlayerRank();
    document.getElementById('clan-ui-rank').textContent = playerRank.toUpperCase();

    // Render members list
    const membersList = document.getElementById('clan-members-list');
    membersList.innerHTML = '';
    
    this._clanData.members.forEach(member => {
      const memberItem = document.createElement('div');
      memberItem.className = 'clan-member-item';
      memberItem.innerHTML = `
        <span class="clan-member-name">${member.name}</span>
        <span class="clan-member-rank ${member.rank}">${member.rank}</span>
      `;
      membersList.appendChild(memberItem);
    });

    // Initialize chat with welcome message
    this._initClanChat();

    // Show/hide copy code button based on rank
    const copyBtn = document.getElementById('btn-copy-clan-code');
    if(playerRank === 'owner' && this._clanData.isHidden){
      copyBtn.classList.remove('hidden');
    } else {
      copyBtn.classList.add('hidden');
    }

    // Custom canvas layout mode: render the saved Clan Editor layout with live data
    const savedLayout = this._loadClanLayoutForUI();
    let layout;
    if(savedLayout){
      layout = savedLayout;
    } else if(typeof CLAN_DEFAULT_LAYOUT !== 'undefined' && CLAN_DEFAULT_LAYOUT && CLAN_DEFAULT_LAYOUT.length){
      layout = JSON.parse(JSON.stringify(CLAN_DEFAULT_LAYOUT));
    } else {
      layout = this._defaultClanLayout();
    }
    // isDefault is only true when NO user design is saved — then the
    // "design not saved" hint banner shows (it was inverted before)
    this._setupClanCanvasUI(layout, !savedLayout);
    if(savedLayout && this._clanLayoutSort && this._clanUIState){
      this._clanUIState.sortBy = (this._clanLayoutSort === 'xp') ? 'xp' : 'name';
    }
  },

  _initClanChat(){
    if(!this._clanData.chat) this._clanData.chat = [];
    if(this._clanData.chat.length === 0){
      this._clanData.chatSeq = (this._clanData.chatSeq || 0) + 1;
      this._clanData.chat.push({ id: this._clanData.chatSeq + ':System', name: 'System', rank: 'owner', msg: 'Welcome to ' + this._clanData.name + ' clan chat!' });
      this._saveClanData();
    }
    const chatMessages = document.getElementById('clan-chat-messages');
    if(!chatMessages) return;
    chatMessages.innerHTML = '';
    this._clanData.chat.forEach(m => this._addChatMessage(m.name, m.msg, m.rank, m.rank === 'owner' && m.name === 'System', m.ts));
  },

  _addChatMessage(name, message, rank, isSystem = false, ts = null){
    const chatMessages = document.getElementById('clan-chat-messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'clan-chat-message';
    let timeStr = '';
    if(ts){
      const dt = new Date(ts);
      timeStr = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
    }
    if(isSystem){
      messageDiv.innerHTML = `
        <span class="clan-chat-message-name" style="color: #9b59b6;">${name}</span>
        <span class="clan-chat-message-time">${timeStr}</span>
        <span class="clan-chat-message-text">${message}</span>
      `;
    } else {
      messageDiv.innerHTML = `
        <span class="clan-chat-message-rank ${rank}">${rank}</span>
        <span class="clan-chat-message-name">${name}</span>
        <span class="clan-chat-message-time">${timeStr}</span>
        <span class="clan-chat-message-text">${message}</span>
      `;
    }
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  },

  _sendChatMessage(){
    const st = this._clanUIState;
    const input = st
      ? document.getElementById('clan-canvas-input')
      : document.getElementById('clan-chat-input');
    if(!input) return;
    const message = input.value.trim();
    
    if(!message) return;
    
    const playerName = this.settings.playerName || 'Player';
    const playerRank = this._getPlayerRank();

    // Persist message in clan data (drawn by the canvas layout + fallback DOM)
    if(!this._clanData.chat) this._clanData.chat = [];
    this._clanData.chatSeq = (this._clanData.chatSeq || 0) + 1;
    this._clanData.chat.push({ id: this._clanData.chatSeq + ':' + playerName, name: playerName, rank: playerRank, msg: message, ts: Date.now() });
    if(this._clanData.chat.length > 50) this._clanData.chat = this._clanData.chat.slice(-50);
    this._saveClanData();
    this._updateRegistryClan(this._clanData);
    this._apiAnnounceClan(this._clanData);

    if(!st) this._addChatMessage(playerName, message, playerRank, false, Date.now());
    input.value = '';
    if(st){ st.draft = ''; st.chatScroll = 0; this._updateClanCanvasCounter(input, st.layout.find(x => x.type === 'chat-input')); }
  },

  _clanMemberAction(name, act){
    const clan = this._clanData;
    if(!clan) return;
    const me = this.settings.playerName || 'Player';
    const myRank = this._getPlayerRank();
    const target = (clan.members || []).find(m => m.name === name);
    if(!target || target.name === me || target.rank === 'owner') return;
    if(act === 'rank' && myRank === 'owner'){
      target.rank = (target.rank === 'admin') ? 'member' : 'admin';
      this.toast(target.rank === 'admin' ? name + ' is now an ADMIN' : name + ' is now a member');
    } else if(act === 'kick' && (myRank === 'owner' || (myRank === 'admin' && target.rank !== 'admin'))){
      clan.members = (clan.members || []).filter(m => m.name !== name);
      this.toast(name + ' was kicked from the clan');
    } else {
      return;
    }
    this._saveClanData();
    this._updateRegistryClan(clan);
    this._apiAnnounceClan(clan);
  },

  _getPlayerRank(){
    if(!this._clanData) return 'none';
    const playerName = this.settings.playerName || 'Player';
    const member = this._clanData.members.find(m => m.name === playerName);
    return member ? member.rank : 'none';
  },

  _copyClanCode(){
    if(!this._clanData || !this._clanData.code) return;
    this._copyToClipboard(this._clanData.code);
    this.toast('Clan code copied to clipboard!');
  },

  _leaveClan(){
    if(!this._clanData) return;
    
    if(confirm('Are you sure you want to leave this clan?')){
      const playerName = this.settings.playerName || 'Player';
      const isOwner = this._getPlayerRank() === 'owner';

      if(isOwner){
        // Owner leaving dissolves the clan and removes it from the shared registry
        const clanCode = this._clanData.code;
        this._removeClanFromRegistry(this._clanData.name, this._clanData.code);
        this._removeClanName(this._clanData.name);
        if(typeof Net !== 'undefined' && Net.removeClan){
          Net.removeClan(clanCode).catch(()=>{});
        }
        this._apiRemoveClan(clanCode);
      } else {
        // Members just remove themselves from the clan and registry entry
        this._clanData.members = (this._clanData.members || []).filter(m => m.name !== playerName);
        this._updateRegistryClan(this._clanData);
      }

      this._clanData = null;
      localStorage.removeItem('tankparty_clan');
      this._syncClanTag('');
      this._stopClanCanvasUI();
      this.toast('You have left the clan.');
      this.show('menu-clans');
    }
  },

  _syncClanTag(name){
    try{
      this.settings.playerClan = name || '';
      saveSettings(this.settings);
      this.refreshProfile();
    }catch(e){}
  },

  _copyToClipboard(text){
    navigator.clipboard.writeText(text).catch(() => {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    });
  },

  _handleCodeCommand(code){
    // Check if user is clan owner and requesting clan code
    if(code === '/code' && this._clanData){
      const playerRank = this._getPlayerRank();
      if(playerRank === 'owner'){
        this._copyClanCode();
        return true;
      } else if(playerRank !== 'none'){
        this.toast('Only clan owners can access the secret code!');
        return true;
      }
    }
    return false;
  },

  /* ---------- Clan Registry (real, shared across tabs) ---------- */
  _getClanRegistry(){
    try{ return JSON.parse(localStorage.getItem('tankparty_clan_registry') || '[]'); }catch(e){ return []; }
  },
  _setClanRegistry(list){
    try{ localStorage.setItem('tankparty_clan_registry', JSON.stringify(list)); }catch(e){}
  },

  /* ---------- Persistent clan API (Cloudflare Worker, cross-device) ---------- */
  _clanApiBase(){
    return (typeof CONFIG !== 'undefined' && CONFIG.CLAN_API_URL) ? CONFIG.CLAN_API_URL : '';
  },

  async _apiFetchClans(){
    const base = this._clanApiBase();
    if(!base) return [];
    try{
      const r = await fetch(base + '/clans', { method: 'GET' });
      if(!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    }catch(e){ return []; }
  },

  async _apiFetchClan(code){
    const base = this._clanApiBase();
    if(!base || !code) return null;
    try{
      const r = await fetch(base + '/clans?code=' + encodeURIComponent(code), { method: 'GET' });
      if(!r.ok) return null;
      return await r.json();
    }catch(e){ return null; }
  },

  async _apiAnnounceClan(clan){
    const base = this._clanApiBase();
    if(!base || !clan || !clan.code) return;
    try{
      // Stamping our own presence locally makes the member list turn green
      // immediately, before the server round-trip comes back
      const me = this.settings.playerName || '';
      if(me){
        (clan.members || []).forEach(m => { if(m && m.name === me) m.lastSeen = Date.now(); });
      }
      const summary = {
        name: clan.name,
        code: clan.code,
        isHidden: !!clan.isHidden,
        owner: clan.owner || '',
        members: clan.members || [],
        chat: (clan.chat || []).slice(-50),
        chatSeq: clan.chatSeq || 0,
        me: me
      };
      await fetch(base + '/clans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(summary)
      });
    }catch(e){}
  },

  async _apiRemoveClan(code){
    const base = this._clanApiBase();
    if(!base || !code) return;
    try{ await fetch(base + '/clans?code=' + encodeURIComponent(code), { method: 'DELETE' }); }catch(e){}
  },

  /* Sequence number of a chat message (parsed from its "seq:name" id) */
  _clanChatSeq(m){
    if(!m || !m.id) return 0;
    const n = parseInt(String(m.id).split(':')[0], 10);
    return isNaN(n) ? 0 : n;
  },

  /* Live sync: pull the clan from the API and merge members + chat locally */
  async _pollClanSync(){
    if(!this._clanData || !this._clanData.code) return;
    // Presence heartbeat: refresh our own online stamp on the server every 30s
    const now = Date.now();
    if(!this._lastClanBeat || now - this._lastClanBeat > 30000){
      this._lastClanBeat = now;
      this._apiAnnounceClan(this._clanData);
    }
    const remote = await this._apiFetchClan(this._clanData.code);
    if(!remote || !remote.members) return;
    const local = this._clanData;
    const map = new Map();
    (local.members || []).forEach(m => { if(m && m.name) map.set(m.name, m); });
    (remote.members || []).forEach(m => {
      if(!m || !m.name) return;
      const cur = map.get(m.name);
      // Adopt a remote entry when it is new, when a member rank got promoted,
      // or when it carries fresher presence data (lastSeen)
      if(!cur || (cur.rank === 'member' && m.rank === 'owner') || (m.lastSeen || 0) > (cur.lastSeen || 0)) map.set(m.name, m);
    });
    local.members = Array.from(map.values());
    // Merge remote messages in (additive only — a stale remote must never
    // remove local messages), then sort by sequence so older late-arriving
    // messages never masquerade as new ones or push the newest out of the
    // 50-message cap.
    const localIds = new Set((local.chat || []).map(m => m.id).filter(x => x != null));
    (remote.chat || []).forEach(m => {
      if(m && m.id != null && !localIds.has(m.id)) local.chat.push(m);
    });
    local.chat.sort((a, b) => this._clanChatSeq(a) - this._clanChatSeq(b));
    if(local.chat.length > 50) local.chat = local.chat.slice(-50);
    local.chatSeq = Math.max(local.chatSeq || 0, remote.chatSeq || 0);
    this._saveClanData();
    this._updateRegistryClan(local);
  },
  _registerClan(clan){
    const list = this._getClanRegistry();
    if(list.some(c => c.name.toLowerCase() === clan.name.toLowerCase())) return;
    list.push(JSON.parse(JSON.stringify(clan)));
    this._setClanRegistry(list);
  },
  _updateRegistryClan(clan){
    const list = this._getClanRegistry();
    const i = list.findIndex(c =>
      c.name.toLowerCase() === (clan.name || '').toLowerCase() && c.code === clan.code);
    if(i !== -1){
      list[i] = JSON.parse(JSON.stringify(clan));
      this._setClanRegistry(list);
    }
  },
  _removeClanFromRegistry(name, code){
    const list = this._getClanRegistry().filter(c =>
      !(c.name.toLowerCase() === (name || '').toLowerCase() && (!code || c.code === code)));
    this._setClanRegistry(list);
  },
  _syncClanFromRegistry(){
    if(!this._clanData) return;
    const entry = this._getClanRegistry().find(c =>
      c.name.toLowerCase() === (this._clanData.name || '').toLowerCase() && c.code === this._clanData.code);
    if(entry && entry.members && entry.members.length > (this._clanData.members || []).length){
      this._clanData.members = JSON.parse(JSON.stringify(entry.members));
      this._saveClanData();
    }
  },
  _saveClanData(){
    try{
      // Multi-tab guard: if the stored chat contains messages newer than the
      // in-memory copy (another tab saved a fresher state), fold them in
      // before writing so a stale tab never erases recent messages.
      const saved = localStorage.getItem('tankparty_clan');
      if(saved && this._clanData){
        try{
          const cur = JSON.parse(saved);
          if(cur && cur.chat && this._clanData.chat){
            const localMax = Math.max(0, ...this._clanData.chat.map(m => this._clanChatSeq(m)));
            const savedMax = Math.max(0, ...cur.chat.map(m => this._clanChatSeq(m)));
            if(savedMax > localMax){
              const ids = new Set(this._clanData.chat.map(m => m.id).filter(x => x != null));
              cur.chat.forEach(m => {
                if(m && m.id != null && !ids.has(m.id)) this._clanData.chat.push(m);
              });
              this._clanData.chat.sort((a, b) => this._clanChatSeq(a) - this._clanChatSeq(b));
              this._clanData.chat = this._clanData.chat.slice(-50);
            }
          }
        }catch(e){}
      }
      localStorage.setItem('tankparty_clan', JSON.stringify(this._clanData));
    }catch(e){}
  },
  _joinClanFromRegistry(entry, viaCode){
    if(!entry) return;
    if(this._clanData){
      this.toast('You are already in a clan. Leave your current clan first.');
      return;
    }
    const clan = JSON.parse(JSON.stringify(entry));
    const playerName = this.settings.playerName || 'Player';
    clan.members = clan.members || [];
    if(!clan.members.some(m => m.name === playerName)){
      clan.members.push({ name: playerName, rank: 'member', xp: 0 });
    }
    if(!clan.chat) clan.chat = [];
    this._clanData = clan;
    this._saveClanData();
    this._syncClanTag(clan.name);
    this._updateRegistryClan(clan);
    // Share the updated member list with the clan lobby
    if(typeof Net !== 'undefined' && Net.announceClan){
      Net.announceClan(clan).catch(()=>{});
    }
    // Share with the persistent cloud registry
    this._apiAnnounceClan(clan);
    this.toast('Successfully joined ' + clan.name + '!');
    this.show('menu-clan-ui');
    this._renderClanUI();
  },

  /* ============================================================
     CLAN CANVAS UI (custom layout renderer)
     Draws the Clan Editor layout (tankparty_clan_layout) in-game
     with live data: name, members, weekly XP, chat, sort, etc.
     ============================================================ */
  _clanUIState: null,

  /* Rounded-rect path (canvas roundRect may be missing on older engines) */
  _clanUIRoundRect(ctx, x, y, w, h, r){
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  },

  /* Break a string into lines that each fit inside maxW (word wrap +
     hard-break for words longer than the box). Returns array of lines. */
  /* Fresh cartoon style helpers for the clan canvas UI */
  _clanCartoonPanel(ctx, x, y, w, h, r, c1, c2){
    ctx.save();
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.beginPath();
    this._clanUIRoundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.strokeStyle = '#4a505c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    this._clanUIRoundRect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, Math.max(2, r - 1));
    ctx.stroke();
    ctx.restore();
  },
  _clanOutlineText(ctx, text, x, y, font, fill, outline, align, baseline, outlineW){
    ctx.save();
    ctx.font = font;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = baseline || 'top';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = outline;
    ctx.lineWidth = outlineW || 3;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    ctx.restore();
  },
  _clanUIBreakText(ctx, text, maxW){
    const words = String(text || '').split(/(\s+)/);
    const lines = [];
    let cur = '';
    for(let i = 0; i < words.length; i++){
      const w = words[i];
      if(ctx.measureText(cur + w).width <= maxW){
        cur += w;
        continue;
      }
      if(cur) lines.push(cur);
      /* Binary search for the break point.
         This loop walked the remaining string down one character at a time,
         measuring a fresh substring at every step: O(n^2) measureText calls
         for one word. measureText is a synchronous text-shaping call into the
         platform, so on a long chat line or a wide member list this was tens
         of thousands of them PER FRAME, and the clan screen pinned the tab.
         Splitting a long unbroken word into two halves and only measuring the
         one that can still contain the break turns it into ~log2(n) calls. */
      let rest = w;
      while(rest.length){
        if(ctx.measureText(rest).width <= maxW){
          lines.push(rest);
          rest = '';
          break;
        }
        let lo = 1, hi = rest.length, best = 1;
        while(lo <= hi){
          const mid = (lo + hi) >> 1;
          if(ctx.measureText(rest.slice(0, mid)).width <= maxW){ best = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        lines.push(rest.slice(0, best));
        rest = rest.slice(best);
      }
      cur = '';
    }
    if(cur) lines.push(cur);
    return lines;
  },

  _loadClanLayoutForUI(){
    try{
      this._clanLayoutSort = null;
      const data = JSON.parse(localStorage.getItem('tankparty_clan_layout'));
      // No saved user design at all: null means "no user layout" so the
      // caller falls back to the embedded default WITH the hint banner
      if(!data) return null;
      let els = (data[0] && data[0].type === '_meta') ? data.slice(1) : data;
      const meta = (data[0] && data[0].type === '_meta') ? data[0] : null;
      this._clanLayoutSort = meta ? (meta.sortBy || null) : null;
      // Saved design is older than the installed default: use the updated default
      if(typeof CLAN_LAYOUT_VERSION !== 'undefined' && (!meta || (meta.version || 0) < CLAN_LAYOUT_VERSION)){
        if(this.toast) this.toast('Clan design updated - open the editor and press Save to keep your edits.');
        return null;
      }
      // Resolve separately-stored images back into data URLs (quota-safe save)
      els = els.map(el => {
        if(el && el.type === 'image' && typeof el.imageData === 'string' && el.imageData.indexOf('tankparty_clan_img_') === 0){
          try{
            const d = localStorage.getItem(el.imageData);
            if(d){
              const c = {};
              for(const k in el){ if(k !== 'imageData') c[k] = el[k]; }
              c.imageData = d;
              return c;
            }
          }catch(e){}
        }
        return el;
      });
      return els;
    }catch(e){ return null; }
  },

  _defaultClanLayout(){
    return [
      { type:'clan-name',   x:40,  y:20,  w:470, h:66,  fontSize:34, color:'#ffb12b', borderColor:'rgba(255,177,43,0.5)' },
      { type:'badge',       x:560, y:14,  w:70,  h:70,  label:'\u{1F3C6}', color:'#ffb12b', showFrame:false },
      { type:'progress-bar',x:40,  y:102, w:470, h:40,  fillColor:'#ffb12b', color:'#fff', borderColor:'rgba(255,200,50,0.5)' },
      { type:'xp-counter',  x:530, y:100, w:200, h:92,  label:'Weekly XP', fontSize:30, color:'#fff', borderColor:'rgba(255,200,50,0.4)' },
      { type:'time-left',   x:40,  y:158, w:470, h:34,  fontSize:16, color:'#cfd6e0', borderColor:'rgba(255,200,50,0.4)' },
      { type:'sort-buttons',x:40,  y:204, w:230, h:32,  fontSize:15, color:'#fff' },
      { type:'clan-count',  x:530, y:204, w:200, h:36,  label:'Members', fontSize:16, color:'#cfd6e0', borderColor:'rgba(255,200,50,0.4)' },
      { type:'member',      x:40,  y:252, w:310, h:300, fontSize:15, color:'#e8ecf1', borderColor:'rgba(255,200,50,0.4)', maxPlayers:20 },
      { type:'chat-body',   x:322, y:252, w:364, h:238, fontSize:14, color:'#e8ecf1', borderColor:'rgba(255,200,50,0.4)' },
      { type:'chat-input',  x:322, y:504, w:272, h:42,  label:'Type a message...', fontSize:15, color:'#fff' },
      { type:'chat-send',   x:606, y:504, w:80,  h:42,  label:'Send', fontSize:15, color:'#ffb12b' }
    ];
  },

  _setupClanCanvasUI(layout, isDefault){
    const wrap = document.getElementById('clan-canvas-wrap');
    if(!wrap){
      if(this.toast) this.toast('Please hard-refresh (Ctrl+Shift+R) to see the custom clan layout!');
      return false;
    }
    const bounds = this._getLayoutBounds(layout);
    // Fullscreen: the canvas fills the whole viewport and the layout letterboxes inside it
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const cw = Math.max(320, vw);
    const ch = Math.max(240, vh);

    const canvas = document.getElementById('clan-ui-canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';

    this._stopClanCanvasUI();

    const st = {
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      dpr: dpr,
      W: cw,
      H: ch,
      layout: layout,
      isDefault: !!isDefault,
      images: {},
      sortBy: 'name',
      draft: '',
      chatScroll: 0,
      rafId: null,
      bounds: bounds
    };
    this._clanUIState = st;

    // Make sure the cartoon web fonts are ready for canvas text
    try{
      if(document.fonts){
        Promise.all([
          document.fonts.load("24px 'Lilita One'"),
          document.fonts.load("800 18px 'Nunito'"),
          document.fonts.load("700 18px 'Fredoka'")
        ]).catch(() => {});
      }
    }catch(e){}

    // Pre-decode all PNGs in the background; each pops in as soon as it is ready
    layout.forEach(el => {
      if(el.type === 'image' && el.imageData && !st.images[el.imageData]){
        const img = new Image();
        img.onload = () => { st.images[el.imageData] = img; };
        img.onerror = () => {};
        img.src = el.imageData;
      }
    });

    wrap.classList.remove('hidden');
    document.getElementById('menu-clan-ui').classList.add('canvas-mode');
    document.getElementById('menu-clan-ui').scrollTop = 0;
    window.scrollTo(0, 0);

    canvas.onclick = (e) => this._clanUIClick(e);
    canvas.onmousemove = (e) => this._clanUIHover(e);
    canvas.onwheel = (e) => {
      const st2 = this._clanUIState;
      if(!st2 || !st2.layout) return;
      const body = st2.layout.find(x => x.type === 'chat-body');
      if(!body) return;
      const r = st2.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const s2 = this._clanUIScale();
      const lx = (x - s2.ox) / s2.scale;
      const ly = (y - s2.oy) / s2.scale;
      if(lx >= body.x && lx <= body.x + body.w && ly >= body.y && ly <= body.y + body.h){
        e.preventDefault();
        st2.chatScroll = (st2.chatScroll || 0) + e.deltaY / s2.scale;
      }
    };

    // Real visible textarea overlaid on the chat-input element: the browser
    // handles caret placement, arrow-key navigation, selection and copy, and
    // the canvas only draws the frame behind it.
    const inp = document.getElementById('clan-canvas-input');
    if(inp){
      const s = this._clanUIScale();
      const el = layout.find(x => x.type === 'chat-input');
      if(el){
        inp.style.left = (el.x * s.scale + s.ox) + 'px';
        inp.style.top  = (el.y * s.scale + s.oy) + 'px';
        inp.style.width  = (el.w * s.scale) + 'px';
        inp.style.height = ((el.h + 14) * s.scale) + 'px';
        inp.style.fontSize = (el.fontSize || 15) + 'px';
        inp.placeholder = el.label || 'Type a message...';
      }
      const ph = document.getElementById('clan-canvas-ph');
      if(ph){
        ph.style.left = (el.x * s.scale + s.ox) + 'px';
        ph.style.top  = (el.y * s.scale + s.oy) + 'px';
        ph.style.width = (el.w * s.scale) + 'px';
        ph.style.height = ((el.h + 14) * s.scale) + 'px';
        ph.style.fontSize = (el.fontSize || 15) + 'px';
        const phText = document.getElementById('clan-canvas-ph-text');
        if(phText) phText.textContent = (el.label || 'Type a message').replace(/\.+$/, '');
        const updPh = () => ph.classList.toggle('hidden', inp.value.length > 0);
        inp.addEventListener('input', updPh);
        inp.addEventListener('keyup', updPh);
        inp.addEventListener('change', updPh);
        ph.classList.remove('hidden');
        inp.placeholder = '';
      } else {
        inp.placeholder = el.label || 'Type a message...';
      }
      inp.value = '';
      inp.oninput = () => { st.draft = inp.value; this._updateClanCanvasCounter(inp, el); };
      inp.onkeydown = (e) => {
        if(e.code === 'Enter' && !e.shiftKey){
          e.preventDefault();
          this._sendChatMessage();
          inp.value = '';
          st.draft = '';
          this._updateClanCanvasCounter(inp, el);
        }
      };
      this._updateClanCanvasCounter(inp, el);
    }

    const loop = () => {
      if(document.getElementById('menu-clan-ui').classList.contains('hidden')){
        this._stopClanCanvasUI();
        return;
      }
      this._drawClanCanvasFrame();
      st.rafId = requestAnimationFrame(loop);
    };
    st.rafId = requestAnimationFrame(loop);

    // Live sync: refresh members + chat from the cloud registry while the UI is open
    this._pollClanSync();
    st.pollTimer = setInterval(() => this._pollClanSync(), 4000);

    // Measure mode (M toggles, Esc exits): click two points, the distance
    // between them shows in layout pixels so the user can report exact offsets
    st.measure = { on: false, p1: null, p2: null };
    st._keyHandler = (e) => {
      if(e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return;
      if(e.key === 'm' || e.key === 'M'){
        if(!st.measure) st.measure = { on: false, p1: null, p2: null };
        st.measure.on = !st.measure.on;
        st.measure.p1 = null;
        st.measure.p2 = null;
      } else if(e.key === 'Escape' && st.measure && st.measure.on){
        st.measure.on = false;
        st.measure.p1 = null;
        st.measure.p2 = null;
      }
    };
    window.addEventListener('keydown', st._keyHandler);

    // Yellow tip: clan chat syncs with a delay, not instantly
    const tip = document.getElementById('clan-sync-tip');
    if(tip){
      tip.classList.remove('hidden');
      if(this._clanTipTimer) clearTimeout(this._clanTipTimer);
      this._clanTipTimer = setTimeout(() => tip.classList.add('hidden'), 9000);
    }
    return true;
  },

  /* Char counter badge for the canvas chat input (hidden while empty) */
  _updateClanCanvasCounter(inp, el){
    let counter = document.getElementById('clan-canvas-counter');
    if(!counter){
      counter = document.createElement('div');
      counter.id = 'clan-canvas-counter';
      document.getElementById('clan-canvas-wrap').appendChild(counter);
    }
    const val = inp ? inp.value : '';
    if(!val || !el){
      counter.style.display = 'none';
      return;
    }
    const s = this._clanUIScale();
    const max = (inp && inp.maxLength) || 200;
    counter.textContent = val.length + '/' + max;
    counter.style.display = val.length ? 'block' : 'none';
    counter.style.left = (el.x * s.scale + s.ox + el.w * s.scale - 52) + 'px';
    counter.style.top  = (el.y * s.scale + s.oy - 20) + 'px';
  },

  _stopClanCanvasUI(){
    const st = this._clanUIState;
    if(st && st.rafId) cancelAnimationFrame(st.rafId);
    if(st && st.pollTimer) clearInterval(st.pollTimer);
    if(st && st._keyHandler) window.removeEventListener('keydown', st._keyHandler);
    this._clanUIState = null;
    const counter = document.getElementById('clan-canvas-counter');
    if(counter) counter.style.display = 'none';
    const tip = document.getElementById('clan-sync-tip');
    if(tip) tip.classList.add('hidden');
    if(this._clanTipTimer){ clearTimeout(this._clanTipTimer); this._clanTipTimer = null; }
    const wrap = document.getElementById('clan-canvas-wrap');
    if(wrap) wrap.classList.add('hidden');
    const menu = document.getElementById('menu-clan-ui');
    if(menu) menu.classList.remove('canvas-mode');
  },

  _getLayoutBounds(layout){
    let maxW = 800, maxH = 600;
    layout.forEach(el => {
      maxW = Math.max(maxW, el.x + el.w);
      maxH = Math.max(maxH, el.y + el.h);
    });
    return { maxW: maxW, maxH: maxH };
  },

  _clanUIScale(){
    const st = this._clanUIState;
    const scale = Math.min(st.W / st.bounds.maxW, st.H / st.bounds.maxH);
    const ox = (st.W - st.bounds.maxW * scale) / 2;
    const oy = (st.H - st.bounds.maxH * scale) / 2;
    return { scale: scale, ox: ox, oy: oy };
  },

  _drawClanCanvasFrame(){
    const st = this._clanUIState;
    if(!st) return;
    const ctx = st.ctx;
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.clearRect(0, 0, st.W, st.H);
    ctx.fillStyle = '#14181e';
    ctx.fillRect(0, 0, st.W, st.H);

    const s = this._clanUIScale();
    ctx.save();
    ctx.translate(s.ox, s.oy);
    ctx.scale(s.scale, s.scale);
    const t = Date.now() / 1000;
    const self = this;
    // Images act as the background layer: draw them first so UI elements sit on top
    st.layout.forEach(el => { if(el.type === 'image') self._drawClanUIElement(el, ctx, t); });
    st.layout.forEach(el => { if(el.type !== 'image') self._drawClanUIElement(el, ctx, t); });
    ctx.restore();

    // Measure mode: grid + crosshair + point markers over the layout, and a
    // status bar with the exact pixel distances
    if(st.measure && st.measure.on){
      ctx.save();
      ctx.translate(s.ox, s.oy);
      ctx.scale(s.scale, s.scale);
      this._clanDrawMeasureOverlay(ctx, st);
      ctx.restore();
      this._clanDrawMeasureBar(ctx, st);
    }

    // Notice when no custom layout was found (user designed one in the Clan Editor)
    if(st.isDefault && !(st.measure && st.measure.on)){
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(0, st.H - 30, st.W, 30);
      ctx.fillStyle = '#ffb12b';
      ctx.font = "16px 'Lilita One', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        'Showing default layout \u2014 your Clan Editor design was not saved. Open Codes menu \u2192 editor123, design it, click Save, then reopen your clan.',
        st.W / 2, st.H - 15);
    }
  },

  _drawClanUIElement(el, ctx, t){
    const st = this._clanUIState;
    const hcol = el.borderColor || 'rgba(255,200,50,0.5)';
    const col = el.color || '#ffffff';
    const txtCol = el.placeholderColor || col;
    const fs = el.fontSize || 14;
    const boldFont = 'bold ' + fs + 'px Segoe UI, sans-serif';
    const baseFont = fs + 'px Segoe UI, sans-serif';
    const sf = el.showFrame !== false;
    const s = this.settings;
    const clan = this._clanData || { name: 'CLAN', members: [], chat: [] };
    const playerName = s.playerName || 'Player';

    const drawFrame = () => {
      if(!sf) return;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = hcol;
      ctx.lineWidth = 2;
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      ctx.setLineDash([]);
    };

    if(el.type === 'badge'){
      const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
      const r = Math.min(el.w, el.h) / 2;
      const pulse = 1 + Math.sin(t * 2.4) * 0.06;
      ctx.beginPath();
      ctx.arc(cx, cy, r * pulse, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,177,43,0.12)';
      ctx.fill();
      ctx.strokeStyle = hcol;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = txtCol;
      ctx.font = boldFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(el.label || '\u{1F3C6}', cx, cy);

    } else if(el.type === 'chat-body'){
      // Dark gray cartoon panel with a chunky light-gray border
      this._clanCartoonPanel(ctx, el.x, el.y, el.w, el.h, 18, '#3a3f49', '#262a31');
      const msgs = clan.chat || [];
      const gap = (el.gap !== undefined ? el.gap : 8);
      const lineH = fs * 1.4;
      const bubPad = 10;
      const avatarR = Math.max(10, fs * 0.55);
      const wrapW = Math.max(40, el.w - 52);
      // Build message bubbles (newest first) with pre-wrapped text
      const bubbles = [];
      for(let i = msgs.length - 1; i >= 0; i--){
        const m = msgs[i];
        const isSys = m.rank === 'owner' && m.name === 'System';
        const nameCol = isSys ? '#9b59b6' : (m.rank === 'owner' ? '#ff6b6b' : (m.rank === 'admin' ? '#ffd24a' : (m.rank && m.rank !== '-' && m.rank !== 'none' ? '#ffb12b' : '#3aa0ff')));
        const rankTag = (m.rank === 'owner' || m.rank === 'admin') ? '[' + m.rank.toUpperCase() + '] ' : '';
        const nameStr = isSys ? 'SYSTEM' : (rankTag + (m.name || '?'));
        ctx.font = '800 ' + (fs * 0.92) + "px 'Nunito', sans-serif";
        const lines = this._clanUIBreakText(ctx, (m.msg || ''), wrapW);
        const txtH = Math.max(lines.length, 1) * lineH;
        const h = bubPad + fs * 1.5 + 6 + txtH + bubPad;
        bubbles.push({ m, nameCol, nameStr, lines, h, isSys });
        if(bubbles.length > 80) break;
      }
      bubbles.reverse(); // oldest first for the stack walk
      // Stacked bubbles: consecutive messages from the same sender share a
      // tighter gap so they read as one block
      const gapArr = bubbles.map(() => gap);
      for(let i = 0; i < bubbles.length - 1; i++){
        const a = bubbles[i], b = bubbles[i + 1];
        if(a.m.name === b.m.name && a.m.rank === b.m.rank) gapArr[i] = 4;
      }
      let totalH = 0;
      for(let i = 0; i < bubbles.length; i++) totalH += bubbles[i].h + gapArr[i];
      if(bubbles.length) totalH -= gapArr[bubbles.length - 1];
      const viewH = el.h - 14;
      const maxScroll = Math.max(0, totalH - viewH);
      st.chatScroll = Math.max(0, Math.min(st.chatScroll || 0, maxScroll));
      // Draw NEWEST first, stacking UP from the bottom edge so a fresh
      // message always appears inside the window (bubbles may never go
      // below the panel, so nothing leaks over the input row)
      ctx.save();
      ctx.beginPath();
      this._clanUIRoundRect(ctx, el.x + 1, el.y + 1, el.w - 2, el.h - 2, 16);
      ctx.clip();
      let y = el.y + el.h - 10 - (st.chatScroll || 0);
      for(let i = bubbles.length - 1; i >= 0; i--){
        const b = bubbles[i];
        y -= b.h;
        const top = y;
        y -= gapArr[i];
        if(top + b.h <= el.y + 4) continue;
        // Dark cartoon bubble card with drop shadow + light-gray outline
        const bx = el.x + 8, bw = el.w - 16;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        this._clanUIRoundRect(ctx, bx, top + 3, bw, b.h, 14);
        ctx.fill();
        ctx.fillStyle = b.isSys ? '#3a3550' : '#333842';
        ctx.beginPath();
        this._clanUIRoundRect(ctx, bx, top, bw, b.h, 14);
        ctx.fill();
        ctx.strokeStyle = '#4a505c';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        this._clanUIRoundRect(ctx, bx + 1.25, top + 1.25, bw - 2.5, b.h - 2.5, 12.75);
        ctx.stroke();
        // Nickname line starts near the bubble's left edge; grows right with
        // the timestamp following it (Discord-style, never spread out)
        const nameX = bx + bubPad + 8;
        const nameLineX = nameX;
        ctx.font = (fs * 0.95) + "px 'Lilita One', sans-serif";
        ctx.fillStyle = b.nameCol;
        ctx.fillText(b.nameStr, nameLineX, top + bubPad + 14);
        if(b.m.ts){
          const dt = new Date(b.m.ts);
          const tStr = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
          ctx.font = (fs * 0.68) + "px 'Nunito', sans-serif";
          ctx.fillStyle = 'rgba(220,228,235,0.45)';
          ctx.fillText(tStr, nameLineX + ctx.measureText(b.nameStr).width + 10, top + bubPad + 18);
        }
        // Message text (chunky rounded body font) — starts right after the
        // avatar block with breathing room below the sender name; owner's
        // messages are red, admin's are yellow
        ctx.font = '800 ' + (fs * 0.92) + "px 'Nunito', sans-serif";
        ctx.fillStyle = b.isSys ? '#b48fd9' : (b.m.rank === 'owner' ? '#ff6b6b' : (b.m.rank === 'admin' ? '#ffd24a' : '#e8ecf1'));
        let ty = top + bubPad + fs * 1.5 + 6;
        for(const ln of b.lines){
          ctx.fillText(ln, nameX, ty);
          ty += lineH;
        }
      }
      ctx.restore();
      // Scrollbar hint when history overflows the box
      if(maxScroll > 1 && totalH > viewH){
        const barH = Math.max(18, viewH * (viewH / totalH));
        const barY = el.y + 8 + (viewH - barH) * ((st.chatScroll || 0) / maxScroll);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.beginPath();
        this._clanUIRoundRect(ctx, el.x + el.w - 8, barY, 5, barH, 2.5);
        ctx.fill();
      }

    } else if(el.type === 'chat-input'){
      // The real textarea (#clan-canvas-input) renders the typing UI — caret,
      // selection, wrapping rows, placeholder. Nothing to draw on canvas.

    } else if(el.type === 'chat-send'){
      // Invisible: the real send button is a PNG image drawn on top.
      // Only the hitbox stays active (clicks still send the message).

    } else if(el.type === 'member'){
      this._clanCartoonPanel(ctx, el.x, el.y, el.w, el.h, 16, '#3a3f49', '#262a31');
      ctx.font = (fs * 0.95) + "px 'Lilita One', sans-serif";
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      let items = (clan.members || []).map(m => ({
        name: m.name,
        rank: m.rank || 'member',
        xp: (m.name === playerName ? (s.clanWeeklyXP || 0) : (m.xp || 0)),
        lastSeen: m.lastSeen || 0
      }));
      if(items.length === 0) items = [{ name: clan.owner || 'Owner', rank: 'owner', xp: 0, lastSeen: 0 }];
      const sortBy = st.sortBy;
      if(sortBy === 'xp') items.sort((a, b) => b.xp - a.xp);
      else items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      const maxP = el.maxPlayers || 20;
      const myRankHere = this._getPlayerRank();
      const myHere = this.settings.playerName || 'Player';
      st.memberPills = null;
      const pills = [];
      let rowCount = 0;
      for(let mi = 0; mi < Math.min(items.length, maxP); mi++){
        const my = el.y + 15 + mi * (fs + 16);
        if(my + fs + 10 > el.y + el.h - 6) break;
        rowCount++;
        const it = items[mi];
        const tagCol = it.rank === 'owner' ? '#ff6b6b' : (it.rank === 'admin' ? '#ffd24a' : (it.rank === 'co-leader' ? '#ffb12b' : '#e8ecf1'));
        // Presence dot (green online / red offline) + tiny label above it
        const online = it.name === myHere || (Date.now() - it.lastSeen < 90000);
        const pcol = online ? '#34d399' : '#f87171';
        ctx.font = "7px 'Nunito', sans-serif";
        ctx.textAlign = 'center';
        ctx.fillStyle = pcol;
        ctx.fillText(online ? 'online' : 'offline', el.x + 24, my);
        ctx.beginPath();
        ctx.arc(el.x + 24, my + 14, 6, 0, Math.PI * 2);
        ctx.fillStyle = pcol;
        ctx.fill();
        ctx.strokeStyle = '#4a505c';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.textAlign = 'left';
        // Rank tags only for OWNER / ADMIN (member + co-leader show plain names)
        const tagStr = (it.rank === 'owner' || it.rank === 'admin') ? '[' + it.rank.toUpperCase() + '] ' : '';
        ctx.font = (fs * 0.95) + "px 'Lilita One', sans-serif";
        ctx.fillStyle = tagCol;
        const tw = tagStr ? ctx.measureText(tagStr).width : 0;
        ctx.fillText(tagStr, el.x + 46, my);
        // XP is shown on both sort filters
        ctx.font = (fs * 0.8) + "px 'Nunito', sans-serif";
        ctx.textAlign = 'right';
        ctx.fillStyle = '#c3ccd8';
        ctx.fillText(String(it.xp) + ' xp', el.x + el.w - 16, my + 4);
        ctx.textAlign = 'left';
        ctx.font = (fs * 0.95) + "px 'Lilita One', sans-serif";
        let fillW = el.w - 16 - 46 - tw - 64;
        if(st.memberActions === it.name) fillW -= 86;
        /* Truncate to fit with a BINARY search.
           This stripped one character at a time, re-measuring each time, for
           every member, on every frame of the clan screen's rAF loop. With a
           100-member clan that is thousands of synchronous text-shaping calls
           per frame -- the single worst offender behind the "menu freezes"
           half of this. Binary search does it in ~log2(len) measurements. */
        let nStr = it.name;
        if(ctx.measureText(nStr).width > fillW && nStr.length > 1){
          let lo = 1, hi = nStr.length - 1, best = 1;
          while(lo <= hi){
            const mid = (lo + hi) >> 1;
            if(ctx.measureText(nStr.slice(0, mid)).width <= fillW){ best = mid; lo = mid + 1; }
            else hi = mid - 1;
          }
          nStr = nStr.slice(0, best) + '\u2026';
        }
        ctx.fillStyle = '#e8ecf1';
        ctx.fillText(nStr, el.x + 46 + tw, my);
        // Action pills for owners (admin toggle + kick) and admins (kick only)
        const canKick = (myRankHere === 'owner' || myRankHere === 'admin') &&
          it.name !== myHere && it.rank !== 'owner' && (myRankHere === 'owner' || it.rank !== 'admin');
        const canAdmin = myRankHere === 'owner' && it.name !== myHere && it.rank !== 'owner';
        if(st.memberActions === it.name && (canKick || canAdmin)){
          const acts = [];
          if(canAdmin) acts.push({ label: it.rank === 'admin' ? 'DEMOTE' : 'ADMIN', act: 'rank', col: '#ffb12b' });
          if(canKick) acts.push({ label: 'KICK', act: 'kick', col: '#f87171' });
          let ex = el.x + el.w - 16;
          const ph = fs * 0.72 + 8, py = my - 1;
          ctx.font = (fs * 0.72) + "px 'Nunito', sans-serif";
          for(let ai = acts.length - 1; ai >= 0; ai--){
            const a = acts[ai];
            const aw = ctx.measureText(a.label).width + 16;
            const rx = ex - aw;
            ctx.fillStyle = '#2b2f3d';
            ctx.beginPath();
            this._clanUIRoundRect(ctx, rx, py, aw, ph, 7);
            ctx.fill();
            ctx.strokeStyle = '#4a505c';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            this._clanUIRoundRect(ctx, rx + 0.75, py + 0.75, aw - 1.5, ph - 1.5, 6.25);
            ctx.stroke();
            ctx.fillStyle = a.col;
            ctx.textAlign = 'center';
            ctx.fillText(a.label, rx + aw / 2, py + (ph - fs * 0.72) / 2);
            ctx.textAlign = 'left';
            pills.push({ name: it.name, act: a.act, x: rx, y: py, w: aw, h: ph });
            ex = rx - 6;
          }
        }
      }
      st.memberPills = pills;
      if(rowCount === 0){
        ctx.fillStyle = '#c3ccd8';
        ctx.font = (fs * 0.8) + "px 'Nunito', sans-serif";
        ctx.fillText('No members yet', el.x + 24, el.y + 16);
      }

    } else if(el.type === 'progress-bar'){
      const barR = Math.min(12, el.h / 2);
      ctx.fillStyle = '#1d2126';
      ctx.beginPath();
      this._clanUIRoundRect(ctx, el.x, el.y, el.w, el.h, barR);
      ctx.fill();
      ctx.strokeStyle = '#4a505c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      this._clanUIRoundRect(ctx, el.x + 1.5, el.y + 1.5, el.w - 3, el.h - 3, barR - 1);
      ctx.stroke();
      const cap = (typeof CLAN_XP_CAP !== 'undefined') ? CLAN_XP_CAP : 10000;
      const pct = Math.max(0, Math.min(100, (s.clanWeeklyXP || 0) / cap * 100));
      if(pct > 0){
        const grad = ctx.createLinearGradient(el.x, 0, el.x + el.w, 0);
        grad.addColorStop(0, '#ffd34d');
        grad.addColorStop(1, '#ff9f1c');
        ctx.fillStyle = grad;
        ctx.save();
        ctx.beginPath();
        this._clanUIRoundRect(ctx, el.x + 2, el.y + 2, el.w - 4, el.h - 4, barR - 1);
        ctx.clip();
        ctx.fillRect(el.x + 2, el.y + 2, (el.w - 4) * (pct / 100), el.h - 4);
        ctx.restore();
      }
      this._clanOutlineText(ctx, Math.round(pct) + '%', el.x + el.w / 2, el.y + el.h / 2, (el.h * 0.55) + "px 'Lilita One', sans-serif", '#ffffff', '#2b2f3d', 'center', 'middle', 3);

    } else if(el.type === 'xp-counter'){
      // Full cartoon card behind the number + label so the counter never
      // looks like a background that only covers half the element
      this._clanCartoonPanel(ctx, el.x, el.y, el.w, el.h, 16, '#3a3f49', '#262a31');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let vSize = el.fontSize || 28;
      const vStr = String(s.clanWeeklyXP || 0);
      while(ctx.measureText(vStr).width > el.w - 6 && vSize > 9){
        vSize--;
        ctx.font = vSize + "px 'Lilita One', sans-serif";
      }
      this._clanOutlineText(ctx, vStr, el.x + el.w / 2, el.y + el.h * 0.42, vSize + "px 'Lilita One', sans-serif", '#ff9f1c', '#14181e', 'center', 'middle', Math.max(2, vSize / 5));
      ctx.globalAlpha = 0.85;
      const lStr = el.label || 'xp';
      let lSize = Math.max(8, Math.min(el.fontSize || 14, vSize * 0.55));
      ctx.font = lSize + "px 'Nunito', sans-serif";
      while(ctx.measureText(lStr).width > el.w - 6 && lSize > 8){
        lSize--;
        ctx.font = lSize + "px 'Nunito', sans-serif";
      }
      ctx.fillStyle = '#aeb8c4';
      ctx.fillText(lStr, el.x + el.w / 2, el.y + el.h * 0.78);
      ctx.globalAlpha = 1;

    } else if(el.type === 'clan-count'){
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      this._clanOutlineText(ctx, String((clan.members || []).length), el.x + el.w / 2, el.y + el.h * 0.36, (el.fontSize || 28) + "px 'Lilita One', sans-serif", '#ff9f1c', '#14181e', 'center', 'middle', 3);
      ctx.globalAlpha = 0.8;
      ctx.font = Math.max(9, (el.fontSize || 28) * 0.42) + "px 'Nunito', sans-serif";
      ctx.fillStyle = '#aeb8c4';
      ctx.fillText(el.label || 'Members', el.x + el.w / 2, el.y + el.h * 0.78);
      ctx.globalAlpha = 1;

    } else if(el.type === 'sort-buttons'){
      const curSort = st.sortBy;
      const btnPad = 20, bh = fs + 12;
      const totalW = Math.max(el.w, btnPad + 2);
      const btnW = (totalW - btnPad) / 2;
      const by = el.y + (el.h - bh) / 2;
      ['Name', 'XP'].forEach((label, idx) => {
        const bx = el.x + (idx === 0 ? 10 : 10 + btnW + 4);
        const isActive = label.toLowerCase() === curSort;
        ctx.fillStyle = 'rgba(43,47,61,0.18)';
        ctx.beginPath();
        this._clanUIRoundRect(ctx, bx, by + 3, btnW, bh, 10);
        ctx.fill();
        ctx.fillStyle = isActive ? '#ffb12b' : '#2e333c';
        ctx.beginPath();
        this._clanUIRoundRect(ctx, bx, by, btnW, bh, 10);
        ctx.fill();
        ctx.strokeStyle = '#4a505c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        this._clanUIRoundRect(ctx, bx + 1, by + 1, btnW - 2, bh - 2, 9);
        ctx.stroke();
        ctx.fillStyle = isActive ? '#14181e' : '#c3ccd8';
        ctx.font = (fs * 0.72) + "px 'Lilita One', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + btnW / 2, by + bh / 2 + 1);
      });

    } else if(el.type === 'clan-name'){
      const chipW = Math.min(el.w, ctx.measureText((clan.name || 'CLAN').toUpperCase()).width + 40);
      ctx.fillStyle = 'rgba(38,42,49,0.85)';
      ctx.beginPath();
      this._clanUIRoundRect(ctx, el.x + el.w / 2 - chipW / 2, el.y + 2, chipW, el.h - 4, 12);
      ctx.fill();
      ctx.strokeStyle = '#4a505c';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      this._clanUIRoundRect(ctx, el.x + el.w / 2 - chipW / 2 + 1.25, el.y + 3.25, chipW - 2.5, el.h - 6.5, 10.75);
      ctx.stroke();
      this._clanOutlineText(ctx, (clan.name || 'CLAN').toUpperCase(), el.x + el.w / 2, el.y + el.h / 2, (el.fontSize || 35) + "px 'Lilita One', sans-serif", '#ff9f1c', '#14181e', 'center', 'middle', 4);

    } else if(el.type === 'time-left'){
      const now = new Date();
      const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
      const nextMonday = new Date(now);
      nextMonday.setDate(now.getDate() + daysUntilMonday);
      nextMonday.setHours(0, 0, 0, 0);
      const ms = nextMonday - now;
      const tStr = Math.floor(ms / 86400000) + 'd ' + Math.floor((ms % 86400000) / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm left';
      const chipW = Math.min(el.w, ctx.measureText(tStr).width + 28);
      ctx.fillStyle = 'rgba(38,42,49,0.85)';
      ctx.beginPath();
      this._clanUIRoundRect(ctx, el.x + el.w - chipW - 6, el.y + 2, chipW, el.h - 4, 12);
      ctx.fill();
      ctx.strokeStyle = '#4a505c';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      this._clanUIRoundRect(ctx, el.x + el.w - chipW - 6 + 1.25, el.y + 3.25, chipW - 2.5, el.h - 6.5, 10.75);
      ctx.stroke();
      ctx.fillStyle = '#cfd6e0';
      ctx.font = (fs * 0.95) + "px 'Nunito', sans-serif";
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(tStr, el.x + el.w - 10, el.y + el.h / 2);

    } else if(el.type === 'text'){
      ctx.fillStyle = txtCol;
      let style = '';
      if(el.bold) style += 'bold ';
      if(el.italic) style += 'italic ';
      ctx.font = style + fs + "px " + (el.bold ? "'Lilita One', sans-serif" : "'Nunito', sans-serif");
      ctx.textAlign = el.align || 'center';
      ctx.textBaseline = 'middle';
      let tx = el.x;
      if(ctx.textAlign === 'center') tx = el.x + el.w / 2;
      else if(ctx.textAlign === 'right') tx = el.x + el.w;
      ctx.fillText(el.label || '', tx, el.y + el.h / 2);

    } else if(el.type === 'image'){
      if(el.imageData && st.images[el.imageData]){
        ctx.drawImage(st.images[el.imageData], el.x, el.y, el.w, el.h);
      } else {
        drawFrame();
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(el.x, el.y, el.w, el.h);
      }
    }
  },

  /* Measure-mode overlay (drawn in layout units): 10px grid, crosshair,
     clicked points and the exact ΔX / ΔY between them */
  _clanDrawMeasureOverlay(ctx, st){
    let maxX = 800, maxY = 600;
    st.layout.forEach(el => {
      maxX = Math.max(maxX, el.x + el.w);
      maxY = Math.max(maxY, el.y + el.h);
    });
    maxX = Math.ceil(maxX / 100) * 100;
    maxY = Math.ceil(maxY / 100) * 100;
    for(let gx = 0; gx <= maxX; gx += 10){
      ctx.strokeStyle = (gx % 100 === 0) ? 'rgba(255,255,255,0.20)'
                       : (gx % 50 === 0)  ? 'rgba(255,255,255,0.10)'
                       : 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, maxY);
      ctx.stroke();
    }
    for(let gy = 0; gy <= maxY; gy += 10){
      ctx.strokeStyle = (gy % 100 === 0) ? 'rgba(255,255,255,0.20)'
                       : (gy % 50 === 0)  ? 'rgba(255,255,255,0.10)'
                       : 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(maxX, gy);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,177,43,0.55)';
    ctx.font = "11px 'Nunito', sans-serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for(let gx = 100; gx < maxX; gx += 100) ctx.fillText(String(gx), gx + 2, 2);
    for(let gy = 100; gy < maxY; gy += 100) ctx.fillText(String(gy), 2, gy + 2);
    // Crosshair at the pointer
    const h = st.hover;
    if(h){
      ctx.strokeStyle = 'rgba(255,177,43,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(h.x, 0);
      ctx.lineTo(h.x, maxY);
      ctx.moveTo(0, h.y);
      ctx.lineTo(maxX, h.y);
      ctx.stroke();
    }
    // Markers + distance readout
    const m = st.measure;
    const pt = (p, label) => {
      ctx.fillStyle = 'rgba(255,177,43,0.9)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#14181e';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = '#14181e';
      ctx.font = "12px 'Nunito', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, p.x, p.y + 0.5);
    };
    if(m.p1) pt(m.p1, 'A');
    if(m.p2) pt(m.p2, 'B');
    if(m.p1 && m.p2){
      const dx = Math.round(m.p2.x - m.p1.x);
      const dy = Math.round(m.p2.y - m.p1.y);
      ctx.strokeStyle = 'rgba(255,177,43,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(m.p1.x, m.p1.y);
      ctx.lineTo(m.p2.x, m.p2.y);
      ctx.stroke();
      const mx = (m.p1.x + m.p2.x) / 2 + 12;
      const my = (m.p1.y + m.p2.y) / 2 - 12;
      ctx.font = "14px 'Lilita One', sans-serif";
      const line1 = 'DX ' + dx + ' px';
      const line2 = 'DY ' + dy + ' px';
      const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 16;
      ctx.fillStyle = 'rgba(14,17,22,0.88)';
      ctx.strokeStyle = 'rgba(255,177,43,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      this._clanUIRoundRect(ctx, mx, my - 26, w, 44, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffb12b';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(line1, mx + 8, my - 22);
      ctx.fillText(line2, mx + 8, my - 4);
    }
  },

  /* Measure-mode status bar (drawn in device pixels) */
  _clanDrawMeasureBar(ctx, st){
    const W = st.W, H = st.H;
    const m = st.measure;
    ctx.fillStyle = 'rgba(14,17,22,0.92)';
    ctx.fillRect(0, H - 52, W, 44);
    ctx.fillStyle = 'rgba(255,177,43,0.55)';
    ctx.fillRect(0, H - 52, W, 2);
    const parts = ['MEASURE MODE — M off · Esc clear'];
    if(m.p1) parts.push('A (' + m.p1.x + ',' + m.p1.y + ')');
    if(m.p2){
      parts.push('B (' + m.p2.x + ',' + m.p2.y + ')');
      parts.push('DX ' + Math.round(m.p2.x - m.p1.x) + ' px');
      parts.push('DY ' + Math.round(m.p2.y - m.p1.y) + ' px');
    }
    ctx.font = "16px 'Lilita One', sans-serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffb12b';
    ctx.fillText(parts.join('   |   '), 16, H - 30);
    // Hovered element info + cursor coords
    let info = 'cursor: --, --';
    if(st.hover){
      info = 'cursor: ' + Math.round(st.hover.x) + ',' + Math.round(st.hover.y);
      for(let i = st.layout.length - 1; i >= 0; i--){
        const el = st.layout[i];
        if(st.hover.x >= el.x && st.hover.x <= el.x + el.w && st.hover.y >= el.y && st.hover.y <= el.y + el.h){
          info += '   element: ' + el.type + ' x:' + Math.round(el.x) + ' y:' + Math.round(el.y) + ' w:' + Math.round(el.w) + ' h:' + Math.round(el.h);
          break;
        }
      }
    }
    ctx.font = "13px 'Nunito', sans-serif";
    ctx.fillStyle = '#e8ecf1';
    ctx.fillText(info, 16, H - 12);
  },

  _clanUIHit(e, skipEl){
    const st = this._clanUIState;
    if(!st) return null;
    const r = st.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const s = this._clanUIScale();
    const lx = (x - s.ox) / s.scale;
    const ly = (y - s.oy) / s.scale;
    for(let i = st.layout.length - 1; i >= 0; i--){
      const el = st.layout[i];
      if(el === skipEl) continue;
      if(lx >= el.x && lx <= el.x + el.w && ly >= el.y && ly <= el.y + el.h) return el;
    }
    return null;
  },

  _clanUIClick(e){
    const st = this._clanUIState;
    if(st && st.measure && st.measure.on){
      const h = st.hover;
      if(!h) return;
      const pt = { x: Math.round(h.x), y: Math.round(h.y) };
      if(!st.measure.p1) st.measure.p1 = pt;
      else if(!st.measure.p2) st.measure.p2 = pt;
      else { st.measure.p1 = pt; st.measure.p2 = null; }
      return;
    }
    // Images (PNG buttons, backgrounds) are drawn on top but only the
    // chat-send button is interactive: clicks on decorative/background PNGs
    // must fall through to the real element underneath
    let el = this._clanUIHit(e);
    while(el && el.type === 'image'){
      const r = st.canvas.getBoundingClientRect();
      const s = this._clanUIScale();
      const lx = (e.clientX - r.left - s.ox) / s.scale;
      const ly = (e.clientY - r.top - s.oy) / s.scale;
      const send = st.layout.find(x => x.type === 'chat-send');
      if(send && lx >= send.x && lx <= send.x + send.w && ly >= send.y && ly <= send.y + send.h){
        this._sendChatMessage();
        const inp = document.getElementById('clan-canvas-input');
        if(inp){ inp.value = ''; st.draft = ''; }
        return;
      }
      el = this._clanUIHit(e, el);
    }
    if(!el) return;
    if(el.type === 'sort-buttons'){
      const s = this._clanUIScale();
      const r = st.canvas.getBoundingClientRect();
      const lx = (e.clientX - r.left - s.ox) / s.scale;
      const btnPad = 20, bh = (el.fontSize || 14) + 10;
      const btnW = (Math.max(el.w, btnPad + 2) - btnPad) / 2;
      st.sortBy = (lx < el.x + 10 + btnW) ? 'name' : 'xp';
      if(Audio && Audio.click) Audio.click();
    } else if(el.type === 'member'){
      const s = this._clanUIScale();
      const r = st.canvas.getBoundingClientRect();
      const lx = (e.clientX - r.left - s.ox) / s.scale;
      const ly = (e.clientY - r.top - s.oy) / s.scale;
      // Open action pills take priority over the row click
      if(st.memberActions && st.memberPills && st.memberPills.length){
        for(const p of st.memberPills){
          if(lx >= p.x && lx <= p.x + p.w && ly >= p.y && ly <= p.y + p.h){
            this._clanMemberAction(p.name, p.act);
            st.memberActions = null;
            st.memberPills = null;
            return;
          }
        }
      }
      const clan2 = this._clanData || { members: [] };
      const me2 = this.settings.playerName || 'Player';
      const fs2 = el.fontSize || 14;
      const idx = Math.floor((ly - (el.y + 15)) / (fs2 + 16));
      if(idx >= 0 && idx < (clan2.members || []).length){
        const it = clan2.members[idx];
        const myRank2 = this._getPlayerRank();
        const can = (myRank2 === 'owner' || myRank2 === 'admin') &&
          it.name !== me2 && it.rank !== 'owner' && (myRank2 === 'owner' || it.rank !== 'admin');
        st.memberActions = (st.memberActions === it.name) ? null : (can ? it.name : null);
      } else {
        st.memberActions = null;
      }
    } else if(el.type === 'chat-input'){
      const inp = document.getElementById('clan-canvas-input');
      if(inp) inp.focus();
    } else if(el.type === 'chat-send'){
      this._sendChatMessage();
      const inp = document.getElementById('clan-canvas-input');
      if(inp){ inp.value = ''; st.draft = ''; }
    }
  },

  /* ==========================================================================
     THE SEARCH LOCK

     Shown when the player tries to change mode while a search is running.

     The lock is not a punishment and it is not silent. It says three things:
     that you are searching, why the choice is unavailable, and exactly how to
     undo it — because a disabled control with no explanation is the thing that
     makes a menu feel broken. The PLAY button is the cancel, and it is already
     labelled with the running timer, so the exit is the control the player is
     already looking at.
     ========================================================================== */
  _lockModeSelector(silent){
    const cards = document.querySelectorAll('.gm-card');
    const squares = document.querySelectorAll('.gamemode-square');
    for(const el of cards){ el.classList.add('mode-locked'); }
    for(const el of squares){ el.classList.add('mode-locked'); }

    let note = document.getElementById('mode-lock-note');
    if(!note){
      note = document.createElement('div');
      note.id = 'mode-lock-note';
      note.className = 'mode-lock-note';
      note.innerHTML =
        '<span class="mode-lock-icon" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
          'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
          '<rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/>' +
          '<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>' +
        '</svg>' +
        '</span>' +
        '<span class="mode-lock-text">' +
          '<b>Searching for players</b>' +
          '<i>The mode is locked until the match is found.</i>' +
        '</span>' +
        '<button class="mode-lock-cancel" id="mode-lock-cancel">Cancel search</button>';
      /* Appended to the mode list itself so it sits inside the panel the player
         just clicked, not floating over a different screen. */
      const host = document.querySelector('.gm-cards') || document.body;
      host.appendChild(note);
      const btn = document.getElementById('mode-lock-cancel');
      if(btn) btn.onclick = ()=>{ try { this._cancelSearch(); } catch(e){} };
    }
    note.classList.remove('hide');
    /* `silent` is the search STARTING, which the timer on the PLAY button
       already says out loud. A toast there would announce a lock nobody has
       tried yet. Refused clicks are the opposite case: the player did something
       and got nothing back, so it has to answer them. */
    if(silent) return;
    try { this.toast('Searching — cancel the search to change mode'); } catch(e){}
    /* Re-shown on every attempt so it re-animates in rather than sitting there
       having already played its entrance while the player was looking at the
       cards and not at it. */
    note.classList.remove('show');
    void note.offsetWidth;
    note.classList.add('show');
  },

  _unlockModeSelector(){
    document.querySelectorAll('.mode-locked').forEach(el => el.classList.remove('mode-locked'));
    const note = document.getElementById('mode-lock-note');
    if(note) note.classList.add('hide');
  },

  _closeTrophyMenu(){
    const pop = document.getElementById('pcard-trophy-pop');
    if(pop) pop.classList.add('hidden');
    /* The two document-level listeners are removed here rather than left to the
       overlay's own teardown. _renderProfileCard re-binds them every time the
       screen is drawn, so a visit that did not remove the previous pair would
       stack another listener per visit and the menu would take several clicks
       to open after a few profile visits. */
    if(this._trophyDismiss){ document.removeEventListener('pointerdown', this._trophyDismiss, true); this._trophyDismiss = null; }
    if(this._trophyEscape){ document.removeEventListener('keydown', this._trophyEscape); this._trophyEscape = null; }
  },

  _selectGamemode(gamemode){
    if(!gamemode) return;

    /* LOCKED WHILE SEARCHING.

       Nothing used to stand between a click here and a mode change, and that is
       a real state bug, not just a UI untidiness. The search closure captured
       its mode in a local `m` when it started; this function rewrites
       `_selectedGamemode` and writes it to localStorage, and navigates back to
       the main menu. So fifteen seconds in, the button and the icon could be
       showing "Capture the Circle" while the queue that is about to hand you a
       roster was opened for Team Deathmatch. The menu would be describing a
       different game from the one you were about to be put into, and there was
       no way to see or undo it.

       Pressing PLAY again cancels the search — the button says so — and that is
       the only exit, which is what makes the lock honest rather than a trap. */
    if(this._queued){
      this._lockModeSelector();
      return;
    }

    /* Refuse a mode that has no card. Anything reaching here from a stale
       selector square or a saved value cannot be started, so it must not become
       the selection -- otherwise PLAY would launch it with no way back. */
    const card = document.querySelector('.gm-card[data-gamemode="' + gamemode + '"]');
    if(!card){ console.warn('[gamemode] not available:', gamemode); this.toast('That mode is not available yet'); return; }
    
    // Store selected gamemode (persisted) and refresh icon + tile highlight
    this._selectedGamemode = gamemode;
    localStorage.setItem('tankparty_gamemode', gamemode);
    this._syncGamemodeIcon();
    document.querySelectorAll('.gamemode-square').forEach(sq =>
      sq.classList.toggle('active', sq.dataset.gamemode === gamemode)
    );
    document.querySelectorAll('.gm-card').forEach(c =>
      c.classList.toggle('selected', c.dataset.gamemode === gamemode)
    );
    
    if(Audio && Audio.click) Audio.click();
    
    // Drop back to the main menu — the PLAY button starts the chosen mode
    this.show('menu-main');
    const names = {'random-battle':'Random Battle', 'team-deathmatch':'Team Deathmatch', 'gladiator':'Gladiator', sandbox:'Sandbox', captureTheCircle:'Capture The Circle', baseDefend:'Base Defend'};
    this.toast((names[gamemode] || gamemode) + ' selected — press PLAY');
  },

  /* ==========================================================================
     MAP VOTE CONTEXT
     Everything the vote screen needs to be multiplayer-aware in one place:
     how many real humans are in this match, which playerId to publish a vote
     under, and where the shared tally lives.

     Solo / bot-filled matches get humans = 1, which is what makes the vote
     screen end the instant a map is picked instead of sitting on a timer.
     ========================================================================== */
  _voteContext(roster){
    const humans = Math.max(1, this._matchHumans || 1);
    const canShare = humans > 1;
    return {
      multiplayer: canShare,
      humans,
      /* With the WebSocket transport the vote is pushed by the server, so a
         playerId is not required for it to be shared -- that was the old
         fetch-based precondition, and it is why two players in a real match
         still each saw "1 vote": the flag never turned on because playerId was
         null by the time the vote screen opened. */
      playerId: (typeof TDMMatchmaker !== 'undefined' && TDMMatchmaker.playerId) || null,
      code: (typeof TDMMatchmaker !== 'undefined' && TDMMatchmaker.lastMatch && TDMMatchmaker.lastMatch.code) || null,
      workerUrl: CONFIG.MATCHMAKING_URL,
      mapVote: (TDMMatchmaker.lastMatch && TDMMatchmaker.lastMatch.mapVote) || null,
    };
  },

  startSelectedGamemode(){
    /* Read through the validated selection, never straight from storage. These
       two sites are PLAY and the icon sync; both used to re-read localStorage
       directly, which meant a stale disabled mode could still be launched from
       here even after the menu had refused to select it. */
    const RAW = this._selectedGamemode || 'captureTheCircle';

    /* `random-battle` IS NOT A MODE. It is a shortcut that picks one of two real
       ones at the moment the battle is built — and that is now too late, because
       by then the player has already been MATCHED with other people. Each side
       would roll its own dice and one player would load Gladiator while the
       other loaded the Circle, in the same match.

       So the roll happens HERE, once, and the result is what gets queued, voted
       on and started. It also means a player who pressed "Random Battle" lands
       in the same queue as everyone who pressed that mode explicitly, instead
       of sitting in a queue nobody else is ever in.

       The resolved value is written back over the selection so the mode button,
       the icon and the toast all name the thing that is actually about to play.
       Leaving them saying "Random Battle" while the game starts the Circle is
       the menu lying about what you asked for, which is the same class of
       problem as the mode switcher letting you change your mind mid-search. */
    const m = (RAW === 'random-battle')
      ? (Math.random() < 0.5 ? 'gladiator' : 'captureTheCircle')
      : RAW;
    this._selectedGamemode = m;
    if(Audio && Audio.click) Audio.click();

    /* --- Queue for players FIRST, then map voting, then the battle ---
       Capture the Circle used to skip the queue entirely and drop straight
       into map voting, which is why two people pressing PLAY never met: each
       got their own private match. Both multiplayer modes now wait on the
       queue, and it is the queue that decides WHO is in the match. */
    const self = this;
    /* Kept on the Menu so the mode starter can see who the matchmaker actually
       put in this game. Without it the battle spawns a fixed roster of bots and
       the humans the queue just paired are silently dropped. */
    let roster = null;
    /* Clear the PREVIOUS match's leftovers first. These three are read by
       _voteContext and _startModeAfterVote to decide whether this run came
       through the queue. Left set, the next PLAY believes it is resuming a
       match that no longer exists: it skips queueing, hands the battle a stale
       roster, and the vote screen behaves as multiplayer when nobody is there.
       That reads to the player as "multiplayer is broken". */
    this._matchRoster = null;
    this._matchHumans = 1;
    this._votedMap = null;
    this._voteClientWaiting = false;
    const afterQueue = function(){
      self._queued = false;
      self._matchRoster = roster;
      MapVoting.showVote(function(winner){
        try {
          /* THE LOADING SCREEN GOES UP BEFORE ANYTHING ELSE HAPPENS.

             This used to be the worst-looking three seconds in the game. The
             vote overlay hides itself, and what is behind it is the main menu —
             so for the whole of the map load the player was looking at the main
             menu, which reads as "my vote was ignored and I got kicked to the
             menu", followed a few seconds later by being dropped into a
             battlefield they never saw arrive.

             On the client it was worse, because the wait is not the load. A
             client waits for the HOST's map announcement before it starts
             anything, so it sat on the main menu for that entire gap with
             nothing at all on screen to say it was still playing.

             So the screen is raised here, at the exact moment the vote ends, on
             both sides, and it stays up until Game._begin() — the one point
             where the battle is genuinely live. The client gets a different
             line of text because it is genuinely doing something different. */
          if(typeof BootLoading !== 'undefined'){
            if(self._voteClientWaiting){
              BootLoading.show('Waiting for the host to choose a map', 15);
            } else {
              BootLoading.show('Loading ' + (winner && winner.name ? winner.name : 'battlefield'), 25);
            }
          }

          /* WHO PICKS THE MAP.

             The host decides and tells the server; the server tells everyone
             else. A client used to run its own winner-picker over its own copy
             of the tally, and the two sides disagreed -- so the host loaded one
             map and the client loaded another, and each spawned into a world the
             other was not in. That is the "multiplayer is broken" report, and it
             is worse in Capture the Circle (different geometry, different
             spawns) than in TDM.

             So a client does NOT start here. It waits for the host's
             announcement and starts from that. */
          if(self._voteClientWaiting){
            self._startWhenMapKnown(m);
            return;
          }
          self._votedMap = winner;
          try {
            if(typeof Net !== 'undefined' && Net.sendChosenMap) Net.sendChosenMap(winner.id);
          } catch(e){}
          /* The vote is over; the cursors were only ever for the vote. Left
             running they would keep relaying mouse moves for the whole match,
             and the markers would sit on top of the HUD. */
          try { if (window.NetCursors) window.NetCursors.detach(); } catch (e) {}
          self._startModeAfterVote(m);
        } catch(err){
          console.error('Map vote callback error:', err);
          self.toast('Error starting match: ' + (err.message || err));
          try { if(typeof BootLoading !== 'undefined') BootLoading.hide(0); } catch(e){}
        }
      }, self._voteContext(roster));
    };

    /* EVERY MODE BUT SANDBOX GOES THROUGH THE QUEUE.

       Gladiator used to be excluded, and so, more to the point, was
       `random-battle` — which is not a mode at all but a shortcut that picks
       Gladiator or the Circle. So the default entry in the mode list went
       straight to the arena: press PLAY, no timer, no search, no indication
       that matchmaking existed anywhere in the product. That is the report.

       The exclusion was never about the mode being single-player. The server
       keys its queues by an arbitrary mode string and has no allowlist, and
       Gladiator is a ten-tank free-for-all that fills with nine bots precisely
       because nobody else was ever invited to look for players in it. Letting
       it queue costs nothing and gives it a chance at a real opponent.

       SANDBOX STAYS LOCAL, and it is the only mode that should: it is the mode
       you open to build something and try it out, and putting it behind a
       fifteen-second search would be actively hostile.

       The `tdmReady()` half of this condition is the other half of the report:
       if the transport is missing, every mode here silently skipped the queue
       and dropped into a local battle, so "no searching animation" was also
       what a broken socket looked like. It is handled further down, visibly. */
    const isMultiplayer = (m === 'gladiator' || m === 'captureTheCircle' ||
                           m === 'team-deathmatch' || m === 'baseDefend');
    if(!isMultiplayer){ afterQueue(); return; }
    if(!tdmReady()){
      /* SAID OUT LOUD, NOT SILENTLY.

         This branch used to be the other half of "there is no searching
         animation". With the transport missing, every mode skipped the queue
         and dropped straight into a local battle with no message — so a broken
         socket and a working queue looked identical to the player, and the only
         honest description of both was the feature not existing. One line of
         text is the difference between a bug report and a diagnosis. */
      try { this.toast('Matchmaking unavailable — playing locally'); } catch(e){}
      afterQueue();
      return;
    }

    /* Is anyone actually serving? Probe before queueing, because the queue has
       a 15 second bot-fill timer and failing at the end of it wastes the
       player's time and then drops them into a solo battle with no explanation.
       Offline goes straight to a normal local match for that mode. */
    _tdmServerProbe().then(function(online){
      if(!online){
        self._hidePlayCountdown();
        self.toast('Multiplayer server offline — playing locally');
        self._matchHumans = 1;
        afterQueue();
        return;
      }
      self._startQueue(m, afterQueue, function(r){ roster = r; });
    });
  },

  /* The queue half of startSelectedGamemode, split out so the reachability
     probe above can decide whether to run it at all.

     `roster` and `afterQueue` are passed in rather than closed over: afterQueue
     assigns to the `roster` variable declared in startSelectedGamemode, and a
     closure over a *parameter* of this function would have captured a different
     binding -- so _matchRoster would always have come back null and the mode
     starter would never have seen the roster it was matched with. */
  _startQueue(m, afterQueue, setRoster){
    const self = this;
    TDMMatchmaker.init(CONFIG.MATCHMAKING_URL);
    TDMMatchmaker.onMatchStart = function(matchInfo){
      self._hidePlayCountdown();
      /* Tell the countdown watchdog the match it was waiting for turned up, so
         it stands down instead of firing its stall recovery over the top of a
         match that is arriving normally. See _showPlayCountdown. */
      self._searchGotRoom = true;
      const found = (matchInfo && matchInfo.players) ? matchInfo.players : null;
      setRoster(found);
      /* Remember who we actually got matched with. The map vote screen reads
         this to decide whether anyone is really in the match: if the queue
         filled up with bots there is nobody to wait for, and picking a map
         should drop you straight into the battle. */
      /* `found`, not `roster`: the roster variable lives in
         startSelectedGamemode and is not in scope here, so reading it threw a
         ReferenceError inside this callback. The throw happened before
         afterQueue(), so the map vote never opened at all and the player was
         left staring at a dead "SEARCHING" button. */
      self._matchHumans = (typeof TDMMatchmaker.humanCount === 'function')
        ? TDMMatchmaker.humanCount(found) : 1;
      /* The host owns the simulation and opens the arena; a client waits for
         the host's first snapshot, which is what actually pulls it into the
         battle. Either way afterQueue() runs right now, so the map vote appears
         immediately instead of after a stall. */
      self._voteClientWaiting = !!(matchInfo && matchInfo.mode === 'client');

      /* Start showing the other players' cursors for the vote. A party of
         people choosing a map in separate browser windows otherwise gives no
         sign that anyone else is even there. */
      try { if (window.NetCursors) window.NetCursors.attach(); } catch (e) {}
      /* Stand the game up BEFORE the vote.

         A client that waited until the vote finished sat on an empty world for
         the whole vote -- no map, no tanks -- and then had nothing to show for
         it. Doing it here means the roster is already on the Game by the time
         the mode starter runs, so _rosterHumans() spawns the real players, and
         the client's connecting screen is up while it waits for the host. */
      try {
        if(self.game){
          if(matchInfo && matchInfo.mode === 'host'){
            self.game.startTDMHost(matchInfo.code, found, self._matchHumans);
          } else {
            self.game.startTDMClient(matchInfo.code, found, self._matchHumans);
          }
        }
      } catch(err){
        console.error('Match setup failed:', err);
      }
      afterQueue();
    };
    TDMMatchmaker.joinQueue(
      (this.settings && this.settings.playerName) || 'Player',
      (this.settings && this.settings.selectedTank) || 'coolbuddy',
      (this.settings && this.settings.playerColor) || 0x888888,
      m                                   /* players only ever meet in the same mode */
    ).then(function(res){
      if(res && res.error){
        self._hidePlayCountdown();
        self.toast(res.error);
        return;
      }
      self._queued = true;
      self._showPlayCountdown(afterQueue);
    });
  },

  /* CLIENT SIDE OF THE MAP DECISION.

     Waits for the host to announce the map, then starts on exactly that one.
     The timeout is a safety net only: if the announcement never arrives (host
     crashed mid-vote) the player is not left staring at a frozen screen, they
     get the default map and a clear message. */
  _startWhenMapKnown(m){
    const self = this;
    let done = false;
    /* Declared up front because start() clears it, and start() can run BEFORE
       the timer is ever assigned (the retained-map path below). A const
       declared further down would be in its temporal dead zone at that moment
       and clearTimeout() would throw. */
    let to = null;
    const start = function(mapId){
      if(done) return;
      done = true;
      try { if(typeof Net !== 'undefined' && Net.onMap) Net.onMap(null); } catch(e){}
      if(to) clearTimeout(to);
      const map = mapId ? MapVoting.getMapById(mapId) : null;
      if(!map){
        self.toast('Host did not choose a map — using the default');
        /* This used to ask for the id 'default', which was a roster entry with
           glb:null — a placeholder meaning "no real map". It is no longer in the
           roster, so that lookup returned null every time and _votedMap was set
           to null.

           The roster now has exactly four real models, so the honest fallback is
           a real map: the first one. Falling back to a null map means the mode
           loads whatever it defaults to, which may not be one a player voted
           for — and on a client that never saw the vote at all, that is the
           difference between the host's map and a random one. */
        const fallback = MapVoting.getMaps()[0];
        self._votedMap = fallback || null;
      } else {
        self._votedMap = map;
      }
      /* The host has spoken, so the "waiting" line on the loading screen is
         now wrong — this client is about to load the same map the host is. */
      try {
        if(typeof BootLoading !== 'undefined'){
          BootLoading.set('Loading ' + (self._votedMap ? self._votedMap.name : 'battlefield'), 45);
        }
      } catch(e){}
      try { if (window.NetCursors) window.NetCursors.detach(); } catch (e) {}
      try { self._startModeAfterVote(m); }
      catch(err){
        console.error('Start after map announcement failed:', err);
        self.toast('Could not start the battle');
        try { if(typeof BootLoading !== 'undefined') BootLoading.hide(0); } catch(e){}
      }
    };

    /* CHECK BEFORE LISTENING.

       Both vote screens finish on their own lock-in timer, independently, so
       the host's announcement frequently arrives BEFORE this client has got
       round to registering a listener for it. The message is gone, the client
       waits out its 20s timeout and then quietly loads the default map -- which
       is the desync all over again, and it looks random because it depends on
       which side's timer happened to win.

       Net.chosenMap is the retained value of that announcement, so read it
       first and only listen for anything newer. */
    try {
      if(typeof Net !== 'undefined'){
        if(Net.chosenMap){ start(Net.chosenMap); return; }
        if(Net.onMap) Net.onMap(function(mapId){ start(mapId); });
      }
    } catch(e){}

    if(done) return;
    to = setTimeout(function(){ start(null); }, 20000);
  },

  _startModeAfterVote(m){
    /* THE MODE STARTERS DROP THE NETWORK ROLE ON THE FLOOR.

       Every mode starter begins with `this.mode = 'sp'`, and several then call
       _resetArena(), which now clears the per-match network state as well. So
       by the time the arena is built, the game no longer knows it is hosting a
       match: mode is 'sp' rather than 'host', _matchRoster is null again, and
       _update()'s broadcast branch (`if(this.mode==='host')`) never runs. The
       match starts, looks completely normal locally, and is broadcast to nobody.

       That is why two players still could not play each other even once the
       queue worked: the roster was correct at vote time and then erased by the
       mode starter before the first frame.

       The fix is to make the mode starters NETWORK-AWARE rather than to patch
       each call site: _armNetMode() is called immediately before the arena is
       built, and it restores the role and roster that _resetArena just cleared.
       Solo play is untouched, because with no _netCode there is nothing to
       restore. */
    const netArm = () => {
      /* Gate on the GAME's armed match, not on Menu._netCode.

         Menu has no _netCode property at all -- the match code lives on
         Game._armedCode, written by startTDMHost/startTDMClient. So the old
         guard was false on every single call and _armNetMode was never invoked
         at all: the armLog stayed empty and the match came up as plain local
         play. Read the same field _armNetMode itself checks, and let it decide. */
      if(this.game && typeof this.game._armNetMode === 'function'){
        this.game._armNetMode(m);
      }
    };

    if(m === 'random-battle'){
      const modes = ['gladiator', 'captureTheCircle'];
      const picked = modes[Math.floor(Math.random() * modes.length)];
      netArm();
      if(picked === 'captureTheCircle'){
        this._startCaptureCircleSafely();
      } else {
        this._startGladiatorSafely();
      }
      return;
    }
    if(m === 'gladiator'){
      netArm();
      this._startGladiatorSafely();
      return;
    }
    if(m === 'captureTheCircle'){
      netArm();
      this._startCaptureCircleSafely();
      return;
    }
    if(m === 'baseDefend'){
      /* Same shape as the Circle above, and for the same two reasons: netArm()
         restores the host role and roster that _resetArena() cleared inside the
         starter, and the failure path has to leave the player at the menu rather
         than in a half-built arena they cannot escape. */
      netArm();
      this._startBaseDefendSafely();
      return;
    }
    if(m === 'team-deathmatch'){
      /* A match that came through the queue has ALREADY been formed by the
         time the map vote finishes. Reaching this point means we were matched,
         we have a roster, and re-joining the queue would put us into a second,
         different match -- dropping the pair we were just matched with.

         Only queue here when no match was ever formed (TDM reached directly,
         with no roster). */
      if(tdmReady() && this._matchRoster){
        /* Team Deathmatch is the ONE multiplayer mode whose starter is not
           routed through the netArm() calls above -- it has its own branch
           because it needs the roster check first. It needs the arm just as
           much: startTeamDeathmatch() sets mode='sp' and calls _resetArena(),
           which is exactly what wiped the host role and the roster. Without
           this line a TDM match runs locally and broadcasts to nobody, while
           Capture the Circle works. */
        netArm();
        const humans = this._matchHumans || 1;
        if(humans <= 1 && this._voteClientWaiting){
          this.toast('Connected! Host is starting the match...');
        }
        try {
          if(this.game && this._votedMap) this.game.setVotedMap(this._votedMap);
          if(this.game){
            this.game.setMatchRoster(this._matchRoster);
            this.game.startTeamDeathmatch();
          }
        } catch(err){
          console.error('Start TDM failed:', err);
          try { if(this.game) this.game.leaveToMenu(); } catch(e2){}
          this.toast('Could not start team deathmatch — back to menu');
        }
        return;
      }
      if(tdmReady()){
        TDMMatchmaker.init(CONFIG.MATCHMAKING_URL);
        TDMMatchmaker.onMatchStart = (matchInfo) => {
          this._hidePlayCountdown();
          if(matchInfo.mode === 'host'){
            try { this.game.startTeamDeathmatch(); } catch(err){
              console.error('Start TDM failed:', err);
              try { this.game.leaveToMenu(); } catch(e2){}
              this.toast('Could not start team deathmatch — back to menu');
            }
          } else {
            this.toast('Connected! Host is starting the match...');
          }
        };
        const playerName = (this.settings && this.settings.playerName) || 'Player';
        const tankId = (this.settings && this.settings.selectedTank) || 'coolbuddy';
        const color = (this.settings && this.settings.playerColor) || 0x888888;
        this._showPlayCountdown();
        TDMMatchmaker.joinQueue(playerName, tankId, color).then(result => {
          if(result.error){
            this._hidePlayCountdown();
            this.toast(result.error);
          }
        });
        return;
      }
      try {
        if(this.game) this.game.startTeamDeathmatch();
      } catch(err){
        console.error('Start Team Deathmatch failed:', err);
        try { if(this.game) this.game.leaveToMenu(); } catch(e2){}
        this.toast('Could not start team deathmatch — back to menu');
      }
      return;
    }
    if(m === 'sandbox'){
      /* Sandbox used to start a local match the instant you pressed PLAY. It is
         now a door: open a room and host up to 14 people, or walk into somebody
         else's room with a code, or play it alone. The alone case is one button
         inside the panel rather than this branch, so both routes end in the
         same place instead of two half-screens. */
      this.show('menu-sandbox');
      return;
    }
    if(m === 'multiplayer'){
      this.show('menu-multiplayer');
      return;
    }
    // Unimplemented modes (platform-king): never let PLAY dead-end —
    // fall back to Gladiator so the button always starts a match.
    this._selectedGamemode = 'gladiator';
    localStorage.setItem('tankparty_gamemode', 'gladiator');
    this._syncGamemodeIcon();
    this.toast((m === 'sandbox' ? 'Sandbox mode' : 'Platform King mode') + ' is coming soon — starting Gladiator!');
    this._startGladiatorSafely();
  },

  _startGladiatorSafely(){
    try {
      if(this.game) this.game.setUseCustomMap(this.hostCfg.useCustomMap);
      if(this.game && this._votedMap) this.game.setVotedMap(this._votedMap);
      if(this.game) this.game.startGladiator();
    } catch(err){
      console.error('Start Gladiator failed:', err);
      try { if(this.game) this.game.leaveToMenu(); } catch(e2){ console.error('menu fallback:', e2); }
      this.toast('Could not start the match — back to menu');
    }
  },

  /* ==========================================================================
     WALKING BACK INTO A BATTLE AFTER A RELOAD
     --------------------------------------------------------------------------
     The server held the player's place while their tab was gone, and answered
     the reconnect with the same room, role, seed and roster. All that is left is
     to rebuild the arena on the same map and re-arm the network role, exactly as
     a normal match start does — without going back through the queue or the
     vote, because the match they are rejoining is already running.

     If any of this throws, the session is cleared and the player is left at the
     menu rather than in a half-built arena that cannot be recovered from.
     ========================================================================== */
  _resumeIntoBattle(info){
    const G = this.game;
    if(!G || !info || !info.code){ this.toast('Could not rejoin that match'); return; }

    try{
      /* The map is whatever the match already decided. The server is the
         authority on that, so ask it rather than trusting local state — this is
         the same reasoning that fixed the map desync in the first place. */
      const map = (info.mapId && typeof MapVoting !== 'undefined')
        ? MapVoting.getMapById(info.mapId) : null;

      this._votedMap = map || this._votedMap || null;
      this._matchRoster = info.roster || null;
      this._votedMapId = info.mapId || (map ? map.id : null);
      this._selectedGamemode = this._selectedGamemode || 'captureTheCircle';

      if(typeof Net !== 'undefined'){
        Net.roomCode = info.code;
        Net.role = info.role;
        Net.hostId = info.hostId;
        Net.seed = info.seed;
        Net.roster = info.roster || Net.roster;
      }

      if(map && G.setVotedMap) G.setVotedMap(map);
      if(G.setMatchRoster) G.setMatchRoster(info.roster);

      if(typeof SessionGuard !== 'undefined') SessionGuard.clear();

      /* Same entry point the vote uses once the map is known, so the restored
         battle is armed identically to a fresh one. */
      if(this._startModeAfterVote) this._startModeAfterVote();
      else this._startCaptureCircleSafely();

      this.toast('Back in the battle — match ' + info.code);
    }catch(err){
      console.error('Resume into battle failed:', err);
      if(typeof SessionGuard !== 'undefined') SessionGuard.clear();
      try{ if(G) G.leaveToMenu(); }catch(e){}
      this.toast('Could not rejoin that match — back to menu');
    }
  },

  /* ---- A TANK FELL ASLEEP / WOKE UP --------------------------------------
     The server holds a disconnected player's place for a grace period instead of
     deleting them, so their tank stays in the arena instead of vanishing. That
     has to be told to the game, or the tank just stands there looking frozen.

     Wired from _init() rather than here, because these are assignments and this
     is an object literal — statements cannot sit in a method position. */
  _wirePeerPresence(){
    if(typeof Net === 'undefined') return;
    Net.onPeerSleep = (msg) => {
      try{
        if(this.game && this.game._setTankAsleep) this.game._setTankAsleep(msg.peerId, true);
        this.toast('A player disconnected — their tank is resting');
      }catch(e){}
    };
    Net.onPeerWake = (msg) => {
      try{
        if(this.game && this.game._setTankAsleep) this.game._setTankAsleep(msg.peerId, false);
      }catch(e){}
    };
    /* Walk back into a battle the server was holding for us. */
    Net.onResume = (info) => {
      try{ if(typeof SessionGuard !== 'undefined') SessionGuard.resumeIntoBattle(info); }
      catch(e){}
    };
  },

  _startCaptureCircleSafely(){
    try {
      if(this.game && this._votedMap) this.game.setVotedMap(this._votedMap);
      if(this.game){
        this.game.setMatchRoster(this._matchRoster);
        this.game.startCaptureTheCircle();
      }
    } catch(err){
      console.error('Start Capture Circle failed:', err);
      try { if(this.game) this.game.leaveToMenu(); } catch(e2){}
      this.toast('Could not start capture circle — back to menu');
    }
  },

  _startBaseDefendSafely(){
    try {
      if(this.game && this._votedMap) this.game.setVotedMap(this._votedMap);
      if(this.game){
        this.game.setMatchRoster(this._matchRoster);
        this.game.startBaseDefend();
      }
    } catch(err){
      console.error('Start Base Defend failed:', err);
      try { if(this.game) this.game.leaveToMenu(); } catch(e2){}
      this.toast('Could not start base defend — back to menu');
    }
  },

  /* ==========================================================================
     THE SEARCH BUTTON

     Pressing PLAY turns the word PLAY into a timer that counts UP from 0 and
     keeps going for as long as you are in the queue. There is no cap and no "+"
     suffix: it used to stop at a hardcoded 5 seconds and then sit on "5s+",
     which was both a lie (the queue waits 15) and a dead end that looked broken.

     SIZE MUST NOT CHANGE. `.btn-play` is content-sized — padding 18px 60px and
     no width — so the label's LENGTH is the button's width. "SEARCHING  15s" is
     fourteen characters against PLAY's four, and it visibly stretched the button
     on the main menu. So the label is kept to two or three characters ("0s",
     "12s"), which is no longer than the word it replaces. Nothing but
     textContent is written: no markup, no classes that alter layout, no CSS.

     Clicking it again cancels the search, so you can change your mind. */
  _showPlayCountdown(onDone){
    const btn = document.getElementById('btn-play');
    if(!btn) return;

    /* THE NUMBER LIVES IN ITS OWN SPAN.

       The button now holds two children: the caption (`.btn-play-cap`) and the
       number (`.btn-play-num`). Writing `btn.textContent = '3s'` would replace
       BOTH and delete the caption outright, so every write here goes to the
       number span instead.

       The fallback matters because `_origText` may itself have been captured
       before this markup existed, or on a page where the span is absent — in
       which case textContent is the only way to write the label and the caption
       is simply not there to be destroyed. */
    const num = btn.querySelector('.btn-play-num');
    const setLabel = (s) => { if(num) num.textContent = s; else btn.textContent = s; };

    /* Capture the resting text ONCE. It used to be captured on every search, so
       if a search ever ended without restoring the button, the next search
       captured "SEARCHING" as the original and the button stayed stuck on it for
       the rest of the session, still wired to cancel. That is the "I click PLAY
       and nothing happens" report. */
    if(!btn._queued){
      btn._origText = num ? num.textContent : btn.textContent;
      btn._origOnclick = btn.onclick;
    }
    btn._queued = true;
    btn.classList.remove('searching-wait');
    btn.classList.add('searching');
    btn.onclick = () => { this._cancelSearch(); };

    /* THE MODE PICKER GOES LOCKED THE MOMENT THE SEARCH BEGINS, not when
       somebody tries to click it. Showing the lock on the attempt means the
       player discovers the rule by being refused, which reads as broken; showing
       it on entry means the picker visibly belongs to the search that is
       running. The PLAY button is the cancel and is already showing the timer,
       so the way out is the control they are already looking at. */
    if(typeof this._lockModeSelector === 'function') this._lockModeSelector(true);

    if(this._playCountdownInterval) clearTimeout(this._playCountdownInterval);

    /* THE WAIT IS 15 SECONDS AND THAT IS THE WHOLE PROMISE.

       Bots fill the empty slots when the window expires, so 15s is a maximum,
       not a rough guide — and the button must never count past it. An earlier
       version was told to count "unlimited" and did exactly that: it would keep
       climbing past 15 whenever the queue took a second longer than expected,
       which reads as a game that is stuck searching rather than one that is
       about to start.

       So the count is clamped to the server's own window (botFillDelayMs, which
       is 15000). Past that it HOLDS at the maximum rather than inventing a
       bigger number: if the wait really does overrun, the honest thing is to sit
       at the number that was promised while the match arrives, not to start
       counting into a second, a minute, forever. */
    const M = (typeof TDMMatchmaker !== 'undefined') ? TDMMatchmaker : null;
    const MAX_WAIT = Math.max(1, Math.round(((M && M.queueDelayMs) || 15000) / 1000));

    let secs = 0;
    let elapsed = 0;   /* NOT clamped -- see the step() note below */
    setLabel('0s');

    /* HOW LONG PAST THE WINDOW BEFORE WE ADMIT THE MATCH IS NEVER COMING.

       Six seconds. The window itself is 15, so this is not "the wait is 21
       seconds" -- it is the point at which holding a number the player was told
       is the maximum stops being honest. If the match has not arrived by then
       it is not arriving, and the player deserves to be told that rather than
       left staring at a frozen 15s.

       This exists because clamping the counter at 15 (done for good reason --
       see above) quietly removed the only visible symptom of a broken
       connection. Before the clamp the number kept climbing, so a stalled
       socket was obvious: 23s, 40s, a minute. Clamped at 15, a stalled socket
       is pixel-for-pixel identical to a match that is one second out, which is
       exactly the "counts to 15 and then nothing happens" report. The clamp was
       right and the missing watchdog was the real gap. */
    const GRACE = 6;

    const step = () => {
      if(!this._queued) return;
      /* TWO COUNTERS ON PURPOSE.

         secs is what the player sees and is clamped, so the button can never
         show a number bigger than the promise. elapsed is the raw tick count
         and is NOT clamped, because it is the watchdog's clock.

         The first attempt at this reused secs for both and could therefore never
         fire: a value pinned at 15 can never satisfy "15 + 6", so the recovery
         branch was unreachable code and the button sat on 15s forever -- which
         is the exact bug it was written to fix. Anything measuring an overrun
         must count past the clamp on its own. */
      elapsed += 1;
      secs = Math.min(elapsed, MAX_WAIT);
      setLabel(secs + 's');

      /* Two different failures, and they deserve different words.

         (a) The socket never came up at all: nothing is connected, so there was
             never a queue to be in. Report that plainly.

         (b) The socket is fine but the match still has not formed after the
             window plus grace: the server took our join and then went quiet.
             This is the one that used to hang forever, because the old test
             required BOTH conditions and a live socket satisfies "connected",
             so it could never trip. */
      const stillQueued = !!(M && M._queueing);
      const connected = !!(typeof Net !== 'undefined' && Net.connected);

      /* "DID THE MATCH FOR THIS SEARCH ARRIVE?" -- not "is a room code set?"

         The watchdog used to read Net.roomCode, which is a global that outlives
         any one search. Reconnecting after a battle, or being resumed back into
         one, sets it -- and then the condition below could never be true again,
         so the only thing standing between the player and an infinite wait was
         switched off for exactly as long as the wait was likely to last.

         This is a per-search flag instead: set by onMatchStart, which is the
         only thing that can legitimately claim the match arrived, and read by
         the watchdog that is waiting for it. */
      const gotRoom = !!(typeof Net !== 'undefined' && Net.roomCode) && this._searchGotRoom === true;
      if(this._searchGotRoom) this._searchGotRoom = false;

      if(!gotRoom && !stillQueued && !connected){
        this._recoverFromStalledSearch('Match server unreachable', onDone);
        return;
      }
      if(!gotRoom && elapsed >= MAX_WAIT + GRACE){
        this._recoverFromStalledSearch('Match server stopped responding', onDone);
        return;
      }

      this._playCountdownInterval = setTimeout(step, 1000);
    };
    /* Nothing has arrived for THIS search yet. Deliberately not seeded from
       Net.roomCode -- see above. */
    this._searchGotRoom = false;
    this._playCountdownInterval = setTimeout(step, 1000);
  },

  /* THE PLAYER IS NEVER LEFT ON A DEAD BUTTON.

     A stalled search used to have two outcomes: wait forever, or -- if the
     socket happened to be down -- fall into the old "start a solo battle"
     branch. Both are wrong in the same way: the player pressed PLAY to play
     with people, and the game silently decided otherwise (or made them watch a
     number stop moving).

     So on a stall we say what happened, put the button back the way we found it
     so it is immediately pressable again, and get them into a battle anyway.
     Bots fill the empty slots, exactly as they do when the window expires
     normally, so the game is playable and the player can press PLAY once more
     to retry real matchmaking. A battle with no players in it beats a menu
     they cannot leave. */
  _recoverFromStalledSearch(reason, onDone){
    /* We are definitively not queued any more. afterQueue also clears this on
       the normal path, but relying on the callback means a stubbed or throwing
       onDone leaves the menu believing it is still searching -- the same frozen
       state, one level up. */
    this._queued = false;
    this._hidePlayCountdown();

    /* Get the queue off the server as well as off the button, otherwise the
       player is still sitting in a queue they cannot see, and the next PLAY
       adds a second entry for the same person. */
    try { if(typeof TDMMatchmaker !== 'undefined') TDMMatchmaker.leaveQueue(); } catch(e){}

    this.toast(reason + ' — starting a battle you can play now. Press PLAY to retry online.');

    /* Only fall through to the mode starter if there is somewhere to go. The
       TDM entry point calls this with no onDone because it starts the battle
       from its own onMatchStart handler, so silently doing nothing there is
       correct -- it is already inside a start path. */
    if(onDone){ try { onDone(); } catch(e){ console.warn('stall recovery:', e); } }
  },

  _cancelSearch(){
    this._queued = false;
    try { if(typeof TDMMatchmaker !== 'undefined') TDMMatchmaker.leaveQueue(); } catch(e){}
    this._hidePlayCountdown();
    this.toast('Search cancelled');
  },

  _hidePlayCountdown(){
    const btn = document.getElementById('btn-play');
    /* THE PICKER IS UNLOCKED HERE, NOT AT THE CALL SITE. Every path that ends a
       search goes through this one function — a real match, a cancellation, the
       stall watchdog, and the offline fallback — so unlocking here is the only
       version that cannot leave the cards greyed out with no search running. */
    if(typeof this._unlockModeSelector === 'function') this._unlockModeSelector();
    if(this._playCountdownInterval){
      clearTimeout(this._playCountdownInterval);
      this._playCountdownInterval = null;
    }
    if(btn){
      /* Always clear BOTH classes. `searching-wait` was only removed on a new
         search, so a search that ended while waiting left the button styled as
         if it were still searching. */
      btn.classList.remove('searching');
      btn.classList.remove('searching-wait');
      btn._queued = false;
      /* Restore from the captured resting text, never from whatever the button
         currently says — that is what let "SEARCHING 5s+" become permanent.

         Written through the number span when there is one, for the same reason
         the countdown writes there: textContent would take the caption with it,
         and dropping the caption on every cancel would make it flicker. */
      const num = btn.querySelector('.btn-play-num');
      if(num) num.textContent = btn._origText || 'PLAY';
      else btn.textContent = btn._origText || 'PLAY';
      btn.onclick = btn._origOnclick || null;
    }
  },

  _syncGamemodeIcon(){
    /* Read through the validated selection, never straight from storage. These
       two sites are PLAY and the icon sync; both used to re-read localStorage
       directly, which meant a stale disabled mode could still be launched from
       here even after the menu had refused to select it. */
    const m = this._selectedGamemode || 'captureTheCircle';
    const svgPaths = {
      'random-battle': '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/>',
      'team-deathmatch': '<path d="m12.5 17-.5-1-.5 1h1z"/><path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="12" r="1"/>',
      'sandbox': '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
      'captureTheCircle': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
      /* A keep on a plinth, under a flag — reads as "a thing worth defending"
         at 24px, where the more literal alternatives (a crosshair, a target) all
         collapse into the same circle-and-dot the Circle mode already uses. */
      'baseDefend': '<path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/><path d="M12 5V2"/><path d="M12 2.8c1.6.5 3 .4 4.4-.4-.2 1.6.2 3 1.6 4.2-1.6.2-2.8 1-3.6 2.4-.8-1.4-2-2.2-3.6-2.4 1.4-1.2 1.8-2.6 1.6-4.2 1.4.8 2.8.9 4.4.4"/>',
      'gladiator': '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/>'
    };
    const svgEl = document.getElementById('gamemode-icon');
    if(svgEl && svgPaths[m]){
      svgEl.innerHTML = svgPaths[m];
    }
  },

  _clanUIHover(e){
    const st = this._clanUIState;
    if(!st) return;
    const el = this._clanUIHit(e);
    const interactive = el && (el.type === 'sort-buttons' || el.type === 'chat-input' || el.type === 'chat-send');
    st.canvas.style.cursor = interactive ? 'pointer' : 'default';
    // Track the pointer in LAYOUT units for the measure mode overlay
    const r = st.canvas.getBoundingClientRect();
    const s = this._clanUIScale();
    st.hover = {
      x: (e.clientX - r.left - s.ox) / s.scale,
      y: (e.clientY - r.top - s.oy) / s.scale
    };
  },
};

window.Menu = Menu;