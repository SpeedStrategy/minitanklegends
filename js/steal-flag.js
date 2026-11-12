/* ============================================================
   steal-flag.js — "Steal the Flag" game mode
   ------------------------------------------------------------
   Classic capture the flag on the two `flag` entities a map
   ships (see world.js's `flag` node convention — kaukaz.glb
   has one standing in each team's base).

   THE LOOP
   ────────
     touch the ENEMY flag while it stands at its base  -> take it
     the flag rides the carrier's tank                -> update()
     carrier touches THEIR OWN flag at ITS base       -> 1 point
     The return trip only scores while the carrier's OWN flag
     is standing at home — a team whose flag has been stolen
     has nothing to exchange the enemy flag FOR (see the
     config note in GAMEMODES).

   WHAT HAPPENS TO A FLAG THAT IS OUT IN THE FIELD
   ───────────────────────────────────────────────
     carrier dies                   -> flag drops where they fell
     TEAMMATE touches a dropped own flag -> picks it up
     ENEMY touches a dropped flag   -> flag returns to ITS OWN base
     ENEMY touches our flag at home -> they steal it
     TEAMMATE touches our flag at home -> nothing to do

   WIN: first team to GAMEMODES.stealFlag.pointsToWin. After
   timeLimit the higher score wins; a tie buys an overtime of
   overtimeTime seconds in which every tank runs
   overtimeSpeedMult faster and the FIRST score ends the match
   instantly. Nobody scores in overtime: a draw.

   Respawn rule is that of Capture the Circle / Base Defend:
   UNLIMITED respawns at your own spawn point, applied from
   the same branch of Game.update (startStealFlag sets
   this._stealFlagMode, which shares that branch).

   HOST/CLIENT: snapshot()/applyHostSnapshot() publish scores,
   timeLeft, overtime and every flag field on the same net
   cadence base-defend uses. A client NEVER takes a flag,
   scores or ends the match from its local update() — it
   applies the host's numbers instead (see _state._client).
   ============================================================ */

const StealFlag = (() => {
  'use strict';

  let _game = null;
  let _state = null;

  const BLUE = 0x4488ff, RED = 0xff4444, AMBER = 0xfbbf24;
  /* 0x4488ff -> '#4488ff' for the canvas panel. It was called but never
     defined, and the ReferenceError it threw came out of the FIRST flag built
     in init() — which aborted init() itself, so the mode started with no
     flags, no state and a HUD that never appeared. That is the whole of "steal
     a flag does not work": one missing helper, not a broken mode. */
  const _hex = (n) => '#' + ('000000' + ((n >>> 0) & 0xffffff).toString(16)).slice(-6);

  const CFG = () => (typeof GAMEMODES !== 'undefined' && GAMEMODES.stealFlag) || {};
  const PICKUP_R  = () => CFG().pickupRadius  || 5;
  const CAPTURE_R = () => CFG().captureRadius || 9;
  const WIN_NEEDED = () => CFG().pointsToWin  || 5;

  /* ── the two team flag GLBs, loaded once inside init ── */
  const FLAG_GLB_BLUE = 'assets/flags/blue flag.glb';
  const FLAG_GLB_RED  = 'assets/flags/red flag.glb';

  /* THE MODELS ARE AUTHORED IN METRES, THE WORLD IS IN TANK UNITS.

     Measured with tools/glb-measure.mjs: "red flag.glb" is 1.126 x 0.555 x 1.0
     authored units. Dropped in unscaled — which is what this used to do — the
     flag that the whole mode is about stood about half a unit tall next to a
     4.4-unit-long tank: a doormat. Nobody could see the objective, so "steal
     the flag" read as an empty field with a HUD on it.

     14 put the cloth about 7.8 units tall — taller than a tank — and the size
     asked for is a third smaller than that, so the factor is written as the
     division rather than as a mystery number: 14 / 1.5 = 9.33, which lands the
     cloth around 5.2 units. Still an objective you can pick out from across the
     map, and no longer taller than the tank that drives up to it. */
  const FLAG_SCALE = 14 / 1.5;
  /* How high the name plate floats above the flag's base. */
  const LABEL_Y = 8.2;

  let _flagLoader = null;
  let _flagModels = null;   /* { blue:{grp, mount}, red:{grp, mount} } */

  /* ── WHERE THE FLAGS STAND ────────────────────────────────────────── */

  /* ── flag resolution — the same logic base-defend.js uses for bases,
     pointed at the map's `flag` marks instead:
       1. a mark whose NAME names a team (`blueflag`, `blue flag`, `Red Flag 2`)
          is assigned outright
       2. a bare `flag` mark goes to the team whose spawn cluster sits
          nearest — kaukaz ships its two flags this way
       3. no mark at all: the flag is placed AUTOMATICALLY behind each
          team's spawn cluster, pushed back the way base-defend pushes a
          fallback base — so the mode still plays on a map that never got
          `flag` entities, it just loses the labels. */
  function _resolveFlags(marks, blueSpawns, redSpawns){
    const centroid = (list) => {
      if(!list || !list.length) return null;
      let x = 0, z = 0;
      for(const s of list){ x += s.pos.x; z += s.pos.z; }
      return { x: x / list.length, z: z / list.length };
    };
    const blueC = centroid(blueSpawns);
    const redC  = centroid(redSpawns);
    const out = [];

    for(const m of (marks || [])){
      let team = null;
      const lower = ((m.name || '') + '').toLowerCase();
      if(lower.includes('blue')) team = 'blue';
      else if(lower.includes('red')) team = 'red';
      if(!team && blueC && redC){
        const dBlue = Math.hypot(m.x - blueC.x, m.z - blueC.z);
        const dRed  = Math.hypot(m.x - redC.x,  m.z - redC.z);
        team = (dBlue <= dRed) ? 'blue' : 'red';
      }
      if(!team) team = 'blue';
      out.push({ team, x: m.x, y: m.y, z: m.z, fromMap: true, name: m.name });
    }

    /* One flag per side, always. Extras are dropped — same rule as
       base-defend's bases. */
    const seen = new Set();
    const final = [];
    for(const f of out){ if(seen.has(f.team)) continue; seen.add(f.team); final.push(f); }

    /* FALLBACK: no flag markers, or only one side had one. The missing flag
       goes BEHIND its team's spawn cluster (pushed away from the enemy
       direction), so a respawned tank spawns IN FRONT of, never on, it. */
    for(const t of ['blue', 'red']){
      if(final.some(f => f.team === t)) continue;
      const list = (t === 'blue') ? blueC : redC;
      const other = (t === 'blue') ? redC : blueC;
      const cx = list ? list.x : 0, cz = list ? list.z : 0;
      let dx = other ? (other.x - cx) : (t === 'blue' ? 1 : -1);
      let dz = other ? (other.z - cz) : 0;
      const len = Math.hypot(dx, dz) || 1;
      dx = -dx / len; dz = -dz / len;
      const back = other ? Math.max(20, Math.hypot(other.x - cx, other.z - cz) * 0.2) : 25;
      final.push({ team: t, x: cx + dx * back, z: cz + dz * back, y: 0,
                   fromMap: false, name: t + ' flag (auto)' });
    }
    return final;
  }

  /* ── ONE FLAG ─────────────────────────────────────────────────────── */

  /* A canvas sprite for the panel above each flag. Sprite, not a plane: it
     always faces the camera, so the state is readable from any direction
     without a billboard pass of our own. */
  function _makeLabelSprite(){
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    /* 9 x 2.25 world units. The first pass was 17 x 4.25 and, seen from 20
       units away, one plate covered a third of the screen — a label is a sign,
       not a billboard. */
    sprite.scale.set(9, 2.25, 1);
    sprite.renderOrder = 1200;
    sprite.userData.stealFlagPiece = true;
    return sprite;
  }

  /* THE BASE A FLAG STANDS ON.

     A ring at exactly the capture radius, so what scores is what is drawn —
     no guessing how close "close" is. The beam is what makes the objective
     findable from across the arena: a flag is 5 units tall in a 900-unit map,
     and without it the first thing a new player does is drive the wrong way. */
  function _buildHomeMarker(teamHex){
    const g = new THREE.Group();
    const r = CAPTURE_R();
    const col = new THREE.Color(teamHex);

    const padMat = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.16, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    const pad = new THREE.Mesh(new THREE.CircleGeometry(r, 44), padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.05;
    g.add(pad);

    const ringMat = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.7, depthWrite: false,
      side: THREE.DoubleSide, fog: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.93, r, 56), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.07;
    g.add(ring);

    /* A COLOURED COLUMN, NOT AN ADDITIVE GLOW.

       Additive on a bright sky washes a red beam out to white, which is what
       made the first version read as a scratch on the lens. Normal blending at
       a low opacity keeps the team colour, so "there is a red thing over there"
       is legible at any distance and from any angle. */
    const beamMat = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.16, depthWrite: false,
      side: THREE.DoubleSide, fog: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.8, 24, 12, 1, true), beamMat);
    beam.position.y = 12;
    g.add(beam);

    g.traverse(o => { o.userData.stealFlagPiece = true; });
    return { grp: g, pad, ring, beam, ringMat, beamMat };
  }

  function _buildFlag(spot, groundY){
    const team = spot.team;
    const teamHex = (team === 'blue') ? BLUE : RED;
    const model = _flagModels && _flagModels[team] ? _flagModels[team] : null;

    /* An UNSCALED root carries the flag and its label; only the model inside
       it is scaled. Scaling the root would scale the name plate too, and a
       plate 9 times its authored size covers the whole screen at close range. */
    const grp = new THREE.Group();
    grp.position.set(spot.x, groundY, spot.z);

    const modelGrp = model && model.grp ? model.grp.clone() : new THREE.Group();
    modelGrp.scale.setScalar(FLAG_SCALE);
    /* SIT THE MODEL ON THE GROUND, INSTEAD OF HALF THROUGH IT.

       The authored pivot is not at the base of the pole — measured on the live
       object, the geometry runs from -0.56 to +0.54 authored units around its
       origin, so at scale 14 the flag stood 8 units UNDER the terrain with only
       the tip of the pole showing. The lift is measured rather than hard-coded
       because it is a property of the art, not of this file. */
    let modelLift = 0;
    try {
      const bb = new THREE.Box3().setFromObject(modelGrp);
      if(!bb.isEmpty() && isFinite(bb.min.y)) modelLift = -bb.min.y;
    } catch(e){}
    modelGrp.position.y = modelLift;
    /* The authored model is centred on its pole with the cloth to one side;
       turning the red one round means both flags face the middle of the map
       instead of both facing the camera on one side and away on the other. */
    if(team === 'red') modelGrp.rotation.y = Math.PI;
    grp.add(modelGrp);

    /* DOUBLE-SIDED, so the yaw billboard above can never turn the cloth into
       an invisible back-face when the camera swings behind it. The materials
       are clones owned by this flag, so nothing else in the match is touched. */
    modelGrp.traverse(o => {
      if(!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => { if(m && !m.transparent){ m.side = THREE.DoubleSide; m.needsUpdate = true; } });
    });

    const sprite = _makeLabelSprite();
    sprite.position.set(0, LABEL_Y, 0);
    grp.add(sprite);

    grp.traverse(o => { o.userData.stealFlagPiece = true; });

    const home = _buildHomeMarker(teamHex);
    home.grp.position.set(spot.x, groundY, spot.z);

    return {
      team, teamHex,
      fromMap: !!spot.fromMap, name: spot.name,
      homeX: spot.x, homeZ: spot.z, homeGroundY: groundY,
      groundY: groundY,
      x: spot.x, z: spot.z,
      carrier: null, dropped: false,
      grp, modelGrp, sprite, home, _modelLift: modelLift,
      _bob: Math.random() * Math.PI * 2,
      _panelT: 0,
    };
  }

  /* ── HUD — the same strip Base Defend uses, #flag-hud in index.html ── */
  let _hudEls = null;
  let _hudKey = '';

  function _hudInit(){
    const hud = document.getElementById('flag-hud');
    if(!hud) return null;
    return {
      hud,
      mineNum:   document.getElementById('flag-hud-mine-num'),
      theirNum:  document.getElementById('flag-hud-theirs-num'),
      mineFill:  document.getElementById('flag-hud-mine-fill'),
      theirFill: document.getElementById('flag-hud-theirs-fill'),
      time:      document.getElementById('flag-hud-time'),
      mineState: document.getElementById('flag-hud-mine-state'),
      theirState:document.getElementById('flag-hud-theirs-state'),
    };
  }

  const _myTeam = () => ((_game && _game.localTank && _game.localTank.team) || 'blue');

  /* One short word for where the flag is, wrote relative to MY team. */
  function _flagWord(f){
    if(!f) return '—';
    if(f.carrier){
      return (f.team === _myTeam())
        ? 'IN ENEMY HANDS'
        : 'HELD BY ' + (f.carrier.team === _myTeam() ? 'YOUR RUNNER' : 'THE ENEMY');
    }
    if(f.dropped) return 'ON THE GROUND';
    return (f.team === _myTeam()) ? 'SAFE AT HOME' : 'IN THEIR BASE';
  }

  function _updateHud(){
    if(!_state || !_hudEls) return;
    const me = _game && _game.localTank;
    const myTeam = (me && me.team) || 'blue';
    const mine   = _state.flags.find(f => f.team === myTeam);
    const theirs = _state.flags.find(f => f.team !== myTeam);
    const t = _state.timeLeft;
    const key =
      (_flagWord(mine)) + '|' + (_flagWord(theirs)) +
      '|' + (_state.scores.blue || 0) + '|' + (_state.scores.red || 0) +
      '|' + Math.max(0, Math.ceil(t)) + '|' + (_state.overtime ? 1 : 0);
    if(key === _hudKey) return;
    _hudKey = key;

    if(_hudEls.mineNum)  _hudEls.mineNum.textContent  = _flagWord(mine);
    if(_hudEls.theirNum) _hudEls.theirNum.textContent = _flagWord(theirs);
    /* MINE IS WHOEVER I AM. The fills used to be hard-wired to the blue and red
       score columns, so a player on the red side watched their own captures
       move the ENEMY bar. Everything in this HUD is relative (see _flagWord),
       so the numbers have to be relative too. */
    const myScore    = _state.scores[myTeam] || 0;
    const theirScore = _state.scores[myTeam === 'blue' ? 'red' : 'blue'] || 0;
    if(_hudEls.mineFill){
      _hudEls.mineFill.style.width  = Math.min(100, myScore / WIN_NEEDED() * 100) + '%';
      _hudEls.mineFill.style.background = (myTeam === 'blue') ? '#4488ff' : '#ff4444';
    }
    if(_hudEls.theirFill){
      _hudEls.theirFill.style.width = Math.min(100, theirScore / WIN_NEEDED() * 100) + '%';
      _hudEls.theirFill.style.background = (myTeam === 'blue') ? '#ff4444' : '#4488ff';
    }
    if(_hudEls.time){
      if(_state.overtime){
        _hudEls.time.textContent = 'OVERTIME ' + Math.max(0, Math.ceil(t)) + 's';
      } else {
        const s = Math.max(0, Math.ceil(t));
        _hudEls.time.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
      }
    }
    if(_hudEls.mineState)   _hudEls.mineState.textContent   = mine   ? ((mine.team === 'blue') ? 'BLUE' : 'RED') : '';
    if(_hudEls.theirState)  _hudEls.theirState.textContent  = theirs ? ((theirs.team === 'blue') ? 'BLUE' : 'RED') : '';
  }

  /* ── init ──────────────────────────────────────────────────────────── */

  async function init(game, ctx){
    _flagLoader = new THREE.GLTFLoader();
    const blue = await _loadOne(game.scene, FLAG_GLB_BLUE);
    const red  = await _loadOne(game.scene, FLAG_GLB_RED);
    _flagModels = {
      blue: blue  ? { grp: blue.group.clone(),  mount: _mountOf(blue.group) }  : null,
      red:  red   ? { grp: red.group.clone(),   mount: _mountOf(red.group) }   : null,
    };

    _game = game;
    _state = null;
    _hudEls = null;
    _hudKey = '';

    const cfg = CFG();
    const marks = (ctx.marks && ctx.marks.length) ? ctx.marks
                : (game.world && game.world._glbFlags) || [];
    const spots = _resolveFlags(marks, ctx.blueSpawns || [], ctx.redSpawns || []);

    console.log('[flags] flag placements:', spots.map(s =>
      s.team + (s.fromMap ? ' (map: ' + s.name + ')' : ' (auto)')).join(', '));

    /* Each flag sits on the ground under it the way Base Defend does: a ray
       straight down from high above, BEFORE any flag group is added — the
       probe must not hit the mode's own pole. If a flag model failed to load,
       _buildFlag still makes a placeholder group and the mode runs without art. */
    const groundY = (spot) => {
      const fallback = (ctx.box ? ctx.box.min.y : ctx.spawnY) || 0;
      try {
        const ray = new THREE.Raycaster(
          new THREE.Vector3(spot.x, fallback + 400, spot.z),
          new THREE.Vector3(0, -1, 0), 0, 900
        );
        ray.camera = _game.camera;
        const hits = ray.intersectObject(_game.scene, true);
        for(const h of hits){
          const o = h.object;
          if(!o.visible) continue;
          if(o.isSprite || o.isPoints || o.isLine) continue;
          if(o.userData && o.userData.noPhysics) continue;
          if(o.userData && o.userData.isVoid) continue;
          /* Skip our own glow discs / sprites from a previous match, if any. */
          if(o.userData && o.userData.stealFlagPiece) continue;
          if(isFinite(h.point.y)) return h.point.y;
        }
      } catch(e){}
      return (spot.y != null) ? spot.y : fallback;
    };

    _state = {
      flags: [], scores: { blue: 0, red: 0 },
      timeLeft: cfg.timeLimit || 300,
      overtime: false,
      winner: null, endedAt: 0,
      _client: !!ctx.client,
    };

    const ys = spots.map(groundY);

    for(let i = 0; i < spots.length; i++){
      let f = null;
      try {
        f = _buildFlag(spots[i], ys[i]);
        _updateFlagPanel(f);
        _poseFlag(f, 0.016);
      } catch(e){
        console.warn('[flags] one flag failed to build:', e);
      }
      if(!f) continue;
      _state.flags.push(f);
      _game.scene.add(f.home.grp);
      _game.scene.add(f.grp);
    }

    _hudEls = _hudInit();
    if(_hudEls && _hudEls.hud) _hudEls.hud.classList.remove('hidden');
    return _state;
  }

  function _killFlag(f){
    if(!f || !_game || !_game.scene) return;
    const roots = [f.grp, f.home && f.home.grp];
    for(const root of roots){
      if(!root) continue;
      if(root.parent) root.parent.remove(root);
      root.traverse(o => {
        /* The sprite's canvas texture is its own allocation and disposing the
           material does not free it — every match used to leave two 256px
           canvases resident, and the mode is restarted often. */
        if(o.material && o.material.map && o.material.map.dispose) o.material.map.dispose();
        if(o.geometry && o.geometry.dispose) o.geometry.dispose();
        if(o.material){
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach(m => m && m.dispose && m.dispose());
        }
      });
    }
    f.grp = null;
    f.home = null;
    f.sprite = null;
    f.modelGrp = null;
  }

  function dispose(){
    if(_state) for(const f of _state.flags) _killFlag(f);
    if(_hudEls && _hudEls.hud) _hudEls.hud.classList.add('hidden');
    _hudEls = null; _hudKey = '';
    _state = null; _game = null;
  }

  function getState(){ return _state; }

  /* THE OVERTIME SPEED HOOK, read by tank.js's speedCap chain. 1 outside an
     overtime costs the call site one property read and nothing else. */
  function speedMult(){
    if(!_state || !_state.overtime) return 1;
    return CFG().overtimeSpeedMult || 1;
  }

  /* ── the flag graphics helpers ─────────────────────────────────────── */

  function _loadOne(scene, url){
    return new Promise((resolve) => {
      try {
        const loader = new THREE.GLTFLoader();
        /* RESOLVE `{ group }`, NOT THE RAW GLTF.

           The call sites below read `res.group.clone()` and `_mountOf(res.group)`,
           but GLTFLoader hands back `{ scene, scenes, animations }` — there is no
           `group` on it. So this resolved a truthy object with an undefined
           `.group`, the `.clone()` threw, and the exception took the whole of
           init() with it: no flags were built and the mode ran without art.
           Measured live in the console as
             TypeError: Cannot read properties of undefined (reading 'clone')
             at Object.init (js/steal-flag.js:219:39)
           which is also the root of the long-standing "flag models never show
           up" report. The scene graph is the group these callers want. */
        loader.load(url, (gltf) => {
          const group = gltf && (gltf.scene || (gltf.scenes && gltf.scenes[0]));
          resolve(group ? { group } : null);
        }, undefined, () => resolve(null));
      } catch(e){ resolve(null); }
    });
  }

  function _mountOf(group){
    let m = null;
    if(group) group.traverse(o => { if(o.isGroup && o.name && (o.name.toLowerCase().includes('mount'))) m = o; });
    return m;
  }

  /* ── the state machine ────────────────────────────────────────────── */

  /* take: give the flag to a tank (enemy steals from home, or a teammate
     picks up a dropped own flag). */
  function _takeFlag(t, f){
    f.carrier = t;
    f.dropped = false;
    const me = _game && _game.localTank;
    const myTeam = (me && me.team) || 'blue';
    if(t === me){
      Menu.toast(f.team === myTeam
        ? 'You picked up your own dropped flag!'
        : 'You took the ENEMY flag — bring it home!');
    } else if(t.team === myTeam){
      Menu.toast((f.team === myTeam ? 'Teammate carrying YOUR flag' : 'Teammate carries the ENEMY flag!'));
    } else {
      Menu.toast(f.team === myTeam ? 'The ENEMY has YOUR flag!' : 'The enemy took their own flag');
    }
    console.log('[flags]', f.team, 'flag taken by', t.name || t.id || 'tank');
  }

  /* drop: carrier died — the flag lands where they fell. */
  function _dropFlag(f){
    const t = f.carrier;
    f.carrier = null;
    f.dropped = true;
    f.x = t.x; f.z = t.z;
    /* Drop it ON THE GROUND IT DIED OVER, not on the home ground: the two differ
       by the height of a hill on half the roster, and a flag that falls through
       the floor is the most obvious possible bug for the thing the mode is
       named after. */
    const gy = (t.root && t.root.position && isFinite(t.root.position.y)) ? t.root.position.y : f.groundY;
    if(isFinite(gy)) f.groundY = gy;
    if(f.grp) f.grp.position.set(f.x, f.groundY, f.z);
    const myTeam = _myTeam();
    Menu.toast(f.team === myTeam
      ? 'Your flag dropped — return it or the enemy sends it home!'
      : 'The ENEMY flag dropped — grab it!');
    console.log('[flags]', f.team, 'flag DROPPED at', f.x.toFixed(1), f.z.toFixed(1));
  }

  /* returnHome: enemy contact with a dropped flag, or a score paid. */
  function _returnFlag(f, silent){
    f.carrier = null;
    f.dropped = false;
    f.x = f.homeX; f.z = f.homeZ;
    f.groundY = f.homeGroundY;
    if(f.grp){ f.grp.position.set(f.homeX, f.homeGroundY, f.homeZ); f.grp.rotation.y = 0; }
    if(!silent){
      Menu.toast(f.team === _myTeam() ? 'Your flag is back at base' : 'A dropped flag went back to its base');
      console.log('[flags]', f.team, 'flag returned to base');
    }
  }

  /* score: the exchange — a runner touching THEIR OWN base while carrying
     the enemy flag, with their own flag standing at home. */
  function _scorePoint(f){
    const g = _state.flags.find(h => h.team === f.carrier.team);
    const carrier = f.carrier;
    _returnFlag(f, true);
    _state.scores[carrier.team] = (_state.scores[carrier.team] || 0) + 1;
    const sc = _state.scores;
    const myTeam = _myTeam();
    Menu.toast((carrier.team === myTeam ? 'FLAG CAPTURED! ' : 'They captured one! ')
      + 'Score ' + (sc.blue || 0) + ' - ' + (sc.red || 0) + ' (blue-red)');
    console.log('[flags]', carrier.team === myTeam ? 'YOUR' : 'ENEMY', 'point scored', sc);
    void g;
    /* OVERTIME: the first score ends the match instantly. */
    if(_state.overtime || (_state.scores[carrier.team] || 0) >= WIN_NEEDED()){
      _endMatch(carrier.team);
    }
  }

  /* endMatch — the ONE place this mode finishes a match. Results flow the
     same way every mode does: toast, then pay cash, then the results
     screen. Draws are a legal outcome: results.js renders headline 'DRAW'. */
  function _endMatch(winner){
    if(!_state || _state.winner) return;
    _state.winner = winner;
    _state.endedAt = _game ? (_game.time || 0) : 0;
    if(_state._client){
      /* A CLIENT MAY NOT DECIDE. The results arrive through the host's
         match-end message; here only the local visuals freeze. */
      return;
    }
    const myTeam = _myTeam();
    const won = (winner !== 'draw') && (myTeam === winner);
    const colorOf = (t) => (_game._displayColor) ? _game._displayColor(t) : t;
    if(winner === 'draw'){
      Menu.toast('Overtime over — nobody scored. It is a DRAW!');
    } else {
      Menu.toast(colorOf(winner) + ' team wins the flag race!');
    }
    setTimeout(() => {
      if(!_game || !_game.running) return;
      _game._awardBattleCash({
        damage: _game.localTank ? (_game.localTank.damageDealt || 0) : 0,
        assists: _game.localTank ? (_game.localTank.assists || 0) : 0,
        kills:  _game.localTank ? (_game.localTank.kills || 0) : 0,
        won: won,
      });
      _game._showResults({
        outcome: winner === 'draw' ? 'draw' : (won ? 'win' : 'loss'),
        headline: winner === 'draw' ? 'DRAW' : (won ? 'VICTORY' : 'DEFEAT'),
      });
    }, 2000);
  }

  /* ── the per-frame update ─────────────────────────────────────────── */

  function update(dt){
    if(!_state || !_game || _state.winner) return;
    const cfg = CFG();

    /* THE CLOCK. Only the host (or a local game) runs the timer; a client
       receives timeLeft in the snapshot and never ticks it itself. */
    if(!_state._client){
      _state.timeLeft = Math.max(0, _state.timeLeft - dt);
      if(_state.timeLeft <= 0 && !_state.winner){
        const b = _state.scores.blue || 0, r = _state.scores.red || 0;
        if(b !== r){
          _endMatch(b > r ? 'blue' : 'red');
          return;
        }
        if(!_state.overtime){
          _state.overtime = true;
          _state.timeLeft = cfg.overtimeTime || 60;
          Menu.toast('OVERTIME! +1.25% speed to EVERY tank — FIRST score wins!');
        } else {
          /* Overtime expired with nobody scoring: a draw. */
          _endMatch('draw');
          return;
        }
      }
    }

    /* CARRIER SYNC FIRST: the flag reads its carrier's position this frame,
       and a dead/dying carrier DROPs the flag where they fell. The on-floor
       dropped flag keeps the same touch radius as before — only the visual
       layer changed (GLB model instead of the old cloth pole + glow). */
    for(const f of _state.flags){
      if(f.carrier){
        const dead = !f.carrier.alive || f.carrier.dying;
        if(dead){
          _dropFlag(f);
        } else {
          f.x = f.carrier.x; f.z = f.carrier.z;
          const cy = (f.carrier.root && f.carrier.root.position && f.carrier.root.position.y != null)
            ? f.carrier.root.position.y : f.homeGroundY;
          if(isFinite(cy)) f.groundY = cy;
        }
      }
    }

    /* TOUCH RULES AND SCORING, host/local only — a client is fed these from
       the snapshot. */
    if(!_state._client){
      _tickTouchRules();
    }

    for(const f of _state.flags) _updateFlagPanel(f);
    for(const f of _state.flags) _poseFlag(f, dt);

    _updateHud();
  }

  /* ── TOUCH RULES — geometry and nothing else ───────────────────────── */

  function _tickTouchRules(){
    for(const f of _state.flags){
      /* RULE: TOUCHING A FLAG THAT IS NOT BEING CARRIED. */
      if(!f.carrier){
        const r = PICKUP_R();
        for(const t of _game.tanks){
          if(!t.alive || t.dying || t.isDummy || t.isPanzer) continue;
          const d = Math.hypot(t.x - f.x, t.z - f.z);
          if(d > r) continue;

          if(t.team === f.team){
            /* TEAMMATE: picks a DROPPED own flag up; at home a teammate's
               touch does nothing. */
            if(f.dropped){ _takeFlag(t, f); break; }
            continue;
          }
          /* ENEMY: steals from home; touching a DROPPED flag returns it to
             ITS OWN base. */
          if(f.dropped){
            _returnFlag(f, false);
          } else {
            _takeFlag(t, f);
          }
          break;
        }
      }
    }

    /* RULE: THE CAPTURE — one loop over carried flags, and only those.
       A runner carrying the enemy flag scores when THEIR OWN flag stands
       at home and the runner is within capture radius of ITS base. */
    for(const g of _state.flags){
      if(!g.carrier || g.carrier.team === g.team) continue;
      const own = _state.flags.find(h => h.team === g.carrier.team);
      if(!own || own.carrier || own.dropped) continue;
      const d = Math.hypot(g.carrier.x - own.homeX, g.carrier.z - own.homeZ);
      if(d <= CAPTURE_R()){
        _scorePoint(g);
        break;
      }
    }
  }

  /* ── visuals ──────────────────────────────────────────────────────── */

  /* Where the flag model, its plate and its home pad are THIS frame.

     Split from the rules on purpose: the touch rules are host-only (a client
     is fed the state) but the drawing has to happen everywhere, so this is
     called outside the `_client` guard. Everything here is derived from f.x /
     f.z / f.carrier, never from the map. */
  function _poseFlag(f, dt){
    if(!f || !f.grp) return;
    f._bob += dt;

    const carried = !!f.carrier;
    const atHome = !carried && !f.dropped;
    /* Carried: rides above the hull so it is visibly YOURS and not lying on the
       floor behind the tank. Home/dropped: sits on its own ground. */
    const y = carried ? (f.groundY + 3.2) : (isFinite(f.groundY) ? f.groundY : f.homeGroundY);
    f.grp.position.set(f.x, y, f.z);

    if(f.modelGrp){
      f.modelGrp.position.y = (f._modelLift || 0) + Math.sin(f._bob * 2.2) * 0.10;
      /* FACE THE CAMERA, HORIZONTALLY ONLY.

         A flag is a flat cloth: from the side it is a line, from behind it is
         the back of the art. Turning it about Y to face the viewer keeps the
         poles vertical (a full billboard would tilt the whole plant as the
         camera looks down, which reads as a falling flag) and keeps it legible
         from every angle as the camera orbits the tank.

         The `- PI` is the authored facing: the cloth points down -Z in the GLB,
         so it is turned round before the yaw is applied or both flags would
         show the camera their backs. */
      const cam = _game && _game.camera;
      if(cam){
        f.modelGrp.rotation.y = Math.atan2(
          cam.position.x - f.grp.position.x,
          cam.position.z - f.grp.position.z
        ) + Math.PI;
      }
    }
    if(f.sprite){
      f.sprite.position.y = LABEL_Y + Math.sin(f._bob * 1.7) * 0.22;
    }

    if(f.home && f.home.ringMat){
      /* The pad says whether this flag is where it belongs: a bright ring means
         "standing here", a dim one means "out in the field". Same information
         as the HUD, readable without looking away from the map. */
      const ringTarget = atHome ? 0.78 : 0.20;
      f.home.ringMat.opacity += (ringTarget - f.home.ringMat.opacity) * Math.min(1, dt * 6);
      f.home.beamMat.opacity = atHome ? (0.16 + 0.05 * Math.sin(f._bob * 2.0)) : 0.04;
      if(f.home.pad) f.home.pad.material.opacity = atHome ? (0.16 + 0.05 * Math.sin(f._bob * 1.6)) : 0.05;
    }
  }

  /* The panel above the flag, repainted only when its own state string
     changed (key compare first). */
  function _updateFlagPanel(f){
    const me = _game && _game.localTank;
    const myTeam = (me && me.team) || 'blue';
    const key = (f.team === myTeam ? 'Y' : 'E') + '|' + (f.carrier ? 'C' : f.dropped ? 'D' : 'H');
    if(key === f._drawKey) return;
    f._drawKey = key;

    try{
    if(f.sprite && f.sprite.material && f.sprite.material.map){
      const c = f.sprite.material.map.image;
      const x = c.getContext('2d');
      x.clearRect(0, 0, c.width, c.height);
      x.fillStyle = 'rgba(6,9,16,0.78)';
      x.beginPath(); x.roundRect(6, 6, 244, 52, 12); x.fill();
      x.lineWidth = 3; x.strokeStyle = _hex(f.teamHex); x.stroke();
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillStyle = '#fff';
      x.font = 'bold 19px Arial';
      const panel = (f.team === myTeam)
        ? (f.carrier ? 'YOUR FLAG CARRIED' : (f.dropped ? 'YOUR FLAG DROPPED' : 'YOUR FLAG'))
        : (f.carrier ? 'ENEMY FLAG CARRIED' : (f.dropped ? 'ENEMY FLAG DROPPED' : 'ENEMY FLAG'));
      x.fillText(panel, 128, 33);
      f.sprite.material.map.needsUpdate = true;
    }
    }catch(e){ /* a label must never take the objective down with it */ }
  }

  /* ── netcode — the same attitude base-defend takes ─────────────────── */

  function snapshot(){
    if(!_state) return null;
    return {
      scores: { blue: _state.scores.blue || 0, red: _state.scores.red || 0 },
      timeLeft: _state.timeLeft,
      overtime: !!_state.overtime,
      winner: _state.winner,
      flags: _state.flags.map(f => ({
        team: f.team,
        atHome: !f.carrier && !f.dropped,
        dropped: !!f.dropped,
        x: f.x, z: f.z,
        carrierTeam: f.carrier ? f.carrier.team : null,
      })),
    };
  }

  function applyHostSnapshot(s){
    if(!s || !_state || !_state._client) return;
    if(s.scores){
      _state.scores.blue = s.scores.blue || 0;
      _state.scores.red  = s.scores.red  || 0;
    }
    if(s.timeLeft != null) _state.timeLeft = s.timeLeft;
    _state.overtime = !!s.overtime;
    for(const rec of (s.flags || [])){
      const f = _state.flags.find(x => x.team === rec.team);
      if(!f) continue;
      if(rec.carrierTeam){
        /* The real tank objects exist on a client too (spawn messages carry
           every tank), so matching on TEAM is enough: one carrier per flag,
           one flag per team. */
        const t = (_game.tanks || []).find(t => t.team === rec.carrierTeam && !t.isDummy);
        if(t){ f.carrier = t; f.dropped = false; }
      } else if(rec.dropped){
        f.carrier = null;
        f.dropped = true;
        f.x = rec.x; f.z = rec.z;
        if(f.grp) f.grp.position.set(f.x, f.homeGroundY, f.z);
      } else if(rec.atHome){
        f.carrier = null;
        f.dropped = false;
        f.x = f.homeX; f.z = f.homeZ;
        if(f.grp){ f.grp.position.set(f.homeX, f.homeGroundY, f.homeZ); f.grp.rotation.y = 0; }
      }
    }
    /* The host's winner decides. _showResults comes from the host's match-end
       message; this freeze only stops local update() ticking past it. */
    if(s.winner && !_state.winner){
      _state.winner = s.winner;
    }
  }

  /* ── PUBLIC ───────────────────────────────────────────────────────── */
  return {
    init, update, dispose, getState,
    speedMult, snapshot, applyHostSnapshot,
  };
})();
