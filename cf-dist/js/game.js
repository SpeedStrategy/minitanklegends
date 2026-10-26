/* ============================================================
   game.js Ã¢â‚¬â€ main controller: renderer, scene, world, tanks,
   projectiles, camera, loop, HUD, minimap, entry modes
   (singleplayer / host / client).
   FULLY WORKING P2P MULTIPLAYER.
   ============================================================ */

/* -- VFX POLICY ---------------------------------------------------------
   particleClouds = sprite-based particle clouds: sparks, smoke, dust,
   debris, embers, explosion puffs, muzzle smoke / kick sparks, the
   burning-tank flame sprites.

   Kept ON regardless of this switch (these are the "VFX", not particles):
     Ã¢â‚¬â€ the video-based explosion / fire effects
     Ã¢â‚¬â€ the muzzle flash itself
     Ã¢â‚¬â€ hit markers, bullet trails, shell casings
   Set to true to bring every sprite particle back.                     */
window.particleClouds = false;

/* ---- SPAWN PADS ----------------------------------------------------------
   A white glowing rectangle painted on the ground at each spawn point. STATIC:
   it marks where a tank starts and stays there. Nothing follows a tank around.

   (The first version also drew a pad under every moving tank. That was wrong --
   a marker that travels with you stops marking a place and starts being part
   of the vehicle, and with 16 tanks on screen it turned the arena into a moving
   grid. Spawn points are the only fixed positions the game has, so they are the
   only place a static pad means anything.)

   ONE size for all of them, and it is sized from the tank's
   COLLIDER -- the hitbox, not the picture.

   The first version of this was sized from the visual model and used 32 units,
   which was wrong twice over. Helix's model is 27.76 units wide while its
   hitbox is 7.04, so sizing to the model produced a 32-unit square for a tank
   whose actual body is under 10 -- the pads covered most of the map and read
   as a grid rather than as a marker.

   Measured collider extents (body.w and body.l x 0.55 x GLOBAL_SCALE):

       sturmratte   8.80 x 12.76   <- the largest, and the constraint
       helix        7.04 x 10.12
       coolbuddy    6.60 x  9.68
       ghost        5.06 x  7.92

   So 11 x 15 clears the biggest tank with a little room to spare. Long axis on
   Z, matching a tank's own body.l along its length.

   Each pad is also ROTATED to the spawn's heading, which is what lets the long
   axis be tight instead of having to be a diagonal-safe square: the tank
   arrives pointing along the rectangle, so it only has to fit the way it
   actually sits, rather than at every possible angle.

   Both numbers are here rather than being derived at runtime on purpose. They
   are a property of the tank roster in config.js, and config can be edited by
   the Tank Editor; re-measuring every battle start to rediscover a constant
   would be slower and would silently change the look of every map when one tank
   is rebalanced. If a future tank is much bigger, this wants re-measuring. */
const TANK_PAD_W = 11;
const TANK_PAD_L = 15;

/* scratch for the video-VFX billboard math (lazily allocated: THREE may not
   be on the page yet when this file is parsed) */
let _vfN = null, _vfRight = null, _vfUp = null, _vfCamUp = null, _vfRot = null;

/* ---- WebGPU probe -------------------------------------------------------
   `navigator.gpu` existing proves nothing: a browser can expose the API and
   still hand back no adapter (blocklisted driver, remote desktop, headless
   session). So the adapter is actually requested, once, and the answer is
   remembered Ã¢â‚¬â€ the settings screen shows it and the renderer only tries WebGPU
   when it is genuinely usable. */
let _webgpuProbeResult = false;
let _webgpuProbe = null;
function _webgpuUsable(){
  if(_webgpuProbe) return _webgpuProbe;
  _webgpuProbe = (async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu || !navigator.gpu.requestAdapter) return false;
      // powerPreference asks for the real GPU rather than a software/fallback
      // one, and a fallback adapter is a hard "no" for Auto: that is the
      // browser saying "I can do WebGPU, but not on a GPU worth doing it on".
      const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!ad) return false;
      if (ad.isFallbackAdapter === true) return false;
      return true;
    } catch(e){ return false; }
  })().then(v => { _webgpuProbeResult = !!v; return _webgpuProbeResult; });
  return _webgpuProbe;
}

/* How many frames a bot may go between decisions. Four at 60fps is 66ms of
   thinking Ã¢â‚¬â€ well inside what a human opponent notices Ã¢â‚¬â€ and it cuts the
   measured 1.6ms of AI cost per frame to roughly a quarter. Bots are staggered
   across the phases so the saving is spread evenly rather than arriving as one
   spike every fourth frame. */
const BOT_THINK_EVERY = 4;

/* ============================================================================
   OUTLINES: TANKS ONLY

   Outlines are applied to tanks and nothing else. The map -- ground, walls,
   trees, rocks, scenery, props -- is left completely clean.

   This is a deliberate reversal, and the reason is visible rather than
   measured. Outlining every map mesh produced 41 hulls and read as a debugging
   overlay, not a style: black frames around every bush and tree that made the
   battlefield look like it was wireframed, and the hulls on foliage read as
   solid black slabs because leaf cards are flat quads whose hull is a slab
   rather than a rim. Outlining only the thing you are playing -- the tanks --
   gives the same readability where it matters and costs a fraction as much.

   The map outline system is kept below as an off-by-default debug aid (Ctrl+M),
   because it is genuinely useful for finding invisible collision geometry while
   level building. It is not built, maintained, or drawn during a match.
   ============================================================================ */
const MAP_OUTLINES_ENABLED = false;
const OUTLINE_MAP_WIDTH = 0.028;

/* ============================================================================
   WHICH THINGS MUST NEVER GET A MAP OUTLINE

   Anything that is drawn, moves on its own, or is a piece of pure effect.

   This exists because the first version outlined EVERY visible mesh, which
   meant it wrapped black hulls around shell tracers and the glowing trail a
   shell drags behind it. A projectile body is an InstancedMesh like any other
   object in the scene, so nothing stopped it.

   Instanced meshes are excluded outright rather than special-cased: a single
   hull around an InstancedMesh would be drawn once at the object's own origin
   rather than around every instance, which is worse than no outline at all.
   ============================================================================ */
function skipMapOutline(o){
  if(o.isInstancedMesh) return true;      // shell bodies, glow trails, grass
  if(o.isSprite || o.isPoints || o.isLine) return true;
  /* Effects: additive geometry is already light, and a black hull around a
     particle is just a black blob. */
  const m = o.material;
  if(m && !Array.isArray(m)){
    if(m.blending === THREE.AdditiveBlending) return true;
    if(m.transparent && o.renderOrder >= 990) return true;
  }
  /* Anything owned by a projectile, a trail, or a world effect. */
  let p = o;
  for(let i=0;i<4 && p;i++){
    const n = (p.name || '') + ' ' + ((p.userData && (p.userData.kind || p.userData.type)) || '');
    if(/shell|projectile|tracer|trail|bullet|muzzle|explosion|smoke|spark|foam|ricochet/i.test(n)) return true;
    p = p.parent;
  }
  return false;
}

/* HOW THE CLIENT'S OWN TANK IS CORRECTED TOWARD THE HOST.

   CORRECT_DEADZONE is the error, in world units, that is ignored outright.
   Ordinary latency leaves the client a unit or two behind the host, and
   correcting that visibly is what made the tank judder while driving. Past the
   deadzone the error is walked off at CORRECT_RATE instead.

   Both are in world units, so they behave the same on a small arena and on the
   1700-unit Kaukaz III. */
const CORRECT_DEADZONE = 2.0;
const CORRECT_RATE = 45;

/* -- THE CLOSING SHOT -------------------------------------------------------
   The cinematic that plays between the last kill and the results screen. See
   Game._beginEndCinematic for what each beat is and why it is that long.

   ALL TIMES ARE REAL SECONDS. The world runs slowed down underneath (see
   `slow`/`dip`) but the shot itself is timed against the wall clock, because a
   shot timed on the dilated clock would take four seconds of real time to play
   four seconds of screen time, which is the exact opposite of the point.

   The numbers are tuned so the whole thing is 4.38s Ã¢â‚¬â€ long enough to register
   as an event, short enough that nobody counts the seconds. */
const END_CINE = {
  /* Beat 1 - WHIP: the play camera throws itself round to the tank's tail. */
  swing:  0.85,
  /* Beat 2 - REVEAL: the arc to the front of the tank, decelerating into it. */
  reveal: 2.10,
  /* Beat 3 - HOLD: near still, breathing push-in. Where the eye rests. */
  hold:   1.05,
  /* Beat 4 - CUT: one white frame, then the results screen is simply there. */
  cut:    0.38,
  /* How hard the world is slowed at the moment of the hit, and where it settles.
     The dip is a near-stop: the killing blow lands, time snaps, then creeps back
     to a crawl. It returns to 1.0 ON THE CUT, not before Ã¢â‚¬â€ a results screen
     with the world still crawling behind it reads as a bug, not as style. */
  dip:    0.12,
  slow:   0.34,
  /* When the headline punches in, and how long the punch takes. */
  title:     0.62,
  titleDur:  0.85,
  /* The two white frames: the one that opens the shot and the one that covers
     the cut into the results screen. Split out rather than derived from `dip`,
     because `dip` is about TIME and these are about LIGHT Ã¢â‚¬â€ a plan that does not
     slow the world down still wants a flash, and a plan that does not flash at
     all still wants the world slowed down. */
  flash0:    0.55,
  cutFlash:  1.00,
  /* Ignore a skip request in the first this-many seconds, so the keypress that
     landed the last shot does not also skip the ending. */
  skipGuard: 0.30,
};
END_CINE.total     = END_CINE.swing + END_CINE.reveal + END_CINE.hold + END_CINE.cut;

/* THE FRAMING. Distances and heights in world units above the tank's own ground
   level; angles in radians off the tank's nose. Read by _endCineCamera, which is
   the only thing that places the camera, and kept here because these are the
   numbers that get dialled in by eye.

   `up` is why the shot sits above the tank rather than level with it: from
   roughly a tank-and-a-half up, and looking at a point `aimHull` of the way up
   the hull, the camera gains enough downward angle to see the ground the tank is
   standing on. Level with the hull roof there is no ground under it at all, and
   a tank with no ground under it is a shape floating in a horizontal band.

   The distance numbers are deliberately KEPT OUT of `up`, even though they are
   dialled in together. They used to share one object and `dist` picked up a
   height, which put the camera four units from the tank looking down at it Ã¢â‚¬â€
   technically a "close low angle", and in practice a bug nobody could see from
   the code. Separate names, separate numbers. */
END_CINE.shot = {
  up: {
    whip0:   6.4,   /* where the whip starts, high Ã¢â‚¬â€ it is falling into frame */
    whip1:   4.6,   /* where it arrives, behind the tank */
    reveal1: 3.5,   /* the arc finishes here, in front of the tank */
    hold1:   4.0,   /* the held shot breathes up a little more */
  },
  /* Horizontal distance. It grows as the camera rises: a higher camera at the
     same distance frames more sky and less tank. */
  reveal1: 9.4,
  hold1:   8.4,
  /* Where the tank's nose points in the final frame, and where it drifts to
     during the hold. A few degrees each, which is most of what the push-in
     reads as. */
  frontAngle: 0.42,
  driftTo:    0.30,
  /* The aim point, as a fraction of the tank's collider height. Above halfway
     so the horizon sits behind the turret rather than through the tracks. */
  aimHull: 0.72,
};

/* The `prefers-reduced-motion` answer to all of the above: no whip, no arc, no
   roll, no time dilation, no opening flash. The camera still ends up in front of
   the tank Ã¢â‚¬â€ that is information, not decoration Ã¢â‚¬â€ it just gets there as a cut
   rather than a move, and the cut carries a soft 0.3 wash instead of a full
   white frame. */
END_CINE.reduced = {
  swing: 0, reveal: 0, hold: 0.55, cut: 0.45,
  dip: 1, slow: 1, title: 0.08, titleDur: 0.30,
  flash0: 0, cutFlash: 0.30, skipGuard: 0.10,
};
END_CINE.reduced.total = END_CINE.reduced.hold + END_CINE.reduced.cut;

/* Resolved once at load. A live matchMedia listener would be more correct in
   principle and is not worth a re-plan mid-shot. */
const _endCinePlan = (() => {
  try {
    if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      return END_CINE.reduced;
    }
  } catch(e){}
  return END_CINE;
})();

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
    /* When the game loop last ran, and the handle on the timer that steps it
       when requestAnimationFrame is throttled. See _startLoopFallback. */
    this._lastRafAt = 0;
    this._loopFallback = null;
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
  async init(){
    // Renderer backend. WebGPU is the newer, faster path and is used whenever
    // the device really has it; anything less falls back to WebGL 2 (and then
    // WebGL 1 / experimental-webgl) exactly as before. The choice comes from
    // Settings > Other and defaults to "auto".
    if(!await this._createRenderer()){
      this._showNoWebGL();
      return;
    }
    this._maxPixelRatio = Math.min(devicePixelRatio, 1.5);
    this.renderer.setPixelRatio(this._maxPixelRatio);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    document.getElementById('game-root').appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.__renderer = this.renderer;
    /* One group of stripe meshes for the whole match, sitting at the top of the
       scene rather than under any tank. See xray.js for why it is not parented
       to the tanks, and sync() for how it is kept in step with them. */
    if(typeof Xray !== 'undefined' && Xray.init){
      try { Xray.init(this.scene); this.refreshXrayStyle(); } catch(e){}
    }
    // Get the muzzle-flash picture downloading now, so the very first shot of
    // the session already has its art instead of a blank square.
    this._muzzlePictureTex();
    // far used to be 1000, but at full zoom-out the camera climbs to ~900
    // units up, so the far edge of the frame landed past the far plane and the
    // world visibly cut off. 1500 keeps everything inside (fog still hides the
    // distance, so nothing extra is really drawn).
    this.camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 1500);
    this.camera.position.set(0, CONFIG.CAM_HEIGHT, -CONFIG.CAM_DIST);
    this.camera.lookAt(0, 1.2, 0);

    this.world = new World(this.scene);
    /* Maps stream in AFTER the match has started, so a map outline built
       during the first seconds of a battle sees the old ground and none of
       the map. Wrapping the one loader catches every mode Ã¢â‚¬â€ singleplayer, TDM,
       Capture the Circle, the voted maps Ã¢â‚¬â€ instead of patching five call
       sites that would drift apart. */
    try {
      const _loadGLB = this.world.loadGLBModel.bind(this.world);
      this.world.loadGLBModel = (...a) => _loadGLB(...a).then((grp) => {
        /* Only the Ctrl+M debug view rebuilds here. Wrapping the loader in a
           hook that fires on every map load cost a full scene rebuild for a
           view that is off. */
        if(this._mapOutlineDebug) setTimeout(() => this._refreshMapOutlines(), 0);
        return grp;
      });
    } catch(e){ /* outlining is a tool; never let it break loading */ }
    /* Scenery (trees and rocks) is loaded separately from the map, so the debug
       view has to hook that too or the trees arrive un-outlined.

       `this` inside a plain function is NOT the game, so the callback captured
       the game in a const. Written as `this` it silently threw on every scenery
       load and the trees were never outlined at all. */
    try {
      if(window.NatureAssets && typeof NatureAssets.loadAll === 'function'){
        const _natLoad = NatureAssets.loadAll.bind(NatureAssets);
        const _self = this;
        NatureAssets.loadAll = function(...a){
          const p = _natLoad(...a);
          return (p && typeof p.then === 'function') ? p.then(function(v){
            if(_self._mapOutlineDebug) setTimeout(() => _self._refreshMapOutlines(), 0);
            return v;
          }) : p;
        };
      }
    } catch(e){}
    this._initPhysics();
    this.input = new Input(this.settings);

    // camera zoom and orbit state
    this.camDist = CONFIG.CAM_DIST;
    this.camAngle = Math.PI; // radians, p = behind the tank
    this.camMode = 'arrows';
    this.cameraMode = (this.settings && this.settings.cameraMode) || 'dynamic';

    /* TWO-MODE CAMERA. Six fixed camera points, two layouts Ã¢â‚¬â€ see the
       CAMERA_STOPS comment in config.js. Stage 0..2 drive the WoT-style
       dynamic third person; stage 3..5 drive the high "strategic" view where
       the mouse is the aim. Stage 2 is the default (a familiar third-person
       distance); the remembered stage follows across restarts. */
    this._staged = !(this.settings && this.settings.camTwoMode === false);
    this._camStage = (this.settings && typeof this.settings.cameraStage === 'number')
      ? Math.max(0, Math.min(5, this.settings.cameraStage|0)) : 2;
    if(this._staged){
      const stop = CONFIG.CAMERA_STOPS[this._camStage];
      this.cameraMode = (stop.mode === 'strategic') ? 'strategic' : 'dynamic';
      if(stop.mode === 'tp') this.camDist = stop.dist;
    }
    /* Mode 1 crosshair pitch: 0 = level shot; negative digs down, positive
       raises up. Clamped in _update, only ever touched in dynamic mode. */
    this._aimPitch = 0;
    /* Mode 1 crosshair horizontal angle: where the crosshair is aiming.
       In dynamic mode, this follows mouse movement and the turret chases it.
       The camera looks along this angle (WoT-style). */
    this._crosshairAngle = 0;
    /* Glow amount for aim line (0..1): when turret is lagging behind crosshair,
       the line glows orange/yellow to warn the player. */
    this._aimLineGlow = 0;

    // Camera angle progression: 25Ã‚Â° at min zoom (close) ? 40Ã‚Â° at max zoom (far, horizontal)
    this._camAngleMin = 15 * Math.PI / 180;
    this._camAngleMax = 40 * Math.PI / 180;

    // aim/trajectory line (from muzzle, length = shellRange)
    this._initAimLine();
    // ricochet indicator (2 colored lines on target tank faces)
    this._initRicoIndicator();
    // artillery impact marker (blast-radius ring + crosshair at the impact point)
    this._initMortarMarker();
    // water foam (created on the fly in _updateWaterFoam)

    // probe available tank models (async). Probe every model referenced by
    // the roster too (TANK_ORDER lists tank ids, but defs may point at a
    // different file name, e.g. striker -> TL_ark).
    const probeNames = new Set(TANK_ORDER);
    for(const id in TANKS){ const m = TANKS[id] && TANKS[id].model; if(m) probeNames.add(m); }
    // Keep the promise so the loading screen can await it instead of racing
    // the first battle for the same files.
    Models._probePromise = Models.probe(Array.from(probeNames)).catch(()=>{});
    /* The scenery load, and the retry that makes trees exist.

       `window.NatureAssets` was the guard here, and it was always false Ã¢â‚¬â€
       models.js declares NatureAssets as a top-level `const`, which lives in
       the shared global LEXICAL scope and is NOT a property of window. So this
       whole block was dead: loadAll() never ran, NatureAssets.loaded stayed
       false, and world.trees stayed empty for the life of the game. The OBJ
       trees in nature/ were on disk, fetchable, and never once placed. models.js
       now also assigns window.NatureAssets, so this guard Ã¢â‚¬â€ and the one in
       _spawnStartProps Ã¢â‚¬â€ read true.

       The retry is the other half. The load is async, so it can still be in
       flight when the first match starts and _spawnStartProps' single call
       finds nothing. Clearing the flag and calling again once it resolves is
       what turns "sometimes there are no trees" into "there are trees". */
    if(typeof NatureAssets !== 'undefined'){
      NatureAssets._promise = Promise.resolve(NatureAssets.loadAll()).then(() => {
        /* THE RETRY, AND WHY IT CANNOT SIT ONLY HERE.

           This callback ran once, when the OBJ files finished parsing. By then
           the match had usually already started, so this.world existed and the
           call worked Ã¢â‚¬â€ but on a fast machine the load can finish BEFORE the
           match is built, when this.world is still undefined, and the callback
           did nothing at all. Nothing ever called it again, so those sessions
           simply had no trees.

           So it does not depend on this.world existing: it marks the scenery
           ready and clears treesPlaced, and _spawnStartProps Ã¢â‚¬â€ which runs on
           every match, when the world is definitely up Ã¢â‚¬â€ does the placing.
           Whichever order the two happen in, the trees appear. */
        this._sceneryReady = true;
        if(this.world && !this.world.treesPlaced) this.world.tryPlaceTrees();
      }).catch(()=>{});
    }

    addEventListener('resize', ()=> this._onResize());
    this._loop = this._loop.bind(this);
    this._step = this._step.bind(this);
    requestAnimationFrame(this._loop);
    this.applyGraphicsSettings();
    // Muzzle-flash lights exist from the very first frame (fancy only) so
    // `numPointLights` never changes and shaders compile exactly once.
    this._ensureMuzzleLights();
    if(typeof GraphicsSettings !== 'undefined') GraphicsSettings.init(this);

    /* ---- Performance overlay (hold P) ---- */
    this._buildPerfOverlay();
    this._onKeyDown = (e) => {
      /* THE SKIP COMBO, and why it is two keys held together.

         Tab+P at the same time is the shortest binding that cannot collide with
         anything the game already does. P alone is the performance overlay and
         Tab alone is the scoreboard, and both are keys a player presses
         constantly mid-fight Ã¢â‚¬â€ so binding skip to either means it fires constantly
         and by accident. Holding BOTH needs a deliberate two-finger press that
         nobody makes by reflex.

         The state is tracked HERE rather than read from input.keys. Input has its
         own window keydown listener, and two listeners on the same event run in
         registration order Ã¢â‚¬â€ so whether input.keys was already updated by the
         time this runs depends on which object was constructed first. A combo
         that fires on the second Tab press of a match because of that ordering is
         not a bug anyone could reproduce, let alone fix.

         Latched, not level-triggered: holding the pair down across a slow frame
         must not call the skip twice, and the second call would land while the
         results screen was already tearing the arena down. */
      if (e.code === 'KeyP') this._skipKeyP = true;
      if (e.code === 'Tab') this._skipKeyTab = true;
      if (this._skipKeyP && this._skipKeyTab) this._trySkipBattle();

      /* Held AFTER the combo check on purpose: the performance overlay is
         suppressed while both keys are down (see keyup), so pressing them
         together never flashes the FPS graph. */
      if (e.code === 'KeyP' && !(this._skipKeyTab && this._skipKeyP)) {
        this._perfOverlay.style.display = 'block';
      }
      if (e.code === 'Tab') { e.preventDefault(); this._toggleScoreboard(); if(document.pointerLockElement) document.exitPointerLock(); }
      /* Ctrl+M (or plain M Ã¢â‚¬â€ Ctrl+key can be swallowed by the browser, a remote
         desktop or an OS shortcut, and a map tool with one fragile binding is
         a map tool nobody uses) outlines the WHOLE map. This is a
         level-designer's tool: it is the only way to see whether the geometry
         you cannot see through is actually where you think it is Ã¢â‚¬â€ gaps in
         cover, walls a tank can drive through, an overhang clipping the gun.
         Tanks already have outlines of their own; this is everything else. */
      if(e.code === 'KeyM'){
        if(e.ctrlKey || e.metaKey) e.preventDefault();
        /* Debug build of the map outlines. Off in a normal match. */
        this._mapOutlineDebug = !this._mapOutlineDebug;
        this._toggleMapOutlines();
      }
    };
    this._onKeyUp = (e) => {
      if (e.code === 'KeyP') {
        this._skipKeyP = false;
        if(!this._skipKeyTab) this._perfOverlay.style.display = 'none';
      }
      if (e.code === 'Tab') this._skipKeyTab = false;
      /* Disarming is NOT the same as clearing the latch. The latch is cleared
         when a new battle starts, so holding the pair down across a skipped
         battle cannot end the next one a player plays without them letting go
         first. */
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
  }

  /** Which backend the player asked for: 'auto' | 'webgpu' | 'webgl2'. */
  _rendererPref(){
    let p = 'auto';
    try {
      const s = (window.Menu && Menu.settings) || (typeof loadSettings === 'function' ? loadSettings() : null);
      if (s && s.rendererBackend) p = s.rendererBackend;
    } catch(e){}
    if (['auto','webgpu','webgl2'].indexOf(p) < 0) p = 'auto';
    /* AUTO MEANS "THE FASTER ONE", NOT "THE NEWER ONE".
       Auto used to pick WebGPU whenever the machine merely *supported* it, on
       the assumption that the modern backend is the faster one. Measured on
       this machine's own hardware (an older AMD GCN-4 card) that is backwards:
       WebGPU ran at about 44 fps where WebGL 2 ran at about 59 on the same
       scene. "Newer" is not a proxy for "faster", so Auto now picks WebGL 2,
       which is the one that actually measured faster. WebGPU is still one click
       away in Settings if it wins on different hardware. */
    if(p === 'auto') p = 'webgl2';
    this.rendererPref = p;
    return p;
  }

  /** Build the renderer. WebGPU only when it is explicitly asked for, then the
      old WebGL 2 -> WebGL 1 -> experimental-webgl ladder. */
  async _createRenderer(){
    const pref = this._rendererPref();
    if (pref !== 'webgl2' && await _webgpuUsable()){
      if (await this._createWebGPURenderer()) return true;
      if (pref === 'webgpu') console.warn('[renderer] WebGPU was requested but could not start Ã¢â‚¬â€ using WebGL 2.');
    }
    return this._createWebGLRenderer();
  }

  /** The WebGPU path. three silently swaps in its own WebGL backend when there
      is no WebGPU device; that would not be WebGPU at all, so the attempt is
      thrown away and the WebGL 2 renderer is built instead. */
  async _createWebGPURenderer(){
    let mods = null;
    try { mods = await window.loadTSL(); } catch(e){ return false; }
    const WGPU = mods && mods.WebGPU;
    if (!WGPU || !WGPU.WebGPURenderer) return false;
    const canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    let r = null;
    try {
      r = new WGPU.WebGPURenderer({ canvas, antialias: devicePixelRatio <= 1, alpha: false });
      await r.init();
    } catch(e){
      console.warn('[renderer] WebGPU init failed:', e);
      return false;
    }
    if (!r.backend || r.backend.isWebGPUBackend !== true){
      try { r.dispose && r.dispose(); } catch(e){}
      return false;
    }
    this.renderer = r;
    this._backend = 'WebGPU';
    this._webgpuAvailable = true;
    window.__isWebGPU = true;
    // Every material the game builds has to be a Node material now: the WebGPU
    // renderer cannot run GLSL ShaderMaterial at all.
    window.__isWebGL = false;
    return true;
  }

  /** Create the WebGL renderer with an automatic backend fallback chain:
      WebGL2 -> WebGL1 -> experimental-webgl. Throwing in a context/driver at
      any step silently advances to the next backend instead of black-screening. */
  _createWebGLRenderer(){
    const canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    const attrs = {
      alpha: false,
      depth: true,
      /* The x-ray pass needs a stencil buffer and asks for one: it stamps the
         player's own visible silhouette there so the stripes are refused on the
         parts you can already see, and are allowed on the parts you cannot.
         Without it the effect degrades to striping the hull under your own
         turret, forever. */
      stencil: true,
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
          stencil: true,
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
    this._webgpuAvailable = _webgpuProbeResult;
    window.__isWebGPU = false;
    window.__isWebGL = true;
    this._watchContextLoss(canvas);
    return true;
  }

  /* A LOST WEBGL CONTEXT LOOKS EXACTLY LIKE A BROKEN GAME.

     The canvas goes black and stays black, while everything that is not the
     canvas keeps working: the HUD, the menus, the health bars, the pointer lock,
     the whole DOM. Nothing throws, nothing crashes, and there is no message
     anywhere. So the report is always the same Ã¢â‚¬â€ "I can't see anything" Ã¢â‚¬â€ and
     it is read as the game being broken rather than as the GPU handing the
     context back.

     Chrome keeps a hard cap of about sixteen live WebGL contexts PER BROWSER,
     not per tab, and evicts the oldest when a seventeenth is asked for; it also
     drops a context on a GPU reset, a driver hiccup, or a laptop switching
     graphics cards. Any of those lands here. The one thing this can do is say
     so, and say what to do about it.

     three.js has its own listeners and will rebuild its GL state when the
     context comes back, so this is only the notice: it appears while the
     canvas is dead and goes away by itself the moment rendering resumes. If it
     does not go away, a reload is the fix Ã¢â‚¬â€ and closing other tabs first is
     worth doing, because that is usually why it was lost. */
  _watchContextLoss(canvas){
    if(!canvas || !canvas.addEventListener) return;
    try {
      canvas.addEventListener('webglcontextlost', (e) => {
        /* Required, or the browser will never restore the context at all. */
        try { e.preventDefault(); } catch(err){}
        this._glLost = true;
        this._showContextLostNotice(true);
        try { if(window.__mtlMark) window.__mtlMark('battle:gl-context-lost'); } catch(err){}
      }, false);
      canvas.addEventListener('webglcontextrestored', () => {
        this._glLost = false;
        this._showContextLostNotice(false);
      }, false);
    } catch(e){ /* no canvas events: the notice simply never appears */ }
  }

  _showContextLostNotice(on){
    let el = document.getElementById('gl-lost-notice');
    if(on){
      if(!el){
        el = document.createElement('div');
        el.id = 'gl-lost-notice';
        el.style.cssText = 'position:fixed;left:50%;top:22px;transform:translateX(-50%);z-index:999998;' +
          'background:#2a1216;border:2px solid #ff6b6b;border-radius:10px;color:#ffd7d7;' +
          'font:13px/1.6 Consolas,Monaco,monospace;padding:12px 16px;max-width:min(92vw,520px);' +
          'box-shadow:0 10px 40px rgba(0,0,0,.6);text-align:center';
        el.innerHTML = '<b>GRAPHICS CONTEXT LOST</b><br>' +
          '<span style="color:#e8b4b4">The browser took the 3D context back; the game is still running, ' +
          'but there is nothing left to draw with. It usually comes back on its own within a second.<br>' +
          'If it does not: close your other tabs Ã¢â‚¬â€ browsers only keep about sixteen 3D contexts at once Ã¢â‚¬â€ ' +
          'then reload this page.</span>';
        try { (document.body || document.documentElement).appendChild(el); } catch(e){}
      }
      el.style.display = 'block';
    } else if(el){
      el.style.display = 'none';
    }
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

    // The WebGPU renderer has no GL context to interrogate; report the backend
    // name instead of a driver string rather than throwing here.
    var gl = this.renderer.getContext ? this.renderer.getContext() : null;
    var gpuName = this._backend || 'Unknown GPU';
    try {
      if (gl) {
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) gpuName = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      }
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
      '<div style="color:#0f6;font-size:13px;font-weight:700;letter-spacing:1px;border-bottom:1px solid rgba(0,255,170,0.30);padding-bottom:6px;margin-bottom:6px">PERFORMANCE MONITOR</div>' +
      '<div id="perf-row-gpu" style="color:#8af"></div>' +
      '<div id="perf-row-fps"></div>' +
      '<div id="perf-row-frametime"></div>' +
      '<div id="perf-row-draws"></div>' +
      '<div id="perf-row-tris"></div>' +
      '<div id="perf-row-ping"></div>' +
      '<div id="perf-row-transport"></div>' +
      '<div id="perf-row-mem-used"></div>' +
      '<div id="perf-row-mem-total"></div>' +
      '<div id="perf-row-mem-pct"></div>' +
      '<div id="perf-row-cpu"></div>' +
      '<div id="perf-row-gpu-load"></div>' +
      '<div style="border-top:1px solid rgba(0,255,170,0.30);padding-top:6px;margin-top:6px" id="perf-row-rating"></div>';

    document.body.appendChild(d);
    this._perfOverlay = d;
    var gpuRow = document.getElementById('perf-row-gpu');
    if(gpuRow){
      gpuRow.textContent = 'GPU  ' + gpuName +
        (this._backend ? '   Ã¢â‚¬â€  [' + this._backend + ']' : '   Ã¢â‚¬â€  [unknown]') +
        '   Ã¢â‚¬â€  WebGPU:' + (this._webgpuAvailable ? 'yes' : 'no');
    }
  }

  /** Throttled overlay update Ã¢â‚¬â€ called every frame but only rewrites DOM ~3x/sec */
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

    // Write DOM (3/sec Ã¢â‚¬â€ safe)
    document.getElementById('perf-row-fps').textContent =
      'FPS        ' + fps.toFixed(1) + (fps >= 55 ? '  ?' : fps >= 30 ? '  ?' : '  ?');
    document.getElementById('perf-row-frametime').textContent =
      'Frame time ' + frt.toFixed(1) + ' ms';

    /* WHAT IS ACTUALLY BEING SUBMITTED, not a guess about it.

       "FPS drops when I drive up to a tank" has two completely different causes
       that look identical from the outside and need opposite fixes:

         * DRAW CALLS -- the CPU cannot get the commands out fast enough. The
           number climbs when many separate objects enter the frustum. Fixed by
           merging or instancing, which is what the shells and the map foliage
           now do.
         * FILL -- the GPU is shading the same pixels many times over. The
           triangle count barely moves, but the tank now covers most of the
           screen and every pass over it (hull, outline shell, x-ray mirror,
           shadow map) is charged for all of those pixels at once. Fixed by
           removing a PASS or shrinking what it covers, never by instancing.

       `renderer.info` is reset by three itself at the start of each render, so
       it has to be read after the frame has been drawn. _perfRendererInfo does
       that on the same 3Hz throttle as the rest of this panel, which is ample:
       the number a player is reacting to does not change 60 times a second.

       Programs is here too, because a material that recompiles mid-match (a
       swapped texture, a transparent flag flipped on a shared toon material)
       costs a multi-hundred-ms stall, and it is invisible in the FPS row
       because it is one frame in a thousand. */
    var info = this._perfRendererInfo;
    if(info){
      var drawsRow = document.getElementById('perf-row-draws');
      var trisRow = document.getElementById('perf-row-tris');
      if(drawsRow){
        drawsRow.textContent =
          'Draw calls ' + info.render.calls +
          '   Programs ' + info.programs.length +
          '   Geoms ' + info.memory.geometries + '  Texs ' + info.memory.textures;
      }
      if(trisRow){
        trisRow.textContent =
          'Triangles ' + (info.render.triangles / 1000).toFixed(1) + 'k' +
          '   Points ' + info.render.points + '   Lines ' + info.render.lines;
      }
    }
    document.getElementById('perf-row-ping').textContent =
      'Ping       ' + pingStr;
      'Ping       ' + pingStr;
    (function(){
      var tr = document.getElementById('perfrow-transport');
      if(tr){
        var t = 'P2P       --';
        try {
          if (typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled){
            var toHost = Net.p2p.direct && Net.p2p.direct[Net.p2p.hostId];
            var openDirect = !!(toHost && toHost.open);
            if(openDirect){
              t = 'P2P       direct to host';
            } else {
              t = 'P2P       connecting (relay)';
            }
          } else {
            var on = (typeof Net !== 'undefined' && Net.role === 'host') ? 'host (relay)' : 'client (relay)';
            t = 'P2P       ' + on;
          }
        } catch(e){}
        tr.textContent = t;
      }
    })();
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
      ratingEl.innerHTML = '<span style="color:#888">PERFORMANCE: Ã¢â‚¬â€  (gathering data)</span>';
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
      var groundHalf = this.world ? Math.max(200, this.world.half + 50) : 200;
      var gCol = this.physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(groundHalf, 0.5, groundHalf), gBody);
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

    /* A SHELL MEANS A SHELL, WHATEVER IT HIT.

       This used to bail out on `if(!d1 || !d2) return;` Ã¢â‚¬â€ the FIRST guard to
       mention the two userData objects Ã¢â‚¬â€ so a contact involving any collider
       that had not been tagged fell straight out of the handler having done
       nothing at all. The map trimesh was untagged, so every shell that struck a
       building or a wall went through it. That is the whole of the bug that made
       bullets bounce off objects; see _sandboxBuildTrimesh.

       Identifying the shell first, and asking only what the OTHER side is,
       inverts the test. It cannot be defeated by a collider nobody remembered to
       tag, and an untagged collider is then treated as the world it almost
       certainly is: a fixed body a round has no business passing through.

       TANK IS STILL EXCLUDED, deliberately. A shell must only ricochet off a
       tank Ã¢â‚¬â€ that is the rule the whole _tryRicochet path exists to implement Ã¢â‚¬â€
       and an untagged collider is not a tank. So the default here is "stop at
       it", never "bounce off it". */
    var shell = null, other = null;
    if(d1 && d1.type === 'shell'){ shell = d1.shell; other = d2; }
    else if(d2 && d2.type === 'shell'){ shell = d2.shell; other = d1; }
    if(!shell || shell.dead) return;

    var otherType = (other && other.type) ? other.type : 'terrain';

    /* Only a genuine tank ricochets. Everything else Ã¢â‚¬â€ walls, the map trimesh,
       ground, debris, and anything added later without a tag Ã¢â‚¬â€ absorbs the shell,
       which is what "shells do not bounce off objects" means in practice. */
    if(otherType === 'tank' && other.tank){
      this._onShellHitTank(shell, other.tank);
      return;
    }

    shell.dead = true;
    var sp = shell._physBody ? shell._physBody.translation() : null;
    var ix = sp ? sp.x : shell.x, iz = sp ? sp.z : shell.z;
    this.spawnExplosion(ix, 1.0, iz, 0xffaa33, 6, 'wall');
    this.spawnBurst(ix, 1.0, iz, {count: 3, tex: 'dust', speed: 3.5, size: 0.9, life: 0.4, rise: 1.2, gravity: 5, blend: 'normal', fade: 0.7});
    /* Sparks bounce BACK toward where the shot came from: the wall throws
       them off like a mirror, and their cone bias follows the reflected
       direction, not the incoming one. */
    if(typeof SparkLines !== 'undefined' && this.scene){
      if(shell.dir){
        SparkLines.spawn(this.scene, ix, 1.05, iz, -(shell.dir.x || 0), -(shell.dir.z || 0), {count: 9, speed: 11});
      } else {
        SparkLines.spawn(this.scene, ix, 1.05, iz, 0, 0, {count: 7, speed: 9});
      }
    }
    /* The knock of the shot dying in the wall - quieter with distance,
       always a little audible so you can hear your own misses at least. */
    if(window.Audio && Audio.wallClang && !this._noParticles){
      try {
        var _ltw = this.localTank;
        var _dw = _ltw ? Math.hypot(_ltw.x - ix, _ltw.z - iz) : -1;
        var wv = _dw < 0 ? 0.5 : (1 - _dw / 72);
        if(wv > 0.03) Audio.wallClang(wv);
        else if(wv <= 0.03 && _dw < 145) Audio.wallClang(0.03);
      } catch(e){}
    }
  }

  _onShellHitTank(shell, tank){
    if(shell.dead) return;
    if(tank === shell.owner && shell.life > (shell.owner.def.shellRange/shell.speed) - 0.30) return;
    if(shell.owner && shell.owner.team && tank.team && shell.owner.team === tank.team) return;
    shell._hitByPhysics = true;
    // Sync position from physics body for accurate collision point
    if(shell._physBody){
      var t = shell._physBody.translation();
      shell.x = t.x; shell.y = t.y; shell.z = t.z;
    }
    if(tank === shell.owner && shell.life > (shell.owner.def.shellRange/shell.speed) - 0.30) return;
    var armor = tank.def.armor;
    if(armor && shell._tryRicochet(tank, this)){
      // Shell bounced - update physics body to match reflected state
      if(shell._physBody){
        shell._physBody.setTranslation({x: shell.x, y: shell.y, z: shell.z}, true);
        shell._physBody.setLinvel({x: shell.dir.x * shell.speed, y: 0, z: shell.dir.z * shell.speed}, true);
      }
      /* Sparks fly along the REFLECTED path: the spark cone follows where the
         round is now going, which is exactly where the eye already is looking
         because it just watched the shot arrive. */
      if(typeof SparkLines !== 'undefined' && this.scene){
        SparkLines.spawn(this.scene, shell.x, Math.max(0.6, shell.y), shell.z,
          shell.dir ? shell.dir.x : 0, shell.dir ? shell.dir.z : 0, {count: 10, speed: 12});
      }
      /* The metal ping - the sound that says "we have armor tonight". Same
         distance rule as every other battle sound: loud near you, faint far
         away, silent across the map. */
      if(window.Audio && Audio.ricochet && !this._noParticles){
        try {
          var _ltr = this.localTank;
          var _dr = _ltr ? Math.hypot(_ltr.x - shell.x, _ltr.z - shell.z) : -1;
          var rv = _dr < 0 ? 0.5 : (1 - _dr / 78);
          if(rv > 0.04) Audio.ricochet(rv);
          else if(_dr < 165) Audio.ricochet(0.04);
        } catch(e){}
      }
      return;
    }
    /* A SPLASH ROUND BURSTS ON THE TANK, it does not tickle it.

       Without this a shell carrying `splashDamage` did full point damage to
       whatever it hit and nothing to anybody standing next to it Ã¢â‚¬â€ the blast
       radius existed on the def and applied only to shells that happened to
       reach _detonate (the artillery arc). Grom is direct-fire: it hits a tank
       head-on and stops there, so it would have been a normal bullet with a
       splash number attached to it, which is the opposite of what it is for.

       So a splash shell hands the hit to _detonate at the impact point and lets
       the radius do the work Ã¢â‚¬â€ the tank it struck plus everything inside 5m of
       it, which at Grom's 1.5x-smaller-than-mortar blast is two or three tanks
       at most. Ballistics and shotgun pellets are excluded: a pellet has no
       splash of its own, and the mortar already reaches this path through its
       own arc. */
    if(shell.splashDamage > 0 && !shell._isShotgunPellet && !shell._isMortar){
      shell._detonate(this);
      return;
    }
    tank.takeDamage(shell.damage, shell.owner, this);
    this._tankHitVfx(tank, shell.dir.x, shell.dir.z, 0xffaa40);
    shell.dead = true;
  }

  /* Trajectory / aim line: main line + optional 10m markers (professional) */
  _initAimLine(){
    // The line is a ribbon (a strip of quads), not a 1px THREE.Line: only a
    // strip can get a real width, fade, break into dashes and taper to a point.
    // 4-component vertex colours give per-position alpha, which three.js turns
    // on automatically when the colour attribute has itemSize 4.
    const MAXSEG = 480;                       // ribbon quads it can ever hold
    this._aimMaxSeg = MAXSEG;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXSEG * 6 * 3), 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(MAXSEG * 6 * 4), 4));
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, transparent: true,
      opacity: this.settings.aimLineOpacity,
      depthTest: false, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    });
    this.aimLine = new THREE.Mesh(geo, mat);
    this.aimLine.visible = false;
    this.aimLine.frustumCulled = false;
    this.aimLine.renderOrder = 998;
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

    // Mode 2 flight-path chevrons: small '>' sprites that MARCH along the
    // line toward the crosshair. Built once, positioned every frame.
    this._initAimChevrons();

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

  /* MODE 2 CHEVRONS. Six '>' marks riding the flight-path line, moving
     continuously toward the crosshair so the line reads as a stream rather
     than a static ruler. Texture is drawn once on a canvas because a THREE
     line primitive can't be wider than 1 px; sprites give the marks real
     size and smooth scale-ups during the "gun is lagging" glow. */
  _initAimChevrons(){
    this._aimChevrons = [];
    try {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      g.strokeStyle = '#ffffff'; g.lineWidth = 8; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(20, 14); g.lineTo(44, 32); g.lineTo(20, 50);
      g.stroke();
      this._aimChevronTex = new THREE.CanvasTexture(c);
    } catch(e){ return; }
    const n = 12;
    for(let i = 0; i < n; i++){
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._aimChevronTex, transparent: true, depthTest: false, depthWrite: false,
        color: 0xffffff, opacity: 0.3,
      }));
      spr.visible = false;
      spr.renderOrder = 999;
      spr.frustumCulled = false;
      this.scene.add(spr);
      this._aimChevrons.push(spr);
    }
    this._chevSpan = 0.08;      // fraction Of the line one chevron's segment covers
    this._chevPhase = 0;        // running offset, advanced every frame
  }

  /* Position/update the chevrons. Called every frame from _updateAimLine Ã¢â‚¬â€
     they must keep marching even on frames where the ribbon itself skips a
     rebuild because the aim has not moved.

     `glow` is the 0..1 "gun is still turning" factor: while it is up, the
     chevrons grow, brighten and the ribbon pushes to full opacity so the
     player sees the line is live but not yet loyal. */
  _updateAimChevrons(endPos, glow){
    const list = this._aimChevrons;
    if(!list) return;
    if(!endPos || this.cameraMode !== 'strategic' || !this.aimLine || !this.aimLine.visible){
      list.forEach(s => { s.visible = false; });
      return;
    }
    const t = this.localTank;
    if(!t || !t.alive){ list.forEach(s => { s.visible = false; }); return; }
    const m = t.muzzle();
    const ax = endPos.x - m.pos.x, az = endPos.z - m.pos.z;
    const L = Math.hypot(ax, az);
    if(L < 4){ list.forEach(s => { s.visible = false; }); return; }
    const ux = ax / L, uz = az / L;
    /* The stream lives in the middle band of the line: it starts past the
       muzzle flare and stops before the crosshair, so neither the explosion
       nor the target hides under a mark. */
    const start = 0.14, end = 0.86;
    const span = (end - start) * L;
    const n = list.length;
    const T = performance.now() / 1000;
    // 8 m/s toward the crosshair; wraps so the stream never runs dry.
    const drift = (T * 8) % (span / n);
    const baseOp = Math.max(0.25, (this.settings && this.settings.aimLineOpacity) || 0.3);
    const op = Math.min(1, baseOp * (1 + 1.4 * glow) + 0.08);
    const scl = 1.35 + 0.9 * glow;
    for(let i = 0; i < n; i++){
      const s = list[i];
      const f = start + ((i / n) * (end - start) + (drift / span)) % ((end - start));
      const x = m.pos.x + ux * f * L;
      const z = m.pos.z + uz * f * L;
      s.position.set(x, Math.max(0.8, m.pos.y), z);
      s.scale.set(scl, scl, 1);
      /* Face the camera and point ALONG the line: sprite quad stays square,
         the '>' itself is drawn 90Ã‚Â°-rotated in the texture so travel direction
         is unambiguous from above. */
       // Chevrons only appear when gun is ALIGNED with crosshair (low glow).
       if(glow > 0.15) {
         s.visible = false;
         continue;
       }
       s.material.color.setRGB(1, 1, 1);
       s.material.opacity = op;
       s.visible = true;
      }
    }

  /* THE SPREAD GUN'S AIM TRIANGLE.

     Two edges from the muzzle out to the extremes of the weapon's own
     `pelletSpread`, closed by a far edge at `shellRange`. The half-angle is
     `pelletSpread` Ã¢â‚¬â€ the SAME value `spawnShot` uses to place each pellet Ã¢â‚¬â€ so
     the wedge is the shot rather than an artist's impression of it, and
     retuning the spread moves the outline in the same commit that moves the
     bullets.

     It is a separate, much cheaper mesh from the ribbon: three straight edges
     instead of a 480-segment camera-facing strip, rebuilt only when the guard
     says the aim has actually moved. Left visible underneath is the ordinary
     centre line, so the player still gets the range along the barrel and the
     wedge on top of it. */
  _buildSpreadCentreRibbon(t, pos){
    /* Pellet shells fly to the same ~500 m ceiling as every other direct
       shot now, so the drawn wedge reaches it too. */
    const CAP = (typeof CONFIG !== 'undefined' && CONFIG.SHELL_MAX_RANGE) || 500;
    const R = Math.max(t.def.shellRange || 0, CAP);
    const pts = [];
    const N = 24;
    for(let i = 0; i <= N; i++){
      const f = i / N;
      pts.push({ x: pos.x + (t.muzzle().dir.x * R) * f,
                 y: pos.y,
                 z: pos.z + (t.muzzle().dir.z * R) * f,
                 d: R * f });
    }
    this._buildAimRibbon(pts, R);
    this.aimLine.visible = true;
  }

  _drawSpreadAim(t, pos){
    if(!this._spreadAim){
      const g = new THREE.BufferGeometry();
      /* 4 verts = a triangle fan: apex at the muzzle, then the two near corners
         and the two far corners as a strip. Six indices closes both edges and
         the base. */
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const m = new THREE.MeshBasicMaterial({
        color: (t.def.pelletGlow || 0xffee44),
        transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
      });
      this._spreadAim = new THREE.Mesh(g, m);
      this._spreadAim.frustumCulled = false;
      this._spreadAim.renderOrder = 997;
      this._spreadEdges = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute('position',
          new THREE.BufferAttribute(new Float32Array(3 * 2 * 3), 3)),
        new THREE.LineBasicMaterial({
          color: (t.def.pelletGlow || 0xffee44),
          transparent: true, opacity: 0.85, depthWrite: false,
        })
      );
      this._spreadEdges.frustumCulled = false;
      this._spreadEdges.renderOrder = 998;
      this.scene.add(this._spreadAim);
      this.scene.add(this._spreadEdges);
    }
    const d = t.muzzle().dir;
    const mid = Math.atan2(d.x, d.z);
    const half = t.def.pelletSpread;
    const R = t.def.shellRange;
    const y = Math.max(0.35, pos.y - 0.25);   // sat on the deck, not at the bore
    const at = (a, r) => ({ x: pos.x + Math.sin(a) * r, z: pos.z + Math.cos(a) * r });
    const l = at(mid - half, R), rr = at(mid + half, R);

    const p = this._spreadAim.geometry.attributes.position.array;
    /* Two triangles: apex-left-far, apex-right-far. */
    const put = (i, x, y2, z) => { p[i*3] = x; p[i*3+1] = y2; p[i*3+2] = z; };
    put(0, pos.x, y, pos.z);
    put(1, l.x, y, l.z);
    put(2, rr.x, y, rr.z);
    put(3, pos.x, y, pos.z);
    put(4, rr.x, y, rr.z);
    put(5, l.x, y, l.z);
    this._spreadAim.geometry.attributes.position.needsUpdate = true;
    this._spreadAim.geometry.computeBoundingSphere();

    const e = this._spreadEdges.geometry.attributes.position.array;
    const edge = (i, ax, az, bx, bz) => {
      e[i*6] = ax; e[i*6+1] = y; e[i*6+2] = az;
      e[i*6+3] = bx; e[i*6+4] = y; e[i*6+5] = bz;
    };
    edge(0, pos.x, pos.z, l.x, l.z);
    edge(1, pos.x, pos.z, rr.x, rr.z);
    edge(2, l.x, l.z, rr.x, rr.z);
    this._spreadEdges.geometry.attributes.position.needsUpdate = true;
    this._spreadEdges.geometry.computeBoundingSphere();
    this._spreadAim.visible = true;
    this._spreadEdges.visible = true;
    this._spreadAimOwner = t.def.id;
  }

  _buildAimRibbon(pts, range, styleOverride){
    const geo = this.aimLine.geometry;
    const pos = geo.attributes.position.array;
    const col = geo.attributes.color.array;
    const MAX = this._aimMaxSeg || 480;
    const style = styleOverride || (this.settings && this.settings.aimLineStyle) || 'fade';
    const cam = this.camera;
    const cssH = (this.renderer && this.renderer.domElement && this.renderer.domElement.clientHeight)
                 || window.innerHeight || 900;
    const tanHalf = Math.tan((cam.fov || 50) * Math.PI / 360);
    // Thickness in screen pixels, per aim-line style. Scaled to 1/1.5 of the
    // old widths on request: the line reads as a guide, not a road marking.
    const BASE_PX = { fade:1.6, breakup:1.6, taper:3, dots:2.3, zigzag:1.6, wedge:3.3, pulse:2, mortar:7.5 };
    const basePx = BASE_PX[style] || 3.3;
    const R = Math.max(1, range);
    const cpx = cam.position;

    // alpha + width multiplier for a point `d` metres down the line
    const styleAt = (d) => {
      if(d < 0) return {a:1, w:1};
      if(style === 'breakup'){
        if(d <= 50) return {a:1, w:1};
        const k = Math.min(1, (d - 50) / 15);
        const ph = ((d - 50) % 4) / 4;            // 4 m dashes
        if(ph > 0.60) return {a:0, w:1};          // ...with a gap
        const soft = Math.min(1, ph / 0.10, (0.60 - ph) / 0.10);
        return {a:(0.95 - 0.78*k*k) * soft, w: 1 - 0.5*k};
      }
      if(style === 'taper'){
        // the THINNING is the point: stays bright so you can watch it narrow
        const k = Math.min(1, d / R);
        let a = 1 - 0.35 * Math.pow(k, 1.8);
        if(d > 50) a *= 1 - 0.30 * Math.min(1, (d - 50) / 15);
        return {a, w: 0.10 + 0.90 * Math.pow(1 - k, 1.15)};   // 9 px -> ~1 px
      }
      // --- new shapes: all of them shape the line from 0 m onwards ---
      if(style === 'dots'){
        const k = Math.min(1, d / R);
        const ph = d % 4;                          // a dot every 4 m, from 0 m
        if(ph > 1.5) return {a:0, w:1};            // ...with a gap
        const soft = Math.min(1, ph / 0.35, (1.5 - ph) / 0.35);
        let a = (1 - 0.28*k*k) * soft;
        if(d > 55) a *= 1 - 0.55 * Math.min(1, (d - 55) / 10);
        return {a, w:1};
      }
      if(style === 'wedge'){
        const k = Math.min(1, d / R);
        let a = 1;
        if(d > 55) a = 1 - 0.45 * Math.min(1, (d - 55) / 10);
        return {a, w: 0.14 + 0.86 * Math.pow(k, 0.85)};   // pinched at the muzzle
      }
      if(style === 'pulse'){
        const wave = ((performance.now()/1000 * 34) % (R + 26)) - 13;   // travelling charge
        const g = Math.exp(-Math.pow((d - wave) / 5.5, 2));
        let a = 0.82 + 0.18 * g;      // line never disappears - the crest only brightens
        if(d > 55) a *= 1 - 0.45 * Math.min(1, (d - 55) / 10);
        return {a, w: 0.80 + 0.75 * g};   // ~4.8 px resting, ~9 px at the crest
      }
      if(style === 'zigzag'){                      // solid, wavy - shape handled below
        if(d <= 50) return {a:1, w:1};
        const k = Math.min(1, (d - 50) / 15);
        return {a: 1 - 0.85*k*k, w:1};
      }
      /* MORTAR: a solid white wedge, pinched at the muzzle and widest at the
         impact point, so the line itself opens out into the blast circle
         instead of stopping dead at its edge. Alpha stays 1 the whole way: a
         faded or dotted arc cannot show an apex, and the apex is the thing the
         player is judging when they decide whether the shot clears the rock. */
      if(style === 'mortar'){
        const km = Math.min(1, Math.max(0, d / R));
        return {a: 1, w: 0.10 + 0.90 * Math.pow(km, 0.75)};
      }
      // fade (default)
      if(d <= 50) return {a:1, w:1};
      const k = Math.min(1, (d - 50) / 15);
      return {a: 1 - 0.90*k*k, w: 1 - 0.30*k};
    };

    let v = 0, segs = 0;
    const V = (x, y, z, a) => {
      pos[v*3] = x; pos[v*3+1] = y; pos[v*3+2] = z;
      col[v*4] = 1; col[v*4+1] = 1; col[v*4+2] = 1; col[v*4+3] = a;
      v++;
    };

    for(let i = 0; i < pts.length - 1 && segs < MAX; i++){
      const p0 = pts[i], p1 = pts[i+1];
      const ex = p1.x - p0.x, ez = p1.z - p0.z;
      const len = Math.hypot(ex, ez);
      if(len < 1e-4) continue;
      const n = Math.max(2, Math.min(200, Math.round(len / 0.4)));   // fine steps: shapes start at 0 m
      const pX = -ez / len, pZ = ex / len;        // horizontal perpendicular
      let pLx = 0, pLy = 0, pLz = 0, pRx = 0, pRy = 0, pRz = 0, pA = 0, hasPrev = false;
      for(let s = 0; s <= n && segs < MAX; s++){
        const t = s / n;
        const dd = p0.d + (p1.d - p0.d)*t;
        let x = p0.x + ex*t;
        const y = p0.y + (p1.y - p0.y)*t;
        let z = p0.z + ez*t;
        if(style === 'zigzag'){                    // the line itself waves sideways
          const off = Math.sin(dd * (Math.PI / 6.5)) * 1.5;
          x += pX * off; z += pZ * off;
        }
        const st = styleAt(dd);
        if(st.a <= 0.003){ hasPrev = false; continue; }      // dash gap: lift the pen
        const dc = Math.hypot(cpx.x - x, cpx.y - y, cpx.z - z);
        let hw = basePx * st.w * 0.5 * (2 * dc * tanHalf / cssH);
        if(hw > 3) hw = 3;                                   // sanity clamp
        const Lx = x + pX*hw, Lz = z + pZ*hw;
        const Rx = x - pX*hw, Rz = z - pZ*hw;
        if(hasPrev){
          // two triangles covering the quad prev->cur
          V(pLx, pLy, pLz, pA); V(pRx, pRy, pRz, pA); V(Rx, y, Rz, st.a);
          V(pLx, pLy, pLz, pA); V(Rx, y, Rz, st.a);  V(Lx, y, Lz, st.a);
          segs++;
        }
        pLx = Lx; pLy = y; pLz = Lz;
        pRx = Rx; pRy = y; pRz = Rz;
        pA = st.a;
        hasPrev = true;
      }
    }
    geo.setDrawRange(0, segs * 6);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  refreshAimLineStyle(){
    if(!this.aimLine) return;
    /* The mortar's line is forced white and opaque, so it must not be repainted
       with the player's colour every time the settings are touched Ã¢â‚¬â€ otherwise
       the override lasts only until the next slider move. */
    const mortar = !!(this.localTank && this.localTank.def &&
                      this.localTank.def.shellType === 'mortar');
    // In strategic mode, add glow effect when turret is lagging
    let aimOpacity = this.settings.aimLineOpacity;
    if(this.cameraMode === 'strategic' && this._aimLineGlow > 0.05) {
      // Boost opacity and shift toward orange when lagging
      aimOpacity = Math.min(1, aimOpacity * (1 + 0.5 * this._aimLineGlow));
    }
    this.aimLine.material.opacity = mortar ? 1 : aimOpacity;
    this.aimLine.material.color.set(mortar ? 0xffffff : this.settings.aimLineColor);
    if(this.aimMarkers){
      this.aimMarkers.material.opacity = this.settings.aimLineOpacity * 0.6;
      this.aimMarkers.material.color.set(this.settings.aimLineColor);
    }
    if(this._aimLabels){
      this._aimLabels.forEach(s=>s.material.opacity = this.settings.aimLineOpacity);
    }
  }

  /* Push the x-ray settings into the shared stripe material.

     Called on every settings save and once at scene setup, exactly like
     refreshAimLineStyle. Colour, opacity and pitch are uniforms and cost
     nothing; the style is baked into the shader as a compile-time branch, so it
     is the one that recompiles Ã¢â‚¬â€ hence setStyle() short-circuiting when it has
     not actually changed, which is what keeps a slider drag from stalling. */
  refreshXrayStyle(){
    if(typeof Xray === 'undefined' || !Xray) return;
    const s = this.settings || {};
    try {
      Xray.setStyle(s.xrayStyle);
      Xray.setColor(s.xrayColor || '#ffffff');
      Xray.setOpacity(s.xrayOpacity != null ? s.xrayOpacity : 0.92);
      /* gl_FragCoord is in device pixels, and the renderer already knows the
         ratio it is actually drawing at Ã¢â‚¬â€ read it from there rather than from
         devicePixelRatio, which lies whenever the renderer has capped it. */
      Xray.setPixelRatio(this.renderer ? this.renderer.getPixelRatio() : 1);
      if(this.renderer && this.renderer.getDrawingBufferSize){
        const v = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        Xray.setResolution(v.x, v.y);
      }
    } catch(e){}
  }

  _onResize(){
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth/innerHeight;
    this.camera.updateProjectionMatrix();
    /* The stripe pitch is in device pixels and the drawing buffer just changed
       size, so the WebGPU path's resolution uniform is stale without this. */
    this.refreshXrayStyle();
  }

  applySettings(s){
    this.settings = s;
    this.camMode = s.camMode || 'arrows';
    /* The two-mode camera owns the live cameraMode when it is on: re-derive
       it from the remembered stop so a settings save cannot strand the player
       in the wrong layout. When it is off, the stored preference wins as before. */
    this._staged = !(s && s.camTwoMode === false);
    if(this._staged){
      this._camStage = Math.max(0, Math.min(5,
        (typeof s.cameraStage === 'number' && s.cameraStage >= 0 && s.cameraStage <= 5) ? s.cameraStage|0 : 2));
      const stop = CONFIG.CAMERA_STOPS[this._camStage];
      this.cameraMode = (stop && stop.mode === 'strategic') ? 'strategic' : 'dynamic';
      if(stop && stop.mode === 'tp') this.camDist = stop.dist;
    } else {
      this.cameraMode = s.cameraMode || 'dynamic';
    }
    if(this.input){
      this.input.binds = s.binds;
      this.input.settings = s;
      this.input.resetCamSwipe();
    }
    this.refreshAimLineStyle();
    this.refreshXrayStyle();
    this.refreshViewRangeStyle();
    this.refreshViewRangeWidth();
    this.applyGraphicsSettings();
    this.camAngle = Math.PI + (s.camRotation || 0);
    // Tanki Online Dynamic: show crosshair + hide cursor when in dynamic mode
    this._updateCrosshair();
  }

  applyGraphicsSettings(){
    if(this._graphicsLocked) return;
    const q = this.settings.graphicsQuality;
    this.isFancy = q === 'fancy';
    /* ULTRA Ã¢â‚¬â€ the "everything on" tier, built to be run with WebGPU.
       Particle clouds (the sprite sparks/smoke/dust) are switched on here and
       nowhere else, the shader fireball is allowed to play, the muzzle gets
       its biggest size and the trails get more segments. */
    this.isUltra = q === 'ultra';
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this._maxPixelRatio = Math.min(devicePixelRatio, this.isUltra ? 3 : (this.isFancy ? 2 : 1.5));
    this.renderer.setPixelRatio(this._maxPixelRatio);
    this._applyParticlePolicy();
    if(this.world) this.world.setQuality(q);
    this._shadowDirty = true;
    this._graphicsLocked = true;
  }

  /* Ultra is the one tier that brings the sprite particle clouds back. The
     game modes switch particles OFF for their own reasons (Capture the Circle
     hides them, for one), so this is re-applied whenever the mode changes. */
  _applyParticlePolicy(){
    if(this.isUltra){
      this._noParticles = false;
      window.particleClouds = true;
    }
  }

  _updateCrosshair(){
    const crosshair = document.getElementById('crosshair');
    const isDynamic = this.cameraMode === 'dynamic';
    if(crosshair) crosshair.style.display = isDynamic ? '' : 'none';
    document.body.classList.toggle('crosshair-mode', isDynamic);
    /* MODE 2: the OS cursor is replaced by a crosshair sprite that follows the
       mouse. cursor:none is scoped to the canvas so open panels keep a cursor. */
    const strat = this.cameraMode === 'strategic';
    document.body.classList.toggle('strategic-mode', strat);
    if(strat){
      this._ensureStrategicReticle();
      if(this._stratReticle){
        this._stratReticle.style.display = '';
        this._stratReticle.style.left = (this.input.mouse.x || innerWidth/2) + 'px';
        this._stratReticle.style.top  = (this.input.mouse.y || innerHeight/2) + 'px';
      }
    } else if(this._stratReticle){
      this._stratReticle.style.display = 'none';
    }
  }

  /* MODE 2 CROSSHAIR. A small DOM reticle built once and parked in the DOM;
     mousemove only ever writes two style numbers, so there is nothing to
     recreate when the arena is torn down. The dead circle keeps the mouse
     pointed at, so it never blocks a click. */
  _ensureStrategicReticle(){
    if(!this._stratReticle || !document.body.contains(this._stratReticle)){
      const d = document.createElement('div');
      d.id = 'strategic-reticle';
      d.innerHTML = '<svg width="52" height="52" viewBox="0 0 52 52" style="filter:drop-shadow(0 0 3px rgba(0,0,0,.7))">'
        + '<circle cx="26" cy="26" r="15" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="2"/>'
        + '<line x1="26" y1="4"  x2="26" y2="12" stroke="rgba(255,255,255,.9)" stroke-width="2"/>'
        + '<line x1="26" y1="40" x2="26" y2="48" stroke="rgba(255,255,255,.9)" stroke-width="2"/>'
        + '<line x1="4"  y1="26" x2="12" y2="26" stroke="rgba(255,255,255,.9)" stroke-width="2"/>'
        + '<line x1="40" y1="26" x2="48" y2="26" stroke="rgba(255,255,255,.9)" stroke-width="2"/>'
        + '<circle cx="26" cy="26" r="2.6" fill="rgba(255,255,255,.95)"/>'
        + '</svg>';
      d.style.cssText = 'position:fixed;width:52px;height:52px;pointer-events:none;z-index:60;transform:translate(-50%,-50%);display:none;';
      document.body.appendChild(d);
      this._stratReticle = d;
      if(!this._stratRetMove){
        this._stratRetMove = (e) => {
          const r = this._stratReticle;
          if(r){ r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; }
        };
        document.addEventListener('mousemove', this._stratRetMove);
      }
    }
    return this._stratReticle;
  }

  setUseCustomMap(v){ this._useCustomMap = !!v; }

  setVotedMap(mapInfo){ this._votedMap = mapInfo || null; }

  /* The roster the matchmaker built for this game. Called BEFORE the mode
     starter so the spawner can put the real humans in and fill the rest with
     bots, instead of ignoring who the queue actually paired. */
  setMatchRoster(roster){
    this._matchRoster = (roster && roster.length) ? roster : null;
  }

  /* Human players from the roster, minus this client. Bots are excluded: the
     server pads the list with them and they are spawned locally anyway.

     READS THE ARMED COPY, NOT THE LIVE ONE.

     _matchRoster is the live field, and _resetArena() clears it -- but
     _armNetMode() restores it from _armedRoster immediately before the arena is
     built, and the arena build is ASYNCHRONOUS (it awaits the GLB). So by the
     time the spawn loops run, the live roster is whatever the last
     _resetArena() left: null. _rosterHumans() then returned [], every slot went
     to a bot, and the humans the server had just paired were dropped from their
     own match. _armedRoster is written once when the match forms and is never
     cleared until leaveToMenu, which is the only place it needs to be. */
  _rosterHumans(){
    const roster = this._armedRoster || this._matchRoster;
    if(!roster || !roster.length) return [];
    const me = (typeof Net !== 'undefined' && Net.myPeerId) ? Net.myPeerId : null;

    /* A CLIENT SPAWNS NOBODY FROM THE ROSTER.

       The roster is the HOST's list of who should be in the battle, and the host
       uses it to place a tank for each other player and drive it from their
       input. A client has no such job: every tank in its world arrives in the
       snapshots, and it simulates nothing itself.

       It used to spawn the roster anyway, which put a GHOST tank on the client
       for every other player -- a locally simulated tank with no input, frozen
       at its spawn point. Then the snapshots arrived for those same players, the
       id lookup found the ghost, and the ghost was corrected... but the host's
       own tank had been roster-spawned too under a different id than the host
       publishes, so a SECOND tank was created alongside it. The result was two
       tanks for the host, one of them never moving, which is what "I see his
       nickname but the movement is not syncing" looked like. */
    if(this.mode === 'client' || this._netRole === 'client') return [];

    return roster.filter(p => !p.isBot && p.peerId && p.peerId !== me);
  }

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
  async startSingleplayer(){
    this.mode='sp'; this._resetArena();
    const voted = this._votedMap;
    this._votedMap = null;

    /* Joining loads a whole map in. That used to happen with nothing on screen
       at all, so the menu simply vanished and the battlefield arrived a beat
       later. Now it gets the same loading screen as boot, and because boot
       already warmed the cache this is normally a fraction of a second. */
    BootLoading.show('Loading battlefield...', 10);

    /* Ã¢â‚¬â€but it has to be given a frame to actually appear. Building the map is
       synchronous and blocks the main thread for a few hundred milliseconds,
       so without this pause the whole job runs inside the same frame the
       screen was added and the browser never draws it Ã¢â‚¬â€ which is exactly what
       a loading screen that "doesn't show up" looks like from the outside.

       The timeout is not optional. requestAnimationFrame does NOT fire in a
       hidden or backgrounded tab, so waiting on it alone left the game stuck
       at 0% forever for anyone who clicked PLAY and then switched tabs. The
       timer races it, so the loading screen gets its chance to paint when the
       tab is visible and the game always moves on when it is not. */
    await new Promise(resolve => {
      let done = false;
      const go = () => { if(!done){ done = true; resolve(); } };
      requestAnimationFrame(() => requestAnimationFrame(go));
      setTimeout(go, 150);
    });

    let _spawnY = 5;
    const _finishSP = () => {
      BootLoading.set('Preparing tanks...', 75);
      try {
        const spawns = this._gladSpawnList();
        const localSp = spawns.length ? spawns.shift() : null;
        this._spawnLocal(localSp ? localSp.x : undefined, localSp ? localSp.z : undefined, localSp ? localSp.ry : undefined, _spawnY);
        for(let i=0;i<20;i++){
          const sp = spawns.length ? spawns.shift() : null;
          this._spawnBot(sp ? sp.x : undefined, sp ? sp.z : undefined, sp ? sp.ry : undefined, _spawnY);
        }
        this._spawnDummy();
      } catch(e){ console.warn('Spawn error:', e); }
      if(window.Menu && Menu.bumpStat) Menu.bumpStat('battles', 1);
      this._begin();
      BootLoading.set('Ready!', 100);
      BootLoading.hide(250);
    };

    if(voted && voted.glb){
      // hideDefaults() now runs inside loadGLBModel() once the GLB is ready Ã¢â‚¬â€
      // hiding it up front left nothing but void during the async load.
      this.world.size = 1000;
      this.world.half = 500;
      const scale = voted.scale || 80;
      this.world.loadGLBModel(voted.glb, scale).then((grp) => {
        if(grp){
          grp.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(grp);
          _spawnY = box.min.y + (box.max.y - box.min.y) * 0.65;
          /* Same reason as the two multiplayer modes: a map that declares its
             own boundary has to override the 500 set just above. */
          this._fitWorldToMap(box, voted);
        }
        _finishSP();
      }).catch(e => {
        console.warn('Voted GLB load:', e);
        _finishSP();
      });
    } else {
      try {
        var m = this._useCustomMap ? loadCustomMap() : null;
        if(!m) m = loadMainMap();
        if(!m && typeof DEFAULT_MAP !== 'undefined' && DEFAULT_MAP) m = DEFAULT_MAP;
        if(m) this.world.loadCustomMapData(m);
        else this.world._disposeGLBGroup();
      } catch(e){ console.warn('Map load error:', e); }
      _finishSP();
    }
  }

  /* ---------- GLADIATOR (battle royale, SP) ---------- */
  startGladiator(){
    this.mode='sp'; this._resetArena();
    const voted = this._votedMap;
    this._votedMap = null;
    const cfg = GAMEMODES.gladiator;

    /* A DECLARED BOUNDARY HAS TO BE APPLIED BEFORE _initGladiator.

       Unlike the other modes, gladiator reads world.half during init and keeps
       the result: _initGladiator turns it into the zone's chunk size, its
       minimum radius and the starting safe radius. Setting it after the map
       loads would leave the zone sized for a 500-unit arena while the player
       is standing in a 241-unit one -- chunks far larger than the map, and a
       "safe" circle that already covers everything.

       This is also the only reason the boundary is declared on the map entry
       rather than purely derived from the measured box: here it has to be
       known before there is a box to measure. */
    const declaredHalf = this._declaredWorldHalf(voted);
    if(declaredHalf){
      this.world.half = declaredHalf;
      this.world.size = declaredHalf * 2;
    }

    this._initGladiator();

    let _spawnY = 5;
    const _finishGlad = () => {
      const spawns = this._gladSpawnList();
      const localSp = spawns.length ? spawns.shift() : this.world.randomSpawn();
      this._spawnLocal(localSp.x, localSp.z, localSp.ry, _spawnY);
      for(let i=0;i<cfg.botCount;i++){
        const sp = spawns.length ? spawns.shift() : this.world.randomSpawn();
        this._spawnBot(sp.x, sp.z, sp.ry, _spawnY);
      }
      if(window.Menu && Menu.bumpStat) Menu.bumpStat('battles', 1);
      this._begin();
    };

    if(voted && voted.glb){
      // hideDefaults() now runs inside loadGLBModel() once the GLB is ready,
      // so the default arena stays as a backdrop during the async load
      // instead of leaving a blank void behind the HUD.
      //
      // The 1000/500 here is a placeholder for the load window, NOT a decision
      // about the arena: it used to overwrite the declared boundary set above,
      // which would leave _initGladiator's zone sized for 130 while the world
      // said 500. A map that declared a boundary keeps it.
      if(!declaredHalf){
        this.world.size = 1000;
        this.world.half = 500;
      }
      const scale = voted.scale || 80;
      this.world.loadGLBModel(voted.glb, scale).then((grp) => {
        if(grp){
          grp.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(grp);
          _spawnY = box.min.y + (box.max.y - box.min.y) * 0.65;
        }
        _finishGlad();
      }).catch(e => {
        console.warn('Voted GLB load:', e);
        _finishGlad();
      });
    } else {
      try {
        var m = this._useCustomMap ? loadCustomMap() : null;
        if(!m && typeof GLADIATOR_MAP !== 'undefined' && GLADIATOR_MAP) m = GLADIATOR_MAP;
        if(!m) m = loadMainMap();
        if(!m && typeof DEFAULT_MAP !== 'undefined' && DEFAULT_MAP) m = DEFAULT_MAP;
        if(m) this.world.loadCustomMapData(m);
        else this.world._disposeGLBGroup();
      } catch(e){ console.warn('Map load error:', e); }
      _finishGlad();
    }
  }

  /* ---------- SANDBOX, MULTIPLAYER (host your own room) ---------- */

  /* Load the map the sandbox host picked.

     This is the same sequence the battle paths use: fetch the GLB, keep the
     default ground as a backdrop, build trimesh physics off the geometry, derive
     a spawn height from the model's own box, then fit the world boundary to what
     actually loaded. The last step matters for stability more than it looks --
     without it the arena stays at the 500-unit default while the player is
     standing in a 241-unit map, so the safe-zone circle and the chunk sizes are
     sized for a world that is not there. Maps that declare their own boundary
     (the 'core' entry) get it honoured via _declaredWorldHalf. */
  async _loadSandboxMap(map){
    this._sandboxSpawnY = 0;
    if(!map || !map.glb){ console.warn('Sandbox: no map GLB'); return; }

    try { if(window.__mtlMark) window.__mtlMark('battle:load-map'); } catch(e){}
    if(window.Menu && Menu.showConnecting) Menu.showConnecting('Loading ' + (map.name || 'sandbox'));

    const declaredHalf = this._declaredWorldHalf(map);
    if(declaredHalf){ this.world.half = declaredHalf; this.world.size = declaredHalf * 2; }
    else { this.world.size = 1000; this.world.half = 500; }

    try{
      const grp = await this.world.loadGLBModel(map.glb, map.scale || 80);
      if(!grp){
        if(window.Menu && Menu.hideConnecting) Menu.hideConnecting();
        if(window.Menu && Menu.toast) Menu.toast('Failed to load the sandbox map');
        return;
      }
      this.world.showDefaults();
      this._sandboxBuildTrimesh(grp);
      grp.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(grp);
      const bottom = box.min.y;
      this._sandboxSpawnY = bottom + (box.max.y - bottom) * 0.65;
      this._fitWorldToMap(box, map);
    }catch(e){
      console.error('Sandbox map load error:', e);
      if(window.Menu && Menu.toast) Menu.toast('Error loading the sandbox map');
    }
    if(window.Menu && Menu.hideConnecting) Menu.hideConnecting();
  }

  /* Called by SandboxRoom for every player, host or guest, so there is exactly
     one code path into the arena and the host and the guests cannot diverge in
     how they got there. */
  async startSandboxMultiplayer(code, map, isHost){
    if(!code){ if(window.Menu && Menu.toast) Menu.toast('No room code'); return; }
    this._isSandbox = true;
    this._sandboxMap = map || null;

    if(isHost){
      await this.startHost({
        maxPlayers: 14,
        isPublic: false,
        fakePlayers: 0,
        code: code,
        gamemode: 'sandbox',
        sandboxMap: map
      });
    } else {
      this._sandboxSpawnY = 0;
      await this.startClient(code);

      /* startClient() deliberately disposes any GLB left over from a previous
         match and never loads one of its own, because in a normal join the map
         never changes. Here it does: the room can be on any of them. So the
         guest loads the host's map AFTER joining, not before -- loading it first
         would simply be thrown away one line later.

         This is safe to do on both sides independently because it is the same
         URL at the same scale in both arenas, which is the same reason the
         battle vote can pre-load a GLB on every client. */
      await this._loadSandboxMap(map);
      if(this.localTank){ this.localTank.maxHp = 9999; this.localTank.hp = 9999; }
    }
  }

  /* ---------- SANDBOX (GLB map + trimesh physics) ---------- */
  startSandbox(){
    this.mode = 'sp';
    this.world.size = 1000;
    this.world.half = 500;
    this._resetArena();

    this._physBodies.forEach(b => {
      try { this.physicsWorld.removeRigidBody(b); } catch(e){}
    });
    this._physBodies = [];
    this.physicsWorld.gravity = {x:0, y:-12, z:0};

    const glbUrl = 'assets/maps/TL_test.map.glb';
    const modelScale = 50;

    /* Map loading is the heaviest synchronous work in the game -- parse, texture
       budget, material rebuild, physics trimesh -- so a freeze is far more likely
       here than anywhere else. Labelling it means the watchdog panel points at
       the map load rather than at the last menu the player happened to open. */
    try { if(window.__mtlMark) window.__mtlMark('battle:load-map'); } catch(e){}

    this.world.loadGLBModel(glbUrl, modelScale).then(grp => {
      if(!grp){
        console.warn('Sandbox: failed to load GLB');
        Menu.toast('Failed to load sandbox map');
        return;
      }
      // This mode has always kept the default ground + lake under the test
      // platform (hideDefaults() used to run before _resetArena() undid it).
      // loadGLBModel() now hides them once the GLB is ready, so put them back.
      this.world.showDefaults();
      this._sandboxBuildTrimesh(grp);

      grp.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(grp);
      const center = box.getCenter(new THREE.Vector3());
      const modelBottom = box.min.y;
      const spawnY = modelBottom + (box.max.y - modelBottom) * 0.65;
      console.log('Sandbox spawn: center='+center.x.toFixed(1)+','+center.y.toFixed(1)+','+center.z.toFixed(1)+' modelBottom='+modelBottom.toFixed(1)+' spawnY='+spawnY.toFixed(1));

      this.camAngle = Math.PI + (this.settings.camRotation || 0);
      const def = TANKS[this.settings.selectedTank] || TANKS.coolbuddy;
      const localId = 'local';
      const t = new Tank(def, {
        id: localId, name: this.settings.playerName, isLocal: true,
        x: center.x, z: center.z, heading: Math.random() * 6,
        physicsWorld: this.physicsWorld, allowFall: true,
        startY: spawnY
      });
      this._finalizeTank(t);
      this.tanks.push(t);
      this.localTank = t;
      this.localTank.maxHp = 9999;
      this.localTank.hp = 9999;

      this._begin();
      this._matchStartDelay = 0;
    }).catch(err => {
      console.error('Sandbox GLB load error:', err);
      Menu.toast('Error loading sandbox map');
    });
  }

  /* WHICH SPAWN POINT YOU GET.
     ---------------------------------------------------------------------------
     Spawning was always index 0 for the local player, and humans took the next
     slots in order, so every battle put everybody in exactly the same place.
     That made two things worse than they had to be: the opening of every match
     was identical, and a player who had learned one map's first thirty seconds
     could rely on where everyone would be.

     The order is now SHUFFLED, and shuffled from the match seed rather than from
     Math.random. That is deliberate. Every client builds its own copy of the
     arena before the first snapshot lands, so a local RNG would place the host's
     tank at slot 3 on the host and slot 0 on that player's own screen Ã¢â‚¬â€ a
     visible teleport for the first second of every round. Deriving the order
     from the shared seed means host and clients agree exactly, and because the
     seed differs every battle, so does the arrangement.

     With no seed (a solo battle) it falls back to a genuine random shuffle,
     which is the case where the only audience is the player. */
  _shuffledSpawns(pool, salt){
    if(!pool || !pool.length) return pool || [];
    const idx = pool.map((_, i) => i);
    let s = this._spawnSeed(salt);
    for(let i = idx.length - 1; i > 0; i--){
      /* xorshift32: deterministic, seeded, and ample for a dozen spawn points. */
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      const j = s % (i + 1);
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    return idx.map(i => pool[i]);
  }

  /* ONE SEED FOR EVERY SPAWN DECISION IN THE MATCH, PLUS A SALT.

     Split out of _shuffledSpawns because the shuffle is no longer the only
     thing that needs randomness Ã¢â‚¬â€ choosing which SIDE each player fights on
     does too, and it has to be reproducible on both machines for the same
     reason. Two calls with the same salt get the same number, different salts
     get decorrelated numbers.

     THE AVALANCHE AT THE END IS NOT OPTIONAL. This started as a plain XOR:

         s = (seed ^ imul(salt + 1, 0x9E3779B1)) >>> 0;

     and it produced the same side for all 400 consecutive seeds tried. The
     reason is that XOR only ever touches the bits the two operands differ in,
     and the match seeds here are SMALL Ã¢â‚¬â€ a few hundred thousand Ã¢â‚¬â€ so they only
     ever varied the bottom dozen bits. The constant filled in the top twenty,
     and every draw therefore landed in the same narrow band. That is a coin
     flip that always comes up the same way: the shuffle looked random because
     it consumes the value differently, but the side never changed.

     The murmur3 finalizer below pushes every input bit through every output
     bit, so a one-bit change in the seed produces a completely different
     result. With it, 400 consecutive seeds split the two sides evenly. */
  _spawnSeed(salt){
    let s;
    if(typeof Net !== 'undefined' && Net.seed != null){
      s = (Net.seed ^ Math.imul((salt || 0) + 1, 0x9E3779B1)) >>> 0;
    } else {
      s = (Math.random() * 0xFFFFFFFF) >>> 0;
    }
    if(s === 0) s = 0x9E3779B9;
    /* murmur3 fmix32: the avalanche. */
    s ^= s >>> 16; s = Math.imul(s, 0x85EBCA6B) >>> 0;
    s ^= s >>> 13; s = Math.imul(s, 0xC2B2AE35) >>> 0;
    s ^= s >>> 16;
    return s >>> 0;
  }

  /* A single 0..1 draw from a salted seed, for "which side?" style choices. */
  _spawnRoll(salt){
    return (this._spawnSeed(salt) % 1000000) / 1000000;
  }

  /* ============================================================================
     WHICH SIDE DOES EVERYONE FIGHT ON Ã¢â‚¬â€ AND WHERE EXACTLY.

     THE MECHANIC, which is the one World of Tanks and every other spawn-based
     tank game uses:

         you spawn at a spawn point, and the side that spawn point is on IS
         your team.

     Not "you are blue because the code said blue, and here is a blue spawn".
     The team is a consequence of the position, which is why it works with any
     number of players and any map: two players can land on the same side and
     end up fighting each other, exactly as they should.

     WHAT IT REPLACES. The local player was hardcoded to blue:

         this.localTank.team = 'blue';
         const firstBlue = spawnBlue[0];

     So every match put you on the same side, at the same end of the same
     spawn list. Not only was every opening identical, it meant "am I blue or
     red" was decided before the map was even read, and a mode where the
     teams are supposed to be a coin flip never flipped.

     WHY IT STAYS IN SYNC ON BOTH MACHINES. Every client builds its own copy of
     the arena before the first snapshot arrives, so this cannot use
     Math.random(): the client would put itself somewhere the host did not put
     it, and would be visibly teleported on the first correction. All of it is
     derived from the match seed instead, which both sides already share, so
     host and client independently arrive at the same assignment.

     The roster order matters and is NOT shuffled: the host is always index 0,
     so "the first human in the list" means the same player on every machine.
     */
  _planTeamAssignments(bluePool, redPool, humanCount){
    const blue = (bluePool && bluePool.length) ? bluePool : null;
    const red  = (redPool  && redPool.length)  ? redPool  : null;

    /* A map with only one side marked: everybody is on it. */
    if(!red){ return { plan: this._fillPlan(blue, humanCount, 'blue'), counts:{ blue: humanCount + 1, red: 0 } }; }
    if(!blue){ return { plan: this._fillPlan(red, humanCount, 'red'), counts:{ blue: 0, red: humanCount + 1 } }; }

    /* First pass: the local player rolls for a side, then each human in roster
       order rolls for whichever side is emptier, so the lobby never ends up
       lopsided through bad luck. Ties go to the roll, so a 1-1 split of two
       players happens exactly half the time. */
    const plan = [];
    const counts = { blue: 0, red: 0 };
    const total = humanCount + 1;              /* humans plus the local player */

    for(let i = 0; i < total; i++){
      let side;
      if(i === 0){
        /* The local player's own coin flip. Salt 90, away from the spawn
           shuffles so this cannot correlate with them. */
        side = this._spawnRoll(90) < 0.5 ? 'blue' : 'red';
      } else {
        /* Everyone else goes to the emptier side; on a tie, they flip. */
        if(counts.blue !== counts.red) side = counts.blue < counts.red ? 'blue' : 'red';
        else side = this._spawnRoll(90 + i) < 0.5 ? 'blue' : 'red';
      }
      /* Respect the map's capacity: a side with fewer spawn points than
         players cannot take them all, so overflow goes across. */
      const room = (side === 'blue' ? blue : red).length;
      if(counts[side] >= room){
        const other = side === 'blue' ? 'red' : 'blue';
        if(counts[other] < (other === 'blue' ? blue : red).length) side = other;
      }
      plan.push(side);
      counts[side]++;
    }

    return { plan, counts };
  }

  /* Straightforward "everyone on this side" plan, for the one-sided maps. */
  _fillPlan(pool, humanCount, side){
    const plan = [];
    for(let i = 0; i < humanCount + 1; i++) plan.push(side);
    return plan;
  }

  /* ============================================================================
     WHICH COLOUR DOES THE PLAYER SEE A TEAM AS

     WORLD OF TANKS DOES IT THIS WAY, AND SO DO WE: YOUR team is always blue,
     theirs is always red. Not "blue if the map says blue" Ã¢â‚¬â€ always, for every
     player, in every match, whatever spawn point you took.

     WHY IT HAS TO BE RELATIVE RATHER THAN ABSOLUTE

     `team` is real and it matters: it decides who you can shoot, who counts as
     an assist, and which side wins. It is assigned by WHICH SPAWN POINT YOU
     TOOK (see _planTeamAssignments), so it genuinely can be 'red'. That is
     correct and none of it should change.

     What was wrong is that the presentation took that id at face value. Spawn
     on a red pad and the game then told you your team was red: the capture
     ring went red while YOUR side was winning, the TDM banner said
     "BLUE vs RED" with yours on the wrong end of it, and the results board
     titled your own team "Red team". Every one of those is a lie told by
     absolute colour, and the worst of them is the capture ring, because it is
     the biggest thing on screen and it changes colour as the score moves.

     The spawn pads KEEP their own red/blue. A pad is a fixed place on a fixed
     map and its colour is a property of that place, not of who is looking at
     it -- and it is a label, not a team indicator. Nothing about where you
     started should tell you what colour your team is.

     WHAT IS DELIBERATELY NOT TOUCHED

       * `t.team` itself. Assignment, win conditions, friendly fire, assists and
         the results screen's own left/right ordering all still read the real
         side, and all still work identically.
       * The spawn pad glows (see _makeSpawnPads) and the map editor's pad
         colour. See above: those are place labels.
       * Bot NAMES. "Blue Spot" stays "Blue Spot" for everyone. A name that
         changed colour depending on whose screen you were looking at would not
         be a name any more, and a scoreboard where your own ally is listed
         under a different heading to the one your enemy sees is worse than the
         problem being fixed.

     Presentation only, and per-client by construction: it reads only
     localTank.team, which every machine knows about its own tank, so no two
     clients need to agree about it. */
  _displaySide(teamId){
    const mine = (this.localTank && this.localTank.team) || 'blue';
    return teamId === mine ? 'blue' : 'red';
  }

  /* The colour for a team, as THIS player sees it. The one place a team is
     turned into a hex. The constants match the nameplate palette's allies /
     enemies (#3bbeff / #ff3b3b family) rather than inventing a third pair. */
  _displayColor(teamId){
    return this._displaySide(teamId) === 'blue' ? 0x4488ff : 0xff4444;
  }

  _clearSleepers(){
    if(!this._sleepers) return;
    for(const t of this._sleepers){
      const grp = t._sleepZ;
      t._sleepZ = null;
      t.sleeping = false;
      if(!grp) continue;
      if(grp.parent) grp.parent.remove(grp);
      if(grp.userData && grp.userData.ownsTexture){
        try { grp.userData.ownsTexture.dispose(); } catch(e){}
      }
      grp.traverse(o => { if(o.material) { try { o.material.dispose(); } catch(e){} } });
    }
    this._sleepers.clear();
  }

  /* ============================================================================
   A TANK WHOSE PLAYER IS NOT HERE
   ---------------------------------------------------------------------------
   When somebody closes their tab mid-battle the server keeps their place for a
   grace period rather than deleting them (see RECONNECT_GRACE_MS in
   server/mpserver.js). That leaves a tank standing in the arena with nobody
   driving it, which is worse than either extreme: it looks like a live opponent
   that never moves, and it never fires.

   So it goes to SLEEP. The visual language is borrowed from Tankionline, which is
   the closest browser game to this one: a slow floating "Z", the tank's engine
   note cut, and the whole thing greys out. It is deliberately legible at a
   glance across the map, because the useful information is "that one is not
   coming back" and that should not require driving over to check.

   Nothing gameplay-relevant changes. The tank keeps its health, it is still
   there to be shot at, and when the player returns the server says so and this
   is undone. Making it intangible instead would be a balance decision, and that
   is not one to smuggle in with a reconnect feature.
   ========================================================================== */
  _setTankAsleep(peerId, asleep){
    if(!peerId) return;
    const id = 'remote-' + peerId;
    let t = this.tanks.find(x => x.id === id);
    /* The host may not have spawned it yet (the player left during the vote). */
    if(!t){
      t = this.clientTanks && this.clientTanks[peerId];
      if(!t) return;
    }

    if(asleep){
      if(t._sleepZ) return;
      t.sleeping = true;
      t._sleepZ = this._makeSleepZ(t);
      if(!this._sleepers) this._sleepers = new Set();
      this._sleepers.add(t);
    } else {
      t.sleeping = false;
      if(t._sleepZ){
        if(t._sleepAnchor) t._sleepAnchor.removeFromParent();
        t._sleepAnchor = null;
        t._sleepZ = null;
      }
      if(this._sleepers) this._sleepers.delete(t);
    }
  }

  /* Three "Z" glyphs rising and fading on a loop, so a sleeping tank reads as
     asleep from any distance and any angle. Built once per tank and animated by
     the existing loop Ã¢â‚¬â€ no timer of its own to leak. */
  _makeSleepZ(tank){
    if(typeof THREE === 'undefined') return null;
    const grp = new THREE.Group();
    grp.renderOrder = 40;

    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    x.font = 'bold 44px system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = '#dfe9f7';
    x.shadowColor = 'rgba(0,0,0,.75)';
    x.shadowBlur = 6;
    x.fillText('Z', 32, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;

    for(let i = 0; i < 3; i++){
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
      }));
      s.userData.phase = i / 3;      /* staggered so they never pulse together */
      s.userData.baseScale = 0.5 + i * 0.22;
      grp.add(s);
    }
    /* The texture is shared by the three sprites, so it is disposed with the
       group rather than three times. */
    grp.userData.ownsTexture = tex;

    /* Parented to the SCENE, not the tank: a tank's own transform is driven by
       the physics body, and adding a child to it would put the Zs inside the
       hull and at the wrong scale. */
    this.scene.add(grp);
    tank._sleepAnchor = null;
    return grp;
  }

  _updateSleepZ(){
    if(!this._sleepers || !this._sleepers.size) return;
    for(const t of this._sleepers){
      const grp = t._sleepZ;
      if(!grp){ continue; }
      const bob = Math.sin(this.time * 0.9 + (t.x || 0) * 0.01) * 0.05;
      grp.position.set(t.x, (t.y || 0) + 2.3 + bob, t.z);
      for(const s of grp.children){
        const u = s.userData;
        const p = (u.phase + (this.time * 0.28)) % 1;
        s.position.set(p * 0.9, p * 1.5, p * 0.4);
        s.scale.setScalar(u.baseScale * (0.6 + p * 0.6));
        s.material.opacity = Math.sin(p * Math.PI) * 0.85;
      }
    }
  }

  /* ---------- TEAM DEATHMATCH (GLB map + 5v5 rounds) ---------- */
  startTeamDeathmatch(){
    if(this._tdmLoading) return; // guard: prevent re-entry while GLB loads
    this._tdmLoading = true;
    this.mode='sp';
    this.world.size = 1000;
    this.world.half = 500;
    this._resetArena();
    this._noParticles = true;
    this._applyParticlePolicy();
    this._tdmState = { blueScore:0, redScore:0, totalKills:0, round:1, blueRoundWins:0, redRoundWins:0, maxRounds:5, roundActive:true };
    try{ this._tankFavorites = JSON.parse(localStorage.getItem('tankFavorites') || '[]'); }catch(e){ this._tankFavorites = []; }

    this._physBodies.forEach(b => {
      try { this.physicsWorld.removeRigidBody(b); } catch(e){}
    });
    this._physBodies = [];
    this.physicsWorld.gravity = {x:0, y:-12, z:0};

    const loadingEl = document.getElementById('loading-overlay');
    if(loadingEl) loadingEl.classList.remove('hidden');

    const cfg = GAMEMODES.teamDeathmatch;
    /* HONOUR THE VOTED MAP.

       Team Deathmatch used to hardcode cfg.glbUrl and never look at
       _votedMap, so the vote screen was a lie in this mode: everyone voted,
       the winner was announced, and then both sides loaded the same default TDM
       map regardless. Capture the Circle already read _votedMap; this brings TDM
       in line so a voted map is actually played.

       Falls back to the mode's own map when nobody voted, and a map with no
       blue/red markers falls back too -- _parseGLBSpawns would otherwise find no
       spawns and the arena would start with every tank stacked at one point. */
    const voted = this._votedMap;
    this._votedMap = null;
    let glbUrl = cfg.glbUrl;
    let modelScale = cfg.glbScale;
    if(voted && voted.glb){
      glbUrl = voted.glb;
      modelScale = voted.scale || modelScale;
      this._votedMapId = voted.id;
    } else {
      this._votedMapId = null;
    }

    try { if(window.__mtlMark) window.__mtlMark('battle:load-map'); } catch(e){}

    /* Keep the loading screen honest about what is happening. The bar is
       driven from work that is genuinely in flight Ã¢â‚¬â€ the GLB fetch and parse,
       then the spawn-marker parse and the tank spawns Ã¢â‚¬â€ rather than being a
       fixed animation, so it does not sit at a number that means nothing. */
    const loadName = (voted && voted.name) || 'battlefield';
    try { if(typeof BootLoading !== 'undefined') BootLoading.set('Downloading ' + loadName, 35); } catch(e){}

    this.world.loadGLBModel(glbUrl, modelScale).then(grp => {
      if(!grp){
        console.warn('TDM: failed to load GLB');
        if(loadingEl) loadingEl.classList.add('hidden');
        try { if(typeof BootLoading !== 'undefined') BootLoading.hide(0); } catch(e){}
        Menu.toast('Failed to load team deathmatch map');
        return;
      }
      try { if(typeof BootLoading !== 'undefined') BootLoading.set('Placing spawns', 70); } catch(e){}

      // TDM historically rendered on the default ground/lake as well
      // (hideDefaults() ran before _resetArena() re-showed them). Keep that.
      this.world.showDefaults();
      this._sandboxBuildTrimesh(grp);
      grp.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(grp);
      const center = box.getCenter(new THREE.Vector3());
      const modelBottom = box.min.y;
      const spawnY = modelBottom + (box.max.y - modelBottom) * 0.65;
      this.world._tdmBox = box;

      /* FIT THE WORLD TO THE MAP THAT ACTUALLY LOADED. The map is passed so a
         map that declares its own boundary (see the 'core' entry) can override
         the 500 floor in _fitWorldToMap. */
      this._fitWorldToMap(box, voted);

      const spawns = this._parseGLBSpawns(grp, modelScale);
      this._tdmSpawns = spawns;

      let blueSpawns = spawns.filter(s => s.team === 'blue');
      let redSpawns = spawns.filter(s => s.team === 'red');

      if(!blueSpawns.length && !redSpawns.length){
        const teamSpawns = spawns.filter(s => s.team === null || s.team === undefined);
        if(teamSpawns.length >= 2){
          const half = Math.ceil(teamSpawns.length / 2);
          blueSpawns = teamSpawns.slice(0, half);
          redSpawns = teamSpawns.slice(half);
          blueSpawns.forEach(s => s.team = 'blue');
          redSpawns.forEach(s => s.team = 'red');
        }
      }

      if(!blueSpawns.length || !redSpawns.length){
        const hx = (box.max.x - box.min.x) / 2;
        const hz = (box.max.z - box.min.z) / 2;
        blueSpawns = [];
        redSpawns = [];
        for(let i = 0; i < (cfg.teamSize || 5); i++){
          blueSpawns.push({pos:{x:center.x - hx*0.3, y:spawnY, z:center.z - hz*0.3 + (i/(cfg.teamSize||5))*hz*0.6}, ry:0, team:'blue'});
          redSpawns.push({pos:{x:center.x + hx*0.3, y:spawnY, z:center.z - hz*0.3 + (i/(cfg.teamSize||5))*hz*0.6}, ry:Math.PI, team:'red'});
        }
      }

      this._tdmBlueSpawns = this._clampSpawnsToMap(blueSpawns, box, 14);
      this._tdmRedSpawns  = this._clampSpawnsToMap(redSpawns, box, 14);

      /* Shuffled, so the local player is not always at index 0 and humans do not
         always fill the first slots. Two different salts keep the two sides from
         sharing an arrangement. See _shuffledSpawns for why this comes from the
         match seed rather than Math.random. */
      const spawnBlue = this._shuffledSpawns(this._tdmBlueSpawns, 0);
      const spawnRed  = this._shuffledSpawns(this._tdmRedSpawns, 1);

      /* Real players first, so they claim spawn points ahead of the bots.

         CAPTURE THE CIRCLE HAS ALWAYS DONE THIS (see its equivalent block).
         Team Deathmatch never did: it went straight to filling both teams with
         bots, so a queued player was paired with a real human by the server and
         then had no tank at all. The human's tank only appeared if their socket
         happened to announce itself later, via _onClientJoin -- and even then
         they had no team. This is the mode where "I queued with a friend and we
         could not see each other" was reported most often. */
      const humans = this._rosterHumans();

      /* SIDE FIRST, THEN THE POINT ON THAT SIDE. See _planTeamAssignments: the
         team follows the spawn, as in World of Tanks, instead of being declared
         blue and then looked up. Index 0 is the local player, 1..n are the
         humans in roster order Ã¢â‚¬â€ which is the same order on every machine,
         because the host is always roster index 0. */
      const assign = this._planTeamAssignments(spawnBlue, spawnRed, humans.length);
      const mySide = assign.plan[0] || 'blue';
      const myPool = mySide === 'blue' ? spawnBlue : spawnRed;
      const mySpawn = (myPool && myPool[0]) || spawnBlue[0] || this._tdmBlueSpawns[0];

      const playerSpawnX = mySpawn.pos.x;
      const playerSpawnZ = mySpawn.pos.z;

      /* The camera looks from behind the tank toward the middle, so it starts
         opposite the spawn's own facing. A red spawn faces roughly +x, so the
         camera belongs on the +x side of it. */
      this.camAngle = (mySide === 'red' ? 0 : Math.PI) + (this.settings.camRotation || 0);
      const def = TANKS[this.settings.selectedTank] || TANKS.coolbuddy;
      const t = new Tank(def, {
        id:'local', name:this.settings.playerName, isLocal:true,
        x: playerSpawnX, z: playerSpawnZ, heading: mySpawn.ry || 0,
        physicsWorld:this.physicsWorld, allowFall:true, startY:spawnY
      });
      this._finalizeTank(t); this.tanks.push(t); this.localTank = t;
      this.localTank.team = mySide;
      this.localTank._spawnPos = {x: playerSpawnX, y: spawnY, z: playerSpawnZ};
      this.localTank._spawnHeading = (mySide === 'blue') ? 0 : Math.PI;
      this.localTank._drawHp();

      /* TEAM SIZE COMES FROM THE MAP, NOT THE MODE CONFIG.

         Both modes used cfg.teamSize (5), which silently threw away most of a
         map that was not built for 5v5. Kaukaz ships SEVEN blue and SEVEN red
         spawn points, and with the hardcoded 5 four of each were never used --
         the map looked emptier and smaller than it is, and half the geometry the
         player modelled played no part.

         So the map decides. teamSize is now the smaller of the two real spawn
         lists, which keeps the teams balanced, and cfg.teamSize is only the
         fallback for a map with no spawn markers at all. */
      const mapTeamSize = Math.min(blueSpawns.length, redSpawns.length);
      const teamSize = mapTeamSize > 0 ? mapTeamSize : (cfg.teamSize || 5);

      /* Real players first, so they claim spawn points ahead of the bots.

         CAPTURE THE CIRCLE HAS ALWAYS DONE THIS (see its equivalent block).
         Team Deathmatch never did: it went straight to filling both teams with
         bots, so a queued player was paired with a real human by the server and
         then had no tank at all. The human's tank only appeared if their socket
         happened to announce itself later, via _onClientJoin -- and even then
         they had no team. This is the mode where "I queued with a friend and we
         could not see each other" was reported most often. */
      let usedBlue = (mySide === 'blue') ? 1 : 0, usedRed = (mySide === 'red') ? 1 : 0;
      for(let i = 0; i < humans.length; i++){
        const side = assign.plan[i + 1] || 'blue';
        const pool = side === 'blue' ? spawnBlue : spawnRed;
        const sp = pool[(side === 'blue' ? usedBlue : usedRed) % pool.length] || spawnBlue[0];
        this._spawnRemoteHuman(humans[i], sp, spawnY, side);
        if(side === 'blue') usedBlue++; else usedRed++;
      }

      /* Fill whatever the humans did not take with bots, so the arena is always
         full and the team sizes stay balanced. */
      for(let i = usedBlue; i < teamSize; i++){
        const sp = spawnBlue[i % spawnBlue.length];
        this._spawnTDMBot(sp.pos.x, sp.pos.z, spawnY, 'blue');
      }
      for(let i = usedRed; i < Math.min(teamSize, redSpawns.length); i++){
        const sp = spawnRed[i % spawnRed.length];
        this._spawnTDMBot(sp.pos.x, sp.pos.z, spawnY, 'red');
      }
      this._spawnGlowRects(blueSpawns, redSpawns);

      setTimeout(() => {
        if(this.mode === null){ this._tdmLoading = false; return; }
        if(loadingEl) loadingEl.classList.add('hidden');
        this._tdmLoading = false;
        this._begin(true);
        Menu.toast('Team Deathmatch Ã¢â‚¬â€ Round 1 of ' + (this._tdmState.maxRounds) + ' Ã¢â‚¬â€ ' + teamSize + 'v' + teamSize);
      }, 300);
    }).catch(err => {
      this._tdmLoading = false;
      console.error('TDM GLB load error:', err);
      if(loadingEl) loadingEl.classList.add('hidden');
      try { if(typeof BootLoading !== 'undefined') BootLoading.hide(0); } catch(e){}
      Menu.toast('Error loading team deathmatch map');
    });
  }

  startCaptureTheCircle(){
    /* RE-ENTRY GUARD -- THIS IS THE "CHAOS" BUG.

       startTeamDeathmatch has had this guard for a long time. Capture the Circle
       did not, and it is the mode everything now routes through.

       The path into a battle has more than one trigger that can fire close
       together: the map-vote callback, the search-button fallback firing when
       the queue did not answer, and the mode card itself. Two of them landing
       together called this twice. Each call runs _resetArena() -- which tears
       down the previous arena and every tank in it -- and then starts an
       ASYNCHRONOUS GLB load. So the second call destroyed the first one's
       half-built world, both loads resolved into the same live scene, and the
       two sets of spawn points, tanks, bots and physics bodies interleaved.

       That is the visible chaos: duplicate tanks, props from two maps at once,
       a "Loading map..." spinner that never clears because one of the two
       callbacks hid it before the other needed it, and physics bodies pointing
       at geometry that no longer exists.

       _tdmLoading is the shared flag, so both modes now block each other too --
       starting one mode while another is loading cannot interleave. */
    if(this._tdmLoading) return;
    this._tdmLoading = true;
    /* A battle already running means this is a restart, not a fresh start. Tear
       it down explicitly rather than letting _resetArena() discover it. */
    if(this.running || (this.tanks && this.tanks.length)) this._resetArena();

    this.mode='sp';
    this._resetArena();
    this._noParticles = true;
    this._applyParticlePolicy();
    this._captureCircleMode = true;
    this._tdmState = { blueScore:0, redScore:0, totalKills:0, round:1, blueRoundWins:0, redRoundWins:0, maxRounds:5, roundActive:true };
    try{ this._tankFavorites = JSON.parse(localStorage.getItem('tankFavorites') || '[]'); }catch(e){ this._tankFavorites = []; }

    this._physBodies.forEach(b => {
      try { this.physicsWorld.removeRigidBody(b); } catch(e){}
    });
    this._physBodies = [];
    this.physicsWorld.gravity = {x:0, y:-12, z:0};

    const loadingEl = document.getElementById('loading-overlay');
    if(loadingEl) loadingEl.classList.remove('hidden');

    /* SAFETY NET FOR THE RE-ENTRY GUARD.

       The guard is set here and released by this load's own success and failure
       paths. If any of them is missed -- a new early return, an exception thrown
       mid-callback, a map that never resolves -- the player is locked out of
       every battle for the rest of the session: PLAY does nothing and no error
       is shown. That is far worse than the double-start this guard prevents,
       because it is silent and permanent.

       So the flag is also cleared unconditionally a few seconds later, and only
       if this start is still the one that owns it. A real map load finishes well
       inside this window (measured: 1-2s), so the net never fires in normal play
       -- it exists purely so a stuck state cannot become a bricked game. */
    this._battleStartToken = (this._battleStartToken || 0) + 1;
    const guardToken = this._battleStartToken;
    clearTimeout(this._guardSafetyTimer);
    this._guardSafetyTimer = setTimeout(() => {
      if(this._battleStartToken === guardToken) this._tdmLoading = false;
    }, 12000);
    /* Releasing the guard is also fine while the battle is legitimately running:
       the battle is already built by then, so nothing is left to guard. */
    this._releaseGuard = () => {
      clearTimeout(this._guardSafetyTimer);
      this._tdmLoading = false;
    };

    const voted = this._votedMap;
    this._votedMap = null;

    const cfg = GAMEMODES.captureTheCircle;
    let glbUrl, modelScale;
    if(voted && voted.glb){
      glbUrl = voted.glb;
      modelScale = voted.scale || 80;
      this.world.size = 1000;
      this.world.half = 500;
    } else {
      glbUrl = cfg.glbUrl;
      modelScale = cfg.glbScale;
      this.world.size = 1000;
      this.world.half = 500;
    }

    try { if(window.__mtlMark) window.__mtlMark('battle:load-map'); } catch(e){}

    /* Same progress reporting as Team Deathmatch Ã¢â‚¬â€ see the note there. */
    try {
      if(typeof BootLoading !== 'undefined'){
        BootLoading.set('Downloading ' + ((voted && voted.name) || 'battlefield'), 35);
      }
    } catch(e){}

    this.world.loadGLBModel(glbUrl, modelScale).then(grp => {
      /* EVERY exit from this callback must release the re-entry guard. The
         `!grp` path below used to return without doing so, and because
         _resetArena() no longer clears the flag, one failed map load locked the
         player out of every future battle -- worse than the double-start bug it
         was meant to fix. The safety net below covers every path including
         ones added later. */
      if(!grp){
        if(loadingEl) loadingEl.classList.add('hidden');
        this._tdmLoading = false;
        try { if(typeof BootLoading !== 'undefined') BootLoading.hide(0); } catch(e){}
        Menu.toast('Failed to load capture circle map');
        return;
      }

      this._sandboxBuildTrimesh(grp);
      grp.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(grp);
      const center = box.getCenter(new THREE.Vector3());
      const modelBottom = box.min.y;
      const spawnY = modelBottom + (box.max.y - modelBottom) * 0.65;
      this.world._tdmBox = box;

      /* FIT THE WORLD TO THE MAP THAT ACTUALLY LOADED. The map is passed so a
         map that declares its own boundary (see the 'core' entry) can override
         the 500 floor in _fitWorldToMap. */
      this._fitWorldToMap(box, voted);

      try { if(typeof BootLoading !== 'undefined') BootLoading.set('Placing spawns', 70); } catch(e){}

      const spawns = this._parseGLBSpawns(grp, modelScale);
      this._tdmSpawns = spawns;

      let blueSpawns = spawns.filter(s => s.team === 'blue');
      let redSpawns = spawns.filter(s => s.team === 'red');

      if(!blueSpawns.length && !redSpawns.length){
        const teamSpawns = spawns.filter(s => s.team === null || s.team === undefined);
        if(teamSpawns.length >= 2){
          const half = Math.ceil(teamSpawns.length / 2);
          blueSpawns = teamSpawns.slice(0, half);
          redSpawns = teamSpawns.slice(half);
          blueSpawns.forEach(s => s.team = 'blue');
          redSpawns.forEach(s => s.team = 'red');
        }
      }

      if(!blueSpawns.length || !redSpawns.length){
        const hx = (box.max.x - box.min.x) / 2;
        const hz = (box.max.z - box.min.z) / 2;
        blueSpawns = [];
        redSpawns = [];
        for(let i = 0; i < (cfg.teamSize || 5); i++){
          blueSpawns.push({pos:{x:center.x - hx*0.3, y:spawnY, z:center.z - hz*0.3 + (i/(cfg.teamSize||5))*hz*0.6}, ry:0, team:'blue'});
          redSpawns.push({pos:{x:center.x + hx*0.3, y:spawnY, z:center.z - hz*0.3 + (i/(cfg.teamSize||5))*hz*0.6}, ry:Math.PI, team:'red'});
        }
      }

      this._tdmBlueSpawns = this._clampSpawnsToMap(blueSpawns, box, 14);
      this._tdmRedSpawns  = this._clampSpawnsToMap(redSpawns, box, 14);

      /* Shuffled, so the local player is not always at index 0 and humans do not
         always fill the first slots. Two different salts keep the two sides from
         sharing an arrangement. See _shuffledSpawns for why this comes from the
         match seed rather than Math.random. */
      const spawnBlue = this._shuffledSpawns(this._tdmBlueSpawns, 0);
      const spawnRed  = this._shuffledSpawns(this._tdmRedSpawns, 1);

      const humans = this._rosterHumans();

      /* SIDE FIRST, THEN THE POINT ON THAT SIDE Ã¢â‚¬â€ same as Team Deathmatch.
         See _planTeamAssignments for why the team follows the spawn rather than
         being declared, and why this has to come from the match seed. */
      const assign = this._planTeamAssignments(spawnBlue, spawnRed, humans.length);
      const mySide = assign.plan[0] || 'blue';
      const myPool = mySide === 'blue' ? spawnBlue : spawnRed;
      const mySpawn = (myPool && myPool[0]) || spawnBlue[0] || this._tdmBlueSpawns[0];

      const playerSpawnX = mySpawn.pos.x;
      const playerSpawnZ = mySpawn.pos.z;

      this.camAngle = (mySide === 'red' ? 0 : Math.PI) + (this.settings.camRotation || 0);
      const def = TANKS[this.settings.selectedTank] || TANKS.coolbuddy;
      const t = new Tank(def, {
        id:'local', name:this.settings.playerName, isLocal:true,
        x: playerSpawnX, z: playerSpawnZ, heading: mySpawn.ry || 0,
        physicsWorld:this.physicsWorld, allowFall:true, startY:spawnY
      });
      this._finalizeTank(t); this.tanks.push(t); this.localTank = t;
      this.localTank.team = mySide;
      this.localTank._spawnPos = {x: playerSpawnX, y: spawnY, z: playerSpawnZ};
      // Capture the Circle sends you back to THIS heading on respawn too
      this.localTank._spawnHeading = mySpawn.ry || 0;
      this.localTank._drawHp();

      /* TEAM SIZE COMES FROM THE MAP. See the note in startTeamDeathmatch:
         Kaukaz has seven spawns a side and a hardcoded 5 discarded half of
         them. */
      const mapTeamSize = Math.min(blueSpawns.length, redSpawns.length);
      const teamSize = mapTeamSize > 0 ? mapTeamSize : (cfg.teamSize || 5);

      /* Real players first, so they claim spawn points ahead of the bots.
         The matchmaker pairs people in the same mode and pads the rest with
         bots; before this, those humans were discarded and every slot went to
         a bot, which is why two people pressing PLAY never saw each other even
         though the server had put them in the same match. */
      let usedBlue = (mySide === 'blue') ? 1 : 0, usedRed = (mySide === 'red') ? 1 : 0;
      for(let i = 0; i < humans.length; i++){
        const side = assign.plan[i + 1] || 'blue';
        const pool = side === 'blue' ? spawnBlue : spawnRed;
        const sp = pool[(side === 'blue' ? usedBlue : usedRed) % pool.length] || spawnBlue[0];
        this._spawnRemoteHuman(humans[i], sp, spawnY, side);
        if(side === 'blue') usedBlue++; else usedRed++;
      }

      /* Fill whatever the humans did not take with bots, so the arena is
         always full and team sizes stay balanced. */
      for(let i = usedBlue; i < teamSize; i++){
        const sp = spawnBlue[i % spawnBlue.length];
        this._spawnTDMBot(sp.pos.x, sp.pos.z, spawnY, 'blue');
      }
      for(let i = usedRed; i < Math.min(teamSize, redSpawns.length); i++){
        const sp = spawnRed[i % spawnRed.length];
        this._spawnTDMBot(sp.pos.x, sp.pos.z, spawnY, 'red');
      }
      this._spawnGlowRects(blueSpawns, redSpawns);

      // Init capture circle
      CaptureCircle.init(this);

      /* The async gap between "start" and here is exactly where a second start
         used to land. Bail if this load is no longer the current one: a newer
         _resetArena will have nulled the mode. */
      setTimeout(() => {
        if(this.mode === null){
          if(loadingEl) loadingEl.classList.add('hidden');
          this._tdmLoading = false;
          return;
        }
        if(loadingEl) loadingEl.classList.add('hidden');
        this._tdmLoading = false;
        this._begin(true);
        Menu.toast('Capture the Circle Ã¢â‚¬â€ ' + teamSize + 'v' + teamSize + ' Ã¢â‚¬â€ Stand in the circle to capture!');
      }, 300);
    }).catch(err => {
      console.error('Capture Circle GLB load error:', err);
      if(loadingEl) loadingEl.classList.add('hidden');
      this._tdmLoading = false;
      try { if(typeof BootLoading !== 'undefined') BootLoading.hide(0); } catch(e){}
      Menu.toast('Error loading capture circle map');
    });
  }

  /* ============================================================================
     BASE DEFEND
     ---------------------------------------------------------------------------
     A clone of startCaptureTheCircle, deliberately.

     Those two modes agree on almost everything that matters here: two teams, a
     map with blue and red spawn markers, NO round structure, and UNLIMITED
     respawns at your own spawn point. Base Defend differs only in the win
     condition Ã¢â‚¬â€ a destructible base per side instead of a capture percentage Ã¢â‚¬â€
     so starting from the Circle's starter means the parts that took the longest
     to get right (the re-entry guard, the map-driven team sizing, humans
     claiming spawns before bots, network arming) come along already working.

     WHAT IS DIFFERENT, and it is all in the tail: CaptureCircle.init() is not
     called, BaseDefend.init() is, and the mode is flagged so _update() runs the
     respawn loop and _onTDMKill does not end a round.

     The base positions come from the map, not from here. See
     World.loadGLBModel's base branch for the naming convention, and
     BaseDefend.init for what happens on a map that ships no base at all. */
  startBaseDefend(){
    /* The shared re-entry guard. See the long note in startCaptureTheCircle:
       _tdmLoading is shared by every battle mode, so this also blocks a Base
       Defend started on top of a Circle that is still loading. */
    if(this._tdmLoading) return;
    this._tdmLoading = true;
    if(this.running || (this.tanks && this.tanks.length)) this._resetArena();

    this.mode='sp';
    this._resetArena();
    this._noParticles = true;
    this._applyParticlePolicy();
    this._baseDefendMode = true;
    /* roundActive stays true for the whole match: the void kill and the "is
       anybody left" bookkeeping both read it, and a Base Defend match has no
       rounds to deactivate. The round COUNTERS stay at zero and are never shown
       Ã¢â‚¬â€ _onTDMKill returns early for this mode, so nothing increments them. */
    this._tdmState = { blueScore:0, redScore:0, totalKills:0, round:1, blueRoundWins:0, redRoundWins:0, maxRounds:5, roundActive:true };
    try{ this._tankFavorites = JSON.parse(localStorage.getItem('tankFavorites') || '[]'); }catch(e){ this._tankFavorites = []; }

    this._physBodies.forEach(b => {
      try { this.physicsWorld.removeRigidBody(b); } catch(e){}
    });
    this._physBodies = [];
    this.physicsWorld.gravity = {x:0, y:-12, z:0};

    const loadingEl = document.getElementById('loading-overlay');
    if(loadingEl) loadingEl.classList.remove('hidden');

    /* Same safety net as the Circle: if any exit path below is ever missed, the
       player would be locked out of every battle for the session. */
    this._battleStartToken = (this._battleStartToken || 0) + 1;
    const guardToken = this._battleStartToken;
    clearTimeout(this._guardSafetyTimer);
    this._guardSafetyTimer = setTimeout(() => {
      if(this._battleStartToken === guardToken) this._tdmLoading = false;
    }, 12000);
    this._releaseGuard = () => {
      clearTimeout(this._guardSafetyTimer);
      this._tdmLoading = false;
    };

    /* BASE DEFEND IGNORES THE VOTED MAP, AND THIS IS DELIBERATE.

       The other modes all take `_votedMap.glb` when there is one, and this used
       to as well. It was wrong for this mode specifically.

       Paperland is the only map in the game that ships `base` entities Ã¢â‚¬â€ the
       `bluebase` and `redbase001` nodes that World.loadGLBModel collects into
       _glbBases. Every other map has none, so Base Defend on any of them falls
       back to _resolvePlacements() guessing two positions off the spawn
       clusters. The mode still runs Ã¢â‚¬â€ the bases are placed, they take damage,
       they can be destroyed Ã¢â‚¬â€ but the objective is somewhere the level designer
       never put it, and it can land behind cover or inside geometry.

       So a vote in Base Defend is a vote for an ARENA, and the objectives belong
       to the map built to have them. The vote is still shown, still counted and
       still recorded in the results; it just does not decide this map.

       The voted map is still cleared (`this._votedMap = null`) and still passed
       to _fitWorldToMap below, because that call needs to know whether the world
       bounds were authored for this map or derived Ã¢â‚¬â€ and the fallback path
       below derives them from paperland's own cfg.glbScale, which is a declared
       worldHalf away from the hardcoded 500 that used to be applied here. */
    const voted = this._votedMap;
    this._votedMap = null;

    const cfg = GAMEMODES.baseDefend;
    /* The mode's own map, always. `voted` is kept only for _fitWorldToMap. */
    const glbUrl = cfg.glbUrl;
    const modelScale = cfg.glbScale;

    /* The map _fitWorldToMap is told about must be the map we ACTUALLY load.

       It takes a `map` argument purely to read that map's declared worldHalf
       (see _declaredWorldHalf). Passing `voted` Ã¢â‚¬â€ the arena, not paperland Ã¢â‚¬â€
       would size paperland's world boundary from the wrong model: vote Core II
       and paperland would be governed by Core II's 286, vote Dream (which
       declares none) and the floor would put it at 500, twice its own size. So
       the mode's own config entry is passed instead, which is where paperland's
       worldHalf is now declared.

       `voted` stays in scope for the results screen and is untouched. */
    const mapForBounds = { id: 'baseDefend', worldHalf: cfg.worldHalf };

    try { if(window.__mtlMark) window.__mtlMark('battle:load-map'); } catch(e){}
    try {
      if(typeof BootLoading !== 'undefined'){
        /* The map being downloaded is Paperland, NOT the voted arena. It used to
           print the voted name while fetching a different file, so the loading
           screen named a map you were not on. */
        BootLoading.set('Downloading ' + (cfg.name || 'battlefield'), 35);
      }
    } catch(e){}

    this.world.loadGLBModel(glbUrl, modelScale).then(grp => {
      if(!grp){
        if(loadingEl) loadingEl.classList.add('hidden');
        this._tdmLoading = false;
        try { if(typeof BootLoading !== 'undefined') BootLoading.hide(0); } catch(e){}
        Menu.toast('Failed to load base defend map');
        return;
      }

      this._sandboxBuildTrimesh(grp);
      grp.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(grp);
      const center = box.getCenter(new THREE.Vector3());
      const modelBottom = box.min.y;
      const spawnY = modelBottom + (box.max.y - modelBottom) * 0.65;
      this.world._tdmBox = box;

      /* Paperland's own boundary, not the voted arena's Ã¢â‚¬â€ see mapForBounds above.
         `voted` is NOT passed here: it is a different map with a different size,
         and _fitWorldToMap reads worldHalf off whatever it is given. */
      this._fitWorldToMap(box, mapForBounds);

      try { if(typeof BootLoading !== 'undefined') BootLoading.set('Placing spawns', 70); } catch(e){}

      const spawns = this._parseGLBSpawns(grp, modelScale);
      this._tdmSpawns = spawns;

      let blueSpawns = spawns.filter(s => s.team === 'blue');
      let redSpawns = spawns.filter(s => s.team === 'red');

      if(!blueSpawns.length && !redSpawns.length){
        const teamSpawns = spawns.filter(s => s.team === null || s.team === undefined);
        if(teamSpawns.length >= 2){
          const half = Math.ceil(teamSpawns.length / 2);
          blueSpawns = teamSpawns.slice(0, half);
          redSpawns = teamSpawns.slice(half);
          blueSpawns.forEach(s => s.team = 'blue');
          redSpawns.forEach(s => s.team = 'red');
        }
      }

      if(!blueSpawns.length || !redSpawns.length){
        const hx = (box.max.x - box.min.x) / 2;
        const hz = (box.max.z - box.min.z) / 2;
        blueSpawns = [];
        redSpawns = [];
        for(let i = 0; i < (cfg.teamSize || 5); i++){
          blueSpawns.push({pos:{x:center.x - hx*0.3, y:spawnY, z:center.z - hz*0.3 + (i/(cfg.teamSize||5))*hz*0.6}, ry:0, team:'blue'});
          redSpawns.push({pos:{x:center.x + hx*0.3, y:spawnY, z:center.z - hz*0.3 + (i/(cfg.teamSize||5))*hz*0.6}, ry:Math.PI, team:'red'});
        }
      }

      this._tdmBlueSpawns = this._clampSpawnsToMap(blueSpawns, box, 14);
      this._tdmRedSpawns  = this._clampSpawnsToMap(redSpawns, box, 14);

      const spawnBlue = this._shuffledSpawns(this._tdmBlueSpawns, 0);
      const spawnRed  = this._shuffledSpawns(this._tdmRedSpawns, 1);

      const humans = this._rosterHumans();

      const assign = this._planTeamAssignments(spawnBlue, spawnRed, humans.length);
      const mySide = assign.plan[0] || 'blue';
      const myPool = mySide === 'blue' ? spawnBlue : spawnRed;
      const mySpawn = (myPool && myPool[0]) || spawnBlue[0] || this._tdmBlueSpawns[0];

      const playerSpawnX = mySpawn.pos.x;
      const playerSpawnZ = mySpawn.pos.z;

      this.camAngle = (mySide === 'red' ? 0 : Math.PI) + (this.settings.camRotation || 0);
      const def = TANKS[this.settings.selectedTank] || TANKS.coolbuddy;
      const t = new Tank(def, {
        id:'local', name:this.settings.playerName, isLocal:true,
        x: playerSpawnX, z: playerSpawnZ, heading: mySpawn.ry || 0,
        physicsWorld:this.physicsWorld, allowFall:true, startY:spawnY
      });
      this._finalizeTank(t); this.tanks.push(t); this.localTank = t;
      this.localTank.team = mySide;
      this.localTank._spawnPos = {x: playerSpawnX, y: spawnY, z: playerSpawnZ};
      this.localTank._spawnHeading = mySpawn.ry || 0;
      this.localTank._drawHp();

      const mapTeamSize = Math.min(blueSpawns.length, redSpawns.length);
      const teamSize = mapTeamSize > 0 ? mapTeamSize : (cfg.teamSize || 5);

      let usedBlue = (mySide === 'blue') ? 1 : 0, usedRed = (mySide === 'red') ? 1 : 0;
      for(let i = 0; i < humans.length; i++){
        const side = assign.plan[i + 1] || 'blue';
        const pool = side === 'blue' ? spawnBlue : spawnRed;
        const sp = pool[(side === 'blue' ? usedBlue : usedRed) % pool.length] || spawnBlue[0];
        this._spawnRemoteHuman(humans[i], sp, spawnY, side);
        if(side === 'blue') usedBlue++; else usedRed++;
      }

      for(let i = usedBlue; i < teamSize; i++){
        const sp = spawnBlue[i % spawnBlue.length];
        this._spawnTDMBot(sp.pos.x, sp.pos.z, spawnY, 'blue');
      }
      for(let i = usedRed; i < Math.min(teamSize, redSpawns.length); i++){
        const sp = spawnRed[i % spawnRed.length];
        this._spawnTDMBot(sp.pos.x, sp.pos.z, spawnY, 'red');
      }
      this._spawnGlowRects(blueSpawns, redSpawns);

      /* THE BASES. Built after the tanks, because the fallback placement reads
         the spawn clusters to work out which half of the map each side owns,
         and those lists only exist once the spawns are resolved.

         world._glbBases was filled by the base branch in loadGLBModel, which is
         the same traversal that ran just above. */
      BaseDefend.init(this, this.world._glbBases, {
        blueSpawns: this._tdmBlueSpawns,
        redSpawns:  this._tdmRedSpawns,
        box, spawnY,
      });
      /* A CLIENT MUST NOT DECIDE THE MATCH.

         Read from _netRole rather than from `this.mode`: every starter sets
         mode='sp' on its first line and only _begin() restores it, so at this
         point mode says 'sp' on a client too. _netRole was written by
         _armNetMode and is not cleared by _resetArena while the match is armed,
         so it is the only field here that actually knows.

         This is what stops a client whose shells land near a base from declaring
         a winner the host has not declared Ã¢â‚¬â€ the symptom being two results
         screens with different winners, or the client showing VICTORY while the
         match continues. */
      if(this._netRole === 'client') BaseDefend.setClient(true);

      setTimeout(() => {
        if(this.mode === null){
          if(loadingEl) loadingEl.classList.add('hidden');
          this._tdmLoading = false;
          return;
        }
        if(loadingEl) loadingEl.classList.add('hidden');
        this._tdmLoading = false;
        this._begin(true);
        Menu.toast('Base Defend Ã¢â‚¬â€ ' + teamSize + 'v' + teamSize + ' Ã¢â‚¬â€ Destroy the enemy base!');
      }, 300);
    }).catch(err => {
      console.error('Base Defend GLB load error:', err);
      if(loadingEl) loadingEl.classList.add('hidden');
      this._tdmLoading = false;
      try { if(typeof BootLoading !== 'undefined') BootLoading.hide(0); } catch(e){}
      Menu.toast('Error loading base defend map');
    });
  }

  _parseGLBSpawns(grp, scale){
    const spawns = [];
    grp.traverse(obj => {
      if(!obj.name) return;
      const lower = obj.name.toLowerCase();
      /* A BASE IS NOT A SPAWN POINT. `bluebase` matches the substring test
         below exactly as `blue` does, so without this the bases of a map like
         paperland are handed out as team spawns Ã¢â‚¬â€ a sixth spawn per side, with
         a respawning tank parked inside the thing you are supposed to be
         defending. Same regex and same reason as the base branch in
         World.loadGLBModel. */
      if(/^(?:(blue|red)[._-]?)?base[.\d]*$/.test(lower)) return;
      let team = null;
      if(lower.includes('blue')) team = 'blue';
      else if(lower.includes('red')) team = 'red';
      else if(lower.includes('spawn')) team = null;
      else return;
      const worldPos = new THREE.Vector3();
      obj.getWorldPosition(worldPos);
      let ry = 0;
      if(obj.rotation && obj.rotation.y !== 0) ry = obj.rotation.y;
      else if(obj.quaternion){
        const q = obj.quaternion.clone();
        const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
        ry = e.y;
      }
      spawns.push({ name:obj.name, team, pos:{x:worldPos.x, y:worldPos.y, z:worldPos.z}, ry });
    });
    return spawns;
  }

  _parseGLBBushes(grp, scale){
    const bushes = [];
    grp.traverse(obj => {
      if(!obj.name) return;
      const lower = obj.name.toLowerCase();
      if(lower.includes('bush')){
        const worldPos = new THREE.Vector3();
        obj.getWorldPosition(worldPos);
        let radius = 5;
        if(obj.scale){
          const ws = new THREE.Vector3();
          obj.getWorldScale(ws);
          radius = Math.max(ws.x, ws.z) * 0.6;
          radius = Math.max(3, Math.min(radius, 15));
        }
        const bushMat = Toon.mat({
          color: 0x3a7a38, flatShading: true,
          transparent: true, opacity: 0.35,
          depthWrite: false,
        });
        const grp2 = new THREE.Group();
        const positions = [[0,0,0,2],[2,0.3,0.5,1.5],[-1.8,0.4,-0.7,1.3],[0.5,0.5,-1.8,1.2],[-0.3,0.3,1.8,1.4]];
        positions.forEach(p => {
          const s = new THREE.Mesh(new THREE.IcosahedronGeometry(p[3], 1), bushMat);
          s.position.set(p[0], p[1] + 0.5, p[2]);
          s.castShadow = false; s.receiveShadow = false;
          grp2.add(s);
        });
        grp2.position.set(worldPos.x, 0, worldPos.z);
        this.scene.add(grp2);
        bushes.push({
          x: worldPos.x, z: worldPos.z,
          radius: radius,
          mesh: grp2,
          material: bushMat,
        });
      }
    });
    return bushes;
  }

  _spawnTDMBot(px, pz, py, team){
    const ids = TANK_ORDER.filter(id => id !== 'tankdisplay' && id !== 'dummy');
    if(!ids.length) return;
    const id = ids[Math.floor(Math.random()*ids.length)];
    const def = TANKS[id];
    if(!def) return;
    const spawnY = py != null ? py : (this.world._tdmBox ? this.world._tdmBox.min.y + (this.world._tdmBox.max.y - this.world._tdmBox.min.y) * 0.30 : 5);
    const t = new Tank(def, {
      id:'tdm-'+team+'-'+Math.random().toString(36).slice(2,6),
      name: (team === 'blue' ? 'Blue ' : 'Red ') + BOTNAMES[Math.floor(Math.random()*BOTNAMES.length)],
      isBot:true, x:px, z:pz, heading: team === 'blue' ? 0 : Math.PI,
      physicsWorld: this.physicsWorld, allowFall: true, startY: spawnY
    });
    t.brain = new BotBrain(t);
    t.team = team;
    // Remember where this tank started Ã¢â‚¬â€ Capture the Circle respawns it HERE
    // instead of a random point (see _captureRespawn).
    t._spawnPos = {x: px, y: spawnY, z: pz};
    t._spawnHeading = (team === 'blue') ? 0 : Math.PI;
    this._finalizeTank(t);
    this.tanks.push(t);
    t._drawHp();
  }

  /* Spawn a real human player from the matchmaker's roster. Modelled on
     _spawnTDMBot -- same body, same team handling -- but with no BotBrain:
     the tank is driven by network input from its owner, not by AI. Keyed by
     peerId in clientTanks so incoming state updates find it. */
  _spawnRemoteHuman(info, spawn, spawnY, team){
    const def = TANKS[info.tank] || TANKS.coolbuddy;
    const t = new Tank(def, {
      id:'remote-'+info.peerId,
      name: info.name || 'Player',
      ownerPeer: info.peerId,
      color: info.color || def.color,
      x: spawn.pos.x, z: spawn.pos.z,
      heading: (spawn.ry != null) ? spawn.ry : (team === 'blue' ? 0 : Math.PI),
      physicsWorld: this.physicsWorld, allowFall: true, startY: spawnY
    });
    t.team = team;
    t._spawnPos = {x: spawn.pos.x, y: spawnY, z: spawn.pos.z};
    t._spawnHeading = (team === 'blue') ? 0 : Math.PI;
    /* Which model this actually is. _sendSpawnAndState() reads it to tell the
       owning client which tank it is driving; without it the message always
       said coolbuddy and the client rendered the wrong tank all match. */
    t._remoteTankId = info.tank || 'coolbuddy';
    this._finalizeTank(t);
    this.tanks.push(t);
    this.clientTanks[info.peerId] = t;
    t._drawHp();

    /* TELL THEM WHICH TANK THEY ARE.

       This is not optional bookkeeping, it is how a networked player works at
       all. The client spawns its own tank locally and guesses a position, then
       corrects itself toward the host's authoritative position for the tank
       whose id matches _myRemoteId -- an id it can only get from this message
       (see _onClientWelcome). Without it _myRemoteId stays null, the correction
       block in _applyHostState never runs, and the player's tank sits wherever
       it spawned while the host's copy drives somewhere else entirely. It looks
       like the controls are ignored.

       Only the host sends these, and only to a real remote player, so it cannot
       collide with the host's own tank. */
    if(this.mode === 'host' || this._netRole === 'host'){
      this._sendSpawnAndState(info.peerId, t);
    }
    return t;
  }

  _onTDMKill(killer, victim){
    if(!this._tdmState || !this._tdmState.roundActive) return;
    this._tdmState.totalKills++;
    // Capture the Circle has mid-match respawns Ã¢â‚¬â€ a wipe here is temporary,
    // never a round end. The zone's 100% capture stays the only win condition.
    if(this._captureCircleMode) return;
    /* Same for Base Defend, and for a stronger reason: respawns there are
       UNLIMITED, so wiping the enemy team is not even a temporary setback, it
       is not a setback at all. Letting this run would end the match the moment
       one side was briefly empty, which in a mode decided entirely by base
       health is a loss decided by a respawn timer. Only the bases end it. */
    if(this._baseDefendMode) return;
    // Check if a team is eliminated
    const blueAlive = this.tanks.filter(t => t.team === 'blue' && t.alive && !t.dying && !t.isDummy).length;
    const redAlive = this.tanks.filter(t => t.team === 'red' && t.alive && !t.dying && !t.isDummy).length;
    if(blueAlive === 0){
      // Red wins the round
      this._tdmEndRound('red');
    } else if(redAlive === 0){
      // Blue wins the round
      this._tdmEndRound('blue');
    }
  }

  _tdmEndRound(winningTeam){
    if(!this._tdmState || !this._tdmState.roundActive) return;
    this._tdmState.roundActive = false;
    if(winningTeam === 'blue') this._tdmState.blueRoundWins++;
    else this._tdmState.redRoundWins++;
    const s = this._tdmState;
    const roundLabel = 'Round ' + s.round + ' of ' + s.maxRounds;
    /* EVERY TEAM NAME IN THIS LINE IS RELATIVE. The counters stay keyed on the real
       blue/red ids (that is the state), but what the player is told is always
       "Blue = us, Red = them" -- see _displaySide. A red-side player used to
       read their own winning round announced as "Red wins! Score: Blue 1 - 2
       Red", which is unreadable. */
    const winName = this._displaySide(winningTeam) === 'blue' ? 'Blue' : 'Red';
    const myRounds = this._displaySide('blue') === 'blue' ? s.blueRoundWins : s.redRoundWins;
    const theirRounds = this._displaySide('blue') === 'blue' ? s.redRoundWins : s.blueRoundWins;
    Menu.toast(roundLabel + ' Ã¢â‚¬â€ ' + winName + ' wins! Score: Blue ' + myRounds + ' - ' + theirRounds + ' Red');
    // Check if match is over
    const winsNeeded = Math.ceil(s.maxRounds / 2);
    if(s.blueRoundWins >= winsNeeded || s.redRoundWins >= winsNeeded){
      const matchWinner = s.blueRoundWins >= winsNeeded ? 'blue' : 'red';
      /* THE MATCH IS OVER Ã¢â‚¬â€ GO TO THE RESULTS SCREEN, NOT THE MENU.

         This used to toast the winner and drop the player straight back to the
         main menu three seconds later. Every number the battle produced Ã¢â‚¬â€
         damage, kills, the cash they earned Ã¢â‚¬â€ was discarded at that point, so a
         good game ended exactly like a bad one: the same menu, with no record
         that anything had happened.

         The results screen shows the whole battle and is dismissed by the
         player, so nothing is thrown away and the player decides when to leave.
         The cash is paid HERE rather than on the way out, because the screen is
         the receipt: it has to show the number that was actually credited. */
      const myTeam = (this.localTank && this.localTank.team) || 'blue';
      const won = myTeam === matchWinner;
      setTimeout(() => {
        if(!this.running) return;
        /* Relative naming again -- "Blue team" always means the player's team. The
           `won` test one line up is left reading the REAL ids on purpose: the
           outcome is a fact about the match, not a thing to be recoloured. */
        Menu.toast('Match over! ' + (this._displaySide(matchWinner) === 'blue' ? 'Blue' : 'Red') + ' team wins '
          + (this._displaySide('blue') === 'blue' ? s.blueRoundWins : s.redRoundWins) + '-'
          + (this._displaySide('blue') === 'blue' ? s.redRoundWins : s.blueRoundWins) + '!');
        this._awardBattleCash({
          damage: this.localTank ? (this.localTank.damageDealt || 0) : 0,
          assists: this.localTank ? (this.localTank.assists || 0) : 0,
          kills:  this.localTank ? (this.localTank.kills || 0) : 0,
          won: won,
        });
        this._showResults({
          outcome: won ? 'win' : 'loss',
          headline: won ? 'VICTORY' : 'DEFEAT',
        });
      }, 2000);
      return;
    }
    // Start next round after delay
    setTimeout(() => { if(!this.running) return; this._tdmStartRound(); }, 3000);
  }

  _tdmStartRound(){
    if(!this._tdmState) return;
    this._tdmState.round++;
    this._tdmState.roundActive = true;
    const s = this._tdmState;
    Menu.toast('Round ' + s.round + ' of ' + s.maxRounds + ' Ã¢â‚¬â€ Blue ' + s.blueRoundWins + ' - ' + s.redRoundWins + ' Red');
    // Respawn all tanks at their spawn positions
    const blueSpawns = this._tdmBlueSpawns || [];
    const redSpawns = this._tdmRedSpawns || [];
    const blueTanks = this.tanks.filter(t => t.team === 'blue' && !t.isDummy);
    const redTanks = this.tanks.filter(t => t.team === 'red' && !t.isDummy);
    const respawnTank = (tank, spawns) => {
      if(!spawns.length) return;
      const sp = spawns[Math.floor(Math.random() * spawns.length)];
      tank.x = sp.pos.x; tank.z = sp.pos.z;
      const respawnY = this.world._tdmBox ? this.world._tdmBox.min.y + (this.world._tdmBox.max.y - this.world._tdmBox.min.y) * 0.30 : 5;
      tank.heading = tank.team === 'blue' ? 0 : Math.PI;
      tank.turretAngle = tank.heading;
      tank.hp = tank.maxHp; tank.alive = true; tank.dying = false; tank.deathT = 0;
      tank.speed = 0; tank.vx = 0; tank.vz = 0; tank.reloadLeft = 0;
      tank.root.visible = true;
      if(tank._physBody){
        try {
          tank._physBody.setEnabled(true);
          tank._physBody.setTranslation({x: tank.x, y: respawnY, z: tank.z}, true);
          tank._physBody.setLinvel({x: 0, y: 0, z: 0}, true);
        } catch(e){}
      }
      if(tank.hpSprite) tank.hpSprite.visible = true;
      /* A tank respawns in the open, so camouflagge has to be cleared here too Ã¢â‚¬â€
         Tank.respawn does the same for its own path. Without this a tank that
         died hidden comes back with its model still switched off, and the flag
         stays set, so _applyCamoVisual's change detection would never re-show
         it: an invisible tank that stays invisible until the next round. */
      tank._camoHidden = false;
      if(tank.bodyGroup) tank.bodyGroup.visible = true;
      if(tank.turretGroup) tank.turretGroup.visible = true;
      /* LOCAL TANK ONLY -- see the note in Tank.respawn.

         This block re-implements the respawn restore by hand instead of calling
         Tank.respawn, and it carried its own copy of the same unconditional
         `visible = true`. So there were TWO places that grew every tank a view
         range circle on respawn, and fixing only the one in tank.js would have
         left the bug alive on TDM, which is exactly where this runs. The circle
         is drawn at the tank's own viewRange, so showing an opponent's is a
         scouting tool rather than a cosmetic slip; the local tank keeps it
         because that information is already theirs and it draws on their own
         hull. */
      if(tank.viewCircle) tank.viewCircle.visible = !!tank.isLocal;
      tank._drawHp();
      tank.root.position.set(tank.x, respawnY, tank.z);
    };
    blueTanks.forEach(t => respawnTank(t, blueSpawns));
    redTanks.forEach(t => respawnTank(t, redSpawns));
    // Stop spectating Ã¢â‚¬â€ tank is about to be respawned
    this._stopSpectate();
  }

  /* ============================================================================
     THE SPAWN PADS Ã¢â‚¬â€ one white glowing rectangle, on the ground, once.

     WHAT THIS IS

     A thin glowing rectangle painted at each spawn point, showing the slot a tank
     starts in. It is static: a tank drives away from it and it stays where it
     was put.

     THE TWO THINGS THIS GOT WRONG FIRST TIME, both of which are why it looked
     like a cage laid over the map rather than a marker:

     1. IT FOLLOWED THE TANKS. There was a pad per tank as well as per spawn, so
        sixteen markers travelled across the arena for the whole round. A marker
        that moves with you has stopped marking a place and become part of the
        vehicle -- and at any moment the pads for the two teams overlapped into
        an unreadable grid. Spawn points are the only fixed positions the game
        has, so they are the only place a static pad means anything. There is no
        per-tank pad any more and nothing is repositioned per frame.

     2. IT WAS SIZED FROM THE VISUAL MODEL. Measured model footprints put helix
        at 27.76 units wide, and the pad was made a 32-unit square to contain
        it at any heading (a w x l rectangle needs its diagonal, sqrt(w^2+l^2),
        to fit a square at 45 degrees -- 30.26 for helix).

        But helix's COLLIDER is only 7.04 wide. Its model is nearly four times
        its own hitbox, and every other tank's model is similarly inflated
        relative to what actually occupies the ground. Sizing a spawn slot to
        the picture rather than the hitbox is what made the pads enormous: a
        32-unit square drawn around a tank whose body is under 10 units long.

        Sized from the collider instead -- body.w and body.l x 0.55 x GLOBAL_SCALE
        -- the largest tank in the game (sturmratte) is 8.80 x 12.76, so 11 x 15
        clears everything. See TANK_PAD_W / TANK_PAD_L at the top of the file for
        the full table.

     A rectangle, not a square, and it is ROTATED to the spawn's own heading.
     Both of those follow from sizing to the collider: a tank is longer than it
     is wide, so a square has to be as wide as the tank is LONG and is therefore
     far too wide across; and because the tank arrives already pointing along the
     rectangle, it only has to fit the way it actually sits. That is what let the
     size come down from 32 to 11 without the tank hanging out of it.

     WHY THE PADS ARE SCENE-OWNED

     Tank.dispose() runs killTree() over the tank's whole subtree and disposes
     every material it finds unless the material is flagged sharedWithCache. A pad
     parented to a tank with a shared material would therefore be disposed out
     from under every OTHER tank the first time any one of them died -- the same
     failure the shared outline material already had to be defended against.
     ============================================================================ */

  /* A rectangular annulus: the outline itself, as one geometry.

     ShapeGeometry with a rectangular hole, rather than four boxes or a
     LineSegments. It is a single quad strip, so a pad is one draw call instead
     of four, and it shares geometry across every pad on the map.

     NOT a square. The width and length are separate because the thing being
     marked is a tank, which is longer than it is wide, and a square big enough
     to clear the tank's length is far too wide in the other axis -- that is
     exactly what made the first version look like a grid.

     `thickness` is a fraction of the SHORT side, so the line keeps the same
     visual weight whether the rectangle is being made longer or narrower. */
  static _padFrameGeometry(w, l, thickness){
    const hw = w / 2, hl = l / 2;
    const t = Math.min(hw, hl) * thickness;
    const iw = hw - t, il = hl - t;
    const outer = new THREE.Shape();
    outer.moveTo(-hw, -hl); outer.lineTo(hw, -hl); outer.lineTo(hw, hl); outer.lineTo(-hw, hl); outer.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-iw, -il); hole.lineTo(-iw, il); hole.lineTo(iw, il); hole.lineTo(iw, -il); hole.closePath();
    outer.holes.push(hole);
    const g = new THREE.ShapeGeometry(outer);
    g.rotateX(-Math.PI / 2);      /* ShapeGeometry is built in XY; lay it flat */
    return g;
  }

  /* Geometry and material are shared by every pad on the map. Two thin frames
     (a bright core inside a wider faint one) is what sells the glow: additive
     white over the bright grass reads as light spilling off the line, where a
     single wider line just reads as a thick line. */
  /* The TEAM-COLOURED spawn washes. Separate from the pads on purpose: these fade
     out once the battle starts (they mark which end of the map you began at),
     while the pads stay for the whole round. Kept as they were. */
  _spawnGlowRects(blueSpawns, redSpawns){
    this._glowRects = [];
    // Determine ground Y from the map bounds
    const groundY = this.world._tdmBox ? this.world._tdmBox.min.y + 0.15 : 0.15;
    const makeGlow = (sp, color, op) => {
      const geo = new THREE.PlaneGeometry(4, 6);
      const mat = new THREE.MeshBasicMaterial({color, transparent:true, opacity:op||0.35, side:THREE.DoubleSide, depthWrite:false});
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(sp.pos.x, groundY, sp.pos.z);
      this.scene.add(mesh);
      this._glowRects.push({mesh, baseOpacity:op||0.35, time:0});
    };
    blueSpawns.forEach(s => makeGlow(s, 0x4488ff));
    redSpawns.forEach(s => makeGlow(s, 0xff4444));
    // Yellow glow under local player's own spawn
    if(this.localTank && this.localTank._spawnPos){
      const sp = this.localTank._spawnPos;
      makeGlow({pos:{x:sp.x, z:sp.z}}, 0xffdd00, 0.5);
    }
  }

  _padAssets(){
    if(this._padCache) return this._padCache;
    const W = TANK_PAD_W, L = TANK_PAD_L;
    const core = Game._padFrameGeometry(W, L, 0.05);
    /* The halo is the same rectangle grown outward on both axes, so it stays a
       rectangle and stays concentric rather than drifting off one corner. */
    const halo = Game._padFrameGeometry(W * 1.09, L * 1.05, 0.13);
    const mk = (opacity) => {
      const m = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity,
        blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false, fog: false,
      });
      /* Nothing disposes these. See the note on killTree above. */
      m.userData.sharedWithCache = true;
      return m;
    };
    this._padCache = { core, halo, matCore: mk(0.95), matHalo: mk(0.28) };
    return this._padCache;
  }

  _makePad(ry){
    const A = this._padAssets();
    const grp = new THREE.Group();
    const halo = new THREE.Mesh(A.halo, A.matHalo);
    const core = new THREE.Mesh(A.core, A.matCore);
    /* No depth write on either, so the pad never punches a hole in the terrain
       and never occludes a shell. Drawn after the ground via renderOrder. */
    halo.renderOrder = 2; core.renderOrder = 3;
    halo.frustumCulled = false; core.frustumCulled = false;
    /* Aligned to the spawn's own heading, so the rectangle's long axis lies
       along the tank instead of across it. Without this the pad would have to
       be diagonal-safe to contain a tank pointing any way, which is most of
       why the pads were oversized. */
    if(ry) grp.rotation.y = ry;
    grp.add(halo); grp.add(core);
    grp.userData.isTankPad = true;
    return grp;
  }

  /* Build the pads for this battle: one per SPAWN POINT, and nothing else.

     Called from _begin(), which every mode starter runs once the map and the
     spawns exist. There is deliberately no pad per tank -- see the note at the
     top of the file. */
  _buildTankPads(){
    this._clearTankPads();
    if(!this.scene) return;
    this._pads = [];
    this._padPulse = 0;

    const sp = this.world.spawnPoints || {};
    const seen = new Set();
    const addSpawn = (p) => {
      if(!p) return;
      const key = Math.round(p.x * 4) + ':' + Math.round(p.z * 4);
      if(seen.has(key)) return;         /* blue/red markers can share a spot */
      seen.add(key);
      /* `ry` is the heading the tank will spawn facing. Passing it through is
         what lets the rectangle be tight instead of diagonal-safe. */
      const pad = this._makePad(p.ry);
      /* Spawn markers carry their own y when the GLB supplied one, which is the
         only way to sit a pad on the ground of a map that is not flat. The
         fallback matches what the old glow rects used. */
      const y = (p.y != null) ? p.y + 0.12
              : (this.world._tdmBox ? this.world._tdmBox.min.y + 0.12 : 0.12);
      pad.position.set(p.x, y, p.z);
      this.scene.add(pad);
      this._pads.push({ obj: pad });
    };
    for(const key in sp){
      const list = sp[key];
      if(!Array.isArray(list)) continue;
      for(const p of list) addSpawn(p);
    }
  }

  /* Per-frame: breathe the glow. Nothing is repositioned -- the pads are static,
       which is the whole point of them. */
  _updateTankPads(dt){
    if(!this._pads || !this._pads.length) return;
    this._padPulse += dt;
    /* One slow breath on the shared material, so every pad pulses together.
       In sync reads as a shared game signal; each on its own clock reads as
       noise. */
    const breath = 0.82 + 0.18 * Math.sin(this._padPulse * 2.2);
    const A = this._padAssets();
    A.matCore.opacity = 0.95 * breath;
    A.matHalo.opacity = 0.28 * breath;
  }

  _clearTankPads(){
    if(!this._pads) return;
    for(const p of this._pads){
      if(p.obj && p.obj.parent) p.obj.parent.remove(p.obj);
    }
    this._pads = null;
  }

  _tdmRespawnBot(bot){
    const blueSpawns = this._tdmBlueSpawns || [];
    const redSpawns = this._tdmRedSpawns || [];
    const spawns = bot.team === 'blue' ? blueSpawns : redSpawns;
    let respawnY = 5;
    if(spawns.length){
      const sp = spawns[Math.floor(Math.random()*spawns.length)];
      bot.x = sp.pos.x; bot.z = sp.pos.z;
      respawnY = this.world._tdmBox ? this.world._tdmBox.min.y + (this.world._tdmBox.max.y - this.world._tdmBox.min.y) * 0.30 : 5;
    } else {
      const box = this.world._tdmBox;
      if(box){
        const cx = (box.max.x + box.min.x) / 2;
        const cz = (box.max.z + box.min.z) / 2;
        bot.x = cx + (bot.team === 'blue' ? -10 : 10) + (Math.random()-0.5)*10;
        bot.z = cz + (Math.random()-0.5)*20;
        respawnY = box.min.y + (box.max.y - box.min.y) * 0.65;
      } else {
        bot.x = (Math.random()-0.5)*40;
        bot.z = (Math.random()-0.5)*40;
      }
    }
    bot.heading = bot.team === 'blue' ? 0 : Math.PI;
    bot.turretAngle = bot.heading;
    bot.hp = bot.maxHp; bot.alive = true; bot.dying = false; bot.deathT = 0;
    bot.speed = 0; bot.vx = 0; bot.vz = 0; bot.reloadLeft = 0;
    bot.root.visible = true;
    if(bot._physBody){
      try {
        bot._physBody.setEnabled(true);
        bot._physBody.setTranslation({x: bot.x, y: respawnY, z: bot.z}, true);
        bot._physBody.setLinvel({x: 0, y: 0, z: 0}, true);
      } catch(e){}
    }
    bot.root.position.set(bot.x, respawnY, bot.z);
  }

  /* A GLB battle map can carry spawn markers that sit just OFF its own floor Ã¢â‚¬â€
     the red markers in Capture the Circle do. A tank that spawns there drops
     straight through the world, the camera follows it down, and the player
     stares at empty sky with the map's underside above them, which reads as
     "the game is broken". Every spawn is pulled back inside the map's own
     footprint before anybody is placed on it. */
  _clampSpawnsToMap(spawns, box, margin){
    if(!box || !spawns || !spawns.length) return spawns;
    const minX = box.min.x + margin, maxX = box.max.x - margin;
    const minZ = box.min.z + margin, maxZ = box.max.z - margin;
    if(minX >= maxX || minZ >= maxZ) return spawns;
    for(const s of spawns){
      if(!s || !s.pos) continue;
      s.pos.x = Math.max(minX, Math.min(maxX, s.pos.x));
      s.pos.z = Math.max(minZ, Math.min(maxZ, s.pos.z));
    }
    return spawns;
  }

  /* Capture the Circle Ã¢â‚¬â€ bring a destroyed tank back at the EXACT spot it
     spawned from (its own, not a random one) after GAMEMODES.captureTheCircle
     .respawnTime seconds. Applied to the player and every bot so teams never
     whittle down to nothing while the zone is being fought over. */
  _captureRespawn(tank){
    if(!tank || !tank.dying) return;
    /* WHICH MODE'S RESPAWN RULES. Both modes that respawn mid-match call this,
       and they are configured separately Ã¢â‚¬â€ so reading one of them here would
       silently apply the other's timings. Base Defend falls back to the Circle's
       numbers rather than to nothing, so a missing key cannot produce a tank
       that comes back with no spawn shield at all. */
    const cfg = this._baseDefendMode ? (GAMEMODES.baseDefend || GAMEMODES.captureTheCircle)
                                      : GAMEMODES.captureTheCircle;
    // The wreck's fire effect is parented to the SCENE and follows tank.x/z Ã¢â‚¬â€
    // kill it here or it would ride along with the respawned tank.
    if(this._videoFireEffects){
      for(let i = this._videoFireEffects.length - 1; i >= 0; i--){
        const v = this._videoFireEffects[i];
        if(v.follow !== tank) continue;
        if(v.mesh && v.mesh.parent) v.mesh.parent.remove(v.mesh);
        try { v.el.pause(); v.el.currentTime = 0; } catch(e){}
        /* Recycled into the pool rather than destroyed: the tank is respawning
           and more wrecks are certain, so keeping the decoder warm is cheaper
           than building a new one. The pool is emptied at arena reset. */
        v.follow = null;
        if(this._videoFirePool && this._videoFirePool.length < 4){
          this._videoFirePool.push(v);
        } else if(v.mesh){
          v.mesh.geometry.dispose(); v.mat.dispose(); this._disposeVideoTex(v.tex, v.el);
        }
        this._videoFireEffects.splice(i, 1);
      }
    }
    // Their OWN original spawn Ã¢â‚¬â€ falls back to the team spawn list, then the
    // current position, so a tank can never fail to respawn.
    const sp = tank._spawnPos || {x: tank.x, z: tank.z};
    const heading = (tank._spawnHeading != null)
      ? tank._spawnHeading
      : (tank.team === 'blue' ? 0 : Math.PI);
    tank.respawn(this.world, this, {x: sp.x, z: sp.z, heading});
    // Fixed spawn point = easy to camp, so hand out the same shield the
    // initial spawn gets (countdown / _spawnInvuln).
    tank._spawnInvuln = cfg.spawnShield || 3;
    if(tank === this.localTank){
      this._stopSpectate();
      if(this.input && this.input.setJoysticksVisible) this.input.setJoysticksVisible(true);
      Menu.toast('Respawned at your spawn point!');
    }
  }

  _checkTDMBushes(tank){
    if(!tank.alive || tank.dying) return;
    const bushes = (this.world && this.world.bushes) || [];
    if(!bushes.length) return;
    let inBush = false;
    const r = CONFIG.BUSH_HIDE_RADIUS || 3.2;
    for(const b of bushes){
      const dx = tank.x - b.x, dz = tank.z - b.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
      if(dist < (b.radius || r) + 3){
        inBush = true;
        break;
      }
    }
    if(tank._inTDMBush !== inBush){
      tank._inTDMBush = inBush;
      if(tank.root){
        tank.root.traverse(o => {
          if(o.isMesh && o.material){
            if(inBush){
              if(o.material._savedOpacity === undefined){
                o.material._savedOpacity = o.material.opacity;
                o.material._savedTransparent = o.material.transparent;
              }
              o.material.transparent = true;
              o.material.opacity = (o.material._savedOpacity || 1) * 0.5;
            } else {
              if(o.material._savedOpacity !== undefined){
                o.material.opacity = o.material._savedOpacity;
                o.material.transparent = o.material._savedTransparent;
                delete o.material._savedOpacity;
                delete o.material._savedTransparent;
              }
            }
          }
        });
      }
    }
  }

  /* SIZE THE WORLD TO THE MAP, INSTEAD OF ASSUMING IT IS 1000 UNITS.

     world.half / world.size used to be set to a flat 500 / 1000 for every map in
     the game. That number is not cosmetic -- it is read by at least a dozen
     systems:

       projectile.js  a shell past world.half is deleted on the spot
       game.js         the camera limit, the capture zone's radius, the gladiator
                       zone shrink, the minimap's world->screen mapping
       bot.js          where bots think the arena ends
       tank.js         the tank containment limit
       world.js        the sun's shadow camera

     With every map near 700-1300 units, a flat 500 was close enough that nobody
     noticed it was wrong. Kaukaz III is ~5000 units across, and on that map a
     hardcoded 500 means: every shell dies about a tenth of the way out, the
     camera is pinned to the middle of the map, the minimap shows a tenth of the
     arena, and the capture zone closes on a circle the player cannot see the
     edge of. The map would be unplayable rather than merely huge.

     So the bounds now come from the box that was just measured. A little margin
     is added so a tank driving at the edge is not instantly clamped, and the
     result is floored at the old 1000 so a tiny or degenerate map cannot
     squeeze the arena shut. */
  _fitWorldToMap(box, map){
    if(!box || !this.world) return;
    const w = box.max.x - box.min.x;
    const d = box.max.z - box.min.z;
    if(!(w > 0) || !(d > 0)) return;

    /* Half the LARGER axis, so the arena is square and the camera limit is the
       same in both directions -- otherwise a wide map gets a tighter Z limit
       than X and players are stopped by an invisible wall. */
    const half = Math.max(w, d) * 0.5;
    /* 8% margin: enough that the visual edge of the ground is inside the kill
       boundary, so a shell never vanishes in mid-air over visible terrain. */
    const derived = Math.round(half * 1.08);

    /* A map may declare its own boundary, which wins over the floor below.

       The floor exists to stop a small or degenerate map from squeezing the
       arena shut, and for every map from Old School up it never binds -- the
       derived number is bigger than 500 anyway. It DOES bind on a genuinely
       small map, and then it is not a safety net, it is the bug: at Core's
       current 241 units the floor put the boundary at 500, twice the map, so
       the tank clamp and the void kill sat 350 units off the edge of the
       ground, the capture circle covered the whole arena from the first second
       and never closed, and the minimap drew a quarter of the map. See the
       'core' entry in map-voting.js.

       A declared worldHalf is that map's own derived value stated out loud, so
       it can also be applied BEFORE the map has loaded -- which gladiator has
       to do, because _initGladiator reads world.half to size its zone. Maps
       that do not declare one are completely unaffected. */
    const declared = this._declaredWorldHalf(map);
    this.world.half = declared || Math.max(500, derived);
    this.world.size = this.world.half * 2;
  }

  /* The boundary a map asks for, or 0 when it does not ask for one. Read from
     the map entry rather than hardcoded anywhere, so adding a small map does
     not mean touching this function again. */
  _declaredWorldHalf(map){
    if(!map) return 0;
    const h = Number(map.worldHalf);
    return isFinite(h) && h > 0 ? Math.round(h) : 0;
  }

  _sandboxBuildTrimesh(grp){
    if(!this.physicsWorld || typeof RAPIER === 'undefined') return;
    try {
      this.scene.updateMatrixWorld(true);
      const mergedVerts = [];
      const mergedIdx = [];
      let vertCount = 0;
      let meshCount = 0;
      grp.traverse(o => {
        if(!o.isMesh) return;
        const nameLower = (o.name || '').toLowerCase();
        if(o.userData && o.userData.noPhysics) return;
        if(nameLower.includes('tree') || nameLower.includes('bush') || nameLower.includes('pine')) return;
        meshCount++;
        const geo = o.geometry;
        if(!geo || !geo.attributes.position) return;
        const cloned = geo.clone();
        o.updateWorldMatrix(true, false);
        const m = o.matrixWorld;
        cloned.applyMatrix4(m);
        const pos = cloned.attributes.position;
        const idx = cloned.index;
        const hasNegScale = m.determinant() < 0;
        if(idx){
          for(let i = 0; i < pos.count; i++){
            mergedVerts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
          }
          for(let i = 0; i < idx.count; i += 3){
            let a = idx.getX(i) + vertCount;
            let b = idx.getX(i+1) + vertCount;
            let c = idx.getX(i+2) + vertCount;
            if(hasNegScale){ var tmp = a; a = c; c = tmp; }
            mergedIdx.push(a, b, c);
          }
          vertCount += pos.count;
        } else {
          for(let i = 0; i < pos.count; i++){
            mergedVerts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
          }
          for(let i = 0; i < pos.count; i += 3){
            let a = i + vertCount;
            let b = i+1 + vertCount;
            let c = i+2 + vertCount;
            if(hasNegScale){ var tmp2 = a; a = c; c = tmp2; }
            mergedIdx.push(a, b, c);
          }
          vertCount += pos.count;
        }
      });
      if(!mergedIdx.length){
        console.warn('Sandbox: no geometry found in GLB (meshes scanned:', meshCount, ')');
        return;
      }
      console.log('Sandbox trimesh: ' + (mergedVerts.length/3) + ' verts, ' + (mergedIdx.length/3) + ' tris, physBodies before:', this._physBodies.length);
      const vertices = new Float32Array(mergedVerts);
      const indices = new Uint32Array(mergedIdx);
      var bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
      var body = this.physicsWorld.createRigidBody(bodyDesc);
      var colDesc = RAPIER.ColliderDesc.trimesh(vertices, indices);
      var collider = this.physicsWorld.createCollider(colDesc, body);
      collider.setCollisionGroups(0xFFFFFFFF);
      collider.setSolverGroups(0xFFFFFFFF);
      /* THE MAP TRIMESH MUST CARRY A type. It did not, and that is why shells
         bounced off buildings.

         _onCollision routes every physics contact by looking at
         `collider.userData.type`, and every branch of it tests for a string that
         is already known Ã¢â‚¬â€ 'wall' for shell-vs-terrain, 'tank' for shell-vs-tank.
         This trimesh is the actual geometry of the map: the ground, the buildings,
         the walls, the rocks. It was built with no userData at all, so a shell
         that struck it arrived as the pair ('(noType)', 'shell'), matched none of
         those branches, fell out of _onCollision having done nothing, and carried
         on with its velocity.

         Rapier itself does not bounce it Ã¢â‚¬â€ both colliders' restitution is 0 Ã¢â‚¬â€
         so what the player saw was a shell that passed through solid geometry,
         or clipped a corner and re-emerged, which reads exactly like a ricochet.
         Measured live: the only collision pairs reaching _onCollision were
         '(noType) <-> tank', i.e. the terrain side was never typed.

         'wall' is the correct tag rather than a new one: it IS the wall to a
         shell, the branch already exists, and tagging it is what reuses it. */
      collider.userData = { type: 'wall' };
      this._physBodies.push(body);
      this._sandboxTrimeshBody = body;
      console.log('Sandbox trimesh created, physBodies after:', this._physBodies.length);
    } catch(e){
      console.warn('Sandbox trimesh build error:', e);
    }
  }

  _gladSpawnList(){
    const sp = this.world.spawnPoints || {};
    let pts = (sp.gladiator || []).slice();
    if(!pts.length) pts = (sp.player || []).slice();
    if(!pts.length) pts = (sp.blue || []).concat(sp.red || []);
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
        pts.push({x:fallback[i].x, z:fallback[i].z, ry:Math.random()*6, y:15});
      }
    }
    for(let i=pts.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=pts[i]; pts[i]=pts[j]; pts[j]=t; }
    if(had < 10 && pts.length < 10) Menu.toast('Map has only '+had+' gladiator spawn points Ã¢â‚¬â€ filling in corners');
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
     if(typeof CaptureCircle !== 'undefined') CaptureCircle.dispose();
     /* Base Defend is torn down here for the same reason the Circle is: this is
        the single place _resetArena() funnels every battle mode through, so
        leaving the bases out means a Base Defend match leaks its cubes, its
        textures and its HUD panel into the next mode Ã¢â‚¬â€ and into the one after
        that, one set at a time. */
     if(typeof BaseDefend !== 'undefined') BaseDefend.dispose();
     if(this._gladZoneMesh){ this.scene.remove(this._gladZoneMesh); this._gladZoneMesh.geometry.dispose(); this._gladZoneMesh.material.dispose(); this._gladZoneMesh = null; }
     if(this._gladZoneTex) this._gladZoneTex.dispose();
     if(this._gladMarker){ this.scene.remove(this._gladMarker); if(this._gladMarkerTex) this._gladMarkerTex.dispose(); this._gladMarker = null; this._gladMarkerCanvas = null; this._gladMarkerTex = null; this._gladMarkerKey = null; }
     this._gladBoxes.forEach(b => { if(b.mesh){ this.scene.remove(b.mesh); if(b.mesh.geometry) b.mesh.geometry.dispose(); if(b.mesh.material) b.mesh.material.dispose(); } });
     this._gladBoxes = [];
     this._gladPickups.forEach(p => { if(p.mesh){ this.scene.remove(p.mesh); if(p.mesh.geometry) p.mesh.geometry.dispose(); if(p.mesh.material) p.mesh.material.dispose(); } });
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
      Toon.mat({color:0x2299ff, emissive:0x0a4a7a, emissiveIntensity:0.25})
    );
    mesh.position.set(x, 1.2, z);
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    this._gladBoxIdSeq = (this._gladBoxIdSeq || 0) + 1;
    const box = { id: id || ('gb'+this._gladBoxIdSeq), x, z, hp:30, alive:true, mesh };
    this._gladBoxes.push(box);
    return box;
  }

  _gladDropPickup(x, z, power, id){
    const grp = new THREE.Group();
    const bm = Toon.mat({color:0x2a7fff, emissive:0x1a5fdd, emissiveIntensity:0.8});
    const seg1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.85, 0.14), bm);
    const seg2 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.7, 0.14), bm);
    seg1.position.y = 0.3;
    seg2.position.set(0.08, -0.3, 0); seg2.rotation.z = 0.55;
    grp.add(seg1, seg2);
    grp.position.set(x, 1.15, z);
    this.scene.add(grp);
    /* A stable identity. Clients match snapshots against this to decide
       whether to move a pickup they already have or build a new one; without
       it every snapshot looks like a completely new set of pickups. */
    if(id == null){
      this._gladPickupSeq = (this._gladPickupSeq || 0) + 1;
      id = 'pk' + this._gladPickupSeq;
    }
    const entry = { id, x, z, power, type:'power', mesh:grp, phase:Math.random()*6.28 };
    if(!this._gladPickups) this._gladPickups = [];
    this._gladPickups.push(entry);
    return entry;
  }

  /* Re-point an existing pickup at the host's latest position. No allocation:
     this runs for every pickup on every 20 Hz snapshot. */
  _gladMovePickup(p, sp){
    p.x = sp.x; p.z = sp.z;
    if(sp.power !== undefined) p.power = sp.power;
    if(p.mesh) p.mesh.position.set(sp.x, 1.15, sp.z);
    return p;
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

/* Seconds between flagging a new chunk orange Ã¢â‚¬â€ accelerates as the safe
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
      form ONE connected blob Ã¢â‚¬â€ i.e. the zone never strands an island. */
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
     /* Forced: only called when a chunk actually changed state, so it must not
        be swallowed by the per-frame rate limit inside _gladPaintZone. */
     this._gladPaintZone(true);
   }

   /* Paint the ground canvas from the current chunk states. */
   _gladPaintZone(force){
     if(!this._gladZoneCanvas) return;
     /* Called from the per-frame update. Repainting a 1024x1024 canvas and
        re-uploading it as a texture EVERY FRAME is ~4 MB of GPU traffic per
        frame before any raster work is counted, and on integrated graphics
        that alone is several times the whole frame budget.

        The zone only meaningfully changes when a chunk changes state or its
        slow pulse needs a tick, so cap the repaint at ~12 Hz. The pulse is far
        too slow to read the difference and the cost drops by a factor of five.
        _gladZoneDirty() forces a repaint when state really changes, so nothing
        is ever swallowed by the cap. */
     const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
     if(!force && this._gladZoneNextPaint && now < this._gladZoneNextPaint) return;
     this._gladZoneNextPaint = now + 83;
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
          Menu.toast('Airdrop landed Ã¢â‚¬â€ stand inside the blue circle!');
        }
      } else {
        g.airdrop.life -= dt;
        if(g.airdrop.life <= 0){
          this._gladClearAirdropVisuals();
          this._gladDropPickup(g.airdrop.x, g.airdrop.z, cfg.power.airdrop);
          Menu.toast('Airdrop expired Ã¢â‚¬â€ power dropped as pickup');
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

    // Hologram barrel model (async; pure visual Ã¢â‚¬â€ no hitbox)
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
      grp.position.set(x - c.x * scale, -box.min.y * scale + 0.30, z - c.z * scale);
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
      this._gladAirCounter.position.y = 6.0 + Math.sin(this.time * 1.6) * 0.30;
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
        if(o.userData && o.userData.noPhysics) return;
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
    crate.position.set(0.30, 2.1, -0.2);
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
      /* id is REQUIRED, not decoration: it is how a client matches a pickup in
         this snapshot to the mesh it already has and moves that instead of
         destroying and rebuilding it twenty times a second. */
      pickups: this._gladPickups.map(p => ({id: p.id, x: p.x, z: p.z, power: p.power})),
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
    /* Pickups.

       This used to destroy and rebuild EVERY pickup from the snapshot, twenty
       times a second, forever: a fresh Group + two BoxGeometry + a fresh
       Toon material allocated and disposed per pickup per snapshot. The meshes
       are completely static -- only x, z and power ever change -- so all of
       that was pure churn, and it showed up as the driver periodically
       stalling for the best part of a second while a gladiator client played.

       Match by id and MOVE the existing mesh instead. Only pickups the host has
       genuinely dropped are created, and only ones that have gone away are
       destroyed. */
    const prevPickups = this._gladPickups;
    const nextPickups = [];
    (gs.pickups || []).forEach(sp => {
      const existing = (prevPickups || []).find(q => q.id === sp.id);
      nextPickups.push(existing
        ? this._gladMovePickup(existing, sp)
        : this._gladDropPickup(sp.x, sp.z, sp.power, sp.id));
    });
    for(const gone of (prevPickups || [])){
      if(nextPickups.indexOf(gone) >= 0) continue;
      if(gone.mesh){ this.scene.remove(gone.mesh); gone.mesh.children.forEach(c => { c.geometry.dispose(); c.material.dispose(); }); }
    }
    this._gladPickups = nextPickups;
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
    // Release pointer lock so cursor is visible on result screen
    if(document.pointerLockElement) document.exitPointerLock();
    const g = this.glad;
    if(!g) return;
    // The result overlay must always sit on top: close any ESC menu first
    const esc = document.getElementById('esc-menu');
    if(esc) esc.classList.add('hidden');
    if(window.Menu) Menu.escOpen = false;
    const txtEl = document.getElementById('glad-result-text');
    /* THE RESULTS SCREEN IS THE REAL RESULT IN GLADIATOR.

       The old `glad-result` box says one line of text and offers three buttons Ã¢â‚¬â€
       "Play again", "Keep watching", "Exit to menu" Ã¢â‚¬â€ and that is the whole
       record of a match. A gladiator battle is the longest thing in the game,
       and it ended by telling you only whether you won, never how much damage
       you did or what you were paid for it.

       So the compact box still appears, because it carries the two things the
       results screen has no room for (immediate replay, keep spectating), and
       the full screen opens on top of it a beat later. Both are shown rather
       than one replacing the other: dismissing the results with CONTINUE must
       not silently drop the player out of a match they may want to watch. */
    if(eliminated){
      if(g._elimShown) return;
      g._elimShown = true;
      const place = this.localTank ? (this.localTank.placement || null) : null;
      if(txtEl) txtEl.textContent = 'ELIMINATED Ã¢â‚¬â€ you placed #' + (place || '?');
      el.classList.remove('hidden');
      const watchBtn = document.getElementById('glad-watch-btn');
      if(watchBtn) watchBtn.classList.remove('hidden');
      setTimeout(() => {
        if(!this.running) return;
        this._awardBattleCash({
          damage: this.localTank ? (this.localTank.damageDealt || 0) : 0,
          assists: this.localTank ? (this.localTank.assists || 0) : 0,
          kills:  this.localTank ? (this.localTank.kills || 0) : 0,
          won: false,
        });
        this._showResults({ outcome: 'loss', headline: 'ELIMINATED', place: place });
      }, 1600);
    } else {
      if(g._finalShown) return;
      g._finalShown = true;
      let winner = g.winner;
      if(!winner && g.winnerId) winner = this.tanks.find(t => t.id === g.winnerId) || null;
      let txt = 'MATCH OVER';
      let won = false;
      if(winner === this.localTank){
        txt = 'VICTORY! Last tank standing!';
        won = true;
        if(window.Menu && Menu.bumpStat) Menu.bumpStat('wins', 1);
      }
      else if(winner) txt = 'WINNER: ' + winner.name;
      else if(g.winnerId) txt = 'MATCH OVER';
      if(txtEl) txtEl.textContent = txt;
      el.classList.remove('hidden');
      const watchBtn = document.getElementById('glad-watch-btn');
      if(watchBtn) watchBtn.classList.add('hidden');
      /* Winning gladiator pays the full damage + kill + win bounty. The last
         survivor already collected per-kill cash along the way; this adds the
         performance-based part, which is what the rewards panel reports. */
      setTimeout(() => {
        if(!this.running) return;
        this._awardBattleCash({
          damage: this.localTank ? (this.localTank.damageDealt || 0) : 0,
          assists: this.localTank ? (this.localTank.assists || 0) : 0,
          kills:  this.localTank ? (this.localTank.kills || 0) : 0,
          won: won,
        });
        this._showResults({
          outcome: won ? 'win' : 'loss',
          headline: won ? 'VICTORY' : 'DEFEAT',
          place: this.localTank ? (this.localTank.placement || null) : null,
        });
      }, 1600);
    }
  }

  async startFreeRoam(){
    Menu.showConnecting('Joining free roam worldÃ¢â‚¬Â¦');
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
    // Free roam never loads its own map Ã¢â‚¬â€ drop a leftover GLB battle map
    // from the previous match instead of leaving it in the arena.
    if(this.world && this.world._disposeGLBGroup) this.world._disposeGLBGroup();
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
      s: { time: this.time, tanks: this.tanks.map(tk => tk.snapshot()), projs: this.projectiles.filter(p=>!p.dead).map(p=>({id:p.id,x:p.x,y:p.y,z:p.z,dx:p.dir.x,dz:p.dir.z,type:p.type,life:p.life,mt:p._isMortar?1:0})) }
    });
  }

  _onFreeRoamLeave(peerId){
    this._onClientLeave(peerId);
    delete this.clientTankInputs[peerId];
  }

  /* ---------- HOST (P2P) ---------- */
  async startHost(cfg){
    Menu.showConnecting('Creating roomÃ¢â‚¬Â¦');
    try{
      await Net.hostRoom({maxPlayers:cfg.maxPlayers, isPublic:cfg.isPublic, fakePlayers:cfg.fakePlayers, code:cfg.code});
    }catch(e){
      Menu.hideConnecting();
      Menu.toast(e.message||'Failed to host');
      return;
    }
    Menu.hideConnecting();
    Menu.toast('Room live Ã¢â‚¬â€ Code: '+cfg.code);
    /* P2P fast path. Only the host decides this, because only the host owns the
       simulation and only the host has a channel for every client to dial. When the
       host opts in, the host gets a P2P id, tells the clients what it is, and the
       clients open a direct channel to it. When the host does not opt in, or when
       WebRTC is unavailable, every byte still goes over the server relay exactly as
       before Ã¢â‚¬â€ there is no dead path here, only a faster one when it works.

       The toggle the host sets in the multiplayer networking settings is the single
       source of truth for this match. It is NOT auto-enabled, because auto-enabling
       would change a match's behaviour depending on a client's browser, which is the
       kind of invisible change that is impossible to debug. */
    if(typeof Net !== 'undefined' && Net.p2p && this._p2pHostOptIn()){
      Net.p2p.enabled = true;
      Net.p2p.myId = Net._p2pId();
      Net.p2p.roles[Net.p2p.myId] = 'host';
      Net.p2p.hostId = Net.p2p.myId;
      if(typeof Net.setP2PHostId === 'function') Net.setP2PHostId(Net.p2p.myId);
      /* Tell every client the host's P2P id so they can open a direct line. This
         goes over the relay because the channel those clients will use is what would
         otherwise carry it. */
      const p2pPeerIds = (typeof Net.p2pPeerIds === 'function') ? Net.p2pPeerIds() : [];
      for(const id of p2pPeerIds){
        try{ if(typeof Net.sendP2PHostIdToClient === 'function') Net.sendP2PHostIdToClient(id, Net.p2p.myId); }catch(e){}
      }
      /* Clients that are already in the match get the host id as soon as they join.
         The onP2PId handler below will also pick them up when they send their id. */
    }

    this.mode='host'; this._resetArena();

    /* SANDBOX. The map was chosen by the host in the sandbox room and rides in
       on the cfg, because the host is the only player whose choice is
       authoritative and every guest has to end up on the same map. It loads as
       a GLB, which is asynchronous, so this branch awaits and finishes the host
       setup itself; the modes below keep the synchronous loadCustomMapData()
       path they have always used. */
    if(cfg.gamemode === 'sandbox' && cfg.sandboxMap){
      await this._loadSandboxMap(cfg.sandboxMap);
      this._spawnLocal(undefined, undefined, undefined, this._sandboxSpawnY);
      /* Same rule as remote joiners above: a sandbox is not a match, so the host
         is not eliminated either. */
      if(this.localTank){ this.localTank.maxHp = 9999; this.localTank.hp = 9999; }
      for(let i=0;i<cfg.fakePlayers;i++) this._spawnBot();

      Net.onPlayerJoin = (info)=> this._onClientJoin(info);
      Net.onPlayerLeave = (peerId)=> this._onClientLeave(peerId);
      Net.onInput = (peerId, inp)=> { this.clientTankInputs[peerId] = inp; };

      this._begin();
      return;
    }

    try {
      var m = this._useCustomMap ? loadCustomMap() : null;
      if(!m && cfg.gamemode === 'gladiator' && typeof GLADIATOR_MAP !== 'undefined' && GLADIATOR_MAP) m = GLADIATOR_MAP;
      if(!m) m = loadMainMap();
      if(!m && typeof DEFAULT_MAP !== 'undefined' && DEFAULT_MAP) m = DEFAULT_MAP;
      if(m) this.world.loadCustomMapData(m);
      else this.world._disposeGLBGroup();
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

    /* ALREADY IN THE ARENA? A player who was on the roster was spawned by the
       mode starter, before their socket ever announced them. This used to spawn
       them a SECOND time at a random world position with no team -- so a matched
       player ended up with two tanks: the correct one on a team, and a duplicate
       teamless one they could see but nobody could score kills with. */
    const existing = this.clientTanks && this.clientTanks[info.peerId];
    if(existing){
      /* Keep the authoritative spawn, but take the fresh identity if the roster
         only had a placeholder. */
      if(info.name && !existing.name) existing.name = info.name;
      this._sendSpawnAndState(info.peerId, existing);
      return;
    }

    const def = TANKS[info.tank] || TANKS.coolbuddy;
    /* A sandbox has no sides to balance and no spawn markers worth trusting, so
       a late arrival lands somewhere on the map that is actually there instead
       of being handed a team slot it never asked for. */
    const sp = this._isSandbox   ? this.world.randomSpawn()
             : this.glad         ? this._gladSpawnForNew()
             :                    this._teamSpawnForNew();
    const t = new Tank(def, {
      id:'remote-'+info.peerId,
      name: info.name || 'Player',
      ownerPeer: info.peerId,
      x: sp.x,
      z: sp.z,
      heading: sp.ry != null ? sp.ry : Math.random()*6,
      color: info.color || def.color,
      startY: this._isSandbox ? (this._sandboxSpawnY || 0) : undefined
    });
    this._finalizeTank(t);

    /* Nobody gets eliminated in a sandbox. It is a room, not a match, and a
       player who spends the afternoon in the same corner as someone else
       should not be removed from it for the evening. */
    if(this._isSandbox){
      t.maxHp = 9999;
      t.hp = 9999;
    }

    /* Put late joiners on the smaller team so the match cannot tip. */
    if(this._tdmState){
      const blue = this.tanks.filter(x => x.team === 'blue').length;
      const red  = this.tanks.filter(x => x.team === 'red').length;
      t.team = (blue <= red) ? 'blue' : 'red';
      if(t._spawnPos) t._spawnPos = { x: sp.x, y: (t._spawnPos||{}).y, z: sp.z };
    }

    t._remoteTankId = info.tank || 'coolbuddy';
    this.tanks.push(t);
    this.clientTanks[info.peerId] = t;
    this._sendSpawnAndState(info.peerId, t);
  }

  /* A spawn point on the emptier team. TDM and Capture the Circle both keep
     their spawn lists once the arena is built; anything else falls back to a
     plain random spawn. */
  _teamSpawnForNew(team){
    const blue = this._tdmBlueSpawns || [];
    const red  = this._tdmRedSpawns || [];
    const t = team || (blue.length <= red.length ? 'blue' : 'red');
    const pool = (t === 'red') ? red : blue;
    if(pool.length){
      const used = this.tanks.filter(x => x.team === t).length;
      const sp = pool[used % pool.length];
      return { x: sp.pos.x, z: sp.pos.z, ry: sp.ry };
    }
    return this.world.randomSpawn();
  }

  _sendSpawnAndState(peerId, tank){
    const t = tank;
    if(!t) return;
    /* Send spawn data to this client so they know where they are.

       `team` is part of this, not decoration. The host decides which side a
       player fights on Ã¢â‚¬â€ it picked the spawn point, and the spawn point's side
       IS the team Ã¢â‚¬â€ so without sending it the client keeps whatever its own
       local build happened to choose. The two then disagree about who is an
       ally, and the client's own tank is drawn in the wrong colour and counted
       for the wrong side. Sending it here means one message settles position,
       facing and team together. */
    Net.sendSpawnToClient(peerId, {
      id: t.id,
      x: t.x,
      z: t.z,
      heading: t.heading,
      team: t.team || null,
      /* The client's own tank definition, from the roster entry that spawned
         this tank. Guessing 'coolbuddy' here meant a client who picked Striker
         was told it was driving a Cool Buddy, and its model and stats on the
         client disagreed with the host's for the whole match. */
      tankId: (t._remoteTankId) || (t.def && t.def.id) || 'coolbuddy',
      name: t.name || 'Player'
    });
    // Send full current state to the newly joined client so they see everyone
    Net.sendFullStateToClient(peerId, {
      time: this.time,
      glad: this.glad ? this._gladSnapshot() : null,
      /* A client that joins mid-match gets the bases at their current health
         from here, so it does not open the arena showing two undamaged bases in
         a match that is half over. */
      bases: this._baseDefendMode ? BaseDefend.snapshot() : null,
      tanks: this.tanks.map(tk => tk.snapshot()),
      projs: this.projectiles.filter(p=>!p.dead).map(p=>({id:p.id,x:p.x,y:p.y,z:p.z,dx:p.dir.x,dz:p.dir.z,type:p.type,life:p.life,mt:p._isMortar?1:0}))
    });
  }

  _onClientLeave(peerId){
    const t = this.clientTanks[peerId];
    if(t){ t.detach(); this.tanks = this.tanks.filter(x=>x!==t); delete this.clientTanks[peerId]; }
    delete this.clientTankInputs[peerId];
  }

  /* ============================================================================
     RESET THE PER-MATCH NETWORK STATE

     Called from _resetArena(). Every one of these used to survive a match:
     _matchRoster left the PREVIOUS match's players on the roster, so the next
     battle spawned a couple of ghosts named after strangers who had already
     left; _matchHumans left last round's headcount behind, which made the map
     vote wait for players who were never going to vote; and _netPending left
     true, so the next client match tried to open a second arena on top of a
     live one.

     That is the "multiplayer is broken" family of bugs: state from a finished
     match leaking into the next one.
     ============================================================================ */
  _resetNetMatchState(){
    /* While a match is ARMED, this must not clear anything.

       Every mode starter calls _resetArena() AFTER startTDMHost() has recorded
       the match -- and then keeps building the arena asynchronously, spawning
       tanks long after that. So clearing here threw away the roster the queue
       had just produced (every slot went to a bot, which is the original
       "two people press PLAY and never see each other"), reset mode to 'sp' so
       the snapshot broadcast never ran, and left the client waiting on a host
       that was never broadcasting.

       The match ends in leaveToMenu(), which calls _forgetNetMatch(). That is
       the only place these are cleared, so a rebuild mid-match is harmless and
       leaving the match actually cleans up. */
    if(this._netArmed) return;

    this._matchCode = null;
    this._matchRoster = null;
    this._matchHumans = 1;
    this._netRole = null;
    this._netPending = false;
    this._pendingMode = null;
  }

  /* Called by leaveToMenu(): the match genuinely ended, so forget it. */
  _forgetNetMatch(){
    this._netArmed = false;
    this._resetNetMatchState();
    this._armedCode = null;
    this._armedRoster = null;
    this._armedHumans = 1;
    this._armedRole = null;
    this._armedMap = null;
  }

  /* ============================================================================
     RE-ARM THE NETWORK ROLE AFTER A MODE STARTER RESET IT

     Called by Menu._startModeAfterVote() immediately before the arena is built.

     Every mode starter sets `this.mode = 'sp'` and calls _resetArena(), and
     _resetArena() clears the per-match network state. So startTDMHost() setting
     mode='host' and stashing the roster BEFORE the map vote does not survive to
     the first frame: by the time the tanks exist, the game believes it is a
     local single-player battle, _update()'s broadcast branch never fires, and
     the client receives nothing. The match runs, correctly, but alone.

     This restores exactly what was lost, and does nothing at all when there is
     no match (no _matchCode), so solo play keeps mode='sp' and stays local.

     mode matters beyond bookkeeping: it gates the snapshot broadcast, the input
     forwarding, and whether the local tank is driven by this player or by the
     host's corrections.

     WHY THIS IS CALLED TWICE, AND WHY IT PERSISTS

     Arming once is not enough, and that was the bug in the first attempt at
     this fix. The mode starters are not a single call: startTeamDeathmatch()
     sets mode='sp', calls _resetArena() (which clears the match state), and
     then does an ASYNCHRONOUS GLB load whose .then() goes on to build the
     spawns, the tanks and _begin(). So arming before the starter is undone by
     the starter's own _resetArena() a few lines later -- the trace showed
     exactly that: _armNetMode, then _resetArena, then _resetNetMatchState.

     And arming inside that .then() is not possible from here, because it is
     per-mode code with no hook.

     So the state is made sticky instead: _armNetMode sets _netArmed, and
     _resetNetMatchState no longer clears the match fields while a match is
     armed. Re-arming is then idempotent and cheap, and _forgetNetMatch() (from
     leaveToMenu) is the single place that ends it. A second call from the
     vote-completion path is harmless.

     BUT STICKY ALONE IS NOT ENOUGH, and this is the part that took three
     attempts to find. The starter's own `this.mode = 'sp'` still executes
     AFTER the arm, and silently demotes the host back to a local game. The
     roster survives, _netRole survives, and mode does not -- so _update()'s
     `if(this.mode === 'host')` broadcast never fires. The state left behind is
     exactly that contradiction: _netRole 'host', roster 16, mode 'sp', ten
     tanks, nothing on the wire.

     The mode value is therefore re-asserted from the one place that runs after
     EVERY starter: _begin(). By the time _begin() runs, the arena and all its
     tanks exist, so setting the mode there is both correct and final -- nothing
     later in the start sequence overwrites it. See _begin(). */
  _armNetMode(mode){
    const role = this._armedRole;
    if(!this._armedCode || (role !== 'host' && role !== 'client')) return false;

    /* Put back everything _resetArena() cleared. */
    this._matchCode   = this._armedCode;
    this._matchRoster = this._armedRoster;
    this._matchHumans = this._armedHumans;
    this._netRole     = role;
    this._netArmed    = true;
    this.mode = role;

    /* Restore the map the vote chose.

       Read live from Menu rather than from _armedMap: the vote finishes AFTER
       startTDMHost() ran, so _armedMap was captured while the choice was still
       null and could only ever be null. Menu._votedMap is set by the vote's
       completion callback, which runs immediately before this. */
    const voted = (typeof Menu !== 'undefined') ? Menu._votedMap : null;
    if(voted){
      this._votedMap = voted;
      this._armedMap = voted;
    }

    if(role === 'host'){
      Net.onPlayerJoin  = (info) => this._onClientJoin(info);
      Net.onPlayerLeave = (peerId) => this._onClientLeave(peerId);
      Net.onInput       = (peerId, input) => { this.clientTankInputs[peerId] = input; };
      /* Tell the server the battle is live so clients stop showing "JoiningÃ¢â‚¬Â¦" and
         know the arena exists. */
      try { Net.markMatchStarted(); } catch(e){}
    } else {
      Net.onState = (snap) => this._applyHostState(snap);
    }

    /* BOTH ROLES NEED THIS. The host installs it so it can finish the match from
       its own broadcast (and ignore the echo), the client so it can finish when
       the host says the match is over.

       Installed here, once, for both roles, because wiring it in two places is
       how one role ends up with a handler the other lacks Ã¢â‚¬â€ and the symptom of a
       missing client handler is a player frozen in a battle that has ended, which
       looks like a netcode bug and is not one. */
    Net.onMatchEnd = (info) => {
      if(!this.running) return;
      this._finishMatch({
        winnerTeam: info.winnerTeam,
        reason: info.reason,
      });
    };

    console.log('[tdm] net mode armed: ' + this._netRole + ' (' + mode + ')');
    return true;
  }

  /* ============================================================================
     MATCH-MAKER ENTRY POINTS
     ============================================================================
     matchmaking.js calls Game.startTDMHost() the moment the server says this
     client is the host of a match. That function DID NOT EXIST anywhere in the
     codebase -- matchmaking.js has called it since the queue was written:

         if(game && game.startTDMHost){ game.startTDMHost(code, players); }

     The guard `game && game.startTDMHost` was quietly false forever, so a
     perfectly good match did nothing at all: no arena, no battle, no error. The
     player sat in the map vote and then nothing happened. The guard is what
     hid it.

     Defined here so the host really does open the arena. It deliberately does
     NOT start the mode itself: Menu._startModeAfterVote() owns that, because
     the map vote is what decides the map, and the map has to be applied before
     the GLB is fetched. Starting the mode here as well would double-load the
     map, which is the "duplicate tanks and props from two maps" chaos that
     startCaptureTheCircle's re-entry guard was written to stop.

     What it does instead:
       * records the roster, so _rosterHumans() spawns the real players
       * flips this client into host mode, so _update() broadcasts snapshots
       * wires the Net callbacks that feed remote tanks their input
       * sends the local player straight to the match, so the opponent starts
         moving immediately instead of waiting out the whole map vote          */
  startTDMHost(code, roster, humans){
    /* Recorded in the *_armed slots as well as the live ones: the mode starter
       runs later and its _resetArena() clears the live set. See
       _resetNetMatchState. */
    this._armedCode   = code || null;
    this._armedRoster = (roster && roster.length) ? roster : null;
    this._armedHumans = Math.max(1, humans || 1);
    this._armedRole   = 'host';
    this._armedMap    = (typeof Menu !== 'undefined') ? Menu._votedMap : null;

    this._matchCode = this._armedCode;
    this.setMatchRoster(this._armedRoster);
    this._matchHumans = this._armedHumans;

    /* Host-authoritative: this is what makes _update() broadcast at ~20Hz. */
    this.mode = 'host';
    this._netRole = 'host';

    /* Remote players drive their tanks through these. The ids are the server's,
       which is the same set _rosterHumans() filters on, so a tank and its input
       always agree on who owns it. */
    Net.onPlayerJoin  = (info) => this._onClientJoin(info);
    Net.onPlayerLeave = (peerId) => this._onClientLeave(peerId);
    Net.onInput       = (peerId, input) => { this.clientTankInputs[peerId] = input; };

    /* Announce ourselves so anyone already in the arena gets our tank. The
       server forwards this to the host, which for us is a no-op, but a client
       that reconnects mid-match relies on the roster broadcast instead. */
    try {
          Net.onP2PId = (msg) => this._onP2PId(msg);

    // Send our P2P id to the host as soon as we have one, over the relay (the
    // channel we are about to open cannot carry the first one).
    if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.myId){
      try{ if(typeof Net.sendP2PId === 'function') Net.sendP2PId(Net.p2p.myId); }catch(e){}
    }

    // If the host turned the P2P fast path on, take it.
    if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId){
      Net.p2p.myId = Net._p2pId();
      Net.p2p.roles[Net.p2p.myId] = 'client';
      if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, Net.p2p.myId);
      if(typeof Net.openP2PToHost === 'function') Net.openP2PToHost();
      if(typeof Net.startP2PRetries === 'function') Net.startP2PRetries();
    } else {
      // Tell the host our P2P id anyway, so if the host turns P2P on later (it does
      // not, but a reconnect/resume path may), the host already knows how to reach us.
      if(typeof Net !== 'undefined' && Net.p2p){
        Net.p2p.myId = Net._p2pId();
        if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, Net.p2p.myId);
        try{ if(typeof Net.sendP2PId === 'function') Net.sendP2PId(Net.p2p.myId); }catch(e){}
      }
    }
Net.sendJoinInfo(
        (this.settings && this.settings.playerName) || 'Player',
        (this.settings && this.settings.selectedTank) || 'coolbuddy',
        ((TANKS[this.settings && this.settings.selectedTank] || {}).color) || 0x888888
      );
    } catch(e){}

    console.log('[tdm] host of ' + code + ' Ã¢â‚¬â€ ' + this._matchHumans + ' human(s), ' +
                ((roster && roster.length) || 0) + ' total roster entries');
    return true;
  }

  /* The client half.

     The map is the HOST's to decide and load, so a client must not fetch its
     own copy -- two independent GLB loads can disagree about spawn points and
     the teams stop matching. What the client does instead is remember who it
     is, then open the SAME arena the host opened when the first snapshot lands
     (_applyHostState does that). Until then it shows the connecting screen, so
     the player gets "Joining matchÃ¢â‚¬Â¦" rather than an empty world that looks
     broken. */
  startTDMClient(code, roster, humans){
    this._armedCode   = code || null;
    this._armedRoster = (roster && roster.length) ? roster : null;
    this._armedHumans = Math.max(1, humans || 1);
    this._armedRole   = 'client';
    this._armedMap    = (typeof Menu !== 'undefined') ? Menu._votedMap : null;

    this._matchCode = this._armedCode;
    this.setMatchRoster(this._armedRoster);
    this._matchHumans = this._armedHumans;
    this.mode = 'client';
    this._netRole = 'client';

    /* Which arena to open. Mirrors Menu's own routing so the client's world
       matches the host's; if Menu has already recorded a vote we use that. */
    this._pendingMode = (typeof Menu !== 'undefined' && Menu._votedMap && Menu._selectedGamemode)
      ? Menu._selectedGamemode
      : (typeof Menu !== 'undefined' ? Menu._selectedGamemode : null) || 'captureTheCircle';
    /* NOT auto-started from the snapshot stream any more -- see
       _applyHostState. Menu._startWhenMapKnown() opens the arena once the host
       has announced the map, which is the only path in. */
    this._netPending = false;

    Net.onState = (snap) => this._applyHostState(snap);
    /* The host's "this is your tank" message. Without this the client never
       learns _myRemoteId, and _applyHostState cannot correct the local tank
       toward the authoritative one -- so the player drives a tank that does not
       go where the host thinks it is. */
    Net.onWelcome = (msg) => this._onClientWelcome(msg);
    Net.onPlayerLeave = (peerId) => {
      if(peerId === 'host'){
        Menu.toast('Host disconnected');
        this.leaveToMenu();
      }
    };

    try {
      Net.sendJoinInfo(
        (this.settings && this.settings.playerName) || 'Player',
        (this.settings && this.settings.selectedTank) || 'coolbuddy',
        ((TANKS[this.settings && this.settings.selectedTank] || {}).color) || 0x888888
      );
    } catch(e){}

    try { Menu.showConnecting('Joining matchÃ¢â‚¬Â¦'); } catch(e){}

    console.log('[tdm] client in ' + code + ' Ã¢â‚¬â€ waiting for the host to start the battle');
    return true;
  }

  /* Open the arena on a networked client. The roster is already on this, so
     _rosterHumans() spawns the other real players and the mode's own bot loops
     fill the rest -- the same code path singleplayer uses, which is the point:
     one arena builder, one spawn layout, no second implementation to drift. */
  _netStartArena(mode){
    const m = mode || 'captureTheCircle';
    this._netPending = false;
    try {
      if(m === 'team-deathmatch') this.startTeamDeathmatch();
      else if(m === 'gladiator') this._startGladiator();
      else if(m === 'baseDefend') this.startBaseDefend();
      else this.startCaptureTheCircle();
    } catch(e){
      console.error('Client arena start failed:', e);
      Menu.hideConnecting();
      Menu.toast('Could not open the battlefield');
    }
  }

  /* ---------- CLIENT ---------- */
  async startClient(code){
    Menu.showConnecting('Joining roomÃ¢â‚¬Â¦');
    try{
      await Net.joinRoom(code);
    }catch(e){
      Menu.hideConnecting();
      Menu.toast(e.message||'Could not join room');
      return;
    }
    Menu.hideConnecting();
    this.mode='client'; this._resetArena();
    // Joined a room: no local map load happens here, so drop any GLB map
    // left over from a previous single-player match.
    if(this.world && this.world._disposeGLBGroup) this.world._disposeGLBGroup();
    
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
    Menu.showConnecting('Joining as spectatorÃ¢â‚¬Â¦');
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
    // Watch-only: no local map load Ã¢â‚¬â€ drop a leftover GLB battle map.
    if(this.world && this.world._disposeGLBGroup) this.world._disposeGLBGroup();

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
    // Pure spectator Ã¢â‚¬â€ no tank HUD or touch joysticks
    const hud = document.getElementById('hud');
    if(hud) hud.classList.add('hidden');
    if(this.input && this.input.setJoysticksVisible) this.input.setJoysticksVisible(false);
    this._initSpectatorHud();
    Menu.toast('Spectating Ã¢â‚¬â€ pick a tank or use freecam at the bottom');
  }

  /* P2P id message arrived over the server relay. Two forms:

     * client -> host: "{ t:'p2p-id', p2pId }" Ã¢â‚¬â€ this client's P2P id, so the host
       can address it directly.
     * host -> client: "{ t:'p2p-id', to: peerId, p2pId }" Ã¢â‚¬â€ the host's P2P id, so
       this client can open a direct channel to it.

     The same callback handles both; the caller (Net.onP2PId) wires whichever form
     the current role expects. */
  _onP2PId(msg){
    if(!msg || typeof msg !== 'object') return;
    if(msg.to != null){
      // Host -> client: this is the host's P2P id.
      if(typeof Net !== 'undefined' && Net.p2p){
        Net.p2p.hostId = msg.p2pId || null;
        if(typeof Net.setP2PHostId === 'function') Net.setP2PHostId(Net.p2p.hostId);
        if(Net.p2p.enabled){
          if(typeof Net.openP2PToHost === 'function') Net.openP2PToHost();
          if(typeof Net.startP2PRetries === 'function') Net.startP2PRetries();
        }
      }
      return;
    }
    // Client -> host: this client's P2P id.
    if(msg.p2pId && this.mode==='host' && typeof Net !== 'undefined' && Net.p2p){
      if(typeof Net.setP2PClientId === 'function') Net.setP2PClientId(Net.myPeerId || Net.playerId, msg.p2pId);
    }
  }

  /* The host's P2P fast-path opt-in toggle. Read from the multiplayer networking
     settings, which the host sets in the menu. Returns false until the host turns
     the toggle on, so a match never silently goes P2P because a client's browser
     happens to have WebRTC Ã¢â‚¬â€ that would be an invisible, un-debuggable change. */
  _p2pHostOptIn(){
    try {
      return !!(this.settings && this.settings.p2pHostFastPath === true);
    } catch(e){
      return false;
    }
  }

  _onClientWelcome(msg){
    /* THE HOST'S SPAWN POINT IS WHERE THIS PLAYER ACTUALLY STARTS.

       The old code assigned localTank.x / .z and then called _syncTransform(),
       which is a no-op for the move: _syncTransform() reads x and z back OUT
       of the rigid body, so the body overwrote the assignment on the very next
       line. The client's tank therefore stayed at whatever spawn point IT
       picked locally, and the correction was discarded.

       That is why two players could not see each other. The host had put this
       player on one side of the map, the client had independently put itself
       somewhere else entirely, and both screens showed their own version as
       ground truth. Each player was looking at a corner of the arena the other
       was never in.

       snapToPosition() moves the body, so the host's spawn actually takes
       effect. Team comes along too, because the side you spawn on decides it. */
    if(msg.id && msg.id.indexOf('remote-') === 0){
      this._myRemoteId = msg.id;
    }
    if(msg.x !== undefined && this.localTank){
      if(this.localTank.snapToPosition){
        this.localTank.snapToPosition(msg.x, msg.z,
          msg.heading !== undefined ? msg.heading : this.localTank.heading);
      } else {
        this.localTank.x = msg.x;
        this.localTank.z = msg.z;
        if(msg.heading !== undefined) this.localTank.heading = msg.heading;
        this.localTank._syncTransform();
      }
    }
    /* The host owns which team this player is on. Applying it here means the
       client's own tank is the right colour, counts for the right side in the
       scoreboard, and is a friend rather than an enemy to its teammates Ã¢â‚¬â€ all
       from the same message that placed it. */
    if(msg.team && this.localTank && this.localTank.team !== msg.team){
      this.localTank.team = msg.team;
      this.localTank._spawnHeading = (msg.team === 'blue') ? 0 : Math.PI;
      this._spawnGlowRectFor(this.localTank);
    }
    if(msg.name && this.localTank) this.localTank.name = msg.name;
  }

  /* Re-point a tank's team glow when its team is corrected after the fact.
     Best effort: a map with no glow rects simply has nothing to move. */
  _spawnGlowRectFor(tank){
    if(!this._glowRects || !tank) return;
    const want = (tank.team === 'red') ? 'red' : 'blue';
    for(const g of this._glowRects){
      if(g && g.team === want) g.mesh.position.set(tank.x, 0.02, tank.z);
    }
  }

  _applyHostState(snap, snapDt){
    if(!snap || !snap.tanks) return;
    /* How long ago the previous snapshot was, so the correction rate is a real
       speed rather than a per-snapshot fraction. Snapshots arrive at ~12Hz, so
       this is normally around 0.083s. The first snapshot has nothing to compare
       against and uses one nominal step. */
    const CORRECT_DT = (snapDt != null && snapDt > 0 && snapDt < 1) ? snapDt : 0.083;
    if(snap.time) this.time = snap.time;
    if(snap.glad) this._gladApplyHostSnapshot(snap.glad);
    if(snap.bases) BaseDefend.applyHostSnapshot(snap.bases);

    /* A queued client opens its arena from the HOST'S MAP ANNOUNCEMENT, not
       from the first snapshot.

       It used to be the other way round, and having both was a race: the client
       had two independent starts, and whichever lost left the game in the wrong
       mode. If the snapshot path won, _netStartArena() ran the mode starter,
       which sets mode='sp' -- so the client ran the whole battle as LOCAL
       single-player, sent no input, and ignored every snapshot. If the
       announcement path won it was correct.

       One path only: the announcement. The client is told which map, and starts
       on exactly that map. */
    
    // Apply host state to local tank via remote representation
    if(snap.tanks && this.localTank && this._myRemoteId){
      const mySnap = snap.tanks.find(s => s.id === this._myRemoteId);
      if(mySnap){
        const wasAlive = this.localTank.alive;
        /* THE CLIENT'S OWN TANK IS PREDICTED LOCALLY AND CORRECTED BY THE HOST.

           The two disagree constantly, and that disagreement used to be visible
           as the tank juddering while driving. Why:

             * the client simulates its tank at 60Hz from its own input;
             * the host simulates the SAME tank from input that arrived over the
               network, and broadcasts the result at 12Hz;
             * so the two copies are always a little apart, and the client was
               pulling itself 30% of the way to the host's answer twelve times a
               second, on top of a third of a second of accumulated drift.

           A 30% pull at 12Hz is a correction every frame the player can feel. It
           is the "my tank glitched while I drove" report: the tank would drift
           one way under its own power, get yanked part-way back, drift again,
           and the visible result is a wobble that no amount of careful driving
           can hold still.

           So the correction is now conditional and mostly invisible:

             * under a threshold, do nothing at all. Ordinary latency error is
               not worth correcting and correcting it is what caused the judder;
             * over it, ease toward the host at a fixed RATE rather than a fixed
               fraction, so a big error is walked off smoothly instead of
               jumped;
             * a genuine teleport (respawn, big map) still snaps, because easing
               across a map is worse than a jump.

           Heading is NOT corrected at all while the tank is alive and driving.
           The host's heading is 12Hz and behind; forcing the client's own tank
           to face it fights the player's own steering input and is the other
           half of the judder. The host stays authoritative for everything that
           actually matters Ã¢â‚¬â€ hp, kills, alive Ã¢â‚¬â€ and those are applied
           immediately below. */
        /* PROJECT THE HOST'S REPORT FORWARD before comparing.

           The snapshot describes where the tank was when the host SENT it Ã¢â‚¬â€ up
           to one send interval plus one network hop ago. Coasting that report
           along its own reported heading and speed absorbs the systematic part
           of the disagreement: on a straight drive the projected report is
           where the tank already is, so only a REAL divergence (a bump that
           resolved differently, a rubber-band, a teleport) crosses the
           deadzone, and ordinary driving never feels a correction at all.

           The age is a fixed ~100 ms (half a send interval + half a round
           trip): long enough to cancel the systematic lag, short enough that a
           turn can't run the projection away from the true corner. */
        const snapSp = (typeof mySnap.sp === 'number' && isFinite(mySnap.sp)) ? Math.max(0, mySnap.sp) : 0;
        const projX = mySnap.x + Math.sin(mySnap.h) * snapSp * 0.10;
        const projZ = mySnap.z + Math.cos(mySnap.h) * snapSp * 0.10;
        const dx = projX - this.localTank.x;
        const dz = projZ - this.localTank.z;
        const drift = Math.hypot(dx, dz);
        /* The deadzone scales with speed: every unit/s of travel buys 0.25
           world units of tolerance, the same way latency grows with speed. */
        const dead = Math.max(CORRECT_DEADZONE, snapSp * 0.25);
        if(drift > 25){
          /* Respawn or map change: the host is somewhere else entirely. */
          this.localTank.snapToPosition(mySnap.x, mySnap.z, mySnap.h);
        } else if(drift > dead){
          /* Walk the error off at a steady speed. */
          const step = Math.min(drift - dead, CORRECT_RATE * CORRECT_DT);
          const k = step / (drift || 1);
          this.localTank.snapToPosition(
            this.localTank.x + dx * k,
            this.localTank.z + dz * k,
            this.localTank.heading);
        }
        /* OWN ALTITUDE, TOO, WITH THE SAME MANNERS AS THE DRIFT CORRECTION.

           The block above reconciles X/Z only, so a tank whose local body ended
           up inside the hill (a collider race while the map streamed in, a
           respawn drop that resolved differently on the host) stayed buried on
           THIS machine forever: nobody's snapshot correction ever touched the
           vertical, and the player saw a hill they could not get out of while
           the host's copy of them stood cleanly on top of it.

           Y has one rule X/Z does not: falling must be respected. A correction
           that never fights a fall in progress is requirement number one Ã¢â‚¬â€ the
           host's report arrives one send interval late, and pulling it down
           mid-drop turns the respawn drop into steps. So: a generous deadzone,
           a dead-band eased walk under it, and a raw snap only past 4 units
           (a genuine fall-through, not latency). The body is moved through its
           translation, because _syncTransform reads x/y back out of the body
           and would otherwise overwrite the correction a frame later. */
        const snapY = (typeof mySnap.y === 'number' && isFinite(mySnap.y)) ? mySnap.y : null;
        if(snapY != null && this.localTank.alive && !this.localTank.dying && this.localTank._allowFall){
          const lt = this.localTank;
          const curY = (typeof lt._visualY === 'number' && isFinite(lt._visualY))
            ? lt._visualY : (lt.y || 0);
          const dy = snapY - curY;
          const ady = Math.abs(dy);
          if(ady > 4){
            /* Fell through, or respawned while this client was asleep: snap. */
            if(lt._physBody){
              try { lt._physBody.setTranslation({x:lt.x, y:snapY, z:lt.z}, false); } catch(e){}
            }
            lt.y = snapY; lt._visualY = snapY;
          } else if(ady > 0.75){
            /* Walk up to the host at a capped rate. */
            const stepY = Math.sign(dy) * Math.min(ady - 0.75, 30 * CORRECT_DT);
            const ny = curY + stepY;
            if(lt._physBody){
              try { lt._physBody.setTranslation({x:lt.x, y:ny, z:lt.z}, false); } catch(e){}
            }
            lt._visualY = ny;
          }
        }
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
    
    /* THE SET OF IDS TO SKIP IS NOT "MY OWN TANK'S ID".

       It was built from this.localTank.id, which is the literal string 'local'
       on BOTH sides -- the host's own tank is called 'local', and so is the
       client's. So 'local' went into `seen` on the client, the host's snapshot
       entry for its own tank was skipped, and the client never created a tank
       for the host at all: it had a roster-spawned ghost (remote-<peerId>, not
       marked net-driven) plus a second, duplicated 'local'.

       What actually has to be skipped is the MY-OWN-TANK case, which is
       identified by _myRemoteId -- the host's authoritative id for THIS player.
       Anything else in the snapshot is somebody else and must be materialised,
       including the host's own tank (whose id is 'local' on the wire). */
    const seen = new Set(this._myRemoteId ? [this._myRemoteId] : []);
    /* Never spawn a rival copy of the tank we already have locally. Only
       relevant when we did not get a _myRemoteId (no spawn message yet). */
    if(!this._myRemoteId && this.localTank) seen.add(this.localTank.id);

    /* NORMALISE WIRE IDS.

       Every player names their own tank 'local', so a snapshot from a host that
       is itself a client can carry an id that collides with ours, and there is
       no way to tell whose 'local' it is. Rewriting a bare 'local' to
       'remote-<peerId>' on the way in makes every id on the wire globally
       unique, so 'remote-p-abc' is always that specific player and never
       depends on who is asking. The host rewrites its own 'local' too, which is
       what lets a client recognise the host's tank at all. */
    const wireId = (id) => (id === 'local')
      ? ('remote-' + (Net.hostId || 'host'))
      : id;

    (snap.tanks||[]).forEach(raw=>{
      const s = raw;
      s.id = wireId(s.id);

      /* THE HOST OWNS THE COUNTDOWN. See _netSnapshotCountdown: this used to be
         counted down locally on each machine from whenever that machine loaded
         the map, so the two sides ran different countdowns and the player saw
         one window with a countdown and one without. */
      if (this.mode === 'client' && snap.cd) this._adoptHostCountdown(snap.cd);
      if(seen.has(s.id)) return;
      let t = this.tanks.find(x=>x.id===s.id);
      if(!t){
        if(s.id === this._myRemoteId) return;
        const def = TANKS[s.tank]||TANKS.coolbuddy;
        /* THE TANK IS BUILT THE WAY EVERY OTHER TANK IS: fall-enabled, at the
           height the snapshot reports.

           These ghosts used to be built WITHOUT allowFall, which pinned their
           render root to y=0 forever (see Tank._syncTransform's altitude
           rules). Flat ground made that look correct, but the moment the arena
           had terrain the tank drove INTO it: your own tank rode the hill while
           the other player's screen showed you standing inside it Ã¢â‚¬â€ half-buried
           and not climbing. The interpolation (_netBuf) already carries the
           host's height in s.y and feeds _visualY each render; the only thing
           missing was permission to render it. No physics world is passed and
           none is needed: a net-driven tank never touches the physics world on
           this side, render included. */
        t = new Tank(def, {id:s.id, name:s.name, x:s.x, z:s.z, heading:s.h, color:s.col,
          allowFall:true,
          startY:(typeof s.y === 'number' && isFinite(s.y)) ? s.y : undefined});
        /* Team from the snapshot, at construction. Every check that decides
           friend-or-foe Ã¢â‚¬â€ bot.js ally tests, the capture circle's headcount, the
           kill feed Ã¢â‚¬â€ runs against `team`, so a tank built without it is an
           enemy to everyone including its own teammates. */
        if(s.team) t.team = s.team;
        this._finalizeTank(t);
        this.tanks.push(t);
      }
      /* MARK EVERY REMOTE TANK, NOT JUST NEWLY CREATED ONES.

         beginNetDriven() used to sit inside the `if(!t)` branch, so it only ran
         for tanks this function created itself. But the roster already spawned
         the other player before any snapshot arrived, so that tank already
         existed -- took the "found it" path -- and was never marked.

         An unmarked tank still ran the full local simulation in _update: it read
         no input (there is none on a client), so it sat still, while its physics
         body overwrote every position the snapshot delivered. The nameplate
         appeared, because that comes from the snapshot's name -- and the tank
         never moved. That is exactly "I can see his nickname but the movement
         is not syncing".

         So this runs for every remote tank, created here or not. */
      if(!t.netDriven) t.beginNetDriven();
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
          /* `mt` marks a lobbed artillery shell. It matters here because
             without it a remote player's mortar round is rebuilt as an ordinary
             flat-flying shell: it would still follow the host's positions, but
             it would be a normal Shell with a normal expiry, and Ã¢â‚¬â€ the part
             that actually shows Ã¢â‚¬â€ its detonation is played locally below rather
             than silently vanishing when the host stops sending it. Blast damage
             is NOT recomputed: the host owns damage in this game, so this client
             plays the bang and nothing else. */
          const dummyDef = {shellSpeed:180, damage:34, shellRange:80, fireConeHalfAngle:0.12};
          if(sp.mt){
            dummyDef.shellType = 'mortar';
            dummyDef.splashRadius = 15;
            dummyDef.splashDamage = 34;
            dummyDef.splashMinDamage = 7;
            dummyDef.artilleryFlight = 1.9;
          }
          /* A MINE IS NOT A FLYING SHELL, so it must not be rebuilt as one.

             The generic branch below builds a Shell, which orients itself along
             `dir` and flies. A Landmine has no direction at all Ã¢â‚¬â€ it sits on
             the ground Ã¢â‚¬â€ so the host sends it with dx/dz of 0 (see
             _projectileSnapshot), and a Shell built from that would be a
             tumbling projectile lying in the grass where the mine actually is.

             It is built as a real Landmine so it goes through the same manager
             and draws the same mesh the host does, and then marked networked
             so it cannot do damage here: the host owns damage, and this client
             has no business detonating anything. The fuse still ticks so the
             thing disappears when the host stops sending it. */
          if(sp.type === 'mine'){
            existing = new Landmine(null, pos, dummyDef);
            existing._networked = true;
            existing.owner = { allyId:null, team:null };
          } else if(sp.type === 'flame'){
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
          /* A lobbed shell simply disappearing mid-air reads as a bug, so when
             the host stops sending one the client plays the detonation it was
             never told about. vfxOnly: the host, and only the host, decides who
             that blast hurt. */
          if(p._isMortar && !p._detonated) p._detonate(this, true);
          p.dead = true;
          p.detach();
          this.projectiles.splice(i, 1);
        }
      }
    }
  }

  /* ---------- arena reset / spawn ---------- */
  /* One brief flash on a score cell whose number just changed. The class is
     removed and re-added rather than simply toggled: assigning the same class
     twice in a row is a no-op as far as the animation engine is concerned, so a
     second consecutive kill would not flash at all. Forcing a reflow between the
     two is what makes it restart. */
  _bumpScoreCell(hud, id, prev, now){
    if(prev === now) return;
    const node = hud[id];
    if(!node) return;
    const cell = node.parentNode;
    if(!cell || !cell.classList) return;
    cell.classList.remove('bump');
    void cell.offsetWidth;      /* reflow: makes the removal take effect */
    cell.classList.add('bump');
  }

  _resetArena(){
    this._clearGladState();
    /* Team radio is per-battle. Carrying it across matches would let a fresh
       round's bots "remember" contacts that belonged to the previous map, and
       would otherwise grow without bound over a long session. */
    this._botRadio = null;
    /* The navigation grid is baked from the world's wall geometry, which the
       next few lines are about to replace. Dropping it here means the next
       plan() re-bakes against the map actually being loaded. BotNav already
       re-bakes on its own when the walls array is reassigned; this makes the
       intent explicit at the point where the map changes, and covers the
       custom-map and editor paths that swap geometry without a reset. */
    try { if(window.BotNav && this.world) BotNav.invalidate(this.world); }catch(e){}
    /* What THIS battle has earned, for the live score strip. Zeroed here because
       _resetArena runs on every mode start, so the strip cannot carry the last
       battle's cash into the next one.

       A separate counter rather than a difference against the wallet, because the
       wallet is also written by things that are not earnings: a shop purchase or
       a box claim would drive the delta down and the strip would then show less
       than has actually been made. Counting the payouts themselves cannot be
       confused with a spend. */
    this._battleCash = 0;
    /* Cleared per battle so the watchdog in _showResults can fire for THIS
       match only, and so a second result screen cannot stack on the first. */
    this._resultsShown = false;
    this._trophyAwardedThisMatch = false;
    this._skipPending = false;
    /* No closing shot left over from the last battle. The one that matters is
       in leaveToMenu, which is where a shot actually gets interrupted; this is
       belt-and-braces for the case where a battle is reset without leaving. */
    this._resultsWatchdog = null;
    this._endCineTearDown();
    /* Re-arm the Tab+P combo for this battle. See _armSkipCombo for why this is
       per-battle rather than cleared on key release. */
    this._armSkipCombo();
    try {
      if(typeof Results !== 'undefined' && Results.hide) Results.hide();
    }catch(e){}
    /* Cash is the ONLY currency a battle pays. These two used to sit here and
       were paid at random per kill, which is how the third currency ended up
       being handed out for free. The results screen shows cash alone. */

    /* Quest progress as it stood BEFORE this battle.

       Taken here, in _resetArena, because that is the one point every mode
       passes through before a single shot is fired Ã¢â‚¬â€ the results screen needs
       to know which quests the battle moved, and progress on its own cannot say
       that. A quest at 2/3 when the battle starts and 2/3 when it ends is a
       quest the battle did not touch, and showing it would imply otherwise.

       Stored as a copy, not a reference: MISSIONS_STATE is mutated in place as
       the battle runs, so holding the object itself would compare the battle
       against itself and find no change at all. */
    this._missionSnapshot = null;
    this._missionRecorded = false;
    try {
      if(typeof Missions !== 'undefined' && Missions.snapshotProgress){
        this._missionSnapshot = Missions.snapshotProgress();
      }
      /* Tell the quest log which mode is starting, and re-take the snapshot
         AFTERWARDS is not the order: the snapshot has to be the before-picture,
         so the mode is announced first and then the picture is taken. A quest
         already advanced by an earlier line of this same function would make the
         battle look like it had done nothing. */
      if(typeof Missions !== 'undefined' && Missions.recordBattle){
        Missions.recordBattle({
          mode: this.mode,
          gamemode: this._currentGamemodeId(),
          withClanMember: !!(typeof Menu !== 'undefined' && Menu && Menu._clanData),
        });
      }
    }catch(e){}
    /* Per-match network state must not survive into the next battle: a stale
       roster spawns ghosts of players who already left, a stale headcount makes
       the map vote wait for voters who do not exist, and a stale _netPending
       makes the next client match open a second arena over a live one. */
    this._resetNetMatchState();
    /* The cached map-edge object belongs to the map being left behind. Forget
       it, so the next Ctrl+M rebuilds for the new arena instead of toggling a
       line drawing of geometry that is no longer there. */
    if(this._mapOutlineList){
      /* They are children of their meshes, so they go with the map; drop the
         references so the next Ctrl+M rebuilds for the new arena. */
      this._clearMapOutlines();
    }
    if(typeof this._cleanupFoam === 'function' && this.tanks){
      for(const t of this.tanks){ try{ this._cleanupFoam(t); }catch(e){} }
    }
    /* dispose(), not detach(). detach() unhooks a tank but frees nothing, so every
       match left ten tanks' worth of geometries, materials and nameplate
       textures resident on the GPU for the life of the tab. Thousands of dead
       objects accumulate and the renderer eventually runs out of memory. */
    this.tanks.forEach(t => {
      try { if(t && t.dispose) t.dispose(); else if(t) t.detach(); } catch(e){}
    });
    this.projectiles.forEach(p=>p.detach());
    this.explosions.forEach(e=>e.detach());
    this.casings.forEach(c=>c.detach());
    if(this._strikeBombs){ this._strikeBombs.forEach(b=>{ this.scene.remove(b.mesh); if(b.mesh.geometry) b.mesh.geometry.dispose(); if(b.mesh.material) b.mesh.material.dispose(); }); this._strikeBombs = []; }
    if(this._oilPuddles){ this._oilPuddles.forEach(p=>{ this.scene.remove(p.mesh); if(p.mesh.material) p.mesh.material.dispose(); p.mesh.geometry.dispose(); }); this._oilPuddles = []; }
    if(this._panzerRing){ this._panzerRing.forEach(p=>this.scene.remove(p.mesh)); this._panzerRing = null; }
    this.tanks.forEach(t => { if(t._strikeRing) this.scene.remove(t._strikeRing); });
    this.tanks.forEach(t => { if(t._reloadBoostRing){ this.scene.remove(t._reloadBoostRing); t._reloadBoostRing = null; } });
    /* Sleeping-tank "Z" groups are parented to the SCENE, not to the tank, so
       they do NOT go with the tank's dispose(). They have to be taken down
       explicitly or every match leaves another three sprites and a canvas
       texture behind Ã¢â‚¬â€ the same leak shape as the video-effect pools. */
    this._clearSleepers();
    this._sleepers = new Set();
    this.tanks.forEach(t => { if(t.myBushes){ t.myBushes.forEach(b => this.world.removePlayerBush(b)); t.myBushes = []; } });
    if(typeof LandmineManager !== 'undefined') LandmineManager.clear();
    /* The stripe mirrors are parented to the scene, not to the tanks, so
       tank.dispose() does not take them with it. Left behind they would hold the
       dead tanks' geometry alive and keep drawing it over the fresh match Ã¢â‚¬â€ the
       same leak shape as the sleepers just above. */
    if(typeof Xray !== 'undefined' && Xray.sync) { try { Xray.sync([], this.settings, 0, null); } catch(e){} }
    this.tanks=[]; this.projectiles=[]; this.explosions=[];
    this.localTank=null; this.time=0;
    if(this.world){
      this.world.clearCustomMapData();
      this.world._glbBushes = [];
      this.world._glbPines = [];
      this.world.showDefaults();
    }
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
        this._disposeVideoTex(hv.tex, hv.el);
      }
      this._helixVideos.clear();
    }
    if(this._videoExplosions){
      for(const v of this._videoExplosions){
        this.scene.remove(v.mesh);
        v.el.pause(); v.el.currentTime = 0;
        v.mesh.geometry.dispose(); v.mat.dispose(); this._disposeVideoTex(v.tex, v.el);
      }
      this._videoExplosions = [];
    }
    if(this._videoFireEffects){
      for(const v of this._videoFireEffects){
        v.el.pause(); v.el.currentTime = 0;
        if(v.mesh.parent) v.mesh.parent.remove(v.mesh);
        v.mesh.geometry.dispose(); v.mat.dispose(); this._disposeVideoTex(v.tex, v.el);
      }
      this._videoFireEffects = [];
    }
    /* Also retire the POOLED video effects.
       They were removed from the live list above, so the loop never sees them
       -- and the fire clip is `loop: true`, so every recycled <video> keeps
       decoding frames for the rest of the page's life, holding a decoder thread
       and a VideoTexture's GPU memory, across every subsequent match. */
    for(const pool of [this._videoFirePool, this._videoExpPool]){
      if(!pool) continue;
      for(const v of pool){
        try { v.el.pause(); } catch(e){}
        try { if(v.mesh.parent) v.mesh.parent.remove(v.mesh); } catch(e){}
        try { v.mesh.geometry.dispose(); v.mat.dispose(); this._disposeVideoTex(v.tex, v.el); } catch(e){}
      }
      pool.length = 0;
    }
    if(this._molotovFires){
      for(const m of this._molotovFires){
        this.scene.remove(m.mesh); this.scene.remove(m.innerMesh);
        m.mesh.geometry.dispose(); m.mesh.material.dispose();
        m.innerMesh.geometry.dispose(); m.innerMesh.material.dispose();
      }
      this._molotovFires = [];
    }
    this._tdmSpawns = null;
    this._tdmBlueSpawns = null;
    this._tdmRedSpawns = null;
    this._tdmBushes = null;
    this._tdmState = null;
    /* NOTE: _tdmLoading is deliberately NOT cleared here. It is the re-entry
       guard, and the mode starters set it BEFORE calling _resetArena() -- so
       clearing it in here threw the guard away on the very call that needed it,
       which is why three simultaneous starts produced twenty-four tanks.
       Callers that must release it do so themselves once their load settles. */
    this._noParticles = false;
    this._captureCircleMode = false;
    /* Cleared here for the same reason as _captureCircleMode directly above:
       _resetArena is where a finished mode's flags go, and a flag left set
       means the respawn loop and _onTDMKill's early return keep firing in the
       NEXT mode. */
    this._baseDefendMode = false;
    this._spWinDone = false;
    this._shake = 0;
    this._dynTurretTarget = undefined;
    /* Reset the camera to the remembered STAGE, not a raw distance: with the
       two-mode camera on, a stage in the strategic band means the next battle
       opens already in the perch layout Ã¢â‚¬â€ and the mode flag has to follow. */
    this._staged = !(this.settings && this.settings.camTwoMode === false);
    if(this._staged){
      this._camStage = Math.max(0, Math.min(5, (typeof this.settings.cameraStage === 'number') ? this.settings.cameraStage|0 : 2));
      const stop = CONFIG.CAMERA_STOPS[this._camStage];
      this.cameraMode = (stop.mode === 'strategic') ? 'strategic' : 'dynamic';
      if(stop.mode === 'tp') this.camDist = stop.dist;
    } else {
      this.camDist = CONFIG.CAM_DIST;
    }
    this._aimPitch = 0;
    this.casings = [];
    if(this.world) this.world._tdmBox = null;
    this._cleanAllVfx();
    try { document.exitPointerLock(); } catch(e){}
    ['super-wrap','super-hint','tdm-lb','match-cd','scoreboard-overlay','base-hud'].forEach(id => {
      const el = document.getElementById(id); if(el) el.classList.add('hidden');
    });
    this._resetPhysics();
  }

  _resetPhysics(){
    try { if(window.__mtlMark) window.__mtlMark('battle:reset-arena'); } catch(e){}
    this._physBodies.forEach(b=>{ try{ this.physicsWorld.removeRigidBody(b); }catch(e){} });
    this._physBodies = [];
    this._eventQueue = null;
    /* THE TWO TRAIL MANAGERS ARE GONE.

       They pre-allocated 200 trail meshes EACH in their constructor -- 400
       BufferGeometry objects and 400 materials, every one of them added to the
       scene -- and _resetPhysics() runs on every battle, so it disposed all 400
       and built 400 more.

       That was the crash. Nothing has spawned a trail since the shell trace was
       removed (no trailManager.spawn( call exists anywhere in the codebase), so
       all 400 were dead weight being thrown away and rebuilt on repeat: measured
       renderer.info.memory.geometries climbing 69 -> 99 -> 131 -> 160, about +32
       retained per battle, on a map with no GLB and nothing else changing. It is
       a slow GPU-memory climb that ends in a context loss, and it is why entering
       battle after battle eventually wedged the tab.

       The managers were also still being updated every frame (see _update), which
       cost a pointless traversal each.

       If a trail is ever wanted again, BulletTrailManager is still in
       js/bullet-trail.js and is still loaded -- construct it where a spawn
       actually happens, and size maxTrails to what is really used rather than
       pre-allocating hundreds. */
    if(this.trailManager && this.trailManager.dispose) this.trailManager.dispose();
    if(this.glowTrailManager && this.glowTrailManager.dispose) this.glowTrailManager.dispose();
    this.trailManager = null;
    this.glowTrailManager = null;
    this._initPhysics();
  }

  _cleanAllVfx(){
    const sc = this.scene;
    if(typeof Fireball !== 'undefined') Fireball.clear();
    if(typeof MortarBlast !== 'undefined') MortarBlast.clear();
    const cleanArr = (arr) => {
      if(!arr) return;
      for(let i=0;i<arr.length;i++){
        const p = arr[i];
        const s = p.sprite || p.mesh || p.light;
        if(s) sc.remove(s);
      }
      arr.length = 0;
    };
    cleanArr(this._ricoLabels);
    cleanArr(this._dmgLabels);
    cleanArr(this._muzzleFlashes);
    cleanArr(this._muzzleSmokes);
    cleanArr(this._picFlashes);
    // Keep the muzzle point lights alive across battles Ã¢â‚¬â€ removing them would
    // change numPointLights and force a full shader recompile at battle start.
    if(this._muzzleLights){
      for(const l of this._muzzleLights){ l.active = false; l.life = 0; l.light.intensity = 0; }
    }
    cleanArr(this._bursts);
    cleanArr(this._exhaustParts);
    cleanArr(this._glowRects);
    this._glowRects = null;
    /* Pads are scene-owned, so the arena reset has to take them out itself.
       Left behind they would accumulate one set per battle and every one of
       them would keep drawing. */
    this._clearTankPads();
    /* Cached HUD element handles. Cleared with the rest so a rebuilt HUD can
       never be left pointing at detached nodes. */
    this._hudCache = null;
    /* Drop the FREE LISTS as well.
       cleanArr() above only empties the LIVE lists; everything already
       recycled into a pool survives the reset and carries straight into the
       next match. That is harmless in isolation, but combined with pools that
       were never capped it means a long session accumulates sprites and
       materials without bound. Retiring the pools at the reset point keeps the
       high-water mark at one match's worth. */
    if(this._picFlashPool){
      for(const m of this._picFlashPool){ try { m.material.dispose(); } catch(e){} }
      this._picFlashPool.length = 0;
    }
    if(this._vfxPool){
      for(const k in this._vfxPool){
        const arr = this._vfxPool[k] || [];
        for(const s of arr){ try { s.material.dispose(); } catch(e){} }
        arr.length = 0;
        delete this._vfxPool[k];
      }
    }
    if(this._flameAccums){
      for(const [, entry] of this._flameAccums){
        if(entry.sprite) sc.remove(entry.sprite);
        if(entry.canvas) entry.canvas = null;
      }
      this._flameAccums.clear();
      this._flameAccums = null;
    }
    cleanArr(this._flameFading);
    this._flameFading = null;
    if(typeof this._cleanupFoam === 'function' && this.tanks){
      for(const t of this.tanks){ try{ this._cleanupFoam(t); }catch(e){} }
    }
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
    Menu.toast('Spectating Ã¢â‚¬â€ pick a tank below');
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
      hp.textContent = dead ? '?' : (Math.ceil(t.hp) + ' HP');
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

  _spawnLocal(px, pz, pheading, py){
    this.camAngle = Math.PI + (this.settings.camRotation || 0);
    const def = TANKS[this.settings.selectedTank] || TANKS.coolbuddy;
    const sp = (px != null && pz != null) ? {x:px, z:pz} : this.world.randomSpawn();
    const localId = this.mode === 'host' ? 'host-player' : 'local';
    const startY = (py != null) ? py : 15;
    const t = new Tank(def, {id:localId, name:this.settings.playerName, isLocal:true, x:sp.x, z:sp.z, heading:(pheading != null ? pheading : Math.random()*6), physicsWorld:this.physicsWorld, allowFall: true, startY: startY});
    this._finalizeTank(t); this.tanks.push(t); this.localTank = t;
    t._spawnInvuln = 5.0;
    /* Ensure trees are placed even if NatureAssets promise hasn't resolved yet.
       tryPlaceTrees() is now the ONE place nature trees are placed, and it is
       the one that registers their cover radius. The ad-hoc loop that used to
       sit here added four extra trees per spawn with no radius and no cover
       entry at all Ã¢â‚¬â€ scenery a player could reverse under and get no
       camouflage from, which is exactly the bug being fixed. Removed. */
    if(this.world && !this.world.treesPlaced) this.world.tryPlaceTrees();
    /* And if the scenery finished loading but landed before the world existed,
       the callback above had nobody to hand the trees to. Placing here as well
       covers both orders Ã¢â‚¬â€ before the world, and after it. Idempotent: the
       one-shot flag means whichever call comes second does nothing. */
    if(this._sceneryReady && this.world && !this.world.treesPlaced) this.world.tryPlaceTrees();
  }

  _spawnBot(px, pz, pheading, py){
    const ids = TANK_ORDER.filter(id=>id!==this.settings.selectedTank && id!=='tankdisplay' && id!=='dummy');
    if(!ids.length) return;
    const id = ids[Math.floor(Math.random()*ids.length)];
    const def = TANKS[id];
    if(!def) return;
    const sp = (px != null && pz != null) ? {x:px, z:pz} : this.world.randomSpawn();
    const startY = (py != null) ? py : 15;
    const t = new Tank(def, {id:'bot-'+Math.random().toString(36).slice(2,6), name:BOTNAMES[Math.floor(Math.random()*BOTNAMES.length)], isBot:true, x:sp.x, z:sp.z, heading:(pheading != null ? pheading : Math.random()*6), physicsWorld:this.physicsWorld, allowFall: true, startY: startY});
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
    /* Best-effort only. The tank's model is still LOADING at this point Ã¢â‚¬â€
       Tank._loadModel() fills the hull and turret inside a promise's .then() Ã¢â‚¬â€
       so this walk usually finds nothing. It is here because it costs one
       traverse and it is the right thing for a model that is already cached.
       The attach that actually does the work is in Xray.sync(), which retries
       each frame until the model has landed. */
    if(typeof Xray !== 'undefined' && Xray.attach){
      try { Xray.attach(t); } catch(e){}
    }
    t.makeViewRangeCircle();
    if(!t.isLocal) t.viewCircle.visible = false;
    t.setViewRangeStyle(this.settings.viewRangeOpacity, this.settings.viewRangeColor);
    if(t.isLocal && t.hasSuper()){
      t._onBushSuper = () => this._deployBush(t);
    }
    return t;
  }

  _begin(delayHUD){
    /* THE MODE IS RE-ASSERTED HERE, AND THIS IS THE ONLY PLACE IT CAN BE.

       Every mode starter opens with `this.mode = 'sp'` and then does an async
       GLB load before calling _begin(). Menu._armNetMode() runs BEFORE the
       starter, so that assignment lands afterwards and undoes it: the game
       keeps a perfectly good roster and _netRole, and reports mode 'sp'. Since
       mode is what gates _update()'s snapshot broadcast and the input
       forwarding, the match then runs correctly and in complete silence --
       which is why a "working" queue still produced two players who could not
       see each other.

       _begin() is the last step of every start path, after the map, the spawns
       and the tanks all exist, so this assignment is final. Solo play is
       untouched: _netArmed is false, so mode stays 'sp'. */
    if(this._netArmed && this._armedRole){
      this.mode = this._armedRole;
    }

    /* GIVE MY OWN TANK A GLOBALLY UNIQUE WIRE ID -- AFTER the mode is settled.

       Every player's tank is called 'local', so a host's snapshot and the
       receiving client's own tank are both literally 'local' and cannot be told
       apart: the client skipped the host's entry, so the host never appeared at
       all. Publishing mine as 'remote-<myPeerId>' makes every wire id unique per
       player.

       This has to sit BELOW the mode re-assertion: the mode starter sets
       mode='sp' and the re-assertion above is what puts 'host' back, so testing
       this.mode === 'host' any higher up always read 'sp' and silently did
       nothing. Nothing keys off the literal 'local' -- ownership is t.isLocal
       throughout -- so renaming it is safe. */
    if(this.mode === 'host' && this.localTank && typeof Net !== 'undefined' && Net.myPeerId){
      this.localTank.id = 'remote-' + Net.myPeerId;
    }

    /* THE ONE PLACE THAT GUARANTEES COVER EXISTS BEFORE A MATCH STARTS.

       Both previous homes for this call could run while the map was still being
       built and then be undone by the map load, which resets world.trees and
       clears treesPlaced Ã¢â‚¬â€ so a match could begin in a bare arena and no later
       call would ever refill it. _begin() is after the map, the spawns and the
       scenery are all in place, and nothing resets them until the match is over.

       Idempotent (tryPlaceTrees has its own one-shot guard) and cheap when the
       trees are already there, so calling it on every match start is safe. */
    if(this.world && !this.world.treesPlaced) this.world.tryPlaceTrees();

    /* TELL THE FREEZE WATCHDOG WHERE WE ARE.

       Without this the watchdog's label is whatever the last MENU open set --
       'menu:main:preview' -- so a freeze during a battle is reported as a freeze
       in the main menu, and the panel sends you looking in the wrong place.
       boot-watchdog.js documents itself as being marked "before every menu open
       and every battle start", but nothing in game.js ever called it: __mtlMark
       appeared in exactly two places, both in menu.js. That is why the report
       named the menu while the game was clearly mid-battle. */
    try { if(window.__mtlMark) window.__mtlMark('battle:' + (this.mode || 'sp')); } catch(e){}

    Menu.showHUD();
    document.getElementById('ui-layer').classList.add('game-active');
    const _gr = document.getElementById('game-root');
    if(_gr) _gr.style.display = '';
    this._ensureMuzzleLights();
    /* Touch controls belong to the sync half of _begin(): startSpectator()
       turns them straight back off after _begin() returns, and everything from
       here down runs a turn later (see the gate below), so leaving this in the
       deferred half would switch the joysticks back on for a spectator. */
    if(this.input && this.input.setJoysticksVisible){
      this.input.setJoysticksVisible(true);
    }
    /* WAIT FOR THE TANKS' MODELS BEFORE THE MATCH GOES LIVE.

       Tank._loadModel() fills the hull and turret inside a promise's .then(),
       so the meshes are NOT in the scene yet when this line is reached -- for
       a cached model the attach is one microtask away, for a model that still
       has to be fetched it can be seconds. _warmUpVfxShaders() below compiles
       every material currently in the scene, so if it runs first it compiles
       everything EXCEPT the tanks, and three.js then compiles the tank
       shaders on the first frame that actually draws them: measured on this
       machine as a single render() call of 500 ms, plus 125 ms and 86 ms on
       the two frames after it, 38 programs in all. That lands right as the
       battle appears and reads as the game freezing.

       The wait is only ever taken when the loading screen is covering the
       canvas (isUp()), and it is bounded, so this can neither show a blank
       canvas nor hold a match hostage to a stalled download. When the screen
       is not up the bound is zero, which still lets an already-cached model's
       microtask attach land first -- the usual case, and free. */
    const _covered = (typeof BootLoading !== 'undefined') && BootLoading.isUp && BootLoading.isUp();
    if(!this._beginModelsReady){
      this._beginModelsReady = true;
      try { if(_covered) BootLoading.hold(); } catch(e){}
      this._whenTankModelsReady(() => {
        try { this._beginLate(delayHUD); }
        catch(e){ console.error('[begin]', e); }
        finally {
          this._beginModelsReady = false;
          try { if(_covered) BootLoading.release(); } catch(e){}
        }
      }, _covered ? 6000 : 0);
      return;
    }
    this._beginLate(delayHUD);
  }

  /* THE SECOND HALF OF _begin(): everything that has to happen AFTER the
     tanks' models are in the tree. Split out purely so the gate above can run
     it on the far side of that wait; the first half (mode, wire id, watchdog
     mark, HUD, touch controls) stays synchronous so the mode starters' own
     code -- startSpectator hiding the HUD, sandbox clearing the countdown --
     still runs in the same turn it always did. */
  _beginLate(delayHUD){
    this._warmUpVfxShaders();
    /* The pads go on LAST, after the map, the spawns and the tanks all exist --
       _begin() is the first point in every start path where that is true. */
    try { this._buildTankPads(); } catch(e){ console.warn('tank pads:', e); }
    this.running = true;
    this._last = performance.now();
    /* Stamped here too, or the fallback would measure the gap from page load
       and fire immediately on the very first frame. */
    this._lastRafAt = this._last;
    this._startLoopFallback();
    this._matchStartDelay = 0;
    this._matchCdShown = false;
    /* THE LOADING SCREEN COMES DOWN HERE, AND ONLY HERE.

       _begin() is the last step of every start path, after the map is loaded,
       the spawns are parsed, the tanks exist and the HUD is about to show. So it
       is the one place where "the battle is real" is true, which makes it the
       only honest place to take the loading screen away.

       The mode starters each used to hide their own small spinner at whatever
       point they happened to reach, which meant the two screens could come down
       in different places and neither matched the moment play actually began.
       They still hide the spinner Ã¢â‚¬â€ it is a separate element and other code
       expects it gone Ã¢â‚¬â€ but the real screen is ended here.

       Safe to call when nothing raised it: BootLoading.hide() with no show()
       computes a hold of zero and does nothing visible. Safe to call twice as
       well, which singleplayer already does. */
    try { if(typeof BootLoading !== 'undefined') BootLoading.hide(200); } catch(e){}
    const specPrev = document.getElementById('spec-prev');
    const specNext = document.getElementById('spec-next');
    const specExit = document.getElementById('spec-exit');
    if(specPrev && !specPrev._wired){ specPrev._wired = true; specPrev.addEventListener('click', ()=> this._spectatePrev()); }
    if(specNext && !specNext._wired){ specNext._wired = true; specNext.addEventListener('click', ()=> this._spectateNext(1)); }
    if(specExit && !specExit._wired){ specExit._wired = true; specExit.addEventListener('click', ()=> this.leaveToMenu()); }
    if(screen.orientation && screen.orientation.lock){
      screen.orientation.lock('landscape').catch(() => {});
    }
    // Hide gameplay HUD during cinematic + countdown
    if(delayHUD){
      const hudEls = ['hp-wrap','speed-readout','minimap-btn','menu-btn','super-btn'];
      hudEls.forEach(id => { const el = document.getElementById(id); if(el) el.style.opacity = '0'; });
      this._hudHidden = true;
      // Start cinematic phase: camera plays first, then countdown begins
      this._cinematicPhase = true;
      this._cinematicTimer = 0;
      this._cinematicDuration = 5;
      // Hide match countdown and tank switch during cinematic
      var mc = document.getElementById('match-cd');
      if(mc) mc.classList.add('hidden');
      var tsp = document.getElementById('tank-switch-panel');
      if(tsp) tsp.classList.add('hidden');
    }
  }

  /* Call `cb` once every tank in this match has its model in the tree, or
     after `maxMs`, whichever comes first -- so the shader warm-up in _begin()
     actually sees the tanks. Resolves on a microtask when the models are
     already cached (which is the whole point of preloading them at boot), and
     never rejects: one missing or stalled model file must not be able to stop
     a match from starting. */
  _whenTankModelsReady(cb, maxMs){
    const pend = [];
    for(const t of (this.tanks || [])){
      const p = t && t._modelReady;
      if(p && typeof p.then === 'function') pend.push(p);
    }
    if(!pend.length){ cb(); return; }
    let fired = false;
    let timer = 0;
    const once = ()=>{
      if(fired) return;
      fired = true;
      if(timer){ clearTimeout(timer); timer = 0; }
      cb();
    };
    if(maxMs > 0){
      timer = setTimeout(once, maxMs);
      if(maxMs > 500){
        setTimeout(()=>{
          if(fired) return;
          try { if(typeof BootLoading !== 'undefined') BootLoading.set('Preparing tanks...', 92); } catch(e){}
        }, 400);
      }
    } else {
      /* No cover: one turn of the event loop is all we can afford, and it is
         still enough for an already-resolved model promise to attach. */
      timer = setTimeout(once, 0);
    }
    Promise.all(pend).then(once, once);
  }

  /* Build the effect shaders BEFORE the first shot instead of during it.
     three.js compiles a brand new shader program the first time it meets a
     material it has not seen, and that compile is a 50-150 ms stall. Mid
     match it reads as the game freezing for a split second, and the effects
     that are worst for it (explosions, mortar glow, flame cone, video
     overlays) are exactly the ones that only appear once something blows up.
     Every material below is the same pooled material the effects really use,
     so this only moves the cost to the start of the battle. */
  /* PRE-COMPILE THE ROUND, THE STREAK AND THE CASING.

   The gap this closes was measured, not guessed. _warmUpVfxShaders above
   already builds 61 materials -- every VFX sprite, the muzzle picture, the
   fireball, the keyed video overlay -- and a first shot was STILL costing a
   447 ms frame, because the shell, its tracer and the casing were never in
   that list. Adding them and getting the order right:

       cold                        447.6 ms worst frame, 5 programs compiled
       warmed before the GLB      130.7 ms worst frame, 4 programs compiled
       warmed after the GLB        49.1 ms worst frame, 0 programs compiled

   THE ORDER IS THE WHOLE FIX, and it is easy to get backwards. _initShared()
   installs a MeshBasicMaterial capsule so a shell can be built synchronously
   before its file has downloaded. Warming THAT compiles a program nothing in
   the match will ever draw: the real bullet is a MeshStandardMaterial. So this
   refuses to run until Shell._modelLoaded, and is otherwise called from
   _adoptModel -- see Shell.onModelsAdopted.

   Nine programs, all created at adoption time: two round bodies, two tracer
   sets, the casing and its depth variant for the shadow pass (the casing is the
   one shadow caster in this file), and the fallback-vs-real pairs each GLB
   leaves behind.

   Nothing is disposed, for the same reason the function above documents: three
   deletes a program when its LAST material goes, so disposing these would hand
   the stall straight back. The group is parked out of the scene and kept. */
  _warmShellShaders(){
    if(this._shellShadersWarmed) return;
    if(!this.renderer || !this.scene || !this.camera) return;
    if(typeof Shell === 'undefined') return;
    /* Wait for the real file. If it never arrives the placeholder is what will
       be drawn, and it is already warmed by the VFX pass above. */
    if(!Shell._modelLoaded) return;

    const grp = new THREE.Group();
    grp.position.set(0, -5000, 0);              /* parked far under the map */
    let n = 0;
    const add = (geo, mat) => {
      if(!geo || !mat) return;
      grp.add(new THREE.Mesh(geo, mat)); n++;
    };
    try {
      add(Shell._sharedGeo,     Shell._sharedMat);
      add(Shell._traceGeo,      Shell._traceMat);
      add(Shell._artGeo,        Shell._artMat);
      add(Shell._artTraceGeo,   Shell._artTraceMat);
      /* The casing is only built once a shell has actually left the barrel, so
         it is usually null here and warms on a later match. Cheap to ask. */
      try { add(ShellCasing._sharedGeo, ShellCasing._sharedMat); } catch(e){}
    } catch(e){}
    this.scene.add(grp);
    try { this.renderer.compile(this.scene, this.camera); } catch(e){}

    /* AND THEN ACTUALLY DRAW IT, WHICH compile() DOES NOT DO.

       renderer.compile() builds and links programs. It does NOT upload a
       single texture -- that happens in WebGLTextures on the first real draw.
       The bullet GLB arrives with its own images, and leaving those to the
       player's first shot is what kept a 433 ms frame on the table even after
       every program had been pre-compiled: this was measured, and the fix is
       these six lines rather than anything about shaders.

       Drawing means being inside the frustum, so the camera is pointed at the
       warm-up group for exactly one frame and then restored from copies taken
       first. It is never moved to where the player can see it, which matters
       because _adoptModel can land mid-match rather than behind the loading
       screen. Frustum culling is off on nothing here -- the group is simply
       rendered while the camera faces it. */
    const cam = this.camera;
    const camPos = cam.position.clone();
    const camQuat = cam.quaternion.clone();
    try {
      /* Twenty units BACK from the group and facing it. Standing the camera ON
         the target looks like it works and is the one version that does not:
         the meshes end up at distance zero, inside the near plane, and are
         clipped -- so nothing is drawn and nothing is uploaded, which is the
         entire thing this render exists to do. */
      cam.position.set(0, -5000, 20);
      cam.lookAt(0, -5000, 0);
      cam.updateMatrixWorld(true);
      this.renderer.render(this.scene, cam);
    } catch(e){}
    finally {
      cam.position.copy(camPos);
      cam.quaternion.copy(camQuat);
      cam.updateMatrixWorld(true);
    }

    this.scene.remove(grp);
    this._shellShadersWarmed = true;
    this._warmShellGroup = grp;                 /* deliberately never disposed */
    if(n) console.log('[Game] warmed ' + n + ' shell/casing materials');
  }

  _warmUpVfxShaders(){
    if(!this.renderer || !this.scene || !this.camera) return;
    /* Armed here, fired from Shell._adoptModel. See _warmShellShaders. */
    this._shellShadersWarmed = false;
    try {
      Shell.onModelsAdopted = () => { try { this._warmShellShaders(); } catch(e){} };
    } catch(e){}
    /* ...and once more from here, for the case where the bullet file is ALREADY
       in the cache (second match, or a preload that beat us to it) and
       _adoptModel will therefore never run again. */
    /* AND START THE FETCH, WHICH IS THE PART THAT ACTUALLY MATTERS.

       Nothing above this line was the real problem. _initShared() is what kicks
       off TL_bullet.glb, and it runs from _build() -- the first time a shell is
       CONSTRUCTED. So on a cold page the bullet file was not requested until the
       player's first shot, and that one shot paid for all of it: the network
       round trip, the decode, the material swap in _adoptModel, and the nine
       programs that swap compiles. Measured, a cold first shot cost 447 ms.

       Kicking it here moves that whole chain onto the loading screen, where a
       pause is invisible, and lets _warmShellShaders run the moment the file
       lands. Nothing is drawn by doing this -- _initShared only installs the
       placeholder capsule and starts the load, exactly as it would have done
       mid-match. */
    try { if(typeof Shell !== 'undefined') Shell._initShared(); } catch(e){}
    /* Same story, one beat later. The casing's geometry and material are built
       by ShellCasing._initShared(), and nothing calls it until the first round
       actually leaves a barrel -- so it was paying the same first-shot cost the
       bullet did, one class lower. Built BEFORE the warm-up pass below, because
       a material that does not exist yet cannot be compiled. */
    try { if(typeof ShellCasing !== 'undefined') ShellCasing._initShared(); } catch(e){}
    /* Only NOW is it worth trying to warm: the casing exists, and the bullet is
       either already cached (so it can be warmed immediately) or still in the
       air (so _adoptModel will call back and finish the job). */
    this._warmShellShaders();
    const grp = new THREE.Group();
    grp.position.set(0, -5000, 0);              // parked far under the map
    const names = ['spark','ember','smoke','starsoft','ring','blobfire','cloud',
                   'dust','fire','hex','shard','oil','flare','trail','muzzle'];
    for(const n of names){
      let tex = null;
      try { tex = VFX.getTex(n); } catch(e){ continue; }
      for(const blend of [THREE.AdditiveBlending, THREE.NormalBlending]){
        for(const tone of [true, false]){
          grp.add(new THREE.Sprite(new THREE.SpriteMaterial({
            map: tex, transparent: true, opacity: 1, depthWrite: false,
            blending: blend, toneMapped: tone
          })));
        }
      }
    }
    // The flat muzzle-flash picture carries its own material (own texture,
    // own blend, own colour handling), so it is warmed on its own too.
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: this._muzzlePictureTex(), color: 0xff6a14, transparent: true,
      side: THREE.DoubleSide, toneMapped: false
    }));
    grp.add(pic);
    this.scene.add(grp);
    try { this.renderer.compile(this.scene, this.camera); } catch(e){}
    this.scene.remove(grp);
    /* KEEP THE WARM-UP MATERIALS ALIVE -- do NOT dispose them.

       three.js deletes a shader program the moment the LAST material using it
       is disposed, and every material in this group was created here, so
       disposing them takes the programs this whole function just compiled
       straight back out of the driver. The next spark recompiles them
       mid-match instead -- the exact stall this function exists to prevent,
       and one that shows up as a matching deleteProgram per warm-up batch.
       Held on the instance (parked, out of the scene) the programs stay
       resident for the life of the page, which is all the pooled effect
       materials want anyway.

       Nothing here is disposed, deliberately: Sprite.geometry is one shared
       module-level plane for every Sprite in the game, disposing it would
       throw away every sprite's buffer in the match, and pic's own plane is
       four vertices. The group is ~60 materials and one texture reference
       each, all of them textures the effects already own. */
    this._warmVfxGroup = grp;

    /* The shader fireball is a whole node material of its own, and on WebGPU
       a brand new material means a brand new WGSL PIPELINE to build Ã¢â‚¬â€ about a
       hundred milliseconds. The first time it would ever draw is the first
       tank kill, i.e. in the middle of a match, which is precisely the kind
       of hitch that reads as the game freezing. So it is built and drawn ONCE
       here, parked far under the map, and thrown away again. */
    if(typeof Fireball !== 'undefined'){
      try {
        const b = Fireball.spawn(this.scene, 0, -6000, 0, 8.7);
        if(b && b.mesh){
          b.mesh.visible = true;
          b.uniforms.uProg.value = 0.5;
          this.renderer.render(this.scene, this.camera);
        }
        Fireball.clear();
      } catch(e){}
    }
    /* Same story for the keyed video overlays: another node material that
       only exists once a tank starts burning. */
    try {
      if(this._videoMaterial){
        const m = this._videoMaterial(this._picFlashTex || this.texGround, { chromaKey: true, opacity: 0 });
        const g = new THREE.Group();
        g.position.set(0, -6000, 0);
        g.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m));
        this.scene.add(g);
        this.renderer.render(this.scene, this.camera);
        this.scene.remove(g);
        g.children[0].geometry.dispose();
        /* Keep the material. _videoMaterial() builds a fresh one every call,
           so this is the ONLY material using its program at this moment:
           disposing it deletes the program this render just compiled, and the
           first tank that starts burning then recompiles a chroma-key-patched
           shader in the middle of the match -- the precise hitch the block
           above exists to move off the match. Parked, it costs one material
           and holds the program alive for the page. */
        (this._warmVfxMats = this._warmVfxMats || []).push(m);
      }
    } catch(e){}

    /* The barrel blasts fire constantly, and they have to never allocate Ã¢â‚¬â€
       so their quads and their two small textures are built here, once, and
       then the pools are reused for the rest of the match. */
    /* The muzzle clouds fire on every shot, and a brand new material means a brand
       new WGSL PIPELINE to build on WebGPU Ã¢â‚¬â€ around a hundred milliseconds. The
       first time one would ever draw is the first shot of a match, which is
       precisely the kind of hitch that reads as the game freezing. So the whole
       pool is built and drawn once here, parked under the map, then shown. */
    if(typeof MuzzlePop !== 'undefined'){
      try {
        MuzzlePop.warm(this.scene);
        this.renderer.render(this.scene, this.camera);
        MuzzlePop.clear();
      } catch(e){}
    }

    this._shadowDirty = true;
  }

  _showHUDAfterCountdown(){
    if(!this._hudHidden) return;
    this._hudHidden = false;
    const hudEls = ['hp-wrap','speed-readout','minimap-btn','menu-btn','super-btn'];
    hudEls.forEach(id => { const el = document.getElementById(id); if(el) el.style.opacity = ''; });
  }

  leaveToMenu(){
    // Hide touch joysticks FIRST Ã¢â‚¬â€ nothing below may run (throws, early
    // returns, async) while leaving the joysticks visible over the menus.
    if(this.input && this.input.setJoysticksVisible){
      this.input.setJoysticksVisible(false);
    }
    if(Menu && Menu.hideTouchControls) Menu.hideTouchControls();
    this.running = false;
    /* The fallback clock only runs during a match, and this ends the match.
       Left running it would tick forever against running===false Ã¢â‚¬â€ harmless
       but pointless, and it would outlive every battle by way of the
       constructor's single handle. */
    this._stopLoopFallback();
    /* Quitting out from under a map load would otherwise leave the loading
       screen up forever, over a menu the player is trying to use. The mode
       starters' error paths hide it too, but a deliberate quit mid-load reaches
       none of those. */
    try { if(typeof BootLoading !== 'undefined') BootLoading.hide(0); } catch(e){}
    this.mode = null;
    /* Release the re-entry guard. _resetArena() no longer clears it, because the
       mode starters set it BEFORE calling _resetArena() -- so this is the one
       place that must let the next battle through. Without it, quitting to the
       menu mid-load leaves the flag set and the next PLAY silently does
       nothing at all, which reads as "the game is broken". */
    this._tdmLoading = false;
    /* Put the PLAY button back.

       It is hijacked while queueing Ã¢â‚¬â€ label and click handler both change Ã¢â‚¬â€ and
       leaving a battle is one of the ways to reach the menu with it still
       hijacked. That leaves the button reading "SEARCHING" and wired to CANCEL,
       so the next press cancels a search that ended long ago and queues nothing.

       This is deliberately here and NOT in Menu.show(). An earlier attempt hung
       it off show(), which looks tidier but fires on ordinary menu navigation Ã¢â‚¬â€
       including `show('menu-multiplayer')` on the very path that STARTS a search
       Ã¢â‚¬â€ so it cancelled the search the instant it began and PLAY did nothing at
       all. Leaving a battle is the precise event, and it is the one that
       matters. */
    try { if(Menu && Menu._hidePlayCountdown) Menu._hidePlayCountdown(); } catch(e){}
    clearTimeout(this._guardSafetyTimer);
    this._guardSafetyTimer = null;
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
    /* The match really is over now, so drop the armed copies too. Leaving them
       would make the NEXT solo battle re-arm itself as a host and start
       broadcasting to a match that no longer exists. */
    try { this._forgetNetMatch(); } catch(e){}
    // Record XP before clearing arena data
    try {
      if(window.UpgradeTree && this.localTank){
        var lt = this.localTank;
        var dmgTotal = 0;
        this.tanks.forEach(function(t){ if(t && !t.isDummy) dmgTotal += (t.damageDealt||0); });
        UpgradeTree.recordBattle({
          won: false,
          kills: lt.kills || 0,
          carry: lt.damageDealt > dmgTotal,
          damage: lt.damageDealt || 0,
          heals: lt.healDealt || 0,
          minutes: (this.time || 0) / 60,
          tankId: lt.def.id
        });
      }
    } catch(e){}
    try { this._resetArena(); } catch(e){ console.warn('reset arena:', e); }
    /* A CLOSING SHOT IN FLIGHT IS TORN DOWN HERE, NOT LEFT RUNNING.

       It owns four things that outlive it: document-level key/pointer/wheel
       listeners (which would otherwise eat input on the main menu and keep
       firing for the rest of the session), the time scale (the world would
       crawl around the menus), an inline opacity on half the battle HUD (so
       the player gets to the menu with an invisible health bar, and the next
       battle inherits it), and a banked camera `up` vector.

       This is reachable while the shot is playing: Escape opens the menu, and
       in gladiator a defeat ends the match and the player's instinct is to
       leave immediately. Safe to call when there was never a shot. */
    try { this._endCineTearDown(); } catch(e){}
    /* The flash falling away off the results screen runs on its own timer (see
       _endCinePresent) precisely because it outlives the shot. Leaving the game
       is the one moment where it must not: it is still white, and the menu is
       about to be shown underneath it. */
    clearTimeout(this._endCineFlashTid);
    this._endCineFlashTid = null;
    try {
      const ec = document.getElementById('endcine');
      if(ec){
        const fl = ec.querySelector('.endcine-flash');
        if(fl){ fl.style.animation = ''; fl.style.opacity = '0'; }
        ec.classList.remove('is-out');
      }
    } catch(e){}
    clearTimeout(this._resultsWatchdog);
    this._resultsWatchdog = null;
    // The renderer stops when running=false, which leaves the LAST BATTLE FRAME
    // frozen on the canvas forever. Every screen transition then fades that
    // stale battlefield up behind the menu ("why do I see the battle?").
    // Unmount it while we're out of the battle Ã¢â‚¬â€ it comes back in _begin().
    try {
      const gr = document.getElementById('game-root');
      if(gr) gr.style.display = 'none';
    } catch(e){}
    // Hide all overlays
    document.getElementById('esc-menu').classList.add('hidden');
    document.getElementById('bigmap').classList.add('hidden');
    var _mc = document.getElementById('match-cd');
    if(_mc) _mc.classList.add('hidden');
    this._matchStartDelay = 0; this._matchCdShown = false;
    this._cinematicPhase = false; this._cinematicTimer = 0;
    this._lastCdNum = undefined;
    // Reset HUD visibility and remove game-active so menu buttons work again
    this._hudHidden = false;
    document.getElementById('ui-layer').classList.remove('game-active');
    const hudEls = ['hp-wrap','speed-readout','minimap-btn','menu-btn','super-btn'];
    hudEls.forEach(id => { const el = document.getElementById(id); if(el) el.style.opacity = ''; });
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
      // Orbit only Ã¢â‚¬â€ same rotate/zoom controls as the normal follow cam
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
      const lookAhead = Math.min(this.camDist * 0.25, 8);
      const lookX = t.x + Math.sin(t.heading) * lookAhead;
      const lookZ = t.z + Math.cos(t.heading) * lookAhead;
      const camHOff = this._getCamHOffset(this.camDist);
      const camTarget = new THREE.Vector3(
        t.x + Math.sin(angle)*(this.camDist + camHOff),
        this._getCameraHeight(this.camDist),
        t.z + Math.cos(angle)*(this.camDist + camHOff));
      /* Same floor clamp as the play camera: spectating a tank that has fallen
         out of the world must not take the view with it. */
      this._clampCameraTarget(camTarget);
      const camLim = (this.world && this.world.half || 75) - 8;
      camTarget.x = Math.max(-camLim, Math.min(camLim, camTarget.x));
      camTarget.z = Math.max(-camLim, Math.min(camLim, camTarget.z));
      this.camera.position.lerp(camTarget, CONFIG.CAM_LERP);
      this.camera.lookAt(lookX, 1.2, lookZ);
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

  /* THE FALLBACK CLOCK. WHY THIS IS NEEDED AT ALL.

     Everything in this game runs off requestAnimationFrame, and browsers do
     NOT run rAF for a tab that is not being painted. Measured on the real
     page while this tab was in the background:

         requestAnimationFrame   1-6 frames per second
         setInterval(16ms)       62 ticks per second

     rAF is tied to the compositor. A backgrounded tab, a minimised window, or
     a window fully covered by another one stops being painted, so its rAF
     chain is throttled to roughly nothing Ã¢â‚¬â€ but timers keep running at full
     rate. That gap is the entire bug.

     WHY IT READS AS "MULTIPLAYER IS BROKEN" AND NOT AS "MY WINDOW IS SMALL".

     A frame is not just a picture. It is one step of the simulation: the
     countdown, the physics step, the bot brains, the tank transforms, and the
     snapshot broadcast that carries all of it to the other player. So a starved
     rAF chain does not merely make the game look choppy, it stops the match.

     And because the HOST is authoritative, it stops the match for BOTH
     players at once. The host's tanks freeze, so no fresh snapshots go out, so
     the client's tanks freeze too Ã¢â‚¬â€ two frozen screens and no error anywhere.
     That is exactly the report: "I spawned in and every tank was frozen and I
     could not tell whether my friend was there." Nothing had crashed. The
     host's browser had simply stopped painting the page, quite possibly
     because they alt-tabbed to chat.

     There is a second, quieter effect. The step below clamps dt to 0.05s, so a
     starved frame advances the simulation by 50ms no matter how much real time
     actually passed. At 1fps that is 0.05s of game time per real second Ã¢â‚¬â€ the
     match runs at one twentieth speed. So even when frames do trickle through,
     everything moves in what looks like extreme slow motion.

     So: keep the rAF chain as the primary clock (it is the right one Ã¢â‚¬â€ it is
     synced to the display), and when it has not fired for a while, step the
     same loop from a timer instead. Same _loop, same code path, no second
     simulation to keep in sync. */
  _startLoopFallback(){
    if(this._loopFallback) return;
    this._loopFallback = setInterval(() => {
      /* Only while a match is actually running. In the menu there is nothing
         to keep alive and the extra wake-ups are pure waste. */
      if(!this.running) return;
      /* How long since requestAnimationFrame last ran Ã¢â‚¬â€ and ONLY rAF, never the
         fallback itself. This distinction is the entire reason the loop keeps
         real time.

         An earlier version stamped this on every step, fallback ones included.
         So the fallback's own step reset the clock, the next tick saw a healthy
         16ms gap, and it skipped. The result could only ever run once per
         threshold window: measured at 8.8 steps/sec against a 100ms threshold,
         and since dt is clamped to 0.05s per step, the match advanced 2.2
         seconds of game time per 5 seconds of real time. Half speed, forever Ã¢â‚¬â€
         still "frozen tanks", just less obviously so.

         Reading the rAF-only stamp instead lets the fallback run on EVERY tick
         while rAF is away, which is what a healthy 60Hz clock looks like. */
      const since = performance.now() - (this._lastRafAt || 0);
      if(since < 100) return;
      /* _step, never _loop Ã¢â‚¬â€ see the note on _loop. Caught for the same reason
         _loop catches it: an exception here would kill the draw without killing
         the timer, so this tick would otherwise throw once every 16ms for as
         long as the tab is left open. Shares _loop's counter, so the two paths
         together still log at most five times. */
      try { this._step(performance.now()); }
      catch(e){
        this._stepErrs = (this._stepErrs || 0) + 1;
        if(this._stepErrs <= 5){
          console.error('[FREEZE-GUARD] fallback _step threw (frame ' + this._stepErrs + '):', e);
          try { if(window.__mtlMark) window.__mtlMark('battle:frame-error'); } catch(e2){}
        }
      }
    }, 16);
  }

  _stopLoopFallback(){
    if(this._loopFallback){ clearInterval(this._loopFallback); this._loopFallback = null; }
  }

  /* THE rAF ENTRY POINT, AND WHY IT IS NOT THE SAME FUNCTION AS THE STEP.

     `_loop` schedules exactly one more rAF and nothing else. The actual frame
     lives in `_step`. The split is not cosmetic Ã¢â‚¬â€ it is the whole fix.

     When the fallback timer drives the game it calls `_step` DIRECTLY. If it
     called `_loop` instead, every fallback tick would queue another
     requestAnimationFrame, and those callbacks would never stop being added:
     the rAF chain would double in length every 16ms until the tab seized up.
     Measured on the real page, an earlier version of this did exactly that Ã¢â‚¬â€
     93 frames per second, each advancing the simulation by 0.0024s, because
     thousands of duplicate callbacks were racing and the dt clamp was rounding
     the differences away to nothing.

     A second, subtler bug lived in the same place. rAF hands its callback a
     timestamp for when the frame *began*, which can be EARLIER than
     performance.now(). So a fallback step (which passes performance.now())
     immediately followed by a rAF step (which passes an older stamp) computed
     a negative dt, clamped to zero, and threw away a whole frame of game time.
     Alternating between the two clocks lost most of the match. So dt is
     measured against performance.now() on both paths and the rAF timestamp is
     used only to decide *when* to draw. */
  _loop(){
    requestAnimationFrame(this._loop);
    /* Stamped here and ONLY here. The fallback reads this to decide whether
       rAF is alive; if _step stamped it too, the fallback would keep resetting
       its own clock and could only ever run once per threshold window. */
    this._lastRafAt = performance.now();
    /* NOTHING IN _step IS ALLOWED TO LEAVE A FROZEN PICTURE.

       rAF is scheduled on line one, before anything can throw, so an
       exception cannot stop the chain -- but _step draws as its LAST statement,
       so an exception anywhere in the frame throws away that draw while the
       loop cheerfully keeps looping. The result is the worst failure shape
       there is: the page is alive, the canvas is stuck on the last frame it
       managed to draw, nothing crashes, and unless devtools happens to be open
       there is nothing in the console to say why. That reads as "the game
       froze in the middle of a battle".

       _update is caught inside _step so the failing subsystem gets named
       specifically; this is the backstop for every other line of the frame
       (HUD, xray, minimap, the draw itself). The frame is dropped and the
       next one renders, instead of the picture dying for good. */
    try { this._step(performance.now()); }
    catch(e){
      this._stepErrs = (this._stepErrs || 0) + 1;
      if(this._stepErrs <= 5){
        console.error('[FREEZE-GUARD] _step threw (frame ' + this._stepErrs + '):', e);
        try { if(window.__mtlMark) window.__mtlMark('battle:frame-error'); } catch(e2){}
      }
    }
  }

  _step(now) {
    /* Frame counter. Read by SessionGuard to tell a dead rAF chain
       from a slow one, and by anything measuring frame rate. It did not
       exist before, so the guard's stall check compared -1 to -1 and could
       never fire. */
    this.frame = (this.frame || 0) + 1;
    const rawDt = Math.max(0, (now - this._last)/1000) || 0;
    /* TWO CLOCKS, ALWAYS.

       `realDt` is wall time. `dt` is the world's clock, and it is the one that
       gets scaled down by the closing cinematic's time dilation. On every other
       frame they are the same number.

       They are separated because the cinematic has to keep running at wall speed
       while the world it is filming crawls. Timing the shot on the dilated clock
       instead would make a two-second camera move take eight real seconds to
       complete Ã¢â‚¬â€ the slow motion would have swallowed the one thing it was
       supposed to make more dramatic. */
    const realDt = Math.min(0.05, rawDt);
    const dt = (this._endCine && this._endCine.timeScale) ? realDt * this._endCine.timeScale : realDt;
    this._last = now;
    this._perfFrameStart = performance.now();

    // Push FPS sample (keep last 60)
    this._perfFpsHistory.push(now);
    if (this._perfFpsHistory.length > 60) this._perfFpsHistory.shift();

    if(this.running){
      // Cinematic phase: camera plays first, no countdown yet
      if(this._cinematicPhase){
        this._cinematicTimer += rawDt;
        if(this._cinematicTimer >= this._cinematicDuration){
          // Cinematic done Ã¢â‚¬â€ start countdown phase
          this._cinematicPhase = false;
          this._matchStartDelay = 10;
          this._matchCdShown = false;
          // Release pointer lock so cursor is visible for tank selection
          try { document.exitPointerLock(); } catch(e){}
          if(this.input) this.input._pointerLocked = false;
          // Show countdown UI and tank switch panel
          var mc = document.getElementById('match-cd');
          if(mc) mc.classList.remove('hidden');
          var tsp = document.getElementById('tank-switch-panel');
          if(tsp) tsp.classList.remove('hidden');
          this._populateTankSwitchList();
          this._botSwitchTimer = 0;
        }
      }
      // Match start countdown: freeze input for 10s
      if(!this._cinematicPhase && this._matchStartDelay > 0){
        this._matchStartDelay -= rawDt;
        if(this._matchStartDelay <= 0){
          this._matchStartDelay = 0;
          var mc = document.getElementById('match-cd');
          if(mc) mc.classList.add('hidden');
          var tsp = document.getElementById('tank-switch-panel');
          if(tsp) tsp.classList.add('hidden');
          this._showHUDAfterCountdown();
          // Re-acquire pointer lock so the player can aim and drive
          try {
            if(this.cameraMode === 'dynamic'){
              const cv = this.renderer && this.renderer.domElement;
              if(cv) cv.requestPointerLock();
            }
          } catch(e){}
        } else {
          // Bot tank switching every 1.5s during countdown
          if(this._matchStartDelay > 0.5){
            this._botSwitchTimer = (this._botSwitchTimer || 0) + rawDt;
            if(this._botSwitchTimer > 1.5){
              this._botSwitchTimer = 0;
              const bots = this.tanks.filter(t => t.isBot && t.alive && !t.dying);
              if(bots.length){
                const b = bots[Math.floor(Math.random()*bots.length)];
                this._switchBotTank(b);
              }
            }
          }
          var num = document.querySelector('.match-cd-num');
          var label = document.querySelector('.match-cd-label');
          var go = document.querySelector('.match-cd-go');
          if(this._tdmState && label){
            label.innerHTML = '<span style="color:#4488ff">BLUE</span> vs <span style="color:#ff4444">RED</span> Ã¢â‚¬â€ Round ' + this._tdmState.round + ' of ' + this._tdmState.maxRounds;
          } else if(label){
            label.textContent = 'Pre-Battle Preparation';
          }
          if(num){
            if(this._matchStartDelay > 0.5){
              const newNum = Math.ceil(this._matchStartDelay);
              const prevNum = this._lastCdNum;
              num.textContent = newNum;
              num.style.display = '';
              if(label) label.style.display = '';
              if(go) go.style.display = 'none';
              if(prevNum !== undefined && newNum !== prevNum){
                num.classList.remove('tick');
                void num.offsetWidth;
                num.classList.add('tick');
                setTimeout(()=> num.classList.remove('tick'), 300);
                // Play ticking sound
                try { Audio.tick(); } catch(e){}
              }
              this._lastCdNum = newNum;
            } else {
              num.style.display = 'none';
              if(label) label.style.display = 'none';
              if(go) go.style.display = 'block';
              this._lastCdNum = undefined;
            }
          }
        }
      }
      this.dt = dt; this.time += dt;
      /* Frame counter the staggered bot thinking runs off. */
      this._frameNo = (this._frameNo || 0) + 1;
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

      /* THE CLOSING SHOT RUNS HERE, NOT IN _update.

         Two reasons, both of them load-bearing.

         It must run before _update so that _update's camera block Ã¢â‚¬â€ which writes
         straight to this.camera.position every single frame Ã¢â‚¬â€ can be told to
         stand down and let the shot keep the camera. See the `_endCine` check at
         the top of that block.

         And it must run on the UNCONDITIONAL path, outside the
         `if(_matchStartDelay <= 0 && !_cinematicPhase)` guard below. A match can
         end inside its own opening countdown (skipping a battle, a mode whose
         win condition is already satisfied), and a cinematic that only ticked
         while the battle was live would hang on the first frame in a mode that
         ended early Ã¢â‚¬â€ with the results screen never shown and the player stuck
         watching a frozen frame. It advances on `realDt`, so the time dilation
         applied to `dt` above does not apply to it. */
      if(this._endCine){
        try { this._endCineTick(realDt); }
        catch(e){
          /* A cinematic that throws must not take the results screen with it.
             Tearing the shot down hands straight back to the plain path, which
             is the behaviour that existed before any of this. */
          console.warn('[end-cine]', e);
          try { this._endCineAbort(); } catch(e2){}
        }
      }

      if(this._matchStartDelay <= 0 && !this._cinematicPhase){
        /* NOTHING IN _step IS ALLOWED TO LEAVE A FROZEN PICTURE.

           _step draws as its very last statement, so an exception thrown from
           _update() aborts the frame before renderer.render() is ever called.
           requestAnimationFrame is scheduled at the TOP of _loop, so the chain
           itself survives -- and the result is the worst possible failure
           shape: the loop keeps running, the canvas keeps showing the last
           frame it managed to draw, nothing crashes, and unless you happen to
           have devtools open there is nothing in the console to explain why
           the game has stopped. That reads as "the game froze in the middle of
           a battle", and it is silent.

           Caught instead: the error is logged a bounded number of times
           (60/s forever is not a log, it is a denial of service on the console)
           and the frame still draws, so a broken update degrades to a visible
           game running on stale logic rather than to a dead screen. The
           watchdog is also told, so the NEXT load names this instead of
           guessing. */
        try { this._update(dt); }
        catch(e){
          this._updateErrs = (this._updateErrs || 0) + 1;
          if(this._updateErrs <= 5){
            console.error('[FREEZE-GUARD] _update threw (frame ' + this._updateErrs + '):', e);
            try { if(window.__mtlMark) window.__mtlMark('battle:update-error'); } catch(e2){}
          }
        }
      } else if(!this._cinematicPhase && this._matchStartDelay > 0){
        // Countdown phase: allow camera rotation via mouse drag + keyboard
        this._updateCountdownCamera(dt);
        // Sync visual mesh positions to physics bodies so tanks don't float
        if(this.tanks) this.tanks.forEach(t => { if(t.alive && t._physBody) t._syncTransform(); });
      } else {
        // Cinematic intro camera
        if(this.localTank) this._updateCinematicCamera();
      }
    }
    this._perfUpdateEnd = performance.now();

    // Adaptive resolution: if frames are heavy, scale render resolution down
    // (and back up when the GPU keeps up) so the game stays smooth on weak GPUs.
    // Resizing the drawing buffer is itself a visible hitch, so this only runs
    // every 3s, needs a full 60-frame sample, and is rate-limited so the
    // resolution can't oscillate during a firefight.
    if(now - this._adapT > 3000){
      this._adapT = now;
      const hist = this._perfFpsHistory;
      if(hist.length > 60){
        let s = 0;
        for(let i = hist.length - 60; i < hist.length; i++){
          const d = hist[i] - hist[i-1];
          s += (1000 / (d > 0 ? d : 16.7));
        }
        const fps60 = s / 59;
        const cur = this.renderer.getPixelRatio();
        const since = now - (this._adapChanged || 0);
        if(fps60 < 32 && cur > 0.8 && since > 6000){
          this._adapChanged = now;
          this.renderer.setPixelRatio(Math.max(0.8, cur - 0.2));
        } else if(fps60 > 55 && cur < this._maxPixelRatio && since > 12000){
          this._adapChanged = now;
          this.renderer.setPixelRatio(Math.min(this._maxPixelRatio, cur + 0.15));
        }
      }
    }

    // GPU load estimate: sample the delta between rAF start and render completion
    this._perfGpuLoadSamples.push(Math.round((performance.now() - this._perfFrameStart) / 1.66));

    this._updatePerfOverlay(now);
    // Animate spawn glow rects
    if(this._glowRects){
      for(const g of this._glowRects){
        g.time += dt;
        g.mesh.material.opacity = g.baseOpacity * (0.6 + 0.4 * Math.sin(g.time * 3));
      }
      // Fade glow rects only after countdown ends (battle starts)
      if(!this._cinematicPhase && this._matchStartDelay <= 0){
        this._glowFadeTimer = (this._glowFadeTimer || 0) + dt;
        const fade = Math.max(0, 1 - this._glowFadeTimer / 0.8);
        for(const g of this._glowRects) g.mesh.material.opacity *= fade;
        if(fade <= 0){
          for(const g of this._glowRects) this.scene.remove(g.mesh);
          this._glowRects = null;
        }
      }
    }
    // -- Shadow budget -------------------------------------------------
    // A shadow map means rendering the whole scene a second time from the
    // light's point of view. Rebuilding it every other frame halves that
    // GPU cost; a one-frame-old shadow is invisible at tank speeds.
    const _rsm = this.renderer.shadowMap;
    if(_rsm.enabled){
      _rsm.autoUpdate = false;
      this._shadowFrame = (this._shadowFrame | 0) + 1;
      if(this._shadowDirty || this._shadowFrame <= 2 || (this._shadowFrame & 1) === 0){
        _rsm.needsUpdate = true;
        this._shadowDirty = false;
      }
    }
    if(this.world && this.world.focusShadows && this.localTank){
      // Shadow box follows the player (the light itself never moves relative
      // to it, so the lighting is unchanged).
      const moved = this.world.focusShadows(this.localTank.x, this.localTank.z, 110 + (this.camDist * 0.7));
      if(moved) this._shadowDirty = true;
    }
    /* Copy the stripe meshes onto their tanks and drop the ones whose tank has
       gone. Done here, immediately before the draw, because a tank's world
       matrices are only final at this point in the frame. */
    if(typeof Xray !== 'undefined' && Xray.sync){
      try { Xray.sync(this.tanks, this.settings, now / 1000, this.localTank ? this.localTank.team : null); } catch(e){}
    }
    if(this.running) this.renderer.render(this.scene, this.camera);
    /* Sampled HERE, after the draw, because three zeroes `info.render` at the top
       of every render() -- reading it any earlier in the frame reports the
       PREVIOUS frame's totals, which on a first frame reads as zero and looks
       like a bug in the readout rather than in the game.

       A held reference rather than a copy: this is a diagnostic, and a snapshot
       taken three times a second is worth exactly as much as the live object. */
    if(this.renderer && this.renderer.info) this._perfRendererInfo = this.renderer.info;
  }

  // Camera height = horizontal distance * tan(pitch). The pitch itself lives in
  // _getCameraAngle, so height and the reported angle can never drift apart.
  _getCameraHeight(camDist) {
    const min = CONFIG.CAM_DIST_MIN, max = CONFIG.CAM_DIST_MAX;
    const tNorm = (camDist - min) / (max - min); // 0..1
    const angle = this._getCameraAngle(camDist);
    const hDist = camDist + (tNorm < 0.125 ? (0.125 - tNorm) / 0.125 * 10 : 0);
    return 1.2 + hDist * Math.tan(angle);
  }

  /* LAYOUT CHANGE ACROSS THE 2Ã¢â€ â€™3 STOP BORDER.

     Wheel in past the border and the game hands the mouse back to the OS so
     the strategic aim can read the cursor; wheel back out and it wraps the
     pointer again for the WoT-style delta aiming. Camera snaps once (it
     physically teleports between a shoulder view and a 138-unit-high perch Ã¢â‚¬â€
     easing through every intermediate angle looks broken). */
  _onStageChange(wasStrat, nowStrat){
    if(wasStrat === nowStrat) return;
    this._aimPitch = 0;
    this._snapCameraNext = true;
    this._updateCrosshair();
    const canPlay = this.localTank && this.localTank.alive && !this.localTank.dying &&
                    !(this._cinematicPhase || this._matchStartDelay > 0);
    if(nowStrat){
      try { if(document.pointerLockElement) document.exitPointerLock(); } catch(e){}
    } else if(canPlay){
      const cv = this.renderer && this.renderer.domElement;
      try { if(cv && !document.pointerLockElement) cv.requestPointerLock(); } catch(e){}
    }
  }

  /* Pitch a horizontal shot direction `pitch` radians without changing its
     heading: horizontal part scales by cos(pitch), vertical becomes
     sin(pitch). Same helper the aim line and the spawned shell use, so what
     you see drawn is exactly what flies. */
  _pitchDir(dir, pitch){
    const p = pitch || 0;
    const v = new THREE.Vector3(
      dir.x * Math.cos(p),
      Math.sin(p),
      dir.z * Math.cos(p));
    if(v.lengthSq() < 1e-6) v.set(dir.x, 0, dir.z);
    return v.normalize();
  }

  /* Height a wall footprint around (x,z) actually tops out at.

     world.collidesWallsOnly is footprint-only, but the ballistic ray now
     needs the vertical edge: a shell ABOVE the top edge crests the wall
     and keeps flying, one BELOW it dies on the wall face. Every wall entry
     in world.walls carries its mesh, and for a Box the world height comes
     from the mesh's own bounding box + position.y Ã¢â‚¬â€ true for border walls,
     custom map walls and crates alike. Walls with no usable mesh are
     treated as knee-high so a malformed custom wall never eats a shot. */
  _wallHeadroom(world, x, z){
    let best = 0;
    for(const w of world.walls){
      const hx = w.w / 2 + 0.3, hz = w.d / 2 + 0.3;
      if(Math.abs(x - w.x) >= hx || Math.abs(z - w.z) >= hz) continue;
      let h = 1.5;
      try {
        const m = w.mesh;
        if(m && m.isMesh && m.geometry){
          if(!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          const bb = m.geometry.boundingBox;
          const sy = m.scale ? m.scale.y : 1;
          h = ((bb.max.y - bb.min.y) * sy) + (m.position ? m.position.y : 0);
        }
      } catch(e){}
      if(h > best) best = h;
    }
    return best;
  }

  /* THE WALL-HIT X. One persistent sprite, drawn only when the aim ribbon
     ends on a wall face; repositioned in place so a sweeping aim doesn't
     spawn a trail of them. A red X AT the impact point is the "this shot
     stops HERE" cue the plain aim line never gave. */
  _updateWallHitMark(show, x, y, z){
    if(!this._wallHitMark){
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d');
      g.strokeStyle = '#ff3b30';
      g.lineWidth = 9;
      g.lineCap = 'round';
      g.shadowColor = 'rgba(255,59,48,0.9)';
      g.shadowBlur = 8;
      g.beginPath(); g.moveTo(12, 12); g.lineTo(52, 52);
      g.moveTo(52, 12); g.lineTo(12, 52); g.stroke();
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true,
        opacity: 0.95, depthWrite: false,
      }));
      sp.scale.set(2.2, 2.2, 1);
      sp.renderOrder = 1000;
      sp.frustumCulled = false;
      sp.visible = false;
      this.scene.add(sp);
      this._wallHitMark = sp;
    }
    const m = this._wallHitMark;
    if(show){
      m.position.set(x, y, z);
      m.visible = true;
    } else {
      m.visible = false;
    }
  }

  // Horizontal distance from tank (with close-zoom offset)
  _getCamHOffset(camDist) {
    const tNorm = (camDist - CONFIG.CAM_DIST_MIN) / (CONFIG.CAM_DIST_MAX - CONFIG.CAM_DIST_MIN);
    return tNorm < 0.125 ? (0.125 - tNorm) / 0.125 * 10 : 0;
  }

  /* THE LOWEST GROUND IN THE LOADED ARENA.

     The bottom of the map's bounding box, which _fitWorldToMap() records when
     the GLB loads. Everything below this is outside the world: there is no floor
     down there, and nothing is meant to be. Zero is the fallback for a map with
     no recorded box. */
  _worldFloorY(){
    const box = this.world && this.world._tdmBox;
    return (box && typeof box.min.y === 'number' && isFinite(box.min.y)) ? box.min.y : 0;
  }

  /* THE CAMERA IS NOT ALLOWED BELOW THE WORLD.

     A tank that drives off the edge of the ground mesh falls forever, because
     there is nothing under it. The camera followed it down Ã¢â‚¬â€ measured at
     y = -12,041 on a map whose floor is at about zero Ã¢â‚¬â€ and the view became a
     flat grey nothing with the HUD still drawn over it. It looks exactly like a
     freeze: nothing moves, no error is logged, and input still works.

     Nothing the player does should be able to move the camera out of the
     arena, so every camera path clamps its target to the floor. This is a
     safety net rather than the fix Ã¢â‚¬â€ a tank that has left the world is also put
     back on its spawn by _recoverFallenTanks Ã¢â‚¬â€ but it means that even if some
     other route drops a tank, the view can never become unusable. */
  _clampCameraTarget(v){
    const floor = this._worldFloorY() + 1.5;
    if(v.y < floor) v.y = floor;
    return v;
  }

  /* PUT A TANK THAT FELL OUT OF THE WORLD BACK ON ITS SPAWN.

     The maps are a trimesh collider built from the GLB, so anywhere that mesh
     does not cover Ã¢â‚¬â€ its outer edge, or a gap the level designer left Ã¢â‚¬â€ is a
     hole straight through the arena. A tank that finds one keeps falling under
     gravity forever: measured at y = -15,720 after a couple of minutes, with
     the camera in tow.

     It is put back rather than killed, because falling off is not something the
     player did deliberately and a death they did not earn reads far worse than
     a short hop back to their spawn point. The tank keeps its health, damage
     and kills Ã¢â‚¬â€ nothing about the round changes except where it is standing. */
  _recoverFallenTanks(){
    const floor = this._worldFloorY();
    /* How far below the map counts as "gone". Generous, because a legitimate
       drop down a cliff can be well below the bounding box minimum, and a tank
       should not be rescued while it is still legitimately in the level. */
    const killY = floor - 120;
    for(const t of this.tanks){
      if(!t || !t.alive || t.dying || !t._physBody) continue;
      const y = t._physBody.translation().y;
      if(!(y < killY)) continue;

      const sp = t._spawnPos || { x: t.x, z: t.z };
      const heading = (t._spawnHeading != null)
        ? t._spawnHeading
        : (t.team === 'red' ? Math.PI : 0);

      /* Put the BODY back, not just the field. The visual position is read out
         of the body every frame for a simulated tank, so assigning x/z alone
         would be undone on the next _syncTransform() Ã¢â‚¬â€ the same mistake the
         spawn message used to make. */
      try {
        const v = t._physBody.translation();
        t._physBody.setTranslation({ x: sp.x, y: (sp.y != null ? sp.y : floor + 4), z: sp.z }, true);
        t._physBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        t._physBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
      } catch(e){}
      t.x = sp.x; t.z = sp.z;
      t.heading = heading;
      t._physBodyY = null;
      try { t._syncTransform(); } catch(e){}

      if(t === this.localTank){
        if(typeof Menu !== 'undefined' && Menu.toast){
          Menu.toast('You left the arena Ã¢â‚¬â€ put back on your spawn');
        }
        /* The camera is following a tank that was 15,000 units down. It has to
           be snapped, not eased, or it spends several seconds crawling back up
           through the terrain, which looks like a slow-motion freeze. */
        this._snapCameraNext = true;
      }
    }
  }

  // Piecewise camera angle (base curve), plus the extra vertical tilt.
  _getCameraAngle(camDist) {
    const min = CONFIG.CAM_DIST_MIN, max = CONFIG.CAM_DIST_MAX;
    const tNorm = (camDist - min) / (max - min);
    let angle;
    if(tNorm < 0.4375){
      const tl = tNorm / 0.4375;
      angle = this._camAngleMin + tl * (this._camAngleMax - this._camAngleMin);
    } else if(tNorm < 0.6875){
      const tl = (tNorm - 0.4375) / 0.25;
      angle = this._camAngleMax + tl * (60 * Math.PI / 180 - this._camAngleMax);
    } else {
      const tl = (tNorm - 0.6875) / 0.3125;
      angle = 60 * Math.PI / 180 + tl * (Math.PI / 2 - 60 * Math.PI / 180);
    }

    // +10Ã‚Â° of extra "look straight down" tilt through the 40..120 zoom band.
    // Ramps in over 40..55 and back out over 120..145. The taper has to be
    // gentler than the base curve rises (~0.65Ã‚Â° per unit of distance) or the
    // pitch would stall while you keep zooming, so it is spread over 25 units.
    const tilt = Math.max(0, Math.min(1,
      (camDist - 40) / 15,          // ramps 0 -> 1 across 40..55
      (145 - camDist) / 25));       // ramps 1 -> 0 across 120..145
    angle += tilt * 10 * Math.PI / 180;

    // Hard cap. The base curve ends at a true 90Ã‚Â°, and tan(90Ã‚Â°) is infinite -
    // that used to fling the camera to y = 2.6e18, i.e. well past camera.far,
    // so the screen went empty at full zoom-out. 80Ã‚Â° is already almost top-down.
    return Math.min(angle, 80 * Math.PI / 180);
  }

  /* ---- Tank switch during countdown ---- */
  _populateTankSwitchList(){
    const panel = document.getElementById('tank-switch-panel');
    const grid = document.getElementById('tank-switch-grid');
    const countEl = document.getElementById('ts-count');
    if(!panel || !grid || !this._tdmState) return;
    panel.classList.remove('hidden');
    grid.innerHTML = '';
    const favs = this._tankFavorites || [];
    const ids = TANK_ORDER.filter(id => id !== 'tankdisplay' && id !== 'dummy');
    ids.sort((a,b) => {
      const af = favs.includes(a) ? 0 : 1;
      const bf = favs.includes(b) ? 0 : 1;
      return af - bf;
    });
    const currentId = this.localTank ? this.localTank.def.id : this.settings.selectedTank;
    const currentIdx = ids.indexOf(currentId);
    // Show 2 rows: 10 per row = 20 visible tanks (full width panel)
    const perRow = 10;
    const visibleCount = perRow * 2;
    this._tsIds = ids;
    this._tsOffset = Math.max(0, Math.min(currentIdx - Math.floor(visibleCount / 2), ids.length - visibleCount));
    this._tsRenderGrid(currentId, visibleCount);
    if(countEl) countEl.textContent = (currentIdx + 1) + '/' + ids.length;
    // Nav buttons
    const prevBtn = document.getElementById('ts-prev');
    const nextBtn = document.getElementById('ts-next');
    if(prevBtn) prevBtn.onclick = () => {
      this._tsOffset = Math.max(0, this._tsOffset - visibleCount);
      this._tsRenderGrid(currentId, visibleCount);
    };
    if(nextBtn) nextBtn.onclick = () => {
      this._tsOffset = Math.min(ids.length - visibleCount, this._tsOffset + visibleCount);
      this._tsRenderGrid(currentId, visibleCount);
    };
  }

  _tsRenderGrid(currentId, visibleCount){
    const grid = document.getElementById('tank-switch-grid');
    const ids = this._tsIds || [];
    const offset = this._tsOffset || 0;
    if(!grid) return;
    grid.innerHTML = '';
    const favs = this._tankFavorites || [];
    const visible = ids.slice(offset, offset + visibleCount);
    visible.forEach(id => {
      const def = TANKS[id];
      if(!def) return;
      const btn = document.createElement('div');
      btn.className = 'ts-btn' + (id === currentId ? ' active' : '');
      const star = document.createElement('div');
      star.className = 'ts-star' + (favs.includes(id) ? ' on' : '');
      star.textContent = '\u2605';
      star.onclick = (e) => {
        e.stopPropagation();
        this._toggleTankFavorite(id);
      };
      btn.appendChild(star);
      const icon = document.createElement('img');
      icon.src = 'assets/icons/tank-icon.webp';
      btn.appendChild(icon);
      const nm = document.createElement('div');
      nm.className = 'ts-name';
      nm.textContent = def.name;
      btn.appendChild(nm);
      btn.onclick = () => this._switchLocalTank(id);
      grid.appendChild(btn);
    });
  }

  _toggleTankFavorite(id){
    if(!this._tankFavorites) this._tankFavorites = [];
    const idx = this._tankFavorites.indexOf(id);
    if(idx >= 0) this._tankFavorites.splice(idx, 1);
    else this._tankFavorites.push(id);
    try{ localStorage.setItem('tankFavorites', JSON.stringify(this._tankFavorites)); }catch(e){}
    this._populateTankSwitchList();
  }

  _switchLocalTank(newTankId){
    if(!this.localTank || (this._matchStartDelay <= 0 && !this._cinematicPhase)) return;
    const newDef = TANKS[newTankId];
    if(!newDef || newDef.id === this.localTank.def.id) return;
    // Save camera state before switch
    const savedCamPos = this.camera.position.clone();
    const savedCamAngle = this.camAngle;
    const old = this.localTank;
    const pos = {x: old.x, z: old.z, heading: old.heading, team: old.team};
    const groundY = old.y || 2;
    old.detach();
    old.alive = false;
    const idx = this.tanks.indexOf(old);
    if(idx >= 0) this.tanks.splice(idx, 1);
    const t = new Tank(newDef, {
      id:'local', name:this.settings.playerName, isLocal:true,
      x: pos.x, z: pos.z, heading: pos.heading,
      physicsWorld:this.physicsWorld, allowFall:true, startY: groundY
    });
    this._finalizeTank(t);
    this.tanks.push(t);
    this.localTank = t;
    this.localTank.team = pos.team;
    // Keep the original spawn point across a tank switch (Capture the Circle
    // respawns you where you STARTED, not where you switched).
    if(old._spawnPos){ t._spawnPos = old._spawnPos; t._spawnHeading = old._spawnHeading; }
    this.localTank._drawHp();
    this.settings.selectedTank = newTankId;
    this._populateTankSwitchList();
    // Restore camera state so it doesn't jump
    this.camera.position.copy(savedCamPos);
    this.camAngle = savedCamAngle;
  }

  _switchBotTank(bot){
    if(!bot || !bot.alive || bot.dying || bot.team !== 'blue' && bot.team !== 'red') return;
    const ids = TANK_ORDER.filter(id => id !== 'tankdisplay' && id !== 'dummy');
    const newId = ids[Math.floor(Math.random()*ids.length)];
    const newDef = TANKS[newId];
    if(!newDef || newDef.id === bot.def.id) return;
    const groundY = bot._physBody ? bot._physBody.translation().y : (bot.y || 2);
    bot.detach();
    bot.alive = false;
    const idx = this.tanks.indexOf(bot);
    if(idx >= 0) this.tanks.splice(idx, 1);
    const t = new Tank(newDef, {
      id: bot.id, name: bot.name, isBot: true,
      x: bot.x, z: bot.z, heading: bot.heading,
      physicsWorld: this.physicsWorld, allowFall: true, startY: groundY
    });
    t.brain = new BotBrain(t);
    t.team = bot.team;
    if(bot._spawnPos){ t._spawnPos = bot._spawnPos; t._spawnHeading = bot._spawnHeading; }
    this._finalizeTank(t);
    this.tanks.push(t);
    t._drawHp();
  }

  /* Countdown camera: follow cam position with mouse/key rotation enabled */
  _updateCountdownCamera(dt){
    if(!this.localTank) return;
    const t = this.localTank;
    const tankY = t._physBody ? t._physBody.translation().y : (t.y || 0);

    // Allow camera rotation via keyboard and mouse drag
    const inv = (this.settings && this.settings.invertCamRot) ? -1 : 1;
    const camRot = this.input ? this.input.consumeCamRotate() : 0;
    if(camRot !== 0){
      this.camAngle -= camRot * inv * CONFIG.CAM_ROTATE_SPEED * dt;
    }
    const swipe = this.input ? this.input.consumeCamSwipe() : 0;
    if(swipe !== 0) this.camAngle += swipe * CONFIG.CAM_SWIPE_SENSITIVITY;
    const mouseRotateRaw = this.input ? this.input.consumeCamMouseRotate() : 0;
    const camMode = this.cameraMode || 'dynamic';
    const sensMul = (this.settings && typeof this.settings.cameraSensitivity === 'number') ? this.settings.cameraSensitivity / 100 : 1;
    const mouseRotate = (camMode === 'dynamic' || (this.settings && this.settings.cameraMouseRotate)) ? mouseRotateRaw : 0;
    if(mouseRotate !== 0) this.camAngle -= mouseRotate * CONFIG.CAM_MOUSE_SENS * sensMul;

    const angle = this.camAngle;
    const lookAhead = Math.min(this.camDist * 0.25, 8);
    const lookX = t.x + Math.sin(t.heading) * lookAhead;
    const lookZ = t.z + Math.cos(t.heading) * lookAhead;
    const camHOff = this._getCamHOffset(this.camDist);
    const camTarget = new THREE.Vector3(
      t.x + Math.sin(angle) * (this.camDist + camHOff),
      tankY + this._getCameraHeight(this.camDist),
      t.z + Math.cos(angle) * (this.camDist + camHOff));
    /* Floor clamp, and a matching clamp on the look target Ã¢â‚¬â€ see
       _clampCameraTarget. The countdown camera follows the same tank and needs
       the same protection. */
    this._clampCameraTarget(camTarget);
    const camLim = (this.world && this.world.half || 500) - 8;
    camTarget.x = Math.max(-camLim, Math.min(camLim, camTarget.x));
    camTarget.z = Math.max(-camLim, Math.min(camLim, camTarget.z));
    this.camera.position.lerp(camTarget, CONFIG.CAM_LERP * 0.5);
    this.camera.lookAt(lookX, Math.max(tankY, this._worldFloorY() + 1.2), lookZ);
  }
  /* Smooth orbit: front ? right side ? behind (always looking at the tank) */
  _updateCinematicCamera(){
    if(!this.localTank || !this.localTank.alive) return;
    const t = this.localTank;
    const elapsed = this._cinematicTimer || 0;
    const total = this._cinematicDuration || 5;
    const p = Math.min(1, Math.max(0, elapsed / total));
    const tankX = t.x, tankZ = t.z;
    const tankY = t._physBody ? t._physBody.translation().y : 0;

    // Orbit angle: start in front (heading + PI), sweep around to behind (heading + PI*2)
    const baseAngle = t.heading + Math.PI;
    const orbitAngle = baseAngle + p * Math.PI;

    // Distance: start close, pull back slightly toward end
    const dist = 12 - p * 4;

    // Height: start low at front, rise up as we go behind
    const camH = tankY + 2 + p * 5;

    const cx = tankX + Math.sin(orbitAngle) * dist;
    const cz = tankZ + Math.cos(orbitAngle) * dist;

    this.camera.position.set(cx, camH, cz);
    this.camera.lookAt(tankX, tankY + 1.2, tankZ);
  }

  /* THE COUNTDOWN, AS IT GOES OUT ON THE WIRE.

     This is the bug that was reported as "one team has countdown but other just
     doesn't". The countdown was counted down by each machine against its OWN
     clock, starting whenever that machine happened to finish loading the map.
     The host loads the map the moment it decides; a client loads it when the map
     announcement arrives, which over a tunnel is a second or more later. Two
     independently started countdowns are two different countdowns, so the window
     where input is frozen Ã¢â‚¬â€ and the zone that starts eating chunks Ã¢â‚¬â€ stop
     lining up, and one player is driving into a battle that has not begun while
     the other is still waiting for it to.

     So the host is the single authority and publishes the remaining time in every
     snapshot. A client adopts that number instead of counting for itself, which
     puts both sides on the same second. */
  /* THE PROJECTILE HALF OF A SNAPSHOT, AND WHY IT IS NOT AN INLINE MAP.

     The inline version read `p.dir.x` on every live projectile. That is a
     crash, not a cosmetic bug.

     Not every projectile is a flying shell. Landmine has no `dir` at all Ã¢â‚¬â€ it
     is a thing sitting on the ground waiting to be driven over Ã¢â‚¬â€ so the moment
     a bot dropped a mine, `p.dir.x` threw a TypeError. The throw happened
     INSIDE this map, inside _update, inside the try/catch that only logs
     "Update error", which meant:

       * the snapshot was never sent, so the client received nothing at all;
       * the rest of that frame's update was abandoned, including the HUD;
       * and it repeated every single frame, forever, because the mine's fuse
         is 30 seconds and it does not go away when you fail to send it.

     The visible result is precisely the bug this was reported as: the host's
     bots carry on moving, the CLIENT sees a completely frozen battlefield,
     and nothing anywhere reports a problem. The client's own tank stops
     correcting toward the host, so it feels unresponsive too.

     So directions are read defensively, and a projectile with no direction is
     sent with dx/dz of 0 Ã¢â‚¬â€ which is what a stationary mine wants anyway. The
     client only uses dx/dz to orient a flying shell, and it never simulates
     anything itself, so a zero is inert rather than wrong. */
  _projectileSnapshot(){
    const out = [];
    for(let i = 0; i < this.projectiles.length; i++){
      const p = this.projectiles[i];
      if(!p || p.dead) continue;
      const dir = p.dir;
      out.push({
        id: p.id,
        x: p.x, y: p.y, z: p.z,
        dx: dir ? (dir.x || 0) : 0,
        dz: dir ? (dir.z || 0) : 0,
        type: p.type,
        life: p.life,
        mt: p._isMortar ? 1 : 0,
      });
    }
    return out;
  }

  _netSnapshotCountdown(){
    if(this._cinematicPhase){
      return { phase:'cinematic', left: Math.max(0, (this._cinematicDuration || 0) - this._cinematicTimer) };
    }
    if(this._matchStartDelay > 0) return { phase:'countdown', left: Math.max(0, this._matchStartDelay) };
    return null;
  }

  /* Adopt the host's countdown.

     It moves the client to the host's time WHICHEVER WAY that is. An earlier
     version refused to rewind, on the reasonable-sounding grounds that a
     reordered snapshot should not drag a client backwards Ã¢â‚¬â€ but that rule is
     exactly what stops the fix working, because the common failure is the client
     being AHEAD: it starts its countdown when its own arena finishes building,
     which is not when the host started its own, and it reaches zero first. A
     client that is ahead and refuses to be pulled back is the original bug.

     A stale or reordered snapshot cannot push a client back into a countdown
     the host has finished, because `cd` is null once the host's countdown is
     over and a null is never adopted. So the authority is safe to obey
     unconditionally; that is the point of having one. */
  _adoptHostCountdown(cd){
    if(!cd || cd.phase !== 'countdown') return false;

    const left = Math.max(0, cd.left || 0);

    if(this._cinematicPhase){
      this._cinematicPhase = false;
      this._cinematicTimer = this._cinematicDuration || 0;
      this._beginCountdownPhase();
    }

    if(left <= 0.05){
      if(this._matchStartDelay > 0 || !this._matchCdShown){ this._endCountdownPhase(); return true; }
      return false;
    }

    this._matchStartDelay = left;
    this._beginCountdownPhase();
    return true;
  }

  /* Start of the pre-battle window: countdown and tank picker visible, HUD in. */
  _beginCountdownPhase(){
    if(this._matchCdShown) return;
    this._matchCdShown = true;
    try { document.exitPointerLock(); } catch(e){}
    if(this.input) this.input._pointerLocked = false;
    const mc = document.getElementById('match-cd');
    if(mc) mc.classList.remove('hidden');
    const tsp = document.getElementById('tank-switch-panel');
    if(tsp) tsp.classList.remove('hidden');
    this._populateTankSwitchList();
    this._botSwitchTimer = 0;
  }

  _endCountdownPhase(){
    this._matchStartDelay = 0;
    const mc = document.getElementById('match-cd');
    if(mc) mc.classList.add('hidden');
    const tsp = document.getElementById('tank-switch-panel');
    if(tsp) tsp.classList.add('hidden');
    this._showHUDAfterCountdown();
    this._updateCrosshair();
    try {
      if(this.cameraMode === 'dynamic'){
        const cv = this.renderer && this.renderer.domElement;
        if(cv) cv.requestPointerLock();
      }
    } catch(e){}
  }

  _update(dt){
    this._updateHitMarkers(dt);
    /* Before anything draws: a tank that has dropped out of the world is put
       back first, so the camera never spends a frame looking for it down there.
       See _recoverFallenTanks. */
    this._recoverFallenTanks();
    /* Pads follow their tanks. Inside the main update rather than the frame
       wrapper so they hold still through the countdown and the cinematic intro,
       when _update() is not running. */
    this._updateTankPads(dt);
    /* Floating "Z"s over the tanks of players who have disconnected. Driven from
       here rather than on a timer of its own, so there is nothing to leak when
       the arena is torn down. */
    this._updateSleepZ();
    try {
    this.world.update(dt, this.time, this.localTank);
    if(this.glad && !this.glad._client) this._gladUpdate(dt);
    if(this.glad && this.glad.airdrop) this._gladUpdateAirdropVis(dt);
    if(typeof CaptureCircle !== 'undefined' && CaptureCircle.getState()) CaptureCircle.update(dt);
    /* getState() rather than a flag, for the same reason the Circle uses it:
       the module is only "live" between init and dispose, and on a client it
       lives on from the host's first snapshot. Calling update on a disposed
       module would touch freed canvases. */
    if(typeof BaseDefend !== 'undefined' && BaseDefend.getState()) BaseDefend.update(dt);
    if(this.mode === 'sp' && !this._tdmState && !this.glad && !this._spWinDone){
      const aliveEnemies = this.tanks.filter(t => t.alive && !t.dying && !t.isDummy && t !== this.localTank);
      if(aliveEnemies.length === 0 && this.localTank && this.localTank.alive){
        this._spWinDone = true;
        Menu.toast('VICTORY! All enemies destroyed!');
        if(typeof UpgradeTree !== 'undefined'){
          try { UpgradeTree.recordBattle({ won: true, kills: this.localTank.kills||0, carry: false, damage: this.localTank.damageDealt||0, heals: this.localTank.healDealt||0, minutes: (this.time||0)/60, tankId: this.localTank.def.id }); } catch(e){}
        }
        try { Menu.bumpStat('wins', 1); } catch(e){}
        setTimeout(() => { if(!this.running) return; this.leaveToMenu(); }, 3000);
      }
    }

    // Camera zoom & orbit
    const zoom = this.input.consumeZoom();
    if(this._staged){
      /* SIX FIXED CAMERA POINTS. The wheel steps between stops; crossing the
         2Ã¢â€ â€™3 (or 3Ã¢â€ â€™2) border flips the LAYOUT, not just the distance Ã¢â‚¬â€ third
         person below the border, high strategic view above it. */
      if(zoom !== 0 && !(this._cinematicPhase || this._matchStartDelay > 0)){
        const oldStage = this._camStage;
        this._camStage = Math.max(0, Math.min(CONFIG.CAMERA_STOPS.length - 1,
          this._camStage - zoom));
        if(this._camStage !== oldStage){
          const stop = CONFIG.CAMERA_STOPS[this._camStage];
          const wasStrat = this.cameraMode === 'strategic';
          const nowStrat = stop.mode === 'strategic';
          this.cameraMode = nowStrat ? 'strategic' : 'dynamic';
          if(stop.mode === 'tp') this.camDist = stop.dist;
          /* Remember it, so the next battle opens where you left off. */
          this.settings.cameraStage = this._camStage;
          try { if(typeof saveSettings === 'function') saveSettings(this.settings); } catch(e){}
          this._onStageChange(wasStrat, nowStrat);
        }
      }
    } else if(zoom !== 0){
      this.camDist = Math.max(CONFIG.CAM_DIST_MIN, Math.min(CONFIG.CAM_DIST_MAX,
        this.camDist - zoom*CONFIG.CAM_ZOOM_STEP));
    }
    
    // Calculate current camera angle from horizontal (for Automatic mode detection)
    const currentCamAngleDeg = this._getCameraAngle(this.camDist) * 180 / Math.PI;
    
    const camRot = this.input.consumeCamRotate();
    const camMode = this.cameraMode || 'dynamic';
    const inv = (this.settings && this.settings.invertCamRot) ? -1 : 1;
    const sensMul = (this.settings && typeof this.settings.cameraSensitivity === 'number') ? this.settings.cameraSensitivity / 100 : 1;
    // Always consume mouse rotation once (used by dynamic and other modes)
    const mouseRotateRaw = this.input.consumeCamMouseRotate();
    // Dynamic mode always uses mouse rotation; other modes gate it behind the setting
    const mouseRotate = (camMode === 'dynamic' || (this.settings && this.settings.cameraMouseRotate))
      ? mouseRotateRaw : 0;
    
    if(camMode === 'dynamic' || camMode === 'strategic'){
      // Mouse/keyboard set a turret target angle (stored separately)
      if(this._dynTurretTarget === undefined && this.localTank) this._dynTurretTarget = this.localTank.turretAngle;
      if(camMode === 'strategic'){
        /* MODE 2: the mouse is the AIM, so it must never rotate the camera.
           The camera orbits on camRot keys (arrows/Q/E) and touch swipe only. */
        if(camRot !== 0){
          this.camAngle += camRot * CONFIG.CAM_ROTATE_SPEED * dt;
        } else {
          const swipe = this.input.consumeCamSwipe();
          if(swipe !== 0) this.camAngle += swipe * CONFIG.CAM_SWIPE_SENSITIVITY * sensMul;
        }
        this.input.consumeCamMouseRotate();   /* drained, ignored */
      } else {
        if(mouseRotate !== 0) this._dynTurretTarget -= mouseRotate * CONFIG.CAM_MOUSE_SENS * sensMul;
        if(camRot !== 0) this._dynTurretTarget += camRot * CONFIG.CAM_ROTATE_SPEED * dt;
        else if(mouseRotate === 0){
          const swipe = this.input.consumeCamSwipe();
          if(swipe !== 0) this._dynTurretTarget += swipe * CONFIG.CAM_SWIPE_SENSITIVITY * sensMul;
        }
      }
    } else if(camMode === 'automatic'){
      // Automatic: when zoomed in (20-30Ã‚Â°), camera smoothly follows turret; otherwise manual
      if(currentCamAngleDeg <= 30 && this.localTank && this.localTank.alive){
        // Smoothly follow turret - camera looks where turret aims
        const turretWorldAngle = this.localTank.turretAngle || this.localTank.heading;
        const targetCamAngle = turretWorldAngle + Math.PI;
        // Smooth interpolation for natural camera movement
        const diff = ((targetCamAngle - this.camAngle + Math.PI) % (Math.PI * 2)) - Math.PI;
        this.camAngle += diff * Math.min(1, dt * 8);
      } else {
        // Manual rotation
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
        if(moveMag > 0.30){
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

        // In Automatic (Turret) mode, camera follows turret - use stable reference for raycasting
        if(this.cameraMode === 'automatic'){
          if(!this._autoFixedCam){
            this._autoFixedCam = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 1000);
            this._autoRay = new THREE.Raycaster();
            this._autoVec = new THREE.Vector2();
            this._autoPlane = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
            this._autoHit = new THREE.Vector3();
          }
          this._autoFixedCam.aspect = innerWidth/innerHeight;
          this._autoFixedCam.updateProjectionMatrix();
          this._autoFixedCam.position.set(this.localTank.x, 100, this.localTank.z);
          this._autoFixedCam.lookAt(this.localTank.x, 0, this.localTank.z);
          this._autoVec.set(this.input.mouse.ndcX, this.input.mouse.ndcY);
          this._autoRay.setFromCamera(this._autoVec, this._autoFixedCam);
          this._autoPlane.constant = -(this.localTank.def.body.h+0.5);
          if(this._autoRay.ray.intersectPlane(this._autoPlane, this._autoHit)){
            turretAngle = Math.atan2(this._autoHit.x - this.localTank.x, this._autoHit.z - this.localTank.z);
          } else {
            turretAngle = this.localTank.turretAngle;
          }
        } else if(this.cameraMode === 'dynamic'){
          if(this.input.pressed('freezeTurret')){
            turretAngle = this.localTank.turretAngle;
          } else {
            // MODE 1 (WoT-style): Mouse X moves the crosshair, turret chases it
            // The crosshair angle is where you're aiming, turret follows at its speed
            const mouseDelta = this.input.consumeCamMouseRotate();
            if(mouseDelta !== 0 && this.localTank) {
              const sens = (this.settings && this.settings.cameraSensitivity) ? this.settings.cameraSensitivity / 100 : 1;
              this._crosshairAngle = (this._crosshairAngle || this.localTank.heading) - mouseDelta * CONFIG.CAM_MOUSE_SENS * sens;
            }
            // Turret target = crosshair angle (turret chases this at its own speed)
            this._dynTurretTarget = this._crosshairAngle;
            turretAngle = (this._dynTurretTarget !== undefined) ? this._dynTurretTarget : this.localTank.turretAngle;
          }
          /* ARTILLERY TAKES ITS RANGE FROM THE MOUSE, NOT THE POINTER.

             Everything above this line is the same code every other tank runs:
             the turret is swung by mouse-X, frozen by right mouse, and the
             camera is driven from the turret in _updateCamera. The mortar used
             to have its turret angle overwritten just below with a ray-cast off
             the raw cursor, which is what broke all three of those -- the camera
             stopped following the gun, right-mouse freeze was ignored, and
             pointer lock had to be refused to keep the ray alive.

             Range is the only genuinely new axis, and it reads mouse-Y, which is
             free because mouse-X is busy turning the turret. It feeds the arc
             through _mortarAim, so the drawn curve and the flown shell stay
             solved from one place. */
          this._mortarRange = this._advanceMortarRange(this._mortarRange, this.input.consumeAimRange());
          /* The mortar owns mouse-Y for range; make sure nobody else's stale
             pitch can leak onto it. */
          this._aimPitch = 0;
        } else {
          turretAngle = this._mouseWorldAngle();
          /* The other camera modes aim the turret from the pointer itself, so
             the mortar's range comes from the same cursor instead of the mouse.
             Consume the axis anyway so it cannot arrive late as a jump. */
          this.input.consumeAimRange();
        }

        /* MODE 1 CROSSHAIR PITCH. Mouse-Y here changes ONLY where the gun
           points vertically: mouse up raises the crosshair on screen and
           raises the shot, mouse down digs it in Ã¢â‚¬â€ while the camera neither
           moves nor orbits. Positive = aim up. Clamped to a narrow band so a
           flick can't flip a direct-fire shell into the sky. */
        if(this.cameraMode === 'dynamic'){
          const pitchDelta = this.input.consumeAimPitch();
          if(pitchDelta){
            this._aimPitch = Math.max(-CONFIG.AIM_PITCH_DOWN_DEG * Math.PI / 180,
                                     Math.min(CONFIG.AIM_PITCH_UP_DEG * Math.PI / 180,
                                              this._aimPitch - pitchDelta * CONFIG.AIM_PITCH_SENS));
          }
        } else {
          this._aimPitch = 0;
          this.input.consumeAimPitch();       /* drained, never applied */
        }
        fire = this.input.pressed('fire');
        handbrake = this.input.pressed('handbrake');
      }
      
      /* MODE 1: THE GUN PHYSICALLY ELEVATES.

         _aimPitch used to spin the aim-line math only. The tank never saw it,
         so the barrel stayed level while the crosshair rode up the screen Ã¢â‚¬â€
         the "gun does not rotate down/up" report. The tank now receives the
         same pitch game.js is about to fire along: rotation.x on a dedicated
         pitch group under the turret, which turret yaw and hull lean cannot
         unwind. Mortar solves its own arc and stays flat; everything else
         visibly digs in or lifts, matching the drawn line. */
      if(this.localTank && typeof this.localTank._applyAimPitch === 'function'){
        const visPitch = (this.cameraMode === 'dynamic' &&
                          this.localTank.def.shellType !== 'mortar' &&
                          this.localTank.def.shellType !== 'flame') ? (this._aimPitch || 0) : 0;
        this.localTank._applyAimPitch(visPitch);
      }

      const input = {throttle, turn, turretWorldAngle:turretAngle, fire, handbrake};
      /* OWN ALTITUDE RIDES THE INPUT MESSAGE. The host carries remote players as
         input-driven kinematic tanks with no physics body, so nothing on the
         host else knows the height the owner's own body is riding Ã¢â‚¬â€ this is the
         only channel. The telemetry becomes the remote tank's rendered and
         snapshot altitude on the host (ownerPeer branch +Tank.snapshot()). */
      if(this.localTank && this.localTank._allowFall){
        input.y = (typeof this.localTank._visualY === 'number' && isFinite(this.localTank._visualY))
          ? this.localTank._visualY
          : (this.localTank.y || 0);
      }
      this.localTank.setInput(input);
      // Forward input to host (P2P or Free Roam)
      if(this.mode==='client'){
        if(typeof Net !== 'undefined' && Net.p2p && Net.p2p.enabled && Net.p2p.hostId &&
           typeof Net.sendInputP2P === 'function' && Net.sendInputP2P(input)){
          /* sent direct */
        } else {
          Net.sendInput(input);
        }
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
      if(t._spawnInvuln > 0) t._spawnInvuln -= dt;
      if(this._matchStartDelay > 0 && t.brain){
        // Skip bot AI during match start countdown
        t.setInput({throttle:0,turn:0,turretWorldAngle:t.turretAngle,fire:false});
        t.update(dt, this.world, this);
        return;
      }
      if(t.brain){
        /* -------------------------------------------------------------------
           BOT THINKING IS THROTTLED, AIMING IS NOT.

           decide() costs a measured 1.6ms a frame across 17 bots, most of it a
           line-of-sight RAYCAST and an incoming-shell scan run for every bot
           on every frame. That is the single largest steady-state item in the
           game, and almost all of it is redundant: a bot re-asking "which tank
           is nearest, can I see it, is a shell coming" four times in 66ms gets
           the same answer as it would have got once.

           So each bot now re-plans on its OWN phase Ã¢â‚¬â€ bot 1 on frames 1,5,9,
           bot 2 on 2,6,10 Ã¢â‚¬â€ which spreads the cost evenly and costs each bot
           nothing in reaction time beyond the four frames itself.

           What is deliberately NOT throttled:
             * AIMING. The turret is re-aimed at the live position of its
               cached target every single frame, so leading a moving enemy is
               exactly as accurate as before.
             * REACTIONS. A bot re-plans immediately if it took damage this
               frame, or if any shell is near enough to matter Ã¢â‚¬â€ so being hit,
               and dodging, stay as sharp as they were.

           Holding throttle/turn/fire between plans is safe: reload is gated by
           the tank's own cooldown, not by the input edge.
           ------------------------------------------------------------------- */
        const phase = t._botPhase === undefined ? ((t._botPhase = this.tanks.indexOf(t) % BOT_THINK_EVERY)) : t._botPhase;
        const mustThink =
          (this._frameNo % BOT_THINK_EVERY) === phase ||
          t._botDirty ||
          (t._hurtThisFrame) ||
          this._shellNear(t);

        if(mustThink){
          t._botDirty = false;
          t._hurtThisFrame = false;
          const inp = t.brain.decide(this);
          t._botPlan = inp;
          t.setInput(inp);
        } else {
          const plan = t._botPlan;
          if(plan){
            /* Re-aim at the target's LIVE position. Everything else Ã¢â‚¬â€ throttle,
               turn, fire Ã¢â‚¬â€ is held from the last decision.

               A target that has gone HIDDEN must be dropped right here, not at
               the next decision. Bots think on an interval (BOT_THINK_EVERY),
               so between two decides this branch runs every frame while
               _curTarget still names the tank that has just ducked into a tree
               -- and the bot would keep tracking and firing at a tank it is not
               supposed to be able to see, right up until the next think tick.

               Firing is suppressed too, and deliberately NOT the whole plan: the
               bot keeps its throttle and turn, so it carries on driving and only
               stops shooting. That is what losing a target mid-sentence looks
               like. */
            const tgt = (t.brain._curTarget && t.brain._curTarget.camoFactor > 0)
              ? t.brain._curTarget
              : null;
            const me = t;
            const aim = (tgt && tgt.alive)
              ? Math.atan2(tgt.x - me.x, tgt.z - me.z)
              : (t.brain.targetLastSeen
                  ? Math.atan2(t.brain.targetLastSeen.x - me.x, t.brain.targetLastSeen.z - me.z)
                  : plan.turretWorldAngle);
            t.setInput({
              throttle: plan.throttle,
              turn: plan.turn,
              turretWorldAngle: aim,
              fire: tgt ? plan.fire : false,
              handbrake: plan.handbrake,
            });
          } else {
            t.setInput({throttle:0,turn:0,turretWorldAngle:t.turretAngle,fire:false});
          }
        }
      } else if(t.ownerPeer && this.clientTankInputs[t.ownerPeer]){
        const inp = this.clientTankInputs[t.ownerPeer];
        /* ALTITUDE TELEMETRY: the owner's own physics run reported the height
           this kinematic replica is standing at. Store it Ã¢â‚¬â€ `_visualY` makes
           the ROOT render at it on this machine and `Tank.snapshot()` ships it
           to every client, so a remote tank sits ON the hill everywhere instead
           of being buried at y=0. */
        if(typeof inp.y === 'number' && isFinite(inp.y)){
          t._peerReportY = inp.y;
          t._visualY = inp.y;
        }
        t.setInput(inp);
      } else if(t === this.localTank){
        // Already set above
      } else {
        t.setInput({throttle:0,turn:0,turretWorldAngle:t.turretAngle,fire:false});
      }
      /* NETWORK-DRIVEN TANKS ARE NOT SIMULATED ON A CLIENT.

         Every tank used to get t.update() here, which drives the physics body.
         On a client that meant the authoritative position arriving from the host
         was overwritten by local physics on the very next frame, and
         _netSmoothTick() was never called from anywhere, so the interpolation
         never ran either. Result: remote tanks stood still at their spawn
         points on the client while the host's copy drove around -- "the tanks
         do not sync even though it says 2 players".

         So: advance the interpolation and skip simulation. The host still owns
         these tanks; the client only draws them. */
      if(t.netDriven){
        t._netSmoothTick();
        return;
      }
      t.update(dt, this.world, this);
    });
    if(!this._botDebugLogged && this._matchStartDelay <= 0) this._botDebugLogged = true;

    // Void / boundary damage: kill tanks that go outside the map
    if(this._tdmState && this._tdmState.roundActive){
      const half = (this.world && this.world.half || 500) - 10;
      for(const t of this.tanks){
        if(!t.alive || t.dying || t.isDummy) continue;
        const outOfBounds = Math.abs(t.x) > half || Math.abs(t.z) > half;
        if(outOfBounds){
          t.takeDamage(t.hp, null, null); // instant kill
          if(t === this.localTank){
            Menu.toast('You fell into the void!');
          }
        }
      }
    }
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

    // Capture the Circle: everyone (you AND the bots) comes back at the exact
    // spawn point they started from once the respawn timer is up.
    //
    // Base Defend is in the same branch and for the same reason: it has
    // UNLIMITED respawns, which is what makes it a mode about bases rather than
    // about who can hold the field. A tank that stayed dead would mean a team
    // eventually ran out of tanks to lose.
    if(this._captureCircleMode || this._baseDefendMode){
      const cfg = this._baseDefendMode ? GAMEMODES.baseDefend : GAMEMODES.captureTheCircle;
      const delay = cfg.respawnTime || 5;
      for(const t of this.tanks){
        if(t.isDummy || !t.dying || t.deathT < delay) continue;
        this._captureRespawn(t);
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
    for(let i=0;i<this.projectiles.length;i++) this.projectiles[i].update(dt, this.world, this);
    { let w=0; for(let i=0;i<this.projectiles.length;i++){const p=this.projectiles[i]; if(p.dead){ p.detach(); } else { this.projectiles[w++]=p; }} this.projectiles.length=w; }
    if(typeof LandmineManager !== 'undefined') LandmineManager.update(this.time);
    /* Shell traces are gone. Shells are now the TL_bullet.glb model and draw
       nothing behind them, so there is no trail to push positions into. The
       managers themselves are still built and updated below because the
       ricochet and muzzle systems still use them -- only the SHELL trail is
       gone, not the whole BulletTrailManager. */
    for(let i=0;i<this.explosions.length;i++) this.explosions[i].update(dt);
    if(typeof Fireball !== 'undefined') Fireball.update(this.scene, dt);
    if(typeof MortarBlast !== 'undefined') MortarBlast.update(this.scene, dt);
    if(typeof MuzzlePop !== 'undefined') MuzzlePop.update(this.scene, dt);
    { let w=0; for(let i=0;i<this.explosions.length;i++){const e=this.explosions[i]; if(e.dead){e.detach();} else { this.explosions[w++]=e; }} this.explosions.length=w; }
    // Shell casings (physics-driven, self-lifetime)
    for(let i=0;i<this.casings.length;i++) this.casings[i].update(dt, this.world, this);
    { let w=0; for(let i=0;i<this.casings.length;i++){const c=this.casings[i]; if(c.dead){c.detach();} else { this.casings[w++]=c; }} this.casings.length=w; }
    /* EVERY SHELL AND CASING IN ONE CALL, ONCE PER FRAME.

       Shells are drawn as four InstancedMeshes (rifle body, rifle tracer,
       artillery body, artillery tracer) plus one for casings, instead of a pair
       of THREE.Meshes per round. The bodies used a shared geometry already, so
       this was the one place in the game where instancing applied directly: a
       firefight that was submitting a draw call per round now submits four.

       PLACED HERE, AFTER BOTH SWEEPS, and that placement is load-bearing rather
       than tidy. The sweeps above are what call detach(), and detach() is what
       removes a dead round from Shell._live -- so a rebuild placed before them
       would spend a frame drawing rounds that were already spent, which at
       80 units a second is over a unit of a shell visibly trailing its own
       impact.

       It cannot be self-driven from projectile.js either. three uploads
       instanceMatrix from WebGLObjects.update(), which runs inside
       projectObject() and therefore BEFORE onBeforeRender fires, so a rebuild
       hung off that hook would be permanently one frame late. See the note on
       Shell.updateInstances. */
    if(typeof Shell !== 'undefined') Shell.updateInstances();
    // Segment sparks (pooled yellow ribbons; SparkLines never allocates and is
    // updated in place each frame, so ticking it while idle costs nothing)
    if(typeof SparkLines !== 'undefined') SparkLines.update(this.scene, dt);
    // Muzzle flash sprites
    if(this._muzzleFlashes){
      for(let i=0;i<this._muzzleFlashes.length;i++){
        const p=this._muzzleFlashes[i];
        p.life -= dt;
        if(p.vx != null){
          p.sprite.position.x += p.vx * dt;
          p.sprite.position.z += p.vz * dt;
          p.sprite.position.y += p.vy * dt;
          p.vy -= 1.5 * dt;
        }
        p.sprite.material.opacity = Math.max(0, p.life / p.maxLife);
        p.sprite.scale.x = p.sprite.scale.y = (p.baseScale || 2.0) * (1 + (1 - p.life / p.maxLife) * 0.5);
      }
      { let w=0; for(let i=0;i<this._muzzleFlashes.length;i++){const p=this._muzzleFlashes[i]; if(p.life<=0){ this._vfxRelease(p.sprite); } else { this._muzzleFlashes[w++]=p; }} this._muzzleFlashes.length=w; }
    }
    // Flash picture: a short hold, then the sides draw in while it fades out.
    if(this._picFlashes && this._picFlashes.length){
      for(let i=0;i<this._picFlashes.length;i++){
        const p = this._picFlashes[i];
        p.life -= dt;
        const k = 1 - Math.max(0, p.life) / p.maxLife;            /* 0 ? 1 */
        const e = Math.max(0, Math.min(1, (k - 0.12) / 0.88));    /* hold, then go */
        const draw = 1 - e;                   /* every edge draws in together */
        p.mesh.scale.set(p.w * draw, p.h * draw, 1);
        p.mesh.material.opacity = 1 - e;
      }
      let w = 0;
      for(let i=0;i<this._picFlashes.length;i++){
        const p = this._picFlashes[i];
        if(p.life <= 0){
          this.scene.remove(p.mesh);
          p.mesh.visible = false;
          /* CAPPED.
             The pool was pushed to with no limit, while every other pool in
             this file caps itself (_vfxPool caps at 400 per key, disposing the
             overflow). So this one grew for the life of the page: every muzzle
             flash ever fired stayed resident as a full-size transparent quad
             with its own material. Memory climbs with every match played until
             the browser starts fighting for GPU memory, which shows up as
             long, random stalls. Past the cap the surplus is disposed. */
          if(this._picFlashPool.length < 12){
            this._picFlashPool.push(p.mesh);
          } else {
            p.mesh.material.dispose();
          }
        } else this._picFlashes[w++] = p;
      }
      this._picFlashes.length = w;
    }
    // Muzzle lights (pooled Ã¢â‚¬â€ fade out after each shot)
    if(this._muzzleLights){
      for(let i=0;i<this._muzzleLights.length;i++){
        const l=this._muzzleLights[i];
        if(!l.active) continue;
        /* While the light burns it rides the muzzle of the tank that fired, so
           the flare stays on the barrel instead of lingering at the old spot. */
        if(l.anchor){
          try {
            if(l.anchor.alive && !l.anchor.dying && l.anchor.muzzle){
              const m = l.anchor.muzzle();
              if(m && m.pos) l.light.position.set(m.pos.x, m.pos.y + 0.2, m.pos.z);
            } else l.anchor = null;
          } catch(e){ l.anchor = null; }
        }
        const k = (l.life -= dt) / l.maxLife;
        l.light.intensity = k <= 0 ? 0 : 30 * k;
        if(k <= 0) l.active = false;
      }
    }
    // Helix video overlay
    if(this._helixVideos.size){
      for(const [tankId, hv] of this._helixVideos){
        const tank = this.tanks.find(t => t.id === tankId);
        if(!tank){ hv.fadeTimer = 0.30; continue; }
        const hasFlame = this.projectiles.some(p => p.type === 'flame' && p.owner && p.owner.id === tankId);
        if(hasFlame){
          hv.firing = true;
          hv.fadeTimer = 0;
          hv.growTimer = Math.min(1, (hv.growTimer || 0) + dt * 2.5);
          const sc = 0.1 + 0.9 * hv.growTimer;
          hv.mesh.scale.set(sc, sc, sc);
          hv.mesh.material.opacity = 0.75 * hv.growTimer;
          if(hv.el.paused) hv.el.play().catch(() => {});
        } else if(hv.firing){
          hv.firing = false;
          hv.fadeTimer = 0.40;
        }
        if(!hv.firing){
          hv.fadeTimer -= dt;
          hv.growTimer = Math.max(0, (hv.growTimer || 0) - dt * 2);
          const sc = Math.max(0.1, hv.growTimer);
          hv.mesh.scale.set(sc, sc, sc);
          hv.mesh.material.opacity = Math.max(0, hv.fadeTimer / 0.40) * hv.growTimer;
          if(hv.fadeTimer <= 0){
            hv.el.pause(); hv.el.currentTime = 0;
            hv.parent.remove(hv.mesh);
            hv.mesh.geometry.dispose();
            hv.mesh.material.dispose();
            this._disposeVideoTex(hv.tex, hv.el);
            this._helixVideos.delete(tankId);
          }
        }
      }
    }
    // Molotov fire zones update
    if(this._molotovFires && this._molotovFires.length){
      for(let i = this._molotovFires.length - 1; i >= 0; i--){
        const m = this._molotovFires[i];
        m.timer -= dt;
        m.tickTimer -= dt;
        const fadeIn = Math.min(1, (1 - m.timer / m.maxTimer) / 0.5);
        const fadeOut = Math.min(1, m.timer / m.fadeOut);
        const op = Math.min(fadeIn, fadeOut) * 0.55;
        const flicker = 0.85 + 0.15 * Math.sin(this.time * 18 + m.phase);
        m.mesh.material.opacity = op * flicker;
        m.innerMesh.material.opacity = op * flicker * 1.2;
        m.innerMesh.material.color.setHSL(0.08 + 0.02 * Math.sin(this.time * 25 + m.phase), 1, 0.55);
        if(m.tickTimer <= 0){
          m.tickTimer = m.tick;
          for(const o of this.tanks){
            if(!o.alive || o === m.owner) continue;
            if(m.owner.allyId && (o.id === m.owner.allyId || o.allyId === m.owner.id)) continue;
            if(m.owner.team && o.team && m.owner.team === o.team) continue;
            const dd = Math.hypot(o.x - m.x, o.z - m.z);
            if(dd < m.radius){
              o.takeDamage(m.damage, m.owner, this);
              this.spawnDamageLabel(o.x, o.def.turret.h + o.def.body.h + 3.6, o.z, m.damage);
            }
          }
        }
        if(m.timer <= 0){
          this.scene.remove(m.mesh);
          this.scene.remove(m.innerMesh);
          m.mesh.geometry.dispose();
          m.mesh.material.dispose();
          m.innerMesh.geometry.dispose();
          m.innerMesh.material.dispose();
          this._molotovFires.splice(i, 1);
        }
      }
    }
    // VideoVFX + Spray system updates
    if(typeof VideoVFX !== 'undefined') VideoVFX.update();
    if(typeof SpraySystem !== 'undefined') SpraySystem.update();
    this._updateVideoVFX(dt);
    // Ricochet labels
    if(this._ricoLabels){
      for(let i=0;i<this._ricoLabels.length;i++){const l=this._ricoLabels[i]; l.life -= dt; l.sprite.material.opacity = Math.max(0, l.life / l.maxLife); }
      { let w=0; for(let i=0;i<this._ricoLabels.length;i++){const l=this._ricoLabels[i]; if(l.life<=0){ this.scene.remove(l.sprite); l.sprite.material.map.dispose(); l.sprite.material.dispose(); } else { this._ricoLabels[w++]=l; }} this._ricoLabels.length=w; }
    }
    // Floating damage numbers
    if(this._dmgLabels){
      for(let i=0;i<this._dmgLabels.length;i++){
        const l = this._dmgLabels[i];
        l.life -= dt;
        const k = Math.max(0, l.life / l.maxLife);          // 1 -> 0
        const age = l.maxLife - l.life;
        // Arc: kicked up and sideways, pulled back down, lateral speed bleeds off.
        l.vy -= 11 * dt;
        const drag = Math.max(0, 1 - 3.0 * dt);
        l.vx *= drag; l.vz *= drag;
        l.sprite.position.x += l.vx * dt;
        l.sprite.position.y += l.vy * dt;
        l.sprite.position.z += l.vz * dt;
        // Punch-in scale, then a slow settle so it reads as a slap, not a fade.
        const settle = age < 0.10 ? 1 + 0.65 * (1 - age / 0.10) : 1;
        l.sprite.scale.set(2.8 * settle, 1.4 * settle, 1);
        l.sprite.material.rotation = -0.16 * l.side * Math.min(1, age / 0.18);
        // Hold crisp for most of the life, then fade only at the very end.
        l.sprite.material.opacity = k > 0.5 ? 1 : Math.max(0, k / 0.5);
      }
      { let w=0; for(let i=0;i<this._dmgLabels.length;i++){const l=this._dmgLabels[i]; if(l.life<=0){ this.scene.remove(l.sprite); l.sprite.material.map && l.sprite.material.map.dispose(); l.sprite.material.dispose(); if(l.canvas) this._putDmgCanvas(l.canvas); } else { this._dmgLabels[w++]=l; }} this._dmgLabels.length=w; }
    }
    // Muzzle smoke
    if(this._muzzleSmokes){
      for(let i=0;i<this._muzzleSmokes.length;i++){
        const p=this._muzzleSmokes[i];
        p.life -= dt;
        p.sprite.position.x += p.vx * dt;
        p.sprite.position.z += p.vz * dt;
        p.sprite.position.y += p.vy * dt;
        p.vy -= 0.3 * dt;
        const grow = 1 + (1 - p.life / p.maxLife) * 1.2;
        p.sprite.scale.x = p.sprite.scale.y = p.baseScale * grow;
        p.sprite.material.opacity = Math.max(0, (p.life / p.maxLife) * 0.65);
      }
      { let w=0; for(let i=0;i<this._muzzleSmokes.length;i++){const p=this._muzzleSmokes[i]; if(p.life<=0){ this._vfxRelease(p.sprite); } else { this._muzzleSmokes[w++]=p; }} this._muzzleSmokes.length=w; }
    }
    // Destruction / burst particles
    if(this._bursts){
      for(let i=0;i<this._bursts.length;i++){
        const p=this._bursts[i];
        p.life -= dt;
        p.sprite.position.x += p.vx * dt;
        p.sprite.position.z += p.vz * dt;
        p.sprite.position.y += p.vy * dt;
        p.vy -= p.gravity * dt;
        const k = 1 - p.life / p.maxLife;
        p.sprite.scale.x = p.sprite.scale.y = p.baseScale * (1 + k * p.grow);
        if(p.spin) p.sprite.rotation.z += p.spin * dt;
        p.sprite.material.opacity = Math.max(0, (p.life / p.maxLife) * p.fade);
      }
      { let w=0; for(let i=0;i<this._bursts.length;i++){const p=this._bursts[i]; if(p.life<=0){ this._vfxRelease(p.sprite); } else { this._bursts[w++]=p; }} this._bursts.length=w; }
    }
    // Exhaust / drift smoke particles
    if(this._exhaustParts){
      for(let i=0;i<this._exhaustParts.length;i++){
        const p=this._exhaustParts[i];
        p.life -= dt;
        p.sprite.position.x += p.vx * dt;
        p.sprite.position.z += p.vz * dt;
        p.sprite.position.y += p.vy * dt;
        p.vy -= 0.2 * dt;
        const grow = 1 + (1 - p.life / p.maxLife) * 1.5;
        p.sprite.scale.x = p.sprite.scale.y = p.baseScale * grow;
        p.sprite.material.opacity = Math.max(0, (p.life / p.maxLife) * 0.4);
      }
      { let w=0; for(let i=0;i<this._exhaustParts.length;i++){const p=this._exhaustParts[i]; if(p.life<=0){ this.scene.remove(p.sprite); p.sprite.material.dispose(); } else { this._exhaustParts[w++]=p; }} this._exhaustParts.length=w; }
    }
    // Flamethrower damage accumulators Ã¢â‚¬â€ live stacking counter
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
          // Stop accumulating Ã¢â‚¬â€ let the sprite fade out
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

    /* No trail update. The managers are not built any more (see _resetPhysics) --
       calling this would throw on the first frame of every battle. */

// Camera (orbits around tank; auto mode locks behind hull front; in
    // spectator mode we follow the watched tank instead of the dead local one)
    /* THE CLOSING SHOT OWNS THE CAMERA.

       The match is over but the world is still being drawn underneath the
       cinematic, so every line below this one would still run and would still
       write this.camera.position Ã¢â‚¬â€ which is why the branch is here and not a
       flag checked further down. _endCineTick already set the pose on its last
       tick, and _step calls it before _update, so the pose survives the frame.

       Both the spectator rig and the follow rig are skipped, including in
       "hull" and "dynamic" modes which write the camera unconditionally. */
    if(this._endCine){
      // Camera is held by the cinematic. Deliberately empty.
    } else if(this.isSpectator){
      this._updateSpectatorCamera(dt);
    } else {
      let camFocus = (this.spectate && this.spectateTarget && this.spectateTarget.alive && !this.spectateTarget.dying)
        ? this.spectateTarget
        : (this.localTank && this.localTank.alive && !this.localTank.dying ? this.localTank : null);
      if(!camFocus && this.localTank && this.localTank.alive && !this.localTank.dying){
        this.spectate = false;
        this.spectateTarget = null;
        camFocus = this.localTank;
      }
      if(camFocus){
      const t = camFocus;
      // Handle camera modes that override camAngle
      if(this.cameraMode === 'hull'){
        this.camAngle = t.heading + Math.PI;
      } else if(this.cameraMode === 'dynamic'){
        // MODE 1 (Third Person / WoT-style):
        // - Camera rotates ONLY when dragging with mouse (right button or explicit rotate)
        // - Crosshair moves with mouse Y (up/down) for vertical aim
        // - Turret chases the crosshair at turretTurn speed
        // - Firing happens where the crosshair is aimed
        // Camera slowly follows the crosshair (mouse aim direction) instead of snapping.
        // This gives a smooth chase-camera feel: the camera eases toward where you aim.
        const crosshairAngle = this._crosshairAngle || t.turretAngle;
        const targetCamAngle = (crosshairAngle || t.heading) + Math.PI;
        const lerpSpeed = 4.0;
        const diff = ((targetCamAngle - this.camAngle + Math.PI) % (Math.PI * 2)) - Math.PI;
        this.camAngle += diff * Math.min(1, dt * lerpSpeed);
      } else if(this.cameraMode === 'strategic'){
        // MODE 2 (Strategic/Top-down): Camera is STABLE.
        // Camera does NOT rotate with mouse OR tank heading.
        // It follows the tank's POSITION but stays at a fixed angle.
        // This means: as tank moves, camera follows; as tank turns, camera doesn't orbit.
        // Mouse only controls turret aim (via crosshair), not camera.
        // Initialize camera angle on first frame to be behind the tank.
        if(this._strategicCamAngle === undefined) {
          // Start with camera behind the tank (standard third-person view angle)
          this._strategicCamAngle = t.heading + Math.PI;
        }
        // Use the fixed strategic camera angle - doesn't change with tank heading
        // This keeps the camera stable while you aim with the mouse
        this.camAngle = this._strategicCamAngle;
      } else if(this.cameraMode === 'automatic'){
        const currentCamAngleDeg = this._getCameraAngle(this.camDist) * 180 / Math.PI;
        if(currentCamAngleDeg <= 30){
          const turretWorldAngle = t.turretAngle || t.heading;
          const targetCamAngle = turretWorldAngle + Math.PI;
          // Smooth interpolation for natural camera movement
          const diff = ((targetCamAngle - this.camAngle + Math.PI) % (Math.PI * 2)) - Math.PI;
          this.camAngle += diff * Math.min(1, dt * 8);
        }
      }
      const angle = this.camAngle;
      const tankY = t._allowFall && t._physBody ? t._physBody.translation().y : 0;        const lookAhead = Math.min(this.camDist * 0.25, 8);
        const lookX = t.x + Math.sin(t.heading) * lookAhead;
        const lookZ = t.z + Math.cos(t.heading) * lookAhead;
        const camHOff = this._getCamHOffset(this.camDist);
        this._camTarget = this._camTarget || new THREE.Vector3();
        this._turretWp = this._turretWp || new THREE.Vector3();
        let camTarget;
        // In strategic mode, ignore mouse rotation for camera - camera stays stable
      if(this.cameraMode === 'dynamic'){
        t.turretGroup.getWorldPosition(this._turretWp);
        this._camTarget.set(
          this._turretWp.x + Math.sin(angle) * (this.camDist + camHOff),
          tankY + this._getCameraHeight(this.camDist),
          this._turretWp.z + Math.cos(angle) * (this.camDist + camHOff));
        camTarget = this._camTarget;
      } else if(this.cameraMode === 'strategic'){
        /* MODE 2 CAMERA Ã¢â‚¬â€ the six-stop "strategic" perch (horizontal top-down).

           Parked at ~58Ã‚Â° pitch (more horizontal than pure top-down) so the tank
           appears at the BOTTOM of the screen, not centered.
           
           KEY: Camera is TOTALLY STABLE - doesn't rotate with mouse OR tank heading.
           The camera follows the tank's POSITION only, staying at a fixed angle.
           Mouse only controls turret aim (via the aim line / crosshair), NOT camera.
           
           Key properties:
           - Tank sits near bottom of frame (not centered)
           - ~58Ã‚Â° angle gives horizontal top-down feel
           - Camera is STABLE - doesn't spin with mouse or tank turning
           - Mouse cursor = crosshair position (aim only, not camera)
           - Turret follows mouse instantly, gun rotation has lag (shown via glow) */
        const stops = CONFIG.CAMERA_STOPS;
        const stop = (stops && stops[this._camStage]) || { dist: 130, pitchDeg: 58 };
        const D = stop.dist;
        this.camDist = D;
        const stratPitchDeg = stop.pitchDeg || 58;
        // At 58Ã‚Â°, the height is less than at 60Ã‚Â° - more horizontal view
        const stratH = D * Math.tan(stratPitchDeg * Math.PI / 180);
        // Use the FIXED strategic camera angle for both position and look-at
        // This ensures the camera doesn't rotate when the tank turns
        const angle = this._strategicCamAngle;
        // Camera position: at distance D from tank, at fixed angle (behind tank)
        // Camera looks at: the tank's position (or slightly ahead in fixed direction)
        // This keeps the camera completely stable - tank moves but camera angle doesn't change
        this._camTarget.set(
          t.x + Math.sin(angle) * D,
          tankY + stratH,
          t.z + Math.cos(angle) * D);
        // Look at the tank itself (or a point ahead in the FIXED camera angle direction)
        // This keeps the view stable - tank at bottom of screen, camera doesn't shift
        const lookTarget = new THREE.Vector3(
          t.x + Math.sin(angle) * D * 0.1,  // slight offset in camera direction
          tankY + 0.5,
          t.z + Math.cos(angle) * D * 0.1);
        this._stratLookTarget = lookTarget;
        camTarget = this._camTarget;
      } else {
        this._camTarget.set(
          t.x + Math.sin(angle) * (this.camDist + camHOff),
          tankY + this._getCameraHeight(this.camDist),
          t.z + Math.cos(angle) * (this.camDist + camHOff));
        camTarget = this._camTarget;
      }
      /* Never below the arena floor Ã¢â‚¬â€ see _clampCameraTarget. */
      this._clampCameraTarget(camTarget);
      // Never let the camera cross a border wall (keeps walls out of view)
      if(this.cameraMode !== 'dynamic'){
        const camLim = (this.world && this.world.half || 75) - 8;
        camTarget.x = Math.max(-camLim, Math.min(camLim, camTarget.x));
        camTarget.z = Math.max(-camLim, Math.min(camLim, camTarget.z));
      }
      if(this.cameraMode === 'dynamic'){
        this.camera.position.copy(camTarget);
        t.turretGroup.getWorldPosition(this._turretWp);
        /* The look target is clamped too, not just the position. A camera held
           at the floor but aimed at a tank 15,000 units below it would point
           straight down into the void, which is the same broken picture with a
           different cause. */
        this._turretWp.y = Math.max(this._turretWp.y, this._worldFloorY());
        this.camera.lookAt(this._turretWp.x, this._turretWp.y, this._turretWp.z);
      } else {
        /* A tank that was just recovered from 15,000 units down leaves the
           camera that far away, and a lerp would spend several seconds crawling
           back up through the terrain. Snapped once, then eased as normal. */
        if(this._snapCameraNext){
          this._snapCameraNext = false;
          this.camera.position.copy(camTarget);
        } else {
          this.camera.position.lerp(camTarget, CONFIG.CAM_LERP);
        }
        const floor = this._worldFloorY() + 1.2;
        if(this.cameraMode === 'strategic'){
          /* Strategic mode: look at the fixed look target (stable, doesn't rotate with tank)
             The look target is set above - a point slightly ahead of the tank in the FIXED
             camera angle direction, not the tank's heading. This keeps the view stable. */
          const lookTarget = this._stratLookTarget || new THREE.Vector3(t.x, tankY + 0.5, t.z);
          this.camera.lookAt(lookTarget.x, lookTarget.y, lookTarget.z);
        } else if(this.cameraMode === 'dynamic'){
          /* Dynamic mode: look at the turret position (follows where you're aiming) */
          t.turretGroup.getWorldPosition(this._turretWp);
          this._turretWp.y = Math.max(this._turretWp.y, this._worldFloorY());
          this.camera.lookAt(this._turretWp.x, this._turretWp.y, this._turretWp.z);
        } else {
          this.camera.lookAt(lookX, Math.max(tankY, floor), lookZ);
        }
      }
      if(this._shake > 0){
        // A tank going up is a heavy event, so the kick is big Ã¢â‚¬â€ but it has to
        // be OVER in about a second. The slower decay this used to run left
        // the camera juddering for two seconds, well past the respawn.
        this._shake = Math.max(0, this._shake - dt*3.0);
        const shScale = (this.settings && typeof this.settings.screenShake === 'number') ? this.settings.screenShake / 100 : 1;
        /* The displacement is in WORLD UNITS, and the camera sits ~80 units
           back and ~100 up, so half a unit of jitter was invisible no matter
           how big the shake number got. This factor is what actually makes the
           camera kick when something goes up next to you. */
        const s = this._shake * shScale * 1.7;
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
    // Update glow amount: when turret is lagging behind crosshair, the line glows
    if(this.cameraMode === 'strategic' && this.localTank && this.localTank.alive) {
      const turretAngle = this.localTank.turretAngle || 0;
      const crosshairAngle = this._crosshairAngle || turretAngle;
      // Calculate angle difference (shortest path)
      let diff = crosshairAngle - turretAngle;
      while(diff > Math.PI) diff -= Math.PI * 2;
      while(diff < -Math.PI) diff += Math.PI * 2;
      const absDiff = Math.abs(diff);
      // Glow ramps up when turret is > 0.1 rad behind, max at 0.5 rad+
      this._aimLineGlow = Math.max(0, Math.min(1, (absDiff - 0.1) / 0.4));
    } else {
      this._aimLineGlow = 0;
    }
    this._updateAimLine();

    // Visibility
    this._updateVisibility();

    // Bush transparency check (all modes with bushes)
    if(this.world && this.world.bushes && this.world.bushes.length){
      for(const t of this.tanks){
        if(t.alive && !t.dying) this._checkTDMBushes(t);
      }
    }

    // Bush billboard: stand vertical, rotate like turret to face camera
    if(this.camera){
      const camPos = this.camera.position;
      /* Reuse one combined list instead of allocating a fresh concat of every
         bush in the level, sixty times a second. On a detailed GLB map that is
         hundreds of entries copied per frame for nothing, which is steady
         garbage-generation and therefore a steady source of GC pauses.
         Rebuilt only when either source array changes identity or length. */
      const tdmB = this._tdmBushes || [];
      const glbB = (this.world && this.world._glbBushes) || [];
      if(!this._billboardList
         || this._bbTdm !== tdmB || this._bbTdmLen !== tdmB.length
         || this._bbGlb !== glbB || this._bbGlbLen !== glbB.length){
        this._billboardList = tdmB.concat(glbB);
        this._bbTdm = tdmB; this._bbTdmLen = tdmB.length;
        this._bbGlb = glbB; this._bbGlbLen = glbB.length;
      }
      const allBushes = this._billboardList;
      for(const b of allBushes){
        if(!b.mesh && !b.obj) continue;
        /* NOBILLBOARD: the taiga cross-shrubs are real 3D and stand on their
           own; the wind writes their rotation in the foliage loop below. A
           billboard rotation here would overwrite that every frame. Flat
           cutout bushes (no noBillboard flag) still spin to face the camera. */
        if(b.noBillboard) continue;
        const bx = b.x, bz = b.z;
        const dx = camPos.x - bx;
        const dy = camPos.y - 1;
        const dz = camPos.z - bz;
        const hAngle = Math.atan2(dx, dz);
        const flip = b.flipped ? Math.PI : 0;
        let tiltUp = 0;
        if(dy > 1){
          const hDist = Math.sqrt(dx*dx + dz*dz);
          const vAngle = Math.atan2(dy, hDist);
          tiltUp = Math.min(vAngle, 10 * Math.PI / 180);
        }
        const target = b.mesh || b.obj;
        if(target){
          target.rotation.order = 'YXZ';
          target.rotation.set(0, 0, 0);
          target.rotation.y = hAngle + flip;
          target.rotation.x = -Math.PI / 2 + tiltUp;
        }
      }
    }

    /* FOLIAGE: WIND, AND A SHAKE WHEN SOMEBODY DRIVES INTO IT.
     -----------------------------------------------------------------------
     Trees and bushes are `pine` and `taiga` nodes in the map (see the naming
     convention in world.js). Both are marked noPhysics, so a tank passes through
     them, and both move here:

       * CONTACT Ã¢â‚¬â€ a tank that is actually ROLLING and touching a tree rattles
         it. Bumping one while stationary leaves it alone, otherwise a parked
         tank would keep a tree wobbling forever.

       * It checks EVERY tank, not just the local one. It used to check only
         `localTank`, which meant that on the host an opponent drove straight
         through a tree and nothing happened, while on that opponent's own screen
         the same tree shook. One tank, two different worlds. Each client now
         tests the tanks it knows about, which agree closely enough because the
         remote positions arrive interpolated.

       * WIND Ã¢â‚¬â€ an idle sway on every tier, `default` included. It is two
         rotation writes per tree on a loop that already runs on every tier for
         the contact test, so it costs nothing to keep it everywhere. Skipped
         while a tree is shaking, so the two motions never fight each other.

       * ONE LIST, TWO SOURCES Ã¢â‚¬â€ pines AND the noBillboard GLB bushes (the
         taiga scrub), merged because wind is the same act on both. The flat
         cutout bushes are NOT in it: the billboard pass above owns their
         rotation entirely, and a wind write underneath would be overwritten
         by or fight that rotation. The merge is cached and rebuilt only when
         either source list changes, the same technique the billboard list
         above already uses Ã¢â‚¬â€ rebuilding a concat of the whole forest sixty
         times a second is steady garbage with no visual change. */
    const gPines = this.world ? (this.world._glbPines || []) : [];
    const gBushes = this.world ? (this.world._glbBushes || []) : [];
    if(!this._windFoliage
       || this._wfPineSrc !== gPines || this._wfPineLen !== gPines.length
       || this._wfBushSrc !== gBushes || this._wfBushLen !== gBushes.length){
      const _uprightBushes = [];
      for(let i = 0; i < gBushes.length; i++){
        const b = gBushes[i];
        if(b.obj && b.noBillboard) _uprightBushes.push(b);
      }
      this._windFoliage = gPines.concat(_uprightBushes);
      this._wfPineSrc = gPines; this._wfPineLen = gPines.length;
      this._wfBushSrc = gBushes; this._wfBushLen = gBushes.length;
    }
    const foliage = this._windFoliage;
    if(foliage && foliage.length){

      /* HOW STRONG THE WIND IS, AND WHY IT WAS INVISIBLE BEFORE.

         These were 0.022 (ultra) and 0.013 (fancy) radians -- 1.26 and 0.75
         degrees -- and `default` had none at all.

         The wind is a rigid rotation of the whole tree about its base, so what
         reaches the screen is the TIP moving height * sin(angle). Trees on the
         GLB maps stand about 18 units tall, so at 0.022 rad the crown shifted
         roughly 0.4 units -- a couple of pixels at fighting distance. Both tiers
         were below the threshold of seeing it at all, which is the whole of the
         "make the wind stronger" report: there was nothing to strengthen.

         The frequencies were slow for the same reason. 0.55 rad/s is an 11-second
         period -- a pendulum, not a breeze. They now sit near a 7s period, which
         is a slow gust rather than a swing.

         Peak amplitude is windAmp * 1.28 (the two harmonics below sum to a
         little over 1), so 0.075 here peaks near 0.096 rad, 5.5 degrees, moving
         an 18-unit tree's crown about 1.8 units. Enough to read as moving air;
         far short of the 0.35 rad at which a tree looks like it is falling
         over. */
      const windAmp  = this.isUltra ? 0.075 : (this.isFancy ? 0.045 : 0.028);
      const windFreq = this.isUltra ? 0.85 : (this.isFancy ? 0.70 : 0.55);

      /* `default` GETS WIND NOW.

         The old comment here said wind was skipped on `default` because it is "a
         per-frame rotation on every tree in the level, which is exactly the kind
         of cost the lower tiers exist to avoid". That cost was never real: the
         loop below already visits every tree on every tier to test it for tank
         contact, so the traversal, the radius test and the tank scan have all
         been paid for before the wind is reached. The wind itself adds two
         rotation writes per tree and no allocation and no second pass.

         So gating it cost the default tier the entire effect and saved nothing.
         The only tier that genuinely cannot afford per-tree work is the one that
         skips the contact test too, and there is no such tier here. */
      const tanks = this.tanks;
      const now = this.time;

      for(let i = 0; i < foliage.length; i++){
        const p = foliage[i];
        const reach = p.radius + 3;

        /* --- is anything driving into it? --- */
        let shaking = false;
        for(let j = 0; j < tanks.length; j++){
          const t = tanks[j];
          /* Net-driven tanks are included on purpose: an opponent driving
             through a tree should rattle it on this screen too, exactly as it
             does on theirs. */
          if(!t || !t.alive || t.dying) continue;
          const dx = t.x - p.x, dz = t.z - p.z;
          if(dx * dx + dz * dz > reach * reach) continue;
          /* Only a tank that is actually rolling rattles the tree. */
          if(Math.abs(t.speed || 0) > 0.5 || Math.hypot(t.vx || 0, t.vz || 0) > 0.5){
            shaking = true;
            break;
          }
        }

        if(shaking){
          if(!p._shakeActive){ p._shakeActive = true; p._shakeTime = 0; }
          p._shakeTime += dt;
          const s = p._shakeTime;
          if(s < 0.6){
            const decay = 1.0 - (s / 0.6);
            p.obj.rotation.x = p._origRotX + Math.sin(s * 18) * (0.08 * decay);
            p.obj.rotation.z = p._origRotZ + Math.cos(s * 23.4) * (0.05 * decay);
          } else {
            p._shakeTime = 0;   /* keep rattling while still pushing it */
          }
          continue;
        }

        /* Contact broken: snap back rather than easing, so an idle tank never
           leaves a tree leaning. */
        if(p._shakeActive){
          p._shakeActive = false;
          p.obj.rotation.x = p._origRotX;
          p.obj.rotation.z = p._origRotZ;
          continue;
        }

        /* Wind. Phase-offset per tree from its own position so a forest does not
           sway as one block.

           TWO HARMONICS, NOT ONE. A single sine is exactly periodic, so every
           tree on the map reached its extreme lean at the same instant and then
           returned on the same schedule -- a metronome, and the reason a forest
           of them read as one rigid block even when the phase offset was
           working. The faster term on each axis is deliberately not a harmonic
           ratio of the slow one (2.3x, 3.1x rather than 2x, 3x): an irrational-
           looking ratio never quite repeats, which is what stops the eye from
           locking onto the cycle and picking out the loop.

           The two axes also run at different rates, as before, so the crown
           traces a slow open loop rather than collapsing onto a single line --
           a tree that only ever leaned left and right along one plane reads as a
           cardboard cutout. */
        {
          const ph = (p.x * 0.11) + (p.z * 0.07);
          const a  = now * windFreq + ph;
          p.obj.rotation.x = p._origRotX +
            (Math.sin(a) + Math.sin(a * 2.3) * 0.28) * windAmp;
          p.obj.rotation.z = p._origRotZ +
            (Math.cos(a * 1.37 + ph) + Math.sin(a * 3.1) * 0.22) * windAmp * 0.7;
        }
      }
    }

    /* HOW OFTEN THE HOST BROADCASTS.

   20 Hz was chosen without measuring it, and it was too high. Every snapshot
   is a JSON.parse plus a per-tank apply on each client, and the client was
   spending a quarter of its frame budget on it Ã¢â‚¬â€ measured at 36 fps on the
   client against 59 on the host, with the host doing none of that work.

   12 Hz is enough because the client does not draw snapshots, it INTERPOLATES
   between them: _netSmoothTick lerps between the last two arrivals using the
   wall clock, so a tank still moves smoothly at 60 fps from 12 updates a second.
   Anything below ~10 starts to look stepped; above 15 is wasted bandwidth and
   wasted main thread on the machines that can least afford it. */
    const SNAPSHOT_INTERVAL = 0.0833;   /* ~12Hz */

    /* The snapshot also carries the countdown, so the two sides cannot disagree
       about when the battle starts Ã¢â‚¬â€ see _netSnapshotCountdown(). */
    if(this.mode==='host'){
      /* When every human peer has a LIVE direct WebRTC channel, send at 20Hz.

         12Hz is the relay rate, tuned for what a shared WebSocket plus each
         client's JSON.parse can afford. A direct link has neither of those
         constraints Ã¢â‚¬â€ the bytes go peer-to-peer in one hop Ã¢â‚¬â€ and 20Hz cuts the
         remote tank's visible delay by a third with no added relay traffic. The
         rate only rises when EVERY connected peer is on the fast path; one
         straggler on the relay drops the match back to 12Hz so nobody's socket
         carries a stream it was not sized for. */
      let snapInterval = SNAPSHOT_INTERVAL;
      try {
        /* 20 HZ IS A PROPERTY OF THE WIRE, NOT OF A SETTING.

           The old condition demanded the P2P flag AND a fully-run p2p-id
           exchange Ã¢â‚¬â€ which nothing ever dispatched (see net.js _handle), so
           the rate never lifted and every match rode the relay cadence no
           matter how good the direct link actually was. What the rate really
           needs to know is simply: is every other player reachable without
           the server hop? A live WebRTC channel keyed by the server id is
           exactly that answer. `Net.conns` holds every socket-known client;
           if each of them has an open channel, the relay copy skips them all
           and the match can afford the higher rate. One straggler on the
           socket drops everyone back to the relay rate so that nobody's
           socket carries a stream it was not sized for. */
        const peers = (typeof Net.conns === 'object' && Net.conns) ? Object.keys(Net.conns) : [];
        if(peers.length > 0 && typeof Rtc !== 'undefined' && Rtc.isOpen &&
           peers.every(id => Rtc.isOpen(id))){
          snapInterval = 0.05;   /* ~20Hz over the direct link */
        }
      } catch(e){ /* keep the normal rate */ }
      this._netSendAcc += dt;
      if(this._netSendAcc > snapInterval){
        this._netSendAcc = 0;
        /* ONE BROADCAST PATH, ALWAYS.

           The fast-path `Net.broadcastP2P(...)` branch sent snapshots into a
           keyed-empty deliver system whenever the uuid exchange had not run
           (it never ran), which is the bug that made matches freeze solid
           while its own HUD said everything was fine. Net.broadcast already
           tries every live direct channel first and then ships one relay
           copy whose `rtc` list names the reached peers Ã¢â‚¬â€ the fast path with
           none of the ways to stop playing. Keep everything on it. */
        Net.broadcast({
          time: this.time,
          glad: this.glad ? this._gladSnapshot() : null,
          bases: this._baseDefendMode ? BaseDefend.snapshot() : null,
          tanks: this.tanks.map(t => t.snapshot()),
          projs: this._projectileSnapshot(),
          cd: this._netSnapshotCountdown(),
        });
        if(window.__PLATOON_BATTLE){
          window.__PLATOON_BATTLE.score = this.tanks.filter(t=>!t.isDummy).map(t=>({name:t.name||'Player', kills:t.kills||0, dd:Math.round(t.damageDealt||0)}));
        }
      }
    } else if(this.mode==='freeroam' && NakamaNet.isHost){
      this._netSendAcc += dt;
      if(this._netSendAcc > SNAPSHOT_INTERVAL){
        this._netSendAcc = 0;
        NakamaNet.sendMatchData({t: 'state', s: {time:this.time, tanks:this.tanks.map(t=>t.snapshot()), projs:this._projectileSnapshot()}});
      }
    }

    // HUD
    this._updateHUD(dt);
    } catch(e){
      /* _update swallows its own exceptions on purpose: one bad frame must not
         take the match down, and the frame keeps drawing either way.

         But it used to say so ONCE PER FRAME. On a persistent fault that is
         sixty console writes a second, and console output is not free -- writing
         it is itself main-thread time, so a "harmless" warning loop is one of
         the few ways a caught exception can still make the game stutter. And it
         told the freeze watchdog nothing, so the next load had no label to show.

         Five detailed reports, then one every couple of seconds; the mark fires
         on the first, so a fault here is named on the next load instead of
         guessed at. */
      this._updateBodyErrs = (this._updateBodyErrs || 0) + 1;
      if(this._updateBodyErrs <= 5 || (this._updateBodyErrs % 120) === 0){
        console.warn('Update error (' + this._updateBodyErrs + '):', e);
        if(this._updateBodyErrs === 1){
          try { if(window.__mtlMark) window.__mtlMark('battle:update-error'); } catch(e2){}
        }
      }
    }
  }

  /* ============================================================================
   MAP OUTLINES

   Outlines EVERY other piece of geometry in the world Ã¢â‚¬â€ terrain, walls, rocks,
   cover, scenery, the loaded map models Ã¢â‚¬â€ using the same inverted-hull
   technique as the tanks, so the whole map can be read at once. This is a
   level-designer's view: most of the invisible geometry in a tank map is
   SUPPOSED to be invisible, and you cannot tell a wall from a painted
   backdrop until you drive into it.

   The map's hulls are much thinner than the tanks' (see OUTLINE_MAP vs
   OUTLINE_TANK), because the map is context and the tanks are what the eye
   has to find first. Both are dynamic: the width is a live shader uniform, so
   it can change with camera distance without rebuilding anything.

   The geometry is SHARED with the mesh it outlines, so a map outline costs no
   duplicate vertex memory Ã¢â‚¬â€ the price is one extra draw per outlined mesh.

   Built LAZILY on the first press and cached, so an ordinary match pays
   nothing. Capped, and anything over the cap is reported, never hidden.
   ============================================================================ */
  _toggleMapOutlines(silent){
    try {
      if(typeof Tank === 'undefined' || !Tank.createOutlineMesh){
        console.warn('[map-outlines] Tank.createOutlineMesh missing');
        return;
      }
      /* Ctrl+M still works for level building; everything else that used to
         build outlines (load hooks, the self-healing loop) is gone, so this is
         only ever reached from the manual toggle.

         Turning the debug view OFF must CLEAR what it drew. Returning early
         instead would leave the hulls on screen with nothing left to rebuild
         or remove them, which is the worst of both. */
      if(!MAP_OUTLINES_ENABLED && !this._mapOutlineDebug){
        this._clearMapOutlines();
        if(!silent && window.Menu && Menu.toast) Menu.toast('Map outlines off');
        return;
      }

      /* ALWAYS a fresh rebuild, never a blind toggle.
         The map streams in after the battle has already started, so a build
         done during the first seconds of a match sees the old ground and none
         of the map that arrived a moment later Ã¢â‚¬â€ and a ground hull expands
         downward, hidden by the ground itself, which reads as "the outlines
         don't work". Rebuilding every press means the second press always
         outlines whatever is actually in the world right now. */
      this._clearMapOutlines();

      /* The tanks move and carry their own, wider outline. */
      const inTank = new Set();
      if(this.tanks) for(const t of this.tanks){
        if(!t.root) continue;
        t.root.traverse(o => inTank.add(o));
      }
      const skip = skipMapOutline;
      if(this.tanks) for(const t of this.tanks){
        if(!t.root) continue;
        t.root.traverse(o => inTank.add(o));
      }

      const CAP = 2200;
      const list = [];
      let meshes = 0, skipped = 0;
      this.scene.traverse((o) => {
        if(!o.isMesh || !o.visible) return;
        if(inTank.has(o)) return;
        const u = o.userData || (o.userData = {});
        if(u.isOutline || u.isSpray || u.noOutline) return;
        if(skip && skip(o, this)) return;
        if(meshes >= CAP){ skipped++; return; }

        let outline = null;
        try { outline = Tank.createOutlineMesh(o, OUTLINE_MAP_WIDTH); } catch(e){ return; }
        if(!outline) return;
        outline.position.set(0, 0, 0);
        outline.rotation.set(0, 0, 0);
        outline.scale.set(1, 1, 1);
        outline.userData.mapOutline = true;
        outline.visible = true;
        o.add(outline);
        list.push(outline);
        meshes++;
      });

      this._mapOutlineList = list;
      /* Materials are POOLED now (Tank._outlineMaterial), so clearing outlines
         must NOT dispose them Ã¢â‚¬â€ they belong to every tank as well, and
         disposing here blanked the tanks' outlines. Only the meshes go. */
      const skinned = this._outlineSkinnedMeshes();
      const msg = 'Map outlines: ' + meshes + ' meshes' +
                  (skinned ? ' + ' + skinned + ' skinned' : '') +
                  (skipped ? ' (' + skipped + ' over cap)' : '');
      console.log('[map-outlines] ' + msg);
      /* Silent while the loop is auto-maintaining it Ã¢â‚¬â€ otherwise a toast would
         pop every time a tank respawned changed the mesh count. */
      if(!silent && window.Menu && Menu.toast) Menu.toast(msg);
    } catch(e){
      console.warn('[map-outlines] failed:', e);
    }
  }

  /* Drop every map outline we added, so the next build starts from the real
     scene rather than from its own leftovers. */
  _clearMapOutlines(){
    const list = this._mapOutlineList;
    if(list){
      for(let i=0;i<list.length;i++){
        const o = list[i];
        try { if(o.parent) o.parent.remove(o); } catch(e){}
      }
    }
    /* Also sweep for any orphan from a build whose list was lost Ã¢â‚¬â€ otherwise
       repeated rebuilds stack a second hull on the same mesh. */
    this.scene.traverse((o) => {
      if(!o.userData || !o.userData.mapOutline) return;
      try { if(o.parent) o.parent.remove(o); } catch(e){}
    });
    this._mapOutlineList = null;
  }

  /* RETAINED, NO LONGER CALLED FROM THE FRAME LOOP.

     This self-healing scheme watched a cheap signature of the scene and rebuilt
     the hulls whenever the world changed underneath them. It was needed only
     because the outlines were ON BY DEFAULT. With MAP_OUTLINES_ENABLED false it
     is dead weight, so nothing in _loop calls it any more Ã¢â‚¬â€ the only caller is
     the Ctrl+M debug toggle.

     Kept because the debug view still wants it: it is the only thing that makes
     Ctrl+M correct when the map streams in after the toggle.

     The original note follows.
     -- Map outlines are ON BY DEFAULT, and SELF-HEALING.

     They used to depend on hooking load events, which is fragile: the map GLB,
     the scenery pack, the spawn props and the arena reset all happen at
     different times, so a build could run before the map arrived, or be
     cleared by a reset immediately after. Hooking every one of those is a
     losing game.

     Instead the loop watches a cheap signature Ã¢â‚¬â€ the number of meshes in the
     world Ã¢â‚¬â€ and rebuilds only when that number changes. It cannot miss a map
     that arrives late, cannot be undone by a reset, and costs one integer
     comparison on most frames. */
  _ensureMapOutlines(){
    this._mapOutlineCheck = (this._mapOutlineCheck || 0) + 1;
    if(this._mapOutlineCheck % 15 !== 0) return;
    let meshes = 0;
    for(const o of this.scene.children){ if(o) meshes++; }
    let deep = 0;
    this.scene.traverseVisible(() => { deep++; });
    const sig = meshes * 1000003 + deep;
    if(sig === this._mapOutlineSig) return;
    this._mapOutlineSig = sig;
    try { this._toggleMapOutlines(true); } catch(e){}
  }

  _refreshMapOutlines(){
    try { this._toggleMapOutlines(true); } catch(e){}
  }

  /* Skinned models cannot be hulled cleanly Ã¢â‚¬â€ their vertices move on the GPU,
     so a hull would tear. They were simply skipped, which is why a tank like
     Cool Buddy appeared to have no outline at all. Give them one by baking a
     static copy of the mesh in its rest pose and hulling THAT: it is not
     animated, but it is always exactly where the tank is, which is all a
     silhouette needs. */
  _outlineSkinnedMeshes(){
    let added = 0;
    if(!this.tanks) return 0;
    for(const t of this.tanks){
      if(!t.root) continue;
      t.root.traverse((o) => {
        if(!o.isSkinnedMesh || o.userData.isOutline) return;
        try {
          o.updateWorldMatrix(true, false);
          const baked = new THREE.Mesh(o.geometry, o.material);
          /* Drawn by the outline shader, so the material is irrelevant beyond
             keeping three's shader path happy; it is overwritten below. */
          const outline = Tank.createOutlineMesh(baked, OUTLINE_TANK);
          if(!outline) return;
          /* Parent to the SKINNED mesh itself with an identity transform, and
             keep the bind pose: the hull is a silhouette in the tank's own
             frame, so it moves with the model as it turns and drives. */
          outline.geometry = o.geometry;
          outline.position.set(0, 0, 0);
          outline.rotation.set(0, 0, 0);
          /* NOT identity. The authored model carries its scale on this mesh, and
             the outline shader pushes in local space -- leaving it at 1 inflated
             the hull by that whole factor. This is the same compensation every
             other outline gets; see Tank.compensateOutlineScale. */
          Tank.compensateOutlineScale(outline, o);
          outline.renderOrder = -1;
          outline.castShadow = false;
          outline.receiveShadow = false;
          outline.userData.isOutline = true;
          outline.userData.skinnedProxy = true;
          o.add(outline);
          added++;
        } catch(e){}
      });
    }
    return added;
  }

  /* A shell close enough to be a real threat makes its victim re-think right
   now, rather than waiting out the rest of its throttle phase. This is plain
   arithmetic over the projectile list Ã¢â‚¬â€ no raycast, no physics Ã¢â‚¬â€ so it is
   cheap enough to run for every bot every frame. */
  _shellNear(t){
    const ps = this.projectiles;
    if(!ps || !ps.length) return false;
    for(let i=0;i<ps.length;i++){
      const p = ps[i];
      if(!p || p.dead || p.owner === t) continue;
      const dx = p.x - t.x, dz = p.z - t.z;
      if(dx*dx + dz*dz < 400) return true;      /* within 20 units */
    }
    return false;
  }

  /* ============================================================================
     ARTILLERY AIM SOLUTION

     ONE function solves the arc, and the aim line and the firing code both ask
     it. That is the entire trick: if the curve shown to the player were
     computed separately from the shell's own flight, the two would drift apart
     and the weapon would stop being aimable Ã¢â‚¬â€ a mortar you cannot range is
     just a tank that throws rocks. Both sides call this, both get the identical
     velocity vector, both agree by construction.

     Returns null for anything that is not an artillery piece, so callers can
     ask unconditionally.

       vel      THREE.Vector3 launch velocity, world units per second
       dir      THREE.Vector3 the flat ground direction it travels in
       dist     horizontal distance to the impact point, metres
       point    {x, z} where it lands
       flight   seconds of flight
       gravity  world units per second squared
       blocked  true when the aim point is inside artilleryMinRange and the gun
                physically cannot take the shot
       minRange, splashRadius   passed through for the marker to draw

     `pos` is the muzzle position to solve from, and it is OPTIONAL. Solving the
     vertical component needs the muzzle height, and Tank.muzzle() forces a full
     world-matrix update of the model Ã¢â‚¬â€ free once per aim redraw, far too
     expensive for every tank on every frame. The per-frame range gate only ever
     reads `blocked`, which does not depend on height at all, so approximating
     it there costs nothing and keeps the drawn arc and the flown arc solved
     from the same real muzzle.

     EVERYTHING IS MEASURED FROM THE MUZZLE, NEVER FROM t.x / t.z. The shell
     launches from the barrel tip, which on this tank sits five metres ahead of
     the hull origin, so ranging from the hull made every single shot overshoot
     by exactly that offset Ã¢â‚¬â€ a mortar that cannot hit what its own reticle is
     drawn on. */
  _mortarAim(t, pos){
    if(!t || !t.def || t.def.shellType !== 'mortar') return null;
    const d = t.def;
    const ox = pos ? pos.x : t.x;          /* origin of the arc: the muzzle */
    const oz = pos ? pos.z : t.z;

    /* WHICH WAY. The turret, exactly as for every other tank.

       This used to read the direction off the cursor as well, and the cursor's
       distance became the range too. That coupled the shot to a pointer that
       pointer lock hides, which is the whole reason the aim felt broken: the
       camera stopped tracking the gun because the gun was no longer tracking
       the camera's axis. Now the heading is the barrel's, and only the range is
       separate.

       The default is MAXIMUM reach: artillery that has to be wound up from zero
       every time is not a weapon, it is a puzzle, and a new player has no way
       to know the scale. */
    let want = d.shellRange;
    let heading = t.turretAngle;
    if(t.isLocal && this.input && this.input.mouse && t.barrelEnd){
      /* Dynamic mode already advanced this from mouse-Y in the input block. In
         the pointer-aimed modes the cursor is visible and picking its own spot
         reads as the same gesture every other tank uses, so the distance to
         that spot is the range. */
      if(this.cameraMode !== 'dynamic'){
        const p = this._mortarCursorAim(t, ox, oz);
        if(p) want = Math.hypot(p.x - ox, p.z - oz);
      } else if(this._mortarRange != null){
        want = this._mortarRange;
      }
    } else if(t.brain && t.brain._curTarget && t.brain._curTarget.alive){
      /* A bot has no cursor, so it ranges at its TARGET rather than at maximum.
         The obvious default Ã¢â‚¬â€ always fire the longest shot Ã¢â‚¬â€ puts every bot shell
         in the next county, and a bot that does that every ten seconds is just
         noise on the map rather than a threat. */
      want = Math.hypot(t.brain._curTarget.x - ox, t.brain._curTarget.z - oz);
    }
    /* A tank with its nose against a wall has no ground point in front of it at
       all; the maximum-range default above covers that.

     A bot whose target has closed inside the minimum range is left BLOCKED,
     same as a player. It will not lob a shell at a target 10m away that lands
     22m away and hits nothing Ã¢â‚¬â€ holding fire and manoeuvring is the honest
     outcome, and the bot's own approach behaviour is what should break the
     stalemate. */

    const minR = d.artilleryMinRange || 0;
    const blocked = want < minR;
    let dist = Math.max(minR, Math.min(want, d.shellRange));

    /* Keep the impact INSIDE the arena. Without this a long shot at a map edge
       bursts in the void, where nothing can see it and nothing can be caught by
       it Ã¢â‚¬â€ which reads to the player as the shell simply evaporating. */
    const half = (this.world && this.world.half) || CONFIG.WORLD_SIZE;
    const lim = half * 0.94;
    let px = ox + Math.sin(heading) * dist;
    let pz = oz + Math.cos(heading) * dist;
    px = Math.max(-lim, Math.min(lim, px));
    pz = Math.max(-lim, Math.min(lim, pz));

    /* Clamping the point changes BOTH the distance and the direction, so both
       are re-read from the clamped result. Solving the arc for the old distance
       along the new heading would draw one curve and fly another. */
    const dl = Math.hypot(px - ox, pz - oz);
    const nfx = dl > 1e-4 ? (px - ox) / dl : Math.sin(heading);
    const nfz = dl > 1e-4 ? (pz - oz) / dl : Math.cos(heading);
    dist = Math.max(4, dl);

    const flight = d.artilleryFlight || 1.9;
    const gravity = d.artilleryGravity || MORTAR_GRAVITY;
    /* dropY is how far the shell must FALL to reach the ground plane. */
    const my = pos ? pos.y : (CONFIG.TANK_Y + (d.body.h || 1) + (d.turret.h || 1));
    const vel = artilleryVelocity(nfx, nfz, dist, flight, gravity, -my);

    /* THE BARREL RAISES WITH THE SHOT.

       A gun that stays dead flat while a shell describes a fifty metre arc over
       a wall reads as broken, so the arm is tilted up by an amount that tracks
       the distance: level at minimum range, 32 degrees flat out at maximum.

       Deliberately linear in RANGE rather than derived from the real launch
       angle. The launch angle is the honest number, but it climbs steeply and
       then crowds together near maximum range, where a huge change in angle buys
       a tiny change in distance, so the barrel would barely move across the
       whole middle of the band and then kick at the end. Mapping the distance
       itself gives a steady, visible response to every mouse movement, which is
       what "depends on distance" is asking for. The 32 degree cap is re-applied
       in Tank._updateGunAssembly so nothing that reaches the model exceeds it. */
    /* ONLY THE CALL ANCHORED TO THE REAL MUZZLE MAY DRIVE THE GUN.

       _mortarAim has three callers. The third, Tank's min-range fire gate, is
       deliberately called with NO position because it only wants `blocked`, and
       as its own comment says, "the muzzle is a full world-matrix update away".
       That call therefore measures from the tank's CENTRE rather than the muzzle
       and lands a few metres off.

       Left unguarded it rewrote the elevation from the wrong origin every frame,
       on top of the muzzle-anchored value, and which one won depended on whether
       the tank update or the aim-line update ran last that frame. The visible
       barrel has to follow the curve the aim line draws, so the write is gated on
       a muzzle actually being supplied Ã¢â‚¬â€ which is exactly the two callers that
       have one. */
    if(pos){
      const span = Math.max(1, (d.shellRange || 115) - minR);
      const u = Math.max(0, Math.min(1, (dist - minR) / span));
      t.gunElevTarget = 32 * u;
    }
    return {
      vel,
      dir: new THREE.Vector3(nfx, 0, nfz),
      dist, point: {x:px, z:pz}, flight, gravity, blocked,
      minRange: minR, splashRadius: d.splashRadius || 12,
    };
  }

  /* WALK THE SHELL OUT AND BACK ON MOUSE-Y.

       Returns the next range in metres for the local artillery piece. This is
       the one axis the mortar owns that other tanks do not, and it is
       deliberately a SCALAR rather than a picked ground point: the turret owns
       the direction, so the two cannot disagree about where the shot goes, and
       the number survives the cursor being hidden by pointer lock.

       Aiming starts at MAXIMUM reach on purpose -- see the note in _mortarAim --
       and this only ever moves from there.

       THE SIGN IS INVERTED DELIBERATELY. `movementY` grows as the mouse is
       pushed DOWN, so feeding it in raw would pull the target toward the tank
       when the player pushes the mouse away from themselves. Negating it means
       "push the mouse forward, throw the shot further" everywhere, which is the
       gesture every artillery control in every game uses.

       The travel is expressed as a fraction of the band per screen-height of
       travel rather than as metres-per-pixel, so the whole usable range is one
       comfortable sweep on any resolution, and the clamp means no amount of
       scrolling can escape the gun's real limits. */
  _advanceMortarRange(cur, deltaPx){
    const t = this.localTank;
    if(!t || !t.def || t.def.shellType !== 'mortar' || !deltaPx) return cur;
    const d = t.def;
    const minR = d.artilleryMinRange || 0;
    const maxR = d.shellRange || 115;
    /* 900px is roughly a full sweep of a typical screen. */
    const perPx = (maxR - minR) / 900;
    let r = (cur == null ? maxR : cur) - deltaPx * perPx;
    r = Math.max(minR, Math.min(maxR, r));
    return r;
  }

  /* WHERE THE POINTER IS POINTING.

     Called by _mortarAim for the RANGE, and only in the pointer-aimed camera
     modes. The HEADING is deliberately not taken from here: the turret owns the
     direction now, which is what lets the mortar behave like every other tank
     (mouse-X turns it, right mouse freezes it, the camera follows it) and what
     let pointer lock go back to normal.

     Returns the aim point in world space, or null when there is no cursor.

     The caller passes the origin it will shoot FROM, because that origin is
     what the distance gets measured from: _mortarAim fires from the muzzle,
     which on this tank sits five metres ahead of the hull origin, so measuring
     from the hull made every shot read long by exactly that offset. */
  _mortarCursorAim(t, ox, oz){
    if(!t || !t.isLocal || !this.input || !this.input.mouse) return null;
    const gp = this._groundPoint(this.input.mouse.ndcX, this.input.mouse.ndcY);
    if(!gp) return null;
    if(ox === undefined || ox === null){ ox = t.x; oz = t.z; }

    /* THE BOTTOM OF THE SCREEN IS BEHIND THE TANK.

       The chase camera sits behind and above, looking forward and down, so the
       ground a pick lands on below the tank is ground the tank has its back to.
       Taking that bearing literally spins the mortar around and fires off the
       bottom of the screen, behind the camera where the shell can never be
       seen. Measured: the entire lower half of the screen picks up ground at
       exactly 180 degrees to the barrel.

       TWO CORRECTIONS, BECAUSE THE TWO NUMBERS WANT OPPOSITE THINGS.

       HEADING folds that half forward over the camera's axis Ã¢â‚¬â€ a reflection,
       not a clamp. The shot keeps facing the playfield, the sideways component
       of the cursor survives so left and right still steer, and because a
       reflection's own terms vanish at the fold the heading is continuous as
       the cursor crosses the tank instead of snapping 180 degrees.

       RANGE deliberately does NOT fold. Distance from the tank is V-shaped: it
       bottoms out where the pick passes over the tank and then grows again on
       the far side, so folding the distance too would make dragging DOWN push
       the shot further away Ã¢â‚¬â€ the aim visibly moving against the hand. Taking
       the along-axis part only from the forward side keeps range monotone.
       Drag up from the tank and the shot lengthens; drag down and it stops at
       minimum range, which is the honest answer for ground the tank cannot
       shoot at anyway. That clamp is continuous as well, so nothing jumps. */
    let rx = gp.x - ox, rz = gp.z - oz;

    /* camAngle points from the tank TO the camera, so the direction into the
       screen Ã¢â‚¬â€ the axis worth folding about Ã¢â‚¬â€ is camAngle + PI. Worth being
       explicit about: camAngle comes from mouse movement only, never from the
       aim being computed here, so feeding its result back into the turret
       cannot start a feedback loop. */
    const axis = (this.camAngle || 0) + Math.PI;
    const ax = Math.sin(axis), az = Math.cos(axis);
    const along = rx * ax + rz * az;

    let hx = rx, hz = rz;
    if(along < 0){ hx -= 2 * along * ax; hz -= 2 * along * az; }

    /* lateral is everything that is NOT along the axis, and it counts either
       way Ã¢â‚¬â€ a low cursor off to one side should still steer the aim sideways. */
    const lx = rx - along * ax, lz = rz - along * az;
    const range = Math.hypot(Math.max(along, 0), Math.hypot(lx, lz));

    /* Exact zero happens only when the pick sits on the tank itself, where
       atan2 would answer a meaningless 0 Ã¢â‚¬â€ aim along the view instead. */
    const hl = Math.hypot(hx, hz);
    const ux = hl > 1e-4 ? hx / hl : ax;
    const uz = hl > 1e-4 ? hz / hl : az;

    return { x: ox + ux * range, z: oz + uz * range };
  }

  /* The impact marker: a ground ring at the BLAST radius drawn on the exact
     spot the shell will land, plus a crosshair on the point itself. Built once
     and moved Ã¢â‚¬â€ it is repositioned every time the aim changes, and allocating
     geometry per frame is how the aim line used to cost a measured 0.8ms. */
_initMortarMarker(){
    if(this._mortarRing) return;
    const g = new THREE.Group();

    /* ============================================================================
       THE MAXIMUM-RANGE CIRCLE

       This is the single most useful thing an artillery piece can draw. Brawl
       Stars, artillery RTS games and every tank game's grenade arc all show the
       limit of the weapon as a ring on the ground, because the question a
       player actually has is never "which way is it pointing" -- it is "can I
       possibly reach that from here". Answering it visually means nobody has to
       move the tank to find out.

       DRAWN AS A LINE, NOT A FILLED DISC, deliberately. A disc would cover the
       whole playable area in a colour the player is meant to read as danger,
       and it would hide the terrain underneath -- which is what they need to see
       to decide whether moving is worth it. A hairline at exactly the maximum
       radius states the limit and leaves the ground legible.

       TWO RINGS, BOTH HAIRLINES. The outer one is maximum reach, drawn white.
       The inner one is artilleryMinRange -- the dead zone the gun physically
       cannot lob into, which is the other half of the same question ("can I
       hit it if I get closer?") and was previously only discoverable by
       discovering it. It is orange, and only appears once it is far enough out
       to be a ring rather than a blob under the tank.
    ============================================================================ */
    const circleMat = (color, opacity) => new THREE.MeshBasicMaterial({
      color, transparent:true, opacity, side:THREE.DoubleSide,
      depthWrite:false, toneMapped:false
    });
    /* DASHED, AND BUILT AS REAL QUADS RATHER THAN A LineLoop.

       A LineLoop is the obvious way to draw a dashed circle and it is wrong twice
       over here. First, WebGL ignores `linewidth`, so every line is exactly one
       pixel wide however it is asked -- a range circle one pixel thick disappears
       against terrain and over grass. Second, a dashed LINE needs per-vertex
       distances and a LineDashedMaterial, and at a 115m radius seen from a chase
       camera the gaps end up a few pixels wide, which reads as noise rather than
       as a measured boundary.

       So the dashes are quads: one mesh, one draw call, real width, and a gap
       sized in METRES rather than in pixels, which means the dash pattern stays
       proportional to the circle instead of turning into a solid ring when the
       camera pulls back. This is the same reason the artillery range circle is
       drawn the way Brawl Stars and artillery RTS games draw theirs -- a broken
       line reads as "a measurement", a solid one reads as "part of the level".

       BUILT IN METRES, NOT NORMALISED UNITS, and that is the whole reason the two
       rings are not parented to one scaled group. Scaled by 0.19 to put the dead
       zone at 22m, a band whose width was authored as a fraction of the outer
       radius shrank by that same 0.19 -- five centimetres of line, i.e. no line at
       all. Each ring owns its own geometry and its own radius, and the cache in
       _updateMortarRangeRings rebuilds only when a radius actually changes. */
    const bandMesh = (color, opacity) => new THREE.Mesh(new THREE.BufferGeometry(), circleMat(color, opacity));
    const maxRing = bandMesh(0xffffff, 0.55);
    const minRing = bandMesh(0xff9020, 0.42);
    maxRing.rotation.x = -Math.PI / 2;
    minRing.rotation.x = -Math.PI / 2;
    /* 1.6m of line reads as a crisp outline at any range in this game, and 1.4m
       of orange does the same job for the dead zone without competing. */
    maxRing.userData.halfWidth = 0.8;
    minRing.userData.halfWidth = 0.7;
    this._mortarRangeMaxRing = maxRing;
    this._mortarRangeMinRing = minRing;
    this._mortarRangeCache = { max: -1, min: -1 };

    const rangeGroup = new THREE.Group();
    rangeGroup.add(maxRing);
    rangeGroup.add(minRing);
    rangeGroup.position.y = 0.05;
    rangeGroup.visible = false;
    /* Under the splash ring (997) and the cross (999) so those always win where
       they overlap, but over the terrain so it is not z-fighting the ground. */
    rangeGroup.renderOrder = 996;
    this.scene.add(rangeGroup);
    this._mortarRangeRings = rangeGroup;

    /* THE BLAST RING IS A GRADIENT, NOT A LINE.

       One ring drawn with per-vertex alpha: 100% opaque at the outer edge,
       falling away across the inner 26% of the radius, and STOPPING there.
       That stopping is the whole point of the request Ã¢â‚¬â€ a glow that hugs the rim
       and does not bleed to the middle Ã¢â‚¬â€ because a filled circle reads as
       "everything in here is lethal" when only the edge is the actual blast
       boundary. One draw call, so it costs nothing next to the stack of
       concentric rings that would otherwise be needed to fake the same falloff. */
    const RINGS = 5, INNER = 0.74;
    const ringGeo = new THREE.RingGeometry(INNER, 1.0, 128, RINGS);
    {
      const p = ringGeo.attributes.position;
      const col = new Float32Array(p.count * 4);
      for(let i = 0; i < p.count; i++){
        const r = Math.hypot(p.getX(i), p.getY(i));
        /* r is 1.0 at the rim and INNER at the inner edge. The exponent above 1
           keeps the bright part tight against the rim instead of smearing
           halfway across the splash. */
        const t = Math.max(0, Math.min(1, (r - INNER) / (1.0 - INNER)));
        col[i*4] = 1; col[i*4+1] = 1; col[i*4+2] = 1;
        col[i*4+3] = Math.pow(t, 1.6);
      }
      ringGeo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    }
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color:0xffffff, vertexColors:true, transparent:true, opacity:0.95,
      side:THREE.DoubleSide, depthWrite:false, toneMapped:false
    }));
    ring.rotation.x = -Math.PI / 2;

    /* A faint inner wash so the danger area stays legible without the glow
       reaching the middle. Deliberately far weaker than the rim. */
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.76, 64),
      new THREE.MeshBasicMaterial({color:0xff7a20, transparent:true, opacity:0.10,
        side:THREE.DoubleSide, depthWrite:false, toneMapped:false})
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.02;
    g.add(ring); g.add(disc);
    g.position.y = 0.06;
    g.visible = false;
    g.renderOrder = 997;
    this.scene.add(g);
    this._mortarRing = g;
    this._mortarRingEdge = ring;
    this._mortarRingFill = disc;

    /* THE MARK IS AN X, AND IT IS BOLD.

       Two things were wrong with the old one. It was a "+", which is the wrong
       mark for a weapon that fires over things rather than at them, and it read
       as a UI cross rather than a gunsight. And it was drawn with
       LineBasicMaterial, whose `linewidth` every browser since 2011 silently
       ignores Ã¢â‚¬â€ so asking for it to be bolder could never have worked by any
       amount of asking. These are two flat quads now, which have real width.

       depthTest is off so the spot stays visible behind a rock: with an arc this
       high, most of the shot is spent looking at something in the way. */
    const cross = new THREE.Group();
    const cm = new THREE.MeshBasicMaterial({color:0xffffff, transparent:true,
      opacity:0.95, depthTest:false, depthWrite:false, toneMapped:false,
      side:THREE.DoubleSide});
    for(let i = 0; i < 2; i++){
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cm);
      bar.rotation.x = -Math.PI / 2;      // lie flat on the ground
      /* +45 and -45, NOT 45 twice.

         Both bars were given the same angle, so they were drawn exactly on top of
         one another and what appeared was a single bar Ã¢â‚¬â€ a stick, not a cross.
         The loop index is what makes it a mark rather than a line. */
      bar.rotation.z = (i === 0) ? Math.PI / 4 : -Math.PI / 4;
      cross.add(bar);
    }
    cross.renderOrder = 999;
    cross.visible = false;
    cross.frustumCulled = false;
    this.scene.add(cross);
    this._mortarCross = cross;
    this._mortarCrossMat = cm;
    this._mortarCrossBars = cross.children;
  }

  /* PLACE THE RANGE RINGS, OR HIDE THEM.

     `t` is the local tank. The rings are drawn around the HULL, not the muzzle:
     the muzzle is five metres ahead of the hull on this tank, so rings centred
     there read as a circle the tank is standing off the edge of, and the player
     judges "am I in range" by where their own tank is.

     Follows the tank every frame rather than being baked once, because it is
     the tank that drives, and a range ring left behind at the spawn point is
     worse than no ring at all. Two vectors and a scale per frame is nothing.

     The inner dead-zone ring is scaled to artilleryMinRange/shellRange so it
     sits at the real minimum distance. It is hidden when that ratio is tiny,
     which is the case where it would render as a dot welded to the tank. */
  _updateMortarRangeRings(t){
    let rg = this._mortarRangeRings;
    if(!rg){ this._initMortarMarker(); rg = this._mortarRangeRings; }
    if(!rg) return;
    if(!t || !t.alive || !t.def || t.def.shellType !== 'mortar'){ rg.visible = false; return; }
    rg.visible = true;
    /* The group carries POSITION only. Scaling it would scale the line width
       too, which is the bug this function exists beside: the dead zone at 22m
       is a fifth of the outer radius, so a shared scale drove its 1.4m of line
       down to a fifth of that -- invisible. */
    rg.scale.setScalar(1);
    rg.position.set(t.x, 0.05, t.z);

    /* A DASHED RING, BUILT FROM QUADS.

       Each dash is a small annular sector: two triangles between an inner and an
       outer radius, spanning an arc. They are all baked into ONE BufferGeometry so
       the whole circle is still a single draw call.

       The dash count is derived from the CIRCUMFERENCE divided by a target
       on-ground dash length, which is the part that matters: a fixed dash COUNT
       would make the pattern stretch as the radius grows, and at 115m against 22m
       the same 40 dashes would read as two entirely different line styles. Working
       in metres means the outer circle and the dead-zone circle are the same kind
       of line, which is what makes them read as two measurements of one weapon
       rather than as two unrelated decorations.

       Dash and gap are both real geometry with real width, so neither thins to
       nothing at distance the way a 1px WebGL line does. */
    const dashedRing = (radius, halfWidth, dashLen, gapLen) => {
      const rIn = Math.max(0.01, radius - halfWidth);
      const rOut = radius + halfWidth;
      const dashArc = dashLen / Math.max(radius, 0.001);
      const gapArc = gapLen / Math.max(radius, 0.001);
      const step = dashArc + gapArc;
      const count = Math.max(12, Math.min(240, Math.round((Math.PI * 2) / step)));
      /* Four corners per dash, two triangles. A little over-tessellated on the arc
         so a dash reads as a smooth segment rather than a visible facet. */
      const per = 5;
      const pos = new Float32Array(count * per * 6 * 3);
      const idx = [];
      let o = 0;
      const put = (x, y) => { pos[o++] = x; pos[o++] = y; pos[o++] = 0; };
      for(let d = 0; d < count; d++){
        const a0 = (d / count) * Math.PI * 2;
        const a1 = a0 + dashArc;
        const base = d * per * 6;
        for(let s = 0; s < per; s++){
          const t0 = a0 + (a1 - a0) * (s / per);
          const t1 = a0 + (a1 - a0) * ((s + 1) / per);
          const c0 = Math.cos(t0), s0 = Math.sin(t0);
          const c1 = Math.cos(t1), s1 = Math.sin(t1);
          put(c0 * rIn,  s0 * rIn);
          put(c0 * rOut, s0 * rOut);
          put(c1 * rOut, s1 * rOut);
          put(c1 * rIn,  s1 * rIn);
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };

    /* Rebuild a ring's geometry only when its radius actually changes. Both
       ranges are constant for the life of a match, so this runs twice in total
       and then never again. */
    const cache = this._mortarRangeCache || (this._mortarRangeCache = {max:-1, min:-1});
    const setRing = (mesh, radius, key, dashLen, gapLen) => {
      if(cache[key] === radius) return;
      cache[key] = radius;
      const hw = mesh.userData.halfWidth || 0.8;
      mesh.geometry.dispose();
      mesh.geometry = dashedRing(radius, hw, dashLen, gapLen);
    };
    const maxR = t.def.shellRange || 115;
    /* THREE TIMES THE DASH DENSITY of the first version, which used 9m/7m.
       At 115m that was 16m per dash-and-gap cycle Ã¢â‚¬â€ roughly 45 dashes round the
       whole circle, sparse enough that from the chase camera the ring read as a
       handful of scattered marks rather than as a drawn boundary. It is a
       MEASUREMENT, though, and a measurement wants to look measured rather than
       approximate: at 3m/2.3m there are about 140 of them and the eye resolves
       the circle as one continuous dashed line with a rhythm to it.

       Still real geometry with real width, so nothing thins to nothing when the
       camera pulls back the way a 1px WebGL line does. */
    setRing(this._mortarRangeMaxRing, maxR, 'max', 3, 2.3);
    const minR = t.def.artilleryMinRange || 0;
    if(minR > 0.02 * maxR) setRing(this._mortarRangeMinRing, minR, 'min', 0.75, 0.6);
    this._mortarRangeMinRing.visible = minR > 0.02 * maxR;
  }

  _updateMortarMarker(aim){
    const g = this._mortarRing;
    if(!g) return;
    this._updateMortarRangeRings(this.localTank);
    if(!aim){
      g.visible = false;
      if(this._mortarCross) this._mortarCross.visible = false;
      return;
    }
    g.visible = true;
    g.position.set(aim.point.x, 0.06, aim.point.z);
    g.scale.setScalar(aim.splashRadius);
    const col = aim.blocked ? 0xff3020 : 0xffb040;
    this._mortarRingEdge.material.color.setHex(col);
    this._mortarRingFill.material.color.setHex(col);
    /* Steadfast when the shot is legal, pulsing red and angry when it is not.
       The player must never have to read a number to know the gun will not
       fire, and artillery without that warning is just a ten second wait. */
    const pulse = aim.blocked ? (0.45 + 0.45 * Math.abs(Math.sin(performance.now() / 140))) : 1;
    this._mortarRingEdge.material.opacity = pulse;
    this._mortarRingFill.material.opacity = pulse * 0.10;

    /* Scale the X off the splash radius but keep it readable at any range, and
       keep its stroke a fixed fraction of the arms so it never turns into a blob
       when the circle is small. */
    const c = this._mortarCross;
    c.visible = true;
    c.position.set(aim.point.x, 0.10, aim.point.z);
    const arm = Math.max(1.9, aim.splashRadius * 0.52);       // half-length of each arm
    const thick = Math.max(0.30, aim.splashRadius * 0.075);   // stroke width
    if(this._mortarCrossBars){
      for(const bar of this._mortarCrossBars){
        bar.scale.set(arm * 2, thick, 1);
      }
    }
    this._mortarCrossMat.color.setHex(aim.blocked ? 0xff5030 : 0xffffff);
    this._mortarCrossMat.opacity = pulse;
  }

  /* The artillery aim line is the ARC, plus the impact ring. Everything else in
     the game draws a straight raycast and a ricochet prediction; none of that
     applies to a shell that goes over walls, so this replaces the lot rather
     than bending it. `aim` is passed in because the caller has already solved
     it to decide whether it needs redrawing at all. */
  _drawMortarAim(t, aim){
    this._updateMortarMarker(aim);
    if(!this.aimLine || !aim){ this.aimLine.visible = false; return; }
    if(this.aimMarkers) this.aimMarkers.visible = false;
    this._aimLabels.forEach(s => s.visible = false);
    this._ricoLines.forEach(l => l.visible = false);
    if(this._ricoFrame) this._ricoFrame.visible = false;

    const {pos} = t.muzzle();
    const v = aim.vel, T = aim.flight, g = aim.gravity;
    const STEPS = 44;
    const pts = [];
    for(let i = 0; i <= STEPS; i++){
      const tt = (i / STEPS) * T;
      const x = pos.x + v.x * tt;
      const y = pos.y + v.y * tt - 0.5 * g * tt * tt;
      const z = pos.z + v.z * tt;
      /* `d` is HORIZONTAL metres from the muzzle, because that is what the
         10m markers and the player's sense of "how far is that" both mean. */
      pts.push({x, y, z, d: Math.hypot(x - pos.x, z - pos.z)});
    }
    /* The ribbon's second argument is the distance its style fades over, and
       that wants the arc's TRUE length, not its horizontal span Ã¢â‚¬â€ pass the span
       and the line fades out halfway up and comes back down the far side. */
    let arc = 0;
    for(let i = 1; i < pts.length; i++){
      arc += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y, pts[i].z - pts[i-1].z);
    }
    this._buildAimRibbon(pts, arc, 'mortar');
    /* FULLY WHITE, and fully opaque, whatever the player's own aim-line colour
       and opacity are. The mortar line is not a preference here: it is the aiming
       solution for a weapon whose whole difficulty is judging the arc, and a
       translucent tinted ribbon over a grey map is very hard to read against
       foliage. The settings are restored by refreshAimLineStyle the moment the
       player drives anything else. */
    this.aimLine.material.color.set(0xffffff);
    this.aimLine.material.opacity = 1;
    this.aimLine.visible = true;
  }

  _updateAimLine(){
    if(!this.aimLine) return;
    const t = this.localTank;
    /* No aiming during the closing shot. The reticle is the last thing to go
       and the first thing that makes a cinematic look like gameplay: a dotted
       firing line lying across a victory pose. The mortar rings and the shotgun
       spread wedge go with it Ã¢â‚¬â€ all three are drawn by this function and all
       three are drawn from the tank's gun, so hiding one and not the others
       would leave the worst of it on screen. */
    if(this._endCine){
      this.aimLine.visible = false;
      if(this.aimMarkers) this.aimMarkers.visible = false;
      this._updateMortarMarker(null);
      if(this._spreadAim){ this._spreadAim.visible = false; this._spreadEdges.visible = false; }
      return;
    }
    /* The spread wedge belongs to the tank that was aiming. Driving anything
       else without hiding it leaves a shotgun's fan drawn on the floor beside a
       tank that cannot fire one. */
    if(this._spreadAim && this._spreadAimOwner !== (t && t.def.id)){
      this._spreadAim.visible = false;
      this._spreadEdges.visible = false;
      this._spreadAimOwner = null;
    }
    if(!t || !t.alive){
      this.aimLine.visible = false; if(this.aimMarkers) this.aimMarkers.visible = false;
      this._updateMortarMarker(null);      /* also hides the range rings */
      this._mortarAimLast = null;          /* so respawning redraws immediately */
      if(this._spreadAim){ this._spreadAim.visible = false; this._spreadEdges.visible = false; }
      this._updateAimChevrons(null);
      return;
    }
    this.aimLine.visible = true;
    const muz = t.muzzle();
    const pos = muz.pos;
    /* MODE 1: the drawn line follows the crosshair pitch, exactly like the
       spawned shell will. The mortar keeps its own flat yaw Ã¢â‚¬â€ its height is
       solved by _mortarAim, not by the barrel. */
     let dir = new THREE.Vector3(Math.sin(t.turretAngle), 0, Math.cos(t.turretAngle));
     if(t === this.localTank && this.cameraMode === 'dynamic' && this._aimPitch &&
        t.def.shellType !== 'mortar'){
       dir = this._pitchDir(muz.dir, this._aimPitch);
     }
    /* MODE 1: the centre crosshair rides the pitch on screen, so "mouse up" is
       visibly the crosshair moving up, not the camera tilting. */
    const chEl = document.getElementById('crosshair');
     if(chEl){
       if(this.cameraMode === 'dynamic'){
         const maxUp = CONFIG.AIM_PITCH_UP_DEG * Math.PI / 180;
         const py = -(this._aimPitch / maxUp) * (CONFIG.AIM_PITCH_CURSOR_PX || 120);
         chEl.style.transform = 'translate(-50%,-50%) translateY(' + Math.round(py) + 'px)';
       } else {
         chEl.style.transform = 'translate(-50%,-50%)';
       }
       var _glow = (typeof this._aimLineGlow === 'number') ? this._aimLineGlow : 0;
       var _inner = chEl.querySelector('div');
       if(_inner){
         if(_glow < 0.15){
           _inner.style.boxShadow = '0 0 8px #f84, 0 0 16px rgba(255,136,68,0.8), 0 0 28px rgba(255,136,68,0.5)';
           _inner.style.transform = 'scale(1.3)';
         } else {
           _inner.style.boxShadow = '0 0 4px #f84, 0 0 8px rgba(255,136,68,0.4)';
           _inner.style.transform = 'scale(1)';
         }
       }
     }
       var _glow = (typeof this._aimLineGlow === 'number') ? this._aimLineGlow : 0;
       var _inner = chEl.querySelector('div');
       if(_inner){
         if(_glow < 0.15){
           _inner.style.boxShadow = '0 0 8px #f84, 0 0 16px rgba(255,136,68,0.8), 0 0 28px rgba(255,136,68,0.5)';
           _inner.style.transform = 'scale(1.3)';
         } else {
           _inner.style.boxShadow = '0 0 4px #f84, 0 0 8px rgba(255,136,68,0.4)';
           _inner.style.transform = 'scale(1)';
         }
       }

    /* ARTILLERY: an arc and an impact ring, not a raycast Ã¢â‚¬â€ solved by
       _mortarAim, which is also what the shell is fired with.

       It runs BEFORE the shared rebuild guard and carries its own, because for
       an artillery piece the aim DISTANCE is part of the aim: the cursor can
       move straight up the same ray, away from the tank, and lengthen the shot
       with the heading completely unchanged. The shared guard watches direction
       only, so it would sit there showing a stale arc at the old range. */
    if(t.def.shellType === 'mortar'){
      /* Solved from the SAME muzzle the arc is drawn from and the shell is
         spawned at (both this and spawnShot pass the real `pos`), so the curve
         on screen and the curve in the air cannot disagree. */
      const aim = this._mortarAim(t, pos);
      const p = aim ? aim.point : null;
      const prev = this._mortarAimLast;
      if(prev && p && prev.px === p.x && prev.pz === p.z && prev.d === aim.dist){
        this._aimStale = false;
        return;
      }
      this._mortarAimLast = p ? {px:p.x, pz:p.z, d:aim.dist} : null;
      this._aimLastRebuild = { dx: dir.x, dz: dir.z, px: pos.x, py: pos.y, pz: pos.z,
                               cam: this.camera.position.clone() };
      this._aimStale = true;
      this._updateAimChevrons(null);
      this._drawMortarAim(t, aim);
      return;
    }
    /* A SPREAD GUN DRAWS ITS FAN, NOT A LINE.

       Everything below this point draws one raycast: a single straight ribbon
       down the barrel. For a shotgun that is a lie the player can see Ã¢â‚¬â€ it says
       "everything inside this one line dies" when the weapon's entire
       characteristic is that it also kills everything in a wedge either side,
       and its range is short enough that the difference between the two is
       metres rather than degrees.

       So a tank declaring `pellets` gets a TRIANGLE: two edges running out from
       the muzzle to the two extremes of its own `pelletSpread`, closed by the
       far edge. The angle is the same number the firing code uses, taken from
       the same def, so the outline cannot drift from the shot Ã¢â‚¬â€ if the spread is
       retuned the wedge changes with it. Filled faintly, because the interior is
       what the player is really being told about; drawn over the raycast ribbon,
       which is still built underneath it and still shows the centre line. */
    if(t.def.pellets > 1 && t.def.pelletSpread){
      /* The wedge is drawn OVER the ordinary ribbon rather than instead of it,
         so the range reading down the barrel survives. The ribbon is rebuilt
         first (no early return), then the triangle is laid on top. */
      this._updateMortarMarker(null);
      this._mortarAimLast = null;
      this._updateAimChevrons(null);
      this._buildSpreadCentreRibbon(t, pos);
      this._drawSpreadAim(t, pos);
      return;
    }

    this._updateMortarMarker(null);
    this._mortarAimLast = null;            /* switching tanks must force a redraw */

    /* GUN-LAG GLOW (mode 2). The turret turns at turretTurn rad/s but the
       cursor is instant Ã¢â‚¬â€ so while the gun is still swinging toward the aim
       the whole line switches to a bright, warm, wider look. The moment it
       arrives, the line drops back to the quiet settings look. This MUST run
       every frame (it re-paints material uniforms, which cost nothing) Ã¢â‚¬â€ and
       it must run AFTER the ribbon would rebuild, since these two states
       alternate several times a second while you sweep the cursor. */
    let glow = 0;
    if(this.cameraMode === 'strategic' && !this.spectate){
      const tgt = this._mouseWorldAngle();
      if(tgt != null && t.turretAngle != null){
        const lag = Math.abs(((tgt - t.turretAngle) % (Math.PI*2) + Math.PI*3) % (Math.PI*2) - Math.PI);
        glow = 0;   /* gun-lag bright flash disabled: it read as a separate white line on fire */
      }
    }
    this._strategicGlow = glow;
    if(this.cameraMode === 'strategic'){
      const mop = this.settings.aimLineOpacity || 0.3;
      if(!this._aimGlowActive){ this._aimGlowBaseOp = this.aimLine.material.opacity;
                                this._aimGlowActive = true; }
      this.aimLine.material.opacity = Math.min(1, mop * (1 + 1.8 * glow));
      this.aimLine.material.color.set(glow > 0.12 ? '#ffd76b'
                                                   : (this.settings.aimLineColor || '#ffffff'));
      this._updateAimChevrons(this._aimEnd, glow);
    } else if(this._aimGlowActive){
      /* Left strategic mode: hand the material back to the settings look. */
      this._aimGlowActive = false;
      this.aimLine.material.opacity = this.settings.aimLineOpacity;
      this.aimLine.material.color.set(this.settings.aimLineColor || '#ffffff');
      this._updateAimChevrons(null);
    }

    /* The ribbon is 480 segments and it was rebuilt EVERY frame, which cost a
       measured 0.8ms of CPU and a full geometry re-upload to the GPU on every
       single frame Ã¢â‚¬â€ while the shot was going exactly the same way it went the
       frame before, which is most of the time. It only changes when the tank
       aims somewhere else or the map under it moves, so it is rebuilt only then.
       The guard is loose on purpose: a degree of drift is invisible but
       rebuilding on every twitch is not free. */
    this._aimLastRebuild = { dx: dir.x, dz: dir.z, px: pos.x, py: pos.y, pz: pos.z,
                             cam: this.camera.position.clone() };
    this._aimStale = true;    const startX = pos.x, startZ = pos.z;
    /* THE LINE DRAWS THE SAME BALLISTICS THE SHELL FLIES.

       Every sample below solves the closed-form the Shell class flies: at
       each flight time T along the aim, x = ox + sin(yaw)*speed*cos(pitch)*T,
       y = oy + speed*sin(pitch)*T - gravity*TÃ‚Â²/2, z = oz + cos(yaw)*... Ã¢â‚¬â€ the
       exact expression in Shell.update's _manualFlight branch. The ribbon is
       built from the same muzzle, the same yaw, the same pitch, the same
       speed, the same gravity and the same shellRange, so what is drawn IS
       what flies, to the last vertex, without needing any solver to agree
       with a second solver invented for the purposes of drawing.

       The stock 2-D ray used to sample x/z until world.collidesWallsOnly fired
       and call it 'blocked at the first wall in path'. It was 2-D (wall height
       never entered the picture) and so was a lie aimed at the crosshair on
       two axes at once: a wall in front of you showed as a clear aim line over
       it (because the line ran at y=0), and no visual cue on aim-vs-hit.

       Now the FIRST 3-D wall contact (see Shell._wallHeightAt) stops the
       ribbon, the impact point is marked with a bright X at the right height
       on the wall face, and a red X is rendered too if the shot is going
       short but would still land before a wall. */
    const isCone = t.def.shellType === 'flame';
    const flightT = t.def.shellRange / t.def.shellSpeed;
    const yaw = Math.atan2(dir.x, dir.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const grav = (typeof CONFIG !== 'undefined' && CONFIG.SHELL_GRAVITY) || 9.8;
    const H_SPEED = t.def.shellSpeed * Math.cos(pitch);
    const V_SPEED = t.def.shellSpeed * Math.sin(pitch);
    const N = 96;
    const T_STEP = flightT / N;
    let endT = flightT;
    let blocked = false;
    for(let i=0;i<=N;i++){
      const T = i * T_STEP;
      const sx = pos.x + Math.sin(yaw) * H_SPEED * T;
      const sz = pos.z + Math.cos(yaw) * H_SPEED * T;
      const sy = pos.y + V_SPEED * T - 0.5 * grav * T * T;
      if(this.world.collidesWallsOnly(sx, sz, 0.3)){
        const wh = this._wallHeadroom(this.world, sx, sz);
        if(sy <= wh){
          endT = T;           /* the shell dies HERE Ã¢â‚¬â€ include the point and stop */
          blocked = true;
          break;
        }
        /* Above the wall crest: carries on, keep sampling. */
      }
    }
    const endDist = H_SPEED * endT;
    const endY = pos.y + V_SPEED * endT - 0.5 * grav * endT * endT;
    const pts = [];                 // polyline the ribbon is drawn along
    let ricoX = pos.x + Math.sin(yaw) * endDist, ricoZ = pos.z + Math.cos(yaw) * endDist, ricoEndX = ricoX, ricoEndZ = ricoZ;
    let ricoEntryDist = endDist, ricoRemaining = 0;
    let rDirX = 0, rDirZ = 0, ricoTarget = null;    
    const y0 = pos.y;
    const yEnd = endY;
    /* WALL-HIT INDICATOR, the piece the request asked for by name.

       `blocked` is true only when the ballistic sample dips below a wall's
       real top edge (the same test Shell.update uses, in the same units, on
       the same wall list). When it is, an X sprite is placed at the exact
       impact point Ã¢â‚¬â€ not 1 unit above the ground near it, the 3-D point Ã¢â‚¬â€
       and the X is RED, so "your shot stops here" is readable without
       reading anything. Anything not blocked is drawn to the end of flight
       with no X at all, so an open shot and a blocked shot look different
       at a glance. */
    this._updateWallHitMark(blocked, ricoX, endY, ricoZ);
    if(isCone){
      const tanHalf = t.def.fireConeHalfAngle || 0.12;
      const halfW = endDist * tanHalf;
      const perpX = -dir.z, perpZ = dir.x;
      // cone OUTLINE: muzzle -> left -> right -> muzzle
      pts.push({x:startX, y:y0, z:startZ, d:0});
      pts.push({x:endX + perpX*halfW, y:yEnd, z:endZ + perpZ*halfW, d:endDist});
      pts.push({x:endX - perpX*halfW, y:yEnd, z:endZ - perpZ*halfW, d:endDist});
      pts.push({x:startX, y:y0, z:startZ, d:0});
    } else {
      // Ricochet prediction Ã¢â‚¬â€ circle-ray intersection for exact entry point
      for(const enemy of this.tanks){
        if(enemy === t || !enemy.alive || !enemy.def.armor) continue;
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
              const ricoMax = (endDist - entryT) / 1.5;
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
      const ricoY = y0 + dir.y * ricoEntryDist;
      const ricoEndY = ricoY + dir.y * ricoRemaining;
      pts.push({x:startX, y:y0, z:startZ, d:0});
      pts.push({x:ricoX, y:ricoY, z:ricoZ, d:ricoEntryDist});
      if(ricoRemaining > 0.01){
        pts.push({x:ricoEndX, y:ricoEndY, z:ricoEndZ, d:ricoEntryDist + ricoRemaining});
      }
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
    /* The line's END point is what the chevron stream measures against Ã¢â‚¬â€
       store it after each rebuild, whether or not the aim has since moved
       (the pre-guard call above reuses this). */
    const _lastPt = pts[pts.length - 1];
    if(_lastPt) this._aimEnd = { x: _lastPt.x, z: _lastPt.z };
    /* range is FLIGHT LENGTH now (metres the shell actually covers along its
       horizontal leg), not the old 500 m CAP Ã¢â‚¬â€ the fade-out and marker
       spacing measure the real shot. */
    const range = ricoEntryDist + ricoRemaining || endDist;
    this._buildAimRibbon(pts, range);
    if(this._strategicGlow != null) this._updateAimChevrons(this._aimEnd, this._strategicGlow);

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
        const yAtD = y0 + (d / (range || 1)) * (yEnd - y0);
        if(isPro && idx+5 < markArr.length){
          markArr[idx] = mx + perpX * halfW;
          markArr[idx+1] = yAtD;
          markArr[idx+2] = mz + perpZ * halfW;
          markArr[idx+3] = mx - perpX * halfW;
          markArr[idx+4] = yAtD;
          markArr[idx+5] = mz - perpZ * halfW;
          idx += 6;
        }
        if(isPro && labelIdx < this._aimLabels.length){
          const lbl = this._aimLabels[labelIdx];
          lbl.visible = true;
          lbl.position.set(mx + perpX * 1.2, yAtD + 0.6, mz + perpZ * 1.2);
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
    // White end-caps (frame): 4 caps (2 per face Ã¢â‚¬â€ 2 faces)
    const fgeo = new THREE.BufferGeometry();
    const fpos = new Float32Array(24); // 4 segments Ã¢â‚¬â€ 2 verts Ã¢â‚¬â€ 3 coords
    fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
    this._ricoFrame = new THREE.LineSegments(fgeo, new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
    }));
    this._ricoFrame.visible = false;
    this._ricoFrame.frustumCulled = false;
    this.scene.add(this._ricoFrame);
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
    s.position.set(x, y, z);
    s.scale.set(2.8, 1.4, 1);
    this.scene.add(s);

    // Fire it sideways across the screen instead of letting it pop in place.
    // "Right" is the camera's own right, so it always reads as left/right on
    // screen no matter which way the player is looking. It has to be
    // normalised - the camera is pitched down, so the raw cross product comes
    // out shorter than 1 and the numbers would crawl.
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    let rightX = -fwd.z, rightZ = fwd.x;
    const rLen = Math.hypot(rightX, rightZ) || 1;
    rightX /= rLen; rightZ /= rLen;
    this._dmgSide = -(this._dmgSide || 1);      // alternate so hits fan out
    const side = this._dmgSide;
    const speed = 10 + Math.random() * 3;       // hard launch, then coasts

    if(!this._dmgLabels) this._dmgLabels = [];
    this._dmgLabels.push({
      sprite:s, canvas:c, life:1.15, maxLife:1.15,
      vx: rightX * speed * side,
      vz: rightZ * speed * side,
      vy: 4.6 + Math.random() * 1.4,            // upward kick
      side,
    });
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

  /* White outline line around tank at water level Ã¢â‚¬â€ only edges in water visible */
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
              if(!this._partGeo) this._partGeo = new THREE.PlaneGeometry(0.9, 0.30);
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
    this._mwaRay = this._mwaRay || new THREE.Raycaster();
    this._mwaVec = this._mwaVec || new THREE.Vector2();
    this._mwaPlane = this._mwaPlane || new THREE.Plane(new THREE.Vector3(0,1,0), 0);
    this._mwaHit = this._mwaHit || new THREE.Vector3();
    this._mwaVec.set(this.input.mouse.ndcX, this.input.mouse.ndcY);
    this._mwaRay.setFromCamera(this._mwaVec, this.camera);
    this._mwaPlane.constant = -(this.localTank.def.body.h+0.5);
    if(!this._mwaRay.ray.intersectPlane(this._mwaPlane, this._mwaHit)) return this.localTank.turretAngle;
    return Math.atan2(this._mwaHit.x - this.localTank.x, this._mwaHit.z - this.localTank.z);
  }

  // Tanki Online Dynamic camera: turret aims where center crosshair ray hits ground
  _screenCenterWorldAngle(){
    if(!this.localTank) return 0;
    this._scwaRay = this._scwaRay || new THREE.Raycaster();
    this._scwaCenter = this._scwaCenter || new THREE.Vector2(0, 0);
    this._scwaPlane = this._scwaPlane || new THREE.Plane(new THREE.Vector3(0,1,0), 0);
    this._scwaHit = this._scwaHit || new THREE.Vector3();
    this._scwaRay.setFromCamera(this._scwaCenter, this.camera);
    this._scwaPlane.constant = -(this.localTank.def.body.h+0.5);
    if(!this._scwaRay.ray.intersectPlane(this._scwaPlane, this._scwaHit)) return this.localTank.turretAngle;
    return Math.atan2(this._scwaHit.x - this.localTank.x, this._scwaHit.z - this.localTank.z);
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
        ring.scale.setScalar(1.15 - 0.30 * (remain / total));
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

    // --- Double: Landfield Ã¢â‚¬â€ place 5 landmines in selected area ---
    else if(st === 'targeting' && d.superType === 'landfield'){
      if((this.input.keys['Escape'] || this.input.keys['ContextMenu']) && !this._superEscPrev){
        this._superEscPrev = true;
        t.cancelSuper();
      } else if(!this.input.keys['Escape'] && !this.input.keys['ContextMenu']){
        this._superEscPrev = false;
      }
      var picked = null;
      var click = this.input.consumePressed('fire') || (this.input.mouse.down && !this._superMousePrev);
      this._superMousePrev = this.input.mouse.down;
      var tap = this.input.consumeTap();
      if(tap){ picked = this._groundPoint(tap.ndcX, tap.ndcY); }
      else if(click){ picked = this._groundPoint(this.input.mouse.ndcX, this.input.mouse.ndcY); }
      if(picked){
        var pd = Math.hypot(picked.x - t.x, picked.z - t.z);
        if(pd > 15){
          if(typeof Menu !== 'undefined' && Menu.toast) Menu.toast('Too far!');
        } else {
          var mineCount = d.superMineCount || 5;
          for(var mi = 0; mi < mineCount; mi++){
            var ma = (mi / mineCount) * Math.PI * 2;
            var mr = 1.5 + Math.random() * 1.5;
            var mx = picked.x + Math.cos(ma) * mr;
            var mz = picked.z + Math.sin(ma) * mr;
            var mine = new Landmine(t, {x:mx, y:0.18, z:mz}, d);
            mine.attach(this.scene); this.projectiles.push(mine);
          }
          t.superState = 'done';
          t.superTimer = 0;
        }
      }
    }

    // --- Inferno: molotov super ---
    else if(st === 'targeting' && d.superType === 'molotov'){
      if((this.input.keys['Escape'] || this.input.keys['ContextMenu']) && !this._superEscPrev){
        this._superEscPrev = true;
        t.cancelSuper();
      } else if(!this.input.keys['Escape'] && !this.input.keys['ContextMenu']){
        this._superEscPrev = false;
      }
      var picked = null;
      var click = this.input.consumePressed('fire') || (this.input.mouse.down && !this._superMousePrev);
      this._superMousePrev = this.input.mouse.down;
      var tap = this.input.consumeTap();
      if(tap){ picked = this._groundPoint(tap.ndcX, tap.ndcY); }
      else if(click){ picked = this._groundPoint(this.input.mouse.ndcX, this.input.mouse.ndcY); }
      if(picked){
        var pd = Math.hypot(picked.x - t.x, picked.z - t.z);
        if(pd > 20){
          if(typeof Menu !== 'undefined' && Menu.toast) Menu.toast('Too far!');
        } else {
          this._spawnMolotov(t, picked.x, picked.z);
          t.superState = 'done';
          t.superTimer = 0;
          t.superCdLeft = t.superCdTotal;
        }
      }
    }

    // --- Predator: reload boost circle ---
    else if(st === 'reload_boosting'){
      t.superTimer -= dt;
      if(!t._reloadBoostRing){
        var rr = d.superRadius || 10;
        t._reloadBoostRing = this._makeGroundRing(t.x, t.z, rr, 0x44ff88, 0.5);
      } else {
        t._reloadBoostRing.position.set(t.x, 0.04, t.z);
      }
      var boostMult = d.superReloadMult || 0.5;
      for(var bi = 0; bi < this.tanks.length; bi++){
        var bt = this.tanks[bi];
        if(!bt.alive) continue;
        var bdist = Math.hypot(bt.x - t.x, bt.z - t.z);
        var brr = d.superRadius || 10;
        if(bdist < brr){
          if(bt.reloadLeft > 0) bt.reloadLeft *= (1 - boostMult * dt * 2);
          if(bt.magReloadLeft > 0) bt.magReloadLeft *= (1 - boostMult * dt * 2);
        }
      }
      if(t.superTimer <= 0){
        if(t._reloadBoostRing){ this.scene.remove(t._reloadBoostRing); t._reloadBoostRing = null; }
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
      const mat = Toon.mat({ color: 0x333338 });
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

  _spawnMolotov(t, x, z){
    if(!this._molotovFires) this._molotovFires = [];
    const d = t.def;
    const radius = d.molotovRadius || 7;
    const duration = d.molotovDuration || 30;
    const damage = d.molotovDamage || 5;
    const tick = d.molotovTick || 0.3;

    const geo = new THREE.CircleGeometry(radius, 48);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.12, z);
    this.scene.add(mesh);

    const innerGeo = new THREE.CircleGeometry(radius * 0.7, 48);
    innerGeo.rotateX(-Math.PI / 2);
    const innerMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const innerMesh = new THREE.Mesh(innerGeo, innerMat);
    innerMesh.position.set(x, 0.14, z);
    this.scene.add(innerMesh);

    this.spawnExplosion(x, 0.4, z, 0xff6600, 8, 'burn');
    this.spawnBurst(x, 0.6, z, { count: 16, tex: 'ember', speed: 10, size: 0.4, life: 0.8, rise: 5, gravity: 8, blend: 'add' });

    this._molotovFires.push({
      owner: t, x, z, radius, damage, tick,
      timer: duration, maxTimer: duration, tickTimer: 0,
      mesh, innerMesh,
      fadeIn: 0.5, fadeOut: 5,
      phase: Math.random() * 6.28,
    });
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
    const icons = { airstrike:'?', cloak:'??', bush:'??', panzers:'?', oil:'??' };
    btn.querySelector('.super-icon').textContent = icons[info.type] || '?';
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
     WoT-STYLE IN-BATTLE SCOREBOARD (Tab)
     =========================================================== */
  _showScoreboard(){
    const el = document.getElementById('scoreboard-overlay');
    if(!el) return;
    el.classList.remove('hidden');
    this._sbHash = '';
    this._renderScoreboard();
  }
  _hideScoreboard(){
    const el = document.getElementById('scoreboard-overlay');
    if(el) el.classList.add('hidden');
  }
  _toggleScoreboard(){
    const el = document.getElementById('scoreboard-overlay');
    if(!el) return;
    if(el.classList.contains('hidden')){
      this._showScoreboard();
    } else {
      el.classList.add('hidden');
    }
  }
  _renderScoreboard(){
    const container = document.getElementById('sb-container');
    if(!container) return;
    const isTDM = !!this._tdmState;

    let dataHash = '';
    const allTanks = this.tanks.filter(t => !t.isDummy);
    for(const t of allTanks){
      dataHash += t.name + ':' + (t.kills||0) + ':' + Math.round(t.damageDealt||0) + ':' + (t.alive?'1':'0') + ':' + (t.team||'') + ';';
    }
    if(isTDM && this._tdmState){
      dataHash += 'R' + this._tdmState.round + 'B' + this._tdmState.blueRoundWins + 'r' + this._tdmState.redRoundWins;
    }
    if(dataHash === this._sbHash) return;
    this._sbHash = dataHash;

    let html = '';
    const medals = ['??','??','??'];
    const renderTeam = (teamArr, teamName, teamClass) => {
      teamArr.sort((a,b) => (b.kills||0) - (a.kills||0) || (b.damageDealt||0) - (a.damageDealt||0));
      let rows = teamArr.map((t,i) => {
        const isLocal = t === this.localTank;
        const dead = !t.alive || t.dying;
        /* Fallback colour is RELATIVE -- the heading this row sits under, which is
         already 'blue' for the player's own team and 'red' for the other. The
         per-tank `t.color` above it still wins when set: that is a player's
         chosen tank colour, not a team indicator, and overriding it here would
         take the dot colour away from being a team colour at all. */
        const col = '#'+((t.color || (teamName==='blue'?0x4488ff:0xff4444)).toString(16).padStart(6,'0'));
        const veh = (t.def && t.def.name) ? t.def.name : '';
        const rankCls = 'sb-row' + (isLocal ? ' local' : '') + (dead ? ' dead' : '') + (i < 3 ? ' sb-rank-'+(i+1) : '');
        const rankContent = i < 3 ? '<span class="sb-medal">'+medals[i]+'</span>' : (i+1);
        const statusHtml = dead
          ? '<span class="sb-status-dead">DOWN</span>'
          : '<span class="sb-status-alive">UP</span>';
        return '<div class="'+rankCls+'">'+
          '<span class="sb-c-rank"><span class="sb-dot" style="background:'+col+';--dot-color:'+col+'"></span>'+rankContent+'</span>'+
          '<span class="sb-name">'+t.name+(isLocal?' <span style="color:#ffb833;font-size:10px;opacity:0.7">YOU</span>':'')+'</span>'+
          '<span class="sb-c-vehicle">'+veh+'</span>'+
          '<span class="sb-c-kills">'+(t.kills||0)+'</span>'+
          '<span class="sb-c-dmg">'+Math.round(t.damageDealt||0)+'</span>'+
          '<span class="sb-c-status">'+statusHtml+'</span>'+
        '</div>';
      }).join('');
      return '<div class="sb-team sb-team-'+teamClass+'">'+
        '<div class="sb-team-header">'+teamName.toUpperCase()+'</div>'+
        '<div class="sb-cols"><span class="sb-c-rank">#</span><span class="sb-name">PLAYER</span><span class="sb-c-vehicle">VEHICLE</span><span class="sb-c-kills">KILLS</span><span class="sb-c-dmg">DMG</span><span class="sb-c-status">STATUS</span></div>'+
        rows+'</div>';
    };
    if(isTDM){
      const blue = this.tanks.filter(t => t.team === 'blue' && !t.isDummy);
      const red = this.tanks.filter(t => t.team === 'red' && !t.isDummy);
      const s = this._tdmState;
      const roundEl = document.getElementById('sb-round-info');
      if(roundEl){
        roundEl.classList.remove('hidden');
        /* Relative, like the ring and the toasts: the left number is always
           yours and the right always theirs, whatever team you are. */
        roundEl.textContent = 'ROUND '+(s.round||1)+' of '+(s.maxRounds||5)+' Ã¢â‚¬â€ Blue '
          +(this._displaySide('blue') === 'blue' ? (s.blueRoundWins||0) : (s.redRoundWins||0))
          +' Ã¢â‚¬â€ '+(this._displaySide('blue') === 'blue' ? (s.redRoundWins||0) : (s.blueRoundWins||0))
          +' Red';
      }
      /* The two columns are ordered by RELATIONSHIP, not by team id, so the
         player's own team is always the one headed BLUE. The rows inside are
         still the real blue team and the real red team -- only the heading and
         the order change. */
      const mineBlue = (this.localTank && this.localTank.team) === 'blue';
      const [firstRows, firstName, secondRows, secondName] = mineBlue
        ? [blue, 'blue', red, 'red']
        : [red,  'blue', blue, 'blue'];
      html = renderTeam(firstRows, firstName, 'blue') + renderTeam(secondRows, secondName, 'red');
    } else {
      const roundEl = document.getElementById('sb-round-info');
      if(roundEl) roundEl.classList.add('hidden');
      const all = this.tanks.filter(t => !t.isDummy);
      html = renderTeam(all, 'Players', 'blue');
    }
    container.innerHTML = html;
  }

  /* ===========================================================
     SKIP BATTLE Ã¢â‚¬â€ the hidden Tab+P shortcut
     =========================================================== */

  /* Arm the combo for this battle.

     Called from _resetArena rather than leaving the flags set, because the whole
     point of the latch is "one press ends one battle". Reset here means a player
     who holds both keys down through a skip has to let go and press again before
     the NEXT battle can be ended. */
  _armSkipCombo(){
    this._skipKeyP = false;
    this._skipKeyTab = false;
    this._skipFired = false;
  }

  /* THE COMBO CHECKED. Only the trigger lives here; what a finished match means
     lives in _finishMatch() so the local and networked paths cannot diverge. */
  _trySkipBattle(){
    if(this._skipFired) return;
    /* Only during a battle. On the menu there is no match to end, and during the
       countdown or the map vote there is not one yet Ã¢â‚¬â€ ending "the battle" then
       would tear down an arena that is still loading. */
    if(!this.running) return;
    /* A finished match is already on its way to the results screen. Firing again
       would build a second one on top of the first. */
    if(this._resultsShown) return;

    this._skipFired = true;

    const me = this.localTank;
    const myTeam = (me && me.team) || 'blue';

    /* A CLIENT CANNOT END THE MATCH. It has no authority over the battle, and two
       machines independently deciding who won is exactly the failure this whole
       path exists to avoid. If the host never hears about it the battle simply
       continues, which is the correct outcome: a hidden key on one player's
       machine must not be able to break a match for both. */
    if(this.mode === 'client'){
      this._skipPending = true;
      return;
    }

    /* Announce it first, then finish locally.

       In that order on purpose. If the broadcast throws, or the socket is already
       gone, the local match still ends Ã¢â‚¬â€ the player who pressed the key gets
       their results screen either way rather than being left standing in a battle
       they just tried to leave. */
    /* `typeof Net` rather than `window.Net`. Net is a top-level `const` in net.js,
       which puts it in the global LEXICAL scope Ã¢â‚¬â€ reachable as a bare `Net` from
       any later script, but NOT attached to `window`. So a `window.Net` guard
       would be false in a perfectly working game, and the skip would never be
       announced to the other player. `typeof` is also safe where a property
       access is not: if net.js ever failed to load, evaluating a bare `Net`
       throws a ReferenceError, and the bare identifier inside the && would be
       reached exactly when the guard is meant to protect. */
    if(typeof Net !== 'undefined' && Net.role === 'host' && typeof Net.sendMatchEnd === 'function'){
      try {
        Net.sendMatchEnd({
          winnerTeam: myTeam,
          winnerPeerId: Net.userId || null,
          reason: 'skipped',
        });
      } catch(e){}
    }

    this._finishMatch({ winnerTeam: myTeam, reason: 'skipped' });
  }

  /* ============================================================================
     FINISH THE MATCH Ã¢â‚¬â€ shared by the combo, the host's own broadcast, and the
     client's copy of it.

     One implementation on purpose. The host runs it locally the instant it
     presses the combo, and the client runs the same function when the message
     arrives. If there were a "host path" and a "client path" they would
     disagree about something eventually Ã¢â‚¬â€ most visibly about who won Ã¢â‚¬â€ and the
     symptom would be two players looking at two different results screens.
     ========================================================================== */
  _finishMatch({ winnerTeam, reason }){
    /* One finish per battle. The host sends matchend to every member INCLUDING
       itself, so the broadcast's echo lands here moments after the direct call Ã¢â‚¬â€
       without this latch that echo builds a second results screen on top of the
       first, and pays the battle cash twice. */
    if(this._resultsShown) return;
    if(!this.running) return;
    this._resultsShown = true;

    const me = this.localTank;
    const myTeam = (me && me.team) || 'blue';
    /* Winning is purely a question of which side won and which side this player
       is on. Deriving it from the two, rather than from "did I press the button",
       is what makes the host and the client agree: both are handed the same
       winnerTeam and both look it up against their own team. */
    const won = (winnerTeam === myTeam);

    /* Stop the match clock and free the pointer immediately. The results screen
       is up for as long as the player wants it, and leaving input live behind it
       means held keys keep driving a tank nobody can see. */
    try { if(document.pointerLockElement) document.exitPointerLock(); } catch(e){}
    try { this._hideScoreboard(); } catch(e){}

    /* Cash for what was actually done. No win bonus: the shortcut ends the battle,
       it does not win it, and paying the win bounty for it would make
       start-then-skip a way to farm a full battle's payout in five seconds. */
    this._awardBattleCash({
      damage: me ? (me.damageDealt || 0) : 0,
      assists: me ? (me.assists || 0) : 0,
      kills:  me ? (me.kills || 0) : 0,
      won: false,
    });

    const skipped = reason === 'skipped';
    this._showResults({
      outcome: won ? 'win' : 'loss',
      /* A skipped battle says so, and says the same thing to BOTH players.

         Calling it VICTORY for the presser and DEFEAT for the other player would
         be a lie in the second case Ã¢â‚¬â€ they did not lose, the battle was ended. And
         saying VICTORY at all would claim a win nobody earned, on a screen whose
         job is to be an honest record of the battle. The banner is neutral and the
         colour carries the result, which is what a neutral banner is for. */
      headline: skipped ? 'BATTLE ENDED' : (won ? 'VICTORY' : 'DEFEAT'),
      place: me ? (me.placement || null) : null,
      skipped: skipped,
    });
  }

  /* ============================================================================
     THE CLOSING SHOT

     What plays between the moment the match ends and the moment the results
     screen is on it. Four beats, 4.38 seconds, then a cut:

       0.00s  IMPACT   World hits a near-stop. White flash, letterbox slams shut,
                       a low boom. The battle camera is still wherever it was.
       0.00s  WHIP     (0.85s) The camera throws itself round to the tank's tail,
                       accelerating then braking. Time creeps back to a crawl.
       0.62s  TITLE    VICTORY / DEFEAT punches in from 3x scale with a blur and
                       settling letter-spacing.
       0.85s  REVEAL   (2.10s) The arc from behind, round the side, to the FRONT
                       of the tank Ã¢â‚¬â€ decelerating the whole way, so it arrives
                       rather than stops. Time holds at its crawl.
       2.95s  HOLD     (1.05s) Near still. A slow push-in and a degree of drift.
       4.00s  CUT      (0.38s) One full white frame, THEN the results screen is
                       built, then the white falls away off it.

     WHY THE WHITE FRAME IS ORDERED THE WAY IT IS

     Results.show() builds a WebGL stage and decodes a GLB. That is tens to
     hundreds of milliseconds of blocking work, and doing it while the player is
     looking at the finished shot is a visible stall. So the flash goes to full
     opacity first, the frame is PAINTED at full white (that is what the forced
     reflow plus the one-frame wait is for), and only then is the heavy work done
     Ã¢â‚¬â€ hidden behind the brightest thing on screen, and revealed by the flash
     falling away afterwards. The hitch is still there; it is just somewhere
     nobody can see it.

     WHAT IT DOES NOT TOUCH

     No gameplay state. The camera, the DOM overlay and the time scale are the
     only things this owns. Damage, kills, cash and missions were all read and
     frozen by _showResults BEFORE this starts, which is why the numbers cannot
     drift between the cinematic and the screen that follows it.
     ========================================================================== */

  /* Build (or reuse) the overlay's DOM. Created once and kept for the life of
     the page: it is four elements with no state of their own, and rebuilding it
     per match would mean a layout pass in the frame the shot starts Ã¢â‚¬â€ which is
     the worst possible moment to ask for one. */
  _endCineDom(){
    let el = document.getElementById('endcine');
    if(el) return el;

    el = document.createElement('div');
    el.id = 'endcine';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
        '<div class="endcine-vig"></div>' +
        '<div class="endcine-bar endcine-bar--t"></div>' +
        '<div class="endcine-bar endcine-bar--b"></div>' +
        '<div class="endcine-title">' +
          '<div class="endcine-word"></div>' +
          '<div class="endcine-sub"></div>' +
          '<div class="endcine-rule"></div>' +
        '</div>' +
        '<div class="endcine-flash"></div>' +
        '<div class="endcine-skip">Press any key to skip</div>';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  /* Kick the shot off. Returns true if a cinematic is actually running, so the
     caller knows whether the results screen is its job or already done.

     Everything that can make this impossible is checked HERE rather than left to
     throw inside the per-frame tick, because a throw per frame is a console
     flood and a frozen overlay:

       * no document (nothing to put an overlay on),
       * no camera (a headless run Ã¢â‚¬â€ nothing to film),
       * no local tank (nothing to film it on),
       * the results module missing (nothing to cut TO Ã¢â‚¬â€ better to show nothing
         than to leave the player watching four seconds of camera and then a
         dead end),
       * an overlay that already exists for a reason we could not clear.

     Any of those and we return false, the caller presents the results screen
     immediately, and the behaviour is exactly what it was before this existed. */
  _beginEndCinematic(data){
    /* Already running: let the one in progress finish. Two overlapping shots
       would fight over the same overlay and two cuts would build two results
       screens. */
    if(this._endCine) return true;

    if(typeof document === 'undefined' || !document.body) return false;
    if(!this.camera || !this.scene || !this.running) return false;
    if(!this.localTank) return false;
    if(typeof Results === 'undefined') return false;

    const plan = _endCinePlan;
    let el;
    try { el = this._endCineDom(); } catch(e){ return false; }
    if(!el) return false;

    /* The headline. "BATTLE ENDED" is not a victory and not a defeat and must
       not be coloured as either Ã¢â‚¬â€ it is its own outcome here, and the CSS keys
       the silver treatment off data-outcome="skip". */
    const outcome = data.skipped ? 'skip' : (data.outcome === 'win' ? 'win' : 'loss');
    const word   = (data.headline || (data.outcome === 'win' ? 'VICTORY' : 'DEFEAT')).toUpperCase();

    /* A line under the word. The headline alone says WHAT happened; this says
       what it was about, and it is the last thing on screen before the screen
       that lists it all. */
    let sub = '';
    try {
      if(outcome === 'win')       sub = 'Battle won';
      else if(outcome === 'loss') sub = 'Battle lost';
      else                        sub = 'Battle ended';
    } catch(e){ sub = ''; }

    const C = {
      t: 0,
      plan,
      total: plan.total,
      outcome,
      data,
      timeScale: plan.dip,

      /* Where the play camera actually was, captured on frame zero. Without
         this the WHIP would start from wherever the cinematic last put it Ã¢â‚¬â€
         which, on the second match of a session, is the front of a tank from
         the previous ending, so the "whip" would be a cut that happened to be
         a cut. */
      fromPos: this.camera.position.clone(),
      fromFov: this.camera.fov,

      /* Frames the camera has applied. The pose is cached rather than recomputed
         from `fromPos` every tick so the whip cannot accumulate float drift
         over four seconds of damping toward a moving tank. */
      settled: false,

      /* The white frame, its peak and its decay rate.

         `flash` STARTS AT THE PEAK, not at zero. It is written to the element
         once below and then overwritten every frame by _endCineTick, so if the
         field began at zero the first tick would put opacity 0 over the element
         that had just been set to the peak and the opening flash would never be
         seen at all Ã¢â‚¬â€ the shot would start on a hard cut with no impact.

         `decay` is chosen so the flash is clear by the middle of the whip, which
         is where the camera arrives and the reveal takes over. It is 0 for a
         plan with no opening flash, which also makes the per-frame decay a
         no-op rather than something that has to be special-cased. */
      flash: plan.flash0,
      flashPeak: plan.flash0,
      flashDecay: plan.flash0 ? (1 / Math.max(0.08, plan.swing * 0.55 || 0.25)) : 0,
      cutFired: false,
      cutShown: false,

      /* Where the title punch is, 0..1, driven from the shot clock rather than
         by a CSS animation so a skip can land it exactly. */
      titleP: 0,

      listeners: null,
      el,
    };
    this._endCine = C;

    /* --- the DOM, written once ------------------------------------------- */
    try {
      el.dataset.outcome = outcome;
      el.classList.remove('is-on', 'is-out');
      const w = el.querySelector('.endcine-word');
      const s = el.querySelector('.endcine-sub');
      const r = el.querySelector('.endcine-rule');
      const f = el.querySelector('.endcine-flash');
      const v = el.querySelector('.endcine-vig');
      if(w) w.textContent = word;
      if(s){ s.textContent = sub; s.style.display = sub ? '' : 'none'; }
      if(r) r.style.width = '0px';
      if(f) f.style.opacity = '0';
      if(v) v.style.opacity = '0';
      /* Restarting the bar animation requires the animation to be removed and
         forced to re-apply. `void el.offsetWidth` is the reflow that does it Ã¢â‚¬â€
         without it a second match's bars replay from their FINAL keyframe and
         simply appear. */
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      /* The white frame goes up first and stays up for the length of the whip,
         falling off through the reveal. It is never fully clear again after
         this Ã¢â‚¬â€ the whole point is that the shot arrives out of a flash. */
      if(f) f.style.opacity = String(plan.flash0);
      el.classList.add('is-on');
    } catch(e){}

    /* Sound. Before the camera starts moving, so the boom lands ON the cut into
       the shot rather than somewhere inside it. */
    try { Audio.endStinger(outcome === 'win' ? 'win' : (outcome === 'loss' ? 'loss' : 'skip')); }
    catch(e){}

    /* Hide the battle HUD. The health bar, the minimap and the speed readout are
       all reporting a fight that has already been decided, and a minimap
       flickering through a victory pose is the single most gameplay-looking
       thing on screen. Stashed, not destroyed Ã¢â‚¬â€ see _endCineRestoreHud. */
    this._endCineHideHud();

    /* --- skip ------------------------------------------------------------- */
    /* Bound only while the shot is playing and removed on every exit path.
       These are document-level, so they would otherwise outlive the match. */
    const skip = () => {
      if(!this._endCine) return;
      if(this._endCine.t < this._endCine.plan.skipGuard) return;
      /* Straight to the CUT, not straight to the results. Skipping the flash
         too would skip the only transition the player gets, and the jump from
         a cinematic pose to a full screen with no frame between them is exactly
         what reads as a bug. */
      this._endCine.t = Math.max(this._endCine.t, this._endCine.total - this._endCine.plan.cut);
      this._endCine.flash     = this._endCine.plan.cutFlash;
      this._endCine.flashPeak = this._endCine.plan.cutFlash;
      this._endCine.flashDecay = this._endCine.plan.cutFlash
        ? (1 / Math.max(0.08, this._endCine.plan.cut * 0.7)) : 0;
    };
    C.listeners = { skip };
    try {
      document.addEventListener('keydown', skip, true);
      document.addEventListener('pointerdown', skip, true);
      document.addEventListener('wheel', skip, true);
      document.addEventListener('touchstart', skip, true);
    } catch(e){}

    return true;
  }

  /* One frame of the shot. Called from _step, before _update.

     `dt` here is REAL time Ã¢â‚¬â€ see the two-clock note in _step. Everything in
     this function is timed against it, including the world slowdown it
     commands. */
  _endCineTick(realDt){
    const C = this._endCine;
    if(!C) return;
    const plan = C.plan;
    C.t += realDt;

    /* --- TIME ------------------------------------------------------------- */
    /* Snap to a near-stop on frame one, then creep back to the crawl and hold
       there. It does NOT return to 1 until the cut Ã¢â‚¬â€ a results screen with the
       world still crawling behind it looks like a stalled frame, not a style
       choice. */
    const slowT = (plan.swing > 0) ? Math.min(1, C.t / plan.swing) : 1;
    C.timeScale = plan.dip + (plan.slow - plan.dip) * (1 - Math.pow(1 - slowT, 3));

    /* --- CAMERA ----------------------------------------------------------- */
    this._endCineCamera(C);

    /* --- FLASH ------------------------------------------------------------ */
    /* Decays from whatever peak it was given. Opacity is written straight to
       the element rather than animated: the flash has to be able to be knocked
       up instantly by a skip, and a running CSS animation cannot be pushed up
       from outside. */
    if(C.flash > 0 && C.flashDecay > 0){
      C.flash = Math.max(0, C.flash - realDt * C.flashDecay);
    }
    const flashEl = C.el && C.el.querySelector('.endcine-flash');
    if(flashEl){
      /* `!important` because the CSS also declares `opacity:0` on the element;
         a CSS declaration and an inline one both being present is fine, but the
         transition/animation rules must not be able to win. */
      flashEl.style.opacity = C.flash.toFixed(3);
    }

    /* --- VIGNETTE --------------------------------------------------------- */
    /* Comes up with the letterbox and stays. Cheap, and it is what stops the
       corners of a wide arena map from competing with a tank. */
    const vig = C.el && C.el.querySelector('.endcine-vig');
    if(vig) vig.style.opacity = Math.min(0.9, C.t * 1.6).toFixed(3);

    /* --- TITLE ------------------------------------------------------------ */
    const tp = (plan.titleDur > 0)
      ? Math.max(0, Math.min(1, (C.t - plan.title) / plan.titleDur))
      : 1;
    C.titleP = tp;
    if(tp > 0) this._endCineTitle(C, tp);

    /* --- THE CUT ---------------------------------------------------------- */
    const cutStart = plan.total - plan.cut;
    if(!C.cutFired && C.t >= cutStart){
      C.cutFired = true;
      /* The white frame goes up, and is FORCED onto the screen before anything
         else happens this frame.

         The reflow at the end is what makes it a painted frame rather than a
         style change: without a forced layout the browser is free to coalesce
         this write with the four below it, paint once, and never show a white
         frame at all Ã¢â‚¬â€ which is exactly the frame the whole cut depends on. It
         is one synchronous layout, once, at a moment where the main thread has
         nothing else pending. */
      C.flash = plan.cutFlash; C.flashPeak = plan.cutFlash;
      C.flashDecay = plan.cutFlash ? (1 / Math.max(0.08, plan.cut * 0.72)) : 0;
      if(flashEl){ flashEl.style.opacity = String(plan.cutFlash); }
      /* The lockup leaves fast Ã¢â‚¬â€ it is being replaced, not faded. */
      try {
        if(C.el) C.el.classList.add('is-out');
        const ttl = C.el && C.el.querySelector('.endcine-title');
        if(ttl) ttl.style.opacity = '0';
        const sub = C.el && C.el.querySelector('.endcine-sub');
        if(sub) sub.style.opacity = '0';
        const skp = C.el && C.el.querySelector('.endcine-skip');
        if(skp) skp.style.opacity = '0';
      } catch(e){}
      /* Read a layout property to force the flush. Wrapped: a browser that
         throws on a detached element must not take the cut down with it. */
      try { if(flashEl) void flashEl.offsetWidth; } catch(e){}
      /* STOP HERE, ON PURPOSE.

         Everything the rest of this function does Ã¢â‚¬â€ including building the
         results screen Ã¢â‚¬â€ is skipped, and the function returns, so that this
         frame ends having done nothing but put a white rectangle on the screen.
         The browser now paints it. Only the NEXT tick builds anything.

         Returning here is the entire mechanism. Setting the flash and then
         carrying straight on to _presentResults() in the same tick means the
         browser is handed both the white and a 200ms synchronous GLB decode
         together and gets to paint once, afterwards Ã¢â‚¬â€ so the white is never on
         screen at all, and the cut it was covering is an uncovered cut. */
      return;
    }

    /* The results screen is built ONE FRAME AFTER the white went up, which is
       the first tick that runs after that white was painted. Same reasoning as
       the return above, from the other side. */
    if(C.cutFired && !C.cutShown){
      C.cutShown = true;
      this._endCinePresent(C);
      return;
    }

    /* --- END -------------------------------------------------------------- */
    if(C.t >= C.total){
      /* Nothing above fired (only reachable if `cut` is 0 for some future plan).
         Present rather than abandon: an ending that never arrives is the one
         failure this whole thing must not have. */
      if(!C.cutShown){ C.cutShown = true; this._endCinePresent(C); }
    }
  }

  /* Hand over to the results screen and tear the shot down.

     The white is deliberately KEPT UP across the hand-over (hence the argument),
     because the hand-over is the expensive part: Results.show() builds a WebGL
     stage and decodes a GLB, which is the one hitch in this whole sequence. It
     happens behind an already-painted white frame, and then the white falls away
     off the finished results screen rather than off the shot. */
  _endCinePresent(C){
    const data = C.data;
    const el = C.el;
    const peak = C.plan.cutFlash;
    /* Tear down FIRST. If Results.show() throws, everything is already off the
       screen and the player is left looking at the battlefield rather than at a
       stuck overlay with a white bar across it. */
    this._endCineTearDown(true);
    try { this._presentResults(data); }
    catch(e){ console.warn('[end-cine] results failed:', e); }
    /* ...and now take the white away. On its own CSS animation, not on the shot
       clock: the shot clock stopped with the shot, and a timer that outlives
       `_endCine` is the only thing here that can run after the teardown. */
    try {
      if(!el || !peak) return;
      const f = el.querySelector('.endcine-flash');
      if(!f) return;
      f.style.opacity = '1';
      f.style.animation = 'none';
      void f.offsetWidth;
      f.style.animation = 'endcine-flash-out .46s cubic-bezier(.2,.7,.3,1) forwards';
      clearTimeout(this._endCineFlashTid);
      this._endCineFlashTid = setTimeout(() => {
        this._endCineFlashTid = null;
        try {
          f.style.animation = '';
          f.style.opacity = '0';
          el.classList.remove('is-out');
        } catch(e){}
      }, 620);
    } catch(e){}
  }

  /* The shot died. Put everything back and show the results screen anyway Ã¢â‚¬â€
       the cinematic is an enhancement and must never be able to swallow one. */
  _endCineAbort(){
    const C = this._endCine;
    if(!C) return;
    const data = C.data;
    this._endCineTearDown();
    try { this._presentResults(data); } catch(e){}
  }

  /* Release everything the shot owns. Safe to call twice, and safe to call when
     there was never a shot Ã¢â‚¬â€ leaveToMenu() calls it unconditionally for
     exactly that reason.

     `keepFlash` leaves the white up through the teardown, for the cut: the
     results screen is built during this gap and it must not be visible while it
     is being built. Only the flash survives; the bars still retract and the
     lockup is still cleared, because those are what the white is replacing. */
  _endCineTearDown(keepFlash){
    const C = this._endCine;
    if(!C) return;
    this._endCine = null;

    try {
      if(C.listeners){
        document.removeEventListener('keydown',  C.listeners.skip, true);
        document.removeEventListener('pointerdown', C.listeners.skip, true);
        document.removeEventListener('wheel',     C.listeners.skip, true);
        document.removeEventListener('touchstart', C.listeners.skip, true);
      }
    } catch(e){}
    C.listeners = null;

    /* Put the camera back the way the play rig expects it. Both of these are
       things the follow camera does not set for itself and would be stuck
       against after a match if we left them: `up` is the roll we banked into
       the whip, and the field of view was pulled in to compress the shot. */
    try {
      if(this.camera){
        this.camera.up.set(0, 1, 0);
        if(C.fromFov && this.camera.fov !== C.fromFov){
          this.camera.fov = C.fromFov;
          this.camera.updateProjectionMatrix();
        }
      }
    } catch(e){}

    this._endCineRestoreHud();

    /* The overlay element itself is KEPT (see _endCineDom) Ã¢â‚¬â€ only its classes
       and opacities are cleared, so the next match starts from a known state
       and does not pay for a layout. */
    try {
      if(C.el){
        if(!keepFlash){
          /* An in-flight flash animation would keep writing opacity after this
             point and paint a white bar over the results screen, so the
             animation is cleared before the value is. */
          const f = C.el.querySelector('.endcine-flash');
          if(f){ f.style.animation = ''; f.style.opacity = '0'; }
          clearTimeout(this._endCineFlashTid);
          this._endCineFlashTid = null;
        }
        const v = C.el.querySelector('.endcine-vig');
        if(v) v.style.opacity = '0';
        const ttl = C.el.querySelector('.endcine-title');
        if(ttl) ttl.style.opacity = '';
        const sub = C.el.querySelector('.endcine-sub');
        if(sub) sub.style.opacity = '';
        const skp = C.el.querySelector('.endcine-skip');
        if(skp) skp.style.opacity = '';
        const rule = C.el.querySelector('.endcine-rule');
        if(rule) rule.style.width = '';
        C.el.classList.remove('is-on');
        if(!keepFlash) C.el.classList.remove('is-out');
      }
    } catch(e){}

    /* No explicit time-scale restore. `_step` rebuilds `this.dt` from the
       wall clock on every frame and only multiplies it down while `this._endCine`
       exists, so clearing the reference above is the whole of the restore. A
       manual writeback here would be a second source of truth for a value that
       is already derived. */
  }

  /* The headline punch.

     A CSS transition cannot express this Ã¢â‚¬â€ three properties moving on three
     different curves over the same 0.85s Ã¢â‚¬â€ so it is driven from the shot clock.
     The numbers:

       scale  3.4 -> 1.00   easeOutQuint, the classic overshoot-free slam
       blur   26px -> 0     linear, so the type is sharpest exactly when the
                            scale settles and the eye has something to land on
       spread .55em -> .06em  the letters start thrown apart and pull together
       opacity 0 -> 1       easeOutCubic, so the word is there before the
                            spacing has finished moving and the eye never waits

     The rule under it grows from the centre on the same curve as the scale, one
     frame behind, so the lockup resolves as a single object. */
  _endCineTitle(C, p){
    let ttl, rule;
    try {
      ttl = C.el.querySelector('.endcine-title');
      rule = C.el.querySelector('.endcine-rule');
    } catch(e){ return; }
    if(!ttl) return;

    const e5 = 1 - Math.pow(1 - p, 5);
    const e3 = 1 - Math.pow(1 - p, 3);
    const scale = 3.4 + (1 - 3.4) * e5;
    const blur  = 26 * (1 - p);
    const spread = 0.55 + (0.06 - 0.55) * e3;

    /* On the LAST frame of the punch the CSS takes back over, so the end state
       is a clean static layout rather than a transform frozen at a number. */
    if(p >= 1){
      ttl.style.opacity = '1';
      ttl.style.transform = 'translateY(-50%)';
      /* Hand the rest back to the stylesheet. Leaving the blur and the
         letter-spacing as inline styles means the finished state of the word is
         a transform frozen at whatever number the last frame computed, and any
         later change to the type in CSS would be silently overridden by an
         inline 0.02em that nothing remembers setting. */
      ttl.style.filter = '';
      ttl.style.letterSpacing = '';
      if(rule) rule.style.width = 'min(420px, 46vw)';
      return;
    }
    ttl.style.opacity = e3.toFixed(3);
    ttl.style.transform = 'translateY(-50%) scale(' + scale.toFixed(4) + ')';
    ttl.style.filter = 'blur(' + blur.toFixed(2) + 'px)';
    ttl.style.letterSpacing = spread.toFixed(3) + 'em';
    if(rule){
      /* One frame behind the word: the line is drawn after the thing it is
         underlining. */
      const rp = Math.max(0, p - 0.10) / 0.90;
      rule.style.width = (Math.min(420, innerWidth * 0.46) * (1 - Math.pow(1 - rp, 3))).toFixed(1) + 'px';
    }
  }

  /* THE SHOT.

     Four beats, one function. Every value that matters is derived from the
     tank's LIVE position each frame rather than captured once, because the
     world underneath is still simulating at a crawl Ã¢â‚¬â€ a camera locked to where
     the tank was when the shot began would drift off it during the reveal,
     which is most of the shot.

     Angles are relative to `tank.heading`, and the game puts the tank's nose on
     +Z at heading 0 (see the look-ahead maths in _update), so:

         behind the tank  =  heading + PI
         in front of it   =  heading

     The reveal ends at heading + frontAngle rather than exactly heading. Dead-on
     is a mugshot; three-quarters is a portrait, and it is the angle that shows the
     barrel AND the side of the hull at once. */
  _endCineCamera(C){
    const cam = this.camera;
    const t = this.localTank;
    if(!cam || !t) return;

    /* THE FRAMING, IN ONE PLACE.

       Every number that decides what the shot LOOKS like is here rather than
       inline in the three beat blocks, because this is the part that gets
       dialled in by eye: raising the camera a unit, or pulling it back a unit,
       should never mean finding the same number in three places and hoping all
       three moved together.

       Heights are above the tank's own ground level. They are deliberately high
       Ã¢â‚¬â€ roughly a tank-and-a-half Ã¢â‚¬â€ and that is the single biggest reason the
       shot reads as a hero shot rather than as a screenshot of a tank. At the
       lower, near-level framing this started on, the camera was barely above the
       hull roof: it saw the arena edge-on, the tank's silhouette was a horizontal
       smear against a horizontal ground plane, and there was no ground under the
       tank to sit it on. Looking DOWN at something, even slightly, is most of
       what separates a portrait from a mugshot.

       Raising it also buys the tilt: `lookAt` aims at a point partway up the
       hull, so every unit added here is a degree of downward angle gained, and
       at ~10 units of range that is enough to see the ground the tank is
       standing on without tipping into a top-down. */
    const SHOT = END_CINE.shot;
    const plan = C.plan;
    const P = this._endCinePose = this._endCinePose || new THREE.Vector3();

    /* --- where the tank is right now ------------------------------------- */
    let py = 0;
    try { py = (t._physBody && t._physBody.translation) ? t._physBody.translation().y : (t.y || 0); }
    catch(e){ py = t.y || 0; }
    /* Clamped to the arena floor for the same reason the play camera is: a tank
       that fell out of the world must not drag the closing shot down with it. */
    const groundY = Math.max(py, this._worldFloorY());
    const hullH = (t.def && t.def.body && t.def.body.h) ? t.def.body.h : 1.6;

    const head = t.heading || 0;
    const T_SWING = plan.swing;
    const T_REVEAL = plan.swing + plan.reveal;

    let angle, dist, height, fov, roll;

    if(C.t <= T_SWING){
      /* --- BEAT 1: WHIP --------------------------------------------------- */
      /* Accelerate out, brake in. A straight lerp here reads as a pan; the
         ease is what makes it read as the camera being thrown. */
      const p = (T_SWING > 0) ? Math.min(1, C.t / T_SWING) : 1;
      const e = (p < 0.5) ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      angle  = head + Math.PI;      // settle behind the tank
      dist   = 12.5 - 2.0 * e;
      height = SHOT.up.whip0 + (SHOT.up.whip1 - SHOT.up.whip0) * e;
      fov    = C.fromFov + (44 - C.fromFov) * e;
      /* Bank into the move and come out of it. A roll that does not return to
         zero is a bug you can see; this one is a sine, so it cannot overshoot. */
      roll = 0.10 * Math.sin(Math.PI * p);
    } else if(C.t <= T_REVEAL){
      /* --- BEAT 2: REVEAL ------------------------------------------------- */
      /* easeOutQuart: almost all of the travel happens early and the last
         third of the beat is the camera arriving. The deceleration is the whole
         effect Ã¢â‚¬â€ a linear arc here ends with the camera stopping dead, which is
         what a camera operator does when they have run out of shot. */
      const p = (plan.reveal > 0) ? Math.min(1, (C.t - T_SWING) / plan.reveal) : 1;
      const e = 1 - Math.pow(1 - p, 4);
      angle  = head + Math.PI + ((head + SHOT.frontAngle) - (head + Math.PI)) * e;
      dist   = 11.0 + (SHOT.reveal1 - 11.0) * e;
      height = SHOT.up.whip1 + (SHOT.up.reveal1 - SHOT.up.whip1) * e;
      fov    = 44 + (38 - 44) * e;
      /* Bank the other way, harder, because this is the shot the eye follows. */
      roll = -0.075 * Math.sin(Math.PI * p);
      C.settled = true;
    } else {
      /* --- BEAT 3: HOLD --------------------------------------------------- */
      /* Almost still: a small drift and a slow push-in over a full second. Anything
       more and it stops being a held shot and starts being another move, which
       would mean the ending never arrives. */
      const p = (plan.hold > 0) ? Math.min(1, (C.t - T_REVEAL) / plan.hold) : 1;
      const e = 0.5 - 0.5 * Math.cos(Math.PI * p);
      angle  = head + SHOT.frontAngle + (head + SHOT.driftTo - (head + SHOT.frontAngle)) * e;
      dist   = SHOT.reveal1 + (SHOT.hold1 - SHOT.reveal1) * e;
      height = SHOT.up.reveal1 + (SHOT.up.hold1 - SHOT.up.reveal1) * e;
      fov    = 38 + (35.5 - 38) * e;
      roll = 0;
      C.settled = true;
    }

    /* --- place the camera ------------------------------------------------- */
    P.set(
      t.x + Math.sin(angle) * dist,
      groundY + height,
      t.z + Math.cos(angle) * dist
    );

    if(!C.settled){
      /* BLEND OUT OF THE CAPTURED PLAY POSITION, AND ONLY ON THE WHIP.

         The factor is 1 on the first frame Ã¢â‚¬â€ P ends up exactly where the player
         was looking, so the shot starts without a jump Ã¢â‚¬â€ and 0 by the time the
         whip is 62% done, after which P is the hero pose and tracks the tank
         directly. Ease-out, because a whip pan is fast at the start and settles:
         the travel is over in about half a second and the rest of the beat is
         the bank and the lens coming in.

         The inversion of this (1 instead of 0 at the start) is worth naming,
         because it is silent and it looks like a camera bug: the camera flies
         out to the hero pose, then flies BACK to where the player was sitting,
         then snaps forward onto the tank. The snap is the part you notice, and
         it happens on the frame after the settle, which is a frame nobody
         attributes to the blend. */
      const blend = Math.min(1, (C.t <= T_SWING ? (T_SWING > 0 ? C.t / T_SWING : 1) : 0) / 0.62);
      P.lerp(C.fromPos, 1 - (1 - Math.pow(1 - blend, 5)));
    }

    /* World floor AND map edge, both. The play camera does both of these for
       the same reason: without them a closing shot on a tank that died against
       the boundary frames several hundred units of nothing. */
    try { this._clampCameraTarget(P); } catch(e){}
    try {
      const lim = (this.world && this.world.half || 500) - 8;
      P.x = Math.max(-lim, Math.min(lim, P.x));
      P.z = Math.max(-lim, Math.min(lim, P.z));
    } catch(e){}
    /* The aim point is clamped too, for the same reason _update clamps both
       halves of its own lookAt: a camera held at the floor aimed at a tank
       15,000 units under it points straight into the void. */
    const lookY = Math.max(groundY + hullH * SHOT.aimHull, this._worldFloorY() + 0.5);

    cam.position.copy(P);
    /* `up` is what produces the bank. lookAt() builds an orthonormal basis from
       it, so a tilted up-vector rolls the whole frame about its forward axis. */
    cam.up.set(Math.sin(roll), Math.cos(roll), 0);
    cam.lookAt(t.x, lookY, t.z);

    /* The lens. Pulled in over the shot to compress the arena behind the tank
       and pushed out of it again on the hold. A wide 55-degree frame with the
       camera eight units from a tank puts the whole map in shot and the tank
       reads as one more piece of scenery; at 35 degrees it is a portrait. */
    if(Math.abs(cam.fov - fov) > 0.01){
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  /* --- HUD ---------------------------------------------------------------- */

  /* The battle HUD reports a fight that is already over. Hidden for the shot,
     stashed on the instance so it comes back byte-identical.

     Only the elements _showHUDAfterCountdown knows about are touched, and
     deliberately so: that list is the set of elements that function has proven
     it can restore. Touching the whole #ui-layer and then restoring "opacity:"
     would put back the default rather than whatever inline value the player
     had Ã¢â‚¬â€ a hidden minimap button would come back visible. */
  _endCineHideHud(){
    if(this._endCineHudStashed) return;
    this._endCineHudStashed = true;
    const ids = ['hp-wrap','speed-readout','minimap-btn','menu-btn','super-btn'];
    const stash = [];
    for(const id of ids){
      const el = document.getElementById(id);
      if(!el) continue;
      stash.push({ el, op: el.style.opacity });
      el.style.opacity = '0';
    }
    this._endCineHud = stash;
    /* The gladiator banner and the spectator HUD are both full-screen-ish text
       that would otherwise sit on top of the victory pose. They are mode-owned
       and each has its own show/hide, so they are hidden without being marked
       as decided Ã¢â‚¬â€ the mode's own logic can still set them again if it wants. */
    const bel = document.getElementById('glad-banner');
    const spec = document.getElementById('spectator-hud');
    this._endCineExtra = [
      { el: bel, hidden: bel ? bel.classList.contains('hidden') : true },
      { el: spec, hidden: spec ? spec.classList.contains('hidden') : true },
    ];
    for(const e of this._endCineExtra){ if(e.el) e.el.classList.add('hidden'); }
  }

  _endCineRestoreHud(){
    const stash = this._endCineHud;
    this._endCineHud = null;
    this._endCineHudStashed = false;
    if(stash){
      for(const s of stash){
        try { s.el.style.opacity = s.op; } catch(e){}
      }
    }
    const extra = this._endCineExtra;
    this._endCineExtra = null;
    if(extra){
      for(const e of extra){
        try { if(e.el && !e.hidden) e.el.classList.remove('hidden'); } catch(e2){}
      }
    }
  }

  /* ===========================================================
     RESULTS SCREEN Ã¢â‚¬â€ the record of the battle just finished
     =========================================================== */

  /* WHERE THE RESULTS NUMBERS COME FROM, AND WHY THIS FUNCTION OWNS THEM

     results.js knows how to draw a results screen and nothing else. Every number
     is assembled here, from the live Game state, at the moment the match ends.

     That split matters more than it looks. The obvious alternative is to let
     results.js reach into `game` itself, and that would quietly break
     multiplayer: the host holds the authoritative totals for every tank in the
     match, while a client holds its own prediction of its own numbers and a
     near-useless copy of everyone else's. Reading through the tanks from one
     place, on whichever machine the player's Game object is, means the screen
     always describes that player's own battle Ã¢â‚¬â€ and for a client, its own copy
     of its own damage, which is what the player actually experienced. */

  _showResults(opts){
    opts = opts || {};
    /* TROPHY AWARDING. One trophy per win, awarded exactly once per battle.
       The catalogue (config.js TROPHIES) carries a `threshold` per trophy; the
       player's running win count decides which ones they have earned. This is
       the single chokepoint for "you won" - every victory path funnels through
       here, so the award happens once regardless of how the match ended. */
    if(opts.outcome === 'win' && !this._trophyAwardedThisMatch){
      this._trophyAwardedThisMatch = true;
      try {
        /* Read through loadSettings() rather than trusting whichever copy of
           the settings object this class happens to hold: the menu, the game
           and the save file can hand out different snapshots, and only the
           shared loader sees the truth for trophyCount. */
        const s = (typeof loadSettings === 'function') ? loadSettings() : this.settings;
        if(s){
          s.trophyCount = (s.trophyCount || 0) + 1;
          const owned = Array.isArray(s.trophyOwnedIds) ? s.trophyOwnedIds : (s.trophyOwnedIds = []);
          const cat = (typeof getTrophyCatalog === 'function') ? getTrophyCatalog() : [];
          for(const t of cat){
            if(typeof t.threshold === 'number' && s.trophyCount >= t.threshold && owned.indexOf(t.id) < 0){
              owned.push(t.id);
              if(typeof awardTrophy === 'function') awardTrophy(t.id);
            }
          }
          if(typeof saveSettings === 'function') saveSettings(s);
          if(typeof Menu !== 'undefined' && Menu.refreshProfile) Menu.refreshProfile();
          if(typeof window !== 'undefined' && typeof window.updateTrophyProgressButton === 'function') window.updateTrophyProgressButton();
        }
      } catch(e){}
    }
    if(typeof Results === 'undefined') return;

    const me = this.localTank;
    /* The real sides, needed for the win/loss outcome, for grouping the rows, and
       for the board headings.

       `theirTeam` was removed from here when the headings were made fixed text,
       on the reasoning that nothing needed the opposing side's id any more. That
       turned out to be wrong, and the failure was silent in the worst way: the
       headings were put back to reading the real teams, and `theirTeam` was still
       gone, so _showResults threw a ReferenceError on the way to Results.show().
       The screen never rendered, the 8-second watchdog in _showResults then fired
       because nothing had been shown, and it hid the overlay and sent the player
       to the menu Ã¢â‚¬â€ so pressing the skip shortcut appeared to do nothing except
       eject you from the battle. */
    const myTeam    = (me && me.team) || 'blue';
    const theirTeam = myTeam === 'blue' ? 'red' : 'blue';

    const real = this.tanks.filter(t => !t.isDummy);

    /* TEAMING. The player is shown on the left under their own colour and the
       opposition on the right, whichever side they happened to be on Ã¢â‚¬â€ the side
       is decided by which spawn point they took, so it is not always blue and
       hard-coding "blue is mine" would put half of all players' own team on the
       wrong side of the screen. */
    const mine   = real.filter(t => (t.team || myTeam) === myTeam);
    const theirs = real.filter(t => (t.team || myTeam) !== myTeam);

    const toRow = (t) => ({
      name:    t.name || 'Unknown',
      tankId:  (t.def && t.def.id) || null,
      damage:  Math.round(t.damageDealt || 0),
      kills:   t.kills || 0,
      assists: t.assists || 0,
      isYou:   t === me,
    });

    /* Ranked by damage, then kills Ã¢â‚¬â€ the same order the in-battle scoreboard
       uses, so a player does not have to re-learn which column decides the
       order between the two screens. */
    const rank = (list) => list.slice().sort((a, b) =>
      (b.damageDealt || 0) - (a.damageDealt || 0) || (b.kills || 0) - (a.kills || 0));

    const rankedMine = rank(mine);
    const myIndex = rankedMine.indexOf(me);

    /* OVERALL PLACE. In team modes the leaderboards are the two team columns, so
       an overall rank would be a number referring to nothing on screen Ã¢â‚¬â€ but
       gladiator has no teams, and there the placement the mode already assigns
       is the only place figure that means anything. `opts.place` wins when the
       caller has one (gladiator passes it); otherwise it is left off rather
       than invented. */
    let place = (opts.place !== undefined) ? opts.place : null;
    if(place == null && (this.glad || mine.length === 0)){
      place = me ? (me.placement || null) : null;
    }

    /* MISSIONS.

       Only the ones this battle actually moved. Listing every quest the player
       owns would be a quest log, not a result Ã¢â‚¬â€ the quest screen already exists
       and one click away Ã¢â‚¬â€ so the results screen shows the lines that changed.

       How that is known: the mission state is snapshotted at battle start and
       compared here. Progress alone cannot do it, because a quest already at
       2/3 before the battle looks identical to one this battle advanced to
       2/3, and only the second one belongs on a results screen. */
    const missions = [];
    try {
      if(typeof Missions !== 'undefined' && Missions.listProgress){
        const before = this._missionSnapshot || {};
        Missions.listProgress().forEach(q => {
          const prev = (before[q.bucket] || {})[q.id];
          /* With no snapshot to compare against, there is no way to tell what
             this battle moved, and showing every quest is the quest log, not a
             result. So show none of them rather than show all of them. */
          if(!prev) return;

          const wasDone = prev.progress >= q.target || prev.claimed;
          const advanced = q.progress > prev.progress;

          /* SHOW IT IF THE BATTLE MOVED IT, OR IF THE BATTLE FINISHED IT.

             That is the whole rule, and it is deliberately an OR. A quest this
             battle pushed forward is worth a line so the player can see how
             close they are; a quest this battle COMPLETED is worth more than
             that, because finishing something is the actual reward.

             The exclusion that matters is the third case Ã¢â‚¬â€ untouched by the
             battle. Not moved and not newly finished means this line is about
             something the player did hours ago, and it belongs on the quest
             screen, one click away. Measured: with every quest carried forward
             this condition was inverted enough to admit all eleven quests, and
             the results screen's mission panel was a complete duplicate of the
             quest log. */
          const finishedNow = q.done && !wasDone;
          if(!advanced && !finishedNow) return;

          missions.push({
            name:     q.title,
            progress: q.progress,
            target:   q.target,
            done:     q.done,
            /* `finished` drives the green tick: it means "this battle did it",
               so a quest that was already claimed never ticks green as though
               it had just been earned. */
            finished: finishedNow,
          });
        });
      }
    }catch(e){
      /* A results screen must never be the thing that throws. If missions
         cannot be read the screen still shows every other number. */
    }

    const data = {
      outcome:  opts.outcome || 'loss',
      headline: opts.headline || (opts.outcome === 'win' ? 'VICTORY' : 'DEFEAT'),
      place:    place,

      /* Carried straight through to the screen. It has to travel this far rather
         than being rendered here, because the one player who most needs to be told
         the battle was ended early is the OTHER one Ã¢â‚¬â€ they did not press anything,
         and "DEFEAT" over their own statistics is a lie about a match they were
         pulled out of. */
      skipped: !!opts.skipped,

      /* THE HEADINGS FOLLOW THE ROWS UNDERNEATH THEM.

         These were hardcoded: your board was always headed "Blue team" with the
         blue CSS class, and the enemy's always "Red team", whatever side you
         actually spawned on. That is wrong twice over.

         It contradicts the game's own rule Ã¢â‚¬â€ your team IS the side you spawned
         on, decided by your spawn point, so half of all matches put you on red Ã¢â‚¬â€
         and it is visibly wrong on screen. The rows in the left column are the
         actual `teams.mine` list, grouped by real team, so a red player saw
         their own red tanks stacked under a heading that said BLUE TEAM, with a
         blue stripe down the side of it. Measured on a live two-player match:
         the player was on red and the board above their own tanks read
         "BLUE TEAM".

         Headings and grouping now come from the same `myTeam`, so the two can
         never disagree. A note on the CSS class: it is the accent colour of the
         border stripe, not the name of the team, and it is derived from the same
         value for the same reason. */
      myTeamName:   myTeam === 'blue' ? 'Blue team' : 'Red team',
      theirTeamName: theirTeam === 'blue' ? 'Blue team' : 'Red team',
      myTeamClass:   myTeam,
      theirTeamClass: theirTeam,

      stats: {
        damage:    Math.round((me && me.damageDealt) || 0),
        kills:     (me && me.kills) || 0,
        assists:   (me && me.assists) || 0,
        teamPlace: myIndex >= 0 ? (myIndex + 1) : 1,
        teamSize:  Math.max(1, mine.length),
      },

      /* The battle counter, not the wallet. `_awardBattleCash` adds to both, and
         the wallet may also have been spent from in a box or the shop while the
         battle ran Ã¢â‚¬â€ a difference against the wallet would under-report what the
         battle earned, or report a negative number. */
      rewards: { cash: this._battleCash || 0 },

      missions: missions,

      teams: {
        mine:   rankedMine.map(toRow),
        theirs: theirs.slice().sort((a, b) =>
          (b.damageDealt || 0) - (a.damageDealt || 0) || (b.kills || 0) - (a.kills || 0)).map(toRow),
      },

      tankId:   (me && me.def && me.def.id) || (this.selectedTank || 'coolbuddy'),
      tankName: (me && me.name) || 'You',
    };

    /* CONTINUE leaves the match. The button has to end the battle, not just
       hide an overlay Ã¢â‚¬â€ a hidden results screen over a still-running match is
       a frozen game the player cannot get out of except with Escape. */
    const prevOnContinue = Results.onContinue;
    Results.onContinue = () => {
      Results.onContinue = prevOnContinue;
      try { Results.hide(); } catch(e){}
      this.leaveToMenu();
    };

    /* One finish per battle. Set BEFORE anything is presented Ã¢â‚¬â€ before the
       cinematic, before Results.show() Ã¢â‚¬â€ so a second match ending during the
       same battle cannot stack another shot or another screen on top. */
    this._resultsShown = true;

    /* THE CLOSING SHOT, THEN THE SCREEN.

       Everything above has already happened by now: the numbers are read, the
       missions are compared against the pre-battle snapshot, and the CONTINUE
       handler is wired. So the shot is pure presentation laid on top of a
       finished record, and it cannot change a single number on it Ã¢â‚¬â€ the data
       object was sealed before a frame of cinematic ran.

       If the cinematic declines (no camera, no tank, reduced-motion plan, a
       document with no body), it returns false and the screen is presented
       immediately. The plain path is the fallback, never the exception. */
    let started = false;
    try { started = this._beginEndCinematic(data); } catch(e){ started = false; }
    if(started) return;
    this._presentResults(data);
  }

  /* ACTUALLY PUT THE RESULTS SCREEN ON SCREEN.

     Split out of _showResults so there is exactly one place that calls
     Results.show(), whether it was reached straight from _showResults or at the
     end of the closing cinematic. Two call sites meant two watchdog timers and
     two chances to forget one of them.

     The watchdog starts HERE, not in _showResults, and that is the whole reason
     for the split: it measures the time since the screen was actually asked
     for. Started before a four-second cinematic, the eight seconds it allows
     would have only four left to build the screen in, and a slow machine would
     be dumped back to the main menu having never seen their own results. */
  _presentResults(data){
    /* The results screen's own "there is a screen over the game" marker. NOT
       set before the cinematic: whatever a future stylesheet does with
       `res-open` (today nothing does Ã¢â‚¬â€ it is a hook), it means "the results
       screen is up", and during a closing shot that is a lie. */
    try { document.body.classList.add('res-open'); } catch(e){}

    /* Cleared BEFORE the build, so the watchdog below is testing THIS attempt
       and not the success of the last match. `Results._shownOk` is only set at
       the very end of a successful _buildDOM, so without this a first-match
       failure would be masked by the second match's success. */
    try { if(typeof Results !== 'undefined') Results._shownOk = false; } catch(e){}

    try { Results.show(data); }
    catch(e){ console.warn('[results] show failed:', e); }

    /* A safety net, and it checks rather than assumes.

       If the screen never came up Ã¢â‚¬â€ the tank model failed to load, a WebGL
       context was refused, the data was a shape it could not draw Ã¢â‚¬â€ the player
       would be stranded in a finished battle with nothing to click, which is
       strictly worse than going to the menu. Results._shownOk is only set at the
       very end of a successful build, so this can never dismiss a screen that
       worked; it just refuses to leave anyone stuck.

       Cleared on the next _showResults so a match that ends while a previous
       match's watchdog is still pending cannot have that watchdog decide its
       fate. */
    clearTimeout(this._resultsWatchdog);
    this._resultsWatchdog = setTimeout(() => {
      this._resultsWatchdog = null;
      if(!this._resultsShown || (typeof Results !== 'undefined' && Results._shownOk)) return;
      try { Results.hide(); } catch(e){}
      this.leaveToMenu();
    }, 8000);
  }

  /* ===========================================================
     COMBAT HOOKS
     =========================================================== */
  ejectShell(tank){
    if(this._noParticles) return;
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
    // Cosmetic: the model's gun node snaps back on the shot and eases home.
    if(tank && tank.onFired) tank.onFired();
    const muz = tank.muzzle();
    const pos = muz.pos;
    /* MODE 1 PITCH: fire where you aim. The crosshair's vertical offset IS a
       real gun elevation here Ã¢â‚¬â€ the shell's direction is pitched by the same
       angle the aim line drew. Mortar solves its own trajectory; flame is a
       fan, not a bullet, and stays flat. */
     let dir = new THREE.Vector3(Math.sin(tank.turretAngle), 0, Math.cos(tank.turretAngle));
     if(tank === this.localTank && this._aimPitch && this.cameraMode === 'dynamic' &&
        tank.def.shellType !== 'mortar' && tank.def.shellType !== 'flame'){
       dir = this._pitchDir(muz.dir, this._aimPitch);
     }
     /* Guard: a NaN/zero direction would make the shell tracer render as a
        giant white line to map centre and hide the real bullet. Fall back to
        the tank's heading so the shot always flies. */
     if(!isFinite(dir.x) || !isFinite(dir.y) || !isFinite(dir.z) || dir.lengthSq() < 1e-8){
       dir = new THREE.Vector3(Math.sin(tank.turretAngle || 0), 0, Math.cos(tank.turretAngle || 0));
       if(!isFinite(dir.x) || !isFinite(dir.y) || !isFinite(dir.z) || dir.lengthSq() < 1e-8){
         dir = new THREE.Vector3(0, 0, 1);
       }
     }
    const y = pos.y;
    if(window.Audio && Audio.click){
      const vol = tank === this.localTank ? 1 : 0.45;
      if(tank.def.shellType === 'flame'){ if(Audio.flame) Audio.flame(vol); }
      else if(tank.def.shellType === 'vortex_mine'){ if(Audio.click) Audio.click('gun', vol * 0.7); }
      else if(tank.def.shellType === 'shotgun'){ Audio.click('gun', vol); }
      else Audio.click('gun', vol);
    }
    if(this.isFancy && tank === this.localTank) this.addShake(tank.def.shellType === 'shotgun' ? 0.22 : 0.12);
    const _canSpawnLocal = this.mode !== 'client' && !(this.mode === 'freeroam' && typeof NakamaNet !== 'undefined' && !NakamaNet.isHost);
    if(_canSpawnLocal){
      if(tank.def.shellType === 'vortex_mine'){
        /* The mine is THROWN from the muzzle, not placed on the ground in
           front of the tank. `_mineFrom` carries the launch point so the mine
           can fly an arc from the barrel to the target rather than blinking
           into existence at it Ã¢â‚¬â€ the whole complaint with the old version was
           that nothing happened between the shot and the mine already being
           there. The landing point is still `mineMaxRange` ahead along the
           heading, unchanged. */
        var mineMaxRange = tank.def.mineMaxRange || 10;
        var fwdX = Math.sin(tank.heading);
        var fwdZ = Math.cos(tank.heading);
        var mineX = tank.x + fwdX * mineMaxRange;
        var mineZ = tank.z + fwdZ * mineMaxRange;
        var mdef = Object.create(tank.def);
        mdef._mineFrom = { x: pos.x, y: y, z: pos.z };
        var m = new Landmine(tank, {x:mineX, y:0.18, z:mineZ}, mdef);
        m.attach(this.scene); this.projectiles.push(m);
      } else if(tank.def.shellType === 'shotgun'){
        /* Both key spellings are honoured. Burst declares `pellets` /
           `pelletSpread` / `pelletGlow`, which read more naturally for a tank
           whose whole identity is the pellet count; the older shotgun keys are
           still accepted so nothing that predates this loses its tuning.

           This mattered: the block below used to read ONLY `shotgunPellets`, so
           Burst's carefully-set ten pellets were silently ignored and it fired
           the default EIGHT at the default spread Ã¢â‚¬â€ a spread gun firing the
           wrong fan, with no error anywhere to say so. Reading the tank's own
           keys first is the whole fix. */
        var pellets = tank.def.pellets || tank.def.shotgunPellets || 8;
        var spread = tank.def.pelletSpread || tank.def.shotgunSpread || 0.25;
        var halfAngle = Math.atan2(dir.x, dir.z);
        for(var pi = 0; pi < pellets; pi++){
          var angleOff = (Math.random() - 0.5) * spread * 2;
          var a = halfAngle + angleOff;
          var sd = new THREE.Vector3(Math.sin(a), (Math.random()-0.5)*0.08, Math.cos(a));
          /* _isShotgunPellet goes in the DEF, not on the shell afterwards: Shell
             builds its mesh inside the constructor, so a flag set on the line
             after this arrives would come too late to have any effect. */
          var sp = new Shell(tank, new THREE.Vector3(pos.x, y, pos.z), sd, {shellSpeed: tank.def.shellSpeed, shellRange: tank.def.shellRange, damage: tank.def.damage, _isShotgunPellet: true}, this.physicsWorld, tank.getWorldVelocity());
          sp.attach(this.scene); this.projectiles.push(sp);
          /* No pellet tracer. Shells no longer draw a streak, so pellets do
             not either -- they were given one here only because ordinary shells
             had one and a bare shotgun looked disconnected from its own tank. */
        }
        /* THE MUZZLE FLASH IS TEN YELLOW DOTS, because that is what the gun does.
           Count and colour both come off the def so the flash and the fan are
           visibly the same shot: `pellets` glowing motes, one per pellet, tinted
           `pelletGlow`. Drawing an arbitrary multiple of them in a hardcoded
           yellow is how a shotgun ends up looking like something else. */
        if(this.spawnBurst){
          this.spawnBurst(pos.x, y, pos.z, {
            count: pellets, tex: 'flare',
            speed: 20, size: 0.34, life: 0.16, rise: 0, gravity: 0,
            biasX: dir.x, biasZ: dir.z, spread: spread * 0.6,
            color: tank.def.pelletGlow || 0xffee44
          });
        }
        if(tank.def.knockbackForce){
          var kb = tank.def.knockbackForce;
          var kbTilt = tank.def.knockbackTilt || 0.3;
          tank.x -= Math.sin(tank.heading) * kb * 0.04;
          tank.z -= Math.cos(tank.heading) * kb * 0.04;
          if(tank._physBody){
            try {
              var lv = tank._physBody.linvel();
              tank._physBody.setLinvel({x: lv.x - Math.sin(tank.heading)*kb, y: lv.y, z: lv.z - Math.cos(tank.heading)*kb}, true);
            } catch(e){}
          }
          tank._shotgunTilt = kbTilt;
        }
      } else {
        const p = tank.def.shellType==='flame'
          ? new FlameCone(tank, new THREE.Vector3(pos.x, y, pos.z), dir, tank.def)
          : tank.def.shellType==='mortar'
          /* ARTILLERY. The velocity is SOLVED, not taken from shellSpeed: the
             shell has to arrive at the impact point the aim line just drew, so
             it is handed the exact same vector _mortarAim produced. See
             artilleryVelocity in projectile.js for why it is a closed form
             rather than a simulated arc. */
          ? new Shell(tank, new THREE.Vector3(pos.x, y, pos.z), dir,
                      Object.assign({}, tank.def, {_launchVel: this._mortarAim(tank, pos).vel}),
                      null, null)
          : new Shell(tank, new THREE.Vector3(pos.x, y, pos.z), dir, tank.def, this.physicsWorld, tank.getWorldVelocity());
        p.attach(this.scene); this.projectiles.push(p);
        /* No trail spawned. The shell is the bullet model now and the streak
           behind it is gone, so there is nothing to start. */
      }
    }
    if(tank.def.shellType === 'flame') this._ensureHelixVideo(tank);

    /* The barrel blast Ã¢â‚¬â€ a white-hot flash with red in it that turns straight
       to black smoke Ã¢â‚¬â€ is now the ONLY thing that plays when a tank fires.
       The two picture flashes that used to spawn here (the small sprite flash
       and the flat artwork lying on the ground) are gone: three flashes at
       the same spot read as a mess, and the smoke was being hidden under the
       two of them. The functions are still there, unused, in case the art
       ever wants to come back. */
    if(typeof MuzzlePop !== 'undefined' && !(this.settings && this.settings.muzzleFx === false)){
      MuzzlePop.play(this.scene, pos, dir, tank === this.localTank, this.camera ? this.camera.position : null, tank);
      /* The point light on the barrel stays: the cartoon cloud is the SHAPE of
         the shot, and the light is what makes the tank's own metal flare when
         it fires. Without it the gun looks like it is firing silently. */
      this._muzzleLight(pos.x, pos.y + 0.2, pos.z, tank);
    }
  }

  /* The flash picture: the muzzle-flash art laid flat at the firing point so
     the chase camera reads it Ã¢â‚¬â€ its face to the sky, its left edge pointing
     back at the gun (so the point of the flash leads the shot). It holds for a
     beat, then draws in from every side and fades away, half a second played
     1.2Ãƒâ€” faster. */
  _muzzlePictureTex(){
    if(!this._picFlashTex){
      this._picFlashTex = new THREE.TextureLoader().load('assets/muzzle-flash.webp?v=20260929b');
      this._picFlashTex.colorSpace = THREE.SRGBColorSpace;
    }
    return this._picFlashTex;
  }

  _muzzlePicture(pos, dir){
    if(this.settings && this.settings.muzzleFx === false) return;
    const tex = this._muzzlePictureTex();
    if(!tex.image) return;                       /* art still downloading Ã¢â‚¬â€ skip */
    if(!this._picFlashGeo) this._picFlashGeo = new THREE.PlaneGeometry(1, 1);
    if(!this._picFlashPool) this._picFlashPool = [];
    if(!this._picFlashes) this._picFlashes = [];
    const FLASH_LIFE = 0.4167;               /* 0.5s played 1.2Ãƒâ€” faster */

    const W = this.isUltra ? 6.6 : (this.isFancy ? 5.4 : 4.5);   /* along the shot */
    const H = W * (87 / 89);                      /* the picture's own shape */

    let m = this._picFlashPool.pop();
    if(!m && this._picFlashes && this._picFlashes.length >= 10){
      /* Every tank in a firefight fires, and each shot used to add another
         card until the pool ran dry Ã¢â‚¬â€ twenty tanks firing at once piled up
         well over a dozen full-size transparent quads on screen, which is pure
         overdraw. Past ten, the oldest card is simply restarted: nobody can
         see which of a dozen simultaneous muzzle flashes was the oldest. */
      const oldest = this._picFlashes[0];
      oldest.life = FLASH_LIFE;
      oldest.maxLife = FLASH_LIFE;
      m = oldest.mesh;
    }
    if(!m){
      m = new THREE.Mesh(this._picFlashGeo, new THREE.MeshBasicMaterial({
        map: this._picFlashTex,
        /* Drawn straight, not added on top: adding a white shape to the
           scenery bleached it out to a cold wash. The picture itself is
           plain white, so this tint is the only colour it has Ã¢â‚¬â€ a hot
           fire orange makes it read as muzzle light instead of daylight. */
        color: 0xff6a14,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        side: THREE.DoubleSide,
        /* Everything else in the scene runs through the filmic tone curve,
           which pulls saturated colour toward grey Ã¢â‚¬â€ a flash has to stay
           hot, so it opts out and keeps its colour. */
        toneMapped: false
      }));
      m.frustumCulled = false;
      m.renderOrder = 999;
    }
    this.scene.add(m);

    const rawX = dir ? (dir.x || 0) : 0;
    const rawZ = dir ? (dir.z || 0) : 1;
    const len = Math.hypot(rawX, rawZ) || 1;
    const fx = rawX / len, fz = rawZ / len;       /* shot direction, flat */

    m.rotation.order = 'YXZ';
    m.rotation.set(-Math.PI / 2, Math.atan2(-fz, fx), 0);   /* face up, point forward */
    m.position.set(pos.x + fx * W * 0.30, pos.y + 0.12, pos.z + fz * W * 0.30);
    m.scale.set(W, H, 1);
    m.material.opacity = 1;
    m.visible = true;

    this._picFlashes.push({mesh: m, life: FLASH_LIFE, maxLife: FLASH_LIFE, w: W, h: H});
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
    /* THE ONE PIECE OF VIDEO THAT REALLY WAS OVER-BUDGETED.

       This strip is a 30fps clip played at FIVE TIMES NORMAL SPEED, so the
       decoder is presenting ~150 frames a second and the renderer is uploading
       whichever of them is current once per rendered frame -- 60 uploads a
       second of a full-frame RGBA texture, for a strip that is only ever seen
       through a luminance key.

       VideoVFX.paceTexture caps the UPLOAD rate at VideoVFX.maxUploadHz (45) and
       refuses the write outright when the decoder has not actually presented a
       new frame. It is worth the most here and nothing at all on the 24/30fps
       one-shot explosions, which is why it is not a blanket "slow the videos
       down" switch -- see the note in video-vfx.js. */
    VideoVFX.paceTexture(tex, el);
    tex.center.set(0.5, 0.5);
    tex.rotation = Math.PI / 2;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.x = -1;
    tex.offset.x = 1;
    const range = tank.def.shellRange || 25;
    const tanHalf = tank.def.fireConeHalfAngle || 0.18;
    const halfW = range * tanHalf;
    const w = halfW * 2;
    const h = range;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.translate(0, h / 2, 0);
    const mat = this._videoMaterial(tex, { opacity: 0.0, chromaKey: 'darkOnly', depthTest: false });
    if(!(window.__isWebGPU && mat.isNodeMaterial)){
      mat.onBeforeCompile = s => { s.fragmentShader = window.glslInject(s.fragmentShader, 'float _lum=dot(outgoingLight,vec3(0.299,0.587,0.114));if(_lum<0.06)discard;'); };
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.set(-Math.PI / 2, 0, Math.PI);
    if(tank.barrelEnd) { mesh.position.copy(tank.barrelEnd.position); mesh.position.x += 0.35; }
    mesh.scale.set(0.1, 0.1, 0.1);
    tank.turretGroup.add(mesh);
    this._helixVideos.set(tank.id, { mesh, tex, el, parent: tank.turretGroup, firing: true, fadeTimer: 0, growTimer: 0 });
  }

  /* Material for a video VFX plane.

     The chroma key is the whole point of these clips: they are shot against a
     flat backdrop that has to be thrown away, leaving only the fire. On WebGL
     that is done with onBeforeCompile. `onBeforeCompile` DOES NOT EXIST in the
     WebGPU build (it only speaks node materials), so on WebGPU the key was
     silently dropped and every keyed clip drew its own black rectangle across
     the tank Ã¢â‚¬â€ a real bug, caught by looking at frames instead of trusting the
     code. The node material below applies the identical luminance test and
     discards the same pixels. */
  _videoMaterial(tex, o){
    const opts = o || {};
    if(opts.chromaKey && window.__isWebGPU && window.TSL && window.WebGPU){
      const T = window.TSL, W = window.WebGPU;
      const mat = new W.MeshBasicNodeMaterial();
      const t = T.texture(tex, T.uv());
      const lum = T.dot(t.rgb, T.vec3(0.299, 0.587, 0.114));
      /* 'darkOnly' = the helix strip, which keys on black only. The full key
         drops near-white as well, which is what the explosion clips need. */
      const bad = (opts.chromaKey === 'darkOnly')
        ? lum.lessThan(0.06)
        : T.or(lum.lessThan(0.06), lum.greaterThan(0.97));
      T.Discard( bad );
      mat.colorNode = T.vec4(t.rgb, t.a.mul(opts.opacity != null ? opts.opacity : 1));
      mat.transparent = true;
      mat.depthWrite  = false;
      mat.depthTest   = (opts.depthTest === false) ? false : true;
      mat.side        = THREE.DoubleSide;
      mat.toneMapped  = false;
      return mat;
    }
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: opts.opacity != null ? opts.opacity : 1,
      blending: opts.blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false, depthTest: (opts.depthTest === false) ? false : true, side: THREE.DoubleSide,
    });
    if(opts.chromaKey && opts.chromaKey !== 'darkOnly'){
      mat.onBeforeCompile = s => {
        s.fragmentShader = window.glslInject(
          s.fragmentShader,
          'float _lum=dot(outgoingLight,vec3(0.299,0.587,0.114));if(_lum<0.06||_lum>0.97)discard;'
        );
      };
    }
    return mat;
  }

  /* ---- Video VFX: fire on destroyed turret + explosion on bullet hit ---- */
  _createVideoPlane(videoUrl, size, opts){
    const o = opts || {};
    const el = document.createElement('video');
    el.src = videoUrl;
    el.muted = true;
    el.loop = !!o.loop;
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.playbackRate = o.playbackRate || 1;
    el.play().catch(()=>{});
    const tex = new THREE.VideoTexture(el);
    /* Same cap as the helix strip. Explosions are 30fps clips, so on a browser
       with requestVideoFrameCallback this changes nothing at all -- three is
       already only re-uploading when the decoder presents -- and that is the
       correct outcome, not a missed optimisation. It earns its keep on the
       clips that DO run at or above refresh rate, and on the browsers where
       rVFC is missing and three falls back to re-uploading every rendered
       frame regardless. */
    VideoVFX.paceTexture(tex, el);
    tex.minFilter = THREE.LinearFilter;
    const mat = this._videoMaterial(tex, {
      opacity: o.opacity || 1,
      blend: o.blend,
      chromaKey: o.chromaKey,
    });
    // Height is what the caller asks for; WIDTH follows the clip's real
    // aspect ratio. These VFX clips are all 16:9 Ã¢â‚¬â€ they used to be forced
    // into a 0.6 "portrait" rectangle, which squashed them ~3x horizontally
    // (and is a big part of why the explosion looked wrong).
    const h = size;
    const geo = new THREE.PlaneGeometry(h * (o.aspect || (16 / 9)), h);
    const mesh = new THREE.Mesh(geo, mat);
    // Correct from the file's real dimensions as soon as metadata is in.
    const fitAspect = () => {
      if(!el.videoWidth || !el.videoHeight) return;
      const target = geo.parameters.height * (el.videoWidth / el.videoHeight);
      const cur = geo.parameters.width;
      if(!cur || Math.abs(target - cur) < 0.001) return;
      const k = target / cur;
      const pos = geo.attributes.position;
      for(let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) * k);
      pos.needsUpdate = true;
      geo.parameters.width = target;
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
    };
    el.addEventListener('loadedmetadata', fitAspect);
    if(el.readyState >= 1) fitAspect();
    return { mesh, tex, el, mat, life: o.life || 2, maxLife: o.life || 2, fadeTimer: 0,
             basePos: new THREE.Vector3(), baseH: h, follow: null };
  }

  _spawnVideoFire(tank){
    if(!tank || !tank.turretGroup) return;
    const url = 'assets/vfx/TL_vfxfire.mp4';
    if(!this._videoFireEffects) this._videoFireEffects = [];
    if(!this._videoFirePool) this._videoFirePool = [];

    /* This is the single most expensive thing that can happen in a battle, and
       it used to happen on EVERY tank death, uncapped:

         * a new <video> element and a new video DECODER thread
         * a new VideoTexture (a GPU allocation)
         * a new PlaneGeometry
         * and, on the WebGPU renderer, a brand new MeshBasicNodeMaterial --
           which means a whole new WGSL PIPELINE, compiled on the spot. The file's
           own notes elsewhere put that at ~100ms each.

       life was 48 seconds, so the elements also piled up for the whole minute
       after a big wipe. Several tanks dying in one frame stacked several
       pipeline builds into that frame: a second of solid freeze, at a random
       moment, that felt nothing to do with what was happening on screen.

       The explosion path directly below already had the answer -- a small fixed
       pool, recycled -- and this one simply never got it. Same fix here. */
    const MAX_LIVE = 4;
    let info;
    if(this._videoFireEffects.length >= MAX_LIVE){
      info = this._videoFireEffects.shift();     // recycle the oldest live one
    } else {
      info = this._videoFirePool.pop();
    }
    if(!info){
      info = this._createVideoPlane(url, 2.4, { loop: true, opacity: 0.9, chromaKey: true, playbackRate: 1.5, aspect: 16 / 9 });
      info.life = 48; info.maxLife = 48;
    } else {
      try { info.el.currentTime = 0; info.el.play().catch(()=>{}); } catch(e){}
      info.mat.opacity = 0.9;
      info.life = info.maxLife = 48;
    }
    // Parented to the SCENE, not the turret: it follows the wreck by position
    // instead of inheriting the turret's yaw, which used to leave the flame
    // pointing edge-on (or flat on the deck) instead of at the camera.
    info.follow = tank;
    if(info.mesh.parent !== this.scene) this.scene.add(info.mesh);
    this._placeVideoGround(info, tank.x, tank.y || 0, tank.z);
    this._videoFireEffects.push(info);
  }

  _spawnVideoExplosion(x, y, z){
    if(!this._videoExplosions) this._videoExplosions = [];
    if(!this._videoExpPool) this._videoExpPool = [];
    // Building a <video> element and spinning up its decoder is one of the most
    // expensive single operations in this game (tens of ms), and it used to
    // happen on every single shell?tank hit. A small fixed pool is recycled
    // instead, so heavy fire never allocates a new video mid-fight.
    const MAX_LIVE = 3;
    const url = 'assets/vfx/TL_vfxexplosion.mp4';
    let info;
    if(this._videoExplosions.length >= MAX_LIVE){
      info = this._videoExplosions.shift();          // recycle the oldest live one
    } else {
      info = this._videoExpPool.pop();
    }
    if(!info){
      info = this._createVideoPlane(url, 2.6, { loop: false, opacity: 1, chromaKey: true, playbackRate: 1.2, life: 1.5, aspect: 16 / 9 });
    } else {
      try { info.el.currentTime = 0; info.el.play().catch(()=>{}); } catch(e){}
      info.mat.opacity = 1;
      info.life = info.maxLife = 1.5;
    }
    this._placeVideoGround(info, x, y, z);
    if(info.mesh.parent !== this.scene) this.scene.add(info.mesh);
    this._videoExplosions.push(info);
  }

  /* Face a video plane squarely at the camera with the centre of its BOTTOM
     edge pinned to (x, y, z) Ã¢â‚¬â€ the exact point the shell hit. It used to be
     laid flat 1.5 units above the ground (rotation.x = -PI/2), which read as
     "spawns at a stupid rotation". A full billboard (not just a yaw turn) so
     it stays face-on even when the player zooms all the way out to top-down. */
  _placeVideoGround(info, x, y, z){
    info.basePos.set(x, y, z);
    info.baseH = (info.mesh.geometry && info.mesh.geometry.parameters.height) || info.baseH || 4.0;
    this._faceVideoToCamera(info, 1);
    return info;
  }

  _faceVideoToCamera(info, scale){
    const cam = this.camera;
    const m = info.mesh;
    if(!cam || !m) return;
    if(!_vfN){ // module scratch Ã¢â‚¬â€ allocated once, no per-frame garbage
      _vfN = new THREE.Vector3(); _vfRight = new THREE.Vector3();
      _vfUp = new THREE.Vector3(); _vfCamUp = new THREE.Vector3();
      _vfRot = new THREE.Matrix4();
    }
    _vfN.subVectors(cam.position, info.basePos);
    if(_vfN.lengthSq() < 1e-6) _vfN.set(0, 0, 1); else _vfN.normalize();
    // Camera's own up, so the plane degrades to a flat ground decal when the
    // camera swings overhead instead of collapsing to an edge-on sliver.
    _vfCamUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
    _vfRight.crossVectors(_vfCamUp, _vfN);
    if(_vfRight.lengthSq() < 1e-8) _vfRight.set(1, 0, 0); else _vfRight.normalize();
    _vfUp.crossVectors(_vfN, _vfRight);
    if(_vfUp.lengthSq() < 1e-8) _vfUp.copy(_vfCamUp); else _vfUp.normalize();
    _vfRot.makeBasis(_vfRight, _vfUp, _vfN);
    m.quaternion.setFromRotationMatrix(_vfRot);
    m.scale.setScalar(scale);
    // centre of the bottom edge lands exactly on the anchor point
    m.position.copy(info.basePos).addScaledVector(_vfUp, info.baseH * scale * 0.5);
  }

  /* Retire a paced video texture.

     VideoVFX.paceTexture installs its own requestVideoFrameCallback loop to decide
     when the texture is worth re-uploading, and that callback re-arms itself
     every time it fires. three's own `tex.dispose()` cancels THREE's callback,
     not this one -- so disposing a paced texture the ordinary way leaves a
     retired explosion holding its <video> element and its decoded frames alive
     for the rest of the session. The symptom is a slow leak you only notice
     after the tab has been open an hour, which is exactly the kind of bug that
     gets blamed on something else.

     Safe on an unpaced texture too, which is why every video VFX teardown in
     this file goes through here rather than special-casing the ones that happen
     to be paced: _unpaceTexture's only other job is deleting the shadowed
     accessor, and `delete` on a property that was never defined is a no-op. */
  _disposeVideoTex(tex, el){
    if(!tex) return;
    try {
      if(typeof VideoVFX !== 'undefined') VideoVFX._unpaceTexture(tex, el, tex.__vfxPacer);
    } catch(e){}
    try { tex.dispose(); } catch(e){}
  }

  _updateVideoVFX(dt){
    this._stepVideoList(this._videoExplosions, dt, 'exp');
    this._stepVideoList(this._videoFireEffects, dt, 'fire');
  }

  /* `which` names the free list a retired effect goes back to. Both lists are
     pooled now: creating a video effect is one of the most expensive operations
     in the game, so recycling is not an optimisation here, it is the difference
     between a smooth frame and a multi-hundred-ms stall. */
  _stepVideoList(list, dt, which){
    if(!list || !list.length) return;
    const pool = (which === 'fire') ? this._videoFirePool : this._videoExpPool;
    if(!pool) return;
    for(let i = list.length - 1; i >= 0; i--){
      const v = list[i];
      v.life -= dt;
      const t = 1 - Math.max(0, v.life) / v.maxLife;
      v.mat.opacity = Math.max(0, 1 - t * t);
      // fire rides along with the wreck it belongs to
      if(v.follow && v.follow.x != null){
        v.basePos.x = v.follow.x;
        v.basePos.z = v.follow.z;
        v.basePos.y = (v.follow.y != null ? v.follow.y : 0);
      }
      // keeps turning to face the camera and grows FROM the anchor point
      this._faceVideoToCamera(v, 1 + t * 0.5);
      if(v.life > 0) continue;
      if(v.mesh.parent) v.mesh.parent.remove(v.mesh);
      list.splice(i, 1);
      /* Recycled, not destroyed. A recycled fire plane must forget which wreck
         it was following or it will snap to a dead tank on its next spawn. */
      v.follow = null;
      if(pool.length < 4){
        pool.push(v);
        continue;
      }
      // Pool is full: this is the only time we actually pay, and it happens at
      // most once per pool lifetime rather than once per death.
      try { v.el.pause(); } catch(e){}
      v.mesh.geometry.dispose(); v.mat.dispose(); this._disposeVideoTex(v.tex, v.el);
    }
  }

  /* ---- VFX sprite pool ----------------------------------------------------
     Every muzzle flash, spark and smoke puff used to allocate a brand new
     THREE.Sprite + THREE.SpriteMaterial and then dispose it a fraction of a
     second later. In a firefight that is hundreds of allocations, scene-graph
     edits and GL program teardowns per second Ã¢â‚¬â€ one of the main reasons the
     game stutters while tanks fire. Sprites are now taken from a free list and
     handed back instead, so the same handful of materials is reused forever. */
  _vfxSprite(tex, opts){
    const o = opts || {};
    const depthTest = o.depthTest !== false;
    const blending = (o.blending != null) ? o.blending : THREE.AdditiveBlending;
    const key = ((tex && tex.uuid) || 'none') + '|' + blending + '|' + (depthTest ? 1 : 0);
    if(!this._vfxPool) this._vfxPool = Object.create(null);
    const pool = this._vfxPool[key] || (this._vfxPool[key] = []);
    let s = pool.pop();
    if(s){
      this.scene.add(s);
    } else {
      s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 1,
        depthWrite: false, depthTest: depthTest, blending: blending
      }));
      this.scene.add(s);
    }
    const m = s.material;
    m.map = tex;
    m.blending = blending;
    m.depthTest = depthTest;
    m.depthWrite = false;
    m.transparent = true;
    m.rotation = 0;
    m.color.set(o.color != null ? o.color : 0xffffff);
    m.opacity = (o.opacity != null) ? o.opacity : 1;
    /* Opt out of the filmic tone curve when asked: the curve drags a
       saturated tint toward grey, which is exactly what made the muzzle
       smoke look cold and colourless. */
    m.toneMapped = (o.toneMapped === true);
    s.visible = true;
    s.rotation.set(0, 0, 0);
    s.renderOrder = o.renderOrder || 0;
    s.position.set(0, 0, 0);
    s.scale.set(1, 1, 1);
    return s;
  }

  _vfxRelease(s){
    if(!s) return;
    const m = s.material;
    const depthTest = m.depthTest !== false;
    const key = ((m.map && m.map.uuid) || 'none') + '|' + m.blending + '|' + (depthTest ? 1 : 0);
    if(!this._vfxPool) this._vfxPool = Object.create(null);
    const pool = this._vfxPool[key] || (this._vfxPool[key] = []);
    this.scene.remove(s);
    s.visible = false;
    if(pool.length < 400){
      pool.push(s);
    } else {
      m.dispose();
    }
  }

  _muzzleFlash(pos, dir){
    if(this.settings && this.settings.muzzleFx === false) return;
    if(!this._muzzleFlashes) this._muzzleFlashes = [];
    const K = this.isUltra ? 1.45 : (this.isFancy ? 1.15 : 0.9);

    // The old UPRIGHT flash (an explosion.png billboard that stood up at the
    // barrel tip, plus a stack of "starsoft" bursts) is gone: every shot now
    // plays the flat horizontal picture in _muzzlePicture() instead, which is
    // the effect the player picked. Sparks, smoke and the light stay below.

    // Directional "kick" sparks pushed along the barrel (meaty, visible)
    const dirX = dir ? (dir.x || 0) : 0;
    const dirZ = dir ? (dir.z || 0) : 0;
    if(window.particleClouds){
    const naf = this.isUltra ? 30 : (this.isFancy ? 16 : 11);
    for(let i=0; i<naf; i++){
      const a = Math.atan2(dirZ, dirX) + (Math.random() - 0.5) * 1.4;
      const spd = (10 + Math.random() * 7) * K;
      const sc = (0.3 + Math.random() * 0.28) * K;
      const s = this._vfxSprite(VFX.getTex(i%3===0?'ember':'spark'), {color:0xffffff, opacity:0.95});
      s.position.set(pos.x, pos.y + 0.12, pos.z);
      s.scale.set(sc, sc, 1);
      const life = 0.18 + Math.random() * 0.12;
      this._muzzleFlashes.push({
        sprite:s, life:life, maxLife:life,
        vx: Math.cos(a) * spd, vz: Math.sin(a) * spd,
        vy: 0.2 + Math.random() * 0.5, baseScale: sc
      });
    }
    }

    // A real point light on every shot (all quality levels) Ã¢â‚¬â€ light orange,
    // alive for about as long as the flash picture it belongs to.
    this._muzzleLight(pos.x, pos.y + 0.2, pos.z);
    if(window.particleClouds){
      const tex = VFX.getTex('smoke');
      for(let i=0, n = this.isUltra ? 10 : 5; i<n; i++){
        /* Warm, un-lit, filmic-curve-bypassing tint: the puff used to be
           white on top of a normal-blended, tone-mapped scene, which greyed
           it out into a cold smudge. It now glows the colour of the shot. */
        const s = this._vfxSprite(tex, {color:0xffa33a, opacity:0.55, depthTest:false, toneMapped:false});
        const sc = 0.5 + Math.random() * 0.4;
        s.position.set(pos.x, pos.y + 0.1 + Math.random() * 0.2, pos.z);
        s.scale.set(sc, sc, 1);
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

    const dirX = dir ? (dir.x || 0) : 0;
    const dirZ = dir ? (dir.z || 0) : 0;
    if(window.particleClouds){
    for(let i=0, n = this.isUltra ? 11 : 6; i<n; i++){
      const a = Math.atan2(dirZ, dirX) + (Math.random() - 0.5) * 1.6;
      const spd = 8 + Math.random() * 5;
      const ss = 0.24 + Math.random() * 0.16;
      const s = this._vfxSprite(VFX.getTex('spark'), {color:0xffffff, opacity:0.8});
      s.position.set(pos.x, pos.y + 0.1, pos.z);
      s.scale.set(ss, ss, 1);
      const slife = 0.12 + Math.random() * 0.08;
      this._muzzleFlashes.push({
        sprite:s, life:slife, maxLife:slife,
        vx: Math.cos(a) * spd, vz: Math.sin(a) * spd,
        vy: 0.2 + Math.random() * 0.4, baseScale: ss
      });
    }
    }
  }

spawnExplosion(x, y, z, color, count, style){
    /* No fireball here. This is the ordinary blast Ã¢â‚¬â€ a shell into a wall, a
       tank getting hit Ã¢â‚¬â€ and the sphere is reserved for a tank being DESTROYED,
       which is _killVfx(). The old version fired the big ball here too, so
       every single hit played a whole death explosion. */
    if(this._noParticles || !window.particleClouds) return;
    const e = new Explosion(x, y, z, color, count, style);
    e.attach(this.scene); this.explosions.push(e);
    /* Shell impacts nudge the camera, and again by how close they are. */
    if(this.localTank){
      const d = Math.hypot(this.localTank.x - x, this.localTank.z - z);
      const reach = 45;
      if(d < reach){ const k = 1 - d / reach; this.addShake(1.2 * k * k); }
    }
  }

  /* Screen-space hit marker Ã¢â‚¬â€ shows a brief crosshair flash when local player lands a hit */
  spawnHitMarker(){
    if(!this.localTank) return;
    // The crosshair canvas/texture is identical every time Ã¢â‚¬â€ draw it once and
    // reuse it instead of re-uploading a fresh CanvasTexture on every hit.
    if(!this._hitMarkerTex){
      const cvs = document.createElement('canvas');
      cvs.width = 64; cvs.height = 64;
      const g = cvs.getContext('2d');
      const c = 32, s = 24, thick = 4;
      g.strokeStyle = '#fff';
      g.lineWidth = thick;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(c - s, c - s); g.lineTo(c - s * 0.4, c - s * 0.4);
      g.moveTo(c + s, c - s); g.lineTo(c + s * 0.4, c - s * 0.4);
      g.moveTo(c - s, c + s); g.lineTo(c - s * 0.4, c + s * 0.4);
      g.moveTo(c + s, c + s); g.lineTo(c + s * 0.4, c + s * 0.4);
      g.stroke();
      this._hitMarkerTex = new THREE.CanvasTexture(cvs);
    }
    const spr = this._vfxSprite(this._hitMarkerTex, {
      color: 0xffffff, opacity: 1, depthTest: false, renderOrder: 1000
    });
    spr.scale.set(0.08, 0.08, 1);
    this._hitMarkerSprites = this._hitMarkerSprites || [];
    this._hitMarkerSprites.push({spr, life: 0.25, maxLife: 0.25});
  }

  _updateHitMarkers(dt){
    if(!this._hitMarkerSprites || !this._hitMarkerSprites.length) return;
    for(let i = this._hitMarkerSprites.length - 1; i >= 0; i--){
      const h = this._hitMarkerSprites[i];
      h.life -= dt;
      if(h.life <= 0){
        this._vfxRelease(h.spr);
        this._hitMarkerSprites.splice(i, 1);
      } else {
        const a = h.life / h.maxLife;
        h.spr.material.opacity = a;
        h.spr.material.rotation += dt * 8;
        h.spr.scale.setScalar(0.08 * (1 + (1 - a) * 0.5));
      }
    }
  }
  /* Directional tank hit: soft star "pop", hot streak sparks pushed along the
     shell direction, tiny debris, light dust kick Ã¢â‚¬â€ reads as a fast "ding". */
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
    /* 5) THE SEGMENT SPARKS. Small yellow LINE segments - not dots - thrown
       straight out of the impact point, scattering every which way, pulled
       down by gravity. SparkLines (js/spark-lines.js) is the one pooled
       ribbon-mesh that draws every live spark in a single draw call; it is
       updated once per frame from the game's VFX tick. */
    if(typeof SparkLines !== 'undefined'){
      SparkLines.spawn(this.scene, px, y + 0.22, pz, dir ? dir[0] : 0, dir ? dir[1] : 0, {
        count: (o.sparkCount != null ? o.sparkCount : 8),
        speed: (o.sparkSpeed != null ? o.sparkSpeed : 11),
      });
    }
  }

  /* Pooled muzzle light Ã¢â‚¬â€ reused between shots, capped at 6 active */
  _ensureMuzzleLights(){
    // Adding a PointLight mid-fight changes `numPointLights`, which forces
    // three.js to recompile and relink EVERY shader in the scene Ã¢â‚¬â€ a visible
    // hitch right as tanks start firing. All six lights are created up front
    // (dark) so the count never changes again during the battle. Every shot
    // gets one, on every quality level.
    if(!this._muzzleLights) this._muzzleLights = [];
    while(this._muzzleLights.length < 4){
      const pl = new THREE.PointLight(0xffc07a, 0, 12, 2);
      this.scene.add(pl);
      this._muzzleLights.push({light: pl, active: false, life: 0, maxLife: 0.1});
    }
  }

  _muzzleLight(x, y, z, tank){
    if(!this._muzzleLights) this._muzzleLights = [];
    let l = this._muzzleLights.find(v => !v.active);
    if(!l){
      if(this._muzzleLights.length >= 4) return null;
      const pl = new THREE.PointLight(0xffc07a, 0, 12, 2);
      this.scene.add(pl);
      l = {light: pl, active: false, life: 0, maxLife: 0.1, anchor: null};
      this._muzzleLights.push(l);
    }
    l.active = true;
    /* Alive for roughly the length of the flash picture, so the tank, the
       ground and the smoke around the barrel actually catch the shot.
       The pop now plays in 0.75 s instead of 1.5 s, so the light dies at half
       that - a glow that outlives the flash looks like a fault, not fire. */
    l.life = l.maxLife = 0.22;
    /* Anchor: the light follows the muzzle while it burns, exactly like the
       flash cloud does now, so a moving tank keeps its flare on the barrel. */
    l.anchor = tank || null;
    l.light.position.set(x, y, z);
    l.light.intensity = 30;
    return l;
  }

  /* Lightweight sprite bursts Ã¢â‚¬â€ fire/smoke/spark particles, fancy only.
     opts.tex can be a string or an array (randomly picked per particle).
     opts.spin sets per-particle angular velocity, opts.stretchX scales x. */
  spawnBurst(x, y, z, opts){
    if(this._noParticles || !window.particleClouds) return;
    if(!this._bursts) this._bursts = [];
    const o = opts || {};
    const count = o.count || 12;
    const texName = Array.isArray(o.tex) ? o.tex[(Math.random()*o.tex.length)|0] : (o.tex || 'flare');
    const tex = VFX.getTex(texName);
    const additive = o.blend !== 'normal';
    const burstOpts = {
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      opacity: 1
    };
    if(o.color != null) burstOpts.color = o.color;
    for(let i = 0; i < count; i++){
      const s = this._vfxSprite(tex, burstOpts);
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

  /* Light directional damage hit on a tank Ã¢â‚¬â€ star pop + sparks kicked back
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

  /* Destruction VFX Ã¢â‚¬â€ white-hot pop, shockwave, sparks, debris, smoke column */
  _killVfx(tank){
    const y1 = tank.y != null ? tank.y : 1.4;
    // Rocket layer: bright pop + dense fireworks (always visible)
    this.spawnExplosion(tank.x, y1, tank.z, 0xfff2d0, 8, 'boom');
    /* The shader fireball belongs to THIS event only Ã¢â‚¬â€ a tank actually being
       destroyed. It is a mesh with its own shader, so it plays in every
       graphics option even where the sprite particles are switched off. */
    /* 13 was a 13-unit ball around a tank roughly 3 units long Ã¢â‚¬â€ the cloud was
       several tank-lengths across and swallowed the wrecks of everything near
       it. 13 / 1.5 = 8.7, which still covers the tank it came from but leaves
       the rest of the fight readable. */
    if(typeof Fireball !== 'undefined') Fireball.spawn(this.scene, tank.x, y1 + 2.0, tank.z, 8.7);
    this.spawnBurst(tank.x, y1 + 0.3, tank.z, {count: 18, tex: ['spark','ember'], speed: 18, size: 0.55, life: 0.6, rise: 2.5, gravity: 16, blend: 'add', spin: 9});
    this.spawnBurst(tank.x, y1 + 0.30, tank.z, {count: 10, tex: ['shard','hex'], speed: 6.5, size: 0.85, life: 0.8, rise: 3, gravity: 9, spin: 6});
    // Flower layer: heavy smolder bloom (fancy only)
    if(this.isFancy){
      const st = EXPLOSION_STYLES.lrg;
      this.spawnBurst(tank.x, y1, tank.z, {count: Math.round(st.fire * 8), tex: 'blobfire', color: 0xff8a2a, speed: 10, size: 1.5, life: 0.9, rise: 5, gravity: -1.5, blend: 'add', spin: 0.8});
      this.spawnBurst(tank.x, y1 - 0.2, tank.z, {count: Math.round(st.smokeCol * 6), tex: 'smoke', speed: 1.6, size: 3.0, life: 1.6, rise: 2.4, grow: 2.6, blend: 'normal', fade: 0.45});
      this.spawnBurst(tank.x, y1 - 0.2, tank.z, {count: 1, tex: 'ring', speed: 0, size: 2.2, life: 0.5, rise: 0, grow: 4.2, blend: 'add', spin: 0});
    }
    if(this.localTank){
      /* A tank going up in front of you should MOVE the camera. The closer it
         is, the harder the hit: full kick at your own feet, nothing at all by
         the time it is across the arena. */
      const d = Math.hypot(this.localTank.x - tank.x, this.localTank.z - tank.z);
      const reach = 75;
      if(d < reach) this.addShake(3.4 * (1 - d / reach) * (1 - d / reach));
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
    if(this._tdmState && tank.team){
      this._onTDMKill(byTank, tank);
      // Round-based: no respawn during round, round end handled by _onTDMKill
    }
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
      // (no second _killVfx here Ã¢â‚¬â€ it already ran at the top of onTankKilled;
      //  calling it again is what made every kill explode twice)
      return;
    }
    if(this.mode === 'sp' && !this._tdmState){
      const aliveEnemies = this.tanks.filter(t => t.alive && !t.dying && !t.isDummy && t !== this.localTank);
      if(aliveEnemies.length === 0 && this.localTank && this.localTank.alive){
        Menu.toast('VICTORY! All enemies destroyed!');
        if(typeof UpgradeTree !== 'undefined'){
          try { UpgradeTree.recordBattle({ won: true, kills: (this.localTank.kills||0) + 1, carry: false, damage: this.localTank.damageDealt||0, heals: this.localTank.healDealt||0, minutes: (this.time||0)/60, tankId: this.localTank.def.id }); } catch(e){}
        }
        try { Menu.bumpStat('wins', 1); } catch(e){}
        /* RESULTS, NOT THE MENU. See the note in _tdmEndRound Ã¢â‚¬â€ the same three
           seconds used to discard every number the battle produced. */
        setTimeout(() => {
          if(!this.running) return;
          this._awardBattleCash({
            damage: this.localTank.damageDealt || 0,
            assists: this.localTank.assists || 0,
            kills:  this.localTank.kills || 0,
            won: true,
          });
          this._showResults({ outcome: 'win', headline: 'VICTORY' });
        }, 2000);
      }
    }
    // _killVfx already ran at the top of onTankKilled Ã¢â‚¬â€ calling it here too
    // is what made every kill explode (and shake) twice.
    // Kill rewards for the local player
    if(byTank && byTank === this.localTank){
      /* CASH ONLY, AND CASH THAT MEANS SOMETHING.

         This used to pay a random bundle Ã¢â‚¬â€ 8 to 21 cash, plus coins, plus a 1%
         chance of a "gem" Ã¢â‚¬â€ and only for a kill, and only in Team Deathmatch.
         That is three problems the results screen made obvious:

           * a battle where you did enormous damage and died paid nothing, so
             the rewards panel read 0 next to a healthy damage number and looked
             broken rather than empty;
           * Capture the Circle and Gladiator paid nothing at all, ever;
           * coins and gems dropped from a single kill, so the third and second
             currencies were being handed out at random whether or not the player
             wanted them.

         Cash is now earned for three things a player can point at afterwards:
         damage dealt, assists, and kills Ã¢â‚¬â€ with a bonus for winning. It is
         deterministic, so the number on the results screen is the number in the
         wallet. */
      this._awardBattleCash({
        damage: this.localTank.damageDealt || 0,
        assists: this.localTank.assists || 0,
        kills: 1,
      });
    }
  }

  /* ============================================================================
     BATTLE REWARDS Ã¢â‚¬â€ CASH ONLY.

     Decided once, in one place, and applied to both the wallet and the battle
     counter, so the HUD strip can never disagree with what was actually
     credited. See the note at the call site for why cash is the only currency
     a battle pays.

     The rates are deliberately modest and flat: a kill is worth a little more
     than a thousand damage, because a kill takes real work and is capped by how
     many enemies there are, whereas damage scales with the length of the match.
     Without that weighting a long match of chip damage out-earned a short one
     of clean kills, which is the wrong incentive. */
  /* WHICH GAMEMODE THIS BATTLE IS.

     There is no `this.gamemode`. The game has never had one: each mode starter
     sets its own flag and the mode is inferred from which flags are live. That is
     fine until something needs the mode as a NAME Ã¢â‚¬â€ and mission quests do, since
     a quest for Gladiator must not be advanced by a round of Team Deathmatch.

     THE ORDER IS THE WHOLE FUNCTION, because the flags overlap. All three team
     modes set _tdmState Ã¢â‚¬â€ it is the shared round scorer Ã¢â‚¬â€ so testing it first
     would report Team Deathmatch for Capture the Circle and Base Defend both.
     The two flags that are genuinely exclusive therefore have to be asked first,
     and gladiator, which has no _tdmState at all, before the fallback. */
  _currentGamemodeId(){
    try {
      if(this._baseDefendMode)   return 'baseDefend';
      if(this._captureCircleMode) return 'captureTheCircle';
      if(this.glad)             return 'gladiator';
      if(this._tdmState)        return 'teamDeathmatch';
    }catch(e){}
    return 'sandbox';
  }

  /* Feed one battle's outcome into the quest log.

     Called from _awardBattleCash because that is the ONE function every battle
     ends through Ã¢â‚¬â€ six call sites, every victory, defeat, elimination and skip Ã¢â‚¬â€
     and a quest system fed from six places is a quest system that misses one.

     It goes ABOVE that function's `if(cash <= 0) return`, and that placement is
     not tidiness. A battle in which the player did nothing awards no cash, so
     anything recorded after that guard is skipped on exactly the battles where a
     player is most likely to be grinding a "play N battles" quest. */
  _recordMissionOutcome(won){
    if(this._missionRecorded) return;
    try {
      if(typeof Missions === 'undefined' || !Missions.recordWin) return;
      this._missionRecorded = true;
      const me = this.localTank;

      /* `won` is the value the caller already worked out and already uses for the
         cash bonus, so the quest log and the payout can never disagree about
         whether the battle was won. It is deliberately NOT recomputed here: the
         winning team is a local variable inside _finishMatch and is not stored on
         the instance, so reading it back would mean either a new field or a
         second comparison that could drift from the first. */
      if(won) Missions.recordWin({ mode: this.mode, gamemode: this._currentGamemodeId() });
      Missions.recordDamage(me ? (me.damageDealt || 0) : 0);
      Missions.recordKill(me ? (me.kills || 0) : 0);
      Missions.recordAssist(me ? (me.assists || 0) : 0);
    }catch(e){ /* a quest must never break a match ending */ }
  }

  _awardBattleCash({ damage, assists, kills, won }){
    try { this._recordMissionOutcome(!!won); } catch(e){}
    const s = Menu.settings;
    const dmg   = Math.max(0, Math.floor(damage || 0));
    const ast   = Math.max(0, Math.floor(assists || 0));
    const kl    = Math.max(0, Math.floor(kills   || 0));
    const isWin = !!won;

    /* 120 per 1,000 damage, 25 per assist, 200 per kill, 400 for the win. */
    let cash = Math.floor(dmg / 1000) * 120 + ast * 25 + kl * 200 + (isWin ? 400 : 0);
    if(cash <= 0) return 0;

    s.cash = (s.cash || 0) + cash;
    this._battleCash = (this._battleCash || 0) + cash;
    saveSettings(s);
    return cash;
  }

  onLocalDeath(){
    if(this.glad){
      // Eliminated Ã¢â‚¬â€ no longer controllable: take the touch controls away
      if(this.input && this.input.setJoysticksVisible) this.input.setJoysticksVisible(false);
      if(Menu && Menu.hideTouchControls) Menu.hideTouchControls();
      this._gladShowResult(true);
      Menu.toast('Eliminated! You placed #' + (this.localTank ? (this.localTank.placement || '?') : '?'));
      return;
    }
    if((this._captureCircleMode || this._baseDefendMode) && this.localTank){
      /* Both mid-match-respawn modes: you come back at your own spawn point, so
         there is nothing to spectate and no reason to take the controls away.
         Base Defend has to be in this branch or a death drops you into the
         spectator bar with the match still running Ã¢â‚¬â€ which reads as being
         kicked out of your own game, five seconds before your tank reappears
         underneath you. */
      Menu.toast(this._baseDefendMode
        ? 'Destroyed Ã¢â‚¬â€ respawning. Your base is still standing.'
        : 'Destroyed Ã¢â‚¬â€ respawning at your spawn point...');
      return;
    }
    if(this._tdmState && this.localTank){
      // Round-based: no respawn during round, spectate until round ends
      Menu.toast('You were destroyed Ã¢â‚¬â€ spectating until round ends...');
      this._startSpectate();
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
    // TDM mode: no visibility filtering, show all tanks at all distances
    if(this._tdmState){
      for(const t of this.tanks){
        t.root.visible = true;
      }
      return;
    }
    const viewDist = me.viewRange || 120;
    // Build the occluder list once per frame. It used to be rebuilt with
    // walls.concat(covers) inside the loop, allocating a fresh array for every
    // tank on every frame Ã¢â‚¬â€ a steady source of GC pressure during combat.
    /* Build the occluder list once per frame, and only REBUILD it when the
       underlying arrays actually changed.

       `walls.concat(covers)` allocated a fresh array every frame, on every
       frame, for the life of the match -- hundreds of entries copied 60 times
       a second. That is a guaranteed major-GC tick every few seconds, and a
       major GC is exactly what a player experiences as "the game freezes at a
       random moment". Now the concatenation happens once and the array is
       reused; the references are re-checked cheaply and only a changed wall
       count triggers a rebuild (walls are only ever added at map load). */
    let blockers = this._visBlockers;
    if(this.world){
      const walls = this.world.walls || [];
      const covers = this.world.coverPoints || [];
      if(walls.length || covers.length){
        if(!blockers || blockers._walls !== walls || blockers._len !== walls.length){
          const fresh = walls.concat(covers);
          fresh._walls = walls;
          fresh._len = walls.length;
          blockers = this._visBlockers = fresh;
        }
      } else {
        blockers = null;
      }
    }
    const meY = me._physBody ? me._physBody.translation().y + 1.5 : 2;
    for(const t of this.tanks){
      if(t === me){ t.root.visible = true; continue; }
      if(t.dying){ t.root.visible = true; continue; }
      const dx = t.x - me.x, dz = t.z - me.z;
      const d = Math.hypot(dx, dz);
      let visible;
      if(d < 18) visible = true;
      else if(d <= viewDist){
        visible = (t.camoFactor >= 0.5);
        if(visible && blockers){
          const tY = t._physBody ? t._physBody.translation().y + 1.5 : 2;
          for(const w of blockers){
            if(this._lineIntersectsAABB(me.x, meY, me.z, t.x, tY, t.z, w)){
              visible = false; break;
            }
          }
        }
      } else visible = false;
      t.root.visible = visible;
    }
  }

  _lineIntersectsAABB(x1,y1,z1, x2,y2,z2, box){
    if(!box) return false;
    const minX = box.minX != null ? box.minX : (box.x != null ? box.x - (box.w||2)/2 : -999);
    const maxX = box.maxX != null ? box.maxX : (box.x != null ? box.x + (box.w||2)/2 : 999);
    const minZ = box.minZ != null ? box.minZ : (box.z != null ? box.z - (box.d||2)/2 : -999);
    const maxZ = box.maxZ != null ? box.maxZ : (box.z != null ? box.z + (box.d||2)/2 : 999);
    const minY = box.minY != null ? box.minY : (box.y != null ? box.y - (box.h||2)/2 : -999);
    const maxY = box.maxY != null ? box.maxY : (box.y != null ? box.y + (box.h||2)/2 : 999);
    const dx = x2-x1, dy = y2-y1, dz = z2-z1;
    let tmin = 0, tmax = 1;
    if(dx !== 0){
      let t1 = (minX - x1) / dx, t2 = (maxX - x1) / dx;
      if(t1 > t2){ const tmp=t1; t1=t2; t2=tmp; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    } else if(x1 < minX || x1 > maxX) return false;
    if(dz !== 0){
      let t1 = (minZ - z1) / dz, t2 = (maxZ - z1) / dz;
      if(t1 > t2){ const tmp=t1; t1=t2; t2=tmp; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    } else if(z1 < minZ || z1 > maxZ) return false;
    if(dy !== 0){
      let t1 = (minY - y1) / dy, t2 = (maxY - y1) / dy;
      if(t1 > t2){ const tmp=t1; t1=t2; t2=tmp; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    } else if(y1 < minY || y1 > maxY) return false;
    return tmin <= tmax && tmax >= 0 && tmin <= 1;
  }

  /* ===========================================================
     HUD
     =========================================================== */
  _updateHUD(dt){
    if(!this.localTank) return;
    // While spectating, show the watched tank's live stats instead of the dead local one
    const t = (this.spectate && this.spectateTarget && this.spectateTarget.alive) ? this.spectateTarget : this.localTank;
    // Refresh scoreboard if visible
    const sbOverlay = document.getElementById('scoreboard-overlay');
    if(sbOverlay && !sbOverlay.classList.contains('hidden')){
      this._sbTimer = (this._sbTimer || 0) + dt;
      if(this._sbTimer > 0.25){ this._sbTimer = 0; this._renderScoreboard(); }
    }
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
    /* Cache the HUD elements and only write when the value actually changed.

       This ran five getElementById calls plus unconditional textContent and
       style writes, every single frame. Writing a textContent that is already
       correct still invalidates layout, so the browser re-laid-out the HUD 60
       times a second to produce identical pixels -- pure waste in the hottest
       loop in the game. The FPS readout right above already worked this way
       (it compared before writing); this is the same treatment applied to the
       rest of the HUD. */
    const hud = this._hudCache || (this._hudCache = {});
    const el = (id) => {
      let e = hud[id];
      if(e === undefined){ e = hud[id] = document.getElementById(id); }
      return e;
    };
    const setText = (node, txt) => { if(node && node.textContent !== txt) node.textContent = txt; };

    setText(el('speed-val'), String(Math.max(0, Math.round(Math.abs(t.speed) * U_TO_KMH))));
    const hpBar = el('hp-bar');
    const pct = Math.max(0, t.hp/t.maxHp);
    const hpPct = (pct*100)+'%';
    if(hpBar && hpBar.style.width !== hpPct) hpBar.style.width = hpPct;
    setText(el('hp-text'), `${Math.ceil(t.hp)} / ${t.maxHp}`);

    /* ---- live battle score: damage, kills, cash earned so far ----
       READ FROM localTank, NOT FROM `t`.

       `t` above is swapped to the spectate target while you are watching a
       teammate, so reading the strip from it would quietly replace YOUR damage
       and kills with whoever you happen to be following, and swap back the
       moment you stopped. The strip is about your own battle, so it deliberately
       ignores the spectate swap. Cash is already yours either way: it lives on
       the Game rather than on a tank.

       Read every frame like the rest of the HUD, but only TOUCH THE DOM when a
       number actually moved. setText already compares before writing; the bump
       needs the same guard, because re-adding a class that is already present
       does not restart its animation. So a kill flashes only the cells that
       changed and leaves the others alone. */
    const me = this.localTank;
    const scoreDmg = Math.round((me && me.damageDealt) || 0);
    const scoreKills = (me && me.kills) || 0;
    const scoreCash = this._battleCash || 0;
    setText(el('score-dmg'), String(scoreDmg));
    setText(el('score-kills'), String(scoreKills));
    setText(el('score-cash'), String(scoreCash));
    if(this._hudScorePrev){
      this._bumpScoreCell(hud, 'score-dmg',   this._hudScorePrev.d, scoreDmg);
      this._bumpScoreCell(hud, 'score-kills', this._hudScorePrev.k, scoreKills);
      this._bumpScoreCell(hud, 'score-cash',  this._hudScorePrev.c, scoreCash);
    }
    this._hudScorePrev = { d: scoreDmg, k: scoreKills, c: scoreCash };

    /* The strip only earns its place once it has something on it: shown from the
       first damage or kill onward rather than sitting at three zeros through the
       whole approach. */
    const strip = el('score-strip');
    if(strip){
      const show = (scoreDmg > 0 || scoreKills > 0 || scoreCash > 0);
      if(show !== strip.classList.contains('on')) strip.classList.toggle('on', show);
    }

    const drownWrap = el('drown-bar-wrap');
    const drownBar = el('drown-bar');
    if(drownWrap && drownBar){
      if(t._drowning){
        drownWrap.classList.remove('hidden');
        const w = Math.min(100, (t._drownTimer / 10) * 100) + '%';
        if(drownBar.style.width !== w) drownBar.style.width = w;
      } else {
        drownWrap.classList.add('hidden');
        if(drownBar.style.width !== '0%') drownBar.style.width = '0%';
      }
    }

    const dot = el('camo-dot');
    const camoTxt = el('camo-text');
    if(dot && camoTxt){
      let cls, txt;
      if(t.camoState === 'bush'){ cls = 'camo-dot on'; txt = 'You are in bush'; }
      else if(t.camoState === 'tree'){ cls = 'camo-dot mid'; txt = 'Partial cover'; }
      else { cls = 'camo-dot off'; txt = ''; }
      if(dot.className !== cls) dot.className = cls;
      setText(camoTxt, txt);
    }
    
    // Flamethrower heat bar (shown inside the reload indicator slot)
    const heatWrap = document.getElementById('heat-wrap');
    const heatBar = document.getElementById('heat-bar');
    const heatText = document.getElementById('heat-text');
    if(heatWrap && heatBar && heatText){
      heatWrap.classList.add('hidden');
    }

    // Reload indicator: bullet-shaped icon at 45Ã‚Â°, filled by reload progress,
    // finished with a hard black outline (cartoon sticker style, like the HP bar).
    const ri = document.getElementById('reload-indicator');
    if(ri){
      const rctx = ri.getContext('2d');
      const w = ri.width, h = ri.height;
      rctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const rr = (x, y, bw, bh, rad) => {
        rctx.beginPath();
        if(rctx.roundRect) rctx.roundRect(x, y, bw, bh, rad);
        else rctx.rect(x, y, bw, bh);
        rctx.fill();
      };

      // Shared bullet silhouette used by both branches. The body and the nose
      // are traced as ONE path, so the black outline runs unbroken with no seam
      // where the point meets the body.
      const bw = 28, bh = 64, rad = 6, hw = bw / 2;
      const by = -bh / 2;            // body top
      const bot = by + bh;           // body bottom
      const nose = by - 16;          // nose tip
      const bulletPath = () => {
        rctx.beginPath();
        rctx.moveTo(0, nose);
        rctx.lineTo(hw, by);
        rctx.lineTo(hw, bot - rad);
        rctx.arcTo(hw, bot, hw - rad, bot, rad);
        rctx.lineTo(-hw + rad, bot);
        rctx.arcTo(-hw, bot, -hw, bot - rad, rad);
        rctx.lineTo(-hw, by);
        rctx.closePath();
      };
      // dark track -> clip to the silhouette -> let paint() fill it -> outline
      const paintBullet = (paint) => {
        bulletPath();
        rctx.fillStyle = 'rgba(0,0,0,0.55)';
        rctx.fill();
        rctx.save();
        bulletPath();
        rctx.clip();
        paint();
        rctx.restore();
        bulletPath();
        rctx.lineWidth = 5;
        rctx.lineJoin = 'round';
        rctx.strokeStyle = '#000000';
        rctx.stroke();
      };

      if(t.def.shellType === 'flame'){
        const heatMax = 750;
        const pct = Math.min(1, Math.max(0, t.heat / heatMax));
        rctx.save();
        rctx.translate(cx, cy);
        rctx.rotate(Math.PI / 4);            // 45Ã‚Â°, as drawn
        const fh = Math.max(4, bh * pct);
        const grad = rctx.createLinearGradient(0, by + bh, 0, by);
        grad.addColorStop(0, '#ffb12b');
        grad.addColorStop(1, pct > 0.75 ? '#ff3b30' : '#ff6a00');
        paintBullet(() => {
          rctx.fillStyle = grad;
          rctx.fillRect(-hw, bot - fh, bw, fh);
          rctx.fillStyle = pct > 0.75 ? '#ff3b30' : '#ffb12b';
          rctx.fillRect(-hw, nose, bw, by - nose);   // nose always coloured
        });
        rctx.restore();
        rctx.fillStyle = t.overheated ? '#ff3b30' : '#fff';
        rctx.font = 'bold 16px Segoe UI, sans-serif';
        rctx.textAlign = 'center';
        rctx.textBaseline = 'bottom';
        rctx.fillText(t.overheated ? 'HOT' : Math.round(pct * 100) + '%', cx, h - 2);
      } else {
        const info = t.reloadInfo ? t.reloadInfo() : null;
        const loaded = (info && info.active && info.total > 0) ? (1 - Math.min(1, Math.max(0, info.left / info.total))) : 1;
        const reloading = info && info.active && info.total > 0;
        rctx.save();
        rctx.translate(cx, cy);
        rctx.rotate(Math.PI / 4);            // 45Ã‚Â°, as drawn
        const fh = Math.max(4, bh * loaded);
        paintBullet(() => {
          rctx.fillStyle = loaded >= 1 ? '#4cff6a' : '#ffb12b';
          rctx.fillRect(-hw, bot - fh, bw, fh);        // grows upward with progress
          rctx.fillRect(-hw, nose, bw, by - nose);     // nose always coloured
        });
        rctx.restore();
        if(reloading){
          rctx.fillStyle = '#fff';
          rctx.font = 'bold 16px Segoe UI, sans-serif';
          rctx.textAlign = 'center';
          rctx.textBaseline = 'bottom';
          rctx.fillText(Math.ceil((1 - loaded) * 100) + '%', cx, h - 2);
        }
        if(info && info.magSize > 0){
          const n = info.magSize, m = Math.max(0, info.mag);
          const pw = 8, gap = 3, totalW = n * pw + (n - 1) * gap;
          for(let i = 0; i < n; i++){
            rctx.fillStyle = i < m ? '#ffb12b' : 'rgba(255,255,255,0.25)';
            rr(cx - totalW / 2 + i * (pw + gap), 2, pw, pw, 2);
          }
        }
      }
    }

    /* TDM Scoreboard (horizontal glass icons) Ã¢â‚¬â€ round-based.

       NOT in Base Defend. This mode sets _tdmState too Ã¢â‚¬â€ the void kill and the
       roundActive flag both need it Ã¢â‚¬â€ so the strip used to come up in Base
       Defend as well, printing "0 VS 0" above the base panel for the whole
       match. Two scoreboards on one strip of screen, and the one that is pure
       noise sits on top of the one that decides the result. */
    if(this._tdmState && !this._baseDefendMode && !this._cinematicPhase && this._matchStartDelay <= 0){
      const tdmLb = document.getElementById('tdm-lb');
      const lbDiv = document.getElementById('leaderboard');
      if(tdmLb){
        tdmLb.classList.remove('hidden');
        if(lbDiv) lbDiv.style.display = 'none';
        this._lbTimer = (this._lbTimer || 0) + dt;
        if(this._lbTimer > 0.33){
          this._lbTimer = 0;
          const s = this._tdmState;
          const blueScore = document.getElementById('tdm-lb-blue-score');
          const redScore = document.getElementById('tdm-lb-red-score');
          // Show round wins instead of kills
          if(blueScore) blueScore.textContent = s.blueRoundWins;
          if(redScore) redScore.textContent = s.redRoundWins;
          // Update VS label to show round info
          const vsLabel = document.querySelector('.tdm-vs-label');
          if(vsLabel) vsLabel.textContent = 'R' + s.round + '/' + s.maxRounds;
          const blueEl = document.getElementById('tdm-lb-blue');
          const redEl = document.getElementById('tdm-lb-red');
          if(blueEl){
            const blue = this.tanks.filter(t => t.team === 'blue' && !t.isDummy);
            blueEl.innerHTML = blue.map(t => {
              const isLocal = t === this.localTank;
              const isDead = t.hp <= 0;
              return '<div class="tdm-icon'+(isLocal?' local':'')+(isDead?' dead':'')+'"><img src="assets/icons/tank-icon.webp"></div>';
            }).join('');
          }
          if(redEl){
            const red = this.tanks.filter(t => t.team === 'red' && !t.isDummy);
            redEl.innerHTML = red.map(t => {
              const isLocal = t === this.localTank;
              const isDead = t.hp <= 0;
              return '<div class="tdm-icon'+(isLocal?' local':'')+(isDead?' dead':'')+'"><img src="assets/icons/tank-icon.webp"></div>';
            }).join('');
          }
        }
      }
    } else {
      const tdmLb = document.getElementById('tdm-lb');
      if(tdmLb) tdmLb.classList.add('hidden');
      const lbDiv = document.getElementById('leaderboard');
      if(lbDiv) lbDiv.style.display = '';
    }
    // Leaderboard: ALL tanks sorted by damage (throttled to 3x/sec)
    this._lbTimer = (this._lbTimer || 0) + dt;
    if(this._lbTimer > 0.33){
      this._lbTimer = 0;
      const lb = document.getElementById('lb-list');
      if(lb){
        this._lbBuf = this._lbBuf || [];
        this._lbBuf.length = 0;
        const arr = this.tanks;
        for(let i=0;i<arr.length;i++){
          if(arr[i].damageDealt > 0) this._lbBuf.push(arr[i]);
        }
        this._lbBuf.sort((a,b)=> b.damageDealt - a.damageDealt);
        lb.innerHTML = '';
        const end = Math.min(5, this._lbBuf.length);
        for(let i=0;i<end;i++){
          const o=this._lbBuf[i];
          const li = document.createElement('li');
          li.innerHTML = '<span class="lname">'+o.name+'</span><span class="ldmg">'+Math.round(o.damageDealt)+'</span>';
          lb.appendChild(li);
        }
      }
    }

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
      // Re-lock cursor when closing map
      if(this.cameraMode === 'dynamic'){
        const c = this.renderer && this.renderer.domElement;
        if(c) c.requestPointerLock();
      }
      return;
    }
    // Release pointer lock when opening map
    if(document.pointerLockElement) document.exitPointerLock();
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
     icon until assets/icons/minimap-turret.webp is added. */
  _bigMapIcons(){
    if(!this._bigMapHull){
      this._bigMapHull = new Image();
      this._bigMapHull.src = 'assets/icons/minimap-hull.webp?v=' + (CONFIG.MODEL_VER || '1');
    }
    if(!this._bigMapTurret){
      this._bigMapTurret = new Image();
      this._bigMapTurret.onerror = () => { this._bigMapTurret = this._bigMapHull; };
      this._bigMapTurret.src = 'assets/icons/minimap-turret.webp';
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
      this._bigMapAirdropImg.src = 'assets/icons/airdrop.webp';
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

/* Take the document out of "booting" once the menu is genuinely on screen.
   Until then the inline critical style in index.html keeps every other layer
   hidden, so the loading screen is the ONLY thing on screen from the first
   paint Ã¢â‚¬â€ never a half-built menu behind it. */
function clearBooting(){
  try { document.documentElement.classList.remove('booting'); } catch(e){}
}

/* ============================================================================
   BootLoading Ã¢â‚¬â€ the game's ONE loading screen, driven from both places that
   need one.

   It used to be two half-solutions to the same problem:

     * At BOOT the screen was deliberately held back until a fullscreen prompt
       was dismissed. That prompt never resolved, so the page sat there showing
       nothing at all for thirty seconds (measured) and the loading bar only
       appeared for the last two.
     * When JOINING a battle there was no screen whatsoever Ã¢â‚¬â€ the map streamed
       in behind the menu with no indication anything was happening.

   So now: the screen comes up the instant the page does, it never waits on
   anything the player has to do, the bar tracks work that is really in flight,
   and both boot and join drive the same one. Nothing can stall it.
   ============================================================================ */
const BootLoading = (() => {
  let el = null, bar = null, status = null;
  let shownAt = 0, hideTimer = 0;
  /* Number of open holds, and the last hide() that arrived while held.
     See hold()/release() below. */
  let holdCount = 0, pendingHide = -1;

  function grab(){
    if(!el){
      el     = document.getElementById('loading-screen');
      bar    = document.getElementById('loading-bar');
      status = document.getElementById('loading-status');
    }
    return !!el;
  }

  /* Bring the screen up. `pct`/`msg` are optional; the fade-in is played from
     a forced opacity 0 so it always animates rather than snapping in. */
  function show(msg, pct){
    if(!grab()) return;
    if(hideTimer){ clearTimeout(hideTimer); hideTimer = 0; }
    el.style.display = 'flex';
    if(!shownAt){
      shownAt = performance.now();
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s ease';
      /* Fade in on whichever of the two arrives first: an animation frame, or a
         short timer. requestAnimationFrame does NOT fire in a backgrounded tab,
         and this screen is now raised during a map load Ã¢â‚¬â€ which is exactly when
         a player is most likely to have something else in front of the window.
         Waiting on rAF alone meant the screen stayed at opacity 0 and the player
         saw the main menu for the whole load, which is the bug this screen was
         added to fix. */
      requestAnimationFrame(() => { if(el) el.style.opacity = '1'; });
      setTimeout(() => { if(el && el.style.opacity === '0') el.style.opacity = '1'; }, 60);
    }
    set(msg, pct);
  }

  function set(msg, pct){
    if(!grab()) return;
    if(typeof pct === 'number' && bar){
      bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }
    if(msg && status) status.textContent = msg;
  }

  /* `minMs` keeps the screen up at least that long, so a warm join is a brief
     deliberate beat rather than a flicker. While a hold is open the hide is
     only recorded: release() replays the most recent one. */
  function hide(minMs){
    if(!grab()) return;
    if(holdCount > 0){
      pendingHide = (typeof minMs === 'number' ? minMs : 0);
      return;
    }
    if(hideTimer){ clearTimeout(hideTimer); hideTimer = 0; }
    const held = Math.max(0, (minMs || 0) - (performance.now() - shownAt));
    hideTimer = setTimeout(() => {
      if(!el) return;
      el.style.transition = 'opacity 0.3s ease';
      el.style.opacity = '0';
      hideTimer = setTimeout(() => {
        if(!el) return;
        el.style.display = 'none';
        shownAt = 0;
        hideTimer = 0;
      }, 320);
    }, held);
  }

  /* KEEP THE SCREEN UP WHILE SOMETHING THAT MUST NOT BE SEEN RUNS.

     _begin() waits for the tanks' own models before it compiles shaders (see
     _whenTankModelsReady). The mode starters call hide() the moment _begin()
     returns -- ahead of that compile -- so without this the screen starts
     fading while the main thread is still blocked compiling, the fade is a CSS
     transition and carries on regardless, and the player watches a frozen
     canvas for the length of the compile. hold() parks every hide() instead of
     running it, and snaps a fade that is already under way back up, because
     clearing the timer alone would not stop an opacity transition that has
     already started.

     Counted, not boolean: two overlapping start paths must not drop the screen
     because one of them released. */
  function hold(){
    holdCount++;
    if(hideTimer){ clearTimeout(hideTimer); hideTimer = 0; }
    if(el && el.style.display !== 'none' && shownAt){
      el.style.transition = 'opacity 0.25s ease';
      el.style.opacity = '1';
    }
  }

  function release(){
    if(holdCount > 0) holdCount--;
    if(holdCount === 0 && pendingHide >= 0){
      const m = pendingHide;
      pendingHide = -1;
      hide(m);
    }
  }

  /* True between show() and the end of the matching fade-out. shownAt is the
     authority -- it is set by show() and cleared only when a hide completes --
     because the stylesheet's own default display is none of our business. */
  function isUp(){ return !!shownAt && !!el && el.style.display !== 'none'; }

  return { show, set, hide, hold, release, isUp };
})();
if (typeof window !== 'undefined') window.BootLoading = BootLoading;


/* ---------- Bootstrap ---------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  /* The fullscreen prompt element is Menu's to manage now (see the note below).
     Looked up here only so its absence is visible in the console rather than
     silently changing behaviour. */
  const fsPrompt = document.getElementById('menu-fullscreen-prompt');
  if(!fsPrompt) console.warn('[boot] no #menu-fullscreen-prompt; the game will run windowed.');
  // Boot timing trace Ã¢â‚¬â€ read back from window.__loadTimes after startup.
  const _t0 = performance.now();
  window.__loadTimes = [];
  function mark(pct, msg){
    window.__loadTimes.push([Math.round(performance.now() - _t0), pct, msg]);
  }
  const setLoad = (pct, msg) => { mark(pct, msg); BootLoading.set(msg, pct); };

  const loadStartTime = Date.now();

  /* THE SCREEN GOES UP FIRST, BEFORE ANYTHING ELSE.
     It used to be withheld until a fullscreen prompt was dismissed, and that
     prompt never resolved Ã¢â‚¬â€ so the page sat dead for thirty seconds and the
     loading bar only appeared for the final two. The prompt is still offered,
     but it is now a suggestion the player can accept or ignore while the game
     keeps loading underneath it. Loading never waits on the player again. */
  BootLoading.show('Starting up...', 2);

/* THE FULLSCREEN PROMPT IS NOT RAISED FROM HERE ANYMORE.

     This block used to show the prompt during boot and then tear it down again
     on the first pointerdown ANYWHERE, the first keydown ANYWHERE, or six
     seconds later, whichever came first. That is the "sometimes it lets you
     bypass without clicking the buttons" report: it was never a prompt, it was
     a splash with a six second timer, and a keypress meant for something
     completely unrelated took it away.

     It also carried its OWN copy of the fullscreen check, using only the
     element properties, so it raised the prompt at a player already in browser
     fullscreen Ã¢â‚¬â€ the F11 case, which no API reports to anyone.

     And it was a SECOND system racing Menu's own: two independent places
     deciding whether one overlay was visible, which is where the
     unpredictability actually came from.

     Menu._initFullscreen owns all of it now Ã¢â‚¬â€ detection, every button, the ways
     out, and the reason a request was refused. Loading still never waits on the
     prompt. All that is left here is a nudge, so a Menu that has not finished
     booting still gets asked once it has. */
  window._fsPromptOffered = false;
  try {
    if(window.Menu && typeof Menu._refreshFullscreenState === 'function'){
      Menu._refreshFullscreenState(true);
      window._fsPromptOffered = true;
    }
  } catch(e){ /* Menu raises it when it boots; loading must never depend on this */ }

  // Yield to the browser so the bar/status actually repaint between phases.
  const paint = () => new Promise(r => setTimeout(r, 16));
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

  setLoad(5, 'Loading physics engine...');
  try {
    var RapierMod = await import('https://cdn.skypack.dev/@dimforge/rapier3d-compat@0.12.0');
    if(RapierMod.default){
      await RapierMod.default.init();
      window.RAPIER = RapierMod.default;
    }
    mark(0, 'rapier done');
  } catch(e){ console.warn('Rapier init failed, physics disabled:', e); mark(0, 'rapier failed'); }
  setLoad(20, 'Creating renderer...');
  let game = null;
  try {
    game = new Game();
    await game.init();
    window._game = game;
    if(location.hash.indexOf('__dbg') >= 0) window.__game = game;
  } catch(e){
    console.error('BOOTSTRAP ERROR:', e, e.stack);
  }
  mark(0, 'renderer ready');
  await paint();
  setLoad(45, 'Loading map...');
  await paint();
  setLoad(55, 'Loading textures...');
  await paint();

  // ---- Real preloads ------------------------------------------------------
  // Everything below used to happen lazily the first time it was needed Ã¢â‚¬â€ most
  // of it mid-battle. Doing it here means the fight starts on a warm cache
  // instead of stuttering while models and scenery stream in.
  setLoad(65, 'Loading tank models...');
  try {
    if(Models._probePromise) await withTimeout(Models._probePromise, 4000);
    const wanted = [];
    if(Models._available){
      for(const n of Object.keys(Models._available)) if(Models._available[n]) wanted.push(n);
    }
    if(wanted.length){
      await withTimeout(Promise.all(wanted.map(n => Models.load(n).catch(() => null))), 6000);
    }
    mark(0, 'models preloaded (' + wanted.length + ')');
  } catch(e){ console.warn('model preload:', e); }
  try {
    if(window.TankEditor && TankEditor.syncGlobal) TankEditor.syncGlobal().catch(function(){});
  } catch(e){ console.warn('tank overrides sync skipped:', e); }
  await paint();

  setLoad(82, 'Loading scenery...');
  try {
    if(window.NatureAssets && NatureAssets.loadAll){
      await withTimeout(NatureAssets._promise || Promise.resolve(NatureAssets.loadAll()), 5000);
      if(game && game.world){
        game.world.treesPlaced = false;
        game.world.tryPlaceTrees();
      }
    }
    mark(0, 'scenery ready');
  } catch(e){ console.warn('scenery preload:', e); }
  await paint();

  setLoad(90, 'Preparing UI...');
  try {
    Menu.init(game);
  } catch(e){
    console.error('MENU INIT ERROR:', e, e.stack);
  }
  mark(0, 'menu ready');
  await paint();

  /* START CACHING EVERY TANK MODEL IN THE BACKGROUND.

     Until Models.load() has been called for a tank, its GLB has still to be
     fetched and parsed, and _begin() now waits for exactly that before it
     starts a match (see _whenTankModelsReady). Waiting there is correct -- it
     is covered by the loading screen -- but waiting is not necessary at all
     when the file could have been warming up while the menu was up. Fired off
     here and deliberately not awaited: a model that fails to load must never
     be able to hold up boot, and _begin()'s bounded wait is the backstop for
     one still in flight when the player hits Play. */
  try {
    const _warmNames = [];
    for(const _id of (typeof TANK_ORDER !== 'undefined' ? TANK_ORDER : [])){
      const _d = (typeof TANKS !== 'undefined') ? TANKS[_id] : null;
      if(_d && _d.model) _warmNames.push(_d.model);
    }
    if(typeof Models !== 'undefined' && Models.preload) Models.preload(_warmNames);
  } catch(e){ console.warn('tank preload:', e); }

  /* The menu now exists behind the loading screen, but it must NOT become
     visible while the last phases (shader compile) are still running. The
     `booting` class stays until the very end of boot, so the loading screen is
     the only thing on screen from the first paint right up to the handover. */
  clearBooting();

  // Compile every shader now so the first frame of a battle doesn't hitch
  // while three.js builds its programs.
  setLoad(95, 'Compiling shaders...');
  try {
    if(game && game.renderer && game.scene && game.camera){
      game.renderer.compile(game.scene, game.camera);
    }
    mark(0, 'shaders compiled');
  } catch(e){ console.warn('shader warmup:', e); }
  await paint();

  setLoad(100, 'Ready!');
  mark(0, 'boot work finished at ' + (Date.now() - loadStartTime) + 'ms');
  /* A short floor rather than the old fixed two seconds: the screen is up for
     as long as the work really takes, so a fast machine boots immediately and a
     slow one still gets a readable progress bar instead of a flash. */
  BootLoading.hide(400);
  window.__game = game;

  /* The session guard needs the game to exist before it can tell whether we were
     in a battle, so this is the first moment it can act. It checks the record
     left by the previous load: if that load was cut short mid-battle, it says so
     and offers the held player id back to the server, which either puts us back
     in the same match or tells us honestly that it is over. */
  try {
    if (typeof SessionGuard !== 'undefined') {
      SessionGuard.arm();
      SessionGuard.onBoot();
    }
  } catch (e) { console.warn('session guard could not start:', e); }

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
var s = String(msg);
line.textContent = s;
if(s.charAt(0) === '>') line.style.color = '#0ff';
else if(s.charAt(0) === '=') line.style.color = '#0f0';
else if(s.charAt(0) === '!') line.style.color = '#f44';
else if(s.indexOf('===') >= 0) line.style.color = '#ff0';
else if(s.indexOf('P2P') >= 0) line.style.color = '#f84';
_logEl.appendChild(line);
_logEl.scrollTop = _logEl.scrollHeight;
}

      // Expose the executor on window.game so the console input handler and
      // any external caller can eval arbitrary JS in the page context.
      /* `window.game` is a courtesy alias, not a guarantee Ã¢â‚¬â€ the boot code names
         it `window._game` / `window.__game`, so at parse time GAME MAY NOT EXIST
         and the bare assignment below used to THROW every load (measured:
         "Cannot set properties of undefined", killing this whole IIFE).
         Resolve to whatever alias booted first, or create a stand-in. */
      if(!window.game){
        try { window.game = window.__game || window._game || {}; } catch(e){ window.game = {}; }
      }
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
  if(_open){ log('=== DEV CONSOLE === (Ctrl+] to close)'); log('Type /if for all commands.'); if(_inEl) _inEl.focus(); }
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
         if (cmd === '/if' || cmd === '/help' || cmd === '/commands' || cmd === '/list') {
           log('=== ALL CONSOLE COMMANDS ===');
           log('/if            - list all commands (this list)');
           log('/help          - same as /if');
           log('/clear         - clear console output');
           log('/fps           - show current FPS and frame time');
           log('/hud           - toggle NetHud overlay (same as F9)');
           log('/hud stats     - print full NetHud stats object');
           log('/net            - show network status (role, room, RTT, link)');
           log('/net stats      - show detailed network counters');
           log('/ping          - measure RTT to server');
           log('/room          - show room code');
           log('/players       - list all players in current match');
           log('/tank          - show local tank info (pos, speed, heading)');
           log('/tank list     - list all tanks in match');
           log('/map           - show current map name');
           log('/camera        - show camera mode and angle');
           log('/camera dynamic - switch to dynamic camera');
           log('/camera strategic - switch to strategic camera');
           log('/camera tp     - switch to third-person camera');
           log('/settings      - show current settings');
           log('/p2p           - show P2P status');
           log('/p2p on       - enable P2P fast path');
           log('/p2p off      - disable P2P fast path');
           log('/p2p status   - detailed P2P status');
           log('/mp test host  - (placeholder) start host session');
           log('/mp test client - (placeholder) join as client');
           log('/eval <code>  - evaluate JS (or just type code directly)');
           log('/skipbt       - skip current battle, back to menu');
           log('/fastbt       - open map vote, vote to instantly start battle');
           log('/reload        - reload the page');
           log('/version       - show build stamp');
           log('===========================');
         } else if (cmd === '/clear' || cmd === '/cls') {
           if(_logEl) _logEl.innerHTML = '';
           log('console cleared');
         } else if (cmd === '/fps') {
           var h = window.NetHud ? window.NetHud.stats() : null;
           if (h) log('FPS: ' + h.fps + ' (avg ' + h.fpsAvg + ')  frameMs: ' + h.frameMs);
           else log('NetHud not available');
         } else if (cmd === '/hud') {
           if (window.NetHud) { window.NetHud.show(); log('NetHud toggled (F9)'); }
           else log('NetHud not available');
         } else if (cmd === '/hud stats') {
           if (window.NetHud) log(JSON.stringify(window.NetHud.stats()));
           else log('NetHud not available');
         } else if (cmd === '/net') {
           if (typeof Net !== 'undefined') {
             log('role: ' + (Net.role || '-') + '  room: ' + (Net.roomCode || '-') + '  RTT: ' + (Net._lastPing != null ? Math.round(Net._lastPing) + 'ms' : '-') + '  link: ' + (window.NetHud ? window.NetHud.stats().link : '-'));
           } else log('Net not available');
         } else if (cmd === '/net stats') {
           if (typeof Net !== 'undefined' && Net._stats) log(JSON.stringify(Net._stats));
           else log('Net stats not available');
         } else if (cmd === '/ping') {
           if (typeof Net !== 'undefined' && Net._lastPing != null) log('RTT: ' + Math.round(Net._lastPing) + 'ms');
           else log('No ping data yet');
         } else if (cmd === '/room') {
           if (typeof Net !== 'undefined') log('Room: ' + (Net.roomCode || '-') + '  role: ' + (Net.role || '-'));
           else log('Net not available');
         } else if (cmd === '/players') {
           if (typeof Net !== 'undefined' && Net.roster) {
             log('Players (' + Net.roster.length + '):');
             for (var i = 0; i < Net.roster.length; i++) {
               var p = Net.roster[i];
               log('  ' + (p.peerId || p.id || '?') + '  ' + (p.name || '-') + (p.isBot ? ' [bot]' : ''));
             }
           } else log('No roster available');
         } else if (cmd === '/tank') {
           var g = window.game;
           if (g && g.localTank) {
             var t = g.localTank;
             log('Tank: ' + (t.id || '-') + '  pos: ' + (Math.round(t.x*10)/10) + ', ' + (Math.round(t.z*10)/10) + '  speed: ' + (t.speed != null ? t.speed.toFixed(2) : '-') + '  heading: ' + (t.heading != null ? t.heading.toFixed(2) : '-') + '  turret: ' + (t.turretAngle != null ? t.turretAngle.toFixed(2) : '-'));
           } else log('No local tank');
         } else if (cmd === '/tank list') {
           var g2 = window.game;
           if (g2 && Array.isArray(g2.tanks)) {
             log('Tanks (' + g2.tanks.length + '):');
             for (var j = 0; j < g2.tanks.length; j++) {
               var tk = g2.tanks[j];
               log('  ' + (tk.id || '?') + '  team=' + (tk.team || '?') + '  alive=' + (tk.alive !== false) + '  net=' + (tk._netDriven ? 'net' : 'local'));
             }
           } else log('No tanks');
         } else if (cmd === '/map') {
           var g3 = window.game;
           if (g3) log('Map: ' + (g3._votedMap ? g3._votedMap.name || g3._votedMap.id : '-') + '  mode: ' + (g3.mode || '-'));
           else log('No game');
         } else if (cmd === '/camera') {
           var g4 = window.game;
           if (g4) log('Camera mode: ' + (g4.cameraMode || '-') + '  angle: ' + (g4.camAngle != null ? g4.camAngle.toFixed(2) : '-') + '  dist: ' + (g4.camDist != null ? g4.camDist : '-'));
           else log('No game');
         } else if (cmd === '/camera dynamic') {
           if (window.game) { window.game.cameraMode = 'dynamic'; log('Camera: dynamic'); }
         } else if (cmd === '/camera strategic') {
           if (window.game) { window.game.cameraMode = 'strategic'; log('Camera: strategic'); }
         } else if (cmd === '/camera tp') {
           if (window.game) { window.game.cameraMode = 'automatic'; log('Camera: third-person (auto)'); }
         } else if (cmd === '/settings') {
           if (window.game && window.game.settings) log(JSON.stringify(window.game.settings));
           else log('No settings');
         } else if (cmd === '/p2p') {
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
         } else if (cmd === '/skipbt' || cmd === '/skipbattle') {
           if (window.game && typeof window.game.leaveToMenu === 'function') {
             window.game.leaveToMenu();
             log('Battle skipped -> back to menu.');
           } else {
             log('leaveToMenu not available.');
           }
         } else if (cmd === '/fastbt' || cmd === '/fastbattle') {
           if (window.game && typeof MapVoting !== 'undefined' && MapVoting.showVote) {
             log('Opening map vote... vote for a map to instantly start battle.');
             var self = window.game;
             MapVoting.showVote(function(winner){
               self._votedMap = winner;
               if (typeof self.startSingleplayer === 'function') {
                 self.startSingleplayer();
                 log('Battle started!');
               } else if (typeof self.startTeamDeathmatch === 'function') {
                 self.startTeamDeathmatch();
                 log('TDM started!');
               } else {
                 log('No start function found.');
               }
             }, {multiplayer:false, humans:1});
           } else {
             log('MapVoting or game not available.');
           }
         } else if (cmd === '/reload') {
           location.reload();
         } else if (cmd === '/version') {
           log('Build: ' + (document.getElementById('dev-stage-banner') ? document.getElementById('dev-stage-banner').textContent : 'production'));
         } else if (cmd.indexOf('/eval ') === 0) {
           var code = cmd.substring(6);
           try { var r = eval.call(window, code); log('= ' + r); } catch(e){ log('! ' + (e && e.message ? e.message : String(e))); }
         } else {
           // Try to eval as JS
           try { var r2 = eval.call(window, cmd); log('= ' + r2); } catch(e){ log('Unknown command: ' + cmd + '. Type /if for list.'); }
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
       // Ctrl+] toggles the dev console
       document.addEventListener('keydown', function(e){
         if(e.ctrlKey && (e.code === 'BracketRight' || e.key === ']')){
           e.preventDefault();
           toggleConsole();
         }
       });
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
      // (window.game is an INSTANCE-or-stand-in here, not the Game class Ã¢â‚¬â€ so
      // .prototype is undefined and reading it used to THROW and kill the
      // rest of this IIFE. The guard is the whole capability now.)
      try {
        var _origForwardInput = window.game.prototype && window.game.prototype._forwardInput;
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
});
