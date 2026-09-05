/* ============================================================
   game.js — main controller: renderer, scene, world, tanks,
   projectiles, camera, loop, HUD, minimap, entry modes
   (singleplayer / host / client).
   FULLY WORKING P2P MULTIPLAYER.
   ============================================================ */

class Game {
  constructor(){
    this.settings = Menu.settings;
    this.mode = null;
    this.running = false;
    this.tanks = [];
    this.projectiles = [];
    this.explosions = [];
    this.localTank = null;
    this.time = 0;
    this.dt = 0;
    this._last = 0;
    this._netSendAcc = 0;
    this.clientTankInputs = {};
    this.clientTanks = {};
    this._shake = 0;
    this._myRemoteId = null;
    this.physicsWorld = null;
    this._physBodies = [];
    this.casings = [];
    this._eventQueue = null;
    this._helixVideos = new Map();
    this.glad = null;
    this._gladBoxes = [];
    this._gladPickups = [];
    this._adapT = 0;
    this._gladZoneCanvas = null;
    this._gladZoneTex = null;
    this._gladZoneMesh = null;
    this._gladChunkIdx = null;
    this._gladPickTimer = 0;
    this._gladMarker = null;
    this._gladMarkerCanvas = null;
    this._gladMarkerTex = null;
    this._gladMarkerKey = null;
    // Spectate state (WoT-style bottom tank bar after you die)
    this.spectate = false;
    this.spectateTarget = null;
    this._spectateIndex = 0;
  }

  /* ---------- Three.js bootstrap ---------- */
  init(){
    // Automatic renderer backend fallback: WebGL2 -> WebGL1 -> experimental-webgl.
    // (WebGPU is probed and reported, but this build runs on three r128 which
    // can't yet drive a WebGPU context — that path lives in the newer TS port.)
    if(!this._createRenderer()){
      this._showNoWebGL();
      return;
    }
    this._maxPixelRatio = Math.min(devicePixelRatio, 1.5);
    this.renderer.setPixelRatio(this._maxPixelRatio);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('game-root').appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.__renderer = this.renderer;
    this.camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 1000);
    this.camera.position.set(0, CONFIG.CAM_HEIGHT, -CONFIG.CAM_DIST);
    this.camera.lookAt(0, 1.2, 0);

    this.world = new World(this.scene);
    this._initPhysics();
    this.input = new Input(this.settings);

    // camera zoom and orbit state
    this.camDist = CONFIG.CAM_DIST;
    this.camAngle = Math.PI; // radians, π = behind the tank
    this.camMode = 'arrows';

    // Camera angle progression: 20° at min zoom (close), ~85° at max zoom (top-down)
    this._camAngleMin = 20 * Math.PI / 180;
    this._camAngleMax = 85 * Math.PI / 180;

    // aim/trajectory line (from muzzle, length = shellRange)
    this._initAimLine();
    // ricochet indicator (2 colored lines on target tank faces)
    this._initRicoIndicator();
    // center crosshair (for crosshair/auto camera modes)
    this._initCrosshair();
    // water foam (created on the fly in _updateWaterFoam)

    // probe available tank models (async)
    Models.probe(TANK_ORDER).catch(()=>{});
    if(window.NatureAssets){
      NatureAssets.loadAll().then(() => {
        if(this.world){
          this.world.treesPlaced = false;
          this.world.tryPlaceTrees();
        }
      });
    }

    addEventListener('resize', ()=> this._onResize());
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    this.applyGraphicsSettings();

    /* ---- Performance overlay (hold P) ---- */
    this._buildPerfOverlay();
    this._onKeyDown = (e) => {
      if (e.code === 'KeyP') { this._perfOverlay.style.display = 'block'; }
    };
    this._onKeyUp = (e) => {
      if (e.code === 'KeyP') { this._perfOverlay.style.display = 'none'; }
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    
    // F11 fullscreen support (delegates to Menu._initFullscreen's handlers)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F11') {
        e.preventDefault();
        const inFS = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
        if (inFS) {
          document.exitFullscreen();
        } else {
          document.documentElement.requestFullscreen().catch(()=>{});
        }
      }
    });
    
    // Hide fullscreen prompt when entering fullscreen (also handled by Menu, but add safety)
    document.addEventListener('fullscreenchange', () => {
      const prompt = document.getElementById('menu-fullscreen-prompt');
      if (prompt) {
        const inFS = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
        if (inFS) {
          prompt.classList.add('hidden');
        }
      }
    });
    
    // Hide fullscreen prompt on desktop by default - use DOM ready check
    const checkAndHideDesktopPrompt = () => {
      const prompt = document.getElementById('menu-fullscreen-prompt');
      if (prompt) {
        const ua = navigator.userAgent;
        const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
        const isAndroid = /Android/.test(ua);
        const isDesktop = !isIOS && !isAndroid;
        if (isDesktop) {
          // Set Menu's _fsDismissed flag so it doesn't re-show
          if (window.Menu && window.Menu._initFullscreen) {
            // Temporarily prevent Menu from showing overlay
            window.Menu._desktopNoPrompt = true;
          }
          prompt.classList.add('hidden');
        }
      }
    };
    
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', checkAndHideDesktopPrompt);
    } else {
      checkAndHideDesktopPrompt();
    }
    
    // Ensure fullscreen buttons work even if DOM loaded later
    document.addEventListener('DOMContentLoaded', () => {
      const enterBtn = document.getElementById('btn-enter-fullscreen');
      if (enterBtn && !enterBtn._onclickAttached) {
        enterBtn._onclickAttached = true;
        enterBtn.onclick = (e) => {
          e.preventDefault();
          document.documentElement.requestFullscreen().catch(()=>{});
          const prompt = document.getElementById('menu-fullscreen-prompt');
          if (prompt) prompt.classList.add('hidden');
          if (window.Menu) {
            window.Menu._fsDismissed = true;
            window.Menu._checkRenderingTips && window.Menu._checkRenderingTips();
          }
        };
      }
      const dismissBtn = document.getElementById('btn-dismiss-fullscreen');
      if (dismissBtn && !dismissBtn._onclickAttached) {
        dismissBtn._onclickAttached = true;
        dismissBtn.onclick = (e) => {
          e.preventDefault();
          const prompt = document.getElementById('menu-fullscreen-prompt');
          if (prompt) prompt.classList.add('hidden');
          if (window.Menu) {
            window.Menu._fsDismissed = true;
            window.Menu._checkRenderingTips && window.Menu._checkRenderingTips();
          }
        };
      }
      const closeBtn = document.getElementById('btn-fs-close');
      if (closeBtn && !closeBtn._onclickAttached) {
        closeBtn._onclickAttached = true;
        closeBtn.onclick = (e) => {
          e.preventDefault();
          const prompt = document.getElementById('menu-fullscreen-prompt');
          if (prompt) prompt.classList.add('hidden');
          if (window.Menu) {
            window.Menu._fsDismissed = true;
            window.Menu._checkRenderingTips && window.Menu._checkRenderingTips();
          }
        };
      }
    });
  }

  /** Create the WebGL renderer with an automatic backend fallback chain:
      WebGL2 -> WebGL1 -> experimental-webgl. Throwing in a context/driver at
      any step silently advances to the next backend instead of black-screening. */
  _createRenderer(){
    const canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    const attrs = {
      alpha: false,
      depth: true,
      stencil: false,
      antialias: devicePixelRatio <= 1,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    };
    const attempts = [['webgl2', 'WebGL2'], ['webgl', 'WebGL1'], ['experimental-webgl', 'WebGL1(exp)']];
    for(const [name, label] of attempts){
      let gl = null;
      try { gl = canvas.getContext(name, attrs); } catch(e){ gl = null; }
      if(!gl) continue;
      try {
        this.renderer = new THREE.WebGLRenderer({
          canvas,
          context: gl,
          antialias: devicePixelRatio <= 1,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
        });
      } catch(e){ this.renderer = null; }
      if(this.renderer && this.renderer.getContext()){
        this._backend = label;
        break;
      }
    }
    if(!this.renderer){
      try { canvas.remove(); } catch(e){}
      this.renderer = null;
      return false;
    }
    this._webgpuAvailable = !!(typeof navigator !== 'undefined' && navigator.gpu);
    return true;
  }

  _showNoWebGL(){
    let el = document.getElementById('webgl-error');
    if(!el){
      el = document.createElement('div');
      el.id = 'webgl-error';
      el.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;text-align:center;background:#0c1016;color:#fff;font-family:sans-serif;padding:24px;';
      el.innerHTML = '<div><h1 style="margin:0 0 10px;font-size:20px">3D rendering unavailable</h1><div style="color:#9aa0ab;line-height:1.6">This game needs WebGL 1 or WebGL 2, and no working backend could be created.<br>Try enabling hardware acceleration or updating your browser/device drivers.</div></div>';
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
  }

  /** Build the custom full-screen performance overlay DOM */
  _buildPerfOverlay(){
    this._perfFpsHistory = [];
    this._perfGpuLoadSamples = [];
    this._perfLastThrottle = 0;
    this._perfFrameStart = 0;
    this._perfUpdateEnd = 0;

    var gl = this.renderer.getContext();
    var gpuName = 'Unknown GPU';
    try {
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) gpuName = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    } catch(e){}

    var d = document.createElement('div');
    d.id = 'perf-overlay';
    d.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'z-index:99999',
      'background:rgba(8,12,18,0.88)', 'border-left:1px solid rgba(0,255,170,0.12)',
      'padding:14px 18px', 'font-family:"Consolas","Courier New",monospace',
      'font-size:12px', 'line-height:1.7', 'color:#b0e0c0',
      'min-width:280px', 'display:none', 'user-select:none', 'pointer-events:none',
    ].join(';');

    d.innerHTML =
      '<div style="color:#0f6;font-size:13px;font-weight:700;letter-spacing:1px;border-bottom:1px solid rgba(0,255,170,0.15);padding-bottom:6px;margin-bottom:6px">PERFORMANCE MONITOR</div>' +
      '<div id="perf-row-gpu" style="color:#8af"></div>' +
      '<div id="perf-row-fps"></div>' +
      '<div id="perf-row-frametime"></div>' +
      '<div id="perf-row-ping"></div>' +
      '<div id="perf-row-mem-used"></div>' +
      '<div id="perf-row-mem-total"></div>' +
      '<div id="perf-row-mem-pct"></div>' +
      '<div id="perf-row-cpu"></div>' +
      '<div id="perf-row-gpu-load"></div>' +
      '<div style="border-top:1px solid rgba(0,255,170,0.15);padding-top:6px;margin-top:6px" id="perf-row-rating"></div>';

    document.body.appendChild(d);
    this._perfOverlay = d;
    var gpuRow = document.getElementById('perf-row-gpu');
    if(gpuRow){
      gpuRow.textContent = 'GPU  ' + gpuName +
        (this._backend ? '   ·  [' + this._backend + ']' : '   ·  [unknown]') +
        '   ·  WebGPU:' + (this._webgpuAvailable ? 'yes' : 'no');
    }
  }

  /** Throttled overlay update — called every frame but only rewrites DOM ~3x/sec */
  _updatePerfOverlay(now){
    if (now - this._perfLastThrottle < 350) return;
    this._perfLastThrottle = now;

    // FPS: rolling average over last 30 frames
    var fps = 0;
    var hist = this._perfFpsHistory;
    if (hist.length > 1){
      var sum = 0;
      for (var i = 1; i < hist.length; i++) sum += (1000 / (hist[i] - hist[i-1]));
      fps = sum / (hist.length - 1);
    }
    var frt = hist.length > 1 ? (hist[hist.length-1] - hist[hist.length-2]) : 0;

    // CPU Load %: fraction of frame spent in _update / total frame time
    var cpuLoad = 0;
    if (this._perfFrameStart > 0 && this._perfUpdateEnd > 0){
      var frameElapsed = now - this._perfFrameStart;
      var updateElapsed = this._perfUpdateEnd - this._perfFrameStart;
      cpuLoad = frameElapsed > 0 ? Math.min(100, Math.round((updateElapsed / frameElapsed) * 100)) : 0;
    }

    // GPU Load %: rough estimate based on raf-to-draw timing
    var gpuLoad = 0;
    var samples = this._perfGpuLoadSamples;
    if (samples.length > 0){
      var gSum = 0;
      for (var si = 0; si < samples.length; si++) gSum += samples[si];
      gpuLoad = Math.min(100, Math.round(gSum / samples.length));
      samples.length = 0;
    }

    // Memory
    var memUsed = 0, memTotal = 0, memLimit = 0, memPct = 0;
    if (self.performance && self.performance.memory){
      memUsed = (performance.memory.usedJSHeapSize / 1048576).toFixed(1);
      memTotal = (performance.memory.totalJSHeapSize / 1048576).toFixed(1);
      memLimit = (performance.memory.jsHeapSizeLimit / 1048576).toFixed(1);
      memPct = (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit * 100).toFixed(1);
    }

    // Ping
    var pingStr = 'N/A (offline)';
    if (this.mode === 'host' || this.mode === 'client'){
      try {
        if (typeof Net !== 'undefined' && Net.peer && Net.peer._lastPing){
          pingStr = Math.round(Net.peer._lastPing) + ' ms';
        }
      } catch(e){}
    }

    // Write DOM (3/sec — safe)
    document.getElementById('perf-row-fps').textContent =
      'FPS        ' + fps.toFixed(1) + (fps >= 55 ? '  ✓' : fps >= 30 ? '  ⚠' : '  ✗');
    document.getElementById('perf-row-frametime').textContent =
      'Frame time ' + frt.toFixed(1) + ' ms';
    document.getElementById('perf-row-ping').textContent =
      'Ping       ' + pingStr;
    document.getElementById('perf-row-mem-used').textContent =
      'Heap used  ' + memUsed + ' MB';
    document.getElementById('perf-row-mem-total').textContent =
      'Heap total ' + memTotal + ' MB';
    document.getElementById('perf-row-mem-pct').textContent =
      'Heap load  ' + memPct + ' %  (limit ' + memLimit + ' MB)';
    document.getElementById('perf-row-cpu').textContent =
      'CPU load   ' + cpuLoad + ' %';
    document.getElementById('perf-row-gpu-load').textContent =
      'GPU load   ' + gpuLoad + ' %  (est.)';

    // Performance rating
    var ratingEl = document.getElementById('perf-row-rating');
    if (fps > 55 && frt < 18){
      ratingEl.innerHTML = '<span style="color:#0f0">PERFORMANCE: EXCELLENT  (Smooth gameplay)</span>';
    } else if (fps >= 30){
      ratingEl.innerHTML = '<span style="color:#ff0">PERFORMANCE: GOOD  (Stable but limited)</span>';
    } else if (fps > 0){
      ratingEl.innerHTML = '<span style="color:#f44">PERFORMANCE: POOR  (Bottleneck detected! Check instancing/grass density)</span>';
    } else {
      ratingEl.innerHTML = '<span style="color:#888">PERFORMANCE: —  (gathering data)</span>';
    }
  }

  _initPhysics(){
    try {
      if(typeof RAPIER === 'undefined') return;
      this.physicsWorld = new RAPIER.World({x:0, y:-20, z:0});
      this._eventQueue = new RAPIER.EventQueue(false);
      // Ground body
      var gDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0);
      var gBody = this.physicsWorld.createRigidBody(gDesc);
      var gCol = this.physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(160, 0.5, 160), gBody);
      if(gCol && typeof gCol.setActiveEvents === 'function') gCol.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      gCol.userData = {type:'ground'};
      this._physBodies.push(gBody);
      // Wall colliders
      if(this.world && this.world.walls){
        for(const w of this.world.walls){
          try {
            var wDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(w.x, 0.5, w.z);
            var wBody = this.physicsWorld.createRigidBody(wDesc);
            var wCol = this.physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(w.w/2, 5.0, w.d/2), wBody);
            if(wCol && typeof wCol.setActiveEvents === 'function') wCol.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
            wCol.userData = {type:'wall'};
            this._physBodies.push(wBody);
          } catch(e2){}
        }
      }
    } catch(e){ console.warn('Rapier init:', e); }
  }

  /* Rapier collision event handler (compat: drainCollisionEvents gives
     collider handles, resolved back to wrappers via getCollider) */
  _onCollision(c1Handle, c2Handle){
    if(!this.physicsWorld) return;
    var c1 = this.physicsWorld.getCollider(c1Handle);
    var c2 = this.physicsWorld.getCollider(c2Handle);
    if(!c1 || !c2) return;
    var d1 = c1.userData;
    var d2 = c2.userData;
    if(!d1 || !d2) return;

    // Shell-wall
    if(d1.type === 'shell' && d2.type === 'wall'){
      if(!d1.shell.dead){
        d1.shell.dead = true;
        var sp1 = d1.shell._physBody ? d1.shell._physBody.translation() : null;
        this.spawnExplosion(sp1 ? sp1.x : d1.shell.x, 1.0, sp1 ? sp1.z : d1.shell.z, 0xffaa33, 6, 'wall');
        this.spawnBurst(sp1 ? sp1.x : d1.shell.x, 1.0, sp1 ? sp1.z : d1.shell.z, {count: 3, tex: 'dust', speed: 3.5, size: 0.9, life: 0.4, rise: 1.2, gravity: 5, blend: 'normal', fade: 0.7});
      }
      return;
    }
    if(d1.type === 'wall' && d2.type === 'shell'){
      if(!d2.shell.dead){
        d2.shell.dead = true;
        var sp2 = d2.shell._physBody ? d2.shell._physBody.translation() : null;
        this.spawnExplosion(sp2 ? sp2.x : d2.shell.x, 1.0, sp2 ? sp2.z : d2.shell.z, 0xffaa33, 6, 'wall');
        this.spawnBurst(sp2 ? sp2.x : d2.shell.x, 1.0, sp2 ? sp2.z : d2.shell.z, {count: 3, tex: 'dust', speed: 3.5, size: 0.9, life: 0.4, rise: 1.2, gravity: 5, blend: 'normal', fade: 0.7});
      }
      return;
    }

    // Shell-tank
    if(d1.type === 'shell' && d2.type === 'tank'){
      if(!d1.shell.dead) this._onShellHitTank(d1.shell, d2.tank);
      return;
    }
    if(d1.type === 'tank' && d2.type === 'shell'){
      if(!d2.shell.dead) this._onShellHitTank(d2.shell, d1.tank);
      return;
    }
  }

  _onShellHitTank(shell, tank){
    if(shell.dead) return;
    shell._hitByPhysics = true;
    // Sync position from physics body for accurate collision point
    if(shell._physBody){
      var t = shell._physBody.translation();
      shell.x = t.x; shell.y = t.y; shell.z = t.z;
    }
    if(tank === shell.owner && shell.life > (shell.owner.def.shellRange/shell.speed) - 0.15) return;
    var armor = tank.def.armor;
    if(armor && shell._tryRicochet(tank, this)){
      // Shell bounced - update physics body to match reflected state
      if(shell._physBody){
        shell._physBody.setTranslation({x: shell.x, y: shell.y, z: shell.z}, true);
        shell._physBody.setLinvel({x: shell.dir.x * shell.speed, y: 0, z: shell.dir.z * shell.speed}, true);
      }
      return;
    }
    tank.takeDamage(shell.damage, shell.owner, this);
    this._tankHitVfx(tank, shell.dir.x, shell.dir.z, 0xffaa40);
    shell.dead = true;
  }

  /* Trajectory / aim line: main line + optional 10m markers (professional) */
  _initAimLine(){
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent:true, opacity:this.settings.aimLineOpacity,
    });
    // Triangle cone: muzzle → left → right → muzzle (4 vertices)
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    this.aimLine = new THREE.Line(geo, mat);
    this.aimLine.visible = false;
    this.aimLine.frustumCulled = false;
    this.scene.add(this.aimLine);

    // Marker ticks + number labels (professional mode)
    const markerMat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent:true, opacity:this.settings.aimLineOpacity * 0.6,
    });
    const markerGeo = new THREE.BufferGeometry();
    const maxMarks = 10;
    this._aimMarkerArr = new Float32Array(maxMarks * 2 * 3);
    markerGeo.setAttribute('position', new THREE.BufferAttribute(this._aimMarkerArr, 3));
    this.aimMarkers = new THREE.LineSegments(markerGeo, markerMat);
    this.aimMarkers.visible = false;
    this.aimMarkers.frustumCulled = false;
    this.scene.add(this.aimMarkers);

    // Number sprites for each marker
    this._aimLabels = [];
    for(let i=1; i<=maxMarks; i++){
      const c = document.createElement('canvas');
      c.width = 128; c.height = 64;
      const g = c.getContext('2d');
      g.shadowColor = 'rgba(0,0,0,0.8)';
      g.shadowBlur = 6;
      g.fillStyle = '#ffffff';
      g.font = 'bold 28px Segoe UI, Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText((i*10)+'m', 64, 32);
      const tex = new THREE.CanvasTexture(c);
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({map:tex, depthTest:false, transparent:true, opacity:this.settings.aimLineOpacity}));
      spr.scale.set(2.4, 1.2, 1);
      spr.visible = false;
      this.scene.add(spr);
      this._aimLabels.push(spr);
    }
  }
  refreshAimLineStyle(){
    if(!this.aimLine) return;
    this.aimLine.material.opacity = this.settings.aimLineOpacity;
    this.aimLine.material.color.set(this.settings.aimLineColor);
    if(this.aimMarkers){
      this.aimMarkers.material.opacity = this.settings.aimLineOpacity * 0.6;
      this.aimMarkers.material.color.set(this.settings.aimLineColor);
    }
    if(this._aimLabels){
      this._aimLabels.forEach(s=>s.material.opacity = this.settings.aimLineOpacity);
    }
  }

  _onResize(){
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth/innerHeight;
    this.camera.updateProjectionMatrix();
  }

  applySettings(s){
    this.settings = s;
    this.camMode = s.camMode || 'arrows';
    this.cameraMode = s.cameraMode || 'dynamic';
    if(this.input){
      this.input.binds = s.binds;
      this.input.settings = s;
      this.input.resetCamSwipe();
    }
    this.refreshAimLineStyle();
    this.refreshViewRangeStyle();
    this.refreshViewRangeWidth();
    this.applyGraphicsSettings();
    this.camAngle = Math.PI + (s.camRotation || 0);
  }

  applyGraphicsSettings(){
    const q = this.settings.graphicsQuality;
    this.isFancy = q === 'fancy';
    this.renderer.shadowMap.enabled = true;
    this._maxPixelRatio = Math.min(devicePixelRatio, this.isFancy ? 2 : 1.5);
    this.renderer.setPixelRatio(this._maxPixelRatio);
    if(this.world) this.world.setQuality(q);
  }

  setUseCustomMap(v){ this._useCustomMap = !!v; }

  refreshViewRangeStyle(){
    if(!this.tanks) return;
    for(const t of this.tanks){
      t.setViewRangeStyle(this.settings.viewRangeOpacity, this.settings.viewRangeColor);
    }
  }

  refreshViewRangeWidth(){
    if(!this.tanks) return;
    for(const t of this.tanks){
      if(t.refreshViewRangeWidth) t.refreshViewRangeWidth();
    }
  }

  /* ===========================================================
     ENTRY MODES
     =========================================================== */

  /* ---------- SINGLEPLAYER ---------- */
  startSingleplayer(){
    this.mode='sp'; this._resetArena();
    try {
      var m = this._useCustomMap ? loadCustomMap() : null;
      if(!m) m = loadMainMap();
      if(!m && typeof DEFAULT_MAP !== 'undefined' && DEFAULT_MAP) m = DEFAULT_MAP;
      if(m) this.world.loadCustomMapData(m);
    } catch(e){ console.warn('Map load error:', e); }
    try {
      this._spawnLocal();
      for(let i=0;i<20;i++) this._spawnBot();
      this._spawnDummy();
    } catch(e){ console.warn('Spawn error:', e); }
    if(window.Menu && Menu.bumpStat) Menu.bumpStat('battles', 1);
    this._begin();
  }

  /* ---------- GLADIATOR (battle royale, SP) ---------- */
  startGladiator(){
    this.mode='sp'; this._resetArena();
    try {
      var m = this._useCustomMap ? loadCustomMap() : null;
      if(!m && typeof GLADIATOR_MAP !== 'undefined' && GLADIATOR_MAP) m = GLADIATOR_MAP;
      if(!m) m = loadMainMap();
      if(!m && typeof DEFAULT_MAP !== 'undefined' && DEFAULT_MAP) m = DEFAULT_MAP;
      if(m) this.world.loadCustomMapData(m);
    } catch(e){ console.warn('Map load error:', e); }
    const cfg = GAMEMODES.gladiator;
    const spawns = this._gladSpawnList();
    this._initGladiator();
    const localSp = spawns.length ? spawns.shift() : this.world.randomSpawn();
    this._spawnLocal(localSp.x, localSp.z, localSp.ry);
    for(let i=0;i<cfg.botCount;i++){
      const sp = spawns.length ? spawns.shift() : this.world.randomSpawn();
      this._spawnBot(sp.x, sp.z, sp.ry);
    }
    if(window.Menu && Menu.bumpStat) Menu.bumpStat('battles', 1);
    this._begin();
  }

  _gladSpawnList(){
    let pts = (this.world.spawnPoints && this.world.spawnPoints.gladiator) ? this.world.spawnPoints.gladiator.slice() : [];
    pts = pts.filter(p => !this.world._inLake(p.x, p.z, 3) && !this.world.collides(p.x, p.z, 3));
    const hf = this.world.half;
    const h80 = Math.round(hf * 0.8), h37 = Math.round(hf * 0.37);
    const fallback = [
      {x:-h80,z:-h80},{x:h80,z:-h80},{x:-h80,z:h80},{x:h80,z:h80},
      {x:-h80,z:0},{x:h80,z:0},{x:0,z:-h80},{x:0,z:h80},
      {x:-h37,z:-h37},{x:h37,z:h37},
    ];
    const had = pts.length;
    for(let i=0;i<fallback.length && pts.length<10;i++){
      if(!pts.some(p => Math.hypot(p.x-fallback[i].x, p.z-fallback[i].z) < 12)){
        pts.push({x:fallback[i].x, z:fallback[i].z, ry:Math.random()*6});
      }
    }
    for(let i=pts.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=pts[i]; pts[i]=pts[j]; pts[j]=t; }
    if(had < 10 && pts.length < 10) Menu.toast('Map has only '+had+' gladiator spawn points — filling in corners');
    return pts.slice(0, 10);
  }

  _initGladiator(){
    const cfg = Object.assign({}, GAMEMODES.gladiator);
    // Scale the zone shrink to the world size so matches keep a sane length
    cfg.zone = Object.assign({}, cfg.zone, {
      chunk: Math.max(12, Math.round(this.world.half / 5)),
      minHalf: Math.round(this.world.half * 0.1),
    });
    this.glad = {
      cfg, stage:0,
      safeHalf: this.world.half, orangeHalf: null, phase:'grace', phaseTimer: cfg.zone.graceTime,
      alive:0, winner:null, ended:false,
      airdrop:null, airdropTimer: cfg.airdrop.firstDelay,
    };
    this._gladBoxes = [];
    this._gladPickups = [];
    
    // ZONE SYSTEM - CHUNK-BASED GRID
    this._gladZoneChunks = null;
    this._gladChunkMeshes = [];
    this._gladChunkOverlays = [];
    this._gladCorruptedChunks = new Set(); // chunks that have turned red
    this._gladNextCorruptionIndex = 0;
    this._gladChunkGlowTime = 0;
    
    // Zone ground overlay (canvas texture, regenerated on state change)
    const _zo = this._createGladZoneOverlay();
    this._gladZoneCanvas = _zo.canvas;
    this._gladZoneTex = _zo.tex;
    const zmat = new THREE.MeshBasicMaterial({map:this._gladZoneTex, transparent:true, opacity:0.55, depthWrite:false});
    const zgeo = new THREE.PlaneGeometry(this.world.size, this.world.size);
    zgeo.rotateX(-Math.PI/2);
    this._gladZoneMesh = new THREE.Mesh(zgeo, zmat);
    this._gladZoneMesh.position.y = 0.06;
    this._gladZoneMesh.renderOrder = 5;
    this.scene.add(this._gladZoneMesh);
    
    // Initialize chunk grid for zone representation
    this._initGladChunkGrid();
    
    this._refreshGladZone();
    // Blue boxes placed via the map editor
    (this.world.blueBoxes || []).forEach(b => this._gladSpawnBox(b.x, b.z));
    const gh = document.getElementById('glad-hud');
    if(gh) gh.classList.remove('hidden');
  }

_clearGladState(){
     this.glad = null;
     if(this._gladZoneMesh){ this.scene.remove(this._gladZoneMesh); this._gladZoneMesh.geometry.dispose(); this._gladZoneMesh.material.dispose(); this._gladZoneMesh = null; }
     if(this._gladZoneTex) this._gladZoneTex.dispose();
     if(this._gladMarker){ this.scene.remove(this._gladMarker); if(this._gladMarkerTex) this._gladMarkerTex.dispose(); this._gladMarker = null; this._gladMarkerCanvas = null; this._gladMarkerTex = null; this._gladMarkerKey = null; }
     this._gladBoxes.forEach(b => { if(b.mesh){ this.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); } });
     this._gladBoxes = [];
     this._gladPickups.forEach(p => { if(p.mesh){ this.scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); } });
     this._gladPickups = [];
     this._gladClearAirdropVisuals();
     
     // Clean up chunk system
     if(this._gladChunkMeshes){
       this._gladChunkMeshes.forEach(mesh => {
         if(mesh){ this.scene.remove(mesh); if(mesh.geometry) mesh.geometry.dispose(); if(mesh.material) mesh.material.dispose(); }
       });
       this._gladChunkMeshes = [];
     }
     if(this._gladChunkOverlays){
       this._gladChunkOverlays.forEach(overlay => {
         if(overlay){ this.scene.remove(overlay); if(overlay.geometry) overlay.geometry.dispose(); if(overlay.material) overlay.material.dispose(); }
       });
       this._gladChunkOverlays = [];
     }
     this._gladZoneChunks = null;
     this._gladCorruptedChunks = new Set();
     this._gladNextCorruptionIndex = 0;
     this._gladChunkGlowTime = 0;
     if(this._gladZoneCanvas){
       if(this._gladZoneTex) this._gladZoneTex.dispose();
       const _zo2 = this._createGladZoneOverlay();
       this._gladZoneCanvas = _zo2.canvas;
       this._gladZoneTex = _zo2.tex;
     }
     
     const gh = document.getElementById('glad-hud');
     if(gh) gh.classList.add('hidden');
     const gb = document.getElementById('glad-banner');
     if(gb) gb.classList.add('hidden');
     const gr = document.getElementById('glad-result');
     if(gr) gr.classList.add('hidden');
   }

  _gladClearAirdropVisuals(){
    if(this._gladAirBeam){ this.scene.remove(this._gladAirBeam); this._gladAirBeam.geometry.dispose(); this._gladAirBeam.material.dispose(); this._gladAirBeam = null; }
    if(this._gladAirCrate){ this.scene.remove(this._gladAirCrate); this._gladAirCrate.geometry.dispose(); this._gladAirCrate.material.dispose(); this._gladAirCrate = null; }
    if(this._gladAirRing){ this.scene.remove(this._gladAirRing); this._gladAirRing.geometry.dispose(); this._gladAirRing.material.dispose(); this._gladAirRing = null; }
    if(this._gladAirCircle){ this.scene.remove(this._gladAirCircle); this._gladAirCircle.geometry.dispose(); this._gladAirCircle.material.dispose(); this._gladAirCircle = null; }
    if(this._gladAirOutline){ this.scene.remove(this._gladAirOutline); this._gladAirOutline.geometry.dispose(); this._gladAirOutline.material.dispose(); this._gladAirOutline = null; }
    if(this._gladAirCounter){
      this.scene.remove(this._gladAirCounter);
      if(this._gladAirCounter.material) this._gladAirCounter.material.dispose();
      if(this._gladAirCounterTex) this._gladAirCounterTex.dispose();
      this._gladAirCounter = null; this._gladAirCounterCanvas = null; this._gladAirCounterCtx = null; this._gladAirCounterTex = null;
    }
    this._gladAirCounterKey = '';
    if(this._gladAirHolo){
      this.scene.remove(this._gladAirHolo);
      this._gladAirHolo.traverse(o => {
        if(!o.isMesh) return;
        if(o.geometry) o.geometry.dispose();
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach(m => { if(m && m.dispose) m.dispose(); });
      });
      if(this._gladAirHoloTexes){
        this._gladAirHoloTexes.forEach(t => { try{ t.dispose(); }catch(e){} });
        this._gladAirHoloTexes.clear();
      }
      this._gladAirHolo = null;
    }
    this._gladAirGen = (this._gladAirGen || 0) + 1;
  }

  _gladSpawnBox(x, z, id){
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 2.4, 2.4),
      new THREE.MeshStandardMaterial({color:0x2299ff, emissive:0x0a4a7a, emissiveIntensity:0.25, roughness:0.4, metalness:0.4})
    );
    mesh.position.set(x, 1.2, z);
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    this._gladBoxIdSeq = (this._gladBoxIdSeq || 0) + 1;
    const box = { id: id || ('gb'+this._gladBoxIdSeq), x, z, hp:30, alive:true, mesh };
    this._gladBoxes.push(box);
    return box;
  }

  _gladDropPickup(x, z, power){
    const grp = new THREE.Group();
    const bm = new THREE.MeshStandardMaterial({color:0x2a7fff, emissive:0x1a5fdd, emissiveIntensity:0.8, roughness:0.3});
    const seg1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.85, 0.14), bm);
    const seg2 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.7, 0.14), bm);
    seg1.position.y = 0.3;
    seg2.position.set(0.08, -0.3, 0); seg2.rotation.z = 0.55;
    grp.add(seg1, seg2);
    grp.position.set(x, 1.15, z);
    this.scene.add(grp);
    this._gladPickups.push({ x, z, power, type:'power', mesh:grp, phase:Math.random()*6.28 });
    return this._gladPickups[this._gladPickups.length-1];
  }

  _gladKillBox(b){
    if(!b.alive) return;
    b.alive = false;
    if(b.mesh){ this.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); b.mesh = null; }
    this._gladDropPickup(b.x, b.z, GAMEMODES.gladiator.power.box);
  }

  _gladBoxHit(shell){
    if(!this._gladBoxes) return false;
    for(const b of this._gladBoxes){
      if(!b.alive) continue;
      const dx = shell.x - b.x, dz = shell.z - b.z;
      const rr = 1.7 + (shell.radius || 0.4);
      if(dx*dx + dz*dz < rr*rr){
        b.hp -= shell.damage;
        this.spawnExplosion(b.x, 1.5, b.z, 0x44ccff, 6, 'box');
        if(b.hp <= 0){
          this._gladKillBox(b);
          if(shell.owner === this.localTank) Menu.toast('\u26A1 Blue box destroyed! +5 power dropped');
        }
        return true;
      }
    }
    return false;
  }

_inGladRed(x, z){
     const g = this.glad;
     if(!g) return false;
     const c = this._gladChunkAt(x, z);
     if(!c) return true;   // off-grid (wall/lake/outside) = unsafe
     return c.state === 'red';
   }

   _gladChunkAt(x, z){
     const g = this.glad;
     if(!g || !this._gladChunkIdx) return null;
     const cs = g.cfg.zone.chunk;
     const gi = Math.round(x / cs), gj = Math.round(z / cs);
     return this._gladChunkIdx.get(gi + ',' + gj) || null;
   }

   _initGladChunkGrid(){
     const g = this.glad;
     const cfg = g.cfg;
     const half = this.world.half;
     const chunkSize = cfg.zone.chunk;

     // Create a chunk grid covering the entire map.
     // Each chunk starts 'safe'; the zone flags random edge chunks 'orange'
     // (countdown) and later 'red' (danger).
     const chunkGridSize = Math.ceil(half / chunkSize) + 1;

     this._gladZoneChunks = [];
     this._gladChunkIdx = new Map();
      for(let gx = -chunkGridSize; gx <= chunkGridSize; gx++){
        for(let gz = -chunkGridSize; gz <= chunkGridSize; gz++){
          const cx = gx * chunkSize;
          const cz = gz * chunkSize;
          // Every grid cell is a chunk (lakes/walls included) so the zone can
          // consume the whole map and no position maps to an "unsafe off-grid"
          // chunk that would deal phantom damage.
          const chunk = {
           x: cx, z: cz,
           id: gx + ',' + gz,
           gi: gx, gj: gz,
           state: 'safe',   // 'safe' | 'orange' | 'red'
           orangeUntil: 0,
           glowTime: 0,
         };
         this._gladZoneChunks.push(chunk);
         this._gladChunkIdx.set(chunk.id, chunk);
       }
     }
// Track which chunks are close to player for countdown
     this._gladPlayerChunkDist = null;
   }

/* Chunks currently safe that border a red chunk or the outer map edge. */
   _gladEdgeChunks(){
     const g = this.glad;
     if(!g || !this._gladZoneChunks || !this._gladChunkIdx) return [];
     const out = [];
     for(const c of this._gladZoneChunks){
       if(c.state !== 'safe') continue;
       const nb = [
         (c.gi + 1) + ',' + c.gj,
         (c.gi - 1) + ',' + c.gj,
         c.gi + ',' + (c.gj + 1),
         c.gi + ',' + (c.gj - 1),
];
        let edge = false;
        const half = this.world.half;
        for(let k = 0; k < 4; k++){
          const n = this._gladChunkIdx.get(nb[k]);
          // A neighbour that is missing (grid border), red, or OUTSIDE the
          // visible map makes this chunk part of the outer perimeter, so the
          // zone starts eating at the visible map edges right away.
          if(!n || n.state === 'red' || Math.abs(n.x) > half || Math.abs(n.z) > half){
            edge = true; break;
          }
        }
       if(edge) out.push(c);
     }
     return out;
   }

/* Seconds between flagging a new chunk orange — accelerates as the safe
       area shrinks and as the match reaches its end-game. */
   _gladPickInterval(){
     const g = this.glad;
     if(!g || !this._gladZoneChunks) return 8;
     let total = 0, safeCount = 0;
     for(const c of this._gladZoneChunks){ total++; if(c.state !== 'red') safeCount++; }
     const frac = total ? (1 - safeCount / total) : 1;
     const base = (g.cfg.zone.pickTime || 8);
     let iv = Math.max(0.5, base - frac * (base - 2));
     if(g.alive != null && g.alive > 0 && g.alive <= 3) iv = Math.min(iv, 1.2);
     return iv;
   }

   /* Flag a wave of 5 safe edge chunks as ORANGE. The 5 chunks are grouped
      into 2-3 connected clusters in a random layout (4+1, 5, 2+2+1, 3+2,
      1+1+3). Clusters in the same wave share the same orangeUntil so connected
      same-timing chunks visually merge into one shape. A layout is only kept
      if it cannot split the safe area into islands. */
   _gladSpawnWave(){
     const g = this.glad;
     if(!g || !this._gladZoneChunks) return false;
     if(!this._gladEdgeChunks().some(c => c.state === 'safe')) return false;
     const now = this.time || 0;
     const ttl = g.cfg.zone.chunkOrange || 90;
     const patterns = [[4,1], [5], [2,2,1], [3,2], [1,1,3]];
     for(let attempt = 0; attempt < 8; attempt++){
       const pattern = patterns[Math.floor(Math.random() * patterns.length)];
       const used = new Set();
       const wave = [];
       for(const size of pattern){
         const cl = this._gladBuildCluster(size, used);
         for(const c of cl){
           if(c.state === 'safe' && wave.indexOf(c) < 0) wave.push(c);
         }
       }
       if(!wave.length) continue;
       // Reject layouts that would leave an island of safe chunks stranded
       // behind a red barrier when this wave turns red.
       if(!this._gladSafeStaysConnected(new Set(wave.map(c => c.id)))) continue;
       for(const c of wave){
         c.state = 'orange';
         c.orangeUntil = now + ttl;
       }
       return true;
     }
     // Every random layout would carve an island; keep the zone where it is.
     return false;
   }

   /* True if, once the given chunks (plus everything already orange, which
      turns red before this wave does) are red, the remaining safe cells still
      form ONE connected blob — i.e. the zone never strands an island. */
   _gladSafeStaysConnected(turnRed){
     const starts = [];
     for(const c of this._gladZoneChunks){
       if(c.state === 'safe' && !turnRed.has(c.id)) starts.push(c);
     }
     if(!starts.length) return true;
     const seen = new Set();
     const q = [starts[0]]; seen.add(starts[0].id);
     let cnt = 0;
     while(q.length){
       const c = q.pop(); cnt++;
       for(const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
         const n = this._gladChunkIdx.get((c.gi + dx) + ',' + (c.gj + dz));
         if(!n || seen.has(n.id)) continue;
         if(n.state !== 'safe' || turnRed.has(n.id)) continue; // orange blocks: it'll be red too
         seen.add(n.id); q.push(n);
       }
     }
     return cnt === starts.length;
   }

   /* Grow one connected cluster of `size` safe chunks, seeded from a random
      safe edge chunk. Growth prefers neighbours that stay ON the red/edge line,
      so each wave paints a strip along the perimeter (layer by layer from the
      map edges) instead of snaking straight toward the center. Falls back to
      filling any remaining safe chunks if the map leaves too little room. */
   _gladBuildCluster(size, used){
     const half = this.world.half;
     const candidates = this._gladEdgeChunks().filter(c =>
       c.state === 'safe' && !used.has(c.id) &&
       Math.abs(c.x) <= half && Math.abs(c.z) <= half); // only visible border chunks
     if(!candidates.length) return [];
     const seed = candidates[Math.floor(Math.random() * candidates.length)];
     used.add(seed.id);
     const cluster = [seed];
const frontier = this._gladNeighborsSafe(seed, used);
      const isVisible = c => Math.abs(c.x) <= half && Math.abs(c.z) <= half;
      while(cluster.length < size && frontier.length){
        // Prefer visible neighbours that hug the red/edge line (stay on the
        // current layer inside the map), falling back to any visible one.
        let pool = frontier.filter(isVisible);
        if(!pool.length) pool = frontier;
        const onLine = pool.filter(n => this._gladIsOnEdgeLine(n));
        if(onLine.length) pool = onLine;
       const n = pool[Math.floor(Math.random() * pool.length)];
       frontier.splice(frontier.indexOf(n), 1);
       if(!n || used.has(n.id) || n.state !== 'safe') continue;
       used.add(n.id);
       cluster.push(n);
       for(const nb of this._gladNeighborsSafe(n, used)) frontier.push(nb);
}
      // Never yank chunks from the middle of the field to fill a cluster: a
      // partial wave is better than a red dent poking into the safe area.
      return cluster;
    }

   /* True if the chunk borders a red chunk or the map edge (i.e. it sits on
      the current perimeter of the safe area). */
   _gladIsOnEdgeLine(c){
     const half = this.world.half;
     for(const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
       const n = this._gladChunkIdx.get((c.gi + dx) + ',' + (c.gj + dz));
       if(!n || n.state === 'red' || Math.abs(n.x) > half || Math.abs(n.z) > half) return true;
     }
     return false;
   }

   /* Safe, unclaimed 4-directional neighbours of a chunk. */
   _gladNeighborsSafe(c, used){
     const out = [];
     for(const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
       const n = this._gladChunkIdx.get((c.gi + dx) + ',' + (c.gj + dz));
       if(n && n.state === 'safe' && !used.has(n.id)) out.push(n);
     }
     return out;
   }

   /* Axis-aligned bounding box of the remaining safe (non-red) chunks. */
   _gladSafeBounds(){
     if(!this._gladZoneChunks) return null;
     let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, n = 0;
     for(const c of this._gladZoneChunks){
       if(c.state === 'red') continue;
       if(c.x < minX) minX = c.x;
       if(c.x > maxX) maxX = c.x;
       if(c.z < minZ) minZ = c.z;
       if(c.z > maxZ) maxZ = c.z;
       n++;
     }
     if(!n) return null;
     return { minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ };
   }

   /* Radius of the remaining safe area (half the wider bounding-box side). */
   _gladSafeRadius(){
     const b = this._gladSafeBounds();
     if(!b) return 0;
     return Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2;
   }

   /* High-res (1024px) zone overlay canvas so the square-grid tiles render
      crisp instead of smeared. Texture keeps linear filtering for distance. */
   _createGladZoneOverlay(){
     const canvas = document.createElement('canvas');
     canvas.width = canvas.height = 1024;
     const tex = new THREE.CanvasTexture(canvas);
     tex.generateMipmaps = false;
     tex.minFilter = THREE.LinearFilter;
     tex.magFilter = THREE.LinearFilter;
     if(this.renderer && this.renderer.capabilities && this.renderer.capabilities.getMaxAnisotropy){
       try { tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy(); } catch(e){}
     }
     return { canvas: canvas, tex: tex };
   }

   _refreshGladZone(){
     if(!this._gladZoneMesh || !this._gladZoneCanvas) return;
     const g = this.glad;
     if(g.phase === 'grace'){ this._gladZoneMesh.visible = false; return; }
     this._gladZoneMesh.visible = true;
     // Redraw tiles; live variants (pulse, countdown marker) run per-frame.
     this._gladPaintZone();
   }

   /* Paint the ground canvas from the current chunk states. */
   _gladPaintZone(){
     if(!this._gladZoneCanvas) return;
     const ctx = this._gladZoneCanvas.getContext('2d');
     const S = this._gladZoneCanvas.width;
     ctx.clearRect(0, 0, S, S);
     if(this.glad && this.glad.phase !== 'grace') this._drawGladZone(ctx, S);
     if(this._gladZoneTex) this._gladZoneTex.needsUpdate = true;
   }

   _drawGladZone(ctx, S){
     const g = this.glad;
     if(!g || g.phase === 'grace') return;
     if(!this._gladZoneChunks) return;
     const scale = S / this.world.size;
     const toPx = (v) => S/2 + v * scale;
const chunkSize = g.cfg.zone.chunk;
     const cell = chunkSize * scale;
     ctx.lineCap = 'round';

     // Crisp square-grid tiles: orange warning chunks and red danger chunks.
     for(const chunk of this._gladZoneChunks){
       if(chunk.state !== 'orange' && chunk.state !== 'red') continue;
       const cx = toPx(chunk.x), cz = toPx(chunk.z);
       if(chunk.state === 'orange') this._drawOrangeTile(ctx, cx, cz, cell);
       else this._drawRedTile(ctx, cx, cz, cell);
     }

     // Dashed outline around the remaining safe chunks
     const b = this._gladSafeBounds();
     if(b){
       const x1 = toPx(b.minX), z1 = toPx(b.minZ);
       const x2 = toPx(b.maxX), z2 = toPx(b.maxZ);
       ctx.save();
       ctx.strokeStyle = 'rgba(255,200,90,0.9)';
       ctx.lineWidth = Math.max(2.5, S * 0.004);
       ctx.setLineDash([Math.max(5, cell * 0.16), Math.max(5, cell * 0.12)]);
       ctx.strokeRect(x1, z1, Math.max(1, x2 - x1), Math.max(1, z2 - z1));
       ctx.restore();
     }
   }

   /* Orange warning tile: crisp filled square (part of the square-grid look). */
   _drawOrangeTile(ctx, cx, cz, cell){
     const inset = -0.5; // overlap neighbours by 1px so tiles merge with no seams
     const s = cell - inset * 2;
     const x0 = cx - cell/2 + inset, z0 = cz - cell/2 + inset;
     ctx.fillStyle = 'rgba(255,160,45,0.5)';
     ctx.fillRect(x0, z0, s, s);
     ctx.strokeStyle = 'rgba(255,214,120,0.6)';
     ctx.lineWidth = Math.max(1.5, cell * 0.035);
     ctx.strokeRect(x0, z0, s, s);
   }

   /* Red danger tile: crisp red square + symmetric lattice of tiny X marks. */
   _drawRedTile(ctx, cx, cz, cell){
     const t = this.time || 0;
     const inset = -0.5; // overlap neighbours by 1px so tiles merge with no seams
     const s = cell - inset * 2;
     const x0 = cx - cell/2 + inset, z0 = cz - cell/2 + inset;
     ctx.fillStyle = `rgba(205,32,32,${0.5 + 0.1 * Math.sin(t * 5 + cx * 0.13 + cz * 0.07)})`;
     ctx.fillRect(x0, z0, s, s);
     ctx.strokeStyle = 'rgba(255,95,80,0.6)';
     ctx.lineWidth = Math.max(1.5, cell * 0.035);
     ctx.strokeRect(x0, z0, s, s);
     const n = 3;
     const step = s / n;
     const hx = cell * 0.055;
     ctx.beginPath();
     for(let i = 0; i < n; i++){
       for(let j = 0; j < n; j++){
         const x = x0 + (i + 0.5) * step;
         const z = z0 + (j + 0.5) * step;
         ctx.moveTo(x - hx, z - hx); ctx.lineTo(x + hx, z + hx);
         ctx.moveTo(x - hx, z + hx); ctx.lineTo(x + hx, z - hx);
       }
     }
     ctx.strokeStyle = '#ff5a4d';
     ctx.lineWidth = Math.max(1.5, cell * 0.042);
     ctx.stroke();
   }

   _gladChunkInZone(chunk){
     const g = this.glad;
     if(!g) return false;
     const h = Math.max(0, g.safeHalf);
     // Chunk center is at (chunk.x, chunk.z) which is in world coordinates
     // The zone is a square from -h to h
     return Math.abs(chunk.x) <= h && Math.abs(chunk.z) <= h;
   }

   /* Floating zone marker above the orange/red chunk closest to the player.
      A THREE.Sprite always faces the camera (billboard). Orange chunks show
      their per-chunk countdown; red chunks just show a danger badge. */
   _gladEnsureMarker(){
     if(this._gladMarker) return this._gladMarker;
     const cv = document.createElement('canvas');
     cv.width = cv.height = 256;
     const tex = new THREE.CanvasTexture(cv);
     tex.minFilter = THREE.LinearFilter;
     tex.magFilter = THREE.LinearFilter;
     const mat = new THREE.SpriteMaterial({map: tex, transparent: true, depthTest: true, depthWrite: false});
     const spr = new THREE.Sprite(mat);
     spr.scale.set(5.2, 5.2, 1);
     this._gladMarkerCanvas = cv;
     this._gladMarkerTex = tex;
     this._gladMarkerKey = null;
     this._gladMarker = spr;
     this.scene.add(spr);
     spr.visible = false;
     return spr;
   }

   _gladHideMarker(){
     if(this._gladMarker && this._gladMarker.visible) this._gladMarker.visible = false;
   }

   _roundRect(ctx, x, y, w, h, r){
     ctx.beginPath();
     if(ctx.roundRect){ ctx.roundRect(x, y, w, h, r); return; }
     ctx.moveTo(x + r, y);
     ctx.arcTo(x + w, y, x + w, y + h, r);
     ctx.arcTo(x + w, y + h, x, y + h, r);
     ctx.arcTo(x, y + h, x, y, r);
     ctx.arcTo(x, y, x + w, y, r);
     ctx.closePath();
   }

   _gladDrawMarkerFace(isOrange, secs){
     const cv = this._gladMarkerCanvas;
     const ctx = cv.getContext('2d');
     const W = cv.width, H = cv.height;
     ctx.clearRect(0, 0, W, H);
     ctx.textAlign = 'center';
     ctx.textBaseline = 'middle';
     if(isOrange){
       const w = 210, h = 126;
       const x = (W - w) / 2, y = (H - h) / 2;
       ctx.fillStyle = 'rgba(255,140,30,0.28)';
       this._roundRect(ctx, x - 10, y - 10, w + 20, h + 20, 20); ctx.fill();
       ctx.fillStyle = 'rgba(18,15,9,0.94)';
       this._roundRect(ctx, x, y, w, h, 18); ctx.fill();
       ctx.strokeStyle = 'rgba(255,190,80,0.95)';
       ctx.lineWidth = 5;
       this._roundRect(ctx, x, y, w, h, 18); ctx.stroke();
       ctx.font = '900 88px Arial, sans-serif';
       ctx.fillStyle = '#ffd188';
       ctx.fillText(String(secs), W / 2, H / 2 + 4);
       ctx.font = '700 26px Arial, sans-serif';
       ctx.fillStyle = 'rgba(255,200,120,0.92)';
       ctx.fillText('ZONE IN', W / 2, y - 32);
       ctx.fillText('turns red', W / 2, y + h + 32);
     } else {
       const w = 200, h = 200;
       const x = (W - w) / 2, y = (H - h) / 2;
       ctx.fillStyle = 'rgba(255,55,35,0.3)';
       this._roundRect(ctx, x - 10, y - 10, w + 20, h + 20, 30); ctx.fill();
       ctx.fillStyle = 'rgba(22,8,8,0.96)';
       this._roundRect(ctx, x, y, w, h, 24); ctx.fill();
       ctx.strokeStyle = 'rgba(255,70,50,0.95)';
       ctx.lineWidth = 6;
       this._roundRect(ctx, x, y, w, h, 24); ctx.stroke();
       ctx.font = '900 130px Arial, sans-serif';
       ctx.fillStyle = '#ff4a35';
       ctx.fillText('!', W / 2, H / 2 + 8);
       ctx.font = '700 28px Arial, sans-serif';
       ctx.fillStyle = 'rgba(255,120,100,0.92)';
       ctx.fillText('DANGER', W / 2, y + h + 32);
     }
   }

   /* Place the marker on the nearest orange/red chunk and point it at the camera. */
   _gladUpdateMarker(){
     const g = this.glad, tank = this.localTank;
     if(!g || g.phase === 'grace' || g.ended || !tank || !tank.alive || !this._gladZoneChunks){
       this._gladHideMarker();
       return;
     }
     let best = null, bestD = Infinity;
     for(const c of this._gladZoneChunks){
       if(c.state !== 'orange' && c.state !== 'red') continue;
       const d = Math.hypot(c.x - tank.x, c.z - tank.z);
       if(d < bestD){ bestD = d; best = c; }
     }
     if(!best){ this._gladHideMarker(); return; }
     const spr = this._gladEnsureMarker();
     const isOrange = best.state === 'orange';
     const secs = isOrange ? Math.max(0, Math.ceil(best.orangeUntil - (this.time || 0))) : 0;
     const key = (isOrange ? 'o' : 'r') + ':' + Math.min(99, secs);
     if(this._gladMarkerKey !== key){
       this._gladMarkerKey = key;
       this._gladDrawMarkerFace(isOrange, secs);
       if(this._gladMarkerTex) this._gladMarkerTex.needsUpdate = true;
     }
// Keep the marker inside the chunk but never too close to the player:
      // start at the rect-closest point, then push it away from the tank
      // (toward the chunk centre) until it's at least minDist away or the
      // chunk boundary stops it.
      const half = g.cfg.zone.chunk / 2;
      const pad = Math.min(4, half * 0.25);
      const loX = best.x - half + pad, hiX = best.x + half - pad;
      const loZ = best.z - half + pad, hiZ = best.z + half - pad;
      let mx = Math.max(loX, Math.min(hiX, tank.x));
      let mz = Math.max(loZ, Math.min(hiZ, tank.z));
      const minDist = 6;
      if(Math.hypot(mx - tank.x, mz - tank.z) < minDist){
        const toCX = best.x - tank.x, toCZ = best.z - tank.z;
        const len = Math.hypot(toCX, toCZ);
        for(let s = 1; s <= 16; s++){
          const step = minDist * s / 16;
          let nx, nz;
          if(len > 0.001){
            nx = tank.x + toCX / len * step;
            nz = tank.z + toCZ / len * step;
          } else {
            nx = tank.x; nz = tank.z + step;
          }
          mx = Math.max(loX, Math.min(hiX, nx));
          mz = Math.max(loZ, Math.min(hiZ, nz));
          if(Math.hypot(mx - tank.x, mz - tank.z) >= minDist) break;
        }
      }
      spr.position.set(
        mx,
        4.6 + Math.sin((this.time || 0) * 2.4 + mx * 0.3) * 0.28,
        mz
      );
      spr.visible = true;
   }

   _gladSpawnForNew(){
    const pts = this._gladSpawnList();
    const taken = this.tanks.filter(t=>t.alive).map(t=>({x:t.x, z:t.z}));
    let best = null, bestD = -1;
    for(const p of pts){
      let minD = Infinity;
      for(const tk of taken){ const d = Math.hypot(p.x-tk.x, p.z-tk.z); if(d<minD) minD = d; }
      if(minD > bestD){ bestD = minD; best = p; }
    }
    return best || {x:0, z:0, ry:0};
  }

  /* ---------- GLADIATOR per-frame engine ---------- */
  _gladUpdate(dt){
    if(this._matchStartDelay > 0) return;
    const g = this.glad;
if(!g){ this._gladHideMarker(); return; }
    if(g.ended){ this._gladHideMarker(); return; }
    const cfg = g.cfg;

    // Grace phase countdown; once it hits 0 the zone starts eating chunks.
    if(g.phase === 'grace') g.phaseTimer = Math.max(0, g.phaseTimer - dt);

    // Zone stage machine: grace, then the zone repeatedly flags a random
    // safe-edge chunk ORANGE (per-chunk countdown) and flips it RED when its
    // timer runs out.
    const isHost = !g._client;
    if(isHost && g.phase === 'grace' && g.phaseTimer <= 0){
      g.phase = 'active';
      this._gladWaveTimer = 0.5;
      this._refreshGladZone();
      Menu.toast('Zone incoming!');
    }

    if(isHost && g.phase === 'active'){
      let changed = false;
      const now = this.time || 0;

      // Orange chunks reaching their countdown turn red (danger)
      for(const c of this._gladZoneChunks){
        if(c.state === 'orange' && now >= c.orangeUntil){
          c.state = 'red';
          this._gladCorruptedChunks.add(c.id);
          changed = true;
        }
      }

      // Every waveTime seconds, spawn a wave of 5 chunks grouped into random
      // connected clusters (4+1 / 5 / 2+2+1 / 3+2 / 1+1+3). All share the same
      // orangeUntil so adjacent same-type chunks merge into one shape.
      if(!this._gladZoneChunks) this._initGladChunkGrid();
      this._gladWaveTimer -= dt;
      if(this._gladWaveTimer <= 0){
        this._gladWaveTimer = (g.cfg.zone.waveTime || 60);
        if(this._gladSpawnWave()) changed = true;
      }

      if(changed) this._refreshGladZone();
    }

    // Per-frame zone canvas repaint + floating countdown/danger marker
    if(g.phase !== 'grace'){
      this._gladPaintZone();
      this._gladUpdateMarker();
    }

    // Red zone damage (redDps HP/s inside red cells / when fully collapsed)
    if(g.phase !== 'grace'){
      for(const t of this.tanks){
        if(!t.alive || t.dying || t.isDummy) continue;
        if(this._inGladRed(t.x, t.z)){
          t.takeDamage(cfg.redDps * Math.min(dt, 0.5), null, this, true);
          if(t.alive && !t.dying && Math.random() < dt * 6) this.spawnExplosion(t.x, 0.5, t.z, 0xff3030, 2, 'burn');
          this.spawnHitVfx(t.x, 0.5, t.z, 0, 0, 0xffaa40, {flashCount: 0, sparkCount: 6, sparkSpeed: 7, sparkLife: 0.3, dustCount: 0});
        }
      }
    }

    // Airdrops
    g.airdropTimer -= dt;
    if(!g.airdrop && g.airdropTimer <= 0){
      g.airdrop = this._gladSpawnAirdrop();
      g.airdropTimer = cfg.airdrop.interval;
      Menu.toast('Airdrop incoming!');
    } else if(g.airdrop){
      if(!g.airdrop.landed){
        g.airdrop.countdown -= dt;
        if(g.airdrop.countdown <= 0){
          g.airdrop.landed = true;
          g.airdrop.life = 60;
          Menu.toast('Airdrop landed — stand inside the blue circle!');
        }
      } else {
        g.airdrop.life -= dt;
        if(g.airdrop.life <= 0){
          this._gladClearAirdropVisuals();
          this._gladDropPickup(g.airdrop.x, g.airdrop.z, cfg.power.airdrop);
          Menu.toast('Airdrop expired — power dropped as pickup');
          g.airdrop = null;
        } else {
          for(const t of this.tanks){
            if(!t.alive || t.dying || t.isDummy) continue;
            const d = Math.hypot(t.x - g.airdrop.x, t.z - g.airdrop.z);
            if(d < 9.0){
              t._gladHoldTime = (t._gladHoldTime || 0) + dt;
              if(t === this.localTank) g.airdrop.localHold = t._gladHoldTime;
              if(t._gladHoldTime >= cfg.airdrop.holdTime){
                t.applyPower(cfg.power.airdrop, this);
                if(t === this.localTank) Menu.toast('Airdrop secured! +40 power');
                else if(g.winner && t === g.winner) Menu.toast('The winner grabbed the airdrop!');
                this.tanks.forEach(x=>{ x._gladHoldTime = 0; });
                this._gladClearAirdropVisuals();
                g.airdrop = null;
                break;
              }
            }
          }
        }
      }
    }

    // Shared power pickups: spin + collect (host-authoritative; any tank can grab)
    for(let i = this._gladPickups.length - 1; i >= 0; i--){
      const p = this._gladPickups[i];
      p.phase = (p.phase || 0) + dt * 3;
      if(p.mesh){
        p.mesh.rotation.y = p.phase;
        p.mesh.position.y = 1.15 + Math.sin(p.phase * 1.4) * 0.12;
      }
      for(const t of this.tanks){
        if(!t.alive || t.dying || t.isDummy) continue;
        const d = Math.hypot(t.x - p.x, t.z - p.z);
        if(d < 2.6){
          t.applyPower(p.power, this);
          if(t === this.localTank) Menu.toast('+' + p.power + ' power!');
          if(p.mesh){
            this.scene.remove(p.mesh);
            p.mesh.children.forEach(c => { c.geometry.dispose(); c.material.dispose(); });
          }
          this._gladPickups.splice(i, 1);
          break;
        }
      }
    }

    // Blue boxes idle pulse
    for(const b of this._gladBoxes){
      if(b.alive && b.mesh){
        b.mesh.rotation.y += dt * 0.6;
        b.mesh.position.y = 1.2 + Math.sin(this.time * 2 + b.x) * 0.06;
      }
    }

    // Alive count & win check
    const alive = this.tanks.filter(t => t.alive && !t.dying && !t.isDummy);
    g.alive = alive.length;
    if(!g.winner && alive.length === 1){
      g.winner = alive[0];
      g.ended = true;
      this._gladAwardClanXP();
      this._gladShowResult(false);
    } else if(!g.winner && alive.length === 0){
      g.ended = true;
      this._gladAwardClanXP();
      this._gladShowResult(false);
    }
  }

  _gladSpawnAirdrop(){
    const cfg = this.glad.cfg;
const half = Math.max(12, this._gladSafeRadius() - 10);
    let x = 0, z = 0, tries = 0;
    do {
      x = (Math.random() * 2 - 1) * half;
      z = (Math.random() * 2 - 1) * half;
      tries++;
    } while((this.world._inLake(x, z, 4) || this.world.collidesWallsOnly(x, z, 5)) && tries < 5);
    const geo = new THREE.CylinderGeometry(3.2, 3.2, 260, 20, 1, true);
    geo.translate(0, 130, 0);
    const mat = new THREE.MeshBasicMaterial({color:0x00ddff, transparent:true, opacity:0.35, depthWrite:false});
    this._gladAirBeam = new THREE.Mesh(geo, mat);
    this._gladAirBeam.position.set(x, 0, z);
    this.scene.add(this._gladAirBeam);
    this._gladBuildAirdropVis(x, z);
    return { x, z, countdown: cfg.airdrop.countdown, hold: cfg.airdrop.holdTime, landed:false, life:0, localHold:0 };
  }

  /* Blue circle (matches the 9.0 hold radius) + lighter-blue outline ring +
     solid power-up barrel model (no hitbox) + countdown counter sprite.
     The barrel model loads async; everything else builds now. */
  _gladBuildAirdropVis(x, z){
    this._gladAirGen = (this._gladAirGen || 0) + 1;
    const gen = this._gladAirGen;

    // Ground circle (the zone a tank must stand in to secure the drop)
    const cg = new THREE.CircleGeometry(9.0, 64);
    cg.rotateX(-Math.PI / 2);
    const cm = new THREE.MeshBasicMaterial({color:0x1f9eff, transparent:true, opacity:0.30, depthWrite:false});
    this._gladAirCircle = new THREE.Mesh(cg, cm);
    this._gladAirCircle.position.set(x, 0.055, z);
    this._gladAirCircle.renderOrder = 4;
    this.scene.add(this._gladAirCircle);

    // Even-lighter-blue outline hugging the circle
    const rg = new THREE.RingGeometry(8.84, 9.60, 80);
    rg.rotateX(-Math.PI / 2);
    const rm = new THREE.MeshBasicMaterial({color:0xc9f3ff, transparent:true, opacity:0.85, side:THREE.DoubleSide, depthWrite:false, blending:THREE.AdditiveBlending});
    this._gladAirOutline = new THREE.Mesh(rg, rm);
    this._gladAirOutline.position.set(x, 0.07, z);
    this._gladAirOutline.renderOrder = 4;
    this.scene.add(this._gladAirOutline);

    // Countdown / hold counter floating above the drop
    this._gladAirCounter = this._gladMakeCounterSprite();
    this._gladAirCounter.position.set(x, 6.0, z);
    this._gladAirCounterKey = '';
    this.scene.add(this._gladAirCounter);

    // Hologram barrel model (async; pure visual — no hitbox)
    this._gladLoadAirdropHolo().then(raw => {
      if(gen !== this._gladAirGen){ if(raw) this._gladDisposeHoloScene(raw); return; }
      let grp = raw || this._gladMakeBarrelHolo();
      if(!grp || !grp.isObject3D){ if(grp) this._gladDisposeHoloScene(grp); grp = this._gladMakeBarrelHolo(); }
      this._gladAirHoloTexes = new Set();
      grp.traverse(o => {
        if(!o.isMesh) return;
        if(o.geometry) o.geometry.computeBoundingBox();
        const orig = o.material;
        const mk = (m) => new THREE.MeshBasicMaterial({
          map: (m && m.map) || null,
          color: 0xffffff, side: THREE.DoubleSide,
        });
        o.material = Array.isArray(orig) ? orig.map(mk) : mk(orig);
        if(Array.isArray(orig)) orig.forEach(m => { if(m && m.map) this._gladAirHoloTexes.add(m.map); });
        else if(orig && orig.map) this._gladAirHoloTexes.add(orig.map);
        o.castShadow = false; o.receiveShadow = false;
      });
      const box = new THREE.Box3().setFromObject(grp);
      const dim = box.getSize(new THREE.Vector3());
      const c = box.getCenter(new THREE.Vector3());
      const scale = Math.min(
        3.2 / Math.max(dim.x, dim.z, 0.01),
        2.8 / Math.max(dim.y, 0.01)
      );
      grp.scale.setScalar(scale);
      grp.position.set(x - c.x * scale, -box.min.y * scale + 0.15, z - c.z * scale);
      grp.rotation.y = Math.random() * Math.PI * 2;
      this._gladAirHolo = grp;
      this.scene.add(grp);
    });
  }

  _gladMakeCounterSprite(){
    const c = document.createElement('canvas'); c.width = 256; c.height = 100;
    this._gladAirCounterCanvas = c; this._gladAirCounterCtx = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c);
    this._gladAirCounterTex = tex;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({map:tex, depthTest:false, transparent:true}));
    spr.scale.set(5.4, 2.1, 1);
    return spr;
  }

  _gladDrawCounter(txt, sub, col){
    const c = this._gladAirCounterCanvas, g = this._gladAirCounterCtx;
    if(!c || !g) return;
    g.clearRect(0, 0, 256, 100);
    g.fillStyle = 'rgba(0,16,32,0.6)';
    g.beginPath();
    g.roundRect ? g.roundRect(34, 8, 188, 84, 18) : g.rect(34, 8, 188, 84);
    g.fill();
    g.strokeStyle = 'rgba(140,225,255,0.5)';
    g.lineWidth = 2;
    g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 52px Segoe UI';
    g.lineJoin = 'round';
    g.strokeStyle = '#00111f';
    g.lineWidth = 8;
    g.strokeText(txt, 128, sub ? 42 : 52);
    g.fillStyle = col;
    g.fillText(txt, 128, sub ? 42 : 52);
    if(sub){
      g.font = 'bold 24px Segoe UI';
      g.strokeStyle = '#00111f';
      g.lineWidth = 5;
      g.strokeText(sub, 128, 78);
      g.fillStyle = '#bfe9ff';
      g.fillText(sub, 128, 78);
    }
    if(this._gladAirCounterTex) this._gladAirCounterTex.needsUpdate = true;
  }

  /* Per-frame airdrop visuals: beam/outline pulse, hologram float+spin,
     blue smoke plume at the drop point, countdown counter text. Runs on
     both host and client. */
  _gladUpdateAirdropVis(dt){
    const g = this.glad;
    if(!g || !g.airdrop) return;
    const a = g.airdrop;
    if(this._gladAirBeam){
      this._gladAirBeam.material.opacity = a.landed
        ? 0.42 + 0.14 * Math.sin(this.time * 4)
        : 0.22 + 0.2 * Math.sin(this.time * 5);
    }
    if(this._gladAirOutline){
      this._gladAirOutline.material.opacity = 0.55 + 0.3 * Math.sin(this.time * 3);
    }
    if(this._gladAirCircle){
      this._gladAirCircle.material.opacity = 0.24 + 0.08 * Math.sin(this.time * 3);
    }
    if(this._gladAirHolo){
      this._gladAirHolo.position.y = 0.25 + Math.sin(this.time * 1.6) * 0.18;
    }
    if(this._gladAirCounter){
      this._gladAirCounter.position.y = 6.0 + Math.sin(this.time * 1.6) * 0.15;
    }
    // Blue smoke rising from the drop point
    this._gladAirSmokeT = (this._gladAirSmokeT || 0) + dt;
    if(this._gladAirSmokeT >= 0.1 && this.spawnBurst){
      this._gladAirSmokeT = 0;
      this.spawnBurst(a.x, 0.3 + Math.random() * 0.35, a.z, {
        count: 2, tex: 'smoke', color: 0xcfe9ff, speed: 0.6, size: 1.1,
        life: 1.3, rise: 1.4, gravity: -0.6, grow: 2.0, fade: 0.5, blend: 'normal',
      });
    }
    // Counter text
    const holdT = a.landed ? (this.localTank ? (this.localTank._gladHoldTime || 0) : 0) : 0;
    let txt, sub, col;
    if(!a.landed){ txt = Math.max(0, Math.ceil(a.countdown)) + 's'; sub = 'INCOMING'; col = '#8fd8ff'; }
    else if(holdT > 0){ txt = Math.max(0, Math.ceil(a.hold - holdT)) + 's'; sub = 'HOLD THE CIRCLE'; col = '#7ff0ff'; }
    else { txt = 'CLAIM'; sub = 'STAND IN BLUE CIRCLE'; col = '#bff2ff'; }
    const key = txt + '|' + sub;
    if(key !== this._gladAirCounterKey){
      this._gladAirCounterKey = key;
      this._gladDrawCounter(txt, sub, col);
    }
  }

  /* Load the Fuel_C_Barrels hologram prop (returns Promise<Scene|null>). */
  _gladLoadAirdropHolo(){
    return new Promise(resolve => {
      let loader = null;
      try{ loader = new THREE.GLTFLoader(); }catch(e){ loader = null; }
      if(!loader) return resolve(null);
      loader.load(
        'assets/props/airdrop/Fuel_C_Barrels.gltf?v=' + (CONFIG.MODEL_VER || 0),
        (gltf) => resolve(gltf && (gltf.scene || gltf)),
        undefined,
        () => resolve(null)
      );
    });
  }

  /* Dispose a freshly loaded (but unused / cancelled) hologram scene. */
  _gladDisposeHoloScene(grp){
    if(!grp) return;
    grp.traverse(o => {
      if(!o.isMesh) return;
      if(o.geometry) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach(m => { if(m) m.dispose(); });
    });
  }

  /* Procedural fallback hologram (a little stack of fuel barrels). */
  _gladMakeBarrelHolo(){
    const grp = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0x8fd4ff, side: THREE.DoubleSide,
    });
    const barrel = (r, h, x, z) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), mat);
      m.position.set(x, h / 2, z);
      grp.add(m);
    };
    barrel(0.55, 1.9, -0.7, 0.35);
    barrel(0.55, 1.9, 0.7, -0.3);
    barrel(0.6, 2.1, 0, 0.2);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat);
    crate.position.set(0.15, 2.1, -0.2);
    grp.add(crate);
    return grp;
  }

  _gladSnapshot(){
    const g = this.glad;
    if(!g) return null;
    return {
      stage: g.stage,
      safeHalf: g.safeHalf,
      orangeHalf: g.orangeHalf,
      phase: g.phase,
      phaseTimer: g.phaseTimer,
      alive: g.alive,
      winner: g.winner ? g.winner.id : null,
      ended: !!g.ended,
      airdropTimer: g.airdropTimer,
      airdrop: g.airdrop ? {
        x: g.airdrop.x, z: g.airdrop.z,
        countdown: g.airdrop.countdown, landed: g.airdrop.landed,
        life: g.airdrop.life, hold: g.airdrop.hold
      } : null,
      boxes: this._gladBoxes.filter(b => b.alive).map(b => ({id: b.id, x: b.x, z: b.z, hp: b.hp})),
      pickups: this._gladPickups.map(p => ({x: p.x, z: p.z, power: p.power})),
redChunks: (this._gladZoneChunks || []).filter(c => c.state === 'red').map(c => c.id),
      orangeChunks: (this._gladZoneChunks || []).filter(c => c.state === 'orange').map(c => ({
        id: c.id,
        secs: Math.max(0, (c.orangeUntil || 0) - (this.time || 0)),
      })),
      chunkSize: this.glad.cfg.zone.chunk,
    };
  }

  _gladApplyHostSnapshot(gs){
    const base = GAMEMODES.gladiator;
    const cfg = Object.assign({}, base, {zone: Object.assign({}, base.zone, {chunk: gs.chunkSize || base.zone.chunk})});
    if(!this.glad){
      this.glad = {
        cfg, stage:0, safeHalf:this.world.half, orangeHalf:null, phase:'grace', phaseTimer:0,
        alive:0, winner:null, winnerId:null, ended:false, airdrop:null, airdropTimer:0, _client:true,
      };
      this._gladBoxes = [];
      this._gladPickups = [];
const _zo3 = this._createGladZoneOverlay();
      this._gladZoneCanvas = _zo3.canvas;
      this._gladZoneTex = _zo3.tex;
      const zmat = new THREE.MeshBasicMaterial({map:this._gladZoneTex, transparent:true, opacity:0.9, depthWrite:false});
      const zgeo = new THREE.PlaneGeometry(this.world.size, this.world.size);
      zgeo.rotateX(-Math.PI/2);
      this._gladZoneMesh = new THREE.Mesh(zgeo, zmat);
      this._gladZoneMesh.position.y = 0.06;
      this._gladZoneMesh.renderOrder = 5;
      this.scene.add(this._gladZoneMesh);
      const gh = document.getElementById('glad-hud');
      if(gh) gh.classList.remove('hidden');
    }
    const g = this.glad;
    const prevEnded = g.ended;
    g.stage = gs.stage;
    g.safeHalf = gs.safeHalf;
    g.orangeHalf = gs.orangeHalf;
    g.phase = gs.phase;
    g.phaseTimer = gs.phaseTimer;
    g.alive = gs.alive;
    g.winnerId = gs.winner;
    g.ended = !!gs.ended;
    g.airdropTimer = gs.airdropTimer;
    if(gs.airdrop){
      if(!g.airdrop){
        g.airdrop = {x:0, z:0, countdown:0, landed:false, life:0, hold:0, localHold:0};
        const geo = new THREE.CylinderGeometry(3.2, 3.2, 260, 20, 1, true);
        geo.translate(0, 130, 0);
        const mat = new THREE.MeshBasicMaterial({color:0x00ddff, transparent:true, opacity:0.35, depthWrite:false});
        this._gladAirBeam = new THREE.Mesh(geo, mat);
        this._gladAirBeam.position.set(gs.airdrop.x, 0, gs.airdrop.z);
        this.scene.add(this._gladAirBeam);
        this._gladBuildAirdropVis(gs.airdrop.x, gs.airdrop.z);
      } else if(this._gladAirBeam && g.airdrop.landed !== gs.airdrop.landed){
        this._gladAirBeam.material.opacity = 0.4;
      }
      g.airdrop.x = gs.airdrop.x;
      g.airdrop.z = gs.airdrop.z;
      g.airdrop.countdown = gs.airdrop.countdown;
      const wasLanded = g.airdrop.landed;
      g.airdrop.landed = gs.airdrop.landed;
      g.airdrop.life = gs.airdrop.life;
      g.airdrop.hold = gs.airdrop.hold;
      if(this._gladAirBeam){
        this._gladAirBeam.position.set(gs.airdrop.x, 0, gs.airdrop.z);
        if(wasLanded && !gs.airdrop.landed) this._gladAirBeam.material.opacity = 0.3;
      }
    } else if(g.airdrop){
      g.airdrop = null;
      this._gladClearAirdropVisuals();
    }
    // Blue boxes: reconcile meshes with snapshot
    const want = new Set((gs.boxes || []).map(b => b.id));
    for(let i = this._gladBoxes.length - 1; i >= 0; i--){
      if(!want.has(this._gladBoxes[i].id)){
        const b = this._gladBoxes[i];
        if(b.mesh){ this.scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); }
        this._gladBoxes.splice(i, 1);
      }
    }
    (gs.boxes || []).forEach(sb => {
      let b = this._gladBoxes.find(x => x.id === sb.id);
      if(!b){
        b = this._gladSpawnBox(sb.x, sb.z, sb.id);
      }
      b.x = sb.x; b.z = sb.z; b.hp = sb.hp; b.alive = true;
    });
    // Pickups
    for(let i = this._gladPickups.length - 1; i >= 0; i--){
      const p = this._gladPickups[i];
      if(p.mesh){
        this.scene.remove(p.mesh);
        p.mesh.children.forEach(c => { c.geometry.dispose(); c.material.dispose(); });
      }
      this._gladPickups.splice(i, 1);
    }
    (gs.pickups || []).forEach(sp => this._gladDropPickup(sp.x, sp.z, sp.power));
    // Sync per-chunk zone states so clients render the same orange/red grid
    if(!this._gladZoneChunks) this._initGladChunkGrid();
    if(this._gladZoneChunks){
      const redSet = new Set(gs.redChunks || []);
      const orMap = new Map((gs.orangeChunks || []).map(o => [o.id, Math.max(0, o.secs || 0)]));
      const now = this.time || 0;
      let zoneChanged = false;
      for(const c of this._gladZoneChunks){
        let st = 'safe';
        if(redSet.has(c.id)) st = 'red';
        else if(orMap.has(c.id)) st = 'orange';
        if(st === 'orange') c.orangeUntil = now + orMap.get(c.id);
        else c.orangeUntil = 0;
        if(st !== c.state){ c.state = st; zoneChanged = true; }
      }
      this._refreshGladZone();
    }
    // End-of-match notification
    if(!prevEnded && g.ended){
      this._gladShowResult(false);
    }
  }

_gladZoneNotice(text){
    Menu.toast(text);
  }

  _gladShowResult(eliminated){
    const el = document.getElementById('glad-result');
    if(!el) return;
    const g = this.glad;
    if(!g) return;
    // The result overlay must always sit on top: close any ESC menu first
    const esc = document.getElementById('esc-menu');
    if(esc) esc.classList.add('hidden');
    if(window.Menu) Menu.escOpen = false;
    const txtEl = document.getElementById('glad-result-text');
    if(eliminated){
      if(g._elimShown) return;
      g._elimShown = true;
      if(txtEl) txtEl.textContent = 'ELIMINATED — you placed #' + (this.localTank ? (this.localTank.placement || '?') : '?');
      el.classList.remove('hidden');
      const watchBtn = document.getElementById('glad-watch-btn');
      if(watchBtn) watchBtn.classList.remove('hidden');
    } else {
      if(g._finalShown) return;
      g._finalShown = true;
      let winner = g.winner;
      if(!winner && g.winnerId) winner = this.tanks.find(t => t.id === g.winnerId) || null;
      let txt = 'MATCH OVER';
      if(winner === this.localTank){
        txt = 'VICTORY! Last tank standing!';
        if(window.Menu && Menu.bumpStat) Menu.bumpStat('wins', 1);
      }
      else if(winner) txt = 'WINNER: ' + winner.name;
      else if(g.winnerId) txt = 'MATCH OVER';
      if(txtEl) txtEl.textContent = txt;
      el.classList.remove('hidden');
      const watchBtn = document.getElementById('glad-watch-btn');
      if(watchBtn) watchBtn.classList.add('hidden');
    }
  }

  async startFreeRoam(){
    Menu.showConnecting('Joining free roam world…');
    try {
      const match = await NakamaNet.joinOrCreateWorld();
    } catch(e) {
      Menu.hideConnecting();
      Menu.toast(e.message||'Failed to join world');
      return;
    }
    Menu.hideConnecting();
    this.mode = 'freeroam';
    if(NakamaNet.isHost) Menu.toast('You are the world host');
    this._resetArena();
    NakamaNet.onPlayerJoin = (info) => this._onFreeRoamJoin(info);
    NakamaNet.onPlayerLeave = (peerId) => this._onFreeRoamLeave(peerId);
    NakamaNet.onInput = (peerId, inp) => { this.clientTankInputs[peerId] = inp; };
    NakamaNet.onWelcome = (msg) => {
      // Host sent us our spawn position
      if(msg.x !== undefined && msg.z !== undefined){
        this.localTank.x = msg.x;
        this.localTank.z = msg.z;
      }
    };
    NakamaNet.onState = (snap) => this._applyHostState(snap);
    NakamaNet.onHostChange = (newHostId) => {
      if(newHostId === NakamaNet.userId){
        NakamaNet.isHost = true;
        Menu.toast('You are now the world host');
      }
    };
    this._spawnLocal();
    if(!NakamaNet.isHost){
      // Tell host who we are so they can assign a spawn and broadcast us
      const def = TANKS[this.settings.selectedTank] || TANKS.coolbuddy;
      NakamaNet.sendMatchData({
        t: 'join',
        name: this.settings.playerName,
        tank: this.settings.selectedTank,
        color: def.color
      });
    }
    this._begin();
  }

  _onFreeRoamJoin(info){
    // info = {peerId, name, tank, color}
    const def = TANKS[info.tank] || TANKS.coolbuddy;
    const sp = this.world.randomSpawn();
    const t = new Tank(def, {
      id: 'remote-'+info.peerId,
      name: info.name || 'Player',
      ownerPeer: info.peerId,
      x: sp.x,
      z: sp.z,
      heading: Math.random()*6,
      color: info.color || def.color
    });
    this._finalizeTank(t);
    this.tanks.push(t);
    this.clientTanks[info.peerId] = t;
    // Send spawn position back to joining client
    NakamaNet.sendMatchData({
      t: 'spawn',
      id: t.id,
      x: t.x,
      z: t.z,
      heading: t.heading,
      tankId: info.tank || 'coolbuddy',
      name: info.name || 'Player'
    });
    // Send full state so new client sees all existing tanks
    NakamaNet.sendMatchData({
      t: 'state',
      s: { time: this.time, tanks: this.tanks.map(tk => tk.snapshot()), projs: this.projectiles.filter(p=>!p.dead).map(p=>({id:p.id,x:p.x,y:p.y,z:p.z,dx:p.dir.x,dz:p.dir.z,type:p.type,life:p.life})) }
    });
  }

  _onFreeRoamLeave(peerId){
    this._onClientLeave(peerId);
    delete this.clientTankInputs[peerId];
  }

  /* ---------- HOST (P2P) ---------- */
  async startHost(cfg){
    Menu.showConnecting('Creating room…');
    try{
      await Net.hostRoom({maxPlayers:cfg.maxPlayers, isPublic:cfg.isPublic, fakePlayers:cfg.fakePlayers, code:cfg.code});
    }catch(e){
      Menu.hideConnecting();
      Menu.toast(e.message||'Failed to host');
      return;
    }
    Menu.hideConnecting();
    Menu.toast('Room live • Code: '+cfg.code);
    this.mode='host'; this._resetArena();
    try {
      var m = this._useCustomMap ? loadCustomMap() : null;
      if(!m && cfg.gamemode === 'gladiator' && typeof GLADIATOR_MAP !== 'undefined' && GLADIATOR_MAP) m = GLADIATOR_MAP;
      if(!m) m = loadMainMap();
      if(!m && typeof DEFAULT_MAP !== 'undefined' && DEFAULT_MAP) m = DEFAULT_MAP;
      if(m) this.world.loadCustomMapData(m);
    } catch(e){ console.warn('Map load error:', e); }
    if(cfg.gamemode === 'gladiator'){
      const spawns = this._gladSpawnList();
      this._initGladiator();
      const localSp = spawns.length ? spawns.shift() : this.world.randomSpawn();
      this._spawnLocal(localSp.x, localSp.z, localSp.ry);
      for(let i=0;i<cfg.fakePlayers;i++){
        const sp = spawns.length ? spawns.shift() : this.world.randomSpawn();
        this._spawnBot(sp.x, sp.z, sp.ry);
      }
    } else {
      this._spawnLocal();
      // fake players (bots)
      for(let i=0;i<cfg.fakePlayers;i++) this._spawnBot();
    }
    
    // Network callbacks
    Net.onPlayerJoin = (info)=> this._onClientJoin(info);
    Net.onPlayerLeave = (peerId)=> this._onClientLeave(peerId);
    Net.onInput = (peerId, inp)=> { this.clientTankInputs[peerId] = inp; };
    
    this._begin();
  }

  _onClientJoin(info){
    // info = {peerId, name, tank, color}
    const def = TANKS[info.tank] || TANKS.coolbuddy;
    const sp = this.glad ? this._gladSpawnForNew() : this.world.randomSpawn();
    const t = new Tank(def, {
      id:'remote-'+info.peerId,
      name: info.name || 'Player',
      ownerPeer: info.peerId,
      x: sp.x,
      z: sp.z,
      heading: sp.ry != null ? sp.ry : Math.random()*6,
      color: info.color || def.color
    });
    this._finalizeTank(t);
    this.tanks.push(t);
    this.clientTanks[info.peerId] = t;
    
    // Send spawn data to this client so they know where they are
    Net.sendSpawnToClient(info.peerId, {
      id: t.id,
      x: t.x,
      z: t.z,
      heading: t.heading,
      tankId: info.tank || 'coolbuddy',
      name: info.name || 'Player'
    });
    
    // Send full current state to the newly joined client so they see everyone
    Net.sendFullStateToClient(info.peerId, {
      time: this.time,
      glad: this.glad ? this._gladSnapshot() : null,
      tanks: this.tanks.map(tk => tk.snapshot()),
      projs: this.projectiles.filter(p=>!p.dead).map(p=>({id:p.id,x:p.x,y:p.y,z:p.z,dx:p.dir.x,dz:p.dir.z,type:p.type,life:p.life}))
    });
  }
  
  _onClientLeave(peerId){
    const t = this.clientTanks[peerId];
    if(t){ t.detach(); this.tanks = this.tanks.filter(x=>x!==t); delete this.clientTanks[peerId]; }
    delete this.clientTankInputs[peerId];
  }

  /* ---------- CLIENT ---------- */
  async startClient(code){
    Menu.showConnecting('Joining room…');
    try{
      await Net.joinRoom(code);
    }catch(e){
      Menu.hideConnecting();
      Menu.toast(e.message||'Could not join room');
      return;
    }
    Menu.hideConnecting();
    this.mode='client'; this._resetArena();
    
    // Set up network callbacks for client
    Net.onWelcome = (msg)=> this._onClientWelcome(msg);
    Net.onState = (snap)=> this._applyHostState(snap);
    Net.onPlayerLeave = (peerId)=>{
      if(peerId==='host'){
        Menu.toast('Host disconnected');
        this.leaveToMenu();
      }
    };
    
    // Send our join info immediately
    const def = TANKS[this.settings.selectedTank] || TANKS.coolbuddy;
    Net.sendJoinInfo(this.settings.playerName, this.settings.selectedTank, def.color);
    
    // Spawn local tank (position will be corrected by host's spawn message)
    this._spawnLocal();
    this._begin();
  }

  /* ---------- SPECTATOR (platoon spectator slots) ---------- */
  async startSpectator(cfg){
    Menu.showConnecting('Joining as spectator…');
    try{
      await Net.joinRoom(cfg.code);
    }catch(e){
      Menu.hideConnecting();
      Menu.toast(e.message||'Could not join room');
      return;
    }
    Menu.hideConnecting();
    this.isSpectator = true;
    this.mode='client'; this._resetArena();

    // Watch-only: never send join info and never spawn a local tank.
    Net.onState = (snap)=> this._applyHostState(snap);
    Net.onPlayerLeave = (peerId)=>{
      if(peerId==='host'){
        Menu.toast('Host disconnected');
        this.leaveToMenu();
      }
    };

    this.spectate = {
      mode: 'player',      // 'player' = follow a tank, 'free' = freecam
      targetId: null,
      yaw: Math.PI,
      pitch: -0.5,
      spd: 28,
    };

    this._begin();
    // Pure spectator — no tank HUD or touch joysticks
    const hud = document.getElementById('hud');
    if(hud) hud.classList.add('hidden');
    if(this.input && this.input.setJoysticksVisible) this.input.setJoysticksVisible(false);
    this._initSpectatorHud();
    Menu.toast('Spectating — pick a tank or use freecam at the bottom');
  }

  _onClientWelcome(msg){
    // Host tells us we connected, optionally with spawn data
    if(msg.id && msg.id.indexOf('remote-') === 0){
      this._myRemoteId = msg.id;
    }
    if(msg.x !== undefined && this.localTank){
      this.localTank.x = msg.x;
      this.localTank.z = msg.z;
      if(msg.heading !== undefined) this.localTank.heading = msg.heading;
      this.localTank._syncTransform();
    }
  }

  _applyHostState(snap){
    if(!snap || !snap.tanks) return;
    if(snap.time) this.time = snap.time;
    if(snap.glad) this._gladApplyHostSnapshot(snap.glad);
    
    // Apply host state to local tank via remote representation
    if(snap.tanks && this.localTank && this._myRemoteId){
      const mySnap = snap.tanks.find(s => s.id === this._myRemoteId);
      if(mySnap){
        const wasAlive = this.localTank.alive;
        this.localTank.x += (mySnap.x - this.localTank.x) * 0.15;
        this.localTank.z += (mySnap.z - this.localTank.z) * 0.15;
        this.localTank.hp = mySnap.hp;
        this.localTank.alive = mySnap.alive;
        this.localTank.damageDealt = mySnap.dd;
        this.localTank.kills = mySnap.k;
        this.localTank.dying = !!mySnap.dying;
        this.localTank.placement = mySnap.pl || 0;
        this.localTank.power = mySnap.pw || 0;
        this.localTank._gladHoldTime = mySnap.gt || 0;
        if(this.localTank.setPowerFromSnapshot) this.localTank.setPowerFromSnapshot(mySnap.pw || 0);
        if(wasAlive && !mySnap.alive && !this.localTank.dying){
          this.localTank._startDeath(this, null);
        }
        this.localTank._syncTransform();
        this.localTank._drawHp();
      }
    }
    
    const seen = new Set([this.localTank ? this.localTank.id : '', this._myRemoteId].filter(Boolean));
    
    (snap.tanks||[]).forEach(s=>{
      if(seen.has(s.id)) return;
      let t = this.tanks.find(x=>x.id===s.id);
      if(!t){
        if(s.id === this._myRemoteId) return;
        const def = TANKS[s.tank]||TANKS.coolbuddy;
        t = new Tank(def, {id:s.id, name:s.name, x:s.x, z:s.z, heading:s.h, color:s.col});
        this._finalizeTank(t);
        this.tanks.push(t);
        t.beginNetDriven();
      }
      const wasAlive = t.alive;
      t.applyNetSnapshot(s);
      if(wasAlive && !t.alive && !t.dying){
        t._startDeath(this, null);
      }
      seen.add(s.id);
    });
    
    // Remove unseen tanks (that aren't local)
    this.tanks = this.tanks.filter(t=>{
      if(t.isLocal) return true;
      if(!seen.has(t.id)){ t.detach(); return false; }
      return true;
    });
    
    // Handle projectiles from host
    if(snap.projs){
      const hostProjIds = new Set();
      snap.projs.forEach(sp => {
        hostProjIds.add(sp.id);
        let existing = this.projectiles.find(p => p.id === sp.id);
        if(!existing){
          const pos = new THREE.Vector3(sp.x, sp.y, sp.z);
          const dir = new THREE.Vector3(sp.dx, 0, sp.dz);
          const dummyDef = {shellSpeed:90, damage:34, shellRange:40, fireConeHalfAngle:0.12};
          if(sp.type === 'flame'){
            existing = new FlameCone(null, pos, dir, dummyDef);
          } else {
            existing = new Shell(null, pos, dir, dummyDef, null);
          }
          existing._networked = true;
          existing.attach(this.scene);
          this.projectiles.push(existing);
        }
        existing.x = sp.x;
        existing.y = sp.y;
        existing.z = sp.z;
        existing.life = sp.life;
        existing.dead = false;
        if(existing.dir){
          existing.dir.x = sp.dx;
          existing.dir.z = sp.dz;
        }
        if(existing.mesh){
          existing.mesh.position.set(sp.x, sp.y, sp.z);
          existing.mesh.lookAt(sp.x + sp.dx, sp.y, sp.z + sp.dz);
        }
        if(existing.group){
          existing.group.position.set(sp.x, sp.y, sp.z);
        }
      });
      for(let i = this.projectiles.length - 1; i >= 0; i--){
        const p = this.projectiles[i];
        if(!hostProjIds.has(p.id)){
          p.dead = true;
          p.detach();
          this.projectiles.splice(i, 1);
        }
      }
    }
  }

  /* ---------- arena reset / spawn ---------- */
  _resetArena(){
    this._clearGladState();
    this.tanks.forEach(t=>t.detach());
    this.projectiles.forEach(p=>p.detach());
    this.explosions.forEach(e=>e.detach());
    this.casings.forEach(c=>c.detach());
    if(this._strikeBombs){ this._strikeBombs.forEach(b=>{ this.scene.remove(b.mesh); if(b.mesh.geometry) b.mesh.geometry.dispose(); if(b.mesh.material) b.mesh.material.dispose(); }); this._strikeBombs = []; }
    if(this._oilPuddles){ this._oilPuddles.forEach(p=>{ this.scene.remove(p.mesh); if(p.mesh.material) p.mesh.material.dispose(); p.mesh.geometry.dispose(); }); this._oilPuddles = []; }
    if(this._panzerRing){ this._panzerRing.forEach(p=>this.scene.remove(p.mesh)); this._panzerRing = null; }
    this.tanks.forEach(t => { if(t._strikeRing) this.scene.remove(t._strikeRing); });
    this.tanks.forEach(t => { if(t.myBushes){ t.myBushes.forEach(b => this.world.removePlayerBush(b)); t.myBushes = []; } });
    this.tanks=[]; this.projectiles=[]; this.explosions=[];
    this.localTank=null; this.time=0;
    // A fresh match must never inherit spectator state from a previous one
    // (e.g. "Keep watching" left spectate=true/the bar visible, so the next
    // start looked frozen and PLAY/Play again seemed dead).
    this.spectate = false;
    this.spectateTarget = null;
    this.isSpectator = false;
    try {
      this._stopSpectate();
      const _shud = document.getElementById('spectator-hud');
      if(_shud) _shud.classList.add('hidden');
      const _sbar = document.getElementById('spectate-bar');
      if(_sbar) _sbar.classList.add('hidden');
    } catch(e){}
    if(this._helixVideos){
      for(const [, hv] of this._helixVideos){
        hv.el.pause(); hv.el.currentTime = 0;
        if(hv.parent) hv.parent.remove(hv.mesh);
        hv.mesh.geometry.dispose();
        hv.mesh.material.dispose();
        hv.tex.dispose();
      }
      this._helixVideos.clear();
    }
    this._resetPhysics();
  }

  _resetPhysics(){
    this._physBodies.forEach(b=>{ try{ this.physicsWorld.removeRigidBody(b); }catch(e){} });
    this._physBodies = [];
    this._eventQueue = null;
    this.trailManager = new BulletTrailManager(this.scene, {
      maxTrails: 48, fadeTime: 0.18, width: 0.12, color: 0xffffff,
    });
    this._initPhysics();
  }

  /* ---------- Spectator mode (WoT-style bottom tank bar) ---------- */
  _spectateTanks(){
    return this.tanks.filter(t => t && !t.isDummy && !t.isLocal);
  }

  _startSpectate(){
    if(this.spectate) return;
    this.spectate = true;
    this.spectateTarget = null;
    if(this.input && this.input.setJoysticksVisible) this.input.setJoysticksVisible(false);
    const bar = document.getElementById('spectate-bar');
    if(bar) bar.classList.remove('hidden');
    this._renderSpectateBar();
    this._spectateNext(1);
    Menu.toast('Spectating — pick a tank below');
  }

  _stopSpectate(){
    this.spectate = false;
    this.spectateTarget = null;
    const bar = document.getElementById('spectate-bar');
    if(bar) bar.classList.add('hidden');
  }

  _renderSpectateBar(){
    const bar = document.getElementById('spectate-bar');
    if(!bar) return;
    let row = document.getElementById('spectate-chips');
    if(!row){
      row = document.createElement('div');
      row.id = 'spectate-chips';
      row.className = 'spectate-chips';
      bar.appendChild(row);
    }
    row.innerHTML = '';
    const tanks = this._spectateTanks();
    for(const t of tanks){
      const chip = document.createElement('button');
      chip.type = 'button';
      const active = t === this.spectateTarget;
      const dead = !t.alive || t.dying;
      chip.className = 'spec-chip' + (active ? ' spec-active' : '') + (dead ? ' spec-dead' : '');
      const name = document.createElement('span');
      name.className = 'spec-chip-name';
      name.textContent = t.name || 'Player';
      const hp = document.createElement('span');
      hp.className = 'spec-chip-hp';
      const pct = t.maxHp ? Math.max(0, t.hp / t.maxHp) : 0;
      hp.textContent = dead ? '✕' : (Math.ceil(t.hp) + ' HP');
      hp.style.color = pct > 0.5 ? '#7ee787' : (pct > 0.25 ? '#fbbf24' : '#f87171');
      chip.appendChild(name);
      chip.appendChild(hp);
      if(dead) chip.disabled = true;
      chip.addEventListener('click', () => this._watchTank(t));
      row.appendChild(chip);
    }
  }

  _watchTank(t){
    if(!t || !t.alive || t.dying || !this.spectate) return;
    this.spectateTarget = t;
    this._spectateIndex = Math.max(0, this._spectateTanks().indexOf(t));
    this._renderSpectateBar();
  }

  _spectateNext(dir){
    const tanks = this._spectateTanks();
    if(!tanks.length){ this.spectateTarget = null; this._renderSpectateBar(); return; }
    let i = tanks.indexOf(this.spectateTarget);
    if(i < 0) i = -1;
    for(let step = 0; step < tanks.length + 1; step++){
      i = (i + (dir || 1) + tanks.length) % tanks.length;
      const t = tanks[i];
      if(t.alive && !t.dying){ this.spectateTarget = t; break; }
    }
    // If every other tank is dead, keep whatever target we already had
    if((!this.spectateTarget || !this.spectateTarget.alive || this.spectateTarget.dying) && tanks.length){
      const alive = tanks.find(t => t.alive && !t.dying);
      this.spectateTarget = alive || null;
    }
    this._renderSpectateBar();
  }

  _spectatePrev(){ this._spectateNext(-1); }

  _spawnLocal(px, pz, pheading){
    this.camAngle = Math.PI + (this.settings.camRotation || 0);
    const def = TANKS[this.settings.selectedTank] || TANKS.coolbuddy;
    const sp = (px != null && pz != null) ? {x:px, z:pz} : this.world.randomSpawn();
    const localId = this.mode === 'host' ? 'host-player' : 'local';
    const t = new Tank(def, {id:localId, name:this.settings.playerName, isLocal:true, x:sp.x, z:sp.z, heading:(pheading != null ? pheading : Math.random()*6), physicsWorld:this.physicsWorld});
    this._finalizeTank(t); this.tanks.push(t); this.localTank = t;
    // Ensure trees are placed even if NatureAssets promise hasn't resolved yet
    if(this.world && !this.world.treesPlaced) this.world.tryPlaceTrees();
    // Place OBJ trees near spawn if already loaded
    if(window.NatureAssets && NatureAssets.loaded && NatureAssets.trees.length>0){
      for(let i=0;i<4;i++){
        const src = NatureAssets.trees[Math.floor(Math.random()*NatureAssets.trees.length)];
        const tree = src.clone(true);
        const a = Math.random()*Math.PI*2, d = 5+Math.random()*15;
        tree.position.set(sp.x+Math.cos(a)*d, 0, sp.z+Math.sin(a)*d);
        tree.scale.setScalar(1+Math.random()*0.5);
        this.world.scene.add(tree);
        this.world.trees.push({x:tree.position.x,z:tree.position.z,mesh:tree});
      }
    }
  }

  _spawnBot(px, pz, pheading){
    const ids = TANK_ORDER.filter(id=>id!==this.settings.selectedTank && id!=='tankdisplay' && id!=='dummy');
    if(!ids.length) return;
    const id = ids[Math.floor(Math.random()*ids.length)];
    const def = TANKS[id];
    if(!def) return;
    const sp = (px != null && pz != null) ? {x:px, z:pz} : this.world.randomSpawn();
    const t = new Tank(def, {id:'bot-'+Math.random().toString(36).slice(2,6), name:BOTNAMES[Math.floor(Math.random()*BOTNAMES.length)], isBot:true, x:sp.x, z:sp.z, heading:(pheading != null ? pheading : Math.random()*6), physicsWorld:this.physicsWorld});
    t.brain = new BotBrain(t);
    this._finalizeTank(t); this.tanks.push(t);
  }

  _spawnDummy(){
    const def = TANKS.dummy;
    // Spawn 10 units in front of the local player
    const dx = Math.sin(this.localTank.heading) * 10;
    const dz = Math.cos(this.localTank.heading) * 10;
    const x = this.localTank.x + dx;
    const z = this.localTank.z + dz;
    const t = new Tank(def, {id:'dummy', name:'Dummy', x, z, heading:Math.random()*6, physicsWorld:this.physicsWorld});
    t.isDummy = true;
    t.dummySpawnX = x;
    t.dummySpawnZ = z;
    this._finalizeTank(t); this.tanks.push(t);

    // Spawn a display tank next to the dummy
    const displayDef = TANKS.tankdisplay;
    if(displayDef){
      const side = new THREE.Vector3(Math.cos(this.localTank.heading), 0, -Math.sin(this.localTank.heading)).multiplyScalar(5);
      const td = new Tank(displayDef, {id:'displaytank', name:'Display', x: x + side.x, z: z + side.z, heading:0, physicsWorld:this.physicsWorld});
      this._finalizeTank(td); this.tanks.push(td);
    }
  }

  _finalizeTank(t){
    t.attach(this.scene);
    t.makeViewRangeCircle();
    if(!t.isLocal) t.viewCircle.visible = false;
    t.setViewRangeStyle(this.settings.viewRangeOpacity, this.settings.viewRangeColor);
    if(t.isLocal && t.hasSuper()){
      t._onBushSuper = () => this._deployBush(t);
    }
    return t;
  }

  _begin(){
    Menu.showHUD();
    document.getElementById('ui-layer').classList.add('game-active');
    this.running = true;
    this._last = performance.now();
    // Match start countdown (5s before play)
    this._matchStartDelay = 5;
    this._matchCdShown = false;
    // Show touch joysticks when game starts (only on mobile)
    if(this.input && this.input.setJoysticksVisible){
      this.input.setJoysticksVisible(true);
    }
    // Spectate bar controls (wired once)
    const specPrev = document.getElementById('spec-prev');
    const specNext = document.getElementById('spec-next');
    const specExit = document.getElementById('spec-exit');
    if(specPrev && !specPrev._wired){ specPrev._wired = true; specPrev.addEventListener('click', ()=> this._spectatePrev()); }
    if(specNext && !specNext._wired){ specNext._wired = true; specNext.addEventListener('click', ()=> this._spectateNext(1)); }
    if(specExit && !specExit._wired){ specExit._wired = true; specExit.addEventListener('click', ()=> this.leaveToMenu()); }
    // Lock to landscape on mobile
    if(screen.orientation && screen.orientation.lock){
      screen.orientation.lock('landscape').catch(() => {});
    }
  }

  leaveToMenu(){
    // Hide touch joysticks FIRST — nothing below may run (throws, early
    // returns, async) while leaving the joysticks visible over the menus.
    if(this.input && this.input.setJoysticksVisible){
      this.input.setJoysticksVisible(false);
    }
    if(Menu && Menu.hideTouchControls) Menu.hideTouchControls();
    this.running = false;
    this.mode = null;
// Hide joysticks FIRST: if anything below throws, we must never leave
    // the touch controls stuck on the main menu (mobile bug).
    try {
      if(this.input && this.input.setJoysticksVisible) this.input.setJoysticksVisible(false);
    } catch(e){ console.warn('joystick hide:', e); }
    this._stopSpectate();
    this.isSpectator = false;
    this.spectate = null;
    const specHud = document.getElementById('spectator-hud');
    if(specHud) specHud.classList.add('hidden');
    try { Net.disconnect(); } catch(e){}
    try { NakamaNet.leaveMatch(); } catch(e){}
    try { this._resetArena(); } catch(e){ console.warn('reset arena:', e); }
    // Hide all overlays
    document.getElementById('esc-menu').classList.add('hidden');
    document.getElementById('bigmap').classList.add('hidden');
    var _mc = document.getElementById('match-cd');
    if(_mc) _mc.classList.add('hidden');
    this._matchStartDelay = 0; this._matchCdShown = false;
    if (this._perfOverlay) this._perfOverlay.style.display = 'none';
    if(Menu.escOpen) Menu.escOpen = false;
    Menu.show(window.__PLATOON_BATTLE ? 'menu-platoon' : 'menu-main');
    // Clean up orientation poll timer if any
    Menu._stopOrientationPoll();
    // Remove in-game portrait warning
    const pw = document.getElementById('portrait-warning');
    if(pw) pw.classList.add('hidden');
    // Unlock orientation
    if(screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
  }

  /* ---------- spectator camera + HUD ---------- */
  _spectateAliveTanks(){
    return this.tanks.filter(t => t && !t.isDummy && t.alive && !t.dying);
  }

  _pickSpectateTarget(jump){
    const alive = this._spectateAliveTanks();
    if(!alive.length){ this.spectate.targetId = null; return false; }
    this.spectate.targetId = alive[0].id;
    if(jump) this._jumpSpectateCamera(alive[0]);
    return true;
  }

  _spectateCycleTarget(){
    if(!this.spectate) return;
    const alive = this._spectateAliveTanks();
    if(!alive.length){
      this.spectate.targetId = null;
      this._refreshSpectateHud();
      return;
    }
    const cur = alive.findIndex(t => t.id === this.spectate.targetId);
    const next = alive[(cur + 1) % alive.length];
    this.spectate.targetId = next.id;
    this._jumpSpectateCamera(next);
    this._refreshSpectateHud();
  }

  _jumpSpectateCamera(t){
    if(!t) return;
    this.camera.position.set(t.x, (t.def.body.h || 1) + 10, t.z);
    if(this.spectate) this.camAngle = this.spectate.yaw;
  }

  _initSpectatorHud(){
    const bar = document.getElementById('spectator-hud');
    if(!bar) return;
    bar.classList.remove('hidden');
    if(this._specHudBound) return;
    this._specHudBound = true;
    const self = this;
    const playerBtn = document.getElementById('spec-player-btn');
    const freeBtn = document.getElementById('spec-free-btn');
    if(playerBtn){
      playerBtn.addEventListener('click', ()=>{
        if(!self.spectate) return;
        if(self.spectate.mode !== 'player'){
          self.spectate.mode = 'player';
          if(!self._pickSpectateTarget(true)) self._spectateCycleTarget();
          self._refreshSpectateHud();
          return;
        }
        self._spectateCycleTarget();
      });
    }
    if(freeBtn){
      freeBtn.addEventListener('click', ()=>{
        if(!self.spectate) return;
        self.spectate.mode = 'free';
        self._refreshSpectateHud();
      });
    }
    this._refreshSpectateHud();
  }

  _refreshSpectateHud(){
    const bar = document.getElementById('spectator-hud');
    if(!bar || !this.spectate) return;
    const playerBtn = document.getElementById('spec-player-btn');
    const freeBtn = document.getElementById('spec-free-btn');
    const nameEl = document.getElementById('spec-target-name');
    if(playerBtn) playerBtn.classList.toggle('spec-on', this.spectate.mode === 'player');
    if(freeBtn) freeBtn.classList.toggle('spec-on', this.spectate.mode === 'free');
    if(nameEl){
      const t = this.spectate.mode === 'player' ? this.tanks.find(x => x.id === this.spectate.targetId) : null;
      nameEl.textContent = (t && t.alive) ? (t.name || 'Player') : 'NO TARGET';
    }
  }

  _updateSpectatorCamera(dt){
    const sp = this.spectate;
    if(!sp) return;
    const inv = (this.settings && this.settings.invertCamRot) ? -1 : 1;
    const zoom = this.input.consumeZoom();

    if(sp.mode === 'player'){
      // Orbit only — same rotate/zoom controls as the normal follow cam
      if(zoom !== 0){
        this.camDist = Math.max(CONFIG.CAM_DIST_MIN, Math.min(CONFIG.CAM_DIST_MAX,
          this.camDist - zoom*CONFIG.CAM_ZOOM_STEP));
      }
      const camRot = this.input.consumeCamRotate();
      if(camRot !== 0){
        this.camAngle -= camRot * inv * CONFIG.CAM_ROTATE_SPEED * dt;
      } else {
        const swipe = this.input.consumeCamSwipe();
        if(swipe !== 0) this.camAngle += swipe * CONFIG.CAM_SWIPE_SENSITIVITY;
      }
      sp.yaw = this.camAngle;

      let t = this.tanks.find(x => x.id === sp.targetId);
      if(!t || !t.alive || t.dying){
        const alive = this._spectateAliveTanks();
        t = alive.length ? alive[0] : null;
        if(t) sp.targetId = t.id;
      }
      if(!t) return;

      const angle = this.camAngle;
      const camTarget = new THREE.Vector3(
        t.x + Math.sin(angle)*this.camDist,
        this._getCameraHeight(this.camDist),
        t.z + Math.cos(angle)*this.camDist);
      const camLim = (this.world && this.world.half || 75) - 8;
      camTarget.x = Math.max(-camLim, Math.min(camLim, camTarget.x));
      camTarget.z = Math.max(-camLim, Math.min(camLim, camTarget.z));
      this.camera.position.lerp(camTarget, CONFIG.CAM_LERP);
      this.camera.lookAt(t.x, 1.2, t.z);
      this._refreshSpectateHud();
      return;
    }

    // ---- freecam: WASD move, SHIFT down, SPACE up, drag to rotate ----
    if(zoom !== 0) sp.spd = Math.max(6, Math.min(120, sp.spd + zoom*5));
    const camRot = this.input.consumeCamRotate();
    if(camRot !== 0) sp.yaw -= camRot * inv * CONFIG.CAM_ROTATE_SPEED * dt;
    const swipe = this.input.consumeCamSwipe();
    if(swipe !== 0) sp.yaw += swipe * CONFIG.CAM_SWIPE_SENSITIVITY;
    const swY = this.input.consumeCamSwipePitch();
    if(swY !== 0) sp.pitch = Math.max(-1.5, Math.min(1.5, sp.pitch - swY * CONFIG.CAM_SWIPE_SENSITIVITY));

    const k = this.input.keys || {};
    const fwd = { x: Math.sin(sp.yaw), z: Math.cos(sp.yaw) };
    const right = { x: Math.cos(sp.yaw), z: -Math.sin(sp.yaw) };
    let mvx = 0, mvz = 0;
    if(k['KeyW']){ mvx += fwd.x; mvz += fwd.z; }
    if(k['KeyS']){ mvx -= fwd.x; mvz -= fwd.z; }
    if(k['KeyD']){ mvx += right.x; mvz += right.z; }
    if(k['KeyA']){ mvx -= right.x; mvz -= right.z; }
    const nl = Math.hypot(mvx, mvz);
    if(nl > 0){
      const s = sp.spd * dt / nl;
      this.camera.position.x += mvx * s;
      this.camera.position.z += mvz * s;
    }
    let vy = 0;
    if(k['ShiftLeft'] || k['ShiftRight']) vy -= 1;
    if(k['Space']) vy += 1;
    if(vy) this.camera.position.y += vy * sp.spd * dt;

    const lim = (this.world && this.world.half || 75) - 2;
    this.camera.position.x = Math.max(-lim, Math.min(lim, this.camera.position.x));
    this.camera.position.z = Math.max(-lim, Math.min(lim, this.camera.position.z));
    this.camera.position.y = Math.max(0.8, Math.min(120, this.camera.position.y));

    const look = new THREE.Vector3(fwd.x, Math.sin(sp.pitch), fwd.z).normalize();
    this.camera.lookAt(
      this.camera.position.x + look.x,
      this.camera.position.y + look.y,
      this.camera.position.z + look.z);
    this._refreshSpectateHud();
  }

  /* ===========================================================
     GAME LOOP
     =========================================================== */
  _loop(now){
    requestAnimationFrame(this._loop);
    const rawDt = Math.max(0, (now - this._last)/1000) || 0;
    const dt = Math.min(0.05, rawDt);
    this._last = now;
    this._perfFrameStart = performance.now();

    // Push FPS sample (keep last 60)
    this._perfFpsHistory.push(now);
    if (this._perfFpsHistory.length > 60) this._perfFpsHistory.shift();

    if(this.running){
      // Match start countdown: freeze input for 5s
      if(this._matchStartDelay > 0){
        this._matchStartDelay -= rawDt;
        if(this._matchStartDelay <= 0){
          this._matchStartDelay = 0;
          var mc = document.getElementById('match-cd');
          if(mc) mc.classList.add('hidden');
        } else {
          var mc = document.getElementById('match-cd');
          if(mc && !this._matchCdShown){
            mc.classList.remove('hidden');
            this._matchCdShown = true;
          }
          var num = document.querySelector('.match-cd-num');
          var label = document.querySelector('.match-cd-label');
          var go = document.querySelector('.match-cd-go');
          if(num){
            if(this._matchStartDelay > 0.5){
              num.textContent = Math.ceil(this._matchStartDelay);
              if(label) label.style.display = '';
              if(go) go.style.display = 'none';
            } else {
              num.style.display = 'none';
              if(label) label.style.display = 'none';
              if(go) go.style.display = 'block';
            }
          }
        }
      }
      this.dt = dt; this.time += dt;
      // Play-time stats: +1s while a match runs
      this._playAcc = (this._playAcc || 0) + dt;
      if(this._playAcc >= 1){
        this._playAcc -= 1;
        if(window.Menu && Menu.settings){
          const st = Menu.settings.stats || (Menu.settings.stats = {});
          st.playSec = (st.playSec || 0) + 1;
          this._playSaveAcc = (this._playSaveAcc || 0) + 1;
          if(this._playSaveAcc >= 60){ this._playSaveAcc = 0; try{ saveSettings(Menu.settings); }catch(e){} }
        }
      }
      try {
        if(this.physicsWorld){
          this.physicsWorld.timestep = Math.min(dt, 0.033);
          this.physicsWorld.step(this._eventQueue);
          if(this._eventQueue) this._eventQueue.drainCollisionEvents((h1, h2, started) => {
            if(!started) return;
            this._onCollision(h1, h2);
          });
        }
      } catch(e){ console.warn('Physics step:', e); }
      if(this._matchStartDelay <= 0){
        this._update(dt);
      } else {
        // During countdown: still step physics but skip input/bot updates
        if(this.physicsWorld){
          this.physicsWorld.timestep = Math.min(dt, 0.033);
          this.physicsWorld.step(this._eventQueue);
          if(this._eventQueue) this._eventQueue.drainCollisionEvents((h1, h2, started) => {
            if(!started) return;
            this._onCollision(h1, h2);
          });
        }
        // Cinematic intro camera: sweep from the tank's left side, rise and
        // rotate around behind it to exactly the follow-cam position, so the
        // handoff to the normal camera when the countdown ends is seamless.
        if(this.localTank) this._updateCinematicCamera();
      }
    }
    this._perfUpdateEnd = performance.now();

    // Adaptive resolution: if frames are heavy, scale render resolution down
    // (and back up when the GPU keeps up) so the game stays smooth on weak GPUs
    if(now - this._adapT > 2000){
      this._adapT = now;
      const hist = this._perfFpsHistory;
      if(hist.length > 30){
        let s = 0;
        for(let i = hist.length - 30; i < hist.length; i++) s += (1000 / (hist[i] - hist[i-1]));
        const fps30 = s / 29;
        const cur = this.renderer.getPixelRatio();
        if(fps30 < 35 && cur > 0.8){
          this.renderer.setPixelRatio(Math.max(0.8, cur - 0.25));
        } else if(fps30 > 50 && cur < this._maxPixelRatio){
          this.renderer.setPixelRatio(Math.min(this._maxPixelRatio, cur + 0.2));
        }
      }
    }

    // GPU load estimate: sample the delta between rAF start and render completion
    this._perfGpuLoadSamples.push(Math.round((performance.now() - this._perfFrameStart) / 1.66));

    this._updatePerfOverlay(now);
    this.renderer.render(this.scene, this.camera);
  }

  // Calculate camera height based on distance with dynamic angle (40° at min zoom → 85° at max zoom)
  _getCameraHeight(camDist) {
    const t = (camDist - CONFIG.CAM_DIST_MIN) / (CONFIG.CAM_DIST_MAX - CONFIG.CAM_DIST_MIN);
    const angle = this._camAngleMin + t * (this._camAngleMax - this._camAngleMin);
    return 1.2 + camDist * Math.tan(angle);
  }

  /* Cinematic intro camera (runs during the match-start countdown).
     Progress 0→1 maps to the countdown duration (5s). The camera starts
     at the tank's left side, low and close, then rises while rotating
     around to the standard follow position, ending exactly there. */
  _updateCinematicCamera(){
    if(!this.localTank || !this.localTank.alive || this.localTank.dying) return;
    const t = this.localTank;
    const dur = this._matchStartDelay; // 5 → 0
    const p = Math.min(1, Math.max(0, (5 - dur) / 5));
    // Smooth easing so launch and handoff feel natural
    const e = p * p * (3 - 2 * p);
    if(this.cameraMode === 'hull') this.camAngle = t.heading + Math.PI;
    // Orbit from the left side (heading + PI/2) around to the back (camAngle)
    const endA = this.camAngle;
    const startA = endA - Math.PI / 2;
    const ang = startA + (endA - startA) * e;
    const dist = this.camDist * (0.7 + 0.3 * e);
    const finalH = this._getCameraHeight(this.camDist);
    const h = 3 + (finalH - 3) * e;
    const camLim = (this.world && this.world.half || 75) - 8;
    const cx = Math.max(-camLim, Math.min(camLim, t.x + Math.sin(ang) * dist));
    const cz = Math.max(-camLim, Math.min(camLim, t.z + Math.cos(ang) * dist));
    this.camera.position.set(cx, h, cz);
    this.camera.lookAt(t.x, 1.2, t.z);
  }

  _update(dt){
    try {
    this.world.update(dt, this.time, this.localTank);
    if(this.glad && !this.glad._client) this._gladUpdate(dt);
    if(this.glad && this.glad.airdrop) this._gladUpdateAirdropVis(dt);

    // Camera zoom & orbit
    const zoom = this.input.consumeZoom();
    if(zoom !== 0){
      this.camDist = Math.max(CONFIG.CAM_DIST_MIN, Math.min(CONFIG.CAM_DIST_MAX,
        this.camDist - zoom*CONFIG.CAM_ZOOM_STEP));
    }
    
    // Calculate current camera angle from horizontal (for Automatic mode detection)
    const tAngle = (this.camDist - CONFIG.CAM_DIST_MIN) / (CONFIG.CAM_DIST_MAX - CONFIG.CAM_DIST_MIN);
    this._currentCamAngleDeg = (this._camAngleMin + tAngle * (this._camAngleMax - this._camAngleMin)) * 180 / Math.PI;
    
    const camRot = this.input.consumeCamRotate();
    const camMode = this.cameraMode || 'dynamic';
    const inv = (this.settings && this.settings.invertCamRot) ? -1 : 1;
    // Mouse movement rotation without LMB (when enabled in settings)
    const mouseRotate = this.settings && this.settings.cameraMouseRotate 
      ? this.input.consumeCamMouseRotate() 
      : 0;
    
    if(camMode === 'dynamic'){
      // Dynamic: angle changes with zoom, manual rotation with arrows/swipe/mouse-move
      // Left arrow = orbit left, Drag right = orbit right, Mouse right = orbit right
      if(camRot !== 0){
        this.camAngle += camRot * CONFIG.CAM_ROTATE_SPEED * dt;
      } else {
        const swipe = this.input.consumeCamSwipe();
        if(swipe !== 0) this.camAngle += swipe * CONFIG.CAM_SWIPE_SENSITIVITY;
        else if(mouseRotate !== 0) this.camAngle += mouseRotate * CONFIG.CAM_SWIPE_SENSITIVITY;
      }
    } else if(camMode === 'automatic'){
      // Automatic: when zoomed in (20-30°), mouse rotates camera, turret aims at screen center
      if(this._currentCamAngleDeg <= 30 && this.localTank && this.localTank.alive){
        // Mouse rotates camera (same as manual modes)
        if(camRot !== 0){
          this.camAngle += camRot * CONFIG.CAM_ROTATE_SPEED * dt;
        } else {
          const swipe = this.input.consumeCamSwipe();
          if(swipe !== 0) this.camAngle += swipe * CONFIG.CAM_SWIPE_SENSITIVITY;
          else if(mouseRotate !== 0) this.camAngle += mouseRotate * CONFIG.CAM_SWIPE_SENSITIVITY;
        }
      } else {
        // Manual rotation when zoomed out
        if(camRot !== 0){
          this.camAngle += camRot * CONFIG.CAM_ROTATE_SPEED * dt;
        } else {
          const swipe = this.input.consumeCamSwipe();
          if(swipe !== 0) this.camAngle += swipe * CONFIG.CAM_SWIPE_SENSITIVITY;
          else if(mouseRotate !== 0) this.camAngle += mouseRotate * CONFIG.CAM_SWIPE_SENSITIVITY;
        }
      }
    } else if(camMode === 'hull'){
      // Hull follow: camera always behind tank hull
      if(this.localTank && this.localTank.alive){
        this.camAngle = this.localTank.heading + Math.PI;
      }
    } else if(camMode === 'arrows'){
      if(camRot !== 0){
        this.camAngle += camRot * CONFIG.CAM_ROTATE_SPEED * dt;
      } else if(mouseRotate !== 0){
        this.camAngle += mouseRotate * CONFIG.CAM_SWIPE_SENSITIVITY;
      }
    } else if(camMode === 'swipe'){
      const swipe = this.input.consumeCamSwipe();
      if(swipe !== 0) this.camAngle += swipe * CONFIG.CAM_SWIPE_SENSITIVITY;
      else if(mouseRotate !== 0) this.camAngle += mouseRotate * CONFIG.CAM_SWIPE_SENSITIVITY;
    } else if(camMode === 'crosshair'){
      // Crosshair mode: mouse always rotates camera, turret aims at center
      if(camRot !== 0){
        this.camAngle += camRot * CONFIG.CAM_ROTATE_SPEED * dt;
      } else {
        const swipe = this.input.consumeCamSwipe();
        if(swipe !== 0) this.camAngle += swipe * CONFIG.CAM_SWIPE_SENSITIVITY;
        else if(mouseRotate !== 0) this.camAngle += mouseRotate * CONFIG.CAM_SWIPE_SENSITIVITY;
      }
    }

    // Local tank input (keyboard/mouse OR touch)
    if(this._matchStartDelay > 0){
      // Skip all input during match start countdown
    } else if(this.localTank && this.localTank.alive && !this.localTank.dying && !(this.glad && this.glad.ended)){
      let throttle, turn, turretAngle, fire, handbrake;
      
      const touchInput = this.input.getTouchInput();
      
      if(touchInput && touchInput.isTouch){
        // Tank-relative controls (WASD-like): joystick maps directly to tank body
        const mThrottle = touchInput.throttle;
        const mTurn = touchInput.turn;
        const moveMag = Math.sqrt(mThrottle*mThrottle + mTurn*mTurn);
        if(moveMag > 0.15){
          throttle = mThrottle;
          turn = mTurn;
        } else {
          throttle = 0;
          turn = 0;
        }

        // Turret: camera-relative aim
        if(this.input._turretJoystick && this.input._turretJoystick.active){
          turretAngle = (this.camAngle || Math.PI) + Math.PI - (touchInput.turretRelAngle || 0);
        }

        // Fire only when knob is dragged to max distance (armed)
        fire = !!touchInput.armed;
        handbrake = false;
      } else {
        // Desktop: tank-relative controls
        throttle = (this.input.pressed('forward')?1:0) - (this.input.pressed('backward')?1:0);
        turn = (this.input.pressed('right')?1:0) - (this.input.pressed('left')?1:0);

        // In Automatic and Crosshair modes: turret aims at screen center (camera look-at point)
        // Mouse rotates camera, crosshair stays fixed in center
        if(this.cameraMode === 'automatic' || this.cameraMode === 'crosshair'){
          // Turret aims where camera looks (screen center = camera forward direction)
          // Camera looks at tank position (t.x, 1.2, t.z), so turret aims at that point from tank
          // But we want turret to aim at camera's forward direction projected to ground
          const camForward = new THREE.Vector3();
          this.camera.getWorldDirection(camForward);
          camForward.y = 0; // Project to horizontal plane
          if(camForward.length() > 0.001){
            camForward.normalize();
            turretAngle = Math.atan2(camForward.x, camForward.z);
          } else {
            turretAngle = this.localTank.turretAngle;
          }
        } else {
          turretAngle = this._mouseWorldAngle();
        }
        fire = this.input.pressed('fire');
        handbrake = this.input.pressed('handbrake');
      }
      
      const input = {throttle, turn, turretWorldAngle:turretAngle, fire, handbrake};
      this.localTank.setInput(input);
      // Forward input to host (P2P or Free Roam)
      if(this.mode==='client'){
        Net.sendInput(input);
      } else if(this.mode==='freeroam' && !NakamaNet.isHost){
        NakamaNet.sendMatchData({t: 'input', input});
      }
    }

    // Super ability activation (PC key / mobile button already wired via #super-btn)
    if(this.localTank && this.localTank.alive && !this.localTank.dying && !(this.glad && this.glad.ended)){
      const superPressed = this.input.consumePressed('super');
      if(superPressed && !this.localTank.superState) this.localTank.activateSuper();
      else if(superPressed && this.localTank.superState === 'targeting') this.localTank.cancelSuper();
      this._updateSupers(dt);
    }

    // Update all tanks
    this.tanks.forEach(t=>{
      if(this._matchStartDelay > 0 && t.brain){
        // Skip bot AI during match start countdown
        t.setInput({throttle:0,turn:0,turretWorldAngle:t.turretAngle,fire:false});
        t.update(dt, this.world, this);
        return;
      }
      if(t.brain){
        t.setInput(t.brain.decide(this));
      } else if(t.ownerPeer && this.clientTankInputs[t.ownerPeer]){
        t.setInput(this.clientTankInputs[t.ownerPeer]);
      } else if(t === this.localTank){
        // Already set above
      } else {
        t.setInput({throttle:0,turn:0,turretWorldAngle:t.turretAngle,fire:false});
      }
      t.update(dt, this.world, this);
    });
    // Respawn dummy tank 2s after death at its original position
    for(const t of this.tanks){
      if(t.isDummy && t.dying && t.deathT > 0.5 && !t._dummyRespawning){
        t._dummyRespawning = true;
        setTimeout(() => {
          t.respawn(this.world, this);
          t.x = t.dummySpawnX;
          t.z = t.dummySpawnZ;
          t.root.position.x = t.x;
          t.root.position.z = t.z;
          t.turretGroup.position.set(0, 0, 0);
          t.turretGroup.rotation.set(0, 0, 0);
          t._drawHp();
          t._dummyRespawning = false;
        }, 2000);
      }
    }

    // Dummy rapidly regenerates health
    for(const t of this.tanks){
      if(t.isDummy && t.alive && !t.dying && t.hp < t.maxHp){
        t.heal(t.maxHp * 0.5 * dt);
      }
    }

    // Spectate housekeeping: hop off dead targets, keep the bar fresh (HP, kills)
    if(this.spectate){
      if(this.spectateTarget && (!this.spectateTarget.alive || this.spectateTarget.dying)){
        this._spectateNext(1);
      }
      this._specBarTimer = (this._specBarTimer || 0) + dt;
      if(this._specBarTimer > 0.5){ this._specBarTimer = 0; this._renderSpectateBar(); }
    }

    // Projectiles
    this.projectiles.forEach(p=> p.update(dt, this.world, this));
    this.projectiles = this.projectiles.filter(p=>{ if(p.dead){ if(p._trail) this.trailManager.endTrail(p._trail); p.detach(); return false;} return true; });
    // Push shell positions to active trails
    for(const p of this.projectiles){
      if(p._trail && !p.dead) this.trailManager.pushPosition(p._trail, p.x, p.y, p.z);
    }
    this.explosions.forEach(e=> e.update(dt));
    this.explosions = this.explosions.filter(e=>{ if(e.dead){e.detach(); return false;} return true; });
    // Shell casings (physics-driven, self-lifetime)
    this.casings.forEach(c=> c.update(dt, this.world, this));
    this.casings = this.casings.filter(c=>{ if(c.dead){c.detach(); return false;} return true; });
    // Muzzle flash sprites
    if(this._muzzleFlashes){
      this._muzzleFlashes.forEach(p=>{
        p.life -= dt;
        if(p.vx != null){
          p.sprite.position.x += p.vx * dt;
          p.sprite.position.z += p.vz * dt;
          p.sprite.position.y += p.vy * dt;
          p.vy -= 1.5 * dt;
        }
        p.sprite.material.opacity = Math.max(0, p.life / p.maxLife);
        p.sprite.scale.x = p.sprite.scale.y = (p.baseScale || 2.0) * (1 + (1 - p.life / p.maxLife) * 0.5);
      });
      this._muzzleFlashes = this._muzzleFlashes.filter(p=>{
        if(p.life <= 0){ this.scene.remove(p.sprite); /* shared VFX tex */ p.sprite.material.dispose(); return false; }
        return true;
      });
    }
    // Muzzle lights (pooled — fade out after each shot)
    if(this._muzzleLights){
      this._muzzleLights.forEach(l=>{
        if(!l.active) return;
        const k = (l.life -= dt) / l.maxLife;
        l.light.intensity = k <= 0 ? 0 : 26 * k;
        if(k <= 0) l.active = false;
      });
    }
    // Helix video overlay
    if(this._helixVideos.size){
      for(const [tankId, hv] of this._helixVideos){
        const tank = this.tanks.find(t => t.id === tankId);
        if(!tank){ hv.fadeTimer = 0.15; continue; }
        const hasFlame = this.projectiles.some(p => p.type === 'flame' && p.owner && p.owner.id === tankId);
        if(hasFlame){
          hv.firing = true;
          hv.fadeTimer = 0;
          hv.mesh.material.opacity = 1;
          if(hv.el.paused) hv.el.play().catch(() => {});
        } else if(hv.firing){
          hv.firing = false;
          hv.fadeTimer = 0.15;
        }
        if(!hv.firing){
          hv.fadeTimer -= dt;
          hv.mesh.material.opacity = Math.max(0, hv.fadeTimer / 0.15);
          if(hv.fadeTimer <= 0){
            hv.el.pause(); hv.el.currentTime = 0;
            hv.parent.remove(hv.mesh);
            hv.mesh.geometry.dispose();
            hv.mesh.material.dispose();
            hv.tex.dispose();
            this._helixVideos.delete(tankId);
          }
        }
      }
    }
    // Ricochet labels
    if(this._ricoLabels){
      this._ricoLabels.forEach(l=>{ l.life -= dt; l.sprite.material.opacity = Math.max(0, l.life / l.maxLife); });
      this._ricoLabels = this._ricoLabels.filter(l=>{
        if(l.life <= 0){ this.scene.remove(l.sprite); l.sprite.material.map.dispose(); l.sprite.material.dispose(); return false; }
        return true;
      });
    }
    // Floating damage numbers
    if(this._dmgLabels){
      this._dmgLabels.forEach(l=>{
        l.life -= dt;
        l.sprite.position.y += l.vy * dt;
        l.sprite.material.opacity = Math.max(0, l.life / l.maxLife);
      });
      this._dmgLabels = this._dmgLabels.filter(l=>{
        if(l.life <= 0){ this.scene.remove(l.sprite); l.sprite.material.dispose(); if(l.canvas) this._putDmgCanvas(l.canvas); return false; }
        return true;
      });
    }
    // Muzzle smoke
    if(this._muzzleSmokes){
      this._muzzleSmokes.forEach(p=>{
        p.life -= dt;
        p.sprite.position.x += p.vx * dt;
        p.sprite.position.z += p.vz * dt;
        p.sprite.position.y += p.vy * dt;
        p.vy -= 0.3 * dt;
        const grow = 1 + (1 - p.life / p.maxLife) * 1.2;
        p.sprite.scale.x = p.sprite.scale.y = p.baseScale * grow;
        p.sprite.material.opacity = Math.max(0, (p.life / p.maxLife) * 0.65);
      });
      this._muzzleSmokes = this._muzzleSmokes.filter(p=>{
        if(p.life <= 0){ this.scene.remove(p.sprite); /* shared VFX tex */ p.sprite.material.dispose(); return false; }
        return true;
      });
    }
    // Destruction / burst particles
    if(this._bursts){
      this._bursts.forEach(p=>{
        p.life -= dt;
        p.sprite.position.x += p.vx * dt;
        p.sprite.position.z += p.vz * dt;
        p.sprite.position.y += p.vy * dt;
        p.vy -= p.gravity * dt;
        const k = 1 - p.life / p.maxLife;
        p.sprite.scale.x = p.sprite.scale.y = p.baseScale * (1 + k * p.grow);
        if(p.spin) p.sprite.rotation.z += p.spin * dt;
        p.sprite.material.opacity = Math.max(0, (p.life / p.maxLife) * p.fade);
      });
      this._bursts = this._bursts.filter(p=>{
        if(p.life <= 0){ this.scene.remove(p.sprite); /* shared VFX tex */ p.sprite.material.dispose(); return false; }
        return true;
      });
    }
    // Exhaust / drift smoke particles
    if(this._exhaustParts){
      this._exhaustParts.forEach(p=>{
        p.life -= dt;
        p.sprite.position.x += p.vx * dt;
        p.sprite.position.z += p.vz * dt;
        p.sprite.position.y += p.vy * dt;
        p.vy -= 0.2 * dt;
        const grow = 1 + (1 - p.life / p.maxLife) * 1.5;
        p.sprite.scale.x = p.sprite.scale.y = p.baseScale * grow;
        p.sprite.material.opacity = Math.max(0, (p.life / p.maxLife) * 0.4);
      });
      this._exhaustParts = this._exhaustParts.filter(p=>{
        if(p.life <= 0){ this.scene.remove(p.sprite); /* shared VFX tex */ p.sprite.material.dispose(); return false; }
        return true;
      });
    }
    // Flamethrower damage accumulators — live stacking counter
    if(this._flameAccums){
      for(const [id, entry] of this._flameAccums){
        const tank = this.tanks.find(t => t.id === id);
        if(!tank || (!tank.alive && entry.damage === 0)){
          if(entry.sprite){ this.scene.remove(entry.sprite); entry.sprite.material.dispose(); }
          this._flameAccums.delete(id);
          continue;
        }
        entry.timer -= dt;
        if(entry.timer <= 0 || !tank.alive){
          // Stop accumulating — let the sprite fade out
          entry.fading = true;
          if(!this._flameFading) this._flameFading = [];
          this._flameFading.push(entry);
          this._flameAccums.delete(id);
        } else if(entry.sprite){
          // Follow tank position
          entry.sprite.position.x = tank.x + (Math.random() - 0.5) * 0.2;
          entry.sprite.position.z = tank.z + (Math.random() - 0.5) * 0.2;
          entry.sprite.position.y = tank.def.turret.h + tank.def.body.h + 3.6;
        }
      }
    }
    // Fading flame labels
    if(this._flameFading){
      for(let i = this._flameFading.length - 1; i >= 0; i--){
        const f = this._flameFading[i];
        f.life = (f.life || 0.6) - dt;
        if(f.sprite){
          f.sprite.material.opacity = Math.max(0, (f.life || 0) / 0.6);
          if(f.life <= 0){
            this.scene.remove(f.sprite);
            f.sprite.material.dispose();
            this._flameFading.splice(i, 1);
          }
        } else {
          this._flameFading.splice(i, 1);
        }
      }
    }
    // Water foam around tanks in lakes
    this._updateWaterFoam(dt);

    // Bullet trails
    this.trailManager.update(dt, this.camera);

// Camera (orbits around tank; auto mode locks behind hull front; in
    // spectator mode we follow the watched tank instead of the dead local one)
    if(this.isSpectator){
      this._updateSpectatorCamera(dt);
    } else {
      const camFocus = (this.spectate && this.spectateTarget && this.spectateTarget.alive && !this.spectateTarget.dying)
        ? this.spectateTarget
        : (this.localTank && this.localTank.alive && !this.localTank.dying ? this.localTank : null);
      if(camFocus){
      const t = camFocus;
      // Handle camera modes that override camAngle
      if(this.cameraMode === 'hull'){
        this.camAngle = t.heading + Math.PI;
      }
      // Automatic and Crosshair modes: camAngle is controlled by mouse input in _update()
      // No override needed here - camAngle already updated based on mouse movement
      const angle = this.camAngle;
      const camTarget = new THREE.Vector3(
        t.x + Math.sin(angle) * this.camDist,
        this._getCameraHeight(this.camDist),
        t.z + Math.cos(angle) * this.camDist);
      // Never let the camera cross a border wall (keeps walls out of view)
      const camLim = (this.world && this.world.half || 75) - 8;
      camTarget.x = Math.max(-camLim, Math.min(camLim, camTarget.x));
      camTarget.z = Math.max(-camLim, Math.min(camLim, camTarget.z));
      this.camera.position.lerp(camTarget, CONFIG.CAM_LERP);
      this.camera.lookAt(t.x, 1.2, t.z);
      if(this._shake > 0){
        this._shake = Math.max(0, this._shake - dt*2.5);
        const shScale = (this.settings && typeof this.settings.screenShake === 'number') ? this.settings.screenShake / 100 : 1;
        const s = this._shake * shScale;
        this.camera.position.x += (Math.random()-0.5)*s;
        this.camera.position.y += (Math.random()-0.5)*s;
        this.camera.position.z += (Math.random()-0.5)*s;
      }
      } else if(this.localTank && !this.localTank.alive){
        // Keep camera at last position when dead (don't follow dying tank)
      }
    }

    // Dynamic UI and outline scaling based on camera distance
    for(const t of this.tanks) t.updateDistanceScaling(this.camera.position, this.camDist);

    // Aim line
    this._updateAimLine();

    // Visibility
    this._updateVisibility();

    // Networking: Host broadcasts state
    if(this.mode==='host'){
      this._netSendAcc += dt;
      if(this._netSendAcc > 0.05){ // ~20Hz
        this._netSendAcc = 0;
        Net.broadcast({time:this.time, glad:this.glad ? this._gladSnapshot() : null, tanks:this.tanks.map(t=>t.snapshot()), projs:this.projectiles.filter(p=>!p.dead).map(p=>({id:p.id,x:p.x,y:p.y,z:p.z,dx:p.dir.x,dz:p.dir.z,type:p.type,life:p.life}))});
        if(window.__PLATOON_BATTLE){
          window.__PLATOON_BATTLE.score = this.tanks.filter(t=>!t.isDummy).map(t=>({name:t.name||'Player', kills:t.kills||0, dd:Math.round(t.damageDealt||0)}));
        }
      }
    } else if(this.mode==='freeroam' && NakamaNet.isHost){
      this._netSendAcc += dt;
      if(this._netSendAcc > 0.05){
        this._netSendAcc = 0;
        NakamaNet.sendMatchData({t: 'state', s: {time:this.time, tanks:this.tanks.map(t=>t.snapshot()), projs:this.projectiles.filter(p=>!p.dead).map(p=>({id:p.id,x:p.x,y:p.y,z:p.z,dx:p.dir.x,dz:p.dir.z,type:p.type,life:p.life}))}});
      }
    }

    // HUD
    this._updateHUD();
    } catch(e){ console.warn('Update error:', e); }
  }

  _updateAimLine(){
    if(!this.aimLine) return;
    const t = this.localTank;
    if(!t || !t.alive){
      this.aimLine.visible = false; if(this.aimMarkers) this.aimMarkers.visible = false;
      return;
    }
    this.aimLine.visible = true;
    const {pos, dir} = t.muzzle();
    const startX = pos.x, startZ = pos.z;
    const range = t.def.shellRange;
    const step = 1.5;
    let endX = startX, endZ = startZ;
    let endDist = range;
    for(let d=0; d<=range; d+=step){
      const tx = startX + dir.x*d, tz = startZ + dir.z*d;
      if(this.world.collidesWallsOnly(tx, tz, 0.3)){ endX=tx; endZ=tz; endDist=d; break; }
      endX=tx; endZ=tz;
    }
    const arr = this.aimLine.geometry.attributes.position.array;
    const isCone = t.def.shellType === 'flame';
    let ricoX = endX, ricoZ = endZ, ricoEndX = endX, ricoEndZ = endZ;
    let ricoEntryDist = endDist, ricoRemaining = 0;
    let rDirX = 0, rDirZ = 0, ricoTarget = null;
    const y = t.def.body.h + 0.6;
    if(isCone){
      const tanHalf = t.def.fireConeHalfAngle || 0.12;
      const halfW = endDist * tanHalf;
      const perpX = -dir.z, perpZ = dir.x;
      arr[0]=startX; arr[1]=y; arr[2]=startZ;
      arr[3]=endX + perpX*halfW; arr[4]=y; arr[5]=endZ + perpZ*halfW;
      arr[6]=endX - perpX*halfW; arr[7]=y; arr[8]=endZ - perpZ*halfW;
      arr[9]=startX; arr[10]=y; arr[11]=startZ;
    } else {
      // Ricochet prediction — circle-ray intersection for exact entry point
      for(const enemy of this.tanks){
        if(enemy === t || !enemy.alive || !enemy.def.armor) continue;
        const rad = (Math.max(enemy.def.body.w, enemy.def.body.l)/2 + 0.4) * (enemy.hitScale || 1);
        const edx = startX - enemy.x, edz = startZ - enemy.z;
        const b = 2 * (edx * dir.x + edz * dir.z);
        const c = edx*edx + edz*edz - rad*rad;
        const disc = b*b - 4*c;
        if(disc <= 0) continue;
        const sqrtD = Math.sqrt(disc);
        const t1 = (-b - sqrtD) / 2;
        const t2 = (-b + sqrtD) / 2;
        const entryT = (t1 > 0.01 && t1 < endDist) ? t1 : (t2 > 0.01 && t2 < endDist ? t2 : 0);
        if(entryT <= 0 || entryT > ricoEntryDist) continue;
        const ex = startX + dir.x * entryT, ez = startZ + dir.z * entryT;
        // Check if ricochet would happen
        const h = enemy.heading;
        const fwX = Math.sin(h), fwZ = Math.cos(h);
        const fx = ex - enemy.x, fz = ez - enemy.z;
        const fl = Math.hypot(fx, fz);
        if(fl > 0.01){
          const fdX = fx/fl, fdZ = fz/fl;
          const dot = fdX * fwX + fdZ * fwZ;
          let nxx, nzz, av;
          if(dot > 0.5){ nxx = fwX; nzz = fwZ; av = enemy.def.armor.front; }
          else if(dot < -0.5){ nxx = -fwX; nzz = -fwZ; av = enemy.def.armor.back; }
          else {
            const sX = Math.cos(h), sZ = -Math.sin(h);
            const sD = fdX * sX + fdZ * sZ;
            nxx = sD > 0 ? sX : -sX; nzz = sD > 0 ? sZ : -sZ;
            av = enemy.def.armor.sides;
          }
          const dN = Math.abs(dir.x * nxx + dir.z * nzz);
          const aFS = 90 - Math.acos(Math.min(1, dN)) * 180 / Math.PI;
          if(aFS < av){
            const rD = dir.x * nxx + dir.z * nzz;
            let rrx = dir.x - 2 * rD * nxx;
            let rrz = dir.z - 2 * rD * nzz;
            const rL = Math.hypot(rrx, rrz);
            if(rL > 0.01){
              rrx /= rL; rrz /= rL;
              let rEx = ex, rEz = ez, lastS = 0;
              const ricoMax = (range - entryT) / 1.5;
              for(let s=0; s<=ricoMax; s+=1.5){
                const tx = ex + rrx * s, tz = ez + rrz * s;
                if(this.world.collidesWallsOnly(tx, tz, 0.3)){ rEx=tx; rEz=tz; break; }
                rEx=tx; rEz=tz; lastS = s;
              }
              ricoX = ex; ricoZ = ez; ricoEntryDist = entryT;
              ricoEndX = rEx; ricoEndZ = rEz; ricoRemaining = lastS;
              rDirX = rrx; rDirZ = rrz;
            }
          } else {
            ricoX = ex; ricoZ = ez; ricoEntryDist = entryT;
            ricoEndX = ex; ricoEndZ = ez; ricoRemaining = 0;
          }
        }
        ricoTarget = enemy;
        break;
      }
      arr[0]=startX; arr[1]=y; arr[2]=startZ;
      arr[3]=ricoX; arr[4]=y; arr[5]=ricoZ;
      arr[6]=ricoX; arr[7]=y; arr[8]=ricoZ;
      arr[9]=ricoEndX; arr[10]=y; arr[11]=ricoEndZ;
    }
    // Ricochet indicator: 2 colored lines on target tank's visible faces
    if(this.settings.ricochetIndicator && ricoTarget && ricoTarget.alive){
      const en = ricoTarget, h = en.heading;
      const fwX = Math.sin(h), fwZ = Math.cos(h);
      const sX = Math.cos(h), sZ = -Math.sin(h);
      const cW = en.def.body.w / 2, cL = en.def.body.l / 2;
      // Direction from target to shooter (for face visibility)
      const dtx = startX - en.x, dtz = startZ - en.z, dl = Math.hypot(dtx, dtz) || 1;
      // 4 faces: {nx,nz} = normal, {mx,mz} = midpoint offset, {tx,tz} = tangent, len, armor
      const faces = [
        { nx:fwX, nz:fwZ, mx:fwX*cL, mz:fwZ*cL, tx:sX, tz:sZ, len:cW*2, armor:'front' },
        { nx:-fwX, nz:-fwZ, mx:-fwX*cL, mz:-fwZ*cL, tx:sX, tz:sZ, len:cW*2, armor:'back' },
        { nx:sX, nz:sZ, mx:sX*cW, mz:sZ*cW, tx:fwX, tz:fwZ, len:cL*2, armor:'sides' },
        { nx:-sX, nz:-sZ, mx:-sX*cW, mz:-sZ*cW, tx:fwX, tz:fwZ, len:cL*2, armor:'sides' },
      ];
      const scored = faces.map(f => ({...f, dot: (f.nx*dtx + f.nz*dtz)/dl }));
      scored.sort((a,b) => b.dot - a.dot);
      const yp = en.def.body.h * 0.4, off = 0.1, lf = 1.0;
      const farr = this._ricoFrame.geometry.attributes.position.array;
      let fi = 0;
      for(let i=0; i<this._ricoLines.length; i++){
        const f = scored[i];
        if(!f){ this._ricoLines[i].visible = false; continue; }
        const fmx = en.x + f.mx + f.nx*off;
        const fmz = en.z + f.mz + f.nz*off;
        const hf = f.len * lf * 0.5;
        const arr = this._ricoLines[i].geometry.attributes.position.array;
        // colored line
        arr[0] = fmx - f.tx*hf; arr[1] = yp; arr[2] = fmz - f.tz*hf;
        arr[3] = fmx + f.tx*hf; arr[4] = yp; arr[5] = fmz + f.tz*hf;
        this._ricoLines[i].geometry.attributes.position.needsUpdate = true;
        // white end-caps (perpendicular to tangent)
        const pX = -f.tz, pZ = f.tx, capHalf = 0.07;
        const lx = fmx - f.tx*hf, lz = fmz - f.tz*hf;
        farr[fi] = lx - pX*capHalf; farr[fi+1] = yp; farr[fi+2] = lz - pZ*capHalf;
        farr[fi+3] = lx + pX*capHalf; farr[fi+4] = yp; farr[fi+5] = lz + pZ*capHalf;
        fi += 6;
        const rx = fmx + f.tx*hf, rz = fmz + f.tz*hf;
        farr[fi] = rx - pX*capHalf; farr[fi+1] = yp; farr[fi+2] = rz - pZ*capHalf;
        farr[fi+3] = rx + pX*capHalf; farr[fi+4] = yp; farr[fi+5] = rz + pZ*capHalf;
        fi += 6;
        // color
        const dN = Math.abs(dir.x*f.nx + dir.z*f.nz);
        const aFS = 90 - Math.acos(Math.min(1, dN)) * 180 / Math.PI;
        const av = en.def.armor[f.armor], margin = aFS - av;
        let col = 0;
        if(margin >= 15) col = 0x33ee33;
        else if(margin >= 0){
          const t = margin/15;
          col = (Math.round(255-t*155)<<16) | (Math.round(128+t*110)<<8) | 0;
        } else col = 0xee3333;
        this._ricoLines[i].material.color.setHex(col);
        this._ricoLines[i].visible = true;
      }
      this._ricoFrame.geometry.attributes.position.needsUpdate = true;
      this._ricoFrame.visible = true;
    } else {
      this._ricoLines.forEach(l => l.visible = false);
      if(this._ricoFrame) this._ricoFrame.visible = false;
    }
    this.aimLine.geometry.attributes.position.needsUpdate = true;

    // Professional markers + labels every 10m (follow ricochet path)
    if(this.aimMarkers){
      const isPro = this.settings.aimLineDesign === 'professional';
      this.aimMarkers.visible = isPro;
      const markArr = this._aimMarkerArr;
      let idx = 0;
      let labelIdx = 0;
      const totalPath = ricoEntryDist + ricoRemaining;
      const isCone2 = t.def.shellType === 'flame';
      for(let d=10; d<=totalPath && !isCone2; d+=10){
        let mx, mz, perpX, perpZ;
        if(d <= ricoEntryDist){
          mx = startX + dir.x * d;
          mz = startZ + dir.z * d;
          perpX = -dir.z; perpZ = dir.x;
        } else {
          const rd = d - ricoEntryDist;
          mx = ricoX + rDirX * rd;
          mz = ricoZ + rDirZ * rd;
          perpX = -rDirZ; perpZ = rDirX;
        }
        const halfW = 0.4;
        if(isPro && idx+5 < markArr.length){
          markArr[idx] = mx + perpX * halfW;
          markArr[idx+1] = y;
          markArr[idx+2] = mz + perpZ * halfW;
          markArr[idx+3] = mx - perpX * halfW;
          markArr[idx+4] = y;
          markArr[idx+5] = mz - perpZ * halfW;
          idx += 6;
        }
        if(isPro && labelIdx < this._aimLabels.length){
          const lbl = this._aimLabels[labelIdx];
          lbl.visible = true;
          lbl.position.set(mx + perpX * 1.2, y + 0.6, mz + perpZ * 1.2);
          labelIdx++;
        }
      }
      if(idx < markArr.length){ markArr.fill(0, idx); }
      if(isPro){
        this.aimMarkers.geometry.attributes.position.needsUpdate = true;
        while(labelIdx < this._aimLabels.length){
          this._aimLabels[labelIdx].visible = false;
          labelIdx++;
        }
      } else {
        this._aimLabels.forEach(s=>s.visible = false);
      }
    }
    // Update crosshair visibility
    if(this._crosshairEl){
      const showCrosshair = this.localTank && this.localTank.alive && 
        (this.cameraMode === 'crosshair' || 
         (this.cameraMode === 'automatic' && this._currentCamAngleDeg <= 30));
      this._crosshairEl.style.display = showCrosshair ? 'block' : 'none';
    }
  }

  /* Ricochet indicator: 2 colored lines + white end-caps on visible faces */
  _initRicoIndicator(){
    this._ricoLines = [];
    for(let i=0; i<2; i++){
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(6);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0x00ff00, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      line.frustumCulled = false;
      this.scene.add(line);
      this._ricoLines.push(line);
    }
    // White end-caps (frame): 4 caps (2 per face × 2 faces)
    const fgeo = new THREE.BufferGeometry();
    const fpos = new Float32Array(24); // 4 segments × 2 verts × 3 coords
    fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
    this._ricoFrame = new THREE.LineSegments(fgeo, new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
    }));
    this._ricoFrame.visible = false;
    this._ricoFrame.frustumCulled = false;
    this.scene.add(this._ricoFrame);
  }

  _initCrosshair(){
    // Create screen-space crosshair as HTML overlay (fixed in center of screen)
    const el = document.createElement('div');
    el.id = 'center-crosshair';
    el.style.cssText = `
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      z-index: 100;
      width: 32px; height: 32px;
      display: none;
    `;
    el.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 32 32" style="filter: drop-shadow(0 0 2px #000);">
        <circle cx="16" cy="16" r="10" fill="none" stroke="#fff" stroke-width="2"/>
        <line x1="16" y1="2" x2="16" y2="6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
        <line x1="16" y1="26" x2="16" y2="30" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
        <line x1="2" y1="16" x2="6" y2="16" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
        <line x1="26" y1="16" x2="30" y2="16" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
    document.getElementById('game-root').appendChild(el);
    this._crosshairEl = el;
  }

  spawnRicoLabel(x, z){
    const c = document.createElement('canvas');
    c.width = 256; c.height = 96;
    const g = c.getContext('2d');
    g.font = 'bold 42px "Segoe UI", "Arial Black", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.strokeStyle = '#000'; g.lineWidth = 6; g.lineJoin = 'round';
    g.strokeText('Ricochet!', 128, 48);
    g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 12;
    g.fillStyle = '#ff6a2a';
    g.fillText('Ricochet!', 128, 48);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({map:tex, transparent:true, depthTest:false, depthWrite:false});
    const s = new THREE.Sprite(mat);
    s.position.set(x, 1.5, z);
    s.scale.set(4, 1.5, 1);
    this.scene.add(s);
    if(!this._ricoLabels) this._ricoLabels = [];
    this._ricoLabels.push({sprite:s, life:1.2, maxLife:1.2});
  }

  _getDmgCanvas(){
    if(!this._dmgCanvasPool) this._dmgCanvasPool = [];
    let c = this._dmgCanvasPool.pop();
    if(!c){ c = document.createElement('canvas'); c.width = 128; c.height = 64; }
    return c;
  }
  _putDmgCanvas(c){
    if(!this._dmgCanvasPool) this._dmgCanvasPool = [];
    if(this._dmgCanvasPool.length < 20) this._dmgCanvasPool.push(c);
  }

  spawnDamageLabel(x, y, z, amount){
    const c = this._getDmgCanvas();
    const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 64);
    g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 6;
    g.font = 'bold 38px "Segoe UI", "Arial Black", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.strokeStyle = '#000'; g.lineWidth = 5; g.lineJoin = 'round';
    g.strokeText('-' + Math.round(amount), 64, 32);
    g.fillStyle = '#ff4444';
    g.fillText('-' + Math.round(amount), 64, 32);
    const tex = new THREE.CanvasTexture(c);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({map:tex, transparent:true, depthTest:false, depthWrite:false}));
    s.renderOrder = 999;
    s.position.set(x + (Math.random()-0.5)*1.5, y, z + (Math.random()-0.5)*1.5);
    s.scale.set(2.8, 1.4, 1);
    this.scene.add(s);
    if(!this._dmgLabels) this._dmgLabels = [];
    this._dmgLabels.push({sprite:s, life:1.0, maxLife:1.0, vy:1.2 + Math.random()*0.8});
  }

  _accumFlameDamage(tank, amount){
    if(!this._flameAccums) this._flameAccums = new Map();
    let entry = this._flameAccums.get(tank.id);
    if(!entry){
      const c = document.createElement('canvas'); c.width = 128; c.height = 64;
      const g = c.getContext('2d');
      const tex = new THREE.CanvasTexture(c);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({map:tex, transparent:true, depthTest:false, depthWrite:false}));
      s.renderOrder = 999;
      s.position.set(tank.x, tank.def.turret.h + tank.def.body.h + 3.6, tank.z);
      s.scale.set(2.8, 1.4, 1);
      this.scene.add(s);
      entry = {sprite:s, canvas:c, ctx:g, tex, damage:0, timer:0.3};
      this._flameAccums.set(tank.id, entry);
    }
    entry.damage += amount;
    entry.timer = 0.3;
    // Redraw canvas with climbing number
    const g = entry.ctx;
    const c = entry.canvas;
    g.clearRect(0, 0, c.width, c.height);
    g.font = 'bold 38px "Segoe UI", "Arial Black", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 6;
    g.strokeStyle = '#000'; g.lineWidth = 5; g.lineJoin = 'round';
    g.strokeText('-' + Math.round(entry.damage), 64, 32);
    g.fillStyle = '#ff6644';
    g.fillText('-' + Math.round(entry.damage), 64, 32);
    entry.tex.needsUpdate = true;
  }

  spawnExhaust(x, y, z, dirAngle, kmh){
    if(!this.isFancy) return;
    if(!this._exhaustParts) this._exhaustParts = [];
    if(this._exhaustParts.length > 30) return;
    const tex = VFX.getTex('smoke');
    const mat = new THREE.SpriteMaterial({map:tex, transparent:true, depthTest:false, depthWrite:false, opacity:0.5});
    const s = new THREE.Sprite(mat);
    const baseScale = 0.3 + Math.random() * 0.25;
    const sc = baseScale * (0.7 + kmh / 200);
    s.position.set(x, y, z);
    s.scale.set(sc, sc, 1);
    this.scene.add(s);
    const spd = 0.8 + kmh / 60;
    this._exhaustParts.push({
      sprite:s, life:0.6 + Math.random() * 0.4, maxLife:1.0,
      vx: Math.sin(dirAngle) * spd + (Math.random() - 0.5) * 0.4,
      vz: Math.cos(dirAngle) * spd + (Math.random() - 0.5) * 0.4,
      vy: 0.5 + Math.random() * 0.6,
      baseScale: sc
    });
  }

  /* Check if any part of the tank intersects water */
  _tankInWater(t){
    const hw = t.def.body.w/2 + 0.6, hl = t.def.body.l/2 + 0.4;
    const ch = Math.cos(t.heading), sh = Math.sin(t.heading);
    const corners = [
      [ hw,  hl], [ hw, -hl], [-hw,  hl], [-hw, -hl],
    ];
    for(const [lx,lz] of corners){
      if(this.world.lakeAt(t.x + lx*ch + lz*sh, t.z - lx*sh + lz*ch)) return true;
    }
    return !!this.world.lakeAt(t.x, t.z);
  }

  _tankFullyInWater(t){
    const hw = t.def.body.w/2 + 0.6, hl = t.def.body.l/2 + 0.4;
    const ch = Math.cos(t.heading), sh = Math.sin(t.heading);
    const pts = [[0,0],[ hw, hl],[ hw,-hl],[-hw, hl],[-hw,-hl]];
    for(const [lx,lz] of pts){
      if(!this.world.lakeAt(t.x + lx*ch + lz*sh, t.z - lx*sh + lz*ch)) return false;
    }
    return true;
  }

  /* White outline line around tank at water level — only edges in water visible */
  _updateWaterFoam(dt){
    if(!this.world) return;
    for(const t of this.tanks){
      if(!t.alive || t.dying){
        this._cleanupFoam(t);
        continue;
      }
      const inWater = this._tankInWater(t);
      const fullyIn = inWater && this._tankFullyInWater(t);
      if(fullyIn && !t._drowning){
        t._drowning = true;
        t._drownTimer = 0;
        t._drownBar.visible = true;
      } else if(!fullyIn && t._drowning){
        t._drowning = false;
        t._drownTimer = 0;
        t._drownBar.visible = false;
      }
      if(t._drowning){
        t._drownTimer += dt;
        t._drawDrownBar(t._drownTimer / 10);
        if(t._drownTimer >= 10){
          t._drowning = false;
          t._drownBar.visible = false;
          t.takeDamage(t.hp, null, null);
        }
      }
      if(inWater){
        if(!t._foamMeshes){
          const hw = t.def.body.w/2 + 0.5, hl = t.def.body.l/2 + 0.3, fat = 0.6;
          const mat = () => new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
          });
          const makeStrip = (pts) => {
            const sh = new THREE.Shape();
            sh.moveTo(pts[0][0], pts[0][1]);
            for(let i=1;i<pts.length;i++) sh.lineTo(pts[i][0], pts[i][1]);
            sh.closePath();
            const g = new THREE.ShapeGeometry(sh);
            g.rotateX(-Math.PI/2);
            const m = new THREE.Mesh(g, mat());
            m.renderOrder = 4;
            this.scene.add(m);
            return m;
          };
          t._foamMeshes = [
            makeStrip([[0, -hl], [hw, -hl], [hw, -hl+fat], [0, -hl+fat]]),
            makeStrip([[-hw, -hl], [0, -hl], [0, -hl+fat], [-hw, -hl+fat]]),
            makeStrip([[0, hl], [hw, hl], [hw, hl-fat], [0, hl-fat]]),
            makeStrip([[-hw, hl], [0, hl], [0, hl-fat], [-hw, hl-fat]]),
            makeStrip([[hw, 0], [hw, -hl], [hw-fat, -hl], [hw-fat, 0]]),
            makeStrip([[hw, 0], [hw, hl], [hw-fat, hl], [hw-fat, 0]]),
            makeStrip([[-hw, 0], [-hw, -hl], [-hw+fat, -hl], [-hw+fat, 0]]),
            makeStrip([[-hw, 0], [-hw, hl], [-hw+fat, hl], [-hw+fat, 0]]),
          ];
        }
        const ch = Math.cos(t.heading), sh = Math.sin(t.heading);
        const hw = t.def.body.w/2 + 0.5, hl = t.def.body.l/2 + 0.3;
        const edges = [
          { mid:[ hw/2,  hl], idx:0, ox: sh, oz: ch },
          { mid:[-hw/2,  hl], idx:1, ox: sh, oz: ch },
          { mid:[ hw/2, -hl], idx:2, ox:-sh, oz:-ch },
          { mid:[-hw/2, -hl], idx:3, ox:-sh, oz:-ch },
          { mid:[ hw,  hl/2], idx:4, ox: ch, oz:-sh },
          { mid:[ hw, -hl/2], idx:5, ox: ch, oz:-sh },
          { mid:[-hw,  hl/2], idx:6, ox:-ch, oz: sh },
          { mid:[-hw, -hl/2], idx:7, ox:-ch, oz: sh },
        ];
        for(const ed of edges){
          const m = t._foamMeshes[ed.idx];
          const mx = t.x + ed.mid[0]*ch + ed.mid[1]*sh;
          const mz = t.z - ed.mid[0]*sh + ed.mid[1]*ch;
          if(this.world.lakeAt(mx, mz)){
            const wh = this.world.waveHeight(mx, mz, this.time);
            m.position.set(t.x, 0.25 + wh + 0.02, t.z);
            m.rotation.y = t.heading;
            m.material.opacity = 0.85;
          } else {
            m.position.set(0, -999, 0);
            m.material.opacity = 0;
          }
        }
        // Spawn foam particles from visible edges
        if(!t._foamParticles) t._foamParticles = [];
        if(t._foamParticles.length < 30 && Math.random() < 0.3){
          const visible = edges.filter((_,i)=> {
            const m = t._foamMeshes[i];
            return m.position.y > -900;
          });
          if(visible.length){
            const ed = visible[Math.floor(Math.random()*visible.length)];
            const mx = t.x + ed.mid[0]*ch + ed.mid[1]*sh;
            const mz = t.z - ed.mid[0]*sh + ed.mid[1]*ch;
            let tooClose = false;
            for(const p of t._foamParticles){
              if(Math.hypot(mx-p.x, mz-p.z) < 0.6){ tooClose = true; break; }
            }
            if(!tooClose){
              if(!this._partGeo) this._partGeo = new THREE.PlaneGeometry(0.9, 0.15);
              const pm = new THREE.Mesh(this._partGeo, new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide,
              }));
              pm.renderOrder = 5;
              pm.position.set(mx, 0.27, mz);
              pm.rotation.x = -Math.PI/2;
              const perpAngle = Math.atan2(-ed.ox, -ed.oz) + (Math.random() - 0.5) * 0.35;
              pm.rotation.y = perpAngle;
              this.scene.add(pm);
              const maxLife = 0.8 + Math.random() * 1.0;
              t._foamParticles.push({
                mesh: pm, x: mx, z: mz,
                dx: ed.ox, dz: ed.oz,
                speed: 0.5 + Math.random() * 1.0,
                life: maxLife, maxLife,
              });
            }
          }
        }
        // Update particles
        for(let i = t._foamParticles.length-1; i>=0; i--){
          const p = t._foamParticles[i];
          p.x += p.dx * p.speed * dt;
          p.z += p.dz * p.speed * dt;
          p.speed *= 0.97;
          p.life -= dt;
          if(p.life <= 0){
            this.scene.remove(p.mesh);
            p.mesh.material.dispose();
            t._foamParticles.splice(i,1);
          } else {
            p.mesh.position.set(p.x, 0.27, p.z);
            p.mesh.material.opacity = p.life / p.maxLife;
          }
        }
      } else {
        this._cleanupFoam(t);
      }
    }
  }
  _cleanupFoam(t){
    if(t._foamMeshes){
      t._foamMeshes.forEach(m=>{ this.scene.remove(m); m.material.dispose(); m.geometry.dispose(); });
      t._foamMeshes = null;
    }
    if(t._foamParticles){
      t._foamParticles.forEach(p=>{ this.scene.remove(p.mesh); p.mesh.material.dispose(); });
      t._foamParticles = null;
    }
  }

  _mouseWorldAngle(){
    if(!this.localTank) return 0;
    const ray = new THREE.Raycaster();
    const v = new THREE.Vector2(this.input.mouse.ndcX, this.input.mouse.ndcY);
    ray.setFromCamera(v, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0,1,0), -(this.localTank.def.body.h+0.5));
    const hit = new THREE.Vector3();
    if(!ray.ray.intersectPlane(plane, hit)) return this.localTank.turretAngle;
    return Math.atan2(hit.x - this.localTank.x, hit.z - this.localTank.z);
  }

  /* ===========================================================
     SUPERS
     =========================================================== */
  _groundPoint(ndcX, ndcY){
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, hit) ? hit : null;
  }

  _makeGroundRing(x, z, r, color, opacity){
    const grp = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r - 0.18, r + 0.18, 48),
      new THREE.MeshBasicMaterial({ color, transparent:true, opacity: opacity || 0.8, side:THREE.DoubleSide, depthWrite:false })
    );
    ring.rotation.x = -Math.PI/2;
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(r * 0.92, 48),
      new THREE.MeshBasicMaterial({ color, transparent:true, opacity: 0.22, depthWrite:false })
    );
    fill.rotation.x = -Math.PI/2;
    fill.position.y = 0.02;
    grp.add(ring);
    grp.add(fill);
    grp.position.set(x, 0.04, z);
    this.scene.add(grp);
    return grp;
  }

  _updateSupers(dt){
    const t = this.localTank;
    if(!t || !t.hasSuper()) return;
    const d = t.def;
    const st = t.superState;
    if(st === 'targeting' && this._lastSuperState !== 'targeting'){
      this._superMousePrev = this.input.mouse.down;
    }
    this._lastSuperState = st;

    // --- Airstrike: waiting for ground selection ---
    if(st === 'targeting'){
      if((this.input.keys['Escape'] || this.input.keys['ContextMenu']) && !this._superEscPrev){
        this._superEscPrev = true;
        t.cancelSuper();
      } else if(!this.input.keys['Escape'] && !this.input.keys['ContextMenu']){
        this._superEscPrev = false;
      }
      let picked = null;
      const click = this.input.consumePressed('fire') || (this.input.mouse.down && !this._superMousePrev);
      this._superMousePrev = this.input.mouse.down;
      const tap = this.input.consumeTap();
      if(tap){ picked = this._groundPoint(tap.ndcX, tap.ndcY); }
      else if(click){ picked = this._groundPoint(this.input.mouse.ndcX, this.input.mouse.ndcY); }
      if(picked){
        const r = d.airstrikeRadius || 4;
        t.superTarget = { x: picked.x, z: picked.z };
        t.superState = 'strike';
        t.superTimer = d.airstrikeDelay || 3;
        t.superCdLeft = t.superCdTotal;
        if(t._strikeRing) this.scene.remove(t._strikeRing);
        t._strikeRing = this._makeGroundRing(picked.x, picked.z, r, 0xffffff, 0.9);
        this._superWarned = false;
      }
    } else if(st === 'strike'){
      t.superTimer -= dt;
      const total = d.airstrikeDelay || 3;
      const remain = t.superTimer;
      if(t._strikeRing){
        const ring = t._strikeRing;
        if(remain <= 1 && !this._superWarned){
          this._superWarned = true;
          ring.children.forEach(c => {
            if(c.material){ c.material.color.set(0xff4422); c.material.opacity = c.material.opacity > 0.5 ? 0.85 : 0.25; }
          });
        }
        ring.scale.setScalar(1.15 - 0.15 * (remain / total));
      }
      if(t.superTimer <= 0){
        if(t._strikeRing){ this.scene.remove(t._strikeRing); t._strikeRing = null; }
        this._dropStrikeBombs(t);
        t.superState = 'done';
        t.superTimer = 0;
      }
    }

    // --- Sturmratte: panzer drop marker ---
    else if(st === 'panzer_drop'){
      t.superTimer -= dt;
      if(!this._panzerRing){
        this._panzerRing = [];
        for(const side of [-1, 1]){
          const a = t.heading + Math.PI/2 * side;
          const ox = Math.sin(a) * 3.2, oz = Math.cos(a) * 3.2;
          const ring = this._makeGroundRing(t.x + ox, t.z + oz, 1.6, 0x88ccff, 0.7);
          this._panzerRing.push({ mesh: ring, side });
        }
      } else {
        this._panzerRing.forEach(p => {
          const a = t.heading + Math.PI/2 * p.side;
          p.mesh.position.set(t.x + Math.sin(a) * 3.2, 0.04, t.z + Math.cos(a) * 3.2);
        });
      }
      if(t.superTimer <= 0){
        this._panzerRing.forEach(p => this.scene.remove(p.mesh));
        this._panzerRing = null;
        this._spawnPanzers(t);
        t.superState = 'done';
        t.superTimer = 0;
      }
    }

    // --- Helix: oil fill then burn ---
    else if(st === 'oil_fill'){
      t.superTimer -= dt;
      this._oilPuddleTimer = (this._oilPuddleTimer || 0) - dt;
      if(this._oilPuddleTimer <= 0){
        this._oilPuddleTimer = 0.12;
        this._spawnOilPuddle(t);
      }
      (this._oilPuddles || []).forEach(p => {
        if(p.cur < p.sc){
          p.cur = Math.min(p.sc, p.cur + p.sc * dt * 3);
          p.mesh.scale.setScalar(p.cur);
        }
      });
      if(t.superTimer <= 0){
        t.superState = 'oil_burn';
        t.superTimer = d.oilBurn || 1;
        this._oilBurnTimer = 0;
        (this._oilPuddles || []).forEach(p => {
          p.burning = true;
          if(p.mesh.material) p.mesh.material.dispose();
          p.mesh.material = new THREE.MeshBasicMaterial({ map: VFX.getTex('fire'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
          p.mesh.scale.setScalar(p.cur * 1.25);
        });
        this.spawnExplosion(t.x, 0.4, t.z, 0xff6600, 6, 'burn');
        this.spawnBurst(t.x, 0.4, t.z, {count: 12, tex: 'ember', speed: 8, size: 0.3, life: 0.5, rise: 4, gravity: 7, blend: 'add'});
      }
    }
    else if(st === 'oil_burn'){
      t.superTimer -= dt;
      this._oilBurnTimer = (this._oilBurnTimer || 0) - dt;
      (this._oilPuddles || []).forEach(p => {
        const fl = 0.7 + 0.3 * Math.sin(this.time * 30 + p.phase) * Math.sin(this.time * 11 + p.phase * 2);
        p.mesh.scale.setScalar(p.cur * 1.25 * fl);
        if(p.mesh.material) p.mesh.material.opacity = 0.75 + 0.25 * Math.sin(this.time * 23 + p.phase);
      });
      if(this._oilBurnTimer <= 0){
        this._oilBurnTimer = d.oilTick || 0.25;
        for(const o of this.tanks){
          if(!o.alive || o === t || o.allyId === t.id || t.allyId === o.id) continue;
          for(const p of (this._oilPuddles || [])){
            const pr = p.cur * 1.15;
            const ddx = o.x - p.x, ddz = o.z - p.z;
            if(ddx*ddx + ddz*ddz < pr*pr){
              o.takeDamage(d.oilDamage || 4, t, this);
              this.spawnDamageLabel(o.x, o.def.turret.h + o.def.body.h + 3.6, o.z, d.oilDamage || 4);
              break;
            }
          }
        }
      }
      if(t.superTimer <= 0){
        (this._oilPuddles || []).forEach(p => {
          this.scene.remove(p.mesh);
          if(p.mesh.material) p.mesh.material.dispose();
          p.mesh.geometry.dispose();
        });
        this._oilPuddles = [];
        t.superState = 'done';
        t.superTimer = 0;
      }
    }

    // --- Update falling strike bombs ---
    if(this._strikeBombs && this._strikeBombs.length){
      this._strikeBombs.forEach(b => {
        b.y -= (b.fallSpeed || 60) * dt;
        b.mesh.position.set(b.x, b.y, b.z);
        b.mesh.rotation.x += 3 * dt;
        b.mesh.rotation.z += 2 * dt;
        if(b.y <= 0.5 && !b.hit){
          b.hit = true;
          this.spawnExplosion(b.x, 1.2, b.z, 0xffaa33, 10);
          const rad = b.radius, dmg = b.damage;
          for(const o of this.tanks){
            if(!o.alive || o === b.owner) continue;
            const ddx = o.x - b.x, ddz = o.z - b.z;
            if(ddx*ddx + ddz*ddz < rad*rad){
              o.takeDamage(dmg, b.owner, this);
              this.spawnDamageLabel(o.x, o.def.turret.h + o.def.body.h + 3.6, o.z, dmg);
            }
          }
        }
      });
      this._strikeBombs = this._strikeBombs.filter(b => {
        if(b.hit && b.y <= -2){
          this.scene.remove(b.mesh);
          b.mesh.geometry.dispose();
          b.mesh.material.dispose();
          return false;
        }
        return true;
      });
    }
  }

  _dropStrikeBombs(t){
    const d = t.def;
    const cx = t.superTarget.x, cz = t.superTarget.z;
    const r = d.airstrikeRadius || 4;
    if(!this._strikeBombs) this._strikeBombs = [];
    for(let i = 0; i < (d.airstrikeBombs || 3); i++){
      const a = Math.random() * Math.PI * 2;
      const off = Math.random() * r * 0.7;
      const geo = new THREE.SphereGeometry(0.28, 10, 10);
      const mat = new THREE.MeshStandardMaterial({ color: 0x333338, roughness: 0.6, metalness: 0.4 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      const x = cx + Math.cos(a) * off, z = cz + Math.sin(a) * off;
      const y = 46 + Math.random() * 4;
      mesh.position.set(x, y, z);
      this.scene.add(mesh);
      this._strikeBombs.push({ mesh, x, z, y, hit:false, owner:t, radius:r, damage:d.airstrikeDamage || 60, fallSpeed: 55 + Math.random()*15 });
    }
  }

  _deployBush(t){
    const d = t.def;
    const max = d.bushMax || 3;
    while(t.myBushes.length >= max){
      const oldest = t.myBushes.shift();
      this.world.removePlayerBush(oldest);
    }
    const a = Math.random() * Math.PI * 2;
    const entry = this.world.addPlayerBush(t.x + Math.cos(a) * 1.2, t.z + Math.sin(a) * 1.2);
    t.myBushes.push(entry);
    this.spawnExplosion(t.x, 0.5, t.z, 0x55aa55, 4, 'bush');
    this.spawnBurst(t.x, 0.5, t.z, {count: 6, tex: 'shard', color: 0x55aa55, speed: 4, size: 0.4, life: 0.5, rise: 2, gravity: 8, blend: 'normal', spin: 8});
  }

  _spawnPanzers(t){
    for(const side of [-1, 1]){
      const a = t.heading + Math.PI/2 * side;
      const ox = Math.sin(a) * 3.2, oz = Math.cos(a) * 3.2;
      const def = TANKS.panzer;
      const p = new Tank(def, {
        id:'panzer-' + t.id + '-' + side + '-' + Math.random().toString(36).slice(2,6),
        name: side < 0 ? 'Panzer 1' : 'Panzer 2',
        x: t.x + ox, z: t.z + oz,
        heading: t.heading,
        physicsWorld: this.physicsWorld,
      });
      p.allyId = t.id;
      p.isPanzer = true;
      p.brain = new PanzerBrain(p, t);
      this._finalizeTank(p);
      this.tanks.push(p);
      this.spawnExplosion(p.x, 0.6, p.z, 0x8899aa, 6, 'drop');
    }
  }

  _spawnOilPuddle(t){
    if(!this._oilPuddles) this._oilPuddles = [];
    const rearA = t.heading + Math.PI;
    const off = 1.6 + Math.random() * 1.4;
    const x = t.x + Math.sin(rearA) * off + (Math.random() - 0.5) * 0.9;
    const z = t.z + Math.cos(rearA) * off + (Math.random() - 0.5) * 0.9;
    const sc = 1.1 + Math.random() * 1.1;
    const geo = new THREE.PlaneGeometry(2.2, 2.2);
    const mat = new THREE.MeshBasicMaterial({ map: VFX.getTex('oil'), transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI/2;
    mesh.rotation.z = Math.random() * Math.PI;
    mesh.scale.setScalar(0.3);
    mesh.position.set(x, 0.07, z);
    this.scene.add(mesh);
    this._oilPuddles.push({ mesh, x, z, sc, cur: 0.3, phase: Math.random() * 6.28, burning: false });
    if(this._oilPuddles.length > 30){
      const old = this._oilPuddles.shift();
      this.scene.remove(old.mesh);
      old.mesh.geometry.dispose();
      if(old.mesh.material) old.mesh.material.dispose();
    }
  }

  _updateSuperSlot(){
    const wrap = document.getElementById('super-wrap');
    const btn = document.getElementById('super-btn');
    const hint = document.getElementById('super-hint');
    const t = this.localTank;
    if(!wrap || !btn) return;
    const has = !!(t && t.hasSuper());
    wrap.classList.toggle('hidden', !has);
    if(!has || !t) return;
    if(!btn._wired){
      btn._wired = true;
      btn.onclick = () => { Audio && Audio.click && Audio.click(); if(this.localTank) this.localTank.activateSuper(); };
    }
    const info = t.superInfo();
    const icons = { airstrike:'✈', cloak:'👻', bush:'🌿', panzers:'⚙', oil:'🔥' };
    btn.querySelector('.super-icon').textContent = icons[info.type] || '★';
    const label = btn.querySelector('.super-label');
    const frac = info.cdTotal > 0 ? Math.min(1, info.cd / info.cdTotal) : 0;
    btn.style.setProperty('--cd', frac.toFixed(3));
    btn.classList.toggle('ready', info.ready && !info.state);
    btn.classList.toggle('active', !!info.state);
    if(info.state === 'targeting'){
      label.textContent = 'TARGET';
    } else if(info.state && info.timer > 0){
      label.textContent = Math.ceil(info.timer) + 's';
    } else if(info.ready){
      label.textContent = 'READY';
    } else {
      label.textContent = Math.ceil(info.cd) + 's';
    }
    if(hint){
      if(info.state === 'targeting'){
        hint.classList.remove('hidden');
        hint.textContent = 'Click / tap the ground to pick the strike point  (F / right-click to cancel)';
      } else {
        hint.classList.add('hidden');
      }
    }
  }

  /* ===========================================================
     COMBAT HOOKS
     =========================================================== */
  ejectShell(tank){
    // World position of the model's casing port (tracks turret rotation).
    // Uses the cached bind-pose offset so a firing/casing animation on the
    // model's "shell" node can't throw the ejection around.
    tank.root.updateMatrixWorld(true);
    const p = tank.casingPos ? tank.casingPos() : new THREE.Vector3();
    let fallbackPos = false;
    if(!p.lengthSq && !tank.casingPos){
      const m = tank.muzzle();
      p.copy(m.pos);
      fallbackPos = true;
    }
    // Eject backwards/off-axis of the barrel, upward, plus a little of the
    // tank's own ground speed so it trails naturally.
    const a = tank.turretAngle + Math.PI + (Math.random() < 0.5 ? 1 : -1) * (Math.PI/2 + (Math.random()*0.4 - 0.2));
    const gv = tank.getWorldVelocity() || {x:0, z:0};
    const spd = 5 + Math.random() * 3;
    const vel = {
      x: Math.sin(a) * spd * 0.6 + gv.x * 0.35,
      y: 5 + Math.random() * 2.5,
      z: Math.cos(a) * spd * 0.6 + gv.z * 0.35,
    };
    if(fallbackPos) vel.y += 0.5;
    // Cap concurrent casings: keep the scene and physics cheap under rapid fire.
    if(this.casings.length >= 18){
      const oldest = this.casings.shift();
      if(oldest) oldest.detach();
    }
    const casing = new ShellCasing(p, vel, this.physicsWorld);
    casing.attach(this.scene);
    this.casings.push(casing);
  }

  spawnShot(tank){
    const {pos, dir} = tank.muzzle();
    const y = pos.y;
    // Gunshot sound: full volume from the local tank, quieter from others.
    // Helix flamethrower gets a whoosh instead of the AK-style gunshot.
    if(window.Audio && Audio.click){
      const vol = tank === this.localTank ? 1 : 0.45;
      if(tank.def.shellType === 'flame'){ if(Audio.flame) Audio.flame(vol); }
      else Audio.click('gun', vol);
    }
    // Fancy-only: light recoil kick when the player's own tank fires
    if(this.isFancy && tank === this.localTank) this.addShake(0.12);
    // In client/freeroam mode, host sends projectiles via snapshots
    if(this.mode !== 'client' && this.mode !== 'freeroam'){
      const p = tank.def.shellType==='flame'
        ? new FlameCone(tank, new THREE.Vector3(pos.x, y, pos.z), dir, tank.def)
        : new Shell(tank, new THREE.Vector3(pos.x, y, pos.z), dir, tank.def, this.physicsWorld, tank.getWorldVelocity());
      p.attach(this.scene); this.projectiles.push(p);
      // Spawn bullet trail for shell projectiles
      if(tank.def.shellType !== 'flame'){
        p._trail = this.trailManager.spawn(
          new THREE.Vector3(pos.x, y, pos.z)
        );
      }
    }
    if(tank.def.shellType === 'flame') this._ensureHelixVideo(tank);
    if(tank===this.localTank){
      this._muzzleFlash(pos, dir);
    } else {
      this._muzzleFlashFaint(pos, dir);
    }
  }

  _ensureHelixVideo(tank){
    if(this._helixVideos.has(tank.id)) return;
    const el = document.createElement('video');
    el.src = 'assets/helix/fire.mp4';
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.playbackRate = 5; el.play().catch(() => {});
    const tex = new THREE.VideoTexture(el);
    tex.center.set(0.5, 0.5);
    tex.rotation = Math.PI / 2;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.x = -1;
    tex.offset.x = 1;
    const range = tank.def.shellRange || 22;
    const tanHalf = tank.def.fireConeHalfAngle || 0.12;
    const halfW = range * tanHalf;
    const w = halfW * 2;
    const h = range;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.translate(0, h / 2, 0);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.75, blending: THREE.NormalBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    mat.onBeforeCompile = s => { s.fragmentShader = s.fragmentShader.replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', 'float _lum=dot(outgoingLight,vec3(0.299,0.587,0.114));if(_lum<0.06)discard;gl_FragColor=vec4(outgoingLight,diffuseColor.a);'); };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.set(-Math.PI / 2, 0, Math.PI);
    if(tank.barrelEnd) { mesh.position.copy(tank.barrelEnd.position); mesh.position.x += 0.35; }
    tank.turretGroup.add(mesh);
    this._helixVideos.set(tank.id, { mesh, tex, el, parent: tank.turretGroup, firing: true, fadeTimer: 0 });
  }

  _muzzleFlash(pos, dir){
    if(this.settings && this.settings.muzzleFx === false) return;
    if(!this._muzzleFlashes) this._muzzleFlashes = [];
    const K = this.isFancy ? 1.15 : 0.9;

    // Starburst "bark" flash right at the barrel tip (layered for depth)
    for(let i=0; i<3; i++){
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('starsoft'), color:new THREE.Color(0xfff6d8), transparent:true, opacity:1, blending:THREE.AdditiveBlending, depthWrite:false}));
      const sc = (1.5 - i*0.28) * K;
      flash.position.set(pos.x, pos.y + 0.15, pos.z);
      flash.scale.set(sc, sc, 1);
      this.scene.add(flash);
      const life = 0.1 - i*0.02;
      this._muzzleFlashes.push({sprite:flash, life:life, maxLife:life, baseScale:sc});
    }

    // Directional "kick" sparks pushed along the barrel (meaty, visible)
    const dirX = dir ? (dir.x || 0) : 0;
    const dirZ = dir ? (dir.z || 0) : 0;
    const naf = this.isFancy ? 16 : 11;
    for(let i=0; i<naf; i++){
      const a = Math.atan2(dirZ, dirX) + (Math.random() - 0.5) * 1.4;
      const spd = (10 + Math.random() * 7) * K;
      const sc = (0.3 + Math.random() * 0.28) * K;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex(i%3===0?'ember':'spark'), transparent:true, opacity:0.95, blending:THREE.AdditiveBlending, depthWrite:false}));
      s.position.set(pos.x, pos.y + 0.12, pos.z);
      s.scale.set(sc, sc, 1);
      this.scene.add(s);
      const life = 0.18 + Math.random() * 0.12;
      this._muzzleFlashes.push({
        sprite:s, life:life, maxLife:life,
        vx: Math.cos(a) * spd, vz: Math.sin(a) * spd,
        vy: 0.2 + Math.random() * 0.5, baseScale: sc
      });
    }

    // Fancy extras: pooled light + a puff of propellant smoke
    if(this.isFancy){
      this._muzzleLight(pos.x, pos.y + 0.2, pos.z);
      const tex = VFX.getTex('smoke');
      for(let i=0; i<5; i++){
        const s = new THREE.Sprite(new THREE.SpriteMaterial({map:tex, transparent:true, depthTest:false, depthWrite:false, opacity:0.4}));
        const sc = 0.5 + Math.random() * 0.4;
        s.position.set(pos.x, pos.y + 0.1 + Math.random() * 0.2, pos.z);
        s.scale.set(sc, sc, 1);
        this.scene.add(s);
        if(!this._muzzleSmokes) this._muzzleSmokes = [];
        const travelSpeed = 2.0 + Math.random() * 1.5;
        this._muzzleSmokes.push({
          sprite:s, life:0.5 + Math.random() * 0.4, maxLife:0.9,
          vx: dirX * travelSpeed + (Math.random() - 0.5) * 0.6,
          vz: dirZ * travelSpeed + (Math.random() - 0.5) * 0.6,
          vy: 0.8 + Math.random() * 0.8,
          baseScale: sc
        });
      }
    }
  }

  /* Smaller, cheaper muzzle flash for bots/remote shots. */
  _muzzleFlashFaint(pos, dir){
    if(this.settings && this.settings.muzzleFx === false) return;
    if(!this._muzzleFlashes) this._muzzleFlashes = [];
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('starsoft'), color:new THREE.Color(0xfff0c0), transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, depthWrite:false}));
    const sc = 1.0;
    flash.position.set(pos.x, pos.y + 0.15, pos.z);
    flash.scale.set(sc, sc, 1);
    this.scene.add(flash);
    const life = 0.07;
    this._muzzleFlashes.push({sprite:flash, life:life, maxLife:life, baseScale:sc});

    const dirX = dir ? (dir.x || 0) : 0;
    const dirZ = dir ? (dir.z || 0) : 0;
    for(let i=0; i<6; i++){
      const a = Math.atan2(dirZ, dirX) + (Math.random() - 0.5) * 1.6;
      const spd = 8 + Math.random() * 5;
      const ss = 0.24 + Math.random() * 0.16;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('spark'), transparent:true, opacity:0.8, blending:THREE.AdditiveBlending, depthWrite:false}));
      s.position.set(pos.x, pos.y + 0.1, pos.z);
      s.scale.set(ss, ss, 1);
      this.scene.add(s);
      const slife = 0.12 + Math.random() * 0.08;
      this._muzzleFlashes.push({
        sprite:s, life:slife, maxLife:slife,
        vx: Math.cos(a) * spd, vz: Math.sin(a) * spd,
        vy: 0.2 + Math.random() * 0.4, baseScale: ss
      });
    }
  }

spawnExplosion(x, y, z, color, count, style){
    const e = new Explosion(x, y, z, color, count, style);
    e.attach(this.scene); this.explosions.push(e);
  }
  /* Directional tank hit: soft star "pop", hot streak sparks pushed along the
     shell direction, tiny debris, light dust kick — reads as a fast "ding". */
  spawnHitVfx(x, y, z, dirX, dirZ, color, opts){
    if(!this.spawnBurst) return;
    const o = opts || {};
    const px = x || 0, pz = z || 0;
    const dir = (dirX && dirZ) ? [dirX, dirZ] : null;
    // 1) soft starburst pop
    this.spawnBurst(px, y + 0.35, pz, {
      count: o.flashCount || 1, tex: 'starsoft', color: color || 0xfff2d0,
      speed: 0.4, size: o.flashSize || 1.7, life: o.flashLife || 0.18,
      rise: 0.6, gravity: 0, blend: 'add', spin: 0, grow: 1.5, fade: 0.9,
    });
    // 2) hot directional streaks along the shell travel
    this.spawnBurst(px, y + 0.18, pz, {
      count: o.sparkCount != null ? o.sparkCount : 10, tex: ['spark','ember'],
      speed: o.sparkSpeed != null ? o.sparkSpeed : 11, size: o.sparkSize || 0.4,
      life: o.sparkLife || 0.34, rise: 1.6, gravity: o.sparkGravity != null ? o.sparkGravity : 16,
      biasX: dir ? dir[0] : 0, biasZ: dir ? dir[1] : 0, spread: o.spread != null ? o.spread : 0.7,
      blend: 'add', spin: 10,
    });
    // 3) tiny debris
    this.spawnBurst(px, y + 0.08, pz, {
      count: o.debrisCount || 3, tex: ['shard','hex'], color: color || 0xc8b898,
      speed: o.debrisSpeed || 5, size: o.debrisSize || 0.5, life: o.debrisLife || 0.5,
      rise: 1.6, gravity: 12, biasX: dir ? dir[0] : 0, biasZ: dir ? dir[1] : 0,
      spread: 1.0, blend: 'normal', spin: 7,
    });
    // 4) light dust kick
    this.spawnBurst(px, y + 0.04, pz, {
      count: o.dustCount != null ? o.dustCount : 4, tex: 'dust',
      speed: 3.2, size: 0.9, life: 0.5, rise: 1.0, gravity: 5, blend: 'normal', fade: 0.7,
    });
  }

  /* Pooled muzzle light — reused between shots, capped at 6 active */
  _muzzleLight(x, y, z){
    if(!this._muzzleLights) this._muzzleLights = [];
    let l = this._muzzleLights.find(v => !v.active);
    if(!l){
      if(this._muzzleLights.length >= 6) return null;
      const pl = new THREE.PointLight(0xffc07a, 0, 12, 2);
      this.scene.add(pl);
      l = {light: pl, active: false, life: 0, maxLife: 0.1};
      this._muzzleLights.push(l);
    }
    l.active = true;
    l.life = l.maxLife = 0.1;
    l.light.position.set(x, y, z);
    l.light.intensity = 26;
    return l;
  }

  /* Lightweight sprite bursts — fire/smoke/spark particles, fancy only.
     opts.tex can be a string or an array (randomly picked per particle).
     opts.spin sets per-particle angular velocity, opts.stretchX scales x. */
  spawnBurst(x, y, z, opts){
    if(!this._bursts) this._bursts = [];
    const o = opts || {};
    const count = o.count || 12;
    const texName = Array.isArray(o.tex) ? o.tex[(Math.random()*o.tex.length)|0] : (o.tex || 'flare');
    const tex = VFX.getTex(texName);
    const additive = o.blend !== 'normal';
    const tint = (o.color != null) ? new THREE.Color(o.color) : null;
    for(let i = 0; i < count; i++){
      const sm = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 1,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: false
      });
      if(tint) sm.color = tint;
      const s = new THREE.Sprite(sm);
      const a = Math.random() * Math.PI * 2;
      const sp = (o.speed || 8) * (0.5 + Math.random() * 0.8);
      let vx, vz;
      if(o.biasX !== undefined && o.biasZ !== undefined){
        // Directional cone: roughly along (biasX,biasZ) with a spread in radians
        const spread = (o.spread != null ? o.spread : 0.6);
        const dirAng = Math.atan2(o.biasZ, o.biasX) + (Math.random() - 0.5) * spread * 2;
        vx = Math.cos(dirAng) * sp;
        vz = Math.sin(dirAng) * sp;
      } else {
        vx = Math.cos(a) * sp;
        vz = Math.sin(a) * sp;
      }
      s.position.set(x, y + 0.2, z);
      const sc = (o.size || 1.2) * (0.6 + Math.random() * 0.8);
      const stretchX = (o.stretchX != null) ? (0.5 + Math.random() * 1.2) : 1;
      s.scale.set(sc * stretchX, sc, 1);
      const spin = (o.spin != null) ? o.spin * (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random()) : 0;
      if(spin) s.rotation.z = Math.random() * Math.PI * 2;
      this.scene.add(s);
      this._bursts.push({
        sprite: s,
        life: (o.life || 0.6) * (0.6 + Math.random() * 0.8),
        maxLife: o.life || 0.6,
        vx: vx,
        vz: vz,
        vy: (o.rise || 3) * (0.4 + Math.random() * 0.6) + Math.random() * 2,
        gravity: (o.gravity != null ? o.gravity : 9),
        baseScale: sc,
        grow: (o.grow != null ? o.grow : 1.5),
        fade: (o.fade != null ? o.fade : 1),
        spin: spin
      });
    }
  }

  /* Light directional damage hit on a tank — star pop + sparks kicked back
     along the shell direction + small debris. Cheaper than the kill bloom. */
  _tankHitVfx(tank, dx, dz, color){
    if(!tank) return;
    const y1 = tank.y != null ? tank.y : 1.4;
    let px = 0, pz = 0;
    if(dx && dz && (dx !== 0 || dz !== 0)){
      const len = Math.max(0.0001, Math.hypot(dx, dz));
      px = -dx / len; pz = -dz / len;
    }
    this.spawnExplosion(tank.x, y1, tank.z, color || 0xffaa40, 3, 'boom');
    this.spawnHitVfx(tank.x, y1, tank.z, px, pz, color);
  }

  /* Destruction VFX — white-hot pop, shockwave, sparks, debris, smoke column */
  _killVfx(tank){
    const y1 = tank.y != null ? tank.y : 1.4;
    // Rocket layer: bright pop + dense fireworks (always visible)
    this.spawnExplosion(tank.x, y1, tank.z, 0xfff2d0, 8, 'boom');
    this.spawnBurst(tank.x, y1 + 0.3, tank.z, {count: 18, tex: ['spark','ember'], speed: 18, size: 0.55, life: 0.6, rise: 2.5, gravity: 16, blend: 'add', spin: 9});
    this.spawnBurst(tank.x, y1 + 0.15, tank.z, {count: 10, tex: ['shard','hex'], speed: 6.5, size: 0.85, life: 0.8, rise: 3, gravity: 9, spin: 6});
    // Flower layer: heavy smolder bloom (fancy only)
    if(this.isFancy){
      const st = EXPLOSION_STYLES.lrg;
      this.spawnBurst(tank.x, y1, tank.z, {count: Math.round(st.fire * 8), tex: 'blobfire', color: 0xff8a2a, speed: 10, size: 1.5, life: 0.9, rise: 5, gravity: -1.5, blend: 'add', spin: 0.8});
      this.spawnBurst(tank.x, y1 - 0.2, tank.z, {count: Math.round(st.smokeCol * 6), tex: 'smoke', speed: 1.6, size: 3.0, life: 1.6, rise: 2.4, grow: 2.6, blend: 'normal', fade: 0.45});
      this.spawnBurst(tank.x, y1 - 0.2, tank.z, {count: 1, tex: 'ring', speed: 0, size: 2.2, life: 0.5, rise: 0, grow: 4.2, blend: 'add', spin: 0});
    }
    if(this.localTank){
      const d = Math.hypot(this.localTank.x - tank.x, this.localTank.z - tank.z);
      if(d < 60) this.addShake(1.2 * (1 - d / 60));
    }
  }

  _gladAwardClanXP(){
    const g = this.glad;
    if(!g || g._client || g.xpAwarded || this.mode !== 'sp' || !this.localTank) return;
    g.xpAwarded = true;
    const pl = (g.winner === this.localTank) ? 1 : (this.localTank.placement || 0);
    const xp = (typeof CLAN_GLAD_XP !== 'undefined' && CLAN_GLAD_XP[pl]) ? CLAN_GLAD_XP[pl] : 0;
    if(!xp) return;
    addClanXP(xp);
    Menu.toast('+' + xp + ' Clan XP (#' + pl + ' place)');
    if(pl === 1){
      const s = Menu.settings;
      s.clanWeekWins = (s.clanWeekWins || 0) + 1;
      saveSettings(s);
      if(!s.clanWeekWinsBonus && s.clanWeekWins >= (typeof CLAN_WIN_BONUS_COUNT !== 'undefined' ? CLAN_WIN_BONUS_COUNT : 10)){
        s.clanWeekWinsBonus = true;
        saveSettings(s);
        addClanXP(typeof CLAN_WIN_BONUS_XP !== 'undefined' ? CLAN_WIN_BONUS_XP : 2000);
        Menu.toast('10 wins this week! +2000 Clan XP bonus');
      }
    }
  }

  onTankKilled(tank, byTank){
    this._killVfx(tank);
    if(this.glad && !tank.isDummy){
      const g = this.glad;
      const aliveNow = this.tanks.filter(t => t.alive && !t.dying && !t.isDummy).length;
      tank.placement = aliveNow + 1;
      if(byTank && byTank.alive && !byTank.dying && !byTank.isDummy){
        byTank.applyPower(g.cfg.power.kill, this);
        if(byTank === this.localTank) Menu.toast('Kill! +' + g.cfg.power.kill + ' power');
      }
      if(tank === this.localTank && !g.ended){
        this._gladShowResult(true);
      }
      if(!g.ended && aliveNow === 1){
        g.winner = this.tanks.find(t => t.alive && !t.dying && !t.isDummy) || null;
        g.ended = true;
        this._gladAwardClanXP();
        this._gladShowResult(false);
      }
      this._killVfx(tank);
      return;
    }
    this._killVfx(tank);
    if(this.localTank){
      const d = Math.hypot(this.localTank.x-tank.x, this.localTank.z-tank.z);
      if(d < 45){
        this._shake = Math.max(this._shake, 0.9 * (1 - d/45));
      }
    }
    // Kill rewards for the local player
    if(byTank && byTank === this.localTank){
      const s = Menu.settings;
      const roll = Math.random();
      s.cash = (s.cash || 0) + 8;
      s.coins = (s.coins || 0) + 2;
      if(roll < 0.10){ s.cash += 4; s.coins += 1; }   // 10% for +5 (into cash+coins)
      else if(roll < 0.15){ s.cash += 13; s.coins += 2; } // 5% for +15 (into cash+coins)
      if(roll < 0.01) s.gems = (s.gems || 0) + 1; // 1% for 1 gem

      saveSettings(s);
      Menu.toast('+8 cash, +2 coins' + (roll < 0.15 ? ' (+bonus!)' : '') + (roll < 0.01 ? ' +1 gem!' : ''));
    }
  }

  onLocalDeath(){
    if(this.glad){
      // Eliminated — no longer controllable: take the touch controls away
      if(this.input && this.input.setJoysticksVisible) this.input.setJoysticksVisible(false);
      if(Menu && Menu.hideTouchControls) Menu.hideTouchControls();
      this._gladShowResult(true);
      Menu.toast('Eliminated! You placed #' + (this.localTank ? (this.localTank.placement || '?') : '?'));
      return;
    }
    Menu.toast('Your tank was destroyed');
    // Enter spectator mode instead of leaving the match (WoT-style)
    this._startSpectate();
  }

  addShake(amount){ this._shake = Math.max(this._shake, amount); }

  /* ---------- Visibility ---------- */
  _updateVisibility(){
    const me = (this.spectate && this.spectateTarget && this.spectateTarget.alive)
      ? this.spectateTarget
      : this.localTank;
    if(!me) return;
    for(const t of this.tanks){
      if(t === me){ t.root.visible = true; continue; }
      if(t.dying){ t.root.visible = true; continue; }
      const d = Math.hypot(t.x-me.x, t.z-me.z);
      let visible;
      if(d < 18) visible = true;
      else if(d <= me.viewRange) visible = (t.camoFactor >= 0.5);
      else visible = false;
      t.root.visible = visible;
    }
  }

  /* ===========================================================
     HUD
     =========================================================== */
  _updateHUD(){
    if(!this.localTank) return;
    // While spectating, show the watched tank's live stats instead of the dead local one
    const t = (this.spectate && this.spectateTarget && this.spectateTarget.alive) ? this.spectateTarget : this.localTank;
    // FPS counter (updates ~4x per second)
    const fpsEl = document.getElementById('fps-counter');
    if(fpsEl){
      const show = this.settings && this.settings.showFps;
      if(fpsEl._shown !== !!show){
        fpsEl._shown = !!show;
        fpsEl.classList.toggle('hidden', !show);
      }
      if(show){
        if(this._fpsAcc === undefined) this._fpsAcc = 0;
        if(this._fpsPrev === undefined) this._fpsPrev = performance.now();
        this._fpsAcc++;
        const now = performance.now();
        const fps = Math.round(1000 / Math.max(1, now - this._fpsPrev));
        this._fpsPrev = now;
        if(this._fpsAcc >= 8){
          this._fpsAcc = 0;
          if(fpsEl.textContent !== String(fps)) fpsEl.textContent = fps + ' FPS';
        }
      }
    }
    document.getElementById('speed-val').textContent = Math.max(0, Math.round(Math.abs(t.speed) * U_TO_KMH));
    const hpBar = document.getElementById('hp-bar');
    const pct = Math.max(0, t.hp/t.maxHp);
    hpBar.style.width = (pct*100)+'%';
    document.getElementById('hp-text').textContent = `${Math.ceil(t.hp)} / ${t.maxHp}`;
    
    const drownWrap = document.getElementById('drown-bar-wrap');
    const drownBar = document.getElementById('drown-bar');
    if(drownWrap && drownBar){
      if(t._drowning){
        drownWrap.classList.remove('hidden');
        drownBar.style.width = Math.min(100, (t._drownTimer / 10) * 100) + '%';
      } else {
        drownWrap.classList.add('hidden');
        drownBar.style.width = '0%';
      }
    }
    
    const dot = document.getElementById('camo-dot');
    const camoTxt = document.getElementById('camo-text');
    if(dot && camoTxt){
      if(t.camoState === 'bush'){
        dot.className = 'camo-dot on'; camoTxt.textContent = 'You are in bush';
      } else if(t.camoState === 'tree'){
        dot.className = 'camo-dot mid'; camoTxt.textContent = 'Partial cover';
      } else {
        dot.className = 'camo-dot off'; camoTxt.textContent = '';
      }
    }
    
    // Flamethrower heat bar (shown inside the reload indicator slot)
    const heatWrap = document.getElementById('heat-wrap');
    const heatBar = document.getElementById('heat-bar');
    const heatText = document.getElementById('heat-text');
    if(heatWrap && heatBar && heatText){
      heatWrap.classList.add('hidden');
    }

    // Reload indicator: vertical bar + % time left to reload (+ magazine pips).
    // Flame tanks get their heat bar drawn in this same slot instead.
    const ri = document.getElementById('reload-indicator');
    if(ri){
      const rctx = ri.getContext('2d');
      rctx.clearRect(0, 0, ri.width, ri.height);
      const w = ri.width, h = ri.height;
      const barW = 10, barH = h - 30;
      const bx = w/2 - barW/2, by = 14;
      const rr = (x, y, bw, bh, rad) => {
        rctx.beginPath();
        if(rctx.roundRect) rctx.roundRect(x, y, bw, bh, rad);
        else rctx.rect(x, y, bw, bh);
        rctx.fill();
      };
      if(t.def.shellType === 'flame'){
        const pct = Math.min(1, Math.max(0, t.heat / 1000));
        rctx.fillStyle = 'rgba(0,0,0,0.55)';
        rr(bx, by, barW, barH, 5);
        const fh = Math.max(2, barH * pct);
        const grad = rctx.createLinearGradient(0, by + barH, 0, by);
        grad.addColorStop(0, '#ffb12b');
        grad.addColorStop(1, pct > 0.75 ? '#ff3b30' : '#ff6a00');
        rctx.fillStyle = grad;
        rr(bx, by + barH - fh, barW, fh, 5);
        rctx.fillStyle = t.overheated ? '#ff3b30' : '#fff';
        rctx.font = 'bold 13px Segoe UI, sans-serif';
        rctx.textAlign = 'center';
        rctx.textBaseline = 'bottom';
        rctx.fillText(t.overheated ? 'HOT!' : Math.round(pct * 100) + '%', w/2, h - 2);
      } else {
      const info = t.reloadInfo ? t.reloadInfo() : null;
      if(info && info.active && info.total > 0){
        const pct = Math.min(1, Math.max(0, info.left / info.total));
        rctx.fillStyle = 'rgba(0,0,0,0.55)';
        rr(bx, by, barW, barH, 5);
        const loaded = 1 - pct;
        const fh = Math.max(2, barH * loaded);
        rctx.fillStyle = '#ffb12b';
        rr(bx, by + barH - fh, barW, fh, 5);
        rctx.fillStyle = '#fff';
        rctx.font = 'bold 13px Segoe UI, sans-serif';
        rctx.textAlign = 'center';
        rctx.textBaseline = 'bottom';
        rctx.fillText(Math.ceil(pct * 100) + '%', w/2, h - 2);
        if(info.magSize > 0){
          const n = info.magSize, m = Math.max(0, info.mag);
          const pw = 5, gap = 3, totalW = n * pw + (n - 1) * gap;
          for(let i = 0; i < n; i++){
            rctx.fillStyle = i < m ? '#ffb12b' : 'rgba(255,255,255,0.25)';
            rr(w/2 - totalW/2 + i * (pw + gap), 4, pw, pw, 2);
          }
        }
      }
      }
    }

    // Leaderboard: ALL tanks sorted by damage
    const sorted = [...this.tanks]
      .sort((a,b)=> b.damageDealt - a.damageDealt).slice(0,5);
    const lb = document.getElementById('lb-list');
    lb.innerHTML = sorted.map((o,i)=> `<li><span class="lname">${o.name}</span><span class="ldmg">${Math.round(o.damageDealt)}</span></li>`).join('');

    // GLADIATOR HUD: power counter, alive counter, zone/airdrop status
    if(this.glad){
      const pe = document.getElementById('glad-power');
      if(pe) pe.textContent = 'PWR ' + (this.localTank.power || 0) + ' (+' + Math.round((this.localTank.powerMult ? (this.localTank.powerMult() - 1) * 100 : 0)) + '%)';
      const le = document.getElementById('glad-left');
      if(le) le.textContent = 'Alive: ' + (this.glad.alive != null ? this.glad.alive : '-');
      const be = document.getElementById('glad-banner');
      if(be){
        const g = this.glad;
        let txt = '';
if(g.phase === 'grace') txt = 'Zone warning in ' + Math.ceil(g.phaseTimer) + 's';
        else {
          const b = this._gladSafeBounds();
          txt = b ? ('Safe zone ' + Math.max(Math.round(b.maxX - b.minX), Math.round(b.maxZ - b.minZ)) + 'm') : 'Zone closed!';
          const or = (this._gladZoneChunks || []).filter(c => c.state === 'orange').length;
          if(or > 0) txt += '  |  ' + or + ' orange chunk' + (or > 1 ? 's' : '');
        }
        if(g.airdrop){
          if(!g.airdrop.landed) txt += '  |  Airdrop in ' + Math.ceil(g.airdrop.countdown) + 's';
          else{
            const holdT = this.localTank._gladHoldTime || 0;
            if(holdT > 0) txt += '  |  Hold in circle ' + Math.max(0, Math.ceil(g.airdrop.hold - holdT)) + 's';
            else txt += '  |  Airdrop landed - stand in blue circle';
          }
        }
        be.textContent = txt;
        be.classList.remove('hidden');
      }
    }

    // In-game portrait warning
    const pw = document.getElementById('portrait-warning');
    if(pw){
      const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0 || window.navigator.standalone;
      const isPortrait = window.innerHeight > window.innerWidth;
      const orientPortrait = screen.orientation && screen.orientation.type && screen.orientation.type.startsWith('portrait');
      if(isMobile && (isPortrait || orientPortrait)){
        pw.classList.remove('hidden');
      } else {
        pw.classList.add('hidden');
      }
    }

    this._updateSuperSlot();
  }

  /* ---------- Big map ---------- */
  toggleBigMap(){
    const wrap = document.getElementById('bigmap');
    if(!wrap.classList.contains('hidden')){
      wrap.classList.add('hidden');
      this._bigMapLoop = 0;
      return;
    }
    const cv = document.getElementById('bigmap-canvas');
    const S = 720;
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d');

    // Cache the static map base (world + zones) once; the local tank icons and
    // trajectory redraw every frame so position/rotation stay live.
    if(!this._bigMapBase || this._bigMapBase.width !== S){
      this._bigMapBase = document.createElement('canvas');
      this._bigMapBase.width = this._bigMapBase.height = S;
    }
    const bctx = this._bigMapBase.getContext('2d');
    bctx.clearRect(0, 0, S, S);
    this.world.renderToCanvas(bctx, S, S);
    // GLADIATOR center marker on the big map base (zone/airdrop drawn live)
    if(this.glad){
      const g = this.glad;
      if(g.phase !== 'grace'){
        const [cx, cy] = this.world.worldToMap(0, 0, S);
        bctx.strokeStyle = '#ff3030';
        bctx.lineWidth = 8;
        const xr = 16;
        bctx.beginPath();
        bctx.moveTo(cx - xr, cy - xr); bctx.lineTo(cx + xr, cy + xr);
        bctx.moveTo(cx - xr, cy + xr); bctx.lineTo(cx + xr, cy - xr);
        bctx.stroke();
      }
    }
    wrap.classList.remove('hidden');
    // Live loop: zone + airdrop + tank icons + trajectory redrawn every frame.
    const loop = () => {
      if(document.getElementById('bigmap').classList.contains('hidden')){
        this._bigMapLoop = 0; return;
      }
      ctx.clearRect(0, 0, S, S);
      ctx.drawImage(this._bigMapBase, 0, 0);
      this._drawGladZoneOnBigMap(ctx, S);
      this._drawAirdropOnBigMap(ctx, S);
      this._drawTankOnBigMap(ctx, S);
      this._bigMapLoop = requestAnimationFrame(loop);
    };
    this._bigMapLoop = requestAnimationFrame(loop);
  }

  /* Map-space heading/turret angle -> canvas rotation (icon "up" = forward;
     heading 0 faces +Z which is canvas-down here). */
  _bigMapFwdAngle(ang){
    return Math.atan2(Math.cos(ang), Math.sin(ang)) + Math.PI / 2;
  }

  /* Same, but for a plain line: local +X is rotated to point along the world
     forward direction (no image-"up" offset). */
  _bigMapLineAngle(ang){
    return Math.atan2(Math.cos(ang), Math.sin(ang));
  }

  /* Lazily load the hull + turret map icons. Turret falls back to the hull
     icon until assets/icons/minimap-turret.png is added. */
  _bigMapIcons(){
    if(!this._bigMapHull){
      this._bigMapHull = new Image();
      this._bigMapHull.src = 'assets/icons/minimap-hull.png?v=' + (CONFIG.MODEL_VER || '1');
    }
    if(!this._bigMapTurret){
      this._bigMapTurret = new Image();
      this._bigMapTurret.onerror = () => { this._bigMapTurret = this._bigMapHull; };
      this._bigMapTurret.src = 'assets/icons/minimap-turret.png';
    }
    return [this._bigMapHull, this._bigMapTurret];
  }

  /* Live gladiator zone overlay on the big map: RED danger chunks, ORANGE
     pending chunks and the remaining-safe-area outline. */
  _drawGladZoneOnBigMap(ctx, S){
    if(!this.world || !this.glad) return;
    const g = this.glad;
    if(g.phase === 'grace' || !this._gladZoneChunks) return;
    const k = S / (this.world.size || 100);
    const cs = (g.cfg.zone.chunk || 12) * k;
    // RED danger chunks (the actual zone), expanded 1px so tiles have no seams
    ctx.fillStyle = 'rgba(255,40,40,0.55)';
    for(const c of this._gladZoneChunks){
      if(c.state !== 'red') continue;
      const [px, py] = this.world.worldToMap(c.x, c.z, S);
      ctx.fillRect(px - cs / 2 - 0.5, py - cs / 2 - 0.5, cs + 1, cs + 1);
    }
    // ORANGE pending chunks (countdown before they turn red), full cells so
    // connected same-timing squares merge into one region.
    ctx.fillStyle = 'rgba(255,170,60,0.9)';
    for(const c of this._gladZoneChunks){
      if(c.state !== 'orange') continue;
      const [px, py] = this.world.worldToMap(c.x, c.z, S);
      ctx.fillRect(px - cs / 2 - 0.5, py - cs / 2 - 0.5, cs + 1, cs + 1);
    }
    // Safe area outline
    const b = this._gladSafeBounds();
    if(b){
      const [x1, y1] = this.world.worldToMap(b.minX, b.minZ, S);
      const [x2, y2] = this.world.worldToMap(b.maxX, b.maxZ, S);
      ctx.strokeStyle = '#ff3030';
      ctx.lineWidth = 4;
      ctx.strokeRect(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
    }
  }

  /* Airdrop marker icon (box.png) on the big map, cached after first load. */
  _bigMapAirdropIcon(){
    if(!this._bigMapAirdropImg){
      this._bigMapAirdropImg = new Image();
      this._bigMapAirdropImg.src = 'assets/icons/airdrop.png';
    }
    return this._bigMapAirdropImg;
  }

  /* Live airdrop marker: box icon (or cyan circle + DROP label fallback). */
  _drawAirdropOnBigMap(ctx, S){
    if(!this.world || !this.glad || this.glad.phase === 'grace') return;
    const g = this.glad;
    if(!g.airdrop) return;
    const k = S / (this.world.size || 100);
    const [ax, ay] = this.world.worldToMap(g.airdrop.x, g.airdrop.z, S);
    const img = this._bigMapAirdropIcon();
    if(img && img.complete && img.naturalWidth > 0){
      const size = 26 * k;
      ctx.save();
      ctx.globalAlpha = g.airdrop.landed ? 1 : 0.85;
      ctx.translate(ax, ay);
      if(!g.airdrop.landed) ctx.rotate(Math.sin(g.airdrop.countdown * 2) * 0.06);
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
      ctx.restore();
    } else {
      ctx.fillStyle = g.airdrop.landed ? '#00eeff' : 'rgba(0,230,255,0.55)';
      ctx.beginPath();
      ctx.arc(ax, ay, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#003d5c';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('DROP', ax, ay - 14);
    }
  }

  /* Live local-tank overlay: dashed trajectory (- - - - -) along the aim
     direction, hull icon + turret icon in real time. */
  _drawTankOnBigMap(ctx, S){
    const t = this.localTank;
    if(!t || !this.world) return;
    const k = S / (this.world.size || 100);
    const [px, py] = this.world.worldToMap(t.x, t.z, S);
    const aimAngle = (t.turretAngle != null) ? t.turretAngle : t.heading;
    const [hullImg, turretImg] = this._bigMapIcons();

    // --- Trajectory line (- - - - -) along the aim (turret) direction ---
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(this._bigMapLineAngle(aimAngle));
    ctx.strokeStyle = 'rgba(255,177,43,0.85)';
    ctx.lineWidth = Math.max(1.5, 2.5);
    ctx.setLineDash([3 * k, 2.2 * k]);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(26 * k, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // --- Hull icon (position + rotation), 2x scale ---
    const hullW = 9.2 * k;
    const hullAspect = hullImg && hullImg.naturalWidth > 0 ? (hullImg.naturalHeight / hullImg.naturalWidth) : (364 / 239);
    const hullH = hullW * hullAspect;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(this._bigMapFwdAngle(t.heading));
    if(hullImg && hullImg.complete && hullImg.naturalWidth > 0){
      ctx.drawImage(hullImg, -hullW / 2, -hullH / 2, hullW, hullH);
    } else {
      ctx.fillStyle = '#ffb12b'; ctx.beginPath();
      ctx.moveTo(0, -hullW * 0.5); ctx.lineTo(hullW * 0.45, hullW * 0.5);
      ctx.lineTo(-hullW * 0.45, hullW * 0.5); ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    // --- Turret icon (1.5x size, pivot moved to the rear/base of the turret) ---
    const img = (turretImg && turretImg.complete && turretImg.naturalWidth > 0) ? turretImg : hullImg;
    const tw = hullW * 0.93;
    const tAspect = img && img.naturalWidth > 0 ? (img.naturalHeight / img.naturalWidth) : (364 / 239);
    const th = tw * tAspect;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(this._bigMapFwdAngle(aimAngle));
    if(img && img.complete && img.naturalWidth > 0){
      ctx.drawImage(img, -tw / 2, -th * 0.70, tw, th);
    }
    ctx.restore();
  }
}

const BOTNAMES = ['Rommel','Patton','Guderian','Zhukov','Abrams','Leclerc','Tiger','Panther','Sherman','T-34','Challenger','Merkava','Karl','Bovington','Stug','Hetzer','IS-2','Comet','Cromwell','Hellcat'];

/* ---------- Bootstrap ---------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  try {
    var RapierMod = await import('https://cdn.skypack.dev/@dimforge/rapier3d-compat@0.12.0');
    if(RapierMod.default){
      await RapierMod.default.init();
      window.RAPIER = RapierMod.default;
    }
  } catch(e){ console.warn('Rapier init failed, physics disabled:', e); }
  let game = null;
  try {
    game = new Game();
    game.init();
    if(location.hash.indexOf('__dbg') >= 0) window.__game = game;
  } catch(e){
    console.error('BOOTSTRAP ERROR:', e, e.stack);
  }
  try {
    Menu.init(game);
  } catch(e){
    console.error('MENU INIT ERROR:', e, e.stack);
  }
  // Fetch Tank Editor overrides shared with all clients (hitbox/pivot/spawn)
  try {
    if(window.TankEditor && TankEditor.syncGlobal) TankEditor.syncGlobal().catch(function(){});
  } catch(e){ console.warn('tank overrides sync skipped:', e); }
  window.__game = game;
});