/* The WebGPU renderer runs the frame through the filmic tone curve; the WebGL
   build this game was tuned on does not. A flat backdrop colour (sky, fog) is
   therefore noticeably darker on WebGPU, so it is pre-brightened by the
   inverse of that curve: the shade that comes out is then the same one the
   player knows. Colours everywhere else are handled by the light trim in
   index.html. */
function _backdropColor(hex){
  if(!window.__isWebGPU) return new THREE.Color(hex);
  const aces = (x) => { const v = x*(2.51*x + 0.03) / (x*(2.43*x + 0.59) + 0.14); return v < 0 ? 0 : (v > 1 ? 1 : v); };
  const inv = (y) => { let lo = 0, hi = 8; for(let i=0;i<40;i++){ const m = (lo+hi)/2; if(aces(m) < y) lo = m; else hi = m; } return (lo+hi)/2; };
  const c = new THREE.Color(hex);
  return new THREE.Color(inv(c.r), inv(c.g), inv(c.b));
}

class World {
  constructor(scene){
    this.scene = scene;
    this.walls = [];
    this.trees = [];
    this.bushes = [];
    this.lakes = [];
    this._customMeshes = [];
    // The active GLB battle map. Tracked SEPARATELY from _customMeshes:
    // _clearCustom() (which runs from _resetArena()/loadCustomMapData())
    // disposes + scene.remove()s everything it owns, and the live map must
    // never be in that list or the whole arena vanishes mid-battle.
    this._glbGroup = null;
    /* Where the loaded map's trees are, collected at load time by the pine/taiga
       handler in loadGLBModel and spent by _buildTreeBlobs. Reset per map, not
       per arena, for the same reason _glbPines is: a map that ships no conifers
       must not inherit the previous map's ground shadows. */
    this._treeBlobSpots = [];
    this._foliageBatches = null;
    this._waterMaterials = [];
    this._quality = 'default';
    this.size = CONFIG.WORLD_SIZE;
    this.half = this.size / 2;
    /* Spatial index for the per-frame point queries below. Built lazily by
       _ensureIndex() so the constructor stays free of ordering assumptions. */
    this._idxCell = 0;
    this._idxWall = null;
    this._idxBush = null;
    this._idxStamp = 0;
    this._idxSink = [];
    this._build();
  }

  /* =============================================================================
     SPATIAL INDEX

     collidesWallsOnly(), hidingIn() and camoFactor() were all straight linear
     scans over every wall / bush in the level, and they are called constantly:

       * collidesWallsOnly -- once per 1.5-unit step of the aim-line raymarch,
         up to 90 times per rebuild, plus once more per step of the ricochet
         prediction. On a detailed GLB map that is tens of thousands of
         comparisons on the frame after every turret twitch.
       * hidingIn + camoFactor -- both called for EVERY tank EVERY frame, and
         they scan the same bush list, so the same work is done twice over, then
         a third time by the TDM bush check.

     A GLB map pushes one wall entry per cover root and one bush entry per bush
     root, which is easily several hundred of each. Scanning all of them, that
     often, is a large and CONSTANT slice of the frame budget -- the kind of
     cost that shows up as the game hitching under load rather than at any one
     identifiable moment.

     A uniform grid fixes it: each wall/bush is registered into the cells its
     footprint touches, and a query only visits the cells under the query
     point. Query cost becomes proportional to what is actually nearby instead
     of to the size of the map.

     Rebuilt lazily and invalidated whenever walls/bushes are reassigned, so it
     can never disagree with the arrays it mirrors.
     ========================================================================== */
  _ensureIndex(){
    /* Rebuild when the arrays were REASSIGNED (map load, _resetArena, custom
       map changes) or when they GREW. A plain push() -- which is how bushes and
       custom walls arrive -- mutates the array in place, so the identity check
       alone would miss it and the index would silently stop containing the new
       geometry: a player who planted a bush would not be hidden by it.
       Checking the length as well catches every push. */
    if(this._idxWall
       && this._idxWallSrc === this.walls && this._idxBushSrc === this.bushes
       && this._idxWallLen === this.walls.length && this._idxBushLen === this.bushes.length) return;
    /* Cell size trades build cost against query cost. 10 units is a good match
       for the 3.2-unit bush radius and for walls several units wide, and keeps
       a 450-unit world down to ~45x45 cells. */
    const cell = 10;
    this._idxCell = cell;
    const grid = (items, getCell, pad) => {
      const g = new Map();
      for(const it of items){
        const cx = getCell(it, 'x', pad), cz = getCell(it, 'z', pad);
        const x0 = Math.floor((cx - cell) / cell), x1 = Math.floor((cx + cell) / cell);
        const z0 = Math.floor((cz - cell) / cell), z1 = Math.floor((cz + cell) / cell);
        for(let gx = x0; gx <= x1; gx++){
          for(let gz = z0; gz <= z1; gz++){
            const k = gx * 4096 + gz;
            let bucket = g.get(k);
            if(!bucket){ bucket = []; g.set(k, bucket); }
            bucket.push(it);
          }
        }
      }
      return g;
    };
    const wallCell = (w, axis, pad) => (axis === 'x' ? w.x : w.z);
    this._idxWall = grid(this.walls, wallCell, 0);
    /* Bushes are point-like; give them a pad equal to the query radius so the
       grid can never miss one that a radius query would have found. */
    this._idxBush = grid(this.bushes, (b, axis) => (axis === 'x' ? b.x : b.z), CONFIG.BUSH_HIDE_RADIUS + 3);
    this._idxWallSrc = this.walls;
    this._idxBushSrc = this.bushes;
    this._idxWallLen = this.walls.length;
    this._idxBushLen = this.bushes.length;
  }

  /* Invalidate after any code reassigns walls/bushes wholesale (map load,
     _resetArena, custom map changes). Cheap: the next query rebuilds.

     _coverCache goes too: it is derived from bushes AND _glbPines, and neither
     of those is one of the sources the index checks below. Without this line a
     map reload leaves the PREVIOUS map's plants in the cover list, and coverOverlap
     -- which every tank consults every frame -- reports cover from a map that is
     no longer loaded. */
  invalidateIndex(){
    this._idxWall = null;
    this._idxBush = null;
    this._idxWallSrc = null;
    this._idxBushSrc = null;
    this._idxWallLen = -1;
    this._idxBushLen = -1;
    this._coverCache = null;
  }

  /* Reusable scratch array: the query callbacks below must not allocate a new
     array per call, or the index just moves the per-frame garbage elsewhere. */
  _queryCell(grid, x, z, visit){
    const cell = this._idxCell;
    const sink = this._idxSink;
    sink.length = 0;
    const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
    for(let ix = gx - 1; ix <= gx + 1; ix++){
      for(let iz = gz - 1; iz <= gz + 1; iz++){
        const bucket = grid.get(ix * 4096 + iz);
        if(!bucket) continue;
        for(let i = 0; i < bucket.length; i++){
          const it = bucket[i];
          if(sink.indexOf(it) < 0) sink.push(it);
        }
      }
    }
    for(let i = 0; i < sink.length; i++){
      if(visit(sink[i])){ sink.length = 0; return true; }
    }
    return false;
  }

  _build(){
    const loader = new THREE.TextureLoader();
    const base = 'assets/kenney/';

    /* These two are the largest remaining textures in the game and they are
       TILED. texGround repeats 8x8 across the arena, so its 1024x1024 source
       was being magnified and shrunk through mip levels to draw ground that
       occupies most of the screen — the resolution was spent on detail no one
       could resolve, in the one place where every extra texel is paid for on
       every pixel of the floor.

       Shrunk to 512 by the shared texture budget (Models.applyTextureBudget)
       once decoded. Repetition hides the reduction completely: at 8 repeats
       across a 1000-unit arena each tile covers ~125 units, and the camera
       never resolves 1024 texels across that. */
    const shrink = (tex, slot) => {
      /* onUpdate fires once the bitmap has decoded -- the only moment the
         pixels exist to be resampled. The shrunk texture then REPLACES the
         original everywhere, because the ground and wall materials have
         already been built by the time this runs, and swapping them in place
         would leave the floor drawing from a disposed texture. */
      tex.onUpdate = (t) => {
        t.onUpdate = null;
        try {
          const small = Models._shrinkTexture(t);
          if(!small || small === t) return;
          this[slot] = small;
          this.scene.traverse(o => {
            const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
            for(const m of mats){
              if(m.map === t){ m.map = small; m.needsUpdate = true; }
            }
          });
        } catch(e){}
      };
      return tex;
    };

    this.texGround = shrink(loader.load(base + 'texture_01.webp'), 'texGround');
    this.texGround.wrapS = this.texGround.wrapT = THREE.RepeatWrapping;
    this.texGround.repeat.set(8, 8);
    this.texWall = shrink(loader.load(base + 'texture_04.webp'), 'texWall');
    this.texWall.wrapS = this.texWall.wrapT = THREE.RepeatWrapping;
    this.texWall.repeat.set(1, 1);
    this._makeGround();
    this._makeSkybox();
    this._makeLights();
    this._makeLake();
    this._makeWalls();
  }

  _makeGround(){
    const mat = Toon.mat({ map: this.texGround });
    this.groundMat = mat;
    const geo = new THREE.PlaneGeometry(this.size, this.size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.ground.position.set(0, 0, 0);
    this.scene.add(this.ground);
  }

  _makeSkybox(){
    this.scene.background = _backdropColor(0xc8ddf0);
    /* NO FOG. It was Fog(colour, 350, 500) -- near 350, far 500.

       Those numbers were written for a map whose arena is ~300 units across, so
       fog only ever touched the far backdrop. Signal Map's arena is 520 units
       and the camera sits 80+ units above the tank, so 350 units of near plane
       lands in the middle of the PLAYING FIELD: the far side of the arena was
       being washed out with backdrop colour mid-fight, which reads as the map
       going dark and muddy at distance and hides where cover is.

       Removing it rather than pushing the numbers out, because a fixed far
       value is a guess about the map, and maps here range from ~300 to ~1700
       units. One map's fog settings were never right for the other six. */
    this.scene.fog = null;
  }

  _makeLights(){
    const hemi = new THREE.HemisphereLight(0xdde8f5, 0x666655, 0.6);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    const half = this.size / 2;
    const sx = this.size * 0.55, sy = this.size * 1.05, sz = this.size * 0.28;
    sun.position.set(sx, sy, sz);
    // Remember where the sun hangs relative to its target: focusShadows()
    // slides the light AND its target by the same offset, which keeps the
    // light direction (and therefore all the lighting) exactly as it is.
    this._sunOff = {x:sx, y:sy, z:sz};
    sun.castShadow = true;
    /* SHADOW RESOLUTION, AND WHY THE BIAS VALUES ARE WHAT THEY ARE.

       These three numbers were 1024 and -0.001 / 0.0005, and they produced
       diagonal stripes across flat walls and floors -- shadow acne, where a
       surface shadows itself because the depth it stores is nearer than the
       depth the shadow test compares against.

       Both numbers were wrong for the same reason, and it is scale. focusShadows
       parks a box of radius `110 + camDist * 0.7` on the player, so the shadow
       map covers roughly 280 world units. Across 1024 texels that is 0.27 units
       PER TEXEL, and normalBias of 0.0005 was under two thousandths of one
       texel -- it was rounding to nothing. A bias that does not move the
       sampled depth by at least a texel cannot resolve the quantisation it is
       meant to fix.

       The lever for acne on large flat surfaces is normalBias, not bias: it
       offsets along the surface normal rather than along the light direction,
       so it removes the self-shadowing without the peter-panning -- shadows
       visibly detaching from the objects casting them -- that a large constant
       `bias` produces on a scene this size.

       0.9 is about 6 texels at the new resolution. That is generous on purpose:
       the failure mode of being slightly too high is a shadow a little detached,
       which nobody notices, while being too low is stripes on every wall in the
       game. */
    /* 2048. This was raised to 4096 to halve the depth error on the terrain, and
       it did -- and it also quadrupled the fill cost of the shadow pass, which
       is a full extra render of every shadow-casting mesh in the box at four
       times the pixels. On a big map that is the single most expensive thing
       in the frame.

       The acne is fixed by normalBias scaling instead, which costs nothing:
       it is a constant offset, not a resolution. Resolution only buys accuracy
       you cannot get for free, and here the bias carries it. Back to 2048. */
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.bias = -0.0004;
    /* normalBias SCALED BY WORLD SIZE, because acne is a scale problem.

       Signal Map is 1,388 x 1,654 world units built from 4,065 triangles, so
       each terrain triangle is roughly 500 units across. Slope-dependent shadow
       acne comes from the depth stored across a face varying faster than one
       shadow texel, and the bigger the world the more world units one texel
       covers. A constant that works on a 300-unit map does nothing on a
       1,600-unit one -- which is exactly why this looked like it only happened
       here: it did not happen anywhere else, because the other maps are small
       enough for a constant to carry.

       0.0045 * size is about 2.3 units at this map's scale and 1.4 on a small
       one, so it tightens with the world instead of being wrong by 20x. */
    sun.shadow.normalBias = Math.max(0.15, this.size * 0.0009);
    sun.shadow.color = new THREE.Color(0x667788);
    const d = this.size * 0.8;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = Math.max(1, sy - half * 0.9);
    sun.shadow.camera.far = Math.ceil(Math.hypot(sx + half, sy, sz + half) + this.size * 0.15);
    sun.shadow.camera.updateProjectionMatrix();
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sunLight = sun;
    const fill = new THREE.DirectionalLight(0xb0c4de, 0.25);
    fill.position.set(-this.size * 0.6, this.size * 0.47, -this.size * 0.6);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xf0f0f0, 0.15);
    rim.position.set(-this.size * 0.3, this.size * 0.8, -this.size * 0.5);
    this.scene.add(rim);
    const amb = new THREE.AmbientLight(0x404040, 0.3);
    this.scene.add(amb);
  }

  // Update sun light position and shadow camera for new world size (e.g. TDM map)
  updateSunForSize(){
    if(!this.sunLight) return;
    const sx = this.size * 0.55, sy = this.size * 1.05, sz = this.size * 0.28;
    this.sunLight.position.set(sx, sy, sz);
    this.sunLight.target.position.set(0, 0, 0);
    this._sunOff = {x:sx, y:sy, z:sz};
    this._focusX = undefined; this._focusZ = undefined;
    const d = this.size * 0.8;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.camera.near = Math.max(1, sy - this.half * 0.9);
    this.sunLight.shadow.camera.far = Math.ceil(Math.hypot(sx + this.half, sy, sz + this.half) + this.size * 0.15);
    this.sunLight.shadow.camera.updateProjectionMatrix();
    /* The shadow bias is DERIVED FROM THE WORLD SIZE, so it has to be re-derived
       whenever the world size changes -- which is exactly when this runs. It was
       not, so every map inherited the bias computed for whatever
       CONFIG.WORLD_SIZE happened to be at boot. On a map three times larger that
       bias is far too small to cover the texel size, and the ground shadows
       itself on every slope. See the normalBias note in _makeLights. */
    this.sunLight.shadow.normalBias = Math.max(0.5, this.size * 0.0045);
    this.sunLight.shadow.needsUpdate = true;
  }

  /* Park the sun's shadow camera on the player instead of on the whole map.
     The light and its target move together, so the light DIRECTION — and so
     every highlight and shade in the game — stays identical. What changes is
     the size of the box that is drawn into the shadow map: before, it covered
     the entire map, so every tank, wall and tree in the world was rendered a
     second time for shadows even when it was nowhere near the screen. With
     twenty tanks bunched up that second pass was half the frame. Only the
     area the player can actually see is drawn now, which also makes the
     shadows noticeably sharper. */
  focusShadows(x, z, radius){
    const sun = this.sunLight;
    if(!sun || !this._sunOff) return false;
    const r = Math.max(60, Math.min(400, radius || 160));
    if(this._focusX !== undefined &&
       Math.abs(this._focusX - x) < (r * 0.12) && Math.abs(this._focusZ - z) < (r * 0.12)) return false;
    this._focusX = x; this._focusZ = z;
    const o = this._sunOff;
    sun.position.set(x + o.x, o.y, z + o.z);
    sun.target.position.set(x, 0, z);
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    /* top ABOVE bottom. It was `cam.top = -r; cam.bottom = r` -- inverted.

       Both other places that size this camera get it right (`_makeLights` and
       `updateSunForSize` both use top = +d, bottom = -d), which is why it went
       unnoticed for so long: the map looked correct until the player moved,
       because focusShadows is the only one of the three that runs during play.

       An inverted orthographic shadow camera has a negative-determinant
       projection, so the shadow pass rasterises with flipped winding: the
       faces the depth test is supposed to keep are culled and the ones it
       should discard are kept. Every surface in the box then compares against
       the wrong depth and most of the ground reports itself as occluded. The
       result is a dark region with straight edges that follows the player,
       because the box follows the player -- which is exactly what it looked
       like, and nothing about it suggests a projection matrix. */
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    // The light sits `dist` away from the middle of the box; keep the whole
    // box in front of the near plane and behind the far plane.
    const dist = Math.hypot(o.x, o.y, o.z);
    cam.near = Math.max(1, dist - r * 1.5);
    cam.far = Math.ceil(dist + r * 1.5 + 20);
    cam.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
    return true;
  }

  _makeLake(){
    const r = 12;
    const segs = 32;
    const geo = new THREE.CircleGeometry(r, segs);
    geo.rotateX(-Math.PI / 2);
    const mat = WaterShader.createMaterial(r);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(0, 0.05, 0);
    m.frustumCulled = false;
    this.scene.add(m);
    this._lakeMesh = m;
    this._waterMaterials.push(mat);
    this.lakes.push({ x: 0, z: 0, r: r });
  }

  /* Put the default arena floor back at its normal height (used by the modes
     that keep the default ground under a GLB map, and when leaving a match). */
  showDefaults(){
    if(this.ground){ this.ground.position.y = 0; this.ground.visible = true; }
    if(this._lakeMesh) this._lakeMesh.visible = true;
  }

  _makeWalls(){
    const wallMat = Toon.mat({ map: this.texWall });
    const hw = 4;
    const hh = 6;
    const half = this.half - hw / 2;

    const addBox = (x, z, w, d, h) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(geo, wallMat);
      m.position.set(x, h / 2, z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
      this.walls.push({ x, z, w, d, mesh: m });
      return m;
    };

    // Border walls
    addBox(0, -half, this.size - hw, hw, hh);
    addBox(0, half, this.size - hw, hw, hh);
    addBox(-half, 0, hw, this.size - hw, hh);
    addBox(half, 0, hw, this.size - hw, hh);

    // Corner pillars
    const pSize = 3;
    const pOff = half - pSize / 2;
    addBox(-pOff, -pOff, pSize, pSize, hh);
    addBox(pOff, -pOff, pSize, pSize, hh);
    addBox(-pOff, pOff, pSize, pSize, hh);
    addBox(pOff, pOff, pSize, pSize, hh);

    // Internal symmetrical walls — 4 blocks around the lake
    const blockW = 5, blockD = 3;
    const dist = 22;
    addBox(dist, 0, blockW, blockD, hh);
    addBox(-dist, 0, blockW, blockD, hh);
    addBox(0, dist, blockD, blockW, hh);
    addBox(0, -dist, blockD, blockW, hh);

    // 4 diagonal blocks
    const dd = 16;
    addBox(dd, dd, blockW * 0.6, blockW * 0.6, hh * 0.7);
    addBox(-dd, dd, blockW * 0.6, blockW * 0.6, hh * 0.7);
    addBox(dd, -dd, blockW * 0.6, blockW * 0.6, hh * 0.7);
    addBox(-dd, -dd, blockW * 0.6, blockW * 0.6, hh * 0.7);
  }

  collides(x, z, r){
    return this.collidesWallsOnly(x, z, r);
  }

  /* Called ~90x per aim-line rebuild and by every tank, so it must not scan the
     whole map. See the SPATIAL INDEX note in the constructor. */
  collidesWallsOnly(x, z, r){
    if(!this.walls.length) return false;
    this._ensureIndex();
    return this._queryCell(this._idxWall, x, z, (w) => {
      if(w.glbCover) return false;
      const hx = w.w / 2 + r, hz = w.d / 2 + r;
      return Math.abs(x - w.x) < hx && Math.abs(z - w.z) < hz;
    });
  }

  /* AI QUERIES, WHICH RESPECT COVER.

     collidesWallsOnly() above answers "is this a wall a TANK runs into", and it
     deliberately skips glbCover. That skip is why every AI-facing question was
     coming back "clear":

       * a line-of-sight ray passed straight through every building;
       * the bot wall-avoid probes found nothing and drove into cover;
       * the navigation grid baked as almost entirely free, so pathfinding
         correctly reported the way was clear on every single query.

     It is also inconsistent with the rest of the game. Shells are real Rapier
     bodies and they DO stop at cover, and the map teardown code calls these
     entries "cover-wall colliders". So cover was solid to gunfire and invisible
     to everything that thinks.

     This is the same query with the cover included, for sight lines and for
     navigation. Tank movement is left exactly as it was -- whether a tank
     should physically stop at scenery is a game-feel decision, not one to be
     changed silently underneath an AI request -- but the bots now see and plan
     around cover that shells already respect. */
  collidesForAI(x, z, r){
    if(!this.walls.length) return false;
    this._ensureIndex();
    return this._queryCell(this._idxWall, x, z, (w) => {
      const hx = w.w / 2 + r, hz = w.d / 2 + r;
      return Math.abs(x - w.x) < hx && Math.abs(z - w.z) < hz;
    });
  }

  _inLake(x, z, pad = 0){
    for(const l of this.lakes){
      const dx = x - l.x, dz = z - l.z;
      if(dx*dx + dz*dz < (l.r + pad)*(l.r + pad)) return true;
    }
    return false;
  }

  lakeAt(x, z){
    for(const l of this.lakes){
      const dx = x - l.x, dz = z - l.z;
      if(dx*dx + dz*dz < l.r*l.r) return l;
    }
    return null;
  }

  waveHeight(x, z, time){
    const wave = Math.sin(x * 0.2 + time * 1.5) * Math.cos(z * 0.2 + time * 1.2) * 0.04;
    return Math.max(0, wave);
  }

  randomSpawn(){
    for(let tries = 0; tries < 200; tries++){
      const x = (Math.random() - 0.5) * this.size * 0.85;
      const z = (Math.random() - 0.5) * this.size * 0.85;
      if(this._inLake(x, z, 4)) continue;
      if(this.collides(x, z, 3)) continue;
      return { x, z };
    }
    return { x: 0, z: 0 };
  }

  /* Both of these are called for EVERY tank EVERY frame and used to scan the
     entire bush list twice over, once each. They share the spatial index now,
     so the work is proportional to the bushes actually nearby. */
  hidingIn(x, z){
    if(this._inPlayerBush(x, z)) return 'bush';
    const r = CONFIG.BUSH_HIDE_RADIUS;
    const rr = r * r;
    if(!this.bushes.length) return null;
    this._ensureIndex();
    let hit = false;
    this._queryCell(this._idxBush, x, z, (b) => {
      const dx = x - b.x, dz = z - b.z;
      if(dx*dx + dz*dz < rr){ hit = true; return true; }
      return false;
    });
    return hit ? 'bush' : null;
  }
  /* Super bushes are far bigger than the fixed radius the spatial index assumes. */
  _inPlayerBush(x, z){
    for(const b of this.bushes){
      if(b.isPlayerBush && Math.hypot(x - b.x, z - b.z) < (b.radius || 3.2)) return true;
    }
    return false;
  }
  camoFactor(x, z){
    if(this._inPlayerBush(x, z)) return 0;
    const r = CONFIG.BUSH_HIDE_RADIUS + 2;
    const rr = r * r;
    if(!this.bushes.length) return 1;
    this._ensureIndex();
    let faded = false;
    this._queryCell(this._idxBush, x, z, (b) => {
      const dx = x - b.x, dz = z - b.z;
      if(dx*dx + dz*dz < rr){ faded = true; return true; }
      return false;
    });
    return faded ? 0.3 : 1;
  }

  /* ============================================================================
     COVER: HOW MUCH OF A TANK IS ACTUALLY UNDER SOMETHING

     hidingIn()/camoFactor() above answer "is the tank's CENTRE inside a bush",
     and they only ever look at bushes -- TREE_HIDE_RADIUS was defined in config
     and never read by either. So a tank parked against a tree, which is what
     Kaukaz is full of, got no cover at all.

     This is the overlap version, and it answers a different question: what
     FRACTION of the tank is under foliage. That is the thing the player is
     judging when they reverse into a tree and expect to be hidden, and a centre
     test gets that wrong in both directions -- it says "hidden" while a tank is
     mostly poking out past a small bush, and "exposed" while a big tank is
     almost entirely swallowed by a large one.

     WHY A GRID SAMPLE AND NOT AN AREA CALCULATION

     The honest shape is the intersection of a rotated rectangle with a circle,
     which is not worth doing per tank per frame. Instead the tank footprint is
     sampled on a small fixed lattice and a sample counts as covered when it
     falls inside ANY foliage disc. At 5x5 that is 25 point tests per tank,
     which is nothing next to the 64 the physics step already does, and the
     quantisation is well under the 50% threshold's resolution: the result can
     only land on multiples of 4%.

     WHY THE RADIUS IS HALVED

     A sample counts when it is within FOLIAGE_REACH of a plant's centre, and
     the tank's own samples are spread over its half-extents. Foliage disc
     radius is the plant's hide radius (what the player sees as cover) while
     TANK_SAMPLE_REACH is how far from the tank's centre a sample may sit and
     still count. Keeping the two separate is what lets a small tank be covered
     by a big tree and a big tank by a small bush without either being clipped
     by the other's number.

     Returns 0..1. Callers decide what counts as hidden. */
  coverOverlap(tank, halfW, halfL){
    const list = this._coverList();
    if(!list || !list.length) return 0;

    /* Fast reject: nothing within reach of the tank's outer edge can help. */
    const reach = CONFIG.COVER_SAMPLE_REACH;
    const maxR = Math.hypot(halfW, halfL) + reach;
    let any = false;
    for(let i = 0; i < list.length; i++){
      const dx = list[i].x - tank.x, dz = list[i].z - tank.z;
      const r = list[i].r + maxR;
      if(dx*dx + dz*dz <= r*r){ any = true; break; }
    }
    if(!any) return 0;

    const N = CONFIG.COVER_SAMPLES;          /* samples per axis */
    let hit = 0, total = 0;
    for(let i = 0; i < N; i++){
      /* Offset of this sample row/column within the tank footprint. */
      const fx = (N === 1) ? 0 : (i / (N - 1)) * 2 - 1;
      const sx = tank.x + fx * halfW;
      for(let j = 0; j < N; j++){
        const fz = (N === 1) ? 0 : (j / (N - 1)) * 2 - 1;
        const sz = tank.z + fz * halfL;
        total++;
        for(let k = 0; k < list.length; k++){
          const c = list[k];
          const dx = sx - c.x, dz = sz - c.z;
          const rr = c.r + reach;
          if(dx*dx + dz*dz <= rr*rr){ hit++; break; }
        }
      }
    }
    return total ? (hit / total) : 0;
  }

  /* Every plant that can hide a tank: bushes AND trees, flattened to one list
     of {x, z, r}. Built once per map and rebuilt when the cover sources
     change, because coverOverlap runs for every tank every frame.

     THREE SOURCES, NOT TWO — AND THE THIRD ONE IS THE BUG THIS FIXES.

       * this.bushes    — GLB bushes, and player-planted ones.
       * this._glbPines  — conifers inside a loaded GLB map.
       * this.trees      — the OBJ nature trees, added by _spawnStartProps and
                          by Models.js.

     `this.trees` was simply not in this list, so an OBJ tree was scenery and
     nothing else: no cover, no camouflage, no hidden — the tank could reverse
     into a tree canopy and stay plainly visible, which is what a player sees
     and reasonably reads as a bug. Only GLB pines ever granted cover, so the
     feature appeared to work on maps with authored pines and not on any map
     using the nature trees.

     The cache key tracks all three sources (identity AND length, as before),
     so a tree added mid-match is picked up on the next frame rather than
     needing a manual invalidation. */
  _coverList(){
    const bushes = this.bushes || [];
    const pines = this._glbPines || [];
    const trees = this.trees || [];
    if(this._coverSrcBush === bushes && this._coverSrcPines === pines &&
       this._coverSrcTrees === trees &&
       this._coverLenBush === bushes.length && this._coverLenPines === pines.length &&
       this._coverLenTrees === trees.length &&
       this._coverCache){
      return this._coverCache;
    }
    const out = [];
    const bR = CONFIG.BUSH_HIDE_RADIUS;
    for(const b of bushes) out.push({ x: b.x, z: b.z, r: b.radius || bR });
    /* Trees carry their own radius already (world.js computes it from the
       canopy's world scale); fall back to the configured one when it has none. */
    const tR = CONFIG.TREE_HIDE_RADIUS;
    for(const p of pines) out.push({ x: p.x, z: p.z, r: p.radius || tR });
    /* The OBJ nature trees carry no radius at all — they are pushed as bare
       {x, z, mesh}. Measured off the mesh so a big old oak and a sapling are
       not both worth the configured minimum, and the world-space scale is
       already applied to the clone that was added to the scene. */
    for(const t of trees){
      let r = t.radius;
      if(!r && t.mesh){
        try {
          const s = t.mesh.scale;
          const m = Math.max(Math.abs(s.x), Math.abs(s.z));
          r = Math.max(2.5, Math.min(m * 2.2, 14));
        } catch(e){ r = 0; }
      }
      out.push({ x: t.x, z: t.z, r: r || tR });
    }
    this._coverCache = out;
    this._coverSrcBush = bushes;
    this._coverSrcPines = pines;
    this._coverSrcTrees = trees;
    this._coverLenBush = bushes.length;
    this._coverLenPines = pines.length;
    this._coverLenTrees = trees.length;
    return out;
  }

  addPlayerBush(x, z, scale, groundY){
    const bushMat = Toon.mat({ color: 0x2e7a36, flatShading: true });
    const grp = new THREE.Group();
    const cluster = new THREE.Group();
    const sc = 1.3 * (scale || 1);
    const positions = [[0,0,0,1.1],[1.1,0.2,0.3,0.8],[-1.0,0.25,-0.4,0.75],[0.3,0.35,-1.0,0.7],[-0.2,0.15,1.0,0.8]];
    positions.forEach(p => {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(p[3] * sc, 1), bushMat);
      s.position.set(p[0] * sc, p[1] * sc + 0.5, p[2] * sc);
      s.castShadow = true; s.receiveShadow = true;
      cluster.add(s);
    });
    grp.add(cluster);
    grp.position.set(x, groundY || 0, z);
    this.scene.add(grp);
    const entry = { x, z, mesh: grp, isPlayerBush: true, radius: 3.2 * (scale || 1) };
    this.bushes.push(entry);
    return entry;
  }

  removePlayerBush(entry){
    if(!entry) return;
    const idx = this.bushes.indexOf(entry);
    if(idx >= 0) this.bushes.splice(idx, 1);
    this.scene.remove(entry.mesh);
    entry.mesh.traverse(o => { if(o.isMesh){ if(o.material) o.material.dispose(); o.geometry.dispose(); } });
  }
/* THE SCATTERED NATURE TREES ARE GONE.

     This method used to scatter thirty-odd OBJ trees over any arena whose
     authored foliage count was below six, and it used to be an empty function
     before that — which is the whole history of the camouflage feature in two
     steps: nothing was placed, then too much was placed, and neither version
     concealed anything.

     MEASURED, on a live match of a bare map, with the scatter at full tilt:
     thirty-two trees, canopy radii 2.50 to 2.93, against a tank whose collider
     half-width is 9.17. A disc that size overlaps roughly a ninth of the hull
     even with the tank parked on the tree's exact centre — coverOverlap read
     0.08 to 0.12 dead under one, which maps to a camoFactor of 1, i.e.
     completely visible.

     And they were scenery explicitly flagged `noPhysics` (see the GLB tree
     handler above), so you drove straight through them. Which made them the
     worst of both halves at once: something that reads as a solid obstacle and
     behaves like fog. "Why are these trees here and why can't I hit them" was
     the correct question and there was no good answer to give.

     Foliage here is the MAP's job. A map that wants cover ships bushes or
     conifers; those reach _coverList() through the authored path and work
     properly. A map that ships none is a bare arena, and a bare arena is a
     legitimate thing for a map to be.

     WHAT IS LEFT, and why it is not simply deleted: `treesPlaced` is the
     one-shot flag Game._spawnStartProps checks so this is asked once per match
     rather than every frame, and _buildTreeBlobs(null) tears down the merged
     shadow mesh so blobs left by a previously loaded map cannot survive into
     this one. Both still have callers and both still do their job; only the
     scattering is gone. */
  tryPlaceTrees(){
    if(this.treesPlaced) return;
    this.treesPlaced = true;
    /* The map's own trees, painted as ground discs.

       This used to pass `null`, which tore the old blobs down and built nothing:
       correct back when the scattered trees it was written for were deleted, and
       dead weight since, because the GLB handlers turned real shadow casting
       back on for every conifer. Having just removed that (see loadGLBModel), a
       forest with no ground shadow at all looks pasted onto the terrain, so the
       spots the pine/taiga handler has been collecting go here instead. */
    this._buildTreeBlobs(this._treeBlobSpots);
    this.invalidateIndex();
  }

  /* One unlit mesh holding a soft disc under every placed tree, in place of
     thirty real shadow casters. This is what the pine/taiga handlers in
     loadGLBModel buy with their `castShadow = false`: the forest keeps a
     shadow on the ground without paying for a second pass through the shadow
     map, which is the pass that cannot be frustum-culled and runs at the
     shadow map's own resolution.

     MERGED RATHER THAN ONE DISC PER TREE, because one disc per tree would be
     thirty-odd draw calls to replace thirty-odd shadow-map draws — a straight
     trade, and not obviously a win. Merged, it is ONE draw call of ten
     triangles each, which is the actual saving.

     The geometry is built by hand rather than from CircleGeometry clones plus a
     merge helper: a circle is position/normal/uv and an index, and appending
     thirty of them is a few lines that cannot silently drop an attribute the way
     a generic merge can. Every disc is written at its world position, so the
     mesh has an identity transform and its matrix never has to change. */
  _buildTreeBlobs(spots){
    if(this._treeBlobs){
      this.scene.remove(this._treeBlobs);
      if(this._treeBlobsGeo) this._treeBlobsGeo.dispose();
      if(this._treeBlobs.material) this._treeBlobs.material.dispose();
      this._treeBlobs = null; this._treeBlobsGeo = null;
    }
    if(!spots || !spots.length) return;

    const SEG = 10;                     /* ten triangles per disc — a blob is a blob */
    const perDisc = SEG + 1;            /* centre plus rim */
    const n = spots.length;

    const pos   = new Float32Array(n * perDisc * 3);
    const nor   = new Float32Array(n * perDisc * 3);
    const uv    = new Float32Array(n * perDisc * 2);
    const index = new Uint32Array(n * SEG * 3);

    let vp = 0, up = 0, ip = 0, base = 0;
    for(const s of spots){
      const r = s.r;
      /* Centre vertex first, so the fan below is a clean triangle strip. */
      pos[vp] = s.x; pos[vp+1] = 0.02; pos[vp+2] = s.z;
      nor[vp] = 0; nor[vp+1] = 1; nor[vp+2] = 0;
      uv[up] = 0.5; uv[up+1] = 0.5;
      vp += 3; up += 2; base += 1;
      for(let i = 0; i < SEG; i++){
        const a = (i / SEG) * Math.PI * 2;
        pos[vp] = s.x + Math.cos(a) * r; pos[vp+1] = 0.02; pos[vp+2] = s.z + Math.sin(a) * r;
        nor[vp] = 0; nor[vp+1] = 1; nor[vp+2] = 0;
        uv[up] = 0.5 + Math.cos(a) * 0.5; uv[up+1] = 0.5 + Math.sin(a) * 0.5;
        vp += 3; up += 2;
      }
      for(let i = 0; i < SEG; i++){
        index[ip] = base; index[ip+1] = base + 1 + i; index[ip+2] = base + 1 + ((i + 1) % SEG);
        ip += 3;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();

    /* Unlit and translucent: this is a painted shadow, not geometry, so it must
       not respond to the sun and must not write depth, or it punches a hole in
       the ground it is lying on. polygonOffset lifts it clear of bumpy terrain so
       a slope cannot z-fight it into stripes. */
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0d1408, transparent: true, opacity: 0.34,
      depthWrite: false, fog: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'treeBlobs';
    mesh.renderOrder = 1;
    mesh.matrixAutoUpdate = false;      /* identity transform, world-space verts */
    mesh.updateMatrixWorld(true);
    this.scene.add(mesh);
    this._treeBlobs = mesh;
    this._treeBlobsGeo = geo;
  }

  update(dt, time, tankPos){
    /* Before anything else in here, because it is the one thing in this method
       that has to happen every frame regardless of what the water is doing. */
    this.syncFoliageInstances();
    for(const mat of this._waterMaterials){
      mat.uniforms.uTime.value = time;
      if(tankPos && mat.uniforms.uTankPosition){
        mat.uniforms.uTankPosition.value.set(tankPos.x, 0, tankPos.z);
      }
    }
  }

  loadCustomMapData(data){
    if(!data || !data.objects) return;
    // A custom map replaces the GLB battle map — swap them atomically so no
    // frame is rendered with an empty arena.
    this._disposeGLBGroup();
    this._clearCustom();
    const rockMat = Toon.mat({ color: 0x6a6e72, flatShading: true });
    const bushMat = Toon.mat({ color: 0x3a7a38, flatShading: true });
    const trunkMat = Toon.mat({ color: 0x6b4a2b });
    const leafMat = Toon.mat({ color: 0x2f8f3f, flatShading: true });
    this.spawnPoints = {};
    this.blueBoxes = [];
    data.objects.forEach(d => {
      if(d.type === 'spawnpoint'){
        const key = d.subType || 'player';
        if(!this.spawnPoints[key]) this.spawnPoints[key] = [];
        this.spawnPoints[key].push({ x:d.x, z:d.z, ry:d.ry || 0 });
        return;
      }
      if(d.type === 'gladiatorbox'){
        this.blueBoxes.push({ x:d.x, z:d.z });
        return;
      }
      if(d.type === 'tree'){
        const grp = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 3.2, 8), trunkMat);
        const fol = new THREE.Mesh(new THREE.ConeGeometry(2.6, 5.5, 10), leafMat);
        trunk.position.y = 1.6; trunk.castShadow = trunk.receiveShadow = true;
        fol.position.y = 4.2; fol.castShadow = fol.receiveShadow = true;
        grp.add(trunk); grp.add(fol);
        grp.position.set(d.x, 0, d.z);
        grp.scale.set(d.sx || 1, d.sy || 1, d.sz || 1);
        grp.rotation.y = d.ry || 0;
        this.scene.add(grp);
        this._customMeshes.push(grp);
        this.bushes.push({ x: d.x, z: d.z, mesh: grp, custom: true });
        return;
      }
      let mesh;
      if(d.isModel && d.modelName){
        const geo = new THREE.BoxGeometry(4, 4, 4);
        const mat = Toon.mat({ color: d.color || 0x888888 });
        mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(d.x, d.y, d.z);
        mesh.scale.set(d.sx, d.sy, d.sz);
        mesh.rotation.y = d.ry;
        mesh.castShadow = mesh.receiveShadow = true;
        this.scene.add(mesh);
        this._customMeshes.push(mesh);
        if(d.type === 'water'){
          const r = Math.max(d.sx, d.sz) * 3;
          this.lakes.push({ x: d.x, z: d.z, r, custom: true });
        } else {
          const w = 4 * d.sx, dd = 4 * d.sz;
          this.walls.push({ x: d.x, z: d.z, w, d: dd, mesh, custom: true });
        }
        const loadModel = (grp) => {
          if(!grp) return;
          const clone = grp.clone(true);
          clone.position.set(d.x, d.y, d.z);
          clone.scale.set(d.sx, d.sy, d.sz);
          clone.rotation.y = d.ry;
          clone.traverse(o => {
            if(!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = true;
            if(o.userData && o.userData.noShadow){ o.castShadow = false; }
            // Object3D.clone() only copies the node tree — geometry and
            // material stay SHARED with Models._cache. _clearCustom() disposes
            // them, which used to free the hull geometry every tank using this
            // model was drawing from (the outline keeps its own cloned
            // geometry, so those tanks survived as outlines only). Give this
            // map object its own copies so disposal stays local.
            if(o.geometry) o.geometry = o.geometry.clone();
            if(o.material){
              o.material = Array.isArray(o.material)
                ? o.material.map(m => m.clone())
                : o.material.clone();
            }
          });
          this.scene.add(clone);
          this._customMeshes.push(clone);
          this.scene.remove(mesh);
          const idx = this.walls.findIndex(w => w.mesh === mesh);
          if(idx >= 0) this.walls[idx].mesh = clone;
        };
        if(d.modelData){
          const loader = Models.loader();
          if(loader){
            const bin = atob(d.modelData);
            const buf = new ArrayBuffer(bin.length);
            const view = new Uint8Array(buf);
            for(let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
            loader.parse(buf, '', (result) => {
              loadModel(result && result.scene ? result.scene : result);
            }, () => {});
          }
        } else if(window.Models){
          Models.load(d.modelName).then(grp => loadModel(grp));
        }
        return;
      }
      let geo;
      switch(d.kind){
        case 'cube':     geo = new THREE.BoxGeometry(6, 6, 6); break;
        case 'pyramid':  geo = new THREE.ConeGeometry(4, 7, 4); break;
        case 'cone':     geo = new THREE.ConeGeometry(3.5, 7, 18); break;
        case 'torus':    geo = new THREE.TorusGeometry(3, 1.2, 12, 24); break;
        case 'cylinder': geo = new THREE.CylinderGeometry(3, 3, 6, 18); break;
        default: geo = new THREE.BoxGeometry(6, 6, 6);
      }
      const mat = (d.type === 'water') ? Toon.mat({ color: 0x61B2FF, transparent: true, opacity: 0.85 })
                 : (d.type === 'bush' ? bushMat : rockMat);
      mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(d.x, d.y, d.z);
      mesh.scale.set(d.sx, d.sy, d.sz);
      mesh.rotation.y = d.ry;
      mesh.castShadow = mesh.receiveShadow = true;
      this.scene.add(mesh);
      this._customMeshes.push(mesh);
      if(d.type === 'water'){
        const r = Math.max(d.sx, d.sz) * 3;
        this.lakes.push({ x: d.x, z: d.z, r, custom: true });
      } else if(d.type === 'bush'){
        this.bushes.push({ x: d.x, z: d.z, mesh, custom: true });
      } else {
        const w = 6 * d.sx, dd = 6 * d.sz;
        this.walls.push({ x: d.x, z: d.z, w, d: dd, mesh, custom: true });
      }
    });
  }

  /* Remove + dispose the active GLB battle map. Kept out of _clearCustom():
     _resetArena() fires _clearCustom() BEFORE the next map finishes its
     async load, so disposing here used to blank the arena (ground already
     hidden by hideDefaults()) until — or unless — the new GLB arrived. */
  /* ============================================================================
     FOLIAGE INSTANCING — 33 draw calls down to 3
     ============================================================================
     WHY THIS EXISTS AT ALL, since the first instinct is "just use
     InstancedMesh", which is what it does.

     Kaukaz, the biggest map in the game, ships 33 conifers. Each one is its own
     GLTF mesh, so each one is its own draw call -- and the naive reading is that
     these should have been authored as one instanced mesh in the first place.
     They are not, and that is what this method has to undo.

     MEASURED, by hashing the raw vertex bytes of every foliage node in the GLB
     rather than trusting the vertex counts:

         primitive 0   28 verts, 18 trees   -> 1 distinct byte layout
         primitive 0   46 verts, 15 trees   -> 1 distinct byte layout
         primitive 1  978 verts, 15 trees   -> 1 distinct byte layout

     Every taiga is the same 28 vertices. Every pine is the same 46-vertex bark
     plus the same 978-vertex canopy. The trees are byte-identical; only the
     node transform differs, and that lives on the node, not in the buffer. This
     is a scene that was instanced in the authoring tool and flattened on export,
     which is the normal behaviour of every DCC that writes glTF.

     So InstancedMesh is available here, and it is worth taking: 33 draw calls
     become 3, on top of the 33 shadow-map draws the pine handler no longer
     casts (see loadGLBModel). For a map whose whole point is a forest, that is
     most of the scene's submission cost.

     WHAT IS *NOT* TOUCHED, and this is the whole trick:

     The per-tree Object3D roots STAY IN THE SCENE GRAPH AND KEEP BEING MOVED BY
     THE EXISTING CODE. Game._update's foliage loop still writes
     `p.obj.rotation.x` for the wind and the contact shake; the bush billboard
     pass still writes `b.obj.rotation`; cover, noPhysics, the radius records
     and the teardown all still see the same object they saw before. None of
     that needed to know this method exists.

     What leaves the graph is only the DRAWABLE MESHES underneath those roots,
     and what replaces them is an InstancedMesh whose matrices are REBUILT FROM
     THE ROOTS' LIVE matrixWorld EVERY FRAME (syncFoliageInstances). So an
     instance matrix is always `root.matrixWorld * meshLocalOffset` -- the root
     does whatever it has always done, and the batch follows it.

     The alternative, storing each tree's matrix once at build time and letting
     the wind rotate a detached copy of the root, would have meant rewriting
     three call sites in game.js and would have been a different change with a
     different risk profile. This one cannot desynchronise from the animation
     because it reads the animation's own output.

     ANYTHING THAT DOES NOT MATCH IS LEFT ALONE. A group needs identical vertex
     bytes AND an equivalent material to be batched, and a group of one is not
     worth an InstancedMesh. A map with a hand-placed hero tree in it therefore
     still renders correctly: that tree simply stays an ordinary mesh.
     ============================================================================ */
  _instanceFoliage(grp){
    /* Roots are found by NAME, the same convention the classification above
       already established, and then walked UP to the map root so a tree whose
       bark and canopy are two child meshes is treated as one tree rather than
       two. Same walk, same reason, as the pine and bush handlers. */
    const roots = [];
    const seenRoots = new Set();
    grp.traverse(o => {
      const lower = (o.name || '').toLowerCase();
      if(!/(pine|taiga|tree|bush)/.test(lower)) return;
      if(!(o.isGroup || o.isMesh)) return;
      let r = o;
      while(r.parent && r.parent !== grp) r = r.parent;
      if(seenRoots.has(r)) return;
      seenRoots.add(r);
      roots.push(r);
    });
    if(roots.length < 2) return;

    /* A geometry's identity is its VERTEX DATA, not the object: GLTFLoader
       hands every node its own BufferGeometry wrapper even when two of them
       wrap the same bytes, which is precisely the case here. Hashing position,
       normal and uv together matters -- position alone would happily batch two
       trees whose canopies share a silhouette but whose normals or wind UVs
       differ, and the batch would then draw one of them with the other's
       shading. uv in particular is what the foliage wind reads. */
    const geoKeyCache = new WeakMap();
    const geoKey = (g) => {
      let k = geoKeyCache.get(g);
      if(k) return k;
      let h = 5381;
      for(const name of ['position', 'normal', 'uv']){
        const a = g.getAttribute && g.getAttribute(name);
        if(!a || !a.array){ h = ((h * 33) ^ 0) >>> 0; continue; }
        const arr = a.array;
        for(let i = 0; i < arr.length; i++) h = ((h * 33) ^ (arr[i] * 8191 | 0)) >>> 0;
        h = ((h * 33) ^ a.itemSize) >>> 0;
      }
      h = ((h * 33) ^ (g.index ? g.index.count : 0)) >>> 0;
      k = String(h);
      geoKeyCache.set(g, k);
      return k;
    };

    /* Materials cannot be keyed by identity for the same reason geometries
       cannot. loadGLBModel replaces every GLB material with a fresh Toon.mat(),
       so Kaukaz's 18 identical taiga hold 18 DIFFERENT material objects that
       happen to describe the same surface. Keying on uuid would therefore
       produce eighteen groups of one and batch nothing at all -- which is the
       failure mode this whole method exists to avoid, and it would have looked
       like the idea simply not working.

       So the key is what the material actually LOOKS like. The map is the
       identity that matters (two taiga with different bark textures are not
       interchangeable), and colour is included because a map may legitimately
       tint individual trees. Anything not captured here falls into its own
       group and is simply not batched, which is the safe direction to be wrong
       in. */
    const matKey = (m) => {
      if(!m) return 'null';
      const c = m.color ? m.color.getHexString() : '';
      const map = m.map ? m.map.uuid : '';
      return [map, c, m.alphaTest, m.transparent, m.opacity, m.side, m.depthWrite].join(':');
    };

    grp.updateMatrixWorld(true);
    const inv = new THREE.Matrix4();
    const rel = new THREE.Matrix4();

    /* THE INSTANCE MATRICES ARE WRITTEN IN WORLD SPACE, SO THE BATCH MUST BE
       PARENTED TO THE SCENE — NOT TO THE MAP GROUP.

       This is the missing-trees bug, and it is a units mistake rather than a
       logic one.

       An InstancedMesh's per-instance matrices are applied in its OWN local
       space and then multiplied by its own world matrix on the way to the
       shader. The matrices this method writes are WORLD matrices:

           rel = inverse(root.matrixWorld) * mesh.matrixWorld      (build time)
           sync: m = root.matrixWorld * rel  ->  mesh.matrixWorld  (per frame)

       So parenting the batch to `grp` means every instance gets grp's
       transform applied to it a SECOND time. And grp carries the map's
       SCALE — 228x on Core II, 120x on Dream, 167x on Core. A tree that was
       authored at 3 units ends up at 3 x 228 x 228 units from the origin: tens
       of thousands of units away, far outside the camera's far plane, and
       therefore not drawn at all.

       That is exactly the reported symptom: a map that loads, reports its
       spawn points, and has no trees. The trees are not missing, they are
       100,000 units away. Maps where the instancing never ran (fewer than two
       batchable roots) keep their original meshes parented under grp and look
       correct, which is why it reads as "some maps".

       `inv` of the group's matrix converts a world matrix into the group-local
       one the batch needs, and is applied at BUILD time to the relative
       matrices and at SYNC time to the animated ones — so the wind still
       drives them and the scale is applied exactly once, by grp. */
    /* TWO MATRICES, AND THE SECOND ONE EXISTS BECAUSE OF A BUG THAT LOOKED LIKE A
       TYPO.

       `grpInv` is the inverse of the group's world matrix and has to stay that
       value for the whole method — it is handed to every batch so that
       syncFoliageInstances() can keep converting world matrices into
       group-local ones as the wind moves them.

       It was ALSO being used as the scratch matrix for the per-instance world
       matrix, which destroys it on the first iteration. Every batch therefore
       stored whatever the previous loop iteration left behind, and the
       conversion applied at sync time was arithmetic on garbage. That is what
       lost the trees a second time, immediately after the first fix appeared
       to work: the build-time matrices were right and the per-frame ones were
       not, so the trees were correct for one frame and wrong for every frame
       after it.

       `m` is the scratch. `grpInv` is the constant. They must never be the
       same variable. */
    const grpInv = new THREE.Matrix4();
    try { grpInv.copy(grp.matrixWorld).invert(); } catch (e) { grpInv.identity(); }
    const m = new THREE.Matrix4();      /* world matrix of one instance */
    const out = new THREE.Matrix4();   /* that instance, in grp-local space */

    const groups = new Map();       /* key -> [{ root, rel, geo, mat, mesh }] */
    for(const root of roots){
      inv.copy(root.matrixWorld).invert();
      const members = [];
      root.traverse(c => { if(c.isMesh && c.geometry && c.material) members.push(c); });
      for(const mesh of members){
        const key = geoKey(mesh.geometry) + '|' + matKey(mesh.material);
        let g = groups.get(key);
        if(!g){ g = []; groups.set(key, g); }
        rel.multiplyMatrices(inv, mesh.matrixWorld);
        g.push({
          root, mesh, geo: mesh.geometry, mat: mesh.material,
          rel: rel.clone(),
          cast: mesh.castShadow, recv: mesh.receiveShadow
        });
      }
    }

    const batches = [];
    let merged = 0;
    for(const members of groups.values()){
      if(members.length < 2) continue;      /* see the header: a group of one is not a batch */
      const first = members[0];
      const inst = new THREE.InstancedMesh(first.geo, first.mat, members.length);
      /* NOT FRUSTUM CULLED, deliberately.

         An InstancedMesh culls itself against the bounding sphere of its BASE
         geometry, which sits at the origin -- so every tree in the batch would
         be culled the moment the camera looked away from the origin, and a
         forest would blink out of existence as you drove. Recomputing a correct
         per-batch sphere is possible but ties this to a three-version detail,
         and the alternative is merely that some off-screen trees get their
         vertices transformed and discarded, which the GPU does for free. */
      inst.frustumCulled = false;
      inst.castShadow = first.cast;
      inst.receiveShadow = first.recv;
      inst.renderOrder = first.mesh.renderOrder;
      /* Added to the MAP ROOT, not to any tree: an InstancedMesh parented under
         one of the roots it is batching would have its own matrices scaled and
         rotated by that root a second time.

         The instance matrices are pre-multiplied by the inverse of grp's world
         matrix above, so grp's scale is applied exactly ONCE — by grp itself —
         rather than twice. See the grpInv note for why that was the bug. */
      grp.add(inst);

      for(let i = 0; i < members.length; i++){
        const member = members[i];
        /* Seed the batch before the original meshes leave the graph.

           syncFoliageInstances() runs immediately afterwards and overwrites
           every one of these, but an InstancedMesh whose instanceMatrix is
           still all zeros renders every instance collapsed onto the origin —
           one pile of geometry at the middle of the map — for a frame or two
           before that call lands. Writing the real matrix here means the batch
           is correct from the instant it enters the graph. */
        m.multiplyMatrices(member.root.matrixWorld, member.rel);
        out.multiplyMatrices(grpInv, m);
        inst.setMatrixAt(i, out);
        if(member.mesh.parent) member.mesh.parent.remove(member.mesh);
        /* The losers' geometry is now unreferenced by the scene graph, so the
           teardown in _disposeGLBGroup -- which walks that graph -- will never
           see it. Freed here or it leaks one geometry per tree, per map load,
           forever. The WINNER's geometry is still reachable: the InstancedMesh
           is in the graph and holds it. */
        if(member.geo !== first.geo && member.geo.dispose) { try { member.geo.dispose(); } catch(e){} }
      }
      batches.push({ inst, members, grpInv: grpInv.clone() });
      merged += members.length;
    }

    if(batches.length){
      this._foliageBatches = batches;
      console.log('[World] foliage instanced: ' + merged + ' meshes -> ' +
                  batches.length + ' draw calls');
    }
    this.syncFoliageInstances();
  }

  /* Re-derive every foliage instance matrix from the live root transforms.

     Called once per frame from update(). Unconditionally, every frame, with no
     "did anything move?" shortcut: the roots are moved by code in game.js that
     knows nothing about batching, and a dirty flag set there would have to be
     remembered by three separate animation passes. A stale instance matrix here
     does not look like a subtle lag -- it looks like a tree frozen in mid-sway
     while the wind keeps blowing around it. Thirty-three 4x4 matrix multiplies
     is roughly two microseconds; that is the right thing to spend.

     The roots' matrixWorld is whatever the renderer last computed, so a batch
     trails the wind by at most one frame. At under 1 rad/s and under 6 degrees
     of amplitude that is well under a pixel. */
  syncFoliageInstances(){
    const batches = this._foliageBatches;
    if(!batches || !batches.length) return;
    const m = this._foliageScratch || (this._foliageScratch = new THREE.Matrix4());
    /* World -> the map group's local space, so the group's scale is applied by
       the group rather than a second time by every instance. This is the other
       half of the fix; without it the batch is drawn at scale-squared, which
       puts every tree tens of thousands of units away and off the screen.

       Cached per batch, not recomputed per frame: the map group's transform
       does not change once the GLB is loaded and parented, and inverting a
       matrix 16 times a frame for a result that never differs is exactly the
       kind of cost this method's own comment elsewhere is careful to avoid. */
    const out = this._foliageScratch2 || (this._foliageScratch2 = new THREE.Matrix4());
    for(let b = 0; b < batches.length; b++){
      const batch = batches[b];
      const inst = batch.inst;
      const members = batch.members;
      const toLocal = batch.grpInv || null;
      for(let i = 0; i < members.length; i++){
        m.multiplyMatrices(members[i].root.matrixWorld, members[i].rel);
        if(toLocal) out.multiplyMatrices(toLocal, m);
        else out.copy(m);
        inst.setMatrixAt(i, out);
      }
      inst.instanceMatrix.needsUpdate = true;
    }
  }

  _disposeGLBGroup(){
    const grp = this._glbGroup;
    this._glbGroup = null;
    if(grp){
      try {
        /* A MATERIAL'S TEXTURES ARE SEPARATE GPU ALLOCATIONS.

           Disposing a material frees its shader program hooks but not the images
           bound to it. Every battle loads a fresh copy of the map GLB, so every
           battle produced a fresh set of textures, and the teardown below freed
           the geometries and materials while leaving all of those images
           resident. Measured over four consecutive battles on the same map:
           renderer.info.memory.textures climbing 17 -> 25 -> 33 -> 41, i.e.
           exactly +8 per battle, forever, while the scene contents stayed
           identical. Left alone long enough that is several GB and then a
           context loss.

           The skip below used to test `texBudgetApplied`, which flagged EVERY
           replacement produced by the shared texture budget -- including all 19
           of a map's own. So the one texture family the guard was meant to
           protect was also the whole leak. It now tests `sharedBudget`, which
           only the model cache sets: a tank model is budgeted once and handed to
           a dozen live clones, so freeing it when one tank dies would break the
           other eleven. A map has no such sharing and owns its textures
           outright, so they are freed with it.

           Counted per texture object, not per reference, because one shared
           texture bound to twenty materials must only be freed once. */
        const seenTex = new Set();
        grp.traverse(o => {
          if(!o.isMesh) return;
          /* AN INSTANCED MESH OWNS A GPU BUFFER THAT `geometry.dispose()` DOES
             NOT KNOW ABOUT. Its instanceMatrix is a separate attribute the
             renderer allocated on first draw, and it is only released by the
             mesh's own dispose() -- which fires an event the renderer's object
             table listens for and uses to drop that buffer.

             Without this line every map load leaks one buffer per foliage batch
             for the life of the session, silently, on a path that already
             documents itself as being responsible for exactly this class of
             leak. It is safe alongside the geometry/material disposal below
             because InstancedMesh.dispose() touches only the instance matrix. */
          if(o.isInstancedMesh && o.dispose){ try { o.dispose(); } catch(e){} }
          if(o.geometry) o.geometry.dispose();
          if(o.material){
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for(const mt of mats){
              if(!mt) continue;
              for(const k in mt){
                const t = mt[k];
                if(t && t.isTexture && !seenTex.has(t.uuid)){
                  seenTex.add(t.uuid);
                  /* Only a texture shared with a still-cached model survives. */
                  if(t.userData && t.userData.sharedBudget) continue;
                  try { t.dispose(); } catch(e){}
                }
              }
              try { mt.dispose(); } catch(e){}
            }
          }
        });
      } catch(e){}
      this.scene.remove(grp);
    }
    // Everything derived from the map has to go with it: cover-wall
    // colliders, bush proxies and spawn points all point at nodes we just
    // detached, and _clearCustom() never sees them (they aren't `custom`).
    this.walls = this.walls.filter(w => !w.glbCover);
    this.bushes = this.bushes.filter(b => !(b.isGLBBush && !b.custom));
    /* Both arrays were just reassigned, so the spatial index now points at
       objects the map no longer has. Drop it; the next query rebuilds against
       the new arrays. */
    this.invalidateIndex();
    /* Everything read out of the map goes with it. The capture points in
       particular must not survive, or the next battle inherits the previous
       map's zones and the flags end up somewhere the level designer never put
       them. Clearing the LIST is what matters now -- the old single
       `_glbFlag = null` left `_glbFlags` from the previous map untouched, so
       every zone the last map declared would still be here. */
    this._glbFlag = null;
    this._glbFlags = [];
    this._void = null;
    this._glbBushes = [];
    this._glbPines = [];
    /* The batches hold matrices computed from the roots we just detached, and
       syncFoliageInstances() would happily keep writing them for as long as the
       array was non-empty -- uploading to a mesh nobody is drawing. */
    this._foliageBatches = null;
    if(grp) this.spawnPoints = {};
  }

  _clearCustom(){
    this.walls = this.walls.filter(w => !w.custom);
    this.bushes = this.bushes.filter(b => !b.custom);
    this.lakes = this.lakes.filter(l => !l.custom);
    this.invalidateIndex();
    if(this._customMeshes){
      this._customMeshes.forEach(m => {
        try {
          m.traverse(o => {
            if(o.isMesh){
              if(o.geometry) o.geometry.dispose();
              if(o.material){
                if(Array.isArray(o.material)) o.material.forEach(mt => mt.dispose());
                else o.material.dispose();
              }
            }
          });
        } catch(e){}
        this.scene.remove(m);
      });
    }
    this._customMeshes = [];
  }

  clearCustomMapData(){
    this._clearCustom();
  }

  hideDefaults(){
    if(this.ground){
      /* A GLB map brings its own floor, but that floor does not always reach
         the edge of the arena. The default ground is kept, dropped well below
         the map floor, purely to fill that gap — before, anything past the map
         edge was raw sky and it looked like the world had failed to load. */
      this.ground.position.y = -45;
      this.ground.visible = true;
    }
    if(this._lakeMesh) this._lakeMesh.visible = false;
    this.walls.forEach(w => { if(w.mesh) w.mesh.visible = false; });
    this.walls = [];
    this.bushes = [];
    this.trees = [];
    /* The trees this just dropped are still standing in the scene, so the
       clearance guard alone would leave them there on the next match — stacked
       on top of the next set. The old code left treesPlaced set for the same
       reason and never re-ran, so the pile could only grow; now that they are
       real cover and real geometry, they have to be removed rather than
       orphaned, or a second match in the same session starts inside a forest. */
    this._placedTrees = this._placedTrees || [];
    for(const t of this._placedTrees){
      if(t && t.mesh && t.mesh.parent) t.mesh.parent.remove(t.mesh);
    }
    this._placedTrees = [];
    /* The blob shadows go with them. Left behind, thirty dark discs from the
       previous map would sit on the new map's floor — and since the blob mesh
       holds world-space coordinates rather than a transform, it would not move
       when the arena did, so they would not even line up with the trees that
       made them. */
    this._buildTreeBlobs(null);
    /* And the SPOTS go with them. tryPlaceTrees() rebuilds the blobs from this
       list, and it is the thing that runs next; leaving the old coordinates in
       place would repaint the previous map's forest onto the new map's floor
       the instant the flag above is cleared. */
    this._treeBlobSpots = [];
    /* And the one-shot guard has to be cleared with them, or tryPlaceTrees()
       returns early on the next match and the arena is bare again. */
    this.treesPlaced = false;
    this.lakes = [];
    this.spawnPoints = {};
    this.invalidateIndex();
  }

  _registerGLBCoverPoints(grp, scale){
    /* THE THRESHOLD IS IN WORLD UNITS, AND THAT IS THE WHOLE FIX.

       This used to be `(scale * 1.5) ** 2`, on the assumption that Box3 was
       measuring the model in its own unscaled units. It is not: setFromObject()
       measures after the group has been scaled, so the numbers are already in
       world units.

       On a map whose GLB is loaded at scale 167 (the Core arena), that made the
       threshold (167 * 1.5)^2 = 62,750 square units. The map's actual cover
       pieces measure about 8x10 and 5x9 world units -- perfect tank-sized cover
       -- and every one of them fell an order of magnitude below the line, so
       ALL of them were silently discarded. The map loaded, looked correct, and
       ended up with `walls` EMPTY.

       And walls being empty is invisible on its own. It means:

         * every line-of-sight ray passes through every building, so bots see
           (and shoot at) enemies through walls;
         * _wallAvoid has nothing to avoid, so bots drive into cover;
         * the navigation grid bakes as almost entirely free, so pathfinding
           correctly reports "the way is clear" every single time.

       So the size test has to be a fixed number of world units -- it exists to
       skip props too small to hide a tank behind, and a tank is about 3.2 units
       wide regardless of how big the map is. Anything under ~4x4 cannot be
       cover; nothing about that depends on the map's scale factor. */
    const MIN_AREA = 16;

    /* Reject footprints that span the map. Those are the ground plane and
       similar scenery, not cover: registering one as a wall would make a single
       box the size of the arena, and every LOS ray and path query on the map
       would report a wall. The threshold is relative to the group's own extent
       so it works the same on a small arena and a large one. */
    const whole = new THREE.Box3().setFromObject(grp);
    const spanX = Math.max(1, whole.max.x - whole.min.x);
    const spanZ = Math.max(1, whole.max.z - whole.min.z);
    const MAX_AREA = spanX * spanZ * 0.25;

    /* `visited` was an Array searched with .includes() once per mesh, so this
       was O(n^2) over the whole map -- roughly 180k pointer comparisons on a
       map with 600 cover roots, plus a fresh Box3.setFromObject for each one.
       A Set makes the membership test O(1). */
    const visited = new Set();
    grp.traverse(o => {
      if(!o.isMesh) return;
      const nameLower = (o.name || '').toLowerCase();
      if(nameLower.includes('bush') || nameLower.includes('pine') || nameLower.includes('tree')) return;
      if(o.userData && o.userData.isCollider) return;
      let root = o;
      while(root.parent && root.parent !== grp) root = root.parent;
      if(visited.has(root)) return;
      visited.add(root);
      const lb = new THREE.Box3().setFromObject(root);
      const sz = new THREE.Vector3();
      lb.getSize(sz);
      const area = sz.x * sz.z;
      if(area < MIN_AREA || area > MAX_AREA) return;
      /* A cover box is the root's axis-aligned footprint with no height, so a
       terrain chunk, hill or platform the tanks drive ON became a solid block
       tens of units wide. Paperland's centre registered a 65x65 "wall" that
       tanks were standing inside: every line of sight across the middle failed
       and both teams jammed nose to nose without ever firing. Real cover --
       buildings, crates, rocks -- is well under 40 units on a side. */
      if(Math.max(sz.x, sz.z) > 40) return;
      const cx = (lb.min.x + lb.max.x) / 2;
      const cz = (lb.min.z + lb.max.z) / 2;
      const w = sz.x + 2;
      const d = sz.z + 2;
      this.walls.push({ x: cx, z: cz, w, d, mesh: root, glbCover: true });
    });
    /* New cover walls just landed in this.walls. */
    this.invalidateIndex();
  }

  loadGLBModel(url, scale){
    return new Promise((resolve, reject) => {
      const loader = Models.loader();
      if(!loader){ reject(new Error('No GLTFLoader')); return; }
      loader.load(url, (gltf) => {
        const grp = gltf.scene;
        grp.scale.setScalar(scale);
        /* Shrink oversized map textures BEFORE they are read into the new
           toon materials below. Maps arrive with 1024x1024 skins on props that
           cover a few dozen pixels, and every one of those is a separate GPU
           upload. Doing it here means the replacement material is built around
           the small texture, rather than swapping it in afterwards and forcing
           a recompile of every affected material mid-battle. */
        try { Models.applyTextureBudget(grp); } catch(e){}
        grp.traverse(o => {
          if(o.isMesh){ o.castShadow = true; o.receiveShadow = true;
            if(o.material){
              var m = o.material;
              var nameLower = o.name ? o.name.toLowerCase() : '';
              var isBush = nameLower.includes('bush');
              var isPine = nameLower.includes('pine');
              var opts = { color: m.color };
              if(m.map) opts.map = m.map;
              if(m.side) opts.side = m.side;
              if(m.alphaTest !== undefined && m.alphaTest > 0) opts.alphaTest = m.alphaTest;
              if(isBush || isPine){
                // Foliage is alpha-CUTOUT, not alpha-BLEND: cutting a hole with
                // alphaTest still needs depth writes, otherwise the leaves stop
                // occluding and the tree reads as see-through.
                opts.depthWrite = true;
                if(m.map) opts.alphaTest = opts.alphaTest || 0.5;
              } else {
                if(m.opacity !== undefined && m.opacity < 1) opts.opacity = m.opacity;
                if(m.map && m.map.image && m.map.image.width) opts.alphaTest = opts.alphaTest || 0.5;
                // Only go transparent when the source material really is
                // translucent. An RGBAFormat map is NOT a reason to — that test
                // was true for nearly every texture, which put the whole map in
                // the transparent queue with depthWrite off and made it sort
                // itself into the void mid-battle.
                var translucent = !!m.transparent ||
                  (opts.opacity !== undefined && opts.opacity < 1);
                opts.transparent = translucent;
                opts.depthWrite = !translucent;
                opts.side = THREE.DoubleSide;
              }
              o.material = Toon.mat(opts);
              /* THE ACTUAL FIX FOR SHADOW ACNE, AND IT IS NOT A BIAS.

                 Acne is a surface shadowing itself because the depth stored in
                 the shadow map and the depth the fragment computes differ by
                 less than the map's depth precision. Every value thrown at it
                 -- bias, normalBias -- trades that self-shadowing against a
                 different artifact: negative bias detaches shadows, and a large
                 normalBias moves the sample so far along the normal that slopes
                 stop casting at all. That is why tuning the bias chased this
                 problem around the map for several deploys and never settled.

                 Rendering BACK faces into the shadow map is the structural fix.
                 For a closed solid, the far side of the object is always
                 meaningfully further from the light than the near side, so the
                 comparison cannot land on its own depth no matter how coarse
                 the map is -- which matters here, because this terrain is 500
                 units per triangle and no affordable resolution fixes that.

                 It costs nothing: the shadow pass draws the same number of
                 triangles, just the other set. */
              o.material.shadowSide = THREE.BackSide;
            }
          }
        });
        // Replace the previous map only now that the replacement is ready, so
        // the arena is never empty between maps. hideDefaults() is deliberately
        // here too (not in the mode-start functions): hiding the default arena
        // before the async load used to leave a hole in the world for as long
        // as the GLB took to download — with no previous GLB to cover it, that
        // was a blank void behind the HUD.
        this.hideDefaults();
        this._disposeGLBGroup();
        this.scene.add(grp);
        this._glbGroup = grp;
        if(!this.spawnPoints) this.spawnPoints = {};
        /* Reset per-map, not just at teardown: a map with no `flag` node must not
           inherit the previous one's capture points -- and with more than one
           flag now possible, a map with ONE flag must not inherit the previous
           map's second. */
        this._glbFlag = null;
        this._glbFlags = [];
    this._void = null;
        this._glbBushes = [];
        this._glbPines = [];
        this._treeBlobSpots = [];
        /* Reset per-map like the others: a map with no base entity must not
           inherit the previous one's, or its bases would spawn on the far side
           of a battlefield they have nothing to do with. */
        this._glbBases = [];
        grp.traverse(o => {
          if(!o.name) return;
          const lower = o.name.toLowerCase();
          /* COLLIDER / HITBOX (opt-in simple collision).
             A mesh named `collider`, `collider_*`, `hitbox` or `hitbox_*`
             (or carrying the Blender custom property `collider`/`isCollider`)
             becomes a SIMPLE BOX COLLIDER instead of being merged into the
             map's physics trimesh:

               * its bounding box becomes a cuboid collider in Rapier,
               * the mesh itself is HIDDEN (no draw call, no shadow),
               * it is flagged noPhysics so it never enters the trimesh.

             Author the collider as a plain cube in Blender at the volume you
             want; its position/rotation/scale become the box. */
          const isCollider = (o.isMesh || o.isGroup) && (
            /^collider[.\d_]*$/.test(lower) ||
            lower.startsWith('collider_') || lower.startsWith('collider.') ||
            /^hitbox[.\d_]*$/.test(lower) ||
            lower.startsWith('hitbox_') || lower.startsWith('hitbox.') ||
            /^collision[.\d_]*$/.test(lower) ||
            (o.userData && (o.userData.collider === true || o.userData.isCollider === true || o.userData.hitbox === true))
          );
          if(isCollider){
            o.userData = o.userData || {};
            o.userData.noPhysics = true;
            o.userData.isCollider = true;
            if(o.isMesh){ o.visible = false; o.castShadow = false; o.receiveShadow = false; }
            o.traverse(c => {
              if(!c.isMesh) return;
              c.visible = false; c.castShadow = false; c.receiveShadow = false;
              c.userData = c.userData || {};
              c.userData.noPhysics = true;
              c.userData.isCollider = true;
            });
          }
          /* MAP ENTITY NAMING CONVENTION (the level designer's vocabulary).
           pine    a TREE.     taiga  a BUSH.      tree  a tree.   bush  a bush.
           flag    where Capture the Circle puts its flag.
           blue    a blue-team spawn point.  red  a red-team spawn point.

           `taiga` is the low 28-vertex taiga-forest cross-shrub, not a tree,
           so it gets the BUSH rule — this engine's whole bush stack:
           noPhysics, no shadow, camouflage (World.bushes: hidingIn, cover
           overlap, the TDM transparency check), wind and contact shake, and
           foliage instancing. It used to ride the pine rule, which treated
           the scrub as a tree: a tree's ground-shadow blob instead of cover
           you can actually hide behind, and none of the bush wind that the
           flat billboard scrub already got somewhere else.

           Bush registration flags the scrub `noBillboard` on purpose. The GLB
           bush billboard pass exists for FLAT cutout bushes (Last Frontier's
           Bush_Large, Signal Map's bush_solid): a quad that has to spin to
           face the camera. The taiga cross-shrub is real 3D — billboarded it
           would snap face-on and read flat while driving past. So it keeps
           its natural orientation, and the wind reaches it the same way it
           reaches the pines: through the foliage loop, which this file feeds
           with the root the bush handler registers.

           Kept as explicit alternatives rather than a loose regex so a name like
           "pinecone_03" can be given its own rule later without this matcher
           growing by accident. */
          /* Anchored, and with NO type guard. A `flag` node in an authored map is often
             just a parent Object3D holding the flag's meshes, and requiring
             isGroup/isMesh skipped exactly the node we were looking for — which
             is why kaukaz reported no flag at all despite shipping one.

             `^flag[.\d]*$` matches `flag`, `flag.001` and `flag001` (GLTFLoader
             strips the dots) while refusing `flagpole`, which is scenery. */
          if(/^void[.\d]*$/.test(lower)){
            /* THE VOID PLANE: INVISIBLE, NOT SOLID, AND FATAL ON CONTACT.

               A kill volume, not scenery. It is never drawn -- `visible = false`
               takes it out of the render entirely rather than relying on a
               transparent material, because a transparent plane is still
               submitted, still sorted, and still writes to the depth buffer at
               whatever alpha the exporter happened to bake in.

               And it is explicitly NOT solid. Every bush, tree and building in
               the map goes into the physics trimesh; this does not, because a
               collider you are supposed to die on would stop you before you
               arrived, which turns a kill plane into a wall. The only thing
               that reads it is the tank test in Game, which compares a tank's
               position against the bounds recorded here.

               The bounds are taken from the mesh in WORLD space, after `grp` has
               been scaled, so a map can be authored at any size and the kill
               volume still lines up with the ground it is meant to sit under. */
            const vp = new THREE.Vector3();
            o.getWorldPosition(vp);
            const vb = new THREE.Box3().setFromObject(o);
            this._void = {
              x: vp.x, y: vp.y, z: vp.z,
              minX: vb.min.x, maxX: vb.max.x,
              minZ: vb.min.z, maxZ: vb.max.z,
              topY: vb.max.y,
            };
            o.visible = false;
            o.traverse(c => {
              c.visible = false;
              c.castShadow = false;
              c.receiveShadow = false;
              c.userData = c.userData || {};
              c.userData.noPhysics = true;
              c.userData.isVoid = true;
            });
          }

          if(/^flag[.\d]*$/.test(lower)){
            /* THE FLAG CONVENTION: a node named `flag` marks where Capture the
               Circle puts its flag.

               THIS NOW COLLECTS A LIST, because Signal Map has two of them and
               the old single-object assignment kept only the last one found.
               That is the quietest possible failure: the map loads, one flag
               is built, and the second objective simply does not exist. Nothing
               errors, so there is nothing to notice.

               `_glbFlag` is kept as the first entry so anything still reading
               the old single value keeps working, and because a one-flag map
               is genuinely the one-flag case rather than a special case. */
            const fp = new THREE.Vector3();
            o.getWorldPosition(fp);
            if(!this._glbFlags) this._glbFlags = [];
            this._glbFlags.push({ x: fp.x, y: fp.y, z: fp.z, name: o.name });
            if(!this._glbFlag) this._glbFlag = this._glbFlags[0];
          }

          if(lower.includes('pine') && (o.isGroup || o.isMesh)){
            let root = o;
            while(root.parent && root.parent !== grp) root = root.parent;
            if(!this._glbPines.some(p => p.obj === root)){
              root.traverse(c => {
                if(!c.isMesh) return;
                c.userData = c.userData || {};
                c.userData.noPhysics = true;
                /* FOLIAGE DOES NOT CAST A REAL SHADOW. See _buildTreeBlobs.

                   Measured on Kaukaz, the biggest map in the game: 33 conifers,
                   every one its OWN geometry (33 meshes for 33 trees) and every
                   one of them alpha-CUTOUT against a texture. The generic
                   `castShadow = true` applied to every GLB mesh further up this
                   function was therefore putting 33 alpha-tested trees through
                   the shadow pass on top of the 33 they already cost in the main
                   pass.

                   The shadow pass is the worst place to spend that. It is not
                   culled by the camera -- it is culled by the LIGHT, so a tree
                   behind the player is still drawn into the shadow map -- and it
                   runs at the shadow map's own resolution, which setQuality()
                   holds at 1024 for every tier except fancy. An alpha-tested
                   surface there has to sample its texture and discard per
                   fragment to produce an edge nobody is looking at, because a
                   tree's shadow lands on the ground under a tree you cannot see
                   the top of.

                   The ground shadow is not lost, only moved: _buildTreeBlobs
                   paints it as one merged unlit disc mesh for the whole forest,
                   which is the thing this file already worked out how to do. */
                c.castShadow = false;
              });
              const wp = new THREE.Vector3();
              root.getWorldPosition(wp);
              const ws = new THREE.Vector3();
              root.getWorldScale(ws);
              const radius = Math.max(3, Math.min(Math.max(ws.x, ws.z) * 0.5, 10));
              this._glbPines.push({
                obj: root, x: wp.x, z: wp.z, radius,
                _shakeTime: 0, _shakeActive: false,
                _origRotX: root.rotation.x, _origRotZ: root.rotation.z
              });
              /* Blob spots are collected here rather than walked back out of
                 _glbPines later, so the shadow pass above cannot be reintroduced
                 for one species without the ground shadow following it. */
              this._treeBlobSpots.push({ x: wp.x, z: wp.z, r: radius * 0.85 });
            }
          }
          if((lower.includes('bush') || lower.includes('taiga')) && (o.isGroup || o.isMesh)){
            let root = o;
            while(root.parent && root.parent !== grp) root = root.parent;
            if(!this._glbBushes.some(b => b.obj === root)){
              /* NOBILLBOARD -- the one field that decides how the wind drives
                 this bush. A `taiga` or `bush_solid` root is a real 3D shrub
                 that stands up on its own, so the foliage loop in game.js owns
                 its rotation; a plain `bush` is a flat cutout that the
                 billboard pass spins to face the camera, and a rotation write
                 here would fight it. The `solid` half is for the Signal map:
                 its `bush_solid.*` stands are crossed cutout-photo planes
                 (tools/plant-probe.mjs), upright geometry that already faces
                 every direction -- the billboard pass turning them to the
                 camera made the whole undergrowth rotate to stare at the
                 player. */
              const noBillboard = lower.includes('taiga') || lower.includes('solid');
              /* NOT SOLID. This was briefly made solid on a reading of "set
                 solid" as "give it a collider", which was wrong: it turned 53
                 pieces of scrub into obstacles in a 305-unit arena and a tank
                 driving into a hedge stopped dead instead of slowing down and
                 getting hidden. A bush you bounce off is not cover, it is a
                 wall. Foliage is noPhysics and stays that way; the wind, the
                 contact shake and the hide are the feedback. */
              const solid = false;
              root.traverse(c => {
                if(!c.isMesh) return;
                c.userData = c.userData || {};
                if(!solid) c.userData.noPhysics = true;
                /* A billboarded, double-sided, alpha-CUTOUT quad has no business
                   casting a shadow map entry: the shadow it casts is the
                   uncut rectangle of the quad, which reads as a grey sheet lying
                   next to the bush rather than as its shade. Cheaper and more
                   correct to give it none. See the pine handler above. */
                c.castShadow = false;
              });
              const wp = new THREE.Vector3();
              root.getWorldPosition(wp);
              const ws = new THREE.Vector3();
              root.getWorldScale(ws);
              /* `let`, not `const`: the upright-shrub measure below may widen
                 this radius, and a reassignment to a const throws mid-GLB-load,
                 which took the whole map down with it (Signal came up as a
                 default half-500 void with no props at all). */
              let radius = Math.max(3, Math.min(Math.max(ws.x, ws.z) * 0.6, 15));
              if(noBillboard){
                /* AN HONEST COVER RADIUS FOR UPRIGHT SHRUBS. The legacy radius
                   reads the node scale (getWorldScale), which is uniform and
                   knows nothing about how wide the authored MESH is. On the
                   Signal map it lands at 8.5, and the default tank's collider
                   is 18.3 x 22 -- a ~404 u2 footprint against a cover circle
                   of ~226 u2. COVER_HIDE_FRACTION is 50% of the footprint, so
                   the best overlap even dead-centre in the bush was 0.44:
                   camoFactor never reached hidden and the tank sat in the
                   scrub fully visible, which is why the bushes there "did not
                   hide you". Last Frontier never saw this -- its cutouts clamp
                   the legacy radius at 15, a circle that dwarfs any footprint.
                   The box is measured once at registration, so this is
                   load-time cost only. 1.35 turns half the visual spread into
                   a cover radius with breathing room (Signal: ~10.2), still
                   clamped at the old 15; billboard cutouts keep the legacy
                   radius untouched. */
                const bb = new THREE.Box3().setFromObject(root);
                const ext = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5;
                if(ext > 0) radius = Math.max(radius, Math.min(ext * 1.35, 15));
              }
              /* THE BASE ROTATION THE SWAY AND THE SHAKE ARE WRITTEN RELATIVE TO.

                 The pine handler has always recorded these (see _origRotX
                 above). Bushes did not, because bushes were never animated --
                 and when the bush sway and contact shake were added to the
                 foliage loop, every bush would have read `undefined` here and
                 written NaN into its rotation, which three.js propagates as an
                 object that silently disappears. Same failure as a missing
                 scene: no error, just a hole where a bush was. */
              const origRotX = root.rotation.x, origRotZ = root.rotation.z;
              this._glbBushes.push({ obj: root, x: wp.x, z: wp.z, flipped: false, radius, solid,
                noBillboard, _origRotX: origRotX, _origRotZ: origRotZ });
              this.bushes.push({ x: wp.x, z: wp.z, radius, mesh: root, isGLBBush: true, solid });
            }
          }
          if(lower.includes('tree') && (o.isGroup || o.isMesh)){
            let root = o;
            while(root.parent && root.parent !== grp) root = root.parent;
            root.traverse(c => {
              if(!c.isMesh) return;
              c.userData = c.userData || {};
              c.userData.noPhysics = true;
              c.castShadow = false;      /* as for pine/taiga above */
            });
          }

          /* THE BASE CONVENTION — checked BEFORE the spawn classification below,
             and that ordering is not cosmetic.

             `bluebase` and `redbase` contain "blue" and "red", so the substring
             test further down claims them as TEAM SPAWN POINTS. That is exactly
             what it did to paperland.glb, whose bases were picked up as a sixth
             spawn on each side and then had a respawning tank parked on top of
             them. Handling the base name first and returning is what keeps a
             base a base.

             Matching is deliberately loose about the separator, because this is a
             level designer's naming convention and they will not all write it the
             same way: `base`, `base.001` (GLTFLoader's dedupe suffix), `bluebase`
             and `blue_base` all mean the same thing. A bare `base` with no team
             in the name is recorded with team null — BaseDefend then decides its
             side from which spawn cluster it is nearest to.

             No type guard, for the same reason the `flag` branch has none: in an
             authored map the base is very often an empty Object3D holding the
             base's meshes, and `bluebase` in paperland is exactly that. */
          if(/^(?:(blue|red)[._-]?)?base[.\d]*$/.test(lower)){
            const wp3 = new THREE.Vector3();
            o.getWorldPosition(wp3);
            let team3 = null;
            const mt = /^(blue|red)[._-]?base/.exec(lower);
            if(mt) team3 = mt[1];
            this._glbBases.push({ x: wp3.x, y: wp3.y, z: wp3.z, team: team3, name: o.name });
            return;
          }

          let team = null;
          if(lower.includes('blue')) team = 'blue';
          else if(lower.includes('red')) team = 'red';
          else if(lower.includes('spawn')) team = 'player';
          else return;
          const wp2 = new THREE.Vector3();
          o.getWorldPosition(wp2);
          let ry = 0;
          if(o.rotation && o.rotation.y !== 0) ry = o.rotation.y;
          else if(o.quaternion){
            const q = o.quaternion.clone();
            const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
            ry = e.y;
          }
          if(!this.spawnPoints[team]) this.spawnPoints[team] = [];
          this.spawnPoints[team].push({ x: wp2.x, y: wp2.y, z: wp2.z, ry });
        });
        grp.updateMatrixWorld(true);
        this._registerGLBCoverPoints(grp, scale);
        /* Rebuild the ground shadows HERE, not only from tryPlaceTrees().

           tryPlaceTrees() is one-shot behind `treesPlaced`, and the map load is
           asynchronous: on a cold start the match-start call can easily run
           before this GLB finishes downloading, which would leave
           `_treeBlobSpots` empty, paint nothing, and then never be asked again
           because the flag is already set. The tree would be standing in the
           open for the rest of the match. Rebuilding on map load makes the
           blobs a property of the map rather than of a call order. */
        this._buildTreeBlobs(this._treeBlobSpots);
        /* LAST, after classification and after the cover points are registered:
           it removes meshes from the graph, and anything that walks the graph
           afterwards would be walking a forest that is no longer there.

           GUARDED, and it has to be. This runs inside the GLTFLoader callback,
           so anything it throws rejects the promise loadGLBModel() returns —
           which unwinds the entire mode starter, lands in menu.js's catch, and
           puts the player back at the main menu with the map never appearing.

           Foliage batching is an OPTIMISATION. It is not allowed to be able to
           prevent a match from starting. The failure mode it produces is
           indistinguishable from "the map is broken": no map, no tanks, a
           console line about draw calls, and a player who pressed PLAY and got
           thrown out again. A missing batch costs some frames; a rejected map
           load costs the whole game.

           The try/catch is around the CALL rather than inside the function so
           that the abandoned state it may leave behind — batches half-built,
           meshes detached but not replaced — cannot be observed by anything
           that runs afterwards. Resetting the batch list here means the next
           sync() sees nothing and does nothing, which is exactly the state a
           map with no batchable foliage is in anyway. */
        try { this._instanceFoliage(grp); }
        catch(e) {
          this._foliageBatches = null;
          console.warn('[World] foliage batching failed; drawing trees unbatch' +
                       'ed instead:', e);
        }
        console.log('[World] GLB spawnPoints:', Object.keys(this.spawnPoints).map(k => k + ':' + this.spawnPoints[k].length), 'bushes:', this._glbBushes.length, 'pines:', this._glbPines.length, 'coverWalls:', this.walls.length);
        resolve(grp);
      }, undefined, reject);
    });
  }

  setQuality(quality){
    this._quality = quality || 'default';
    // Fancy gets the 2048 map, everything else 1024. This used to be
    // 4096 / 2048 — a 4096 shadow map re-renders the entire scene from the
    // light every single frame and was the single largest GPU cost in the
    // game, for detail nobody can see at this camera distance.
    if(this.sunLight){
      const s = this._quality === 'fancy' ? 2048 : 1024;
      if(this.sunLight.shadow.mapSize.width !== s){
        this.sunLight.shadow.mapSize.set(s, s);
        this.sunLight.shadow.map = null;
        this.sunLight.shadow.needsUpdate = true;
        if(window._game) window._game._shadowDirty = true;
      }
    }
    // Low quality disables fog for performance
    if(this._quality === 'low' && this.scene.fog){
      this.scene.fog.near = 400;
      this.scene.fog.far = 600;
    } else if(this.scene.fog && this._quality !== 'low'){
      this.scene.fog.near = 350;
      this.scene.fog.far = 500;
    }
  }

  renderToCanvas(ctx, w, h, opts = {}){
    const scale = w / this.size;
    const ox = w / 2, oy = h / 2;
    const toPx = (x, z) => [ox + x * scale, oy + z * scale];
    ctx.fillStyle = '#4a6a2a';
    ctx.fillRect(0, 0, w, h);
    this.lakes.forEach(l => {
      const [px, py] = toPx(l.x, l.z);
      ctx.fillStyle = '#2a8aba';
      ctx.beginPath();
      ctx.arc(px, py, l.r * scale, 0, 7);
      ctx.fill();
    });
    ctx.fillStyle = '#6a6e72';
    this.walls.forEach(wl => {
      if(wl.border) return;
      ctx.fillRect(ox + (wl.x - wl.w / 2) * scale, oy + (wl.z - wl.d / 2) * scale, wl.w * scale, wl.d * scale);
    });
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
  }

  worldToMap(x, z, canvasSize){
    const scale = canvasSize / this.size;
    return [canvasSize / 2 + x * scale, canvasSize / 2 + z * scale];
  }
}
