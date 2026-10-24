/* ============================================================
   capture-circle.js — Capture the Circle game mode
   Teams stand inside a glowing circle to capture it.
   100s base, 2x with 2+ allies, contested freezes,
   must decapture enemy % before capturing.

   Visuals
   ───────
   • zone ring painted into a canvas texture: fat black outline,
     dark track, team-coloured progress arc with a glossy core,
     segmented tick marks and a bright inner hairline
   • a slowly rotating outer dash ring (separate mesh so the
     dashes can spin without redrawing the whole texture)
   • "Flag" model by J-Toastie (poly.pizza) standing in the middle,
     tinted to whichever team currently holds the point, with a
     gentle wind sway
   • rising sparkles, looping shockwave pulses and a light column
   ============================================================ */

const CaptureCircle = (() => {
  let _game = null;
  let _state = null;

  let _zonePlane = null, _zoneCanvas = null, _zoneTex = null;
  let _spinPlane = null, _spinCanvas = null, _spinTex = null;
  let _glowDisc = null, _glowTex = null;
  let _uiSprite = null, _uiCanvas = null, _uiTex = null;

  let _flag = null;
  let _flagCloth = [];        // materials whose name says "flag" (the cloth)
  let _flagAllMats = [];      // every material, for disposal
  const _flagTint = new THREE.Color(0xffffff);

  let _beam = null, _beamTex = null;
  let _pulses = [];
  let _spark = null, _sparkGeo = null, _sparkTex = null;
  let _sparkPos = null, _sparkHome = null, _sparkVel = null, _nSpark = 0;

  let _zoneKey = '';
  let _zoneDrawAt = -1;

  /* ── zones ────────────────────────────────────────────────────────────
     ONE ZONE WAS ALWAYS ASSUMED. Everything above is a singleton, every
     draw call reads these names, and the capture point was hard-coded to the
     world origin. A map could therefore have exactly one objective no matter
     what it declared: world.js overwrote `_glbFlag` on each `flag` node it
     found, so Signal Map's second flag was collected and then dropped on the
     floor, silently.

     Rather than rewrite every draw call into zone-relative form -- which
     would put at risk the several real fixes living in those functions, from
     the "blue always means you" colour rule to the terrain probe -- the
     singletons are BOUND to one zone at a time. Each zone owns a complete set
     of them; `_bindZone` swaps the module names over to that zone's copy, the
     existing code runs unchanged, and `_unbindZone` puts them back.

     So the single-zone path is byte-for-byte the code that shipped. A map with
     one flag builds exactly one zone and behaves precisely as before; a map
     with two builds two, and the mode's rule becomes "hold every zone". */
  let _zones = [];
  /* The zone the module names are currently pointing at. Kept as a whole
     object rather than another swapped field because the ground probe needs
     the zone's X/Z to cast at, and a raycast at the origin would probe the
     wrong piece of terrain on every zone except the first. */
  let _boundZone = null;

  /* THE FIELDS THAT BELONG TO A ZONE RATHER THAN TO THE MODE.

     Listed explicitly rather than reflected over, because reflecting means
     eval, and a typo in an eval string fails silently at exactly the moment
     somebody adds a field to a zone and forgets this list. An explicit list
     makes the omission visible: the new field simply does not bind, and the
     zone shows the previous zone's state, which is at least a visible bug
     rather than a silent one. */
  const ZONE_FIELDS = [
    'zonePlane', 'zoneCanvas', 'zoneTex', 'spinPlane', 'spinCanvas', 'spinTex',
    'glowDisc', 'glowTex', 'uiSprite', 'uiCanvas', 'uiTex',
    'flag', 'flagCloth', 'flagAllMats', 'beam', 'beamTex', 'pulses',
    'spark', 'sparkGeo', 'sparkTex', 'sparkPos', 'sparkHome', 'sparkVel',
    'nSpark', 'zoneKey', 'zoneDrawAt', 'groundY', 'groundDone', 'flagGroundY',
    'sparkOffsetY', 'sparkY', 'groundTries', 'probeObjs',
  ];

  /* Snapshot the live module names into a plain object. */
  function _snapshot(){
    const o = {};
    for(const f of ZONE_FIELDS){
      switch(f){
        case 'zonePlane':   o[f] = _zonePlane; break;
        case 'zoneCanvas':  o[f] = _zoneCanvas; break;
        case 'zoneTex':     o[f] = _zoneTex; break;
        case 'spinPlane':   o[f] = _spinPlane; break;
        case 'spinCanvas':  o[f] = _spinCanvas; break;
        case 'spinTex':     o[f] = _spinTex; break;
        case 'glowDisc':    o[f] = _glowDisc; break;
        case 'glowTex':     o[f] = _glowTex; break;
        case 'uiSprite':    o[f] = _uiSprite; break;
        case 'uiCanvas':    o[f] = _uiCanvas; break;
        case 'uiTex':       o[f] = _uiTex; break;
        case 'flag':        o[f] = _flag; break;
        case 'flagCloth':   o[f] = _flagCloth; break;
        case 'flagAllMats': o[f] = _flagAllMats; break;
        case 'beam':        o[f] = _beam; break;
        case 'beamTex':     o[f] = _beamTex; break;
        case 'pulses':      o[f] = _pulses; break;
        case 'spark':       o[f] = _spark; break;
        case 'sparkGeo':    o[f] = _sparkGeo; break;
        case 'sparkTex':    o[f] = _sparkTex; break;
        case 'sparkPos':    o[f] = _sparkPos; break;
        case 'sparkHome':   o[f] = _sparkHome; break;
        case 'sparkVel':    o[f] = _sparkVel; break;
        case 'nSpark':      o[f] = _nSpark; break;
        case 'zoneKey':     o[f] = _zoneKey; break;
        case 'zoneDrawAt':  o[f] = _zoneDrawAt; break;
        case 'groundY':     o[f] = _groundY; break;
        case 'groundDone':  o[f] = _groundDone; break;
        case 'flagGroundY': o[f] = _flagGroundY; break;
        case 'sparkOffsetY':o[f] = _sparkOffsetY; break;
        case 'sparkY':      o[f] = _sparkY; break;
        case 'groundTries': o[f] = _groundTries; break;
        case 'probeObjs':   o[f] = _probeObjs; break;
      }
    }
    o.state = _state;
    o.boundZone = _boundZone;
    return o;
  }

  /* Point the module names at one zone, remembering where they came from. */
  function _bindZone(z){
    const prev = _snapshot();
    for(const f of ZONE_FIELDS){
      switch(f){
        case 'zonePlane':   _zonePlane = z.zonePlane; break;
        case 'zoneCanvas':  _zoneCanvas = z.zoneCanvas; break;
        case 'zoneTex':     _zoneTex = z.zoneTex; break;
        case 'spinPlane':   _spinPlane = z.spinPlane; break;
        case 'spinCanvas':  _spinCanvas = z.spinCanvas; break;
        case 'spinTex':     _spinTex = z.spinTex; break;
        case 'glowDisc':    _glowDisc = z.glowDisc; break;
        case 'glowTex':     _glowTex = z.glowTex; break;
        case 'uiSprite':    _uiSprite = z.uiSprite; break;
        case 'uiCanvas':    _uiCanvas = z.uiCanvas; break;
        case 'uiTex':       _uiTex = z.uiTex; break;
        case 'flag':        _flag = z.flag; break;
        case 'flagCloth':   _flagCloth = z.flagCloth; break;
        case 'flagAllMats': _flagAllMats = z.flagAllMats; break;
        case 'beam':        _beam = z.beam; break;
        case 'beamTex':     _beamTex = z.beamTex; break;
        case 'pulses':      _pulses = z.pulses; break;
        case 'spark':       _spark = z.spark; break;
        case 'sparkGeo':    _sparkGeo = z.sparkGeo; break;
        case 'sparkTex':    _sparkTex = z.sparkTex; break;
        case 'sparkPos':    _sparkPos = z.sparkPos; break;
        case 'sparkHome':   _sparkHome = z.sparkHome; break;
        case 'sparkVel':    _sparkVel = z.sparkVel; break;
        case 'nSpark':      _nSpark = z.nSpark; break;
        case 'zoneKey':     _zoneKey = z.zoneKey; break;
        case 'zoneDrawAt':  _zoneDrawAt = z.zoneDrawAt; break;
        case 'groundY':     _groundY = z.groundY; break;
        case 'groundDone':  _groundDone = z.groundDone; break;
        case 'flagGroundY': _flagGroundY = z.flagGroundY; break;
        case 'sparkOffsetY':_sparkOffsetY = z.sparkOffsetY; break;
        case 'sparkY':      _sparkY = z.sparkY; break;
        case 'groundTries': _groundTries = z.groundTries; break;
        case 'probeObjs':   _probeObjs = z.probeObjs; break;
      }
    }
    _state = z.state;
    _boundZone = z;
    return prev;
  }

  /* Put the module names back to what they were. */
  function _restoreZone(o){
    if(!o) return;
    for(const f of ZONE_FIELDS){
      switch(f){
        case 'zonePlane':   _zonePlane = o[f]; break;
        case 'zoneCanvas':  _zoneCanvas = o[f]; break;
        case 'zoneTex':     _zoneTex = o[f]; break;
        case 'spinPlane':   _spinPlane = o[f]; break;
        case 'spinCanvas':  _spinCanvas = o[f]; break;
        case 'spinTex':     _spinTex = o[f]; break;
        case 'glowDisc':    _glowDisc = o[f]; break;
        case 'glowTex':     _glowTex = o[f]; break;
        case 'uiSprite':    _uiSprite = o[f]; break;
        case 'uiCanvas':    _uiCanvas = o[f]; break;
        case 'uiTex':       _uiTex = o[f]; break;
        case 'flag':        _flag = o[f]; break;
        case 'flagCloth':   _flagCloth = o[f]; break;
        case 'flagAllMats': _flagAllMats = o[f]; break;
        case 'beam':        _beam = o[f]; break;
        case 'beamTex':     _beamTex = o[f]; break;
        case 'pulses':      _pulses = o[f]; break;
        case 'spark':       _spark = o[f]; break;
        case 'sparkGeo':    _sparkGeo = o[f]; break;
        case 'sparkTex':    _sparkTex = o[f]; break;
        case 'sparkPos':    _sparkPos = o[f]; break;
        case 'sparkHome':   _sparkHome = o[f]; break;
        case 'sparkVel':    _sparkVel = o[f]; break;
        case 'nSpark':      _nSpark = o[f]; break;
        case 'zoneKey':     _zoneKey = o[f]; break;
        case 'zoneDrawAt':  _zoneDrawAt = o[f]; break;
        case 'groundY':     _groundY = o[f]; break;
        case 'groundDone':  _groundDone = o[f]; break;
        case 'flagGroundY': _flagGroundY = o[f]; break;
        case 'sparkOffsetY':_sparkOffsetY = o[f]; break;
        case 'sparkY':      _sparkY = o[f]; break;
        case 'groundTries': _groundTries = o[f]; break;
        case 'probeObjs':   _probeObjs = o[f]; break;
      }
    }
    _state = o.state || null;
    _boundZone = o.boundZone || null;
  }

  /* Write the module names back INTO a zone, so its state is captured. */
  function _flushZone(z){
    const s = _snapshot();
    for(const f of ZONE_FIELDS) z[f] = s[f];
    z.state = _state;
    return z;
  }

  /* WHERE THE OBJECTIVES ARE.

     Read from the map's `flag` nodes. A map that declares none keeps the
     original behaviour exactly: one zone at the world origin, which is where
     every shipped map has always put it. */
  function _zoneCentres(){
    const w = _game && _game.world;
    let marks = (w && w._glbFlags) || [];
    if(!marks.length && w && w._glbFlag) marks = [w._glbFlag];
    if(!marks.length) return [{ x: 0, z: 0 }];
    return marks.map(m => ({ x: m.x || 0, z: m.z || 0 }));
  }

  let _groundY = 0;            // world Y of the terrain under the circle
  let _groundDone = false;     // terrain probed yet?
  let _sparkOffsetY = 0;       // how far the sparkle field sits above y = 0
  let _sparkY = null;          // per-particle base height (before the offset)
  const _own = new Set();      // our own meshes — never probe the ground through them
  let _flagGroundY = 0;        // ground height under the flag (the middle of the circle)
  let _groundTries = 0;        // how many times the probe has run
  let _probeObjs = null;       // cached candidate list for the probe

  const FLAG_URL = 'assets/flag.glb?v=20260927a';
  const FLAG_H = 7.5;         // target world height of the flag (1.5x bigger)
  /* BLUE is the fallback for a local tank with no team yet (the first frames of a
     match, or a mode with no teams); once there is a team, Game._displayColor
     decides, and it always answers blue for the player's own side. RED survives
     only as a value the module no longer picks directly -- the panel's two
     labels are literal strings, not this constant. */
  const BLUE = 0x4488ff, RED = 0xff4444, WHITE = 0xffffff;
  const AMBER = 0xfbbf24;

  const CFG = () => GAMEMODES.captureTheCircle;
  const RADIUS = () => CFG().circleRadius || 6;
  const CAP_TIME = () => CFG().captureTime || 100;

  /* The bound zone's centre, defaulting to the origin. Read by the terrain
     probe so it casts over whichever zone is currently being positioned. */
  const _zc = { get cx(){ return (_boundZone && _boundZone.cx) || 0; },
                get cz(){ return (_boundZone && _boundZone.cz) || 0; } };

  /* ── small canvas helpers ─────────────────────────────────────────── */
  const _hex = (n) => '#' + ('000000' + (n >>> 0).toString(16)).slice(-6);

  function _roundSprite(){
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(32, 32, 32, 0, Math.PI * 2); x.fill();
    const t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.LinearFilter;
    return t;
  }

  function _radialGlow(){
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0.0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.LinearFilter;
    return t;
  }

  function _beamGradient(){
    const c = document.createElement('canvas'); c.width = 8; c.height = 128;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 128, 0, 0);   // bottom → top
    g.addColorStop(0.0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 8, 128);
    const t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.LinearFilter;
    return t;
  }

  /* ── the stylised zone ring, painted into a texture ───────────────── */
  function _drawZone(prog, colorHex, contested){
    if(!_zoneCanvas || !_zoneTex) return;
    const S = _zoneCanvas.width, c = S / 2;
    const r = RADIUS();
    const px = (S / 2) / (r * 1.45);           // px per world unit
    const Rout = (r + 0.75) * px, Rin = (r - 0.45) * px;
    const Rm = (Rout + Rin) / 2, lw = Rout - Rin;

    const ctx = _zoneCanvas.getContext('2d');
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(c, c);
    ctx.lineCap = 'butt';

    // 1 — fat soft black outline
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 26;
    ctx.strokeStyle = 'rgba(0,0,0,0.78)';
    ctx.lineWidth = lw + 26;
    ctx.beginPath(); ctx.arc(0, 0, Rm, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;

    // 2 — dark track
    ctx.strokeStyle = '#15171c';
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(0, 0, Rm, 0, Math.PI * 2); ctx.stroke();

    // 3 — capture progress
    const start = -Math.PI / 2;
    const p = Math.max(0, Math.min(1, prog));
    if(p <= 0.001){
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath(); ctx.arc(0, 0, Rm, 0, Math.PI * 2); ctx.stroke();
    } else {
      const end = start + Math.PI * 2 * p;
      ctx.lineCap = 'round';
      ctx.strokeStyle = _hex(colorHex);
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(0, 0, Rm, start, end); ctx.stroke();
      // glossy core down the middle of the arc
      ctx.strokeStyle = 'rgba(255,255,255,0.38)';
      ctx.lineWidth = lw * 0.32;
      ctx.beginPath(); ctx.arc(0, 0, Rm, start, end); ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // 4 — bright inner hairline
    ctx.strokeStyle = contested ? 'rgba(251,191,36,0.85)' : 'rgba(255,255,255,0.42)';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(0, 0, Rin + 9, 0, Math.PI * 2); ctx.stroke();

    // 5 — segment ticks cut through the ring
    const N = 24;
    for(let i = 0; i < N; i++){
      const a = (i / N) * Math.PI * 2;
      const big = (i % 6) === 0;
      ctx.strokeStyle = big ? 'rgba(0,0,0,0.88)' : 'rgba(0,0,0,0.40)';
      ctx.lineWidth = big ? 15 : 8;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (Rin - 6), Math.sin(a) * (Rin - 6));
      ctx.lineTo(Math.cos(a) * (Rout + 6), Math.sin(a) * (Rout + 6));
      ctx.stroke();
    }

    // 6 — four inward chevrons at the cardinals (dark base + white core,
    //     so they stay readable on the light-grey ground of most maps)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for(let pass = 0; pass < 2; pass++){
      ctx.strokeStyle = pass === 0 ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.98)';
      ctx.lineWidth = pass === 0 ? 12 : 4;
      for(let i = 0; i < 4; i++){
        const a = (i / 4) * Math.PI * 2;
        const ux = Math.cos(a), uy = Math.sin(a);
        const d0 = Rout + 34, d1 = Rout + 14;
        const nx = -uy, ny = ux;
        ctx.beginPath();
        ctx.moveTo(ux * d0 - nx * 16, uy * d0 - ny * 16);
        ctx.lineTo(ux * d1, uy * d1);
        ctx.lineTo(ux * d0 + nx * 16, uy * d0 + ny * 16);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
    ctx.restore();
    _zoneTex.needsUpdate = true;
  }

  /* ── the rotating dash ring (drawn once, spun in 3D) ──────────────── */
  function _drawSpin(){
    if(!_spinCanvas) return;
    const S = _spinCanvas.width, c = S / 2;
    const r = RADIUS();
    const px = (S / 2) / (r * 1.45);
    const R = (r + 1.35) * px;
    const ctx = _spinCanvas.getContext('2d');
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(c, c);
    ctx.setLineDash([0.30 * px, 0.42 * px]);
    ctx.lineDashOffset = 0;
    // two-tone dashes so they read on light ground and on dark ground alike
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 0.26 * px;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 0.10 * px;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    _spinTex.needsUpdate = true;
  }

  function init(game){
    _game = game;
    /* ONE ZONE PER FLAG NODE.

       A map with no flag node gets the original single zone at the origin, so
       every map that shipped before Signal Map plays exactly as it did. A map
       with two flag nodes gets two zones, and the mode's win condition becomes
       "hold every zone" -- see the check in update(). */
    const centres = _zoneCentres();
    _zones = centres.map(c => ({
      cx: c.x, cz: c.z,
      state: { bluePercent: 0, redPercent: 0, owner: null },
      flagCloth: [], flagAllMats: [], pulses: [],
      zoneKey: '', zoneDrawAt: -1,
      groundY: 0, groundDone: false, flagGroundY: 0,
      sparkOffsetY: 0, sparkY: null, groundTries: 0, probeObjs: null, nSpark: 0,
    }));

    for(const z of _zones) _buildZone(z);

    /* Leave the module names pointing at the first zone, which is what every
       other function in here expects to find. */
    _bindZone(_zones[0]);
  }

  /* BUILDS ONE ZONE'S ARTWORK, AT (z.cx, z.cz).

     Every mesh below used to be added at the origin, because there was only
     ever one. Each is now offset to its own zone, and the zone's own state is
     flushed back onto it before returning so the next zone starts from
     defaults rather than from the previous zone's meshes.

     The artwork is deliberately identical per zone. Two visibly different
     capture points would read as two different rules, and the only difference
     that matters here is which one you are standing in. */
  function _buildZone(z){
    if(!_game || !_game.scene) return;
    /* Start this zone from clean defaults even though the module names still
       hold the previous zone's values. */
    _bindZone(z);
    _restoreZone({
      state: z.state, boundZone: z,
      flagCloth: [], flagAllMats: [], pulses: [], nSpark: 0,
      zoneKey: '', zoneDrawAt: -1, groundY: 0, groundDone: false,
      flagGroundY: 0, sparkOffsetY: 0, sparkY: null,
      groundTries: 0, probeObjs: null,
      spark: null, sparkGeo: null, sparkTex: null,
      sparkPos: null, sparkHome: null, sparkVel: null,
      glowDisc: null, glowTex: null, zonePlane: null, zoneCanvas: null,
      zoneTex: null, spinPlane: null, spinCanvas: null, spinTex: null,
      uiSprite: null, uiCanvas: null, uiTex: null,
      flag: null, beam: null, beamTex: null,
    });
    const r = RADIUS();
    const scene = _game.scene;
    const cx = z.cx || 0, cz = z.cz || 0;
    const plane = r * 1.45 * 2;          // world size of the square textures

    /* soft glow underneath everything */
    _glowTex = _radialGlow();
    _glowDisc = new THREE.Mesh(
      new THREE.PlaneGeometry(plane * 0.98, plane * 0.98),
      new THREE.MeshBasicMaterial({
        map: _glowTex, transparent: true, opacity: 0.16,
        color: WHITE, depthWrite: false, depthTest: true, toneMapped: false,
      })
    );
    _glowDisc.rotation.x = -Math.PI / 2;
    _glowDisc.position.set(cx, 0.08, cz);
    _glowDisc.renderOrder = 1;
    scene.add(_glowDisc);

    /* stylised zone ring */
    _zoneCanvas = document.createElement('canvas');
    _zoneCanvas.width = _zoneCanvas.height = 1024;
    _zoneTex = new THREE.CanvasTexture(_zoneCanvas);
    _zoneTex.minFilter = THREE.LinearFilter;
    _zonePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(plane, plane),
      new THREE.MeshBasicMaterial({
        map: _zoneTex, transparent: true, depthWrite: false, toneMapped: false,
      })
    );
    _zonePlane.rotation.x = -Math.PI / 2;
    _zonePlane.position.set(cx, 0.12, cz);
    _zonePlane.renderOrder = 2;
    scene.add(_zonePlane);

    /* rotating dash ring */
    _spinCanvas = document.createElement('canvas');
    _spinCanvas.width = _spinCanvas.height = 512;
    _spinTex = new THREE.CanvasTexture(_spinCanvas);
    _spinTex.minFilter = THREE.LinearFilter;
    _spinPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(plane, plane),
      new THREE.MeshBasicMaterial({
        map: _spinTex, transparent: true, opacity: 0.65, color: WHITE,
        depthWrite: false, toneMapped: false,
      })
    );
    _spinPlane.rotation.x = -Math.PI / 2;
    _spinPlane.position.set(cx, 0.14, cz);
    _spinPlane.renderOrder = 3;
    scene.add(_spinPlane);
    _drawSpin();

    /* light column behind the flag */
    _beamTex = _beamGradient();
    _beam = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.34, r * 0.60, 7.5, 40, 1, true),
      new THREE.MeshBasicMaterial({
        map: _beamTex, transparent: true, opacity: 0.14, color: WHITE,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
    );
    _beam.position.set(cx, 3.75, cz);
    _beam.renderOrder = 4;
    scene.add(_beam);

    /* two looping shockwaves */
    for(let i = 0; i < 2; i++){
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.88, 1.0, 72),
        new THREE.MeshBasicMaterial({
          color: WHITE, transparent: true, opacity: 0.5,
          side: THREE.DoubleSide, depthWrite: false,
          blending: THREE.AdditiveBlending, toneMapped: false,
        })
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(cx, 0.16, cz);
      m.renderOrder = 5;
      scene.add(m);
      _pulses.push({ mesh: m, phase: i * 0.5 });
    }

    /* rising sparkles */
    _sparkTex = _roundSprite();
    _nSpark = 70;
    _sparkPos = new Float32Array(_nSpark * 3);
    _sparkHome = new Float32Array(_nSpark * 3);
    _sparkVel = new Float32Array(_nSpark);
    for(let i = 0; i < _nSpark; i++){
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r * 0.92;
      /* `pz`, not `z` -- this used to be a local named `z`, which would now
         shadow the zone parameter and quietly ruin the offset below. */
      const px = Math.cos(a) * d, pz = Math.sin(a) * d;
      const y = Math.random() * 6.0;
      _sparkHome[i * 3] = px + cx; _sparkHome[i * 3 + 1] = y; _sparkHome[i * 3 + 2] = pz + cz;
      _sparkPos[i * 3] = px + cx; _sparkPos[i * 3 + 1] = y; _sparkPos[i * 3 + 2] = pz + cz;
      _sparkVel[i] = 0.5 + Math.random() * 1.3;
    }
    _sparkGeo = new THREE.BufferGeometry();
    _sparkGeo.setAttribute('position', new THREE.BufferAttribute(_sparkPos, 3));
    _spark = new THREE.Points(_sparkGeo, new THREE.PointsMaterial({
      map: _sparkTex, size: 0.55, transparent: true, opacity: 0.9,
      color: WHITE, depthWrite: false, blending: THREE.AdditiveBlending,
      sizeAttenuation: true, toneMapped: false,
    }));
    _spark.frustumCulled = false;
    _spark.renderOrder = 6;
    scene.add(_spark);

    /* UI sprite (team %) — lifted clear of the flag */
    _uiCanvas = document.createElement('canvas');
    _uiCanvas.width = 256;
    _uiCanvas.height = 80;
    _uiTex = new THREE.CanvasTexture(_uiCanvas);
    _uiTex.minFilter = THREE.LinearFilter;
    _uiSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: _uiTex, transparent: true, depthWrite: false, sizeAttenuation: true,
    }));
    _uiSprite.scale.set(10, 3, 1);
    _uiSprite.position.set(cx, 6.9, cz);
    _uiSprite.renderOrder = 7;
    scene.add(_uiSprite);

    _zoneDrawAt = -1;
    _zoneKey = '';

    // remember everything we just added so the ground probe skips it
    [_glowDisc, _zonePlane, _spinPlane, _beam, _spark, _uiSprite].forEach(m => { if(m) _own.add(m); });
    for(const p of _pulses) _own.add(p.mesh);
    _sparkY = new Float32Array(_nSpark);
    for(let i = 0; i < _nSpark; i++) _sparkY[i] = _sparkHome[i * 3 + 1];

    _loadFlag();

    /* Hand this zone's artwork back to the zone object, then clear the module
       names so the next zone cannot inherit any of it. Without this, zone 2
       would be built on top of zone 1's meshes and both would be added to the
       scene again. */
    _flushZone(z);
    _restoreZone({
      state: z.state, boundZone: z,
      flagCloth: [], flagAllMats: [], pulses: [], nSpark: 0,
      zoneKey: '', zoneDrawAt: -1, groundY: 0, groundDone: false,
      flagGroundY: 0, sparkOffsetY: 0, sparkY: null,
      groundTries: 0, probeObjs: null,
      spark: null, sparkGeo: null, sparkTex: null,
      sparkPos: null, sparkHome: null, sparkVel: null,
      glowDisc: null, glowTex: null, zonePlane: null, zoneCanvas: null,
      zoneTex: null, spinPlane: null, spinCanvas: null, spinTex: null,
      uiSprite: null, uiCanvas: null, uiTex: null,
      flag: null, beam: null, beamTex: null,
    });
  }

  /* ── sit everything on the actual terrain ──────────────────────────
     Maps are GLB models whose floor is not at y = 0, so the ring used
     to end up buried a few centimetres under the ground and nothing of
     it was ever visible. Probe the terrain once (after the tanks have
     finished dropping in) and lift the whole capture point to it.      */
  /* the ring itself — it must clear the terrain under every part of the
     artwork, so it is lifted to the HIGHEST ground it covers            */
  function _setGroundY(y){
    if(!isFinite(y) || Math.abs(y - _groundY) < 0.002) return;
    const d = y - _groundY;
    _groundY = y;
    if(_glowDisc) _glowDisc.position.y += d;
    if(_zonePlane) _zonePlane.position.y += d;
    if(_spinPlane) _spinPlane.position.y += d;
    for(const p of _pulses) p.mesh.position.y += d;
    _sparkOffsetY += d;
  }

  /* the flag, its light column and the score panel live in the middle of
     the circle, which can sit at a different height than the ring         */
  function _setFlagGroundY(y){
    if(!isFinite(y) || Math.abs(y - _flagGroundY) < 0.002) return;
    const d = y - _flagGroundY;
    _flagGroundY = y;
    if(_beam) _beam.position.y += d;
    if(_uiSprite) _uiSprite.position.y += d;
    if(_flag) _flag.position.y += d;
  }

  function _sampleGroundY(){
    if(_groundDone || !_game || _groundTries >= 600) return;
    _groundTries++;
    if(_groundTries > 30 && (_groundTries % 4) !== 0) return;   // keep the retries cheap

    /* candidate surfaces: the map, minus ourselves, minus the tanks and
       minus little scatter (grass tufts, debris) that would lie about
       where the ground actually is                                      */
    const skip = new Set();
    const addTree = (o) => { if(o) o.traverse((c) => skip.add(c)); };
    _own.forEach(addTree);
    const tanks = _game.tanks || [];
    for(let i = 0; i < tanks.length; i++) addTree(tanks[i] && tanks[i].root);

    const objs = [];
    try {
      _game.scene.updateMatrixWorld(true);
      _game.scene.traverse((o) => {
        if(!o.isMesh || !o.visible || !o.matrixWorld || !o.geometry) return;
        if(skip.has(o) || o.isSprite || o.isPoints || o.isLine) return;
        try {
          if(!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
          const e = o.matrixWorld.elements;
          const ws = Math.hypot(e[0], e[1], e[2]) || 1;
          if(o.geometry.boundingSphere.radius * ws < 2) return;
        } catch(err){ return; }
        objs.push(o);
      });
    } catch(e){ return; }
    if(!objs.length) return;
    _probeObjs = objs;

    const r = RADIUS();
    const centre = [], ring = [], pts = [];
    const push = (arr, rad, n) => {
      for(let a = 0; a < n; a++){
        const ang = (a / n) * Math.PI * 2;
        pts.push([Math.cos(ang) * rad, Math.sin(ang) * rad, arr]);
      }
    };
    push(centre, 0, 1);
    push(centre, 1.5, 4);
    push(ring, r * 0.55, 6);
    push(ring, r, 8);          // the ring stroke + the rotating dashes
    push(ring, r * 1.12, 8);   // the chevrons on the outside

    for(const p of pts){
      try {
        /* CAST AT THIS ZONE, NOT AT THE ORIGIN.

           The probe samples the floor under the ring, and the sample points
           are laid out relative to the zone centre. Casting straight down at
           (x, 8, z) would therefore drop the ray through thin air on every
           zone except the first, find no hit, and leave that zone's ring
           sitting at y = 0 -- buried in the ground on any map whose floor is
           not at zero, and invisible. */
        const ray = new THREE.Raycaster(
          new THREE.Vector3(p[0] + _zc.cx, 8, p[1] + _zc.cz),
          new THREE.Vector3(0, -1, 0), 0, 80);
        const hits = ray.intersectObjects(_probeObjs, false);
        if(!hits.length) continue;
        const y = hits[0].point.y;
        if(y < -3 || y > 20) continue;
        p[2].push(y);
      } catch(e){}
    }
    if(ring.length < 3) return;
    _groundDone = true;

    const pick = (arr) => {
      const s = arr.slice().sort((a, b) => a - b);
      const med = s[Math.floor(s.length / 2)];
      return Math.min(s[s.length - 1], med + 3);   // one stray tree must not lift the whole zone
    };
    _setGroundY(pick(ring) + 0.06);
    _setFlagGroundY(centre.length >= 2 ? pick(centre) + 0.03 : _groundY);
  }

  /* ── the flag model, tinted per team ──────────────────────────────── */
  function _loadFlag(){
    let L = null;
    try { L = (typeof THREE !== 'undefined' && THREE.GLTFLoader) || window.GLTFLoader; } catch(e){}
    if(typeof GLTFLoader !== 'undefined' && !L) L = GLTFLoader;
    if(!L){ console.warn('[capture] GLTFLoader unavailable'); return; }
    let loader;
    try { loader = new L(); } catch(e){ console.warn('[capture] loader failed', e); return; }

    /* CAPTURED NOW, BECAUSE THIS CALLBACK RUNS LATER.

       The load is asynchronous, and by the time it completes every zone has
       been built and the module names are pointing at whichever zone was bound
       last. Writing `_flag = root` from inside this callback would therefore
       hand zone 2's flag to zone 1 -- and on a single-zone map, where nothing
       else is wrong, it would silently overwrite the correct flag with a
       stale one on every rebuild.

       So the zone is captured synchronously, along with the ground height it
       was built against, and the results are written to THAT zone. The module
       names are updated too, but only when this zone happens to be the bound
       one, which keeps the tinting code working unchanged. */
    const zone    = _boundZone;
    const groundY = _flagGroundY;

    loader.load(FLAG_URL, (gltf) => {
      const root = (gltf && gltf.scene) ? gltf.scene : gltf;
      if(!root || !_game || !_game.scene){
        return;
      }
      // normalise: measure at scale 1, then scale and sit it on the ground
      root.position.set(0, 0, 0);
      root.rotation.set(0, 0, 0);
      root.scale.set(1, 1, 1);
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      /* X/Z must centre on the POLE, not on the whole model. The cloth flies
         away to one side of the pole, so a full-bbox centre plants the pole
         leaning off the middle of the circle - which is exactly the visible
         mismatch between "the ring" and "the flag standing in it". Measure
         only the meshes that are NOT the flag cloth, and stand that axis
         precisely on the centre point. */
      const poleBox = new THREE.Box3();
      root.traverse((o) => {
        if(!o.isMesh){ return; }
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        let isCloth = false;
        for(const mt of mats){
          const nm = ((o.name || '') + ' ' + (mt && mt.name ? mt.name : '')).toLowerCase();
          if(nm.indexOf('flag') !== -1){ isCloth = true; break; }
        }
        if(isCloth) return;
        poleBox.expandByObject(o);
      });
      const useBox = poleBox.isEmpty() ? box : poleBox;
      const size = new THREE.Vector3(); box.getSize(size);
      const h = (size.y > 0.0001) ? size.y : 1;
      const s = FLAG_H / h;
      root.scale.setScalar(s);
      root.position.set(
        -((useBox.min.x + useBox.max.x) / 2) * s,
        -box.min.y * s,
        -((useBox.min.z + useBox.max.z) / 2) * s
      );

      const cloth = [];
      const allMats = [];
      root.traverse((o) => {
        if(!o.isMesh) return;
        o.castShadow = false;
        o.receiveShadow = false;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for(const m of mats){
          if(!m) continue;
          if(allMats.indexOf(m) === -1) allMats.push(m);
          const n = (m.name || '').toLowerCase();
          const wantsCloth = n.indexOf('flag') !== -1;
          const isPole = n.indexOf('pole') !== -1 || n.indexOf('metal') !== -1;
          if(wantsCloth || (!isPole && cloth.length === 0 && n !== 'other')){
            if(cloth.indexOf(m) === -1) cloth.push(m);
          }
        }
      });
      if(!cloth.length){
        root.traverse((o) => {
          if(!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for(const m of mats){
            if(m && cloth.indexOf(m) === -1 &&
               (m.name || '').toLowerCase().indexOf('pole') === -1) cloth.push(m);
          }
        });
      }
      root.position.y += groundY;
      /* Stand it in its own zone. The flag model was always planted at the
         origin, which is correct on every map that has one flag and silently
         wrong on Signal Map, where it would leave both models stacked in the
         middle of a map that declares two separate objectives. */
      if(zone){
        root.position.x += zone.cx || 0;
        root.position.z += zone.cz || 0;
      }
      /* The load is async: if the ground probe moved this zone's base height
         while the model was still downloading, the captured groundY is stale.
         Snap to whatever the probe has live for this zone, so the flag lands
         ON the ground instead of floating above (or buried under) it. */
      if(_boundZone === zone && isFinite(_flagGroundY) &&
         Math.abs(_flagGroundY - groundY) > 0.002){
        root.position.y += _flagGroundY - groundY;
      }
      _own.add(root);
      _game.scene.add(root);

      /* Record it against the zone that asked for it... */
      if(zone){ zone.flag = root; zone.flagCloth = cloth; zone.flagAllMats = allMats; }
      /* ...and against the live names, but only if that zone is the one the
         module is currently pointing at. */
      if(_boundZone === zone){ _flag = root; _flagCloth = cloth; _flagAllMats = allMats; }
    }, undefined, (err) => {
      console.warn('[capture] flag load failed', err && err.message ? err.message : err);
    });
  }

  function update(dt){
    if(!_state || !_game || _state.winner) return;
    const tanks = _game.tanks;
    const r = RADIUS();

    /* A zone counts as HELD once either side has taken it to 100%. Ownership is
       sticky: a full bar does not start draining again the moment the enemy
       walks in, because the mode is about holding ground and a capture that
       silently un-wins the instant you are pushed off is unreadable. */
    let blueHolds = 0, redHolds = 0;

    for(const z of _zones){
      const prev = _bindZone(z);
      const cx = z.cx || 0, cz = z.cz || 0;

      let blueIn = 0, redIn = 0;
      for(const t of tanks){
        if(!t.alive || t.dying || t.isDummy) continue;
        const d = Math.hypot(t.x - cx, t.z - cz);
        if(d <= r){
          if(t.team === 'blue') blueIn++;
          else if(t.team === 'red') redIn++;
        }
      }

      const contested = blueIn > 0 && redIn > 0;
      const speed = 1 / CAP_TIME();

      if(!contested){
        if(blueIn > 0){
          const rate = blueIn >= 2 ? speed * 2 : speed;
          if(_state.redPercent > 0){
            _state.redPercent = Math.max(0, _state.redPercent - rate * dt * 100);
          } else {
            _state.bluePercent = Math.min(100, _state.bluePercent + rate * dt * 100);
          }
        }
        if(redIn > 0){
          const rate = redIn >= 2 ? speed * 2 : speed;
          if(_state.bluePercent > 0){
            _state.bluePercent = Math.max(0, _state.bluePercent - rate * dt * 100);
          } else {
            _state.redPercent = Math.min(100, _state.redPercent + rate * dt * 100);
          }
        }
      }

      if(_state.bluePercent >= 100) _state.owner = 'blue';
      else if(_state.redPercent >= 100) _state.owner = 'red';
      else _state.owner = null;
      if(_state.owner === 'blue') blueHolds++;
      else if(_state.owner === 'red') redHolds++;

      _updateVisuals(dt, blueIn, redIn, contested);
      _flushZone(z);
      _restoreZone(prev);
    }

    /* THE WIN CONDITION IS "EVERY ZONE", NOT "ONE ZONE".

       With a single zone this is exactly the old rule -- a team that fills the
       one bar wins -- because every-zone and any-zone are the same statement
       when there is only one zone.

       With two zones a team must hold BOTH. It cannot win by taking one, so the
       second flag is a genuine objective rather than decoration, and a team
       sitting on one flag while the enemy takes the other watches the match
       continue. The teams cannot both satisfy the condition at once, because a
       zone has exactly one owner. */
    const needAll = _zones.length;
    const _modeWinner = (blueHolds === needAll) ? 'blue'
                      : (redHolds === needAll) ? 'red' : null;
    _state = _zones[0] ? _zones[0].state : null;
    if(_state && !_state.winner) _state.winner = _modeWinner;

    if(!_modeWinner || (_state && _state.winner !== _modeWinner)) return;

    /* THE MATCH IS OVER — RESULTS, NOT THE MENU.

       Both branches used to toast the winner and drop the player to the menu
       three seconds later, throwing away the whole battle. They now hand off to
       Game._showResults(), which pays the cash and shows the screen, so the
       100% capture reads as something you earned a record for.

       The cash is paid HERE, before the screen, because the rewards panel has to
       show the figure that was actually credited to the wallet — paying it on
       the way out instead would let a player see a number that was never paid. */
    if(_modeWinner === 'blue'){
      Menu.toast(_zones.length > 1
        ? 'Blue team wins! All flags captured!'
        : 'Blue team wins! Circle captured!');
      const myTeam = (_game.localTank && _game.localTank.team) || 'blue';
      const won = myTeam === 'blue';
      setTimeout(() => {
        if(!_game || !_game.running) return;
        _game._awardBattleCash({
          damage: _game.localTank ? (_game.localTank.damageDealt || 0) : 0,
          assists: _game.localTank ? (_game.localTank.assists || 0) : 0,
          kills:  _game.localTank ? (_game.localTank.kills || 0) : 0,
          won: won,
        });
        _game._showResults({ outcome: won ? 'win' : 'loss', headline: won ? 'VICTORY' : 'DEFEAT' });
      }, 2000);
    } else {
      Menu.toast(_zones.length > 1
        ? 'Red team wins! All flags captured!'
        : 'Red team wins! Circle captured!');
      const myTeam = (_game.localTank && _game.localTank.team) || 'blue';
      const won = myTeam === 'red';
      setTimeout(() => {
        if(!_game || !_game.running) return;
        _game._awardBattleCash({
          damage: _game.localTank ? (_game.localTank.damageDealt || 0) : 0,
          assists: _game.localTank ? (_game.localTank.assists || 0) : 0,
          kills:  _game.localTank ? (_game.localTank.kills || 0) : 0,
          won: won,
        });
        _game._showResults({ outcome: won ? 'win' : 'loss', headline: won ? 'VICTORY' : 'DEFEAT' });
      }, 2000);
    }
  }

  function _updateVisuals(dt, blueIn, redIn, contested){
    if(!_zonePlane || !_uiSprite) return;
    _sampleGroundY();
    const t = _game.time || 0;

    /* THE RING SHOWS THE COLOUR OF WHATEVER TEAM IS AHEAD, AND "BLUE" ALWAYS MEANS
       YOU -- NEVER THE TEAM WHOSE SPAWN POINT SAYS "blue".

       The absolute version of these lines -- `blueLead` read straight off
       _state.bluePercent, then `blueLead ? BLUE : RED` -- is why a player who
       took a red spawn watched the ring turn RED while their own side was
       capturing, and blue while the enemy was winning. The ring is the single
       largest thing on screen in this mode and it changes colour as the score
       moves, so that is not a mislabelled number: it tells the player the wrong
       team is winning while they are winning.

       So both halves are relative. WHICH team is ahead is read through the
       player, and WHICH COLOUR that team wears comes from Game._displayColor,
       which answers blue for the player's own side and red for the other no
       matter which one that is. Game._displaySide is the same rule without the
       hex.

       THE TIE IS STILL WHITE, and it is checked against the raw percentages
       rather than `myLead === theirPct`. Both spellings are equivalent here
       (the two numbers are simply read in the other order), but the raw
       comparison cannot drift if someone later changes how the percentages are
       derived -- a tie is a tie regardless of whose side you are on. */
    const myTeam    = (_game && _game.localTank && _game.localTank.team) || 'blue';
    const enemyTeam = myTeam === 'blue' ? 'red' : 'blue';
    const myLead    = myTeam === 'blue' ? _state.bluePercent : _state.redPercent;
    const theirPct  = myTeam === 'blue' ? _state.redPercent  : _state.bluePercent;
    const prog = Math.max(myLead, theirPct) / 100;
    const ahead = myLead >= theirPct ? myTeam : enemyTeam;
    let ringColor = (_game && _game._displayColor) ? _game._displayColor(ahead) : BLUE;
    if(_state.bluePercent === _state.redPercent) ringColor = WHITE;
    const colorHex = contested ? AMBER : ringColor;

    /* zone texture — only repaint when something actually changed */
    const key = Math.round(prog * 100) + '|' + colorHex + '|' + (contested ? 1 : 0);
    if(key !== _zoneKey && (t - _zoneDrawAt) > 0.12){
      _zoneKey = key;
      _zoneDrawAt = t;
      _drawZone(contested ? Math.max(prog, 0.001) : prog, colorHex, contested);
    }

    /* spin + colour of the outer dashes */
    if(_spinPlane){
      _spinPlane.rotation.z -= dt * 0.55;
      _spinPlane.material.color.setHex(colorHex);
      _spinPlane.material.opacity = 0.42 + (contested ? 0.30 : 0) + 0.10 * Math.sin(t * 3);
    }

    /* soft glow */
    if(_glowDisc){
      _glowDisc.material.color.setHex(colorHex);
      _glowDisc.material.opacity = 0.24 + 0.08 * Math.sin(t * 2.0) + (contested ? 0.10 : 0);
    }

    /* light column */
    if(_beam){
      _beam.material.color.setHex(colorHex);
      _beam.material.opacity = 0.11 + 0.05 * Math.sin(t * 2.6) + (contested ? 0.07 : 0);
      _beam.rotation.y += dt * 0.35;
    }

    /* shockwaves */
    for(let i = 0; i < _pulses.length; i++){
      const p = _pulses[i];
      const k = ((t * 0.42) + p.phase) % 1;
      const s = (0.35 + k * 0.95) * RADIUS();
      p.mesh.scale.set(s, s, 1);
      p.mesh.material.color.setHex(colorHex);
      p.mesh.material.opacity = Math.max(0, (1 - k)) * 0.42;
    }

    /* sparkles */
    if(_spark){
      _spark.material.color.setHex(colorHex);
      _spark.material.opacity = 0.75 + (contested ? 0.20 : 0) + 0.10 * Math.sin(t * 4);
      for(let i = 0; i < _nSpark; i++){
        let y = _sparkY[i] + _sparkVel[i] * dt;
        if(y > 6.4){
          y = 0.06;
        }
        _sparkY[i] = y;
        _sparkPos[i * 3]     = _sparkHome[i * 3] + Math.sin(t * 1.25 + i * 0.7) * 0.26;
        _sparkPos[i * 3 + 1] = y + _sparkOffsetY;
        _sparkPos[i * 3 + 2] = _sparkHome[i * 3 + 2] + Math.cos(t * 1.05 + i * 1.3) * 0.26;
      }
      _sparkGeo.attributes.position.needsUpdate = true;
    }

    /* the flag: tint toward the holding team, sway in the wind */
    if(_flag){
      _flagTint.lerp(new THREE.Color(colorHex), Math.min(1, dt * 5));
      for(const m of _flagCloth){
        if(m.color) m.color.copy(_flagTint);
        if(m.emissive) m.emissive.copy(_flagTint).multiplyScalar(0.22);
        m.side = THREE.DoubleSide;
      }
      _flag.rotation.y = Math.sin(t * 0.55) * 0.14;
      _flag.rotation.z = Math.sin(t * 1.65) * 0.032;
      _flag.rotation.x = Math.cos(t * 1.15) * 0.014;
    }

    /* UI canvas */
    if(_uiCanvas){
      const ctx = _uiCanvas.getContext('2d');
      ctx.clearRect(0, 0, 256, 80);

      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.roundRect(8, 8, 240, 64, 12);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = contested ? '#fbbf24' : 'rgba(255,255,255,0.35)';
      ctx.stroke();

      /* THE LEFT COLUMN IS ALWAYS *YOUR* TEAM, AND IS ALWAYS CALLED BLUE.

         This panel used to print _state.bluePercent under a hard-coded 'BLUE'
         on the left and _state.redPercent under 'RED' on the right. For a
         player on the red side that put their own capture progress on the right
         of the panel, labelled RED, next to the enemy on the left labelled
         BLUE -- so the panel agreed with neither the ring (now fixed above) nor
         the player.

         Now the columns are ordered by RELATIONSHIP, not by id: left is mine,
         right is theirs, and the percentages follow their columns. The labels
         are fixed text rather than derived from the team, because "BLUE" and
         "RED" here mean *yours* and *theirs* and stop being team ids. The
         colours are the same two hexes the ring uses. */
      const myTeam   = (_game && _game.localTank && _game.localTank.team) || 'blue';
      const minePct  = Math.round(myTeam === 'blue' ? _state.bluePercent : _state.redPercent);
      const theirPct = Math.round(myTeam === 'blue' ? _state.redPercent : _state.bluePercent);

      ctx.textAlign = 'center';
      ctx.fillStyle = '#66aaff';
      ctx.font = 'bold 22px Arial';
      ctx.fillText('BLUE', 64, 35);
      ctx.font = 'bold 28px Arial';
      ctx.fillText(minePct + '%', 64, 62);

      ctx.fillStyle = contested ? '#fbbf24' : 'rgba(255,255,255,0.4)';
      ctx.font = 'bold 14px Arial';
      ctx.fillText(contested ? 'LOCKED' : 'VS', 128, 44);

      ctx.fillStyle = '#ff7777';
      ctx.font = 'bold 22px Arial';
      ctx.fillText('RED', 192, 35);
      ctx.font = 'bold 28px Arial';
      ctx.fillText(theirPct + '%', 192, 62);

      _uiTex.needsUpdate = true;
    }
  }

  /* The HUD reads bluePercent / redPercent off the returned state, so those stay
     the FIRST zone's numbers and the mode is unchanged for a one-flag map. The
     per-zone list and the match winner are published alongside them for
     anything that wants to show "1 of 2 flags held". */
  function getState(){
    if(!_state) return null;
    const s = _state;
    s.zones = _zones.map(z => ({
      cx: z.cx, cz: z.cz,
      bluePercent: z.state.bluePercent, redPercent: z.state.redPercent,
      owner: z.state.owner,
    }));
    s.zoneCount = _zones.length;
    return s;
  }

  function _kill(mesh, extra){
    if(!mesh || !_game || !_game.scene) return;
    _game.scene.remove(mesh);
    if(mesh.geometry) mesh.geometry.dispose();
    if(mesh.material){
      if(Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
      else mesh.material.dispose();
    }
    if(extra) extra();
  }

  function dispose(){
    /* ONE ZONE AT A TIME, bound, so the same teardown applies to every set of
       meshes. Killing only the bound zone's would leak the rest -- every
       texture, geometry and material on zones 1..N-1 would stay alive and,
       worse, stay in the scene for the next match. */
    for(const z of _zones){
      _bindZone(z);
      _kill(_glowDisc, () => { if(_glowTex) _glowTex.dispose(); });
      _kill(_zonePlane, () => { if(_zoneTex) _zoneTex.dispose(); });
      _kill(_spinPlane, () => { if(_spinTex) _spinTex.dispose(); });
      _kill(_beam, () => { if(_beamTex) _beamTex.dispose(); });
      for(const p of _pulses) _kill(p.mesh);
      _pulses = [];
      if(_spark){
        if(_game && _game.scene) _game.scene.remove(_spark);
        if(_sparkGeo) _sparkGeo.dispose();
        if(_spark && _spark.material) _spark.material.dispose();
        if(_sparkTex) _sparkTex.dispose();
      }
      if(_flag){
        if(_game && _game.scene) _game.scene.remove(_flag);
        for(const m of _flagAllMats){
          try {
            if(m.map) m.map.dispose();
            m.dispose();
          } catch(e){}
        }
      }
      if(_uiSprite && _game && _game.scene){
        _game.scene.remove(_uiSprite);
        _uiSprite.material.dispose();
      }
      if(_uiTex) _uiTex.dispose();
    }
    _zones = [];

    _glowDisc = _zonePlane = _spinPlane = _beam = _spark = _flag = _uiSprite = null;
    _zoneCanvas = _spinCanvas = _uiCanvas = null;
    _zoneTex = _spinTex = _glowTex = _beamTex = _sparkTex = _uiTex = null;
    _sparkGeo = null;
    _sparkPos = _sparkHome = _sparkVel = null;
    _flagCloth = []; _flagAllMats = [];
    _zoneKey = ''; _zoneDrawAt = -1;
    _own.clear();
    _groundY = 0; _groundDone = false;
    _flagGroundY = 0;
    _groundTries = 0; _probeObjs = null;
    _sparkOffsetY = 0; _sparkY = null;
    _state = null;
    _game = null;
  }

  return { init, update, getState, dispose };
})();
