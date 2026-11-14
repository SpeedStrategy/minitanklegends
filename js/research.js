/* ============================================================================
   research.js — TANK RESEARCH: the horizontal path that hands out extra tanks.

   WHAT IT IS
   Every collection in the garage (Menu._COLLECTIONS, the same list the
   Collections screen draws) becomes a five-step research line:

       step 1  a CHOICE between the collection's tank 1 and tank 2
       step 2  whichever of those two you did NOT take
       step 3  a CHOICE between tank 3 and tank 4
       step 4  the one you did not take
       step 5  tank 5

   Then the next collection's line opens. That is the whole progression: the
   collection roster decides the rewards, so adding a collection in menu.js
   adds its research line here with no edit to this file.

   XP is the currency. It comes from three places and no others:

       missions   — claiming a completed mission pays research XP alongside
                    its cash/coins (missions.js grantReward calls
                    Research.addXP)
       battles    — kills, assists, damage and a win, paid once per battle
                    through Game._awardBattleCash (game.js)
       crates     — a small flat amount per crate opened (menu.js CLAIM)

   WHY THE PATH IS BUILT FROM THE GARAGE ROSTER
   The alternative is a second hard-coded table of tanks, and the last hard-coded
   roster in this project (the old _COLLECTIONS) is exactly how the Mortar ended
   up playable, in TANK_ORDER, and invisible in the menu. One source of truth.

   SLOTS THAT ARE { soon: 'Name' }
   Announced-but-unmodelled tanks are not rewards. A step whose only candidate is
   a soon marker is drawn as a locked "coming soon" signpost and is PASSED OVER
   by progression, so the line can never dead-end on content that does not exist
   yet. A two-tank step with one real tank collapses into a single-tank step, and
   its paired "the other one" step is dropped rather than duplicated.

   STATE
   Everything lives in settings (and therefore in localStorage):
       researchXP        the wallet
       researchClaimed   nodeId -> tankId, the step's reward has been taken
       researchChoice    nodeId -> tankId, which half a two-tank step took
   Those three keys are whitelisted in config.js loadSettings — see the note
   there, because a key missing from that literal is dropped on every save.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- tuning */

  /* Cost of each step, per collection. The first line is the cheap tutorial
     one; later lines ask for what the tanks are actually worth. A collection
     beyond the table reuses the last row rather than costing nothing. */
  const COLUMN_COSTS = [
    [150, 250, 400, 600, 900],
    [250, 400, 650, 900, 1300],
    [350, 550, 800, 1100, 1500],
    [450, 700, 1000, 1400, 1900],
  ];

  /* XP payouts. Small enough that a whole line takes several sessions, big
     enough that a good battle visibly moves the bar.

     The battle figures are tuned against ONE decent Team Deathmatch: ~6,000
     damage, 4 kills, 3 assists and a win is 180 + 180 + 24 + 120 = 504 XP,
     which is a bit more than the first step of collection 1. A mission claim
     pays in the same league, and a crate pays a nudge so opening them is never
     wasted but never replaces playing. */
  const XP = {
    per1000Damage: 30,
    perKill: 45,
    perAssist: 8,
    perWin: 120,
    missionCash: 0.8,
    missionCoins: 1.5,
    perCrate: 12,
  };

  /* ------------------------------------------------------------- utilities */

  function menu() { return (typeof Menu !== 'undefined' && Menu) ? Menu : null; }

  function settings() {
    const m = menu();
    if (m && m.settings) return m.settings;
    try { return (typeof loadSettings === 'function') ? loadSettings() : null; }
    catch (e) { return null; }
  }

  function persist() {
    const s = settings();
    if (!s) return;
    const m = menu();
    try { if (m && m._updateCurrencies) m._updateCurrencies(); } catch (e) {}
    try { if (typeof saveSettings === 'function') saveSettings(s); } catch (e) {}
  }

  function toast(msg) {
    const m = menu();
    if (m && m.toast) { try { m.toast(msg); return; } catch (e) {} }
    try { console.log('[research]', msg); } catch (e) {}
  }

  function tankDef(id) {
    return (id && typeof TANKS !== 'undefined' && TANKS[id]) ? TANKS[id] : null;
  }

  function isOwned(id) {
    const s = settings();
    if (!s || !id) return false;
    if (s.allUnlocked) return true;
    return Array.isArray(s.unlockedTanks) && s.unlockedTanks.indexOf(id) >= 0;
  }

  /* ------------------------------------------------------------- path model */

  /* One garage slot -> one candidate. Anything that is not a real tank in
     TANKS becomes a named-but-unbuilt placeholder, which is what the path
     renders as a signpost. */
  function slotInfo(entry) {
    if (typeof entry === 'string' && tankDef(entry)) {
      const def = tankDef(entry);
      return { id: entry, name: def.name, tier: def.tier || 1, soon: false };
    }
    if (entry && typeof entry === 'object' && entry.soon) {
      return { id: null, name: String(entry.soon), tier: 0, soon: true };
    }
    return { id: null, name: 'Coming Soon', tier: 0, soon: true };
  }

  function collections() {
    const m = menu();
    return (m && Array.isArray(m._COLLECTIONS)) ? m._COLLECTIONS : [];
  }

  function costsFor(ci) {
    const row = COLUMN_COSTS[Math.min(ci, COLUMN_COSTS.length - 1)];
    return row || COLUMN_COSTS[0];
  }

  /* The whole path, flattened, in play order: collection 1's five steps, then
     collection 2's, and so on.

     `skip` steps are the "the other one" halves whose pair had only one real
     tank — they are dropped rather than rendered, because the tank they would
     hand out is the one the step before them already hands out. */
  function buildPath() {
    const out = [];
    collections().forEach(function (col, ci) {
      const slots = (col.tanks || []).slice(0, 5).map(slotInfo);
      while (slots.length < 5) slots.push({ id: null, name: 'Coming Soon', tier: 0, soon: true });

      const raw = [
        { ni: 0, kind: 'pair',   cands: [slots[0], slots[1]] },
        { ni: 1, kind: 'follow', cands: [slots[0], slots[1]] },
        { ni: 2, kind: 'pair',   cands: [slots[2], slots[3]] },
        { ni: 3, kind: 'follow', cands: [slots[2], slots[3]] },
        { ni: 4, kind: 'single', cands: [slots[4]] },
      ];
      const costs = costsFor(ci);

      raw.forEach(function (n) {
        n.ci = ci;
        n.collectionId = (col.id != null) ? col.id : (ci + 1);
        n.id = 'c' + ci + 'n' + n.ni;
        n.cost = costs[n.ni] || 0;
        n.realCands = n.cands.filter(function (c) { return c && !c.soon && c.id; });
        n.soon = n.realCands.length === 0;
        if (n.kind === 'pair' && n.realCands.length === 1) n.kind = 'single';
      });

      /* A pair with fewer than two real tanks has nothing for its follow-up
         step to hand out. */
      raw[1].skip = raw[0].realCands.length < 2;
      raw[3].skip = raw[2].realCands.length < 2;

      raw.forEach(function (n) { if (!n.skip) out.push(n); });
    });
    return out;
  }

  /* The candidates a step can actually pay out right now.

     A "follow" step resolves to whatever its pair did NOT take, which is only
     known once the pair has been claimed — before that it offers both, and the
     UI draws it as a mystery. Already-owned tanks are filtered out by
     `claimableFor`, not here, so the display can still name them. */
  function resolvedOptions(node, nodes) {
    if (node.kind !== 'follow') return node.realCands.slice();
    const i = nodes.indexOf(node);
    const prev = i > 0 ? nodes[i - 1] : null;
    const s = settings() || {};
    const picked = prev && (s.researchChoice || {})[prev.id];
    if (!picked) return node.realCands.slice();
    const rest = node.realCands.filter(function (c) { return c.id !== picked; });
    return rest.length ? rest : node.realCands.slice();
  }

  function claimOf(node) {
    const s = settings() || {};
    return (s.researchClaimed || {})[node.id] || null;
  }

  /* Index of the first step that still needs work. `soon` signposts are passed
     over: they are not rewards and must never block the line. */
  function frontier(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].soon) continue;
      if (!claimOf(nodes[i])) return i;
    }
    return -1;
  }

  function stateOf(node, nodes) {
    if (claimOf(node)) return 'claimed';
    if (node.soon) return 'soon';
    const f = frontier(nodes);
    if (f >= 0 && nodes[f] === node) return 'next';
    return 'locked';
  }

  /* --------------------------------------------------------------- XP wallet */

  /* Every XP payout in the game goes through here. Returns the amount actually
     credited so callers can report it. */
  function addXP(amount, reason) {
    const n = Math.round(Number(amount) || 0);
    const s = settings();
    if (!s || n <= 0) return 0;
    s.researchXP = (typeof s.researchXP === 'number' ? s.researchXP : 0) + n;
    persist();
    if (reason) toast('+' + n + ' Research XP — ' + reason);
    else toast('+' + n + ' Research XP');
    if (Research.open) render();
    updateBadge();
    return n;
  }

  /* Battle payouts, derived from the numbers the results screen already shows.
     Called once per battle (game.js guards the call), so a battle that ends
     twice cannot pay twice. */
  function xpForBattle(opts) {
    opts = opts || {};
    const dmg = Math.max(0, Math.floor(opts.damage || 0));
    const kills = Math.max(0, Math.floor(opts.kills || 0));
    const assists = Math.max(0, Math.floor(opts.assists || 0));
    return Math.floor(dmg / 1000) * XP.per1000Damage
         + kills * XP.perKill
         + assists * XP.perAssist
         + (opts.won ? XP.perWin : 0);
  }

  function xpForMission(cash, coins) {
    return Math.round((cash || 0) * XP.missionCash + (coins || 0) * XP.missionCoins);
  }

  /* ------------------------------------------------------- 3D TURNTABLE STAGE

     Every reward is a LIVE model, not a picture. One transparent WebGL canvas
     covers the path and each tank is placed on it at its own node's pixel
     coordinates, so the models float straight on the blueprint background with
     no tile, no card and no border around them. Dragging a model spins it.

     WHY ONE CANVAS INSTEAD OF ONE PER TANK
     Five small viewers would need five WebGL contexts on the path plus two more
     in the reward picker, and a browser caps contexts hard. With one camera
     measured in CSS pixels — left 0, right width, top 0, bottom height, so y
     runs DOWNWARD like offsetTop — a model placed at (node.offsetLeft + ...)
     lands exactly above its own dot. The canvas lives INSIDE the scrolled
     content, so it scrolls with the path for free.

     The tank is built with `new Tank(def, { physicsWorld: null })`, the same
     call the garage viewer makes, so the model, its hull/turret rig and the
     editor overrides are the real thing. Each tank hangs off its own pivot
     group: the tank keeps whatever transform it authored, and the pivot is what
     spins and scales. */

  const Stage = (function () {

    function create(host) {
      const stage = {
        host: host,
        slots: [],
        pool: {},
        renderer: null,
        scene: null,
        camera: null,
        canvas: null,
        failed: false,
        running: false,
        raf: 0,
        w: 1,
        h: 1,
        laid: false,
        hoverSlot: -1,
        dragging: false,
        dirty: false,
      };

      stage.ensure = function () {
        if (stage.renderer) return true;
        if (stage.failed) return false;
        if (typeof THREE === 'undefined' || typeof Tank === 'undefined') { stage.failed = true; return false; }
        try {
          stage.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        } catch (e) { stage.failed = true; return false; }

        stage.renderer.setClearAlpha(0);
        if ('outputColorSpace' in stage.renderer && THREE.SRGBColorSpace) stage.renderer.outputColorSpace = THREE.SRGBColorSpace;

        stage.canvas = stage.renderer.domElement;
        stage.canvas.className = 'rs-canvas';
        stage.canvas.setAttribute('aria-hidden', 'true');

        stage.scene = new THREE.Scene();
        /* CALM SHOWROOM LIGHTING.
           The screens behind these models are now dark, so the rig is a quiet
           neutral studio: a dim hemisphere for form, a moderate key so hull
           textures and panels stay readable instead of blowing out, a soft
           gold rim to lift the silhouette off the void, and a low frontal
           fill for near-black authors like the Ghost. Nothing glows. */
        stage.scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x2a2e35, 0.5));
        /* THE KEY WAS BLOWING THE HULLS OUT. At 1.5 on top of a 0.7 hemisphere,
           a 0.55 fill and a 0.85 rim the total landed around 3.6x -- camo
           patterns washed to flat colour and light-coloured tanks clipped to
           white, which is the "too bright" the showroom was reporting. The rig
           is now balanced at roughly two thirds of that, with the key still the
           brightest source so form reads, and the rim kept gold so the
           silhouette lifts off the dark sheet without lighting the hull. */
        const key = new THREE.DirectionalLight(0xfff2dd, 1.0);
        key.position.set(2.4, 3.6, 3.2);
        stage.scene.add(key);
        const rim = new THREE.DirectionalLight(0xffd24a, 0.5);
        rim.position.set(-3.0, 1.8, -2.6);
        stage.scene.add(rim);
        /* THE COOL SIDE. A two-temperature rig is what makes a metal hull
           read as a photographed object: warm key from the front right, a
           faint cool bounce filling the shadow side, gold rim behind. It is
           deliberately weak (0.22) -- enough to hold detail in a black hull,
           not enough to tint the camo. */
        const cool = new THREE.DirectionalLight(0xbfd6f5, 0.22);
        cool.position.set(-3.6, 1.4, 3.4);
        stage.scene.add(cool);
        const under = new THREE.DirectionalLight(0xcfd6de, 0.16);
        under.position.set(0, -2.2, 1.6);
        stage.scene.add(under);
        /* A flat frontal fill. Some hulls are authored near-black (#0f0d0d on
           the Ghost) and toon shading keeps them that way — without a light
           coming from the camera the dark tanks read as holes in the sheet
           rather than as silhouettes with form. */
        const fill = new THREE.DirectionalLight(0xffffff, 0.34);
        fill.position.set(0, 1.2, 4);
        stage.scene.add(fill);

        /* PIXEL-SPACE ORTHOGRAPHIC CAMERA — y UP.

           left 0 / right W / top H / bottom 0 maps world x,y onto CSS pixels
           one-to-one. The y axis must stay the normal way up: handing an ortho
           camera top:0 / bottom:H flips the projection, which also flips the
           winding order on screen, so every front face is culled and the
           inverted-hull toon outline becomes the only thing visible — the
           models render as flat black silhouettes. Placement negates slot.y
           instead (see place()). */
        stage.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -4000, 4000);
        stage.camera.position.set(0, 0, 1500);
        stage.camera.lookAt(0, 0, 0);

        /* VOID-FLOOR CONTACT SHADOW -- one shared soft ellipse texture, one
           mesh per slot created lazily in place(). The pad it lands on is a
           dark hairline ellipse the CSS draws under each model; this shadow
           is what makes the tank STAND instead of hang. The mesh is drawn
           first (renderOrder) with depthTest off, so it never clips the hull
           but always sits behind it. */
        const cvs = document.createElement('canvas');
        cvs.width = 128; cvs.height = 64;
        const cx2 = cvs.getContext('2d');
        if (cx2) {
          const g = cx2.createRadialGradient(64, 32, 3, 64, 32, 62);
          g.addColorStop(0, 'rgba(0,0,0,.62)');
          g.addColorStop(.5, 'rgba(0,0,0,.34)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          cx2.fillStyle = g;
          cx2.fillRect(0, 0, 128, 64);
          stage.shadowTex = new THREE.CanvasTexture(cvs);
          stage.shadowGeo = new THREE.PlaneGeometry(1, 1);
          stage.shadowMat = new THREE.MeshBasicMaterial({
            map: stage.shadowTex,
            transparent: true,
            depthTest: false,
            depthWrite: false,
          });
        }

        /* NO CARTOON INK OUTLINE.

           Every model used to get an inverted-hull shell: a back-face twin
           pushed 0.028 along the normals in flat near-black, which drew a bold
           comic contour round each tank. It was the single most "cartoon"
           thing on this screen, and it also doubled the draw calls of a row
           that can hold twenty models. The Foundry is a showroom now: the
           models keep their own materials and their own shadows and nothing
           is drawn around them. */
        return true;
      };

      stage.mount = function () {
        if (!stage.ensure()) return false;
        if (stage.canvas.parentNode !== host) host.appendChild(stage.canvas);
        stage.layout();
        return true;
      };

      stage.layout = function () {
        if (!stage.renderer) return;
        const w = Math.round(host.clientWidth);
        const h = Math.round(host.clientHeight);
        if (w < 4 || h < 4) { stage.laid = false; return; }
        if (w === stage.w && h === stage.h && stage.laid) { stage.place(); return; }
        stage.w = w; stage.h = h; stage.laid = true;
        stage.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        stage.renderer.setSize(w, h, false);
        stage.camera.left = 0;
        stage.camera.right = w;
        stage.camera.top = h;
        stage.camera.bottom = 0;
        stage.camera.updateProjectionMatrix();
        stage.place();
        stage.paint();
      };

      /* Measure a tank by what is DRAWN, not by its bounding box.

         Box3.setFromObject expands around every mesh in the tree, invisible or
         not — and a tank rig hides a fair amount: the model-authored `hitbox`
         (TL_ark ships one), the muzzle-flash and glow sprites, the overlay
         group. Those hidden nodes can dominate the box, and because the fit
         below normalises by that box, the tank itself comes out small and
         floating, with a black rectangle where the sprite used to be. This
         walks only geometry that is actually visible and unions per-mesh
         bounds in world space. */
      function measure(root) {
        const box = new THREE.Box3();
        const tmp = new THREE.Box3();
        root.updateMatrixWorld(true);
        (function walk(o, shown) {
          const vis = shown && o.visible !== false;
          if (vis && o.isMesh && o.geometry) {
            if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
            if (o.geometry.boundingBox) {
              tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
              box.union(tmp);
            }
          }
          for (let i = 0; i < o.children.length; i++) walk(o.children[i], vis);
        })(root, true);
        if (box.isEmpty()) return new THREE.Box3().setFromObject(root);
        return box;
      }

      /* HOW FAR THE SHEET IS TILTED BACK.

         The camera is pixel-mapped and axis-aligned (world x/y = screen x/y),
         so it cannot itself look down at the tanks. Instead the models are
         tipped toward the viewer about X, which is what gives them a top
         surface and a footprint — a flat hull like the Ghost read as a
         pancake seen edge-on. Tilt sits OUTSIDE the spin group, so spinning a
         tank turns it on its own axis the way a turntable does instead of
         rolling it sideways. */
      const TILT = 0.14;

      /* THE HERO POSE — how far a turret is turned before anyone touches it.
         26 degrees is a deliberate three-quarter: the barrel crosses its own
         silhouette, the front plate and the turret cheek are both readable,
         and the model stops looking like a spec sheet front elevation. It sits
         on top of the hull's own baseSpin (see place), so hull and turret are
         never parallel and every tank gets a photographed angle. */
      const HERO_YAW = 26 * Math.PI / 180;

      /* How far the player may traverse a turret by hand. A real turret only
         swings so far before the breech is in the hull, and beyond about 120
         degrees the barrel clips through the hull on every model that is not
         an open-topped AA mount. */
      const TURRET_LIMIT = 120 * Math.PI / 180;

      /* The one place the turret's yaw is written, so the hero pose and the
         player's aim can never fight over it. */
      function applyTurret(en) {
        if (!en || !en.turret) return;
        en.turret.rotation.y = (en.turretYaw || 0) + (en.hero || 0) * HERO_YAW;
      }

      /* One tank object per SLOT, not per tank id.

         A tank can legitimately appear on two steps at once — step 1 offers
         "coolbuddy or striker" and step 2 IS whichever one you did not take —
         so keying the pool by id made both slots share one pivot, and the
         second placement dragged the first model across the line. The slot key
         (node id + half index) is unique, so each model keeps its own pivot. */
      function entryFor(key, id) {
        if (!key || !id) return null;
        let en = stage.pool[key];
        if (en) return en;
        const def = tankDef(id);
        if (!def) return null;
        let tank = null;
        try {
          const preview = Object.assign({}, def);
          preview.playAnims = false;
          tank = new Tank(preview, { physicsWorld: null });
        } catch (e) { tank = null; }
        if (!tank || !tank.root) return null;
        if (tank._overlayGroup) tank._overlayGroup.visible = false;
        /* No sprites on the blueprint sheet. A tank rig carries billboard
           sprites (muzzle flash, glows) that are meant to appear for a frame
           mid-battle; frozen in a static preview they read as flat black
           rectangles floating beside the hull — and worse, they are part of
           the bounding box, so the tank they belong to gets scaled down to
           fit around a flash that never fires. */
        try {
          tank.root.traverse(function (o) {
            if (o.isSprite || (o.material && o.material.isSpriteMaterial)) o.visible = false;
          });
        } catch (e) {}

        /* pivot = world placement + scale + tilt; spinGroup = the turntable */
        const spinGroup = new THREE.Group();
        spinGroup.add(tank.root);
        const pivot = new THREE.Group();
        pivot.add(spinGroup);
        pivot.rotation.x = TILT;
        /* hidden until it has been measured and placed: a raw pivot sits at the
           world origin at scale 1, which would flash a full-size tank in the
           bottom-left corner of the sheet while the GLB loads */
        pivot.visible = false;
        stage.scene.add(pivot);

        /* THE TURRET IS A SECOND AXIS OF ROTATION.

           en.turret is the node that actually yaws on this model — the model's
           own turret pivot when the GLB has one ("turret"/named rig), the
           engine's turret group otherwise. Two numbers drive it:

             turretYaw   what the PLAYER has aimed, in radians, kept as-is
             hero       1 -> 0 once the exhibit is touched. The tanks are not
                        stored facing straight ahead: a turret turned ~14 deg
                        gives every hull a three-quarter pose with the barrel
                        crossing its own silhouette, which is the angle a
                        photograph of a tank is taken from. The pose is a
                        LIE that only lasts until you grab the tank: on the
                        first pointerdown hero eases to 0 over ~0.45s and the
                        turret returns to the model's own neutral, from which
                        point every degree of yaw is the player's. */
          en = {
            tank: tank, pivot: pivot, spinGroup: spinGroup, spin: null, baseSpin: null,
            ready: false, size: null, shadow: null, detached: false,
            turret: null, turretYaw: 0, hero: 1, heroTouched: false,
          };
          stage.pool[key] = en;

        const ready = (tank._modelReady && typeof tank._modelReady.then === 'function')
          ? tank._modelReady : Promise.resolve();
        Promise.resolve(ready).catch(function () { return null; }).then(function () {
          try {
            tank.root.updateMatrixWorld(true);
            const box = measure(tank.root);
            if (!box.isEmpty()) {
              const c = box.getCenter(new THREE.Vector3());
              en.size = box.getSize(new THREE.Vector3());
              /* centre the hull on the pivot so scale + spin happen about the
                 tank's middle, not about its track pins */
              tank.root.position.set(-c.x, -c.y, -c.z);

              /* WHICH WAY THE TANK FACES ON THE SHEET.

                 The camera looks straight down -Z, so screen width is world X:
                 a hull whose long axis runs along Z is seen end-on and reads as
                 a small block, while the same hull turned sideways fills the
                 line. Models are authored facing all sorts of directions, so
                 the rest pose is derived from the measured box instead of
                 assumed: whichever axis is longer gets swung to roughly
                 across the screen, then backed off ~30° so the side and the
                 front are both visible — a three-quarter view, every time. */
              const deg = Math.PI / 180;
              en.baseSpin = en.size.z > en.size.x ? -60 * deg : -30 * deg;
            }
          } catch (e) {}

          /* WHICH NODE YAWNS. Read once, after the rig exists: a GLB with a
             named turret gets the model's own pivot, a cube tank gets its
             turret group. `tank.turretGroup` is only a fallback because the
             model pivot is the node that turns about the turret ring; yawing
             the outer group would swing the whole turret assembly around the
             hull's centre instead. */
          try {
            en.turret = tank._modelTurretPivot || tank.turretGroup || null;
          } catch (e) { en.turret = null; }
          applyTurret(en);
          en.ready = true;
          stage.dirty = true;
          stage.place();
          pivot.visible = !!(en.size && !stage.failed);
          stage.paint();
        });
        return en;
      }

      /* ONE PATH, MANY MODELS. The path is a single continuous line holding
         EVERY collection's steps, so when its .rs-node markup is rebuilt the
         stage gets ~20 slots at once. Loading 20 GLBs the moment the screen
         opens would burn bandwidth and memory on tanks a screen or two away
         from the step the player is standing on. setViewport() records the
         visible scroll window (plus a margin); place() then only CREATES and
         SHOWS entries near it and detaches the far ones (their GLB load and
         measured size stay cached in the pool -- detaching only removes them
         from the scene, and scrolling back re-attaches instantly). */
      stage.setViewport = function (left, width) {
        stage._vpL = (typeof left === 'number' && isFinite(left)) ? left : null;
        stage._vpW = Math.max(1, width || 1200);
      };
      stage.setViewport(null, 0);

      stage.place = function () {
        if (!stage.renderer) return;
        const vpL = stage._vpL, vpW = stage._vpW;
        stage.slots.forEach(function (slot) {
          /* is this slot within the (margin-inflated) scroll window? */
          const near = (vpL == null) ||
            (slot.x + (slot.w || 80) / 2 > vpL - 620 &&
             slot.x - (slot.w || 80) / 2 < vpL + vpW + 620);
          if (!near) {
            const away = stage.pool[slot.key];
            slot.entry = away || null;
            if (away && !away.detached) {
              try { stage.scene.remove(away.pivot); } catch (err) {}
              if (away.shadow) away.shadow.visible = false;
              away.detached = true;
            }
            return;
          }
          const en = entryFor(slot.key, slot.id);
          slot.entry = en;
          if (!en) return;
          /* the mystery step: one black silhouette, whichever model is on duty */
          if (slot.shadow && !en.ink) { en.ink = true; paintShadow(en); }
          if (en.detached) {
            try { stage.scene.add(en.pivot); } catch (err) {}
            en.detached = false;
            if (en.shadow) en.shadow.visible = true;
          }
          if (!en.ready || !en.size) return;
          const maxW = Math.max(24, slot.w || 150);
          /* air above the tank: the box's bottom edge is the ground line, so the
             trim can only come off the top */
          const maxH = Math.max(24, (slot.h || 120) * 0.92);
          /* FOOTPRINT, not bounding box — the same rule the pre-battle tank
             panel uses (Menu._buildTankPreview: 4.4 / footprint). Fitting to
             width AND height independently made two tanks on one step wildly
             different sizes: a low wide hull hit the width limit and a tall
             one hit the height limit, so a Cool Buddy came out a quarter the
             size of a Sturmratte. Normalising the ground footprint puts every
             tank in the same lineup; the height cap only catches something
             genuinely tall. */
          /* ...and measured at the REST POSE, not on the raw box: the screen
             width of a rotated tank is sx*|cos| + sz*|sin|, so fitting the
             un-rotated footprint under-sizes every hull that is turned to show
             its length. */
          const base = (en.baseSpin === undefined || en.baseSpin === null) ? -Math.PI / 6 : en.baseSpin;
          const c0 = Math.abs(Math.cos(base)), s0 = Math.abs(Math.sin(base));

          /* Screen extents of the tilted, spun box: tilt mixes the model's
             depth into screen height, so a long hull needs its height budget
             computed rather than assumed. */
          const footprint = Math.max(0.001, en.size.x * c0 + en.size.z * s0);
          const depth = en.size.x * s0 + en.size.z * c0;
          const tall = en.size.y * Math.cos(TILT) + depth * Math.sin(TILT);

          let scale = maxW / footprint;
          const tallPx = tall * scale;
          if (tallPx > maxH) scale *= maxH / tallPx;
          en.pivot.scale.setScalar(scale);
          /* world y is UP while slot.y is measured DOWN from the path's top
             edge, so the whole canvas height is the mirror line: this one line
             is the only place the two coordinate systems meet. */

          /* GROUND LINE = THE BOTTOM OF THE SLOT.

             Every tank stands on the same hairline just above its tick and dot,
             so a low wide hull and a tall one sit in a lineup instead of bobbing
             at different heights. The pivot is centred on the measured box, so
             the half-height is what lifts the model's bottom edge onto that
             line.

             IT USED TO END AT THE SLOT'S CENTRE, which left the bottom half of
             the model box empty and the tracks hanging a hundred pixels above
             the hairline they were supposed to touch — the "kid's toy on a
             string" look. slot.y/h are the model-slot's box in path space, so
             the bottom edge is simply y + h. */
          const groundY = stage.h - (slot.y + (slot.h || 0));
          en.pivot.position.set(slot.x, groundY + (tall * scale) / 2, 0);
          if (en.spin === undefined || en.spin === null) en.spin = en.baseSpin || 0;
          if (en.spinGroup) en.spinGroup.rotation.y = en.spin;
          applyTurret(en);
          if (slot.hidden) en.pivot.visible = false;

          /* The shadow ellipse: a bit wider than the measured footprint at the
             final scale, squashed to a cartoon pancake, its centre just above
             the dot line. */
          if (!en.shadow && stage.shadowMat && stage.shadowGeo) {
            en.shadow = new THREE.Mesh(stage.shadowGeo, stage.shadowMat);
            en.shadow.renderOrder = -5;
            stage.scene.add(en.shadow);
          }
          if (en.shadow) {
            const pw = Math.max(36, footprint * scale * 1.08);
            en.shadow.scale.set(pw, pw * 0.30, 1);
            en.shadow.position.set(slot.x, groundY + 1.5, -30);
            en.shadow.visible = !slot.hidden;
          }
        });

        /* Tanks no longer on this line are dropped so switching collections
           cannot leak a viewer per tank. */
        const used = {};
        stage.slots.forEach(function (s) { used[s.key] = 1; });
        Object.keys(stage.pool).forEach(function (key) {
          if (used[key]) return;
          const en = stage.pool[key];
          try { stage.scene.remove(en.pivot); } catch (e) {}
          try { if (en.shadow) stage.scene.remove(en.shadow); } catch (e) {}
          try { if (en.tank && en.tank.dispose) en.tank.dispose(); } catch (e) {}
          delete stage.pool[key];
        });
      };

      /* THE INSPECTOR'S HANDS. The rotate buttons and the hero-pose restore
         drive the same state a drag does, through the same fields, so a button
         turn and a mouse turn can never disagree. `prefix` is the node id: a
         two-tank step has two slots (node:0 / node:1), and the first one is
         the one the buttons steer. */
      stage.spinBy = function (prefix, delta) {
        const slot = stage.slots.filter(function (s) {
          return String(s.key).indexOf(prefix + ':') === 0;
        })[0];
        const en = slot && slot.entry;
        if (!en || !en.ready) return false;
        en.heroTouched = true;
        en.hero = 0;
        en.spin = (en.spin || 0) + delta;
        if (en.spinGroup) en.spinGroup.rotation.y = en.spin;
        stage.dirty = true;
        stage.paint();
        return true;
      };

      stage.heroPose = function (prefix) {
        const slot = stage.slots.filter(function (s) {
          return String(s.key).indexOf(prefix + ':') === 0;
        })[0];
        const en = slot && slot.entry;
        if (!en || !en.ready) return false;
        en.heroTouched = false;
        en.hero = 1;
        en.turretYaw = 0;
        en.spin = (en.baseSpin === undefined || en.baseSpin === null) ? 0 : en.baseSpin;
        if (en.spinGroup) en.spinGroup.rotation.y = en.spin;
        applyTurret(en);
        stage.dirty = true;
        stage.paint();
        return true;
      };

      /* THE SHADOW TANK'S INK.

         "The Other One" used to be a dashed place marker because showing both
         tanks there would repeat step 1. It is a single anonymous silhouette
         now: the two candidate models take turns standing in the same spot,
         and this material is what makes them read as a shadow instead of as a
         tank you can already recognise. Geometry is untouched -- only the
         surface is replaced, so the shape stays crisp and the outline is the
         model's own. */
      function paintShadow(en) {
        try {
          if (!stage.inkMat) stage.inkMat = new THREE.MeshBasicMaterial({ color: 0x0a0c10 });
          en.tank.root.traverse(function (o) {
            if (o.isMesh && o.material && !o.isSprite) o.material = stage.inkMat;
          });
        } catch (e) { /* a tank that refuses to be repainted is simply not dark */ }
      }

      /* Hide/show one pooled model without touching the others. The morphing
         mystery tank is two slots stacked on the same pixels; exactly one of
         them is visible at any moment. */
      stage.setSlotHidden = function (key, hidden) {
        const en = stage.pool[key];
        if (!en || !en.pivot) return;
        en.pivot.visible = !hidden;
        if (en.shadow) en.shadow.visible = !hidden;
        stage.dirty = true;
        stage.paint();
      };

      stage.setSlots = function (list) {
        stage.slots = (list || []).map(function (s) {
          return {
            key: s.key || s.id, id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, auto: !!s.auto,
            /* the mystery tank's two stacked halves */
            shadow: !!s.shadow, hidden: !!s.hidden,
          };
        });
        stage.place();
        stage.paint();
      };

      stage.paint = function () {
        if (!stage.renderer || !stage.scene) return;
        stage.dirty = true;
        stage.renderer.render(stage.scene, stage.camera);
      };

      stage.start = function () {
        if (stage.running) return;
        if (!stage.mount()) return;
        stage.running = true;
        /* NO AUTO-SPIN. The models are exhibits: a tank turns only when the
           player grabs it and drags. The loop still runs, but with a dirty
           flag it only repaints when something actually changed -- a drag
           step, a model finishing its load, a relayout -- so a still screen
           costs one rAF and zero draws. */
        const loop = function () {
          if (!stage.running) return;
          stage.raf = requestAnimationFrame(loop);
          const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          const dt = Math.min(0.05, (now - (stage._last || now)) / 1000);
          stage._last = now;

          /* THE POSE SETTLES, THEN IT IS YOURS. Only a turret that has been
             grabbed eases back to neutral, and only until it gets there; a
             showroom nobody has touched costs exactly one rAF and no draws. */
          let animating = false;
          stage.slots.forEach(function (slot) {
            const en = slot.entry;
            if (!en || !en.ready) return;
            if (en.heroTouched && en.hero > 0) {
              en.hero = Math.max(0, en.hero - dt / 0.45);
              applyTurret(en);
              animating = true;
            }
            if (en.spinGroup) en.spinGroup.rotation.y = en.spin;
          });
          if (animating) stage.dirty = true;

          if (!stage.dirty) return;
          stage.dirty = false;
          stage.renderer.render(stage.scene, stage.camera);
        };
        stage.raf = requestAnimationFrame(loop);
      };

      stage.stop = function () {
        stage.running = false;
        if (stage.raf) cancelAnimationFrame(stage.raf);
        stage.raf = 0;
      };

      /* Drag to spin. Delegated on the host because the drag areas are rebuilt
         with the path markup on every render; window-level move/up so a fast
         drag that leaves the little hit box keeps working. */
      stage.bindDrag = function () {
        if (stage.dragBound) return;
        stage.dragBound = true;

        let active = null, lastX = 0, mode = 'hull';

        const keyFrom = function (target) {
          const el = target && target.closest ? target.closest('[data-slot-key]') : null;
          return el ? el.getAttribute('data-slot-key') : null;
        };
        const slotFor = function (key) {
          if (!key) return null;
          for (let i = 0; i < stage.slots.length; i++) {
            if (stage.slots[i].key === key) return stage.slots[i];
          }
          return null;
        };

        host.addEventListener('pointerdown', function (ev) {
          /* Left button only: middle-drag is the path's pan gesture, and it must
             not start a spin on whatever model it happens to begin over. */
          if (ev.button !== 0) return;
          const slot = slotFor(keyFrom(ev.target));
          if (!slot) return;
          active = slot;
          stage.dragging = true;
          lastX = ev.clientX;

          /* WHERE YOU GRABBED IT DECIDES WHAT TURNS.

             The top half of a tank is its turret and the bottom half is its
             hull, so the hit box is split on that line in SCREEN space rather
             than by raycasting the mesh: no raycast, no per-model geometry to
             query, and it behaves the same for a two-headed pair where the
             slots are side by side. Grabbing the turret aims it; grabbing the
             hull turntables the whole exhibit. */
          mode = 'hull';
          try {
            const cv = stage.canvas && stage.canvas.getBoundingClientRect ? stage.canvas.getBoundingClientRect() : null;
            if (cv && slot.h > 4) {
              /* slot.y is the TOP of the model box (see settleGeometry), so the
                 box top is simply cv.top + slot.y. Subtracting half the height
                 here — which is what this did when slot.y was a centre — put the
                 split line 91px above the tank, so every grab on the turret read
                 as a grab on the hull and the turret could never be aimed. */
              const top = cv.top + slot.y;
              if ((ev.clientY - top) / slot.h < 0.55) mode = 'turret';
            }
          } catch (e) {}

          /* The hero pose is a claim about the model, not about the player's
             aim: the moment anyone touches the exhibit it steps aside. */
          const en = slot.entry;
          if (en && en.heroTouched !== true) {
            en.heroTouched = true;
            stage.dirty = true;
          }
          try { ev.target.setPointerCapture && ev.target.setPointerCapture(ev.pointerId); } catch (e) {}
          ev.preventDefault();
        });

        window.addEventListener('pointermove', function (ev) {
          if (!active) return;
          const en = active.entry;
          if (!en) return;
          const dx = ev.clientX - lastX;
          lastX = ev.clientX;
          if (mode === 'turret') {
            let yaw = (en.turretYaw || 0) + dx * 0.012;
            if (yaw > TURRET_LIMIT) yaw = TURRET_LIMIT;
            if (yaw < -TURRET_LIMIT) yaw = -TURRET_LIMIT;
            en.turretYaw = yaw;
            applyTurret(en);
          } else {
            en.spin += dx * 0.016;
            /* apply immediately: a throttled or backgrounded tab may not run a
               rAF for a long time, and the reward has to turn AS the hand drags */
            if (en.spinGroup) en.spinGroup.rotation.y = en.spin;
          }
          stage.dirty = true;
        });

        const end = function () { active = null; stage.dragging = false; };
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);

        host.addEventListener('pointerover', function (ev) {
          const key = keyFrom(ev.target);
          if (!key) { stage.hoverSlot = -1; return; }
          for (let i = 0; i < stage.slots.length; i++) {
            if (stage.slots[i].key === key) { stage.hoverSlot = i; return; }
          }
        });
        host.addEventListener('pointerout', function (ev) {
          const to = ev.relatedTarget;
          if (to && keyFrom(to)) return;
          stage.hoverSlot = -1;
        });
      };

      stage.dispose = function () {
        stage.stop();
        Object.keys(stage.pool).forEach(function (id) {
          const en = stage.pool[id];
          try { stage.scene.remove(en.pivot); } catch (e) {}
          try { if (en.shadow) stage.scene.remove(en.shadow); } catch (e) {}
          try { if (en.tank && en.tank.dispose) en.tank.dispose(); } catch (e) {}
        });
        stage.pool = {};
        stage.slots = [];
        try {
          if (stage.renderer) {
            stage.renderer.dispose();
            if (stage.renderer.forceContextLoss) stage.renderer.forceContextLoss();
          }
        } catch (e) {}
        if (stage.canvas && stage.canvas.parentNode) stage.canvas.parentNode.removeChild(stage.canvas);
        stage.renderer = null;
        stage.canvas = null;
        stage.scene = null;
        stage.camera = null;
      };

      return stage;
    }

    return { create: create };
  })();

  /* The path's stage is a singleton: the overlay is opened and closed all
     session, and re-creating a renderer each time would burn context after
     context. The picker's stage is per-open and disposed on close. */
  let _pathStage = null;
  let _choiceStage = null;

  function pathStage() {
    const e = els();
    if (!e.path) return null;
    if (!_pathStage) _pathStage = Stage.create(e.path);
    _pathStage.bindDrag();
    /* Visible from the console (and to the QA driver) so a spin can be proved
       rather than assumed. Read-only use; nothing in the game depends on it. */
    try { Research._pathStage = _pathStage; } catch (err) {}
    return _pathStage;
  }

  /* --------------------------------------------------------------- rendering */

  const Research = {
    open: false,
    _active: 0,
    _choiceNode: null,

    /* ---------------------------------------------------------- public API */

    addXP: addXP,
    xpForBattle: xpForBattle,
    xpForMission: xpForMission,
    XP: XP,
    nodes: buildPath,

    openPanel() {
      const el = document.getElementById('research-overlay');
      if (!el || this.open) return;
      /* THE ENTRY WIPE. Arriving in the research menu plays the same
         white-square transition as the claim: squares cover (sharp), the
         path is BUILT underneath (so nothing pops in half-drawn during the
         reveal), then the rounded squares shrink away over the finished
         screen (Menu._tileWipe). Without a wipe it just opens. */
      const m = menu();
      const reveal = (function (r) {
        return function () {
          r.open = true;
          el.classList.remove('hidden');
          document.body.classList.add('rs-lock');
          /* Land on the line that has work in it, not always collection 1:
             after finishing a collection the path should open where the
             player IS. The selection follows the frontier on every open, so
             the inspector always starts on the step that can actually be
             researched instead of whatever was selected last session. */
          selectedStepId = null;
          selectedTankId = null;
          /* A fresh visit starts with the row unobstructed: no sheet, no pill. */
          closeTankSheet(false);
          hideStatsBtn();
          const nodes = buildPath();
          const f = frontier(nodes);
          if (f >= 0) {
            researchActive = nodes[f].ci;
          } else if (nodes.length) {
            researchActive = nodes[nodes.length - 1].ci;
          }
          render();
          startShadowTicker();
        };
      })(this);
      try { if (typeof Audio !== 'undefined' && Audio.click) Audio.click(); } catch (e) {}
      if (m && m._tileWipe) m._tileWipe(reveal);
      else reveal();
    },

    close() {
      if (!this.open) return;
      this.open = false;
      const el = document.getElementById('research-overlay');
      if (el) el.classList.add('hidden');
      closeHelp();
      closeChoice();
      /* false: leaving the workshop must not re-arm the pill over a tank that
         is about to be hidden with the whole overlay. */
      closeTankSheet(false);
      hideStatsBtn();
      stopShadowTicker();
      if (_pathStage) _pathStage.stop();
      document.body.classList.remove('rs-lock');
    },

    toggle() { if (this.open) this.close(); else this.openPanel(); },
  };

  /* Which collection's line is on screen. Kept outside the object so the
     render helpers can read it without `Research.` prefixes. */
  var researchActive = 0;

  /* The latest road/model measurement pass (see settleGeometry). The shared
     window-resize listener re-runs it so a viewport change re-aims both. */
  var _rsSettle = null;

  /* ------------------------------------------------------- the mystery clock

     "The Other One" is two black silhouettes stacked on the same pixels, and
     this is what trades them every three seconds. One timer for the whole
     screen, started when the workshop opens and cleared when it closes, so a
     closed workshop never leaves a callback running. */
  var _shadowTimer = 0;
  var _shadowSide = 0;

  function startShadowTicker() {
    if (_shadowTimer) return;
    _shadowTimer = setInterval(function () {
      if (!Research.open) { stopShadowTicker(); return; }
      const e = els();
      if (!e || !e.path) return;
      const groups = e.path.querySelectorAll('.rs-model-mystery');
      if (!groups.length) return;
      _shadowSide = 1 - _shadowSide;
      const st = _pathStage;
      groups.forEach(function (m) {
        const halves = m.querySelectorAll('[data-shadow]');
        for (let i = 0; i < halves.length; i++) {
          const hide = (i === _shadowSide);
          const el = halves[i];
          el.classList.toggle('rs-shadow-off', hide);
          if (st) {
            try { st.setSlotHidden(el.getAttribute('data-slot-key'), hide); } catch (err) {}
          }
        }
      });
    }, 3000);
  }

  function stopShadowTicker() {
    if (!_shadowTimer) return;
    clearInterval(_shadowTimer);
    _shadowTimer = 0;
  }

  function xpTotal() {
    const s = settings() || {};
    return Math.max(0, Math.round(s.researchXP || 0));
  }

  function els() {
    return {
      overlay: document.getElementById('research-overlay'),
      tabs: document.getElementById('research-tabs'),
      path: document.getElementById('research-path'),
      scroll: document.getElementById('research-scroll'),
      xp: document.getElementById('research-xp-total'),
      fill: document.getElementById('research-progress-fill'),
      hint: document.getElementById('research-hint'),
      choice: document.getElementById('research-choice'),
      choiceCards: document.getElementById('research-choice-cards'),
      choiceTitle: document.getElementById('research-choice-title'),
      badge: document.getElementById('rs-detail-badge'),
      detailName: document.getElementById('rs-detail-name'),
      detailTag: document.getElementById('rs-detail-tag'),
      detailState: document.getElementById('rs-detail-state'),
      detailDesc: document.getElementById('rs-detail-desc'),
      detailStats: document.getElementById('rs-detail-stats'),
      detailCost: document.getElementById('rs-detail-cost'),
      cta: document.getElementById('rs-detail-cta'),
      prev: document.getElementById('rs-prev'),
      next: document.getElementById('rs-next'),
      spinL: document.getElementById('rs-spin-l'),
      spinR: document.getElementById('rs-spin-r'),
      pose: document.getElementById('rs-pose'),
      help: document.getElementById('research-help'),
    };
  }

  /* ---------------------------------------------------------------- THE ROOM

     The foundry artwork is a picture of a hall that already has a floor. It is
     never edited: the models are placed to stand on the floor the picture
     draws, and the picture is POSITIONED until that floor line lands exactly
     under their feet. That is the whole illusion — real 3D models, the player's
     own background, one shared ground line.

     THE NUMBERS COME FROM THE ART. In foundry-bg.png (1920 x 1080) the floor
     seam — the full-width row where the hall's floor meets the dark front apron
     — is y = 883, so 0.8176 of the image height. The apron below it is empty,
     which is what makes it a good place for the names and prices.

     COVER FIRST, THEN FIT. The image starts at cover size and is then GROWN if
     the tanks' ground line needs to sit higher than cover allows (cover can
     only put the seam at 81.8% of the viewport). Growing crops the ceiling
     instead of leaving a gap, and the three constraints together guarantee
     that no edge of the screen is ever exposed. */
  const ROOM = { w: 1920, h: 1080, floor: 883 };

  function layoutRoom() {
    const img = document.getElementById('research-room');
    if (!img) return;
    const W = Math.max(1, window.innerWidth);
    const H = Math.max(1, window.innerHeight);

    /* The tanks' ground line, measured rather than assumed: the road line is
       drawn through the same points their feet rest on, and how far down the
       screen that is depends on the viewport, the model height knob and the
       footer. Reading it off the rendered rail is the only version that stays
       true when any of those change. */
    const e = els();
    /* THE FEET, not the road. The stage draws every tank with its tracks on the
       BOTTOM EDGE of its model slot (see Stage.place), so the line the artwork's
       floor must meet is that same edge. Measuring the rail instead put the
       picture's floor under the dots rather than under the tanks. */
    let groundY = 0;
    const slot = e.path ? e.path.querySelector('.rs-model-slot') : null;
    const rail = e.path ? (e.path.querySelector('.rs-rail') || e.path.querySelector('.rs-dot')) : null;
    if (slot) {
      const r = slot.getBoundingClientRect();
      if (r.bottom > 0) groundY = r.bottom;
    }
    if (!(groundY > 0) && rail) {
      const r = rail.getBoundingClientRect();
      if (r.top > 0) groundY = r.top + r.height / 2;
    }
    if (!(groundY > 0)) groundY = H * 0.8;

    const seam = ROOM.floor;
    /* COVER, then fit the seam to the feet. The apron constraint is CAPPED: it
       only exists to stop the photograph ending above the footer band, and asking
       it for the whole bottom of the screen is exactly what blew the layout up to
       2.4x and left a crop of bare wall on display. Once it asks for more than a
       quarter over cover, the footer's own dark band finishes the bottom instead. */
    const apron = (H - groundY) / (ROOM.h - seam);
    let s = Math.max(W / ROOM.w, H / ROOM.h);
    s = Math.max(s, groundY / seam, Math.min(apron, 1.25));
    const dw = ROOM.w * s;
    const dh = ROOM.h * s;
    img.style.width = dw.toFixed(1) + 'px';
    img.style.height = dh.toFixed(1) + 'px';
    img.style.left = ((W - dw) / 2).toFixed(1) + 'px';
    img.style.top = (groundY - seam * s).toFixed(1) + 'px';
  }

  function nodeLabel(node, nodes, opts, st) {
    const claimed = claimOf(node);
    if (claimed) { const d = tankDef(claimed); return d ? d.name : claimed; }
    if (node.soon) return node.cands[0] ? node.cands[0].name : 'Coming Soon';
    if (node.kind === 'follow' && resolvedOptions(node, nodes).length > 1) return 'THE OTHER ONE';
    /* "CHOOSE ONE" only while there really is a choice: once every candidate
       but one is already in the garage, the step is that tank. */
    const left = opts.filter(function (o) { return !isOwned(o.id); });
    if (left.length === 1) return left[0].name;
    if (opts.length === 1) return opts[0].name;
    return 'CHOOSE ONE';
  }

  /* The little XP art tile next to a price. The artwork already reads "XP",
     so no extra word is needed. */
  function ico() {
    return '<img class="rs-xp-ico-mini" src="assets/ui/xp.webp" alt="XP" draggable="false">';
  }

  function costLabel(node, st) {
    if (st === 'claimed') return 'UNLOCKED';
    if (node.soon) return 'SOON';
    return node.cost + ico();
  }

  /* Jump anchors, not filters. The path itself is ONE continuous line; these
     pills scroll the player to a collection's segment and report how far into
     that line they are. */
  function renderTabs(nodes) {
    const e = els();
    if (!e.tabs) return;
    const cols = collections();
    let html = '';
    cols.forEach(function (col, ci) {
      const lineNodes = nodes.filter(function (n) { return n.ci === ci; });
      const done = lineNodes.filter(function (n) { return claimOf(n) || n.soon; }).length;
      const isNext = lineNodes.some(function (n) { return stateOf(n, nodes) === 'next'; });
      html += '<button type="button" class="rs-tab' + (ci === researchActive ? ' active' : '') +
        (isNext ? ' has-next' : '') + '" data-col="' + ci + '">' +
        '<span class="rs-tab-num">' + (col.id != null ? col.id : ci + 1) + '</span>' +
        '<span class="rs-tab-name">Collection</span>' +
        '<span class="rs-tab-count">' + done + '/' + lineNodes.length + '</span>' +
        '</button>';
    });
    e.tabs.innerHTML = html;
  }

  /* Which collection's segment is centred on the scrollbar right now. Cheap:
     it reads offsetLeft off the already-rendered nodes. */
  function updateJumpActive() {
    const e = els();
    if (!e.tabs || !e.scroll || !e.path) return;
    const nodeEls = e.path.querySelectorAll('.rs-node');
    const center = e.scroll.scrollLeft + e.scroll.clientWidth / 2;
    let active = 0;
    nodeEls.forEach(function (el) {
      const mid = el.offsetLeft + el.offsetWidth / 2;
      if (mid <= center) active = parseInt(el.getAttribute('data-ci'), 10) || 0;
    });
    if (active !== researchActive) {
      researchActive = active;
      e.tabs.querySelectorAll('.rs-tab').forEach(function (btn) {
        btn.classList.toggle('active', (parseInt(btn.getAttribute('data-col'), 10) || 0) === active);
      });
    }
  }

  function renderPath(nodes) {
    const e = els();
    if (!e.path) return;

    if (!nodes.length) {
      e.path.innerHTML = '<div class="rs-empty">No research line yet.</div>';
      return;
    }

    /* ALL Collections, ONE road. Nodes are emitted in play order and a small
       numbered diamond rides on the road where each new collection's line
       starts, so the path never breaks and never loses its wayfinding. */
    let html = '';
    let lastCi = -1;
    nodes.forEach(function (node) {
      if (node.ci !== lastCi) {
        if (lastCi >= 0) {
          const cols = collections();
          const col = cols[node.ci] || {};
          const num = col.id != null ? col.id : node.ci + 1;
          html += '<div class="rs-divider" aria-hidden="true"><i><b>' + num + '</b></i></div>';
        }
        lastCi = node.ci;
      }

      const st = stateOf(node, nodes);
      const opts = resolvedOptions(node, nodes);

      const owned = opts.filter(function (o) { return isOwned(o.id); });
      const payable = opts.filter(function (o) { return !isOwned(o.id); });

      /* THE REWARD, AS A MODEL. A two-tank step shows BOTH tanks side by side
         with an OR between them, because that is the decision being made; a
         single step shows one; a coming-soon step shows a dashed place marker
         instead of pretending it has a tank. */
      /* A follow-up step before its pair has been chosen is literally "the one
         you did not take", so drawing both tanks again would just repeat step
         1 a second time. It stays a place marker until the choice resolves it,
         then shows the leftover tank on its own. */
      const unresolvedFollow = node.kind === 'follow' && opts.length > 1;
      const taken = claimOf(node);

      /* A claimed step shows THE TANK YOU TOOK, not whichever one is left over.
         After taking Cool Buddy, step 1 still had Ark payable and rendered Ark --
         the same model step 2 was about to reveal, twice on one line. */
      const show = node.soon ? [] : taken
        ? [opts.filter(function (o) { return o.id === taken; })[0] || { id: taken, name: nodeLabel(node, nodes, opts, st) }]
        : unresolvedFollow ? []
        : (node.kind === 'pair' && payable.length > 1)
          ? [payable[0], payable[1]]
          : [payable[0] || owned[0] || null];

      /* Slot keys are unique per node+half; the stage pools models by this key,
         never by tank id (the same tank can sit on two steps at once). */
      const slotKey = function (i) { return node.id + ':' + i; };

      let modelHtml = '';
      if (unresolvedFollow && opts.length > 1) {
        /* THE OTHER ONE, AS A SHADOW.

           This step is literally "whichever tank you did not take", so naming
           either model here would give the answer away (or repeat step 1). It
           used to be a dashed place marker, which said nothing at all. It is a
           black silhouette now: the two candidate models are both mounted on
           the same pixels, only one is visible at a time, and they trade
           places every three seconds -- close enough to read the shape, dark
           enough to keep the secret. The big ? over it is the label. */
        modelHtml =
          '<div class="rs-model rs-model-mystery">' +
            '<div class="rs-model-slot rs-shadow-slot" data-shadow="1" data-slot-key="' + slotKey(0) + '" data-slot-tank="' + opts[0].id + '"></div>' +
            '<div class="rs-model-slot rs-shadow-slot rs-shadow-off" data-shadow="1" data-slot-key="' + slotKey(1) + '" data-slot-tank="' + opts[1].id + '"></div>' +
            '<span class="rs-mystery-q" aria-hidden="true">?</span>' +
          '</div>';
      } else if (node.soon || !show[0]) {
        modelHtml = '<div class="rs-model rs-model-empty"><span class="rs-soon-mark"><i>?</i></span></div>';
      } else if (show.length === 2 && show[1]) {
        modelHtml =
          '<div class="rs-model rs-model-pair">' +
            '<div class="rs-model-slot" data-slot-key="' + slotKey(0) + '" data-slot-tank="' + show[0].id + '"><span class="rs-ring"></span></div>' +
            '<span class="rs-or"><i>OR</i></span>' +
            '<div class="rs-model-slot" data-slot-key="' + slotKey(1) + '" data-slot-tank="' + show[1].id + '"><span class="rs-ring"></span></div>' +
          '</div>';
      } else {
        modelHtml =
          '<div class="rs-model"><div class="rs-model-slot" data-slot-key="' + slotKey(0) + '" data-slot-tank="' + show[0].id + '">' +
            '<span class="rs-ring"></span>' +
          '</div></div>';
      }

      const tier = (function () {
        const one = opts[0];
        return one && one.tier ? '<span class="rs-tier">T' + one.tier + '</span>' : '';
      })();

      html +=
        '<div class="rs-node ' + st + (node.kind === 'pair' ? ' rs-node-pair' : '') +
          (node.id === selectedStepId ? ' selected' : '') +
          '" data-node="' + node.id + '" data-ci="' + node.ci + '">' +
          modelHtml +
          '<span class="rs-tick"></span>' +
          '<div class="rs-dot"></div>' +
          '<div class="rs-label">' + nodeLabel(node, nodes, opts, st) + '</div>' +
          '<div class="rs-cost">' + costLabel(node, st) + tier + '</div>' +
        '</div>';
    });

    e.path.innerHTML = html;

    /* The road: one board from the FIRST dot to the LAST dot, across every
       collection. The gold fill is the share of the whole line researched. */
    const rail = document.createElement('div');
    rail.className = 'rs-rail';
    rail.innerHTML = '<div class="rs-rail-fill"></div>';
    e.path.insertBefore(rail, e.path.firstChild);

    /* MEASURED, not derived. offsetLeft is relative to the nearest positioned
       ancestor, and every .rs-node is position:relative -- so a dot's
       offsetLeft is its offset inside its NODE, not inside the path. Reading
       rects and subtracting the path's own rect is the only version that
       cannot silently produce a zero-width rail.

       MEASURED TWICE, though. render() can be invoked while the overlay is
       still display:none, and a hidden measurement returns NOTHING BUT ZEROS:
       x1 = 0 and pRect.width - x2 = 0, which pins the road edge-to-edge for
       the whole session. The measurement therefore runs as a settle function:
       once right here for the first painted frame, then two animation frames
       later (first real layout) and once more on a short backstop + font
       load, by which time the overlay is on screen and layout is final. A
       pass bails when its rail no longer belongs to the DOM (a newer render
       has rebuilt the path), so a stale pass can never fight a fresh one. */
    const stage = pathStage();

    const settleGeometry = function () {
      if (!rail.isConnected || !e.path.isConnected) return false;
      const pRect = e.path.getBoundingClientRect();
      if (pRect.width < 2) return false;   /* overlay still display:none */

      const dots = e.path.querySelectorAll('.rs-dot');
      if (dots.length) {
        const first = dots[0].getBoundingClientRect();
        const last = dots[dots.length - 1].getBoundingClientRect();
        const x1 = first.left + first.width / 2 - pRect.left;
        const x2 = last.left + last.width / 2 - pRect.left;
        rail.style.left = x1.toFixed(1) + 'px';
        rail.style.right = Math.max(0, pRect.width - x2).toFixed(1) + 'px';
        rail.style.top = (first.top + first.height / 2 - pRect.top).toFixed(1) + 'px';
        const fill = rail.querySelector('.rs-rail-fill');
        if (fill) {
          const f = frontier(nodes);
          const pct = f >= 0 ? Math.min(100, Math.max(0, f / Math.max(1, nodes.length) * 100)) : 100;
          fill.style.width = pct.toFixed(1) + '%';
        }
      }

      /* THE MODELS' ADDRESSES, in the same page space as the road: the pixel
         centre of every tank's drag area. offsetLeft cannot be summed down
         the tree here: it is relative to the nearest POSITIONED ancestor, and
         .rs-model-slot and .rs-model are both positioned, so the inner term
         is always 0 and the centring offset of .rs-model inside a wider node
         was silently dropped. Rects cannot make that mistake. */
      if (stage) {
        stage.mount();
        const slots = [];
        e.path.querySelectorAll('.rs-node').forEach(function (nodeEl) {
          nodeEl.querySelectorAll('.rs-model-slot').forEach(function (area) {
            const r = area.getBoundingClientRect();
            /* X IS THE CENTRE, Y IS THE TOP.

               Stage.place() centres a tank on slot.x and stands it on the
               BOTTOM edge of slot.y..slot.y+slot.h, so it needs one coordinate
               from each system. Handing it the rect's centre for both put every
               model half a box too low — the tanks floated a hundred pixels
               under their own road — and it also made the models and the labels
               disagree about where the step was. */
            slots.push({
              key: area.getAttribute('data-slot-key'),
              id: area.getAttribute('data-slot-tank'),
              shadow: area.getAttribute('data-shadow') === '1',
              hidden: area.classList.contains('rs-shadow-off'),
              x: r.left + r.width / 2 - pRect.left,
              y: r.top - pRect.top,
              /* a little air around each model so neighbouring tanks never
                 touch, and pairs stay clearly separated by the OR. Height is
                 kept whole: the bottom edge IS the ground line, and trimming
                 it here would float every tank 8% of its box off the floor. */
              w: r.width * 0.86,
              h: r.height,
            });
          });
        });
        stage.setViewport(e.scroll ? e.scroll.scrollLeft : 0, e.scroll ? e.scroll.clientWidth : 1200);
        stage.setSlots(slots);
        /* LAST, and for a reason: setSlots() can change the row's width (a
           two-tank step is wider than a single one), and the canvas has to be
           sized from the FINAL box or every model is drawn offset from its
           label by however much the row grew. */
        stage.layout();
        if (Research.open) stage.start();
      }

      /* The room follows the row: the same pass that decides where the tanks
         stand moves the artwork until its floor is under them. It runs after
         `stage` placement so the rail it measures is final. */
      layoutRoom();
      return true;
    };
    _rsSettle = settleGeometry;
    settleGeometry();

    /* The settle-backstop: two animation frames (first painted layout), then
       a timer, then font load. Each may re-run; once geometry is final the
       passes are no-ops that only rewrite the same numbers. */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { settleGeometry(); });
    });
    setTimeout(settleGeometry, 500);
    try {
      if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
        document.fonts.ready.then(settleGeometry, function () {});
      }
    } catch (err) {}

    /* One window-resize hook shared by every render: the row's node sizes are
       vw-clamped, so a viewport change re-aims both the road and the models. */
    if (!e.path._rsResizeBound) {
      e.path._rsResizeBound = true;
      let lastW = window.innerWidth;
      let hz = 0;
      window.addEventListener('resize', function () {
        if (window.innerWidth === lastW) return;
        lastW = window.innerWidth;
        if (hz) cancelAnimationFrame(hz);
        hz = requestAnimationFrame(function () {
          hz = 0;
          if (Research.open && _rsSettle) _rsSettle();
        });
      });
    }

    /* The drafting caption above the row, now about the WHOLE line: how many
       real steps it holds, what the whole line costs, how far along it runs. */
    const sheet = document.getElementById('research-sheet');
    if (sheet) {
      const steps = nodes.filter(function (n) { return !n.soon; }).length;
      const totalCost = nodes.reduce(function (a, n) { return a + (n.soon ? 0 : (n.cost || 0)); }, 0);
      const f = frontier(nodes);
      const done = f >= 0 ? nodes.slice(0, f).filter(function (n) { return !n.soon; }).length : steps;
      sheet.innerHTML =
        '<b>\u25c6</b>' + steps + ' step' + (steps === 1 ? '' : 's') +
        '<b>\u25c6</b>' + totalCost.toLocaleString('en-US') + ' XP line' +
        '<s>' + done + '/' + steps + ' researched</s>';
    }

    /* Keep the player's current step in view when the panel opens. */
    if (e.scroll) {
      const cur = e.path.querySelector('.rs-node.next') || e.path.querySelector('.rs-node.claimed:last-of-type');
      if (cur) {
        const target = Math.max(0, cur.offsetLeft - e.scroll.clientWidth / 2 + cur.offsetWidth / 2);
        e.scroll.scrollLeft = target;
      } else {
        e.scroll.scrollLeft = 0;
      }
      updateJumpActive();
    }
  }

  /* ------------------------------------------------------------- inspector

     SELECTING IS FREE; RESEARCHING COSTS. Before this, a click anywhere on a
     step spent XP immediately and there was nothing on screen describing what
     the XP bought. The path now only ever SELECTS a step, and the inspector's
     single gold button is the only thing that can spend. That also gives the
     3D controls a home: the arrow and rotate buttons live next to the CTA
     instead of being hidden gestures nobody finds.

     `selectedStepId` is a node id (cNnM), not a tank: a two-tank step is one
     step. `selectedTankId` is set only when the player clicked a specific
     MODEL on such a step, which lets the CTA research that tank directly
     instead of opening the choice screen. */
  var selectedStepId = null;
  var selectedTankId = null;
  var _helpOpen = false;
  var _detailAction = null;
  /* The node the STATS pill is currently pointing at (null: nothing armed), and
     the pending frame of its scroll re-aim. */
  var _statsNodeId = null;
  var _statsRaf = 0;
  /* The model the pill hangs over, when the player clicked one half of a pair.
     A node holding two tanks is wide; aiming at its centre would float the
     button between them instead of over the tank that was actually tapped. */
  var _statsAnchor = null;

  function ensureSelection(nodes) {
    let node = null;
    for (let i = 0; i < nodes.length; i++) if (nodes[i].id === selectedStepId) { node = nodes[i]; break; }
    if (!node) {
      const f = frontier(nodes);
      node = f >= 0 ? nodes[f] : (nodes[nodes.length - 1] || null);
      selectedStepId = node ? node.id : null;
      selectedTankId = null;
    }
    if (node && selectedTankId) {
      const opts = resolvedOptions(node, nodes);
      if (!opts.some(function (o) { return o.id === selectedTankId; })) selectedTankId = null;
    }
    return node;
  }

  /* One short word for what the tank DOES, so the panel answers "which one
     should I take" before the stats do. */
  function titleCase(s) {
    return String(s || '').replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  function roleTag(def) {
    if (!def) return '';
    const shell = def.shellType ? String(def.shellType).toLowerCase() : '';
    const map = {
      shell: 'Cannon', flame: 'Flamethrower', rail: 'Railgun', he: 'HE Shells',
      ap: 'AP Shells', shotgun: 'Shotgun', mortar: 'Mortar', mg: 'Machine Gun',
      rocket: 'Rockets', vortex_mine: 'Vortex Mines',
    };
    if (map[shell]) return map[shell];
    if (def.superType) return titleCase(def.superType);
    return 'Tier ' + (def.tier || 1) + ' Tank';
  }

  function statRow(label, value, max) {
    const v = Math.max(0, Math.round(Number(value) || 0));
    const pct = Math.max(4, Math.min(100, Math.round(v / max * 100)));
    return '<div class="rs-stat"><span>' + label + '</span>' +
      '<i><b style="--v:' + pct + '%"></b></i><em>' + v + '</em></div>';
  }

  function armorOf(def) {
    if (!def || !def.armor) return 0;
    return Math.max(def.armor.front || 0, def.armor.sides || 0, def.armor.back || 0);
  }

  function renderDetail(nodes) {
    const e = els();
    if (!e.detailName) return;
    nodes = nodes || buildPath();
    const node = ensureSelection(nodes);
    if (!node) {
      e.detailName.textContent = 'No steps yet';
      e.detailDesc.textContent = 'New tanks will appear here as the workshop expands.';
      e.detailStats.innerHTML = '';
      e.cta.disabled = true;
      e.cta.textContent = 'COMING SOON';
      _detailAction = null;
      return;
    }

    const st = stateOf(node, nodes);
    const claimedId = claimOf(node);
    const opts = resolvedOptions(node, nodes);
    const payable = opts.filter(function (o) { return !isOwned(o.id); });
    let def = null;
    if (claimedId) def = tankDef(claimedId);
    else if (selectedTankId) def = tankDef(selectedTankId);
    else if (opts.length && opts[0]) def = tankDef(opts[0].id);

    const mystery = (node.kind === 'follow' && !claimedId && st === 'locked');
    const pairChoice = (node.kind === 'pair' && !claimedId && payable.length > 1 && !selectedTankId);
    const have = xpTotal();

    /* -- identity ------------------------------------------------------- */
    if (e.badge) e.badge.textContent = def && def.tier ? 'T' + def.tier : (node.soon ? '?' : 'T1');
    e.detailName.textContent = node.soon ? 'Coming Soon'
      : mystery ? 'The Other One'
      : (def && def.name) || nodeLabel(node, nodes, opts, st);
    if (e.detailTag) e.detailTag.textContent = node.soon ? 'Signpost' : mystery ? 'Pair reward' : roleTag(def);

    /* -- plain-language description -------------------------------------- */
    let desc = node.soon
      ? 'A signpost on the line. Nothing to research here — the path carries on past it.'
      : mystery
        ? 'This step reveals whichever tank your previous pick did not take. Finish the step before it to see the name.'
        : def && def.desc ? def.desc
        : 'A step on the research line.';
    if (pairChoice) desc = 'Two tanks share this step. Click either model to pick it, then research. ' + desc;
    e.detailDesc.textContent = desc;

    /* -- stats ---------------------------------------------------------- */
    e.detailStats.innerHTML = def
      ? statRow('Armor', armorOf(def), 160) +
        statRow('Firepower', def.damage, 70) +
        statRow('Speed', def.speed, 40)
      : '';

    /* -- price and state ------------------------------------------------ */
    if (e.detailCost) {
      e.detailCost.innerHTML = claimedId ? 'PAID'
        : node.cost ? node.cost + '<img src="assets/ui/xp.webp" alt="XP" draggable="false">'
        : 'FREE';
    }
    if (e.detailState) {
      let txt = '';
      let cls = '';
      if (st === 'claimed') txt = 'Researched';
      else if (node.soon) txt = 'Coming soon';
      else if (st === 'next') {
        if (have >= node.cost) { txt = 'Ready to research'; cls = 'is-ready'; }
        else { txt = 'Need ' + (node.cost - have) + ' more XP'; cls = 'is-short'; }
      } else txt = 'Locked';
      e.detailState.textContent = txt;
      e.detailState.className = 'rs-detail-state' + (cls ? ' ' + cls : '');
    }

    /* -- the one button ------------------------------------------------- */
    let label = 'RESEARCH';
    let disabled = false;
    let ghost = false;
    let action = null;
    if (st === 'claimed') {
      label = 'VIEW IN GARAGE';
      ghost = true;
      action = function () { openGarage(claimedId); };
    } else if (node.soon) {
      label = 'COMING SOON';
      disabled = true;
    } else if (st === 'locked') {
      label = mystery ? 'FINISH THE PREVIOUS STEP' : 'RESEARCH EARLIER STEPS';
      disabled = true;
    } else {
      if (!payable.length) {
        label = 'CLEAR STEP';
        action = function () { claim(node.id, null); };
      } else if (pairChoice) {
        label = 'CHOOSE ONE — ' + node.cost + ' XP';
        action = function () { claim(node.id, null); };
      } else {
        label = 'RESEARCH — ' + node.cost + ' XP';
        action = function () { claim(node.id, selectedTankId || null); };
      }
      if (have < node.cost) {
        label = 'NEED ' + (node.cost - have) + ' MORE XP';
        disabled = true;
        action = null;
      }
    }
    _detailAction = action;
    if (e.cta) {
      e.cta.disabled = disabled;
      e.cta.classList.toggle('is-ghost', !!ghost);
      e.cta.textContent = label;
    }

    /* -- the controls --------------------------------------------------- */
    const i = nodes.indexOf(node);
    if (e.prev) e.prev.disabled = i <= 0;
    if (e.next) e.next.disabled = i >= nodes.length - 1;
    const noModel = !def || node.soon;
    if (e.spinL) e.spinL.disabled = noModel;
    if (e.spinR) e.spinR.disabled = noModel;
    if (e.pose) e.pose.disabled = noModel;
  }

  /* ------------------------------------------------------------- the pill

     THE STATS BUTTON IS THE ONLY DOOR INTO THE SHEET.

     The inspector used to be a permanent band under the row: it took a slice
     of the shop on every visit for every player, and it described whatever
     step happened to be selected rather than the one you were looking at. It
     is now a question you ask about a specific tank -- click the tank and a
     small pill pops up over it, press that and the sheet opens.

     The pill lives in the overlay, not in the node, for two reasons: the node
     is inside a scrolling band with `overflow-y:hidden`, which would clip a
     button drawn above a tank's turret, and a fixed pill can be re-aimed from
     a measurement instead of being rebuilt by every renderPath(). */
  function statsParts() {
    return {
      pill: document.getElementById('rs-stats-btn'),
      tank: document.getElementById('research-tank'),
    };
  }

  function tankSheetOpen() {
    const p = statsParts();
    return !!(p.tank && !p.tank.classList.contains('hidden'));
  }

  function placeStatsBtn() {
    const p = statsParts();
    const e = els();
    if (!p.pill || !_statsNodeId || !e.path || !e.scroll) return;
    const node = e.path.querySelector('.rs-node[data-node="' + _statsNodeId + '"]');
    if (!node) { hideStatsBtn(); return; }

    /* The clicked model if it is still in the DOM (a re-render detaches it and
       this falls back to the whole step), else the step itself. */
    const anchor = (_statsAnchor && _statsAnchor.isConnected) ? _statsAnchor : node;
    const r = anchor.getBoundingClientRect();
    const band = e.scroll.getBoundingClientRect();
    const cx = r.left + r.width / 2;

    /* Scrolled clean out of the band: the pill would be pointing at a
       neighbouring collection's tanks. Fade it out rather than leave a lie
       on screen; it comes back when its own step scrolls into view. */
    if (cx < band.left - 8 || cx > band.right + 8) {
      p.pill.classList.remove('in');
      return;
    }

    /* offsetWidth/Height are readable only because showStatsBtn() un-hides the
       pill BEFORE measuring; a display:none element reports 0 and every clamp
       below would collapse to the same corner. */
    const half = p.pill.offsetWidth / 2;
    const h = p.pill.offsetHeight;
    const pad = 10;
    /* Above the tank it belongs to: models grow UP from the road, so the node's
       own top edge is the top of the turret and the nub hangs into it. When
       that would push the pill into the header, the band's top is the floor. */
    const y = Math.max(band.top + h + pad, r.top - 8);
    const x = Math.min(Math.max(cx, half + pad), window.innerWidth - half - pad);
    p.pill.style.left = x.toFixed(1) + 'px';
    p.pill.style.top = y.toFixed(1) + 'px';
    p.pill.classList.add('in');
  }

  function showStatsBtn(nodeId, anchor) {
    const p = statsParts();
    if (!p.pill) return;
    if (!nodeId || tankSheetOpen()) { hideStatsBtn(); return; }
    _statsNodeId = nodeId;
    _statsAnchor = anchor || null;
    p.pill.hidden = false;
    p.pill.classList.remove('in');
    /* Force a reflow, so the pop replays on every newly clicked tank rather
       than only on the first one. */
    void p.pill.offsetWidth;
    placeStatsBtn();
  }

  function hideStatsBtn() {
    const p = statsParts();
    _statsNodeId = null;
    _statsAnchor = null;
    if (!p.pill) return;
    p.pill.classList.remove('in');
    p.pill.hidden = true;
  }

  /* Open the sheet on the armed tank. The card is repainted first: the pill can
     outlive a re-render (a claim elsewhere, a tab switch), and the sheet must
     never show the previous tank's numbers. */
  function openTankSheet() {
    const p = statsParts();
    if (!p.tank) return;
    /* The footer's Research button can open the sheet without a tank having
       been clicked first: arm it on the step the line is standing on. */
    if (!_statsNodeId) {
      const n = ensureSelection(buildPath());
      if (n) _statsNodeId = n.id;
    }
    if (!_statsNodeId) return;
    renderDetail(buildPath());
    p.tank.classList.remove('hidden');
    hideStatsBtn();
    try { if (typeof Audio !== 'undefined' && Audio.click) Audio.click(); } catch (e) {}
    setTimeout(function () {
      const x = document.getElementById('rs-stats-close');
      if (x) { try { x.focus({ preventScroll: true }); } catch (err) { try { x.focus(); } catch (e2) {} } }
    }, 30);
  }

  /* Closing re-arms the pill over the tank that was open, so the button is
     exactly where the thumb left it and a mis-tap costs one tap to undo. */
  function closeTankSheet(reshow) {
    const p = statsParts();
    if (!p.tank || p.tank.classList.contains('hidden')) return;
    p.tank.classList.add('hidden');
    if (reshow !== false && selectedStepId) showStatsBtn(selectedStepId);
  }

  /* Select a step (and optionally one tank on it) without spending anything. */
  function selectStep(nodeId, tankId, scroll, anchor) {
    const nodes = buildPath();
    const node = nodes.filter(function (n) { return n.id === nodeId; })[0];
    if (!node) return;
    selectedStepId = node.id;
    selectedTankId = tankId || null;
    const e = els();
    if (e.path) {
      e.path.querySelectorAll('.rs-node').forEach(function (el) {
        el.classList.toggle('selected', el.getAttribute('data-node') === node.id);
      });
    }
    renderDetail(nodes);
    /* Selecting is what ARMS the pill; it never opens anything. */
    showStatsBtn(node.id, anchor);
    if (scroll !== false && e.scroll && e.path) {
      const el = e.path.querySelector('.rs-node[data-node="' + node.id + '"]');
      if (el) {
        const to = Math.max(0, el.offsetLeft - e.scroll.clientWidth / 2 + el.offsetWidth / 2);
        if (e.scroll.scrollTo) e.scroll.scrollTo({ left: to, behavior: 'smooth' });
        else e.scroll.scrollLeft = to;
      }
    }
  }

  /* Walk the line one step at a time (arrow keys and the inspector arrows). */
  function stepBy(delta) {
    const nodes = buildPath();
    if (!nodes.length) return;
    const node = ensureSelection(nodes);
    let i = node ? nodes.indexOf(node) : -1;
    if (i < 0) i = 0;
    const to = nodes[Math.max(0, Math.min(nodes.length - 1, i + (delta < 0 ? -1 : 1)))];
    if (to) selectStep(to.id, null, true);
  }

  function openHelp() {
    const el = document.getElementById('research-help');
    if (!el) return;
    /* The guide covers the row, so a pill over a tank underneath it would be a
       floating artefact. It comes back when the guide closes. */
    hideStatsBtn();
    el.classList.remove('hidden');
    _helpOpen = true;
    try { if (typeof Audio !== 'undefined' && Audio.click) Audio.click(); } catch (e) {}
    /* focus the way out, so Escape/Tab land somewhere sensible */
    setTimeout(function () {
      const x = document.getElementById('research-help-close');
      if (x) { try { x.focus(); } catch (err) {} }
    }, 30);
  }

  function closeHelp() {
    const el = document.getElementById('research-help');
    if (el) el.classList.add('hidden');
    _helpOpen = false;
    const back = document.getElementById('research-help-open');
    if (back) { try { back.focus(); } catch (e) {} }
    if (selectedStepId && !tankSheetOpen()) showStatsBtn(selectedStepId);
  }

  function openGarage(id) {
    if (!id) return;
    const m = menu();
    Research.close();
    setTimeout(function () {
      try { if (m && m.show) m.show('menu-tank'); } catch (e) {}
      try { if (window.TankMenu && TankMenu.show) TankMenu.show(id); } catch (e) {}
    }, 140);
  }

  /* THE PILL'S REAL DESTINATION: the tank's own menu.

     Returns false when the step has no tank to open (a signpost, or "the other
     one" before its pair is chosen), so the caller can fall back to the sheet. */
  function openTankMenuFor(nodeId) {
    const nodes = buildPath();
    const node = nodeId
      ? nodes.filter(function (n) { return n.id === nodeId; })[0]
      : null;
    if (!node) return false;
    const opts = resolvedOptions(node, nodes);
    const id = selectedTankId || (opts[0] && opts[0].id);
    if (!id) return false;
    if (typeof TANKS === 'undefined' || !TANKS[id]) return false;
    openGarage(id);
    return true;
  }

  function render() {
    const e = els();
    if (!e.overlay) return;
    const nodes = buildPath();
    if (researchActive >= collections().length) researchActive = Math.max(0, collections().length - 1);
    ensureSelection(nodes);

    if (e.xp) e.xp.textContent = xpTotal().toLocaleString('en-US');

    const claimable = nodes.filter(function (n) { return stateOf(n, nodes) === 'next'; });
    if (e.fill) {
      const done = nodes.filter(function (n) { return claimOf(n) || n.soon; }).length;
      e.fill.style.width = (nodes.length ? (done / nodes.length * 100) : 0).toFixed(1) + '%';
    }
    if (e.hint) {
      if (!nodes.length) {
        e.hint.textContent = 'No research line yet.';
      } else if (!claimable.length) {
        e.hint.textContent = 'Every tank on the research path is unlocked. New collections will extend it.';
      } else {
        const n = claimable[0];
        const need = Math.max(0, n.cost - xpTotal());
        e.hint.textContent = need > 0
          ? 'Next: ' + n.cost + ' XP — ' + need + ' to go'
          : 'Next step is ready to research!';
      }
    }

    renderTabs(nodes);
    renderPath(nodes);
    renderDetail(nodes);

    /* renderPath() rebuilds every node element, so the pill's anchor is a new
       DOM node after each render and has to be re-aimed -- or retired when the
       step it pointed at no longer exists (a consumed step, a tab switch). */
    if (_statsNodeId) {
      const alive = nodes.some(function (n) { return n.id === _statsNodeId; });
      if (alive && !tankSheetOpen()) requestAnimationFrame(placeStatsBtn);
      else hideStatsBtn();
    }
  }

  /* ---------------------------------------------------------------- claiming */

  /* Claim a step. `chosenId` is only meaningful for a two-tank step; a step
     with a single payable tank claims itself. */
  function claim(nodeId, chosenId) {
    const nodes = buildPath();
    const node = nodes.filter(function (n) { return n.id === nodeId; })[0];
    if (!node) return false;
    if (node.soon) { toast('Coming soon — the path moves past this step'); return false; }
    if (claimOf(node)) { toast('Already researched'); return false; }
    const f = frontier(nodes);
    if (f < 0 || nodes[f] !== node) { toast('Research the earlier tanks first'); return false; }

    const opts = resolvedOptions(node, nodes);
    const payable = opts.filter(function (o) { return !isOwned(o.id); });

    /* Nothing left to pay out: every candidate is already in the garage. The
       step is marked done for free rather than charging XP for a tank the
       player already owns. */
    if (!payable.length) {
      const s = settings();
      if (!s) return false;
      s.researchClaimed = s.researchClaimed || {};
      s.researchClaimed[node.id] = opts.length ? opts[0].id : 'owned';
      persist();
      toast('Already in your garage — step cleared');
      render();
      updateBadge();
      return true;
    }

    let pick = null;
    if (chosenId) pick = payable.filter(function (o) { return o.id === chosenId; })[0] || null;
    else if (payable.length === 1) pick = payable[0];

    if (!pick) { openChoice(node, payable); return false; }

    const s = settings();
    if (!s) return false;
    const have = Math.max(0, Math.round(s.researchXP || 0));
    if (have < node.cost) {
      toast('Need ' + (node.cost - have) + ' more Research XP');
      return false;
    }

    s.researchXP = have - node.cost;
    s.researchClaimed = s.researchClaimed || {};
    s.researchClaimed[node.id] = pick.id;
    if (node.kind === 'pair' || node.kind === 'follow') {
      s.researchChoice = s.researchChoice || {};
      s.researchChoice[node.id] = pick.id;
    }
    const list = Array.isArray(s.unlockedTanks) ? s.unlockedTanks.slice() : [];
    if (list.indexOf(pick.id) < 0) list.push(pick.id);
    s.unlockedTanks = list;

    persist();
    toast(pick.name + ' unlocked!');

    /* THE CLAIM WIPE. Researching a tank -- straight from the path click or
       from the two-tank picker -- is the moment the screen changes meaning,
       so it plays the white-square transition: squares cover (sharp), the
       unlocked line re-renders underneath, then the rounded squares shrink
       away over it (Menu._tileWipe). With no wipe available (or reduced
       motion) it just re-renders instantly. The garage/roster refresh stays
       outside the callback so the save lands immediately. */
    const m = menu();
    try { if (m && m._renderCollections) m._renderCollections(); } catch (e) {}
    const finish = function () {
      const e = els();
      const nodeEl = e.path && e.path.querySelector('.rs-node[data-node="' + node.id + '"]');
      if (nodeEl) burst(nodeEl);
      try { if (typeof Audio !== 'undefined' && Audio.click) Audio.click(); } catch (err) {}
      render();
      updateBadge();
    };
    if (m && m._tileWipe) m._tileWipe(finish);
    else finish();
    return true;
  }

  /* Two-tank step: both models, live and spinable, above their own names. No
     cards — the choice is the tank and the word, nothing else. */
  function openChoice(node, options) {
    const e = els();
    if (!e.choice || !e.choiceCards) { claim(node.id, options[0] && options[0].id); return; }
    Research._choiceNode = node.id;
    if (e.choiceTitle) e.choiceTitle.textContent = 'CHOOSE YOUR REWARD';

    let html = '';
    options.forEach(function (o) {
      const def = tankDef(o.id);
      html += '<button type="button" class="rs-pick" data-pick="' + o.id + '">' +
        '<span class="rs-pick-name">' + o.name + '</span>' +
        '<span class="rs-pick-meta">' + (def ? ('TIER ' + (def.tier || 1) + ' \u00b7 ' + Math.round(def.speed || 0) + ' SPEED') : '') + '</span>' +
        '<span class="rs-pick-cta">RESEARCH</span>' +
        '</button>';
    });
    e.choiceCards.innerHTML = html;

    const host = document.getElementById('research-choice-stage');
    if (host) {
      host.innerHTML = options.map(function (o) {
        return '<div class="rs-choice-slot" data-slot-tank="' + o.id + '"></div>';
      }).join('') + (options.length > 1 ? '<span class="rs-choice-or" aria-hidden="true"><i>OR</i></span>' : '');
    }
    e.choice.classList.remove('hidden');

    if (host && _choiceStage) { _choiceStage.dispose(); _choiceStage = null; }
    if (host) {
      const stage = Stage.create(host);
      stage.bindDrag();
      _choiceStage = stage;
      stage.mount();
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      /* Centre each model over its own name, not over a fraction of the stage:
         the names sit in a grid with a gap, so the two columns are narrower
         than half the width and the models would drift outward from their
         labels. Measured from the rendered buttons, so it holds on mobile too. */
      const hostRect = host.getBoundingClientRect();
      const picks = e.choiceCards.querySelectorAll('.rs-pick');
      stage.setSlots(options.map(function (o, i) {
        const el = picks[i];
        const r = el ? el.getBoundingClientRect() : null;
        const cx = r ? (r.left + r.width / 2 - hostRect.left) : w * (options.length === 2 ? (i === 0 ? 0.25 : 0.75) : 0.5);
        /* y IS THE TOP OF THE MODEL BOX, and place() stands the tank on
           y + h. This used to pass h * 0.48, which is a CENTRE, so the ground
           line landed at 1.42 x the stage height — below the canvas. Only the
           top few pixels of each tank were visible, which is why the reward
           picker showed two slivers instead of two tanks. Top + 92% of the
           height keeps the ground just inside the stage. */
        return {
          id: o.id,
          x: cx,
          y: h * 0.06,
          w: Math.min(w / Math.max(1, options.length) * 0.92, 320),
          h: h * 0.90,
          auto: i === 0,
        };
      }));
      stage.start();
    }
    try { if (typeof Audio !== 'undefined' && Audio.click) Audio.click(); } catch (err) {}
  }

  function closeChoice() {
    const e = els();
    Research._choiceNode = null;
    if (e.choice) e.choice.classList.add('hidden');
    if (_choiceStage) { _choiceStage.dispose(); _choiceStage = null; }
    const host = document.getElementById('research-choice-stage');
    if (host) host.innerHTML = '';
  }

  /* --------------------------------------------------------------- effects */

  /* Confetti burst out of a tile when a tank pops out of it. Plain DOM, so it
     costs nothing when it is not running. */
  function burst(nodeEl) {
    const rect = nodeEl.getBoundingClientRect();
    const host = els().overlay;
    if (!host) return;
    /* yellow, white and two warm tones only — a rainbow burst would be the one
       thing on the sheet that ignores the palette */
    const colors = ['#ffd447', '#ffb12b', '#ffffff', '#ffe9a8', '#f5f6f8'];
    for (let i = 0; i < 22; i++) {
      const p = document.createElement('span');
      p.className = 'rs-confetti';
      p.style.left = (rect.left + rect.width / 2) + 'px';
      p.style.top = (rect.top + 40) + 'px';
      p.style.background = colors[i % colors.length];
      const dx = (Math.random() - 0.5) * 320;
      const dy = -60 - Math.random() * 190;
      const rot = (Math.random() - 0.5) * 900;
      p.style.setProperty('--dx', dx.toFixed(0) + 'px');
      p.style.setProperty('--dy', dy.toFixed(0) + 'px');
      p.style.setProperty('--rot', rot.toFixed(0) + 'deg');
      p.style.animationDelay = (Math.random() * 0.12).toFixed(2) + 's';
      host.appendChild(p);
      setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 1400);
    }
  }

  /* THE MENU'S OWN FOUNDRY ROW carries the XP figure and a blinking dot while
     a step is affordable. It used to hang off a button at the end of the
     Collections bar; that button is gone, because research is a destination
     rather than a sub-tool of the garage. */
  function updateBadge() {
    const btn = document.getElementById('workshop-side-btn');
    if (!btn) return;
    const nodes = buildPath();
    const f = frontier(nodes);
    const ready = f >= 0 && !nodes[f].soon && xpTotal() >= nodes[f].cost;
    btn.classList.toggle('rs-ready', !!ready);
    const label = btn.querySelector('.menu-side-badge');
    if (label) {
      label.innerHTML = xpTotal().toLocaleString('en-US') +
        ' <img src="assets/ui/xp.webp" alt="XP" draggable="false">';
    }
  }

  /* ------------------------------------------------------------------ wiring */

  function wire() {
    const e = els();
    if (!e.overlay || e.overlay._rsWired) return;
    e.overlay._rsWired = true;

    /* Hover placeholder showing XP, replacing the always-on badge. */
    const fbtn = document.getElementById('workshop-side-btn');
    if (fbtn && !fbtn._workshopHoverWired) {
      fbtn._workshopHoverWired = true;
      const label = fbtn.querySelector('span');
      if (label) label.style.position = 'relative';
      let tip = null;
      fbtn.addEventListener('mouseenter', function () {
        if (tip) return;
        tip = document.createElement('div');
        tip.className = 'workshop-xp-tip';
        tip.textContent = (typeof xpTotal === 'function' ? xpTotal() : 0).toLocaleString('en-US') + ' XP';
        if (label) label.appendChild(tip);
        else fbtn.appendChild(tip);
      });
      fbtn.addEventListener('mouseleave', function () {
        if (tip) { tip.remove(); tip = null; }
      });
      fbtn.addEventListener('click', function () {
        if (tip) { tip.remove(); tip = null; }
      });
    }

    const closeBtn = document.getElementById('research-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { Research.close(); });
    const backBtn = document.getElementById('research-back');
    if (backBtn) backBtn.addEventListener('click', function () { Research.close(); });
    const backdrop = document.getElementById('research-backdrop');
    if (backdrop) backdrop.addEventListener('click', function () { Research.close(); });

    if (e.tabs) {
      e.tabs.addEventListener('click', function (ev) {
        const btn = ev.target.closest ? ev.target.closest('.rs-tab') : null;
        if (!btn) return;
        try { if (typeof Audio !== 'undefined' && Audio.click) Audio.click(); } catch (err) {}
        researchActive = parseInt(btn.getAttribute('data-col'), 10) || 0;
        /* The path is one continuous line now: a tab scrolls the player to
           that collection's segment instead of swapping the row. */
        if (e.path && e.scroll) {
          const target = e.path.querySelector('.rs-node[data-ci="' + researchActive + '"]');
          if (target) {
            const to = Math.max(0, target.offsetLeft - e.scroll.clientWidth / 2 + target.offsetWidth / 2);
            e.scroll.scrollTo({ left: to, behavior: 'smooth' });
          }
        }
        e.tabs.querySelectorAll('.rs-tab').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    }

    /* Track the scroll position so (a) the stage only draws models near the
       viewport and (b) the active jump tab follows the player. */
    if (e.scroll && !e.scroll._rsScrollBound) {
      e.scroll._rsScrollBound = true;
      let pending = 0;
      e.scroll.addEventListener('scroll', function () {
        /* The pill is re-aimed SYNCHRONOUSLY, before the frame is coalesced:
           scroll events are already one per frame, and a queued rAF can be
           skipped entirely by a throttled or background tab — which left the
           button hovering over whatever tank came next. */
        if (_statsNodeId) placeStatsBtn();
        if (pending) return;
        pending = requestAnimationFrame(function () {
          pending = 0;
          const st = pathStage();
          if (st) {
            st.setViewport(e.scroll.scrollLeft, e.scroll.clientWidth);
            st.place();
            st.dirty = true;
          }
          if (Research.open) updateJumpActive();
          /* The pill points at a node inside the band, so it rides the scroll
             with its tank instead of staying pinned to the viewport. */
          if (_statsNodeId) placeStatsBtn();
        });
      }, { passive: true });
    }

    if (e.path) {
      e.path.addEventListener('click', function (ev) {
        const el = ev.target.closest ? ev.target.closest('.rs-node') : null;
        if (!el) return;
        /* A CLICK INSPECTS, IT DOES NOT BUY. Which model was hit matters on a
           two-tank step: clicking one of the pair pre-selects that tank for
           the CTA instead of asking again in the choice screen. */
        const slot = ev.target.closest ? ev.target.closest('[data-slot-tank]') : null;
        const tankId = slot ? slot.getAttribute('data-slot-tank') : null;
        try { if (typeof Audio !== 'undefined' && Audio.click) Audio.click(); } catch (err) {}
        selectStep(el.getAttribute('data-node'), tankId, true, slot);
      });
    }

    /* ---- the pill and the tank sheet ------------------------------------- */
    const pill = document.getElementById('rs-stats-btn');
    if (pill) {
      pill.addEventListener('click', function (ev) {
        /* stopPropagation: the pill floats over the row, so a stray press must
           not also be read as a click on the tank underneath it. */
        ev.preventDefault();
        ev.stopPropagation();
        /* THE PILL OPENS THE TANK, NOT A SIDE PANEL.

           It used to open the workshop's own stats sheet, which is a second,
           smaller tank screen that has to be maintained beside the real one.
           A tank's menu already exists (Collections -> click a tank), so the
           pill now opens exactly that. The sheet is still the place the
           RESEARCH button lives; the footer's Research button opens it, and
           Enter still presses it. */
        if (!openTankMenuFor(_statsNodeId)) openTankSheet();
      });
    }
    const tankClose = document.getElementById('rs-stats-close');
    if (tankClose) tankClose.addEventListener('click', function () { closeTankSheet(); });
    const tankBack = document.getElementById('rs-stats-back');
    if (tankBack) tankBack.addEventListener('click', function () { closeTankSheet(); });
    const claimBtn = document.getElementById('research-claim');
    if (claimBtn) claimBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openTankSheet();
    });

    /* ---- the inspector's controls ---------------------------------------- */
    const helpOpenBtn = document.getElementById('research-help-open');
    const helpLink = document.getElementById('research-help-link');
    const helpClose = document.getElementById('research-help-close');
    const helpGo = document.getElementById('research-help-go');
    const helpBack = document.getElementById('research-help-back');
    const onHelp = function () { openHelp(); };
    if (helpOpenBtn) helpOpenBtn.addEventListener('click', onHelp);
    if (helpLink) helpLink.addEventListener('click', onHelp);
    if (helpClose) helpClose.addEventListener('click', closeHelp);
    if (helpGo) helpGo.addEventListener('click', closeHelp);
    if (helpBack) helpBack.addEventListener('click', closeHelp);

    if (e.cta) {
      e.cta.addEventListener('click', function () {
        if (!_detailAction) return;
        const act = _detailAction;
        try { if (typeof Audio !== 'undefined' && Audio.click) Audio.click(); } catch (err) {}
        act();
      });
    }
    if (e.prev) e.prev.addEventListener('click', function () { stepBy(-1); });
    if (e.next) e.next.addEventListener('click', function () { stepBy(1); });
    if (e.spinL) e.spinL.addEventListener('click', function () {
      if (selectedStepId && _pathStage) _pathStage.spinBy(selectedStepId, -Math.PI / 12);
    });
    if (e.spinR) e.spinR.addEventListener('click', function () {
      if (selectedStepId && _pathStage) _pathStage.spinBy(selectedStepId, Math.PI / 12);
    });
    if (e.pose) e.pose.addEventListener('click', function () {
      if (selectedStepId && _pathStage) _pathStage.heroPose(selectedStepId);
    });

    if (e.choiceCards) {
      e.choiceCards.addEventListener('click', function (ev) {
        const btn = ev.target.closest ? ev.target.closest('.rs-pick') : null;
        if (!btn) return;
        const id = btn.getAttribute('data-pick');
        const nodeId = Research._choiceNode;
        if (!nodeId || !id) { closeChoice(); return; }
        try { if (typeof Audio !== 'undefined' && Audio.click) Audio.click(); } catch (err) {}
        closeChoice();
        /* claim() itself plays the white-square wipe: cover, choice applied
           and the path re-rendered underneath, rounded reveal on top. */
        claim(nodeId, id);
      });
    }

    const cancel = document.getElementById('research-choice-cancel');
    if (cancel) cancel.addEventListener('click', function () { closeChoice(); });

    /* Escape closes the choice panel first, then the whole overlay. Capture
       phase so the menu behind (which also listens for Escape) does not close
       underneath the path. Z does the same thing -- it is the key drawn on the
       back chip, and on every menu's back control, so it is the shortcut the
       player is already looking at. Capture phase matters there too: menu.js's
       own Z handler must not fire as well and skip a level. */
    window.addEventListener('keydown', function (ev) {
      if (!Research.open) return;

      /* The guide swallows the first Escape/Enter so it closes on its own. */
      if (_helpOpen) {
        if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          ev.stopPropagation();
          closeHelp();
        }
        return;
      }

      /* THE SHEET OWNS ESCAPE AND Z — and nothing else. The arrows and Enter
         still belong to the line it is describing (their output is the card
         itself, which repaints for the neighbouring step), so only the way out
         is intercepted here. Without this, Escape would close the whole
         workshop and take the sheet with it. */
      if (tankSheetOpen()) {
        const zkey = (ev.code === 'KeyZ') || ev.key === 'z' || ev.key === 'Z';
        if (ev.key === 'Escape' || (zkey && !ev.ctrlKey && !ev.metaKey && !ev.altKey)) {
          ev.preventDefault();
          ev.stopPropagation();
          closeTankSheet();
          return;
        }
      }

      /* KEYBOARD CONTROLS. Only when no modal owns the screen and the player
         is not typing: arrows walk the line, Enter presses the gold button,
         ? (or H) opens the guide. */
      const t = ev.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      /* A FOCUSED BUTTON OWNS ITS OWN ENTER. Otherwise pressing Enter on the
         rotate or back control would research a tank instead of doing what
         the focused control says it does. */
      const onControl = t && (t.tagName === 'BUTTON' || t.tagName === 'A');
      if (!typing && !Research._choiceNode) {
        if (ev.key === 'ArrowLeft') { ev.preventDefault(); ev.stopPropagation(); stepBy(-1); return; }
        if (ev.key === 'ArrowRight') { ev.preventDefault(); ev.stopPropagation(); stepBy(1); return; }
        if (ev.key === 'Enter' && !onControl) {
          if (_detailAction) { ev.preventDefault(); ev.stopPropagation(); _detailAction(); }
          return;
        }
        if (ev.key === '?' || ev.key === 'h' || ev.key === 'H') { ev.preventDefault(); ev.stopPropagation(); openHelp(); return; }
      }

      const isZ = (ev.code === 'KeyZ') || ev.key === 'z' || ev.key === 'Z';
      if (ev.key !== 'Escape' && !isZ) return;
      if (isZ && (ev.ctrlKey || ev.metaKey || ev.altKey)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (Research._choiceNode) closeChoice();
      else Research.close();
    }, true);

    /* ==========================================================================
       MOVING ALONG THE LINE WITH THE MOUSE

       The path is one long horizontal row, so its only native input was the
       thin scrollbar and the collection tabs at the top. A mouse wheel over the
       row did nothing at all: `overflow-x:auto` with `overflow-y:hidden` has no
       vertical scroll to give the wheel, so the delta was simply dropped. That
       is the whole reason this handler exists -- vertical wheel travel now moves
       the line horizontally, which is the gesture every horizontal shelf uses.

       Middle-drag pans it directly, the way a drafting sheet is dragged. It is
       middle-button rather than left because left-drag already spins the tank
       under the cursor, and a pan that also rotated the model would be two
       actions on one gesture. The model's own handler is gated to button 0 so
       the two cannot both start.
       ========================================================================== */
    if (e.scroll && !e.scroll._rsWheelBound) {
      e.scroll._rsWheelBound = true;

      e.scroll.addEventListener('wheel', function (ev) {
        /* A horizontal trackpad swipe is already handled natively. */
        if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
        if (!e.scroll.scrollWidth || e.scroll.scrollWidth <= e.scroll.clientWidth) return;
        ev.preventDefault();
        /* Line/page deltas arrive in units, not pixels, on Firefox. */
        const mult = ev.deltaMode === 1 ? 26 : (ev.deltaMode === 2 ? e.scroll.clientWidth : 1);
        e.scroll.scrollLeft += ev.deltaY * mult;
      }, { passive: false });

      let pan = null;
      const endPan = function (ev) {
        if (!pan) return;
        pan = null;
        e.scroll.classList.remove('rs-panning');
        try {
          if (ev && ev.pointerId != null && e.scroll.hasPointerCapture(ev.pointerId)) {
            e.scroll.releasePointerCapture(ev.pointerId);
          }
        } catch (err) {}
      };
      /* The browser's own middle-click autoscroll would fight the pan; both of
         these are needed -- pointerdown is not enough on Chromium. */
      e.scroll.addEventListener('mousedown', function (ev) {
        if (ev.button === 1) ev.preventDefault();
      });
      e.scroll.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 1) return;
        ev.preventDefault();
        pan = { x: ev.clientX, left: e.scroll.scrollLeft };
        e.scroll.classList.add('rs-panning');
        try { e.scroll.setPointerCapture(ev.pointerId); } catch (err) {}
      });
      e.scroll.addEventListener('pointermove', function (ev) {
        if (!pan) return;
        e.scroll.scrollLeft = pan.left - (ev.clientX - pan.x);
      });
      e.scroll.addEventListener('pointerup', endPan);
      e.scroll.addEventListener('pointercancel', endPan);
      e.scroll.addEventListener('auxclick', function (ev) {
        if (ev.button === 1) ev.preventDefault();
      });
    }

    /* The stage camera is measured in CSS pixels, so a viewport change has to
       re-measure it; otherwise every model drifts off its dot. The pill is
       measured the same way and has to be re-aimed on the same event. */
    window.addEventListener('resize', function () {
      if (_pathStage && Research.open) { _pathStage.laid = false; _pathStage.layout(); }
      if (_choiceStage) { _choiceStage.laid = false; _choiceStage.layout(); }
      if (_statsNodeId) placeStatsBtn();
    });

    /* The Foundry row opens this overlay. menu.js owns the click (the row is
       one of its [data-open] buttons and has no #menu-foundry panel to show),
       so this listener is only the fallback for a row rendered without that
       wiring. openPanel() is idempotent, so a double call cannot double-open. */
    document.addEventListener('click', function (ev) {
      const btn = ev.target.closest ? ev.target.closest('#workshop-side-btn') : null;
      if (!btn) return;
      try { if (typeof Audio !== 'undefined' && Audio.click) Audio.click(); } catch (err) {}
      Research.openPanel();
    });
  }

  function boot() {
    wire();
    updateBadge();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.Research = Research;
})(window);
