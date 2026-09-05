/* ============================================================
   menu.js — All UI: main menu, multiplayer, host/join, hidden
   code (copy + 5s toast), collections, settings (rebindable keys
   + aim-line opacity/color + view-range width), map editor
   launcher, ESC menu, background images, host map selection.
   ============================================================ */

const Menu = {
  settings: loadSettings(),
  hostCfg: { maxPlayers:8, isPublic:true, fakePlayers:4, code:'------', useCustomMap:false, gamemode:'deathmatch' },
  escOpen: false,


  init(game){
    this.game = game;
    document.body.classList.add(this._detectPlatform() === 'desktop' ? 'is-desktop' : 'is-mobile');
    Audio.init();
    SHOP_DATA.init();
    this._checkWeeklyReset();
    this._checkDailyClanXP();
    this._wireButtons();
    this._renderBinds();
    this._renderAimSettings();
    this._renderViewSettings();
    this._renderCamSettings();
    this._renderCameraSettings();
    this._renderGraphicsSettings();
    this._renderOtherSettings();
    this._renderCollections();
    this._wireSettingsTabs();
    this._renderProfile();
    this._applyBackgrounds();
    this._wireEsc();
    this._wireMinimapKey();
    this._updateMapHint();
    this._wireCodes();
    this._wireCollectionEdit();
    this._loadMysteryImg();
    this._wireNightMode();
    this._initFullscreen();
    this._initScaling();
    this._loadClanData();
    // Tab: instantly return to the main menu from any screen (ignored during a match)
    window.addEventListener('keydown', (e) => {
      if(e.key === 'Tab'){
        e.preventDefault();
        if(this.game && this.game.running) return;
        this.show('menu-main');
      }
    });
    this.show('menu-main');
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

  _isFullscreen(){
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  },

  _requestFullscreen(){
    const el = document.documentElement;
    if(el.requestFullscreen){
      el.requestFullscreen().catch(() => {});
    } else if(el.webkitRequestFullscreen){
      el.webkitRequestFullscreen();
    }
  },

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
    const overlay = document.getElementById('menu-fullscreen-prompt');
    if(!overlay) return;
    this._fullscreenOverlay = overlay;

    // Determine which sections to show/hide
    const update = (forceShow) => {
      if(overlay.classList.contains('hidden') && !forceShow) return;
      const isLandscape = window.innerWidth > window.innerHeight;
      const plat = this._detectPlatform();
      const isMobile = plat === 'ios' || plat === 'ios-standalone' || plat === 'android';
      const isFS = this._isFullscreen();

      if(isMobile){
        if(isLandscape || isFS || this._fsDismissed){
          overlay.classList.add('hidden');
          this._checkRenderingTips();
          return;
        }
        this._showSection(plat === 'android' ? 'fs-android-rotate' : 'fs-ios-rotate');
        overlay.classList.remove('hidden');
      } else {
        // Desktop — show prompt when not in fullscreen
        if(isFS || this._fsDismissed){
          overlay.classList.add('hidden');
          this._checkRenderingTips();
          return;
        }
        this._showSection('fs-desktop');
        overlay.classList.remove('hidden');
      }
    };

    // Also show during gameplay when rotating or leaving fullscreen
    this._refreshFullscreenState = update;

    // Listen for resize (orientation changes on mobile, fullscreen changes on desktop)
    const onResize = () => {
      if(overlay.classList.contains('hidden') && !this._fsDismissed){
        const isLandscape = window.innerWidth > window.innerHeight;
        const plat = this._detectPlatform();
        const isMobile = plat === 'ios' || plat === 'ios-standalone' || plat === 'android';
        if(isMobile && !isLandscape && !this._fsDismissed){
          update(true);
        } else if(!isMobile && !this._isFullscreen() && !this._fsDismissed){
          update(true);
        }
      } else {
        update();
        this._checkRenderingTips();
      }
    };
    window.addEventListener('resize', onResize);

    // Also detect fullscreen changes via the fullscreen API
    const fsChange = () => {
      if(!this._isFullscreen() && !this._fsDismissed){
        update(true);
      } else {
        overlay.classList.add('hidden');
      }
    };
    document.addEventListener('fullscreenchange', fsChange);
    document.addEventListener('webkitfullscreenchange', fsChange);
    document.addEventListener('mozfullscreenchange', fsChange);
    document.addEventListener('MSFullscreenChange', fsChange);

    // Desktop buttons
    const enterBtn = document.getElementById('btn-enter-fullscreen');
    if(enterBtn) enterBtn.onclick = () => {
      this._requestFullscreen();
      overlay.classList.add('hidden');
    };
    const dismissBtn = document.getElementById('btn-dismiss-fullscreen');
    if(dismissBtn) dismissBtn.onclick = () => {
      this._fsDismissed = true;
      overlay.classList.add('hidden');
      this._checkRenderingTips();
    };

    // Close button & Escape key (bypass)
    const fsCloseBtn = document.getElementById('btn-fs-close');
    if(fsCloseBtn) fsCloseBtn.onclick = () => {
      this._fsDismissed = true;
      overlay.classList.add('hidden');
      this._checkRenderingTips();
    };
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape' && !overlay.classList.contains('hidden')){
        this._fsDismissed = true;
        overlay.classList.add('hidden');
        this._checkRenderingTips();
      }
    });

    // Mobile dismiss buttons
    const iosDismiss = document.getElementById('btn-ios-rotate-dismiss');
    if(iosDismiss) iosDismiss.onclick = () => {
      this._fsDismissed = true;
      overlay.classList.add('hidden');
      this._checkRenderingTips();
    };
    const androidDismiss = document.getElementById('btn-android-rotate-dismiss');
    if(androidDismiss) androidDismiss.onclick = () => {
      this._fsDismissed = true;
      overlay.classList.add('hidden');
      this._checkRenderingTips();
    };

    // Initial check
    update(true);
    // If overlay stayed hidden (already fullscreen or dismissed), show tips now
    this._checkRenderingTips();
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
    btn.classList.toggle('night', isNight);
    document.body.classList.toggle('night', isNight);
    btn.onclick = () => {
      Audio.click();
      const nowNight = btn.classList.toggle('night');
      localStorage.setItem('nightMode', nowNight ? '1' : '0');
      document.body.classList.toggle('night', nowNight);
    };
  },

  hideTouchControls(){
    document.querySelectorAll('.joystick-container, #cam-rotate-btns').forEach(el =>
      el.classList.add('joystick-hidden')
    );
  },

  show(id){
    // Touch controls are gameplay-only: any menu hides them (covers every
    // exit path, even ones that skip leaveToMenu).
    this.hideTouchControls();
    // Full-screen overlays replace the menu background, so the main preview
    // (garage) is stopped there; card menus (codes, settings, …) sit on top
    // of the menu layer and keep the garage running behind them.
    if(['menu-collections','menu-store','menu-shop-buy','menu-shop-receive',
        'menu-platoon','menu-preview','menu-clan-ui'].indexOf(id) >= 0 ||
       id === 'menu-custom-full'){
      this._stopMainPreview();
    }
    document.querySelectorAll('.menu').forEach(m=> m.classList.add('hidden'));
    if(this._collectionsKeyHandler){
      window.removeEventListener('keydown', this._collectionsKeyHandler);
      this._collectionsKeyHandler = null;
    }
    document.getElementById(id).classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('ui-layer').classList.remove('game-active');
    if(id !== 'menu-store' && id !== 'menu-shop-buy' && id !== 'menu-shop-receive'){
      if(this._shopTimer){ clearInterval(this._shopTimer); this._shopTimer = null; }
    }
    // Re-evaluate fullscreen overlay when returning to any menu
    this._refreshFullscreenState();
    if(id === 'menu-main'){
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
      this._collectionsFrames = null;
      this._collectionsEditMode = false;
      document.getElementById('ce-toggle').classList.remove('hidden');
      document.getElementById('ce-toggle').textContent = 'Edit Layout';
      document.getElementById('ce-controls').classList.add('hidden');
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
  _renderProfile(){
    const s = this.settings;
    const nameEl = document.getElementById('profile-name');
    const clanEl = document.getElementById('profile-clan');
    const cashEl = document.getElementById('profile-cash-num');
    const goldEl = document.getElementById('profile-gold-num');
    const coinEl = document.getElementById('profile-coins-num');
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
    if(goldEl) goldEl.textContent = (s.gems||0);
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
    if(nameEl) nameEl.textContent = s.playerName || 'Player';
    if(clanEl) clanEl.textContent = s.playerClan ? '[' + s.playerClan + ']' : '';
    const trophyEl = document.querySelector('#menu-profile .profile-trophy');
    const trophyCount = (s.trophyCount || 0);
    if(trophyEl) trophyEl.style.display = trophyCount > 0 ? '' : 'none';
    const slot = document.getElementById('pcard-trophy-slot');
    const pop = document.getElementById('pcard-trophy-pop');
    if(slot && pop){
      const roster = (typeof TROPHIES !== 'undefined' && TROPHIES) ? TROPHIES : [];
      const owned = new Set(s.trophyOwnedIds || []);
      const total = Math.max(16, roster.length);
      const cells = [];
      roster.forEach(t => cells.push({ id: t.id, name: t.name, hint: t.hint || '', owned: owned.has(t.id) }));
      for(let i = cells.length; i < total; i++) cells.push({ id: null, name: '', hint: '', owned: false });
      cells.sort((a, b) => (b.owned ? 1 : 0) - (a.owned ? 1 : 0));
      pop.innerHTML = '<div class="trophy-grid">' + cells.map(c =>
        '<div class="trophy-cell' + (c.owned ? ' owned' : '') + '" title="' + (c.name + (c.hint ? ' — ' + c.hint : '')) + '">' +
        '<span class="trophy-cell-icon">🏆</span>' +
        (c.name ? '<span class="trophy-cell-name">' + c.name + '</span>' : '') +
        '</div>').join('') + '</div>' +
        '<div class="trophy-pop-foot">' + (owned.size > 0 ? owned.size + ' trophy' + (owned.size > 1 ? 'ies' : '') + ' owned' : 'No trophies yet — slots unlock as you earn them') + '</div>';
      let hideT = null;
      const canPop = () => !document.fullscreenElement && !(this.game && this.game.running);
      const showPop = () => { if(!canPop()) return; pop.classList.remove('hidden'); };
      const hidePop = () => { pop.classList.add('hidden'); };
      slot.onmouseenter = () => { clearTimeout(hideT); hideT = setTimeout(showPop, 150); };
      slot.onmouseleave = () => { clearTimeout(hideT); hidePop(); };
      slot.onclick = (e) => {
        e.stopPropagation();
        clearTimeout(hideT);
        if(pop.classList.contains('hidden')) showPop(); else hidePop();
      };
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
    const cash = s.cash || 0, gold = s.gems || 0, coins = s.coins || 0;
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
    document.getElementById('hud').classList.remove('hidden');
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
    document.getElementById('bigmap-close').onclick = ()=> document.getElementById('bigmap').classList.add('hidden');
      document.getElementById('minimap-btn').onclick = ()=> this.game.toggleBigMap();
      document.getElementById('menu-btn').onclick = ()=> this.toggleEsc();
    // Shop buttons
    var shopBuyCancel = document.getElementById('shop-buy-cancel');
    if(shopBuyCancel) shopBuyCancel.onclick = ()=>{ Audio.click(); this.show('menu-store'); };
    var shopReceiveOk = document.getElementById('shop-receive-ok');
    if(shopReceiveOk) shopReceiveOk.onclick = ()=>{ Audio.click(); this.show('menu-store'); };

    // Play buttons
    const btnPlay = document.getElementById('btn-play');
    if(btnPlay) btnPlay.onclick = ()=> this.startSelectedGamemode();
    
    // Gamemode button
    const btnGamemode = document.getElementById('btn-gamemode');
    if(btnGamemode) btnGamemode.onclick = ()=> this.show('menu-gamemode-select');
    
    // Gamemode squares
    document.querySelectorAll('.gamemode-square').forEach(square => {
      square.onclick = ()=> this._selectGamemode(square.dataset.gamemode);
    });
    // Restore persisted gamemode + sync selector icon
    this._selectedGamemode = localStorage.getItem('tankparty_gamemode') || 'gladiator';
    this._syncGamemodeIcon();
    document.querySelectorAll('.gamemode-square').forEach(sq =>
      sq.classList.toggle('active', sq.dataset.gamemode === this._selectedGamemode)
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
    if(btnBattleSP) btnBattleSP.onclick = ()=>{ if(this.game) this.game.startSingleplayer(); };
    const btnBattleMP = document.getElementById('btn-battle-mp');
    if(btnBattleMP) btnBattleMP.onclick = ()=> this.show('menu-multiplayer');
    const btnPlayBack = document.getElementById('btn-play-back');
    if(btnPlayBack) btnPlayBack.onclick = ()=> this.show('menu-main');
    // Legacy (tank-party.html)
    const btnPlaySP = document.getElementById('btn-play-sp');
    if(btnPlaySP) btnPlaySP.onclick = ()=>{ if(this.game) this.game.startSingleplayer(); };
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
    document.getElementById('esc-no').onclick  = ()=> this._closeEsc();

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
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x2a2f2a, roughness: 0.9, metalness: 0.05
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    scene.add(ground);

    // Build tank
    const previewTank = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: def.color, roughness: 0.65, metalness: 0.2
    });
    const b = def.body;
    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.l), bodyMat);
    bodyMesh.position.y = b.h/2;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    previewTank.add(bodyMesh);
    try{ previewTank.add(Tank.createOutlineMesh(bodyMesh)); }catch(e){}
    // Treads
    const treadMat = new THREE.MeshStandardMaterial({color: 0x222226, roughness: 1});
    [-1, 1].forEach(s => {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, b.l+0.2), treadMat);
      t.position.set(s*(b.w/2+0.05), 0.25, 0);
      t.castShadow = true;
      previewTank.add(t);
    });

    // Turret
    const turretGroup = new THREE.Group();
    const tDef = def.turret;
    const turretMat = new THREE.MeshStandardMaterial({
      color: def.turretColor, roughness: 0.65, metalness: 0.2
    });
    const turretMesh = new THREE.Mesh(new THREE.BoxGeometry(tDef.w, tDef.h, tDef.l), turretMat);
    turretMesh.position.y = tDef.h/2;
    turretMesh.castShadow = true;
    turretGroup.add(turretMesh);
    try{ turretGroup.add(Tank.createOutlineMesh(turretMesh)); }catch(e){}

    // Barrel
    const barrelMat = new THREE.MeshStandardMaterial({color: 0x2a2a2e, roughness: 0.65, metalness: 0.2});
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

  _startMainPreviewLegacy(host){
    if(!host) return;
    const def = TANKS[this.settings.selectedTank];
    if(!def) return;

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
    const bodyMat = new THREE.MeshStandardMaterial({color: def.color, roughness: 0.65, metalness: 0.2});
    const b = def.body;
    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.l), bodyMat);
    bodyMesh.position.y = b.h/2;
    bodyMesh.castShadow = true;
    previewTank.add(bodyMesh);
    try{ previewTank.add(Tank.createOutlineMesh(bodyMesh)); }catch(e){}

    const treadMat = new THREE.MeshStandardMaterial({color: 0x222226, roughness: 1});
    [-1, 1].forEach(s => {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, b.l+0.2), treadMat);
      t.position.set(s*(b.w/2+0.05), 0.25, 0);
      t.castShadow = true;
      previewTank.add(t);
    });

    const turretGroup = new THREE.Group();
    const tDef = def.turret;
    const turretMat = new THREE.MeshStandardMaterial({color: def.turretColor, roughness: 0.65, metalness: 0.2});
    const turretMesh = new THREE.Mesh(new THREE.BoxGeometry(tDef.w, tDef.h, tDef.l), turretMat);
    turretMesh.position.y = tDef.h/2;
    turretMesh.castShadow = true;
    turretGroup.add(turretMesh);
    try{ turretGroup.add(Tank.createOutlineMesh(turretMesh)); }catch(e){}

    const barrelMat = new THREE.MeshStandardMaterial({color: 0x2a2a2e, roughness: 0.65, metalness: 0.2});
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(def.barrelR, def.barrelR, def.barrelLen, 10), barrelMat);
    barrel.rotation.x = Math.PI/2;
    barrel.position.set(0, tDef.h*0.4, tDef.l/2 + def.barrelLen/2);
    barrel.castShadow = true;
    turretGroup.add(barrel);

    turretGroup.position.y = b.h;
    previewTank.add(turretGroup);
    scene.add(previewTank);
    this._mainPreviewTank = previewTank;
    this._mainPreviewTurretGroup = turretGroup;
    this._mainPreviewTrails = [];
    let trailTimer = 0;
    let turretAim = 0;
    let turretTimer = 0;

    let t = 0;
    let heading = 0;
    const turnSpeed = 1.5;

    const loop = () => {
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
      turretGroup.rotation.y += (turretAim - turretGroup.rotation.y) * 0.045;

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
      this._mainPreviewRenderer.dispose();
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
      if(e.code!=='Escape' && e.code!=='Tab') return;
      if(e.code==='Tab') e.preventDefault();
      if(document.activeElement && /input|textarea/i.test(document.activeElement.tagName)) return;
      // If big map is open, close it on Escape/Tab
      if(!document.getElementById('bigmap').classList.contains('hidden')){
        document.getElementById('bigmap').classList.add('hidden'); return;
      }
      // Tab toggles esc menu (ignores key-repeat)
      if(e.code==='Tab'){
        if(e.repeat) return;
        if(document.getElementById('hud').classList.contains('hidden')){
          var _specHud = document.getElementById('spectator-hud');
          if(!_specHud || _specHud.classList.contains('hidden')) return;
        }
        this.toggleEsc();
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
      document.getElementById('esc-menu').classList.remove('hidden');
      this.escOpen = true;
    }
  },
  _closeEsc(){
    document.getElementById('esc-menu').classList.add('hidden');
    this.escOpen = false;
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
    if(k==='WheelUp') return 'Wheel ↑';
    if(k==='WheelDown') return 'Wheel ↓';
    if(k==='Space') return 'Space';
    if(k.startsWith('Key')) return k.slice(3);
    if(k.startsWith('Arrow')) return k.slice(5)+' arrow';
    return k;
  },

  /* ---------- aim line settings ---------- */
  _renderAimSettings(){
    const wrap = document.getElementById('aim-settings');
    if(!wrap) return;
    const des = this.settings.aimLineDesign || 'default';
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
      </label>`;
    document.getElementById('aim-op').oninput = e=>{
      this.settings.aimLineOpacity = +e.target.value/100;
      document.getElementById('aim-op-val').textContent = e.target.value+'%';
      saveSettings(this.settings); this.game.applySettings(this.settings);
    };
    document.getElementById('aim-color').oninput = e=>{
      this.settings.aimLineColor = e.target.value;
      saveSettings(this.settings); this.game.applySettings(this.settings);
    };
    wrap.querySelectorAll('[data-aimdes]').forEach(el=>{
      el.onclick = ()=>{
        wrap.querySelectorAll('[data-aimdes]').forEach(x=>x.classList.remove('active'));
        el.classList.add('active');
        this.settings.aimLineDesign = el.dataset.aimdes;
        saveSettings(this.settings); this.game.applySettings(this.settings);
      };
    });
    const ricoToggle = document.getElementById('rico-toggle');
    if(ricoToggle) ricoToggle.onchange = e=>{
      this.settings.ricochetIndicator = e.target.checked;
      saveSettings(this.settings); this.game.applySettings(this.settings);
    };
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
        ${seg('crosshair','Crosshair')}
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
      dynamic: 'Camera angle changes with zoom: 20° (close) → 85° (far). Manual rotation. Left arrow = orbit left.',
      automatic: 'When zoomed in (20°–30°), mouse rotates camera, turret aims at center crosshair. Otherwise manual.',
      crosshair: 'Fixed center crosshair. Mouse rotates camera, turret always aims at crosshair.',
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
      </div>
      <div class="hint">Fancy enables ground shadows &amp; longer view distance</div>`;
    wrap.querySelectorAll('[data-gfx]').forEach(el=>{
      el.onclick = ()=>{
        wrap.querySelectorAll('[data-gfx]').forEach(x=>x.classList.remove('active'));
        el.classList.add('active');
        this.settings.graphicsQuality = el.dataset.gfx;
        saveSettings(this.settings);
        if(this.game) this.game.applySettings(this.settings);
      };
    });
  },

  /* ---------- other settings (screen shake / muzzle FX / FPS) ---------- */
  _renderOtherSettings(){
    const wrap = document.getElementById('other-settings');
    if(!wrap) return;
    const sh = Math.round(this.settings.screenShake != null ? this.settings.screenShake : 100);
    const mf = this.settings.muzzleFx !== false;
    const sf = !!this.settings.showFps;
    const nm = localStorage.getItem('nightMode') === '1';
    wrap.innerHTML = `
      <label>Screen shake strength: <span id="shake-val">${sh}%</span></label>
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
      <label style="margin-top:18px">FPS counter</label>
      <div class="seg">
        <div class="seg-opt${sf?' active':''}" data-fps="1">On</div>
        <div class="seg-opt${sf?'':' active'}" data-fps="0">Off</div>
      </div>
      <div class="hint">Shows frames per second in the top-right corner during a match</div>`;
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
  },

  /* ---------- collections ---------- */
  _wireCollectionEdit(){
    document.getElementById('ce-toggle').onclick = () => this._toggleCollectionsEdit();
  },
  _loadCollectionsLayout(){
    try{
      const d = JSON.parse(localStorage.getItem('tankparty_collections_layout'));
      if(d && d.frames && Array.isArray(d.frames)){
        this._autoAddTankFrames(d.frames);
        this._savedLayout = d.frames;
        return;
      }
    }catch(e){}
    this._savedLayout = null;
  },

  _autoAddTankFrames(frames){
    try{
      const added = JSON.parse(localStorage.getItem('tankparty_collections_autofilled')||'[]');
      const pending = TANK_ORDER.filter(id => id !== 'tankdisplay' && id !== 'dummy' && TANKS[id] && !frames.some(s => s.tankId === id) && !added.includes(id));
      if(!pending.length) return;
      const w = 288, h = 157, gapX = 300, imgW = 3782;
      let maxX = frames.reduce((m, s) => Math.max(m, (s.x || 0) + (s.w || 0)), 0);
      let rowY = 133;
      pending.forEach((id, i) => {
        let x = maxX + 40 + i * gapX;
        if(x + w > imgW - 20){ rowY += 180; x = 40 + (i % 3) * gapX; }
        frames.push({
          x, y: rowY, w, h, scale: 0.8,
          tankId: id, displayType: 'tank',
          pivots: [{ px:0, py:0, pw:w, ph:h, action:'select-tank' }]
        });
        added.push(id);
      });
      localStorage.setItem('tankparty_collections_layout', JSON.stringify({ frames }));
      localStorage.setItem('tankparty_collections_autofilled', JSON.stringify(added));
    }catch(e){}
  },
  _applyCollectionsLayout(){
    if(!this._savedLayout || !this._savedLayout.length) return;
    this._collectionsFrames = this._savedLayout.map((s, i) => ({
      x: s.x, y: s.y, w: s.w, h: s.h, scale: s.scale || 1,
      tankId: s.tankId !== undefined ? s.tankId : null,
      label: s.label !== undefined ? s.label : undefined,
      displayType: s.displayType !== undefined ? s.displayType : (s.tankId ? 'tank' : 'coming-soon'),
      pivots: s.pivots
    }));
    this._ensurePivots();
  },

  _ensurePivots(){
    if(!this._collectionsFrames) return;
    this._collectionsFrames.forEach(f => {
      if(!f.pivots || !f.pivots.length){
        f.pivots = [{ px: 0, py: 0, pw: f.w, ph: f.h, action: f.tankId ? 'select-tank' : 'coming-soon' }];
      } else {
        f.pivots.forEach(p => {
          if(f.tankId && p.action === 'coming-soon' && f.displayType === 'tank'){
            p.action = 'select-tank';
          }
        });
      }
    });
  },

  _renderCollections(){
    const canvas = document.getElementById('collections-overlay');
    if(!canvas) return;
    const container = document.getElementById('collections-image-wrap');
    if(!container) return;
    const vw = container.clientWidth;
    const vh = container.clientHeight;
    if(!vw || !vh){ setTimeout(() => this._renderCollections(), 100); return; }
    const img = document.getElementById('collections-img');
    if(!img) return;
    const imgW = 3782, imgH = 691;
    const zoom = vh / imgH;
    const displayW = imgW * zoom;

    const wrapper = canvas.parentElement;
    if(wrapper){
      wrapper.style.width = displayW + 'px';
      wrapper.style.height = vh + 'px';
    }
    img.style.width = displayW + 'px';
    img.style.height = vh + 'px';

    const dpr = window.devicePixelRatio || 1;
    canvas.width = displayW * dpr;
    canvas.height = vh * dpr;
    canvas.style.width = displayW + 'px';
    canvas.style.height = vh + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    if(!this._collectionsFrames){
      this._loadCollectionsLayout();
      this._collectionsFrames = [
        { x:465.75612353567624, y:348.45367412140575, w:288.80830670926525, h:157.0926517571886, scale:0.8, tankId:null, displayType:'coming-soon', pivots:[{px:0,py:0,pw:344,ph:188,action:'coming-soon'}] },
        { x:119.71671991480298, y:349.0181043663472, w:288.80830670926525, h:157.0926517571886, scale:0.8, tankId:'striker', displayType:'tank', pivots:[{px:0,py:0,pw:344,ph:188,action:'select-tank'}] },
        { x:118.07348242811503, y:133.2310969116081, w:288.80830670926525, h:157.0926517571886, scale:0.8, tankId:'coolbuddy', displayType:'tank', pivots:[{px:0,py:0,pw:344,ph:188,action:'select-tank'}] },
        { x:468.18530351437704, y:133.7955271565495, w:288.80830670926525, h:157.0926517571886, scale:0.8, tankId:'ghost', displayType:'tank', pivots:[{px:0,py:0,pw:344,ph:188,action:'select-tank'}] },
        { x:814.6176783812568, y:133.62406815761446, w:288.80830670926525, h:157.0926517571886, scale:0.8, tankId:'sturmratte', displayType:'tank', pivots:[{px:0,py:0,pw:344,ph:188,action:'select-tank'}] },
        { x:1460.8487752928647, y:131.05644302449414, w:286.30244941427054, h:154.88711395101174, scale:1, tankId:null, displayType:'coming-soon', pivots:[{px:0,py:0,pw:276,ph:149,action:'coming-soon'}] },
        { x:1808.3205537806177, y:132.05644302449417, w:284.0947816826408, h:154.1512247071352, scale:1, tankId:null, displayType:'coming-soon', pivots:[{px:0,py:0,pw:276,ph:149,action:'coming-soon'}] },
        { x:2155.320553780618, y:133.05644302449414, w:283.35889243876454, h:153.4153354632588, scale:1, tankId:null, displayType:'coming-soon', pivots:[{px:0,py:0,pw:276,ph:149,action:'coming-soon'}] },
        { x:1813, y:349, w:276, h:149, scale:1, tankId:null, displayType:'coming-soon', pivots:[{px:0,py:0,pw:276,ph:149,action:'coming-soon'}] },
        { x:2806, y:137, w:276, h:149, scale:1, tankId:null, displayType:'coming-soon', pivots:[{px:0,py:0,pw:276,ph:149,action:'coming-soon'}] },
        { x:2806, y:351, w:276, h:149, scale:1, tankId:null, displayType:'coming-soon', pivots:[{px:0,py:0,pw:276,ph:149,action:'coming-soon'}] },
        { x:3152, y:137, w:276, h:149, scale:1, tankId:null, displayType:'coming-soon', pivots:[{px:0,py:0,pw:276,ph:149,action:'coming-soon'}] },
        { x:3151, y:351, w:276, h:149, scale:1, tankId:null, displayType:'coming-soon', pivots:[{px:0,py:0,pw:276,ph:149,action:'coming-soon'}] },
        { x:3497, y:136, w:276, h:149, scale:1, tankId:null, displayType:'coming-soon', pivots:[{px:0,py:0,pw:276,ph:149,action:'coming-soon'}] },
        { x:1461, y:348.171458998935, w:284.41533546325877, h:152.77209797657088, scale:1, tankId:'helix', displayType:'tank', pivots:[{px:0,py:0,pw:280,ph:180,action:'select-tank'}] },
      ];
      this._applyCollectionsLayout();
      this._ensurePivots();
      this._autoAddTankFrames(this._collectionsFrames);
      this._ensurePivots();
    }

    const isUnlocked = (id) => this.settings.allUnlocked || (this.settings.unlockedTanks||[]).includes(id);

    const drawMystery = (x, y, w, h) => {
      const pad = 4;
      ctx.fillStyle = 'rgba(60,60,60,0.85)';
      ctx.beginPath();
      const r = 6;
      ctx.moveTo(x+pad+r, y+pad);
      ctx.lineTo(x+w-pad-r, y+pad);
      ctx.quadraticCurveTo(x+w-pad, y+pad, x+w-pad, y+pad+r);
      ctx.lineTo(x+w-pad, y+h-pad-r);
      ctx.quadraticCurveTo(x+w-pad, y+h-pad, x+w-pad-r, y+h-pad);
      ctx.lineTo(x+pad+r, y+h-pad);
      ctx.quadraticCurveTo(x+pad, y+h-pad, x+pad, y+h-pad-r);
      ctx.lineTo(x+pad, y+pad+r);
      ctx.quadraticCurveTo(x+pad, y+pad, x+pad+r, y+pad);
      ctx.closePath();
      ctx.fill();
      if(this._mysteryImg && this._mysteryImg.complete && this._mysteryImg.naturalWidth) {
        const mw = this._mysteryImg.naturalWidth;
        const mh = this._mysteryImg.naturalHeight;
        const s = Math.min((w-pad*4)/mw, (h-pad*4)/mh);
        ctx.drawImage(this._mysteryImg, x+(w-mw*s)/2, y+(h-mh*s)/2, mw*s, mh*s);
      }
    };

    const drawTankSvg = (x, y, w, h, tankId, turretAngle) => {
      const t = TANKS[tankId];
      if(!t) return;
      const pad = Math.min(w, h) * 0.12;
      const sx = x + pad, sy = y + pad;
      const sw = w - pad*2, sh = h - pad*2;
      const color = '#' + t.color.toString(16).padStart(6,'0');
      const tColor = '#' + t.turretColor.toString(16).padStart(6,'0');
      const bodyW = sw*0.75, bodyH = sh*0.35;
      const bodyX = sx+(sw-bodyW)/2, bodyY = sy+sh-bodyH-sh*0.05;
      const turretW = sw*0.45, turretH = sh*0.3;
      const turretX = sx+(sw-turretW)/2, turretY = bodyY-turretH+turretH*0.15;

      if(turretAngle !== undefined){
        ctx.save();
        ctx.translate(turretX+turretW/2, turretY+turretH/2);
        ctx.rotate(turretAngle);
        const hw = turretW/2, hh = turretH/2;
        ctx.fillStyle = tColor;
        const r = Math.min(hw, hh)*0.12;
        ctx.beginPath();
        ctx.moveTo(-hw+r, -hh);
        ctx.lineTo(hw-r, -hh);
        ctx.quadraticCurveTo(hw, -hh, hw, -hh+r);
        ctx.lineTo(hw, hh-r);
        ctx.quadraticCurveTo(hw, hh, hw-r, hh);
        ctx.lineTo(-hw+r, hh);
        ctx.quadraticCurveTo(-hw, hh, -hw+r, hh);
        ctx.lineTo(-hw, -hh+r);
        ctx.quadraticCurveTo(-hw, -hh, -hw+r, -hh);
        ctx.closePath();
        ctx.fill();
        const bw = sw*0.28, bh = sh*0.07;
        ctx.fillStyle = '#2a2a2e';
        ctx.fillRect(hw, -bh/2, bw, bh);
        ctx.restore();
      } else {
        ctx.fillStyle = tColor;
        const r = Math.min(turretW, turretH)*0.08;
        ctx.beginPath();
        ctx.moveTo(turretX+r, turretY);
        ctx.lineTo(turretX+turretW-r, turretY);
        ctx.quadraticCurveTo(turretX+turretW, turretY, turretX+turretW, turretY+r);
        ctx.lineTo(turretX+turretW, turretY+turretH-r);
        ctx.quadraticCurveTo(turretX+turretW, turretY+turretH, turretX+turretW-r, turretY+turretH);
        ctx.lineTo(turretX+r, turretY+turretH);
        ctx.quadraticCurveTo(turretX, turretY+turretH, turretX, turretY+turretH-r);
        ctx.lineTo(turretX, turretY+r);
        ctx.quadraticCurveTo(turretX, turretY, turretX+r, turretY);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#2a2a2e';
        ctx.fillRect(turretX+turretW, turretY+turretH/2-sh*0.035, sw*0.28, sh*0.07);
      }
      ctx.fillStyle = color;
      const br = Math.min(bodyW, bodyH)*0.08;
      ctx.beginPath();
      ctx.moveTo(bodyX+br, bodyY);
      ctx.lineTo(bodyX+bodyW-br, bodyY);
      ctx.quadraticCurveTo(bodyX+bodyW, bodyY, bodyX+bodyW, bodyY+br);
      ctx.lineTo(bodyX+bodyW, bodyY+bodyH-br);
      ctx.quadraticCurveTo(bodyX+bodyW, bodyY+bodyH, bodyX+bodyW-br, bodyY+bodyH);
      ctx.lineTo(bodyX+br, bodyY+bodyH);
      ctx.quadraticCurveTo(bodyX, bodyY+bodyH, bodyX, bodyY+bodyH-br);
      ctx.lineTo(bodyX, bodyY+br);
      ctx.quadraticCurveTo(bodyX, bodyY, bodyX+br, bodyY);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#222226';
      ctx.fillRect(bodyX-2, bodyY+bodyH*0.1, 3, bodyH*0.8);
      ctx.fillRect(bodyX+bodyW-1, bodyY+bodyH*0.1, 3, bodyH*0.8);
    };

    const drawText = (x, y, w, h, text) => {
      ctx.fillStyle = 'rgba(40,40,40,0.85)';
      ctx.beginPath();
      const r = 6;
      ctx.moveTo(x+4+r, y+4);
      ctx.lineTo(x+w-4-r, y+4);
      ctx.quadraticCurveTo(x+w-4, y+4, x+w-4, y+4+r);
      ctx.lineTo(x+w-4, y+h-4-r);
      ctx.quadraticCurveTo(x+w-4, y+h-4, x+w-4-r, y+h-4);
      ctx.lineTo(x+4+r, y+h-4);
      ctx.quadraticCurveTo(x+4, y+h-4, x+4, y+h-4-r);
      ctx.lineTo(x+4, y+4+r);
      ctx.quadraticCurveTo(x+4, y+4, x+4+r, y+4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ccc';
      ctx.font = `bold ${Math.min(w,h)*0.1}px Segoe UI`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x+w/2, y+h/2);
    };

    ctx.clearRect(0, 0, displayW, vh);
    this._collectionsFrames.forEach(f => {
      const dt = f.displayType || (f.tankId ? 'tank' : (f.label ? 'coming-soon' : 'nothing'));
      const fx = f.x * zoom, fy = f.y * zoom;
      const fw = f.w * zoom, fh = f.h * zoom;
      const sc = f.scale || 1;
      if(dt === 'tank' && f.tankId){
        if(isUnlocked(f.tankId)){
          drawTankSvg(fx+fw*(1-sc)/2, fy+fh*(1-sc)/2, fw*sc, fh*sc, f.tankId);
        } else {
          drawMystery(fx+fw*(1-sc)/2, fy+fh*(1-sc)/2, fw*sc, fh*sc);
        }
      } else if(dt === 'coming-soon'){
        drawText(fx+fw*(1-sc)/2, fy+fh*(1-sc)/2, fw*sc, fh*sc, f.label || 'Coming Soon!');
      }
    });

    // Editor overlay
    if(this._collectionsEditMode){
      const isSel = (i) => this._selectedFrameIdxs && this._selectedFrameIdxs.includes(i);
      const primary = (this._selectedFrameIdxs && this._selectedFrameIdxs.length) ? this._selectedFrameIdxs[this._selectedFrameIdxs.length-1] : -1;
      const hs = 7;
      this._collectionsFrames.forEach((f, i) => {
        const fx = f.x * zoom, fy = f.y * zoom;
        const fw = f.w * zoom, fh = f.h * zoom;
        const sel = isSel(i);
        ctx.strokeStyle = sel ? (i === primary ? '#ffcc00' : 'rgba(255,200,0,0.5)') : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = sel ? 2 : 1;
        ctx.setLineDash(sel ? [] : [4,4]);
        ctx.strokeRect(fx, fy, fw, fh);
        ctx.setLineDash([]);
        if(i === primary){
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#222';
          ctx.lineWidth = 1.5;
          [[fx, fy], [fx+fw, fy], [fx, fy+fh], [fx+fw, fy+fh]].forEach(([hx, hy]) => {
            ctx.fillRect(hx-hs/2, hy-hs/2, hs, hs);
            ctx.strokeRect(hx-hs/2, hy-hs/2, hs, hs);
          });
        }
      });
      // Snap grid overlay
      if(this._collectionsSnapGrid){
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 0.5;
        const gs = 50 * zoom;
        for(let x = 0; x < displayW; x += gs){
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, vh); ctx.stroke();
        }
        for(let y = 0; y < vh; y += gs){
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(displayW, y); ctx.stroke();
        }
        ctx.restore();
      }
      // Pivot rect overlay
      if(this._collectionsShowPivot){
        const colors = { 'select-tank':'rgba(0,200,80,0.35)', 'coming-soon':'rgba(255,200,0,0.35)', 'info':'rgba(0,120,255,0.35)', 'nothing':'rgba(100,100,100,0.2)' };
        this._collectionsFrames.forEach((f, fi) => {
          (f.pivots||[]).forEach((p, pi) => {
            const px = (f.x + p.px) * zoom, py = (f.y + p.py) * zoom;
            const pw = p.pw * zoom, ph = p.ph * zoom;
            const sel = this._selectedPivot && this._selectedPivot.fi === fi && this._selectedPivot.pi === pi;
            ctx.fillStyle = colors[p.action] || 'rgba(255,255,255,0.2)';
            ctx.fillRect(px, py, pw, ph);
            ctx.strokeStyle = sel ? '#ffcc00' : 'rgba(255,255,255,0.5)';
            ctx.lineWidth = sel ? 2 : 1;
            ctx.setLineDash([]);
            ctx.strokeRect(px, py, pw, ph);
            if(sel){
              ctx.fillStyle = '#ffcc00';
              ctx.font = 'bold 10px sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText(p.action, px + pw/2, py + ph/2);
            }
          });
        });
      }
    }

    // Event wiring
    if(!this._collectionsEventsWired){
      this._collectionsEventsWired = true;

      const imgCoord = (e) => {
        const cr = canvas.getBoundingClientRect();
        return { ix: (e.clientX - cr.left) / zoom, iy: (e.clientY - cr.top) / zoom };
      };
      const hitFrame = (ix, iy) => {
        for(let i=this._collectionsFrames.length-1; i>=0; i--){
          const f = this._collectionsFrames[i];
          if(ix >= f.x && ix < f.x+f.w && iy >= f.y && iy < f.y+f.h) return i;
        }
        return -1;
      };
      let _scrollDrag = null;

      const setSel = (idxs) => { this._selectedFrameIdxs = idxs; this._updateEditorPanel(); this._renderCollections(); };

      canvas.onmousedown = (e) => {
        const {ix, iy} = imgCoord(e);
        if(this._collectionsEditMode && this._selectedFrameIdxs && this._selectedFrameIdxs.length){
          const primary = this._selectedFrameIdxs[this._selectedFrameIdxs.length-1];
          const f = this._collectionsFrames[primary];
          const hs = 8 / zoom;
          for(const c of [{id:'tl',x:f.x,y:f.y},{id:'tr',x:f.x+f.w,y:f.y},{id:'bl',x:f.x,y:f.y+f.h},{id:'br',x:f.x+f.w,y:f.y+f.h}]){
            if(Math.abs(ix-c.x) < hs && Math.abs(iy-c.y) < hs){
              this._dragState = {type:'resize',corner:c.id,idx:primary,startX:ix,startY:iy,orig:{...f}};
              return;
            }
          }
        }
        if(this._collectionsEditMode){
          if(this._collectionsShowPivot){
            // Pivot placement mode
            for(let fi=0; fi<this._collectionsFrames.length; fi++){
              const f = this._collectionsFrames[fi];
              const pivots = f.pivots || [];
              for(let pi=pivots.length-1; pi>=0; pi--){
                const p = pivots[pi];
                if(ix >= f.x+p.px && ix < f.x+p.px+p.pw && iy >= f.y+p.py && iy < f.y+p.py+p.ph){
                  this._selectedPivot = { fi, pi };
                  setSel([fi]);
                  return;
                }
              }
            }
            const idx = hitFrame(ix, iy);
            if(idx >= 0){
              const f = this._collectionsFrames[idx];
              if(!f.pivots) f.pivots = [];
              const pw = 60, ph = 40;
              f.pivots.push({ px: ix-f.x-pw/2, py: iy-f.y-ph/2, pw, ph, action: f.tankId ? 'select-tank' : 'coming-soon' });
              this._selectedPivot = { fi: idx, pi: f.pivots.length - 1 };
              setSel([idx]);
            } else {
              this._selectedPivot = null;
              setSel([]);
            }
            return;
          }
          // Normal edit mode
          const idx = hitFrame(ix, iy);
          if(idx >= 0){
            if(e.ctrlKey || e.metaKey){
              const cur = [...(this._selectedFrameIdxs||[])];
              const pos = cur.indexOf(idx);
              if(pos >= 0) cur.splice(pos, 1); else cur.push(idx);
              setSel(cur.length ? cur : []);
              if(cur.length) this._dragState = {type:'move',idxs:cur,startX:ix,startY:iy,orig:cur.map(i => ({...this._collectionsFrames[i]}))};
            } else {
              setSel([idx]);
              this._dragState = {type:'move',idxs:[idx],startX:ix,startY:iy,orig:[{...this._collectionsFrames[idx]}]};
            }
          } else {
            this._selectedPivot = null;
            setSel([]);
          }
          return;
        }
        _scrollDrag = { startX: e.clientX, startY: e.clientY, scrollLeft: container.scrollLeft, moved: false, velocity: 0 };
        canvas.style.cursor = 'grabbing';
      };

      canvas.onmousemove = (e) => {
        if(this._dragState){
          const {ix, iy} = imgCoord(e);
          const d = this._dragState;
          const dx = ix - d.startX, dy = iy - d.startY;
          const snap = (v) => this._collectionsSnapGrid ? Math.round(v / 50) * 50 : v;
          if(d.type === 'move'){
            d.idxs.forEach((fi, vi) => {
              const f = this._collectionsFrames[fi];
              f.x = snap(d.orig[vi].x + dx);
              f.y = snap(d.orig[vi].y + dy);
            });
          } else {
            const f = this._collectionsFrames[d.idx];
            const o = d.orig;
            if(d.corner === 'tl'){ f.x=snap(o.x+dx); f.y=snap(o.y+dy); f.w=snap(o.w-dx); f.h=snap(o.h-dy); }
            else if(d.corner === 'tr'){ f.y=snap(o.y+dy); f.w=snap(o.w+dx); f.h=snap(o.h-dy); }
            else if(d.corner === 'bl'){ f.x=snap(o.x+dx); f.w=snap(o.w-dx); f.h=snap(o.h+dy); }
            else if(d.corner === 'br'){ f.w=snap(o.w+dx); f.h=snap(o.h+dy); }
            if(f.w < 20) f.w = 20;
            if(f.h < 20) f.h = 20;
          }
          this._updateEditorPanel();
          this._renderCollections();
          return;
        }
        if(_scrollDrag){
          const dx = e.clientX - _scrollDrag.startX;
          if(Math.abs(dx) > 5) _scrollDrag.moved = true;
          if(_scrollDrag.moved){
            const prev = container.scrollLeft;
            container.scrollLeft = _scrollDrag.scrollLeft - dx;
            _scrollDrag.velocity = container.scrollLeft - prev;
          }
        }
      };

      const startScrollInertia = (vel) => {
        const decay = 0.93;
        const step = () => {
          if(Math.abs(vel) < 0.5) return;
          container.scrollLeft += vel;
          vel *= decay;
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      };

      canvas.onmouseup = () => {
        if(this._dragState){ this._dragState = null; this._updateEditorPanel(); return; }
        canvas.style.cursor = '';
        if(_scrollDrag){
          const wasDrag = _scrollDrag.moved;
          const vel = _scrollDrag.velocity;
          const {ix, iy} = imgCoord({ clientX: _scrollDrag.startX, clientY: _scrollDrag.startY });
          _scrollDrag = null;
          if(wasDrag && Math.abs(vel) > 0.5){ startScrollInertia(vel); return; }
          // Was a click — check pivot actions first, then frame selection
          let handled = false;
          for(let fi=0; fi<this._collectionsFrames.length; fi++){
            const f = this._collectionsFrames[fi];
            const pivots = f.pivots || [];
            for(let pi=pivots.length-1; pi>=0; pi--){
              const p = pivots[pi];
              if(ix >= f.x+p.px && ix < f.x+p.px+p.pw && iy >= f.y+p.py && iy < f.y+p.py+p.ph){
                if(p.action === 'select-tank' && f.tankId){
                  if(isUnlocked(f.tankId)){
                    if(this.settings.selectedTank !== f.tankId){
                      this.settings.selectedTank = f.tankId;
                      saveSettings(this.settings);
                    }
                    this.show('menu-main');
                  } else {
                    this.toast('Tank locked! Play to unlock.');
                  }
                } else if(p.action === 'coming-soon'){
                  this.toast('Coming Soon!');
                } else if(p.action === 'info'){
                  this.toast(TANKS[f.tankId]?.name || 'Frame Info');
                }
                handled = true;
                break;
              }
            }
            if(handled) break;
          }
          if(!handled){
            const idx = hitFrame(ix, iy);
            if(idx >= 0){
              const f = this._collectionsFrames[idx];
              if(f.tankId){
                if(isUnlocked(f.tankId)){
                  if(this.settings.selectedTank !== f.tankId){
                    this.settings.selectedTank = f.tankId;
                    saveSettings(this.settings);
                  }
                  this.show('menu-main');
                } else {
                  this.toast('Tank locked! Play to unlock.');
                }
              }
            }
          }
        }
      };
      canvas.onmouseleave = () => {
        if(this._dragState){ this._dragState = null; this._updateEditorPanel(); }
        canvas.style.cursor = '';
        _scrollDrag = null;
      };

      // Arrow keys for scrolling + Ctrl+Shift+D duplicate
      this._collectionsKeyHandler = (e) => {
        if(e.key === 'ArrowLeft'){ container.scrollLeft -= vw * 0.55; e.preventDefault(); }
        else if(e.key === 'ArrowRight'){ container.scrollLeft += vw * 0.55; e.preventDefault(); }
        else if((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')){
          e.preventDefault();
          this._duplicateFrames(this._selectedFrameIdxs);
        }
      };
      window.addEventListener('keydown', this._collectionsKeyHandler);
    }
  },

  _duplicateFrames(idxs){
    if(!idxs || !idxs.length) return;
    const sorted = [...idxs].sort((a,b) => a-b);
    const news = [];
    sorted.forEach((i, vi) => {
      const orig = this._collectionsFrames[i + vi];
      const copy = { ...orig, pivots: (orig.pivots||[]).map(p => ({...p})), x: orig.x + 30, y: orig.y + 30 };
      this._collectionsFrames.splice(i + vi + 1, 0, copy);
      news.push(i + vi + 1);
    });
    this._selectedPivot = null;
    this._selectCollectionFrame(news);
  },

  _selectCollectionFrame(idxs){
    this._selectedFrameIdxs = idxs;
    this._updateEditorPanel();
    this._renderCollections();
  },

  _updateEditorPanel(){
    const panel = document.getElementById('ce-frame-props');
    const selCount = document.getElementById('ce-sel-count');
    const dtSel = document.getElementById('ce-display-type');
    const tankSel = document.getElementById('ce-tank-id');
    if(!panel) return;
    const s = this._selectedFrameIdxs;
    if(!s || !s.length){ panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    if(s.length === 1){
      const f = this._collectionsFrames[s[0]];
      dtSel.value = f.displayType || (f.tankId ? 'tank' : 'coming-soon');
      selCount.textContent = '';
      // Populate tank dropdown
      tankSel.innerHTML = '';
      const tankIds = Object.keys(TANKS || {});
      tankIds.forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = TANKS[id].name || id;
        if(id === f.tankId) opt.selected = true;
        tankSel.appendChild(opt);
      });
      tankSel.classList.toggle('hidden', dtSel.value !== 'tank');
    } else {
      selCount.textContent = `(${s.length} selected)`;
      dtSel.value = '';
      tankSel.classList.add('hidden');
    }
    // Wire display type change
    dtSel.onchange = () => {
      this._selectedFrameIdxs.forEach(i => {
        this._collectionsFrames[i].displayType = dtSel.value;
        if(dtSel.value !== 'tank'){
          this._collectionsFrames[i].tankId = null;
          this._collectionsFrames[i].label = dtSel.value === 'coming-soon' ? 'Coming Soon!' : undefined;
        } else if(s.length === 1 && !this._collectionsFrames[s[0]].tankId){
          const firstTank = Object.keys(TANKS || {})[0];
          this._collectionsFrames[s[0]].tankId = firstTank;
        }
      });
      tankSel.classList.toggle('hidden', dtSel.value !== 'tank');
      this._renderCollections();
    };
    // Wire tank change
    tankSel.onchange = () => {
      this._selectedFrameIdxs.forEach(i => { this._collectionsFrames[i].tankId = tankSel.value; });
      this._renderCollections();
    };
    // Pivot props panel
    const pPanel = document.getElementById('ce-pivot-props');
    const pAction = document.getElementById('ce-pivot-action');
    if(pPanel){
      if(this._selectedPivot){
        const f = this._collectionsFrames[this._selectedPivot.fi];
        const p = f && (f.pivots||[])[this._selectedPivot.pi];
        if(p){ pPanel.classList.remove('hidden'); pAction.value = p.action; }
        else { pPanel.classList.add('hidden'); }
      } else {
        pPanel.classList.add('hidden');
      }
    }
  },

  _toggleCollectionsEdit(){
    this._collectionsEditMode = !this._collectionsEditMode;
    const btn = document.getElementById('ce-toggle');
    if(btn) btn.textContent = this._collectionsEditMode ? 'Exit Edit' : 'Edit Layout';
    if(this._collectionsEditMode) this._enterCollectionsEdit();
    else this._exitCollectionsEdit();
  },

  _enterCollectionsEdit(){
    document.getElementById('ce-controls').classList.remove('hidden');
    this._selectedFrameIdxs = [];
    this._selectedPivot = null;
    this._dragState = null;

    document.getElementById('ce-dup').onclick = () => { this._duplicateFrames(this._selectedFrameIdxs); };
    document.getElementById('ce-up').onclick = () => {
      const s = this._selectedFrameIdxs;
      if(!s || !s.length) return;
      const minIdx = Math.min(...s);
      if(minIdx <= 0) return;
      const sorted = [...s].sort((a,b) => a-b);
      sorted.forEach(i => {
        const tmp = this._collectionsFrames[i];
        this._collectionsFrames[i] = this._collectionsFrames[i-1];
        this._collectionsFrames[i-1] = tmp;
      });
      this._selectCollectionFrame(s.map(i => i-1));
    };
    document.getElementById('ce-down').onclick = () => {
      const s = this._selectedFrameIdxs;
      if(!s || !s.length) return;
      const maxIdx = Math.max(...s);
      if(maxIdx >= this._collectionsFrames.length - 1) return;
      const sorted = [...s].sort((a,b) => b-a);
      sorted.forEach(i => {
        const tmp = this._collectionsFrames[i];
        this._collectionsFrames[i] = this._collectionsFrames[i+1];
        this._collectionsFrames[i+1] = tmp;
      });
      this._selectCollectionFrame(s.map(i => i+1));
    };
    document.getElementById('ce-del').onclick = () => {
      const s = this._selectedFrameIdxs;
      if(!s || !s.length) return;
      this._selectedPivot = null;
      [...s].sort((a,b) => b-a).forEach(i => this._collectionsFrames.splice(i, 1));
      this._selectCollectionFrame([]);
    };
    document.getElementById('ce-pivot-action').onchange = () => {
      if(!this._selectedPivot) return;
      const f = this._collectionsFrames[this._selectedPivot.fi];
      if(!f) return;
      const p = (f.pivots||[])[this._selectedPivot.pi];
      if(p) p.action = document.getElementById('ce-pivot-action').value;
      this._renderCollections();
    };
    document.getElementById('ce-pivot-del').onclick = () => {
      if(!this._selectedPivot) return;
      const f = this._collectionsFrames[this._selectedPivot.fi];
      if(f && f.pivots) f.pivots.splice(this._selectedPivot.pi, 1);
      this._selectedPivot = null;
      this._updateEditorPanel();
      this._renderCollections();
    };
    document.getElementById('ce-save').onclick = () => {
      const layout = { frames: this._collectionsFrames.map(f => ({x:f.x, y:f.y, w:f.w, h:f.h, scale:f.scale||1, tankId:f.tankId||null, displayType:f.displayType||null, pivots: (f.pivots||[]).map(p => ({...p}))})) };
      localStorage.setItem('tankparty_collections_layout', JSON.stringify(layout));
      this._savedLayout = layout.frames;
      document.getElementById('ce-layout-export').classList.remove('hidden');
      document.getElementById('ce-layout-json').value = JSON.stringify(layout.frames, null, 2);
      this.toast('Layout saved! Copy the JSON below and tell me to deploy.');
    };
    document.getElementById('ce-deploy-layout').onclick = () => {
      const json = document.getElementById('ce-layout-json').value;
      navigator.clipboard.writeText(json).then(() => {
        this.toast('Layout JSON copied! Paste it in the chat so I can deploy it.');
      }).catch(() => {
        this.toast('Select all the JSON below, copy, and paste in the chat.');
      });
    };
    const pivotBtn = document.getElementById('ce-pivot');
    if(pivotBtn){
      pivotBtn.onclick = () => {
        this._collectionsShowPivot = !this._collectionsShowPivot;
        pivotBtn.classList.toggle('active', this._collectionsShowPivot);
        this._renderCollections();
      };
      pivotBtn.classList.toggle('active', !!this._collectionsShowPivot);
    }
    const snapBtn = document.getElementById('ce-snap');
    if(snapBtn){
      snapBtn.onclick = () => {
        this._collectionsSnapGrid = !this._collectionsSnapGrid;
        snapBtn.classList.toggle('active', this._collectionsSnapGrid);
        this._renderCollections();
      };
      snapBtn.classList.toggle('active', !!this._collectionsSnapGrid);
    }
    this._renderCollections();
  },

  _exitCollectionsEdit(){
    document.getElementById('ce-toggle').classList.remove('hidden');
    document.getElementById('ce-controls').classList.add('hidden');
    this._selectedFrameIdxs = [];
    this._selectedPivot = null;
    this._dragState = null;
    this._renderCollections();
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
        this.settings.unlockedTanks = Array.from(new Set([...(this.settings.unlockedTanks||[]), 'rapid', 'blitz', 'vulkan', 'coolbuddy', 'striker', 'ghost', 'sturmratte', 'helix']));
        saveSettings(this.settings);
        this.toast('All tanks unlocked!');
        if(this._collectionsFrames){ this._autoAddTankFrames(this._collectionsFrames); this._ensurePivots(); }
        setTimeout(() => this._renderCollections(), 50);
      } else if(code === 'reset1'){
        this.settings = resetSettings();
        this.toast('Progress reset!');
        this.show('menu-main');
      } else if(code === 'revertmap'){
        this._revertMap();
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
    for(let i = 0; i < 48; i++){
      const slot = document.createElement('div');
      slot.className = 'storage-slot';
      slot.dataset.index = i;
      const item = items[i];
      if(item){
        const isBox = item.type === 'box';
        slot.style.color = '#ffb12b';
        slot.style.fontSize = isBox ? '28px' : '14px';
        slot.style.border = '2px solid rgba(255,177,43,0.3)';
        slot.textContent = isBox ? '\u{1F4E6}' : item.type;
        slot.title = (item.meta && item.meta.source) ? 'Source: ' + item.meta.source + ' (Week ' + item.week + ')' : 'Item';
      } else {
        slot.textContent = '';
        slot.style.border = '';
        slot.style.color = '';
        slot.style.fontSize = '';
        slot.title = 'Empty slot';
      }
      grid.appendChild(slot);
    }
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
    this._renderFreeOffer();
    this._updateShopTimer();
    this._wireShopSidebar();
    document.getElementById('shop-back-main').onclick = () => { Audio.click(); this.show('menu-main'); };
    this._shopTimer = setInterval(() => this._updateShopTimer(), 60000);
  },

  _updateCurrencies(){
    const s = Menu.settings;
    const ce = document.getElementById('shop-coins');
    const ge = document.getElementById('shop-gems');
    const ca = document.getElementById('shop-cash');
    if(ce) ce.textContent = s.coins || 0;
    if(ge) ge.textContent = s.gems || 0;
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
      };
    });
  },

  _renderDeals(){
    const container = document.getElementById('shop-deals');
    if(!container) return;
    container.innerHTML = '';
    const offers = SHOP_DATA.getOffers();
    const rewardImages = { cash:'assets/currency/cash.png', coins:'assets/currency/coin.png', gems:'assets/currency/gold.png', basic_crate:'assets/rewards/basic_crate.png', rare_crate:'assets/rewards/rare_crate.png' };
    const rewardLabels = { cash:'Cash', coins:'Coins', gems:'Gems', basic_crate:'Basic Crate', rare_crate:'Rare Crate' };
    offers.forEach((offer, idx) => {
      const card = document.createElement('div');
      const soldOut = offer.stock === 0;
      card.className = 'shop-deal-card' + (soldOut ? ' sold-out' : '');
      const img = rewardImages[offer.reward] || '';
      const label = rewardLabels[offer.reward] || offer.reward;
      const isCrate = offer.reward === 'basic_crate' || offer.reward === 'rare_crate';
      const curFile = offer.currency === 'gems' ? 'gold' : (offer.currency === 'coins' ? 'coin' : 'cash');
      card.innerHTML =
        '<div class="shop-deal-image" style="background-image:url(\'' + img + '\')"></div>' +
        '<div class="shop-deal-amount">' + offer.amount + '</div>' +
        '<div class="shop-deal-label">' + label + '</div>' +
        '<div class="shop-deal-price' + (offer.currency === 'coins' ? ' coins' : '') + '"><img class="cur-mini" src="assets/currency/' + curFile + '.png" alt=""><span>' + offer.price + '</span></div>' +
        (offer.stock > 0 ? '<div class="shop-deal-stock">' + offer.stock + ' left</div>' : '') +
        (soldOut ? '<div class="shop-deal-stock">SOLD OUT</div>' : '');
      if(!soldOut){
        card.onclick = () => this._showShopBuy(offer);
      }
      container.appendChild(card);
    });
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

  _showShopBuy(offer){
    Audio.click();
    if(!offer || offer.stock === 0) return;
    this._currentBuyOffer = offer;
    const rewardImages = { cash:'assets/currency/cash.png', coins:'assets/currency/coin.png', gems:'assets/currency/gold.png', basic_crate:'assets/rewards/basic_crate.png', rare_crate:'assets/rewards/rare_crate.png' };
    const img = rewardImages[offer.reward] || '';
    document.getElementById('shop-buy-image').style.backgroundImage = "url('" + img + "')";
    const curFile = offer.currency === 'gems' ? 'gold' : (offer.currency === 'coins' ? 'coin' : 'cash');
    document.getElementById('shop-buy-cost').innerHTML = '<img class="cur-mini" src="assets/currency/' + curFile + '.png" alt=""> <span>' + offer.price + '</span>';
    const canAfford = SHOP_DATA.canAfford(offer);
    const btn = document.getElementById('shop-buy-btn');
    btn.className = 'button' + (canAfford ? '' : ' btn-gray');
    btn.onclick = canAfford ? () => this._shopBuyConfirm(offer) : null;
    document.getElementById('shop-back-buy').onclick = () => { Audio.click(); this.show('menu-store'); };
    this.show('menu-shop-buy');
  },

  _shopBuyConfirm(offer){
    if(!offer) return;
    const ok = SHOP_DATA.purchase(offer);
    if(!ok){ this.toast('Purchase failed'); this.show('menu-store'); return; }
    Audio.click();
    this._currentRewardOffer = offer;
    this._shopReceive(offer);
  },

  _shopReceive(offer){
    this.show('menu-shop-receive');
    const wrapper = document.getElementById('shop-receive-wrapper');
    const video = document.getElementById('shop-receive-video');
    const rewardDiv = document.getElementById('shop-receive-reward');
    const claimDiv = document.getElementById('shop-receive-claim');
    const imageDiv = document.getElementById('shop-receive-image');
    const amountDiv = document.getElementById('shop-receive-amount');
    const bgVideo = document.getElementById('shop-receive-bg-video');

    // Reset
    rewardDiv.classList.add('hidden');
    claimDiv.classList.add('hidden');
    claimDiv.onclick = null;
    bgVideo.style.opacity = '0';
    bgVideo.pause();

    // Start buy.mp4
    video.src = 'assets/shop/buy.mp4';
    video.currentTime = 0;
    video.play().catch(() => {});
    video.style.opacity = '1';
    video.onended = null;

    // After 5s, show reward
    const rewardImages = { cash:'assets/currency/cash.png', coins:'assets/currency/coin.png', gems:'assets/currency/gold.png', basic_crate:'assets/rewards/basic_crate.png', rare_crate:'assets/rewards/rare_crate.png' };
    const rewardLabels = { cash:'Cash', coins:'Coins', gems:'Gems', basic_crate:'Basic Crate', rare_crate:'Rare Crate' };
    const img = rewardImages[offer.reward] || '';
    const label = rewardLabels[offer.reward] || '';
    const amt = offer.amount + (offer.reward === 'cash' || offer.reward === 'coins' || offer.reward === 'gems' ? '' : 'x ' + (rewardLabels[offer.reward] || ''));
    imageDiv.style.backgroundImage = "url('" + img + "')";
    amountDiv.textContent = offer.reward === 'cash' || offer.reward === 'coins' || offer.reward === 'gems' ? amt : label + ' x' + offer.amount;

    setTimeout(() => {
      video.style.opacity = '0';
      rewardDiv.classList.remove('hidden');
      rewardDiv.style.opacity = '0';
      setTimeout(() => { rewardDiv.style.opacity = '1'; }, 50);

      // After reward animation, fade in bg video and show claim
      setTimeout(() => {
        bgVideo.src = 'assets/shop/buyed.mp4';
        bgVideo.currentTime = 0;
        bgVideo.play().catch(() => {});
        bgVideo.style.opacity = '1';
        claimDiv.classList.remove('hidden');
        claimDiv.onclick = () => {
          Audio.click();
          video.pause();
          bgVideo.pause();
          this._updateCurrencies();
          this.show('menu-store');
        };
      }, 1500);
    }, 5000);
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
      let rest = w;
      while(rest.length){
        let j = rest.length;
        while(j > 0 && ctx.measureText(rest.slice(0, j)).width > maxW) j--;
        if(!j) j = 1;
        lines.push(rest.slice(0, j));
        rest = rest.slice(j);
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
        let nStr = it.name;
        while(ctx.measureText(nStr).width > fillW && nStr.length > 1) nStr = nStr.slice(0, -1);
        if(nStr !== it.name) nStr = nStr.slice(0, -1) + '\u2026';
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

  _selectGamemode(gamemode){
    if(!gamemode) return;
    
    // Store selected gamemode (persisted) and refresh icon + tile highlight
    this._selectedGamemode = gamemode;
    localStorage.setItem('tankparty_gamemode', gamemode);
    this._syncGamemodeIcon();
    document.querySelectorAll('.gamemode-square').forEach(sq =>
      sq.classList.toggle('active', sq.dataset.gamemode === gamemode)
    );
    
    if(Audio && Audio.click) Audio.click();
    
    // Drop back to the main menu — the PLAY button starts the chosen mode
    this.show('menu-main');
    const names = {gladiator:'Gladiator', sandbox:'Sandbox', 'platform-king':'Platform King'};
    const soon = (gamemode === 'sandbox' || gamemode === 'platform-king') ? ' (coming soon!)' : '';
    this.toast((names[gamemode] || gamemode) + ' selected — press PLAY' + soon);
  },

  startSelectedGamemode(){
    const m = this._selectedGamemode || localStorage.getItem('tankparty_gamemode') || 'gladiator';
    this._selectedGamemode = m;
    if(Audio && Audio.click) Audio.click();
    if(m === 'gladiator'){
      this._startGladiatorSafely();
      return;
    }
    if(m === 'multiplayer'){
      this.show('menu-multiplayer');
      return;
    }
    // Unimplemented modes (sandbox / platform-king): never let PLAY dead-end —
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
      if(this.game) this.game.startGladiator();
    } catch(err){
      // A bad re-entry must surface the error and return the player to the
      // menu instead of silently swallowing the click.
      console.error('Start Gladiator failed:', err);
      try { if(this.game) this.game.leaveToMenu(); } catch(e2){ console.error('menu fallback:', e2); }
      this.toast('Could not start the match — back to menu');
    }
  },

  _syncGamemodeIcon(){
    const m = this._selectedGamemode || localStorage.getItem('tankparty_gamemode') || 'gladiator';
    const iconMap = {
      gladiator: 'assets/icons/gamemode-gladiator.png',
      multiplayer: 'assets/icons/gamemode-multiplayer.png',
      sandbox: 'assets/icons/gamemode-sandbox.png'
    };
    const img = document.getElementById('gamemode-icon');
    const em = document.getElementById('gamemode-emoji');
    if(!img || !em) return;
    const src = iconMap[m];
    img.style.display = src ? '' : 'none';
    em.style.display = src ? 'none' : '';
    if(src && img.src.indexOf(src) < 0) img.src = src;
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