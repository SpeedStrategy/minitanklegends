/* ============================================================================
   xray.js — show the part of a tank that something else is standing in front of.

   WHAT IT IS
   Every tank is drawn a second time, coincident with the first, in flat white
   stripes — but only the fragments that are BEHIND something. Walk behind a
   building and the far half of the tank that the building is covering is drawn
   over the building as diagonal white bands; the half you could already see is
   left alone, still wearing its own texture. Nothing is drawn over the parts of
   the tank you can genuinely see, so it never looks like a sticker stuck on
   top of the world.

   HOW THE "ONLY IF HIDDEN" PART WORKS
   This is one number on the material: depthFunc = GreaterDepth.

   The depth buffer already holds, for every pixel, the depth of the nearest
   surface the camera can see. A fragment of the tank sitting FARTHER away than
   that is by definition behind a wall, a rock or another tank. A fragment at the
   same depth or nearer is the tank's own visible surface. GreaterDepth keeps the
   first and throws the second away, per pixel, on the GPU.

   The CPU never asks "is this tank hidden?". That question is asked of every
   pixel of every tank every frame by the depth test itself, which is both exact
   and free — a tank straddling a wall corner gets the stripes only on the
   covered side, with no raycast, no bounding box and no frame-to-frame lag.

   WHY THE MATERIAL IS TRANSPARENT
   Transparent objects are drawn after every opaque one, so by the time this pass
   runs the depth buffer is fully populated. If it were opaque it would be sorted
   in with the world and race the walls it is supposed to be reading.

   SELF-OCCLUSION IS NOT LEFT IN — IT IS ERASED, WITH THE STENCIL
   Your own turret sits in front of your own hull, so the hull reads as "behind
   something" and would be striped for as long as you have a tank. That is the
   difference between an x-ray and a fault, and it cannot be tuned away with a
   distance threshold: a turret is about a unit in front of the hull, and a wall
   you have reversed into is about the same distance in front of it. Same gap,
   opposite meanings.

   So the player's own visible silhouette is stamped into the stencil buffer
   (one colour-write-off draw per mirrored mesh, renderOrder 995) and the stripe
   material refuses to draw where the stamp is set. Behind a rock the stamp
   never lands — that surface failed the depth test — so the stripes still draw,
   which is the entire point of the effect. See buildMaskMaterial().

   WHAT IT IS FOR, AND FOR WHOM
   One tank gets this: YOUR OWN. The camera sits on it, so its own turret and
   its own gun barrel hide real chunks of its own hull from you at all times —
   chunks you are then driving blind into. The stripes put those chunks back.

   Nothing else on the field is striped. Not the enemies, not your teammates.
   A tank in your eyeline has no hidden parts to reveal, and marking up
   somebody else's tank is noise at best and a way to hand your teammates'
   positions to them at worst.

   WHAT ELSE IS NOT MIRRORED
   A tank root also holds its view-range ring, which is a Mesh and, for a tank
   with a long eye, five hundred and forty units across. Mirroring that painted
   the stripe pattern over the whole battlefield. See isDecoration().

   See also `shown()`: a mirror follows the visibility of the mesh it copies, so
   hiding a part of a tank hides its stripes too.

   WHERE THE SECOND DRAW LIVES
   The stripe meshes are NOT parented under the tank. They sit in one group of
   their own, at the top of the scene, and copy the tank's world matrix every
   frame. Parenting them to the tank would have been tidier to write and wrong in
   practice: several passes walk tank.root and rewrite the materials they find
   (the bush fade, the cloak, the outline batcher), and all of them would then
   be quietly dimming, tinting or double-drawing the stripes.

   TWO BACKENDS, ONE LOOK
   WebGL runs the GLSL below. WebGPU cannot run GLSL at all, so the same maths is
   transcribed into TSL further down. Same six styles, same uniforms, same
   result — see the note on _buildNodeMaterial for why the node version cannot
   skip the stripe maths the way a flat colour would have.

   CLASSIC SCRIPT, NO `import`
   Like every other file in js/ this is injected as a classic script, and the
   TSL/WebGPU modules arrive through `await window.loadTSL()` (see index.html).
   ============================================================================ */

const Xray = (() => {

  /* The six styles, in the order the settings screen lists them.

     Kept as a plain list and looked up by name, because the style is saved to
     disk as a string and a renamed or dropped style has to fall back to the
     first one rather than leave the material pointing at nothing. */
  const STYLES = ['stripes', 'scanlines', 'hatch', 'dots', 'solid', 'pulse'];
  const DEFAULT_STYLE = 'stripes';

  /* Stripe pitch in CSS pixels. Screen space, not object space, on purpose: the
     bands stay the same width on the glass whether the tank is 20 m or 200 m
     away. An object-space stripe gets finer with distance until it aliases into
     grey mush, which is exactly the wrong failure for something whose entire job
     is to be noticed. */
  const PERIOD_CSS = 17;

  let _group = null;          // the one group every stripe mesh lives in
  let _scene = null;          // kept so inScene() can walk up to it
  let _mat   = null;          // one material, shared by every tank
  let _maskMat = null;        // the stencil stamp, one material, local tank only
  let _stencilTestOn = true;  // cleared if the mask could not be built
  let _u     = null;          // its uniforms, for the per-frame time
  let _style = DEFAULT_STYLE;
  let _built = false;
  let _warned = false;   // the node-material warning, said once

  /* ------------------------------------------------------------- the shader */

  const VS = /* glsl */`
    /* How far, in WORLD UNITS, a stripe fragment is pulled toward the camera
       before the depth test. See the note on the fragment stage. */
    uniform float uBias;

    void main(){
      /* View space: the camera sits at the origin looking down -z, so adding to
         z moves a fragment toward the eye. Done here, in metres, rather than as
         a polygon offset, because a polygon offset is measured in depth-buffer
         quanta and so changes with the resolution and the near/far planes —
         which is exactly why the seams would not settle. */
      vec4 mv = modelViewMatrix * vec4( position, 1.0 );
      mv.z += uBias;
      gl_Position = projectionMatrix * mv;
    }
  `;

  /* One branch per style, resolved by the preprocessor rather than at runtime.

     The style never changes without the material being rebuilt, so there is
     never a moment where a running shader has to decide between six patterns —
     and picking the branch at compile time keeps the fragment stage down to a
     couple of instructions per pixel, on a mesh that can cover half the screen.

     XRAY_STYLE is a #define rather than a uniform for the same reason. */
  const FS = /* glsl */`
    uniform vec3  uColor;
    uniform float uOpacity;
    uniform float uTime;
    uniform float uPeriod;

    void main(){
      vec2 p = gl_FragCoord.xy;
      float m = 0.0;

      #if XRAY_STYLE == 0
        /* diagonal bands, the default and the one that reads as "x-ray" */
        m = step(0.5, fract( ( p.x + p.y ) / uPeriod ));
      #elif XRAY_STYLE == 1
        /* horizontal scanlines: a tighter pitch, because a horizontal band at
           the same pitch as a diagonal one is half as wide on screen */
        m = step(0.5, fract( p.y / ( uPeriod * 0.55 ) ));
      #elif XRAY_STYLE == 2
        /* cross-hatch: both diagonals, and thinner lines (0.62 not 0.5) so the
           crossings do not fill the whole thing in */
        float a = fract( ( p.x + p.y ) / uPeriod );
        float b = fract( ( p.x - p.y ) / uPeriod );
        m = max( step(0.62, a), step(0.62, b) );
      #elif XRAY_STYLE == 3
        /* dots on a grid */
        vec2 g = fract( p / uPeriod ) - 0.5;
        m = 1.0 - step(0.30, length(g));
      #elif XRAY_STYLE == 4
        /* solid: the whole hidden shape, no pattern at all */
        m = 1.0;
      #elif XRAY_STYLE == 5
        /* the same diagonal bands, travelling. The phase term is in units of
           the period, so the speed is in pixels per second and does not change
           when the pitch does. */
        m = step(0.5, fract( ( ( p.x + p.y ) / uPeriod ) - uTime * 0.35 ));
      #else
        /* Out of range, which styleIndex() should have made impossible. Falls
           back to the default rather than to whichever arm happens to be last,
           so a seventh style added to STYLES without a shader arm shows up as
           plain stripes instead of as travelling ones nobody asked for. */
        m = step(0.5, fract( ( p.x + p.y ) / uPeriod ));
      #endif

      /* The gap between the bands discards rather than drawing transparent.
         Underneath is the wall the tank is behind, so the gaps have to show the
         wall — which is what makes it read as stripes ON the wall rather than a
         white shape floating in front of it. */
      if(m < 0.5) discard;

      gl_FragColor = vec4(uColor, uOpacity);
    }
  `;

  function styleIndex(name){
    const i = STYLES.indexOf(name);
    return i < 0 ? 0 : i;
  }

  /* --------------------------------------------------------------- material */

  function build(){
    if(_built) return _mat;
    const idx = styleIndex(_style);

    /* WebGPU cannot compile GLSL at all. Falling through to the GLSL material on
       that backend does not error and does not draw — it renders nothing and
       reports nothing, which is precisely the "the effect just isn't there" bug
       this guards against. So on WebGPU this returns null and asks to be called
       again, and sync() calls it every frame; the TSL modules are already loaded
       by the time the renderer is built, so the retry costs nothing in practice
       and only matters when something is slower than usual. */
    if(window.__isWebGPU){
      if(!(window.TSL && window.WebGPU)) return null;
      const m = buildNodeMaterial(idx);
      if(!m){
        if(!_warned){
          _warned = true;
          console.warn('[Xray] node material unavailable - the effect will stay off until it builds');
        }
        return null;
      }
      _built = true;
      _mat = m.mat; _u = m.uniforms;
      return _mat;
    }

    _built = true;

    _u = {
      uColor:   { value: new THREE.Color(0xffffff) },
      uOpacity: { value: 0.92 },
      uTime:    { value: 0 },
      uPeriod:  { value: PERIOD_CSS },
      /* The tie-break distance. Big enough to beat a coincident surface, small
         enough that anything genuinely in the way — the smallest thing a tank
         can reverse into is far bigger than this — still counts as hiding it. */
      uBias:    { value: 0.35 },
    };
    _mat = new THREE.ShaderMaterial({
      vertexShader:   VS,
      fragmentShader: FS,
      uniforms:       _u,
      defines:        { XRAY_STYLE: idx },
      transparent:    true,
      depthTest:      true,
      depthWrite:     false,
      side:           THREE.FrontSide,
      blending:       THREE.NormalBlending,
      toneMapped:     false,
      /* THE STENCIL IS WHAT MAKES THIS HONEST.

         The mask stamps 1 on every pixel of the player's own tank that is
         actually visible (see buildMaskMaterial — the turret stamps the hull's
         pixels for it). These stripes are allowed only where the stencil is
         still 0, so: Equal against 0.

         Together with GreaterDepth below, a pixel gets stripes only if
         something is in front of it AND that something is not my own tank:

           * hull under the turret  -> GreaterDepth passes, stencil says 1
             (the turret stamped it) -> refused. This is the permanent-striping
             complaint, and it is what these two tests exist to kill.
           * hull behind a rock      -> GreaterDepth passes, nothing stamped it
             -> drawn. The effect doing its job.

         Getting either half backwards is not a subtle degradation: Equal-1
         stripes the tank's own silhouette and nothing else, and depth-test-off
         on the mask erases the effect behind cover. Both were tried here.

         Writing nothing back (Keep everywhere) leaves the stamp alone for the
         rest of the frame, and the renderer clears the buffer on the next one.
         On a context with no stencil buffer this always passes, so the effect
         degrades to the old behaviour rather than vanishing — hence the
         fallback in sync() that switches the test off if the mask is missing. */
      stencilWrite:   true,
      stencilRef:     0,
      stencilFunc:    THREE.EqualStencilFunc,
      stencilFail:    THREE.KeepStencilOp,
      stencilZFail:   THREE.KeepStencilOp,
      stencilZPass:   THREE.KeepStencilOp,
      /* GreaterDepth IS THE FEATURE — and this offset is what makes it honest.

         The test is "farther than whatever is in the depth buffer", with no
         tolerance, so a stripe fragment sitting at the SAME depth as the hull it
         belongs to is a coin flip. Along panel joins and track tops the outline
         shell wins that coin by a hair, the fragment is judged "behind
         something", and the stripes come through as thin hatched seams on a tank
         standing in the open.

         Pulling the stripe a few depth units TOWARD the camera settles every
         such tie against the hull — coincident fragments become nearer, fail
         GreaterDepth, and are discarded — while leaving anything genuinely hidden
         untouched, because a rock in front of the tank is metres nearer, not a
         few depth units. Same one-sided trick as a z-bias, which is what this is.

         Losing GreaterDepth itself turns the pass into an ordinary depth-tested
         draw and the stripes stop appearing behind walls at all — degraded, not
         broken, which is why that is a fallback and this is not. */
      /* GreaterDepth is the feature. Losing it turns the pass into an ordinary
         depth-tested draw and the stripes simply stop appearing behind walls —
         degraded, not broken, which is why this is a fallback rather than an
         error path. The tie-break is the vertex-stage bias above, not an offset
         here. */
      depthFunc:      THREE.GreaterDepth,
    });
    return _mat;
  }

  /* The TSL transcription. Kept next to the GLSL it mirrors so the two are read
     together; every branch below has a line-number twin in FS. */
  function buildNodeMaterial(idx){
    try {
      const T = window.TSL, W = window.WebGPU;
      const mat = new W.MeshBasicNodeMaterial();

      const uColor   = T.uniform(new THREE.Color(0xffffff));
      const uOpacity = T.uniform(0.92);
      const uTime    = T.uniform(0);
      /* The drawing buffer, in device pixels. screenUV is 0..1 across it, so the
         sum is gl_FragCoord and the pattern lands on the same pixels the GLSL
         version does. */
      const uRes     = T.uniform(new THREE.Vector2(1, 1));
      const P        = Math.max(4, PERIOD_CSS);

      const x = T.screenUV.x.mul(uRes.x);
      const y = T.screenUV.y.mul(uRes.y);
      let m;
      if(idx === 0){
        m = T.step(0.5, T.fract(x.add(y).div(P)));
      } else if(idx === 1){
        m = T.step(0.5, T.fract(y.div(P * 0.55)));
      } else if(idx === 2){
        const a = T.step(0.62, T.fract(x.add(y).div(P)));
        const b = T.step(0.62, T.fract(x.sub(y).div(P)));
        m = T.max(a, b);
      } else if(idx === 3){
        const gx = T.fract(x.div(P)).sub(0.5);
        const gy = T.fract(y.div(P)).sub(0.5);
        m = T.step(0.30, T.length(T.vec2(gx, gy))).oneMinus();
      } else if(idx === 4){
        m = T.float(1);
      } else {
        m = T.step(0.5, T.fract(x.add(y).div(P).sub(uTime.mul(0.35))));
      }
      T.Discard(T.lessThan(m, 0.5));

      mat.colorNode = T.vec4(uColor, uOpacity);
      mat.transparent = true;
      mat.depthTest   = true;
      mat.depthWrite  = false;
      mat.side        = THREE.FrontSide;
      mat.depthFunc   = THREE.GreaterDepth;
      mat.toneMapped  = false;
      /* Same stencil test as the GLSL material, so both backends obey the one rule:
         the mask stamps the player's own visible tank, and stripes pass only
         where it did not — Equal against 0. */
      mat.stencilWrite = true;
      mat.stencilRef   = 0;
      mat.stencilFunc  = THREE.EqualStencilFunc;
      mat.stencilFail  = THREE.KeepStencilOp;
      mat.stencilZFail = THREE.KeepStencilOp;
      mat.stencilZPass = THREE.KeepStencilOp;
      return { mat, uniforms: { uColor, uOpacity, uTime, uRes } };
    } catch(e){
      console.warn('[Xray] node material failed, falling back:', e);
      return null;
    }
  }

  /* Rebuild the material. Only called when the style actually changes — the
     pattern is baked in at compile time, so this is a recompile, and doing it
     on every settings save would stall the frame the player is reading. */
  function setStyle(name){
    const next = (STYLES.indexOf(name) < 0) ? DEFAULT_STYLE : name;
    if(next === _style && _mat) return;
    _style = next;
    if(!_built) return;
    const old = _mat;
    _built = false;
    const fresh = build();
    /* Hand the new material to the mirrors ALREADY IN THE SCENE.

       A mesh holds its material by direct reference, so building a replacement
       does nothing to it: every mirror created before the change goes on drawing
       the old pattern until its tank is despawned. That is not a subtle version
       of "the setting did not apply" — picking a different pattern in the menu
       while a battle is running changes absolutely nothing on screen, which is
       what it looked like.

       Assigning on the group's children is enough, and reaches every tank
       without walking any of them. */
    if(fresh && _group){
      for(let i = 0; i < _group.children.length; i++) _group.children[i].material = fresh;
    }
    if(old && old !== fresh && old.dispose){ try { old.dispose(); } catch(e){} }
  }

  function setTime(sec){
    if(!_u) return;
    if(_u.uTime) _u.uTime.value = sec;
  }

  /* gl_FragCoord is in DEVICE pixels, so the period has to grow with the pixel
     ratio or the bands get thinner on a high-DPI screen and stop matching the
     settings preview. */
  function setPixelRatio(r){
    if(!_u || !_u.uPeriod) return;
    _u.uPeriod.value = PERIOD_CSS * Math.max(0.5, r || 1);
  }

  function setResolution(w, h){
    if(!_u || !_u.uRes) return;
    _u.uRes.value.set(Math.max(1, w | 0), Math.max(1, h | 0));
  }

  function setColor(hex){
    if(!_u || !_u.uColor) return;
    try { _u.uColor.value.set(hex); } catch(e){}
  }

  function setOpacity(v){
    if(!_u || !_u.uOpacity) return;
    _u.uOpacity.value = Math.max(0, Math.min(1, v));
  }

  /* ------------------------------------------------------------------ setup */

  function init(scene){
    if(!scene) return null;
    _scene = scene;
    if(!_group){
      _group = new THREE.Group();
      /* Nothing here is lit, cast or receive; the group is bookkeeping only, but
         leaving it nameless makes it impossible to spot in a scene dump later. */
      _group.name = 'xray';
      _group.matrixAutoUpdate = false;
    }
    if(_group.parent !== scene) scene.add(_group);
    build();
    return _group;
  }

  /* Is this object actually in the rendered scene graph right now?

     The obvious test — `mesh.parent` — is the wrong one, and it was the wrong one
     here for a while. A tank's hull keeps pointing at its own root Group after
     the root is taken out of the scene, so `parent` stayed non-null on a tank
     that had already been disposed and every liveness check passed. The mirror
     of such a tank then sat frozen in mid-air at the last place it was seen,
     striped, for as long as the match lasted.

     Walking to the root is a few steps and happens ONCE PER TANK per frame, not
     per mesh, which is the difference between this being affordable and not. */
  function inScene(o){
    if(!o) return false;
    let n = o;
    while(n){
      if(n === _scene) return true;
      n = n.parent;
    }
    return false;
  }

  /* Is this mesh part of the TANK, or is it something lying on the ground
     pretending to be part of it?

     The view-range ring is a Mesh, it is parented to the tank root, and for a
     tank with a long eye it is FIVE HUNDRED AND FORTY UNITS across — the whole
     battlefield. Mirroring it drew the stripe pattern over the arena from
     underneath the grass, so the effect stopped being an x-ray and became the
     effect drawn everywhere, which is exactly what it looked like. It is hidden
     on every tank but the player's, and even on the player's tank the mirror
     would have drawn it through the floor.

     Three checks, in order of how sure they are: the tank's own ring by
     identity, anything flagged as an overlay, and finally a size sanity check
     for the ground decals that have not been written yet — flat, and far bigger
     than any tank. That last one is deliberately loose (30 units, when the
     longest tank in the game is about 12): the cost of guessing wrong here is
     losing a strip of armour plate from an outline, and the cost of guessing
     too tight is painting the map with stripes.

     Once per attach, on the bounding box, so it costs nothing per frame. */
  function isDecoration(o, tank){
    if(tank && o === tank.viewCircle) return true;
    const u = o.userData;
    if(u && (u.noXray || u.isOverlay || u.isViewCircle)) return true;
    const g = o.geometry;
    if(!g) return true;
    if(!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox;
    const dx = b.max.x - b.min.x, dy = b.max.y - b.min.y, dz = b.max.z - b.min.z;
    if(dy <= 1.0 && Math.max(dx, dz) > 30) return true;   // a decal, not a hull
    return false;
  }

  /* Visible right now, all the way up to the tank.

     A mesh's own flag is not enough: hiding a turret GROUP leaves every mesh
     inside it flagged visible, and a mirror of a part that is not on screen is
     worse than no mirror at all. The walk stops at the tank root, because past
     that it is asking about the map. */
  function shown(o, stop){
    let n = o;
    while(n){
      if(n.visible === false) return false;
      if(n === stop) return true;
      n = n.parent;
    }
    return true;
  }

  /* ============================================================== SELF-OCCLUSION

     THE PROBLEM, PRECISELY.

     The pass is "draw this tank where something is in front of it", and the
     depth test cannot tell WHOSE something. Your own turret is in front of your
     own hull. So every frame, on every tank in the game, the hull underneath
     the turret was found to be "behind something" and striped — which is why
     the lines were on your tank constantly, even with nothing anywhere near it.
     And it cannot be tuned away with a distance threshold: a turret sits about
     a unit in front of the hull, and a wall you have reversed into sits about
     the same distance in front of it. Same gap, opposite meanings.

     THE ANSWER IS THE STENCIL, AND IT IS CHEAP.

     One extra draw per mirrored mesh of YOUR tank, writing no colour, whose only
     job is to stamp the stencil buffer with the tank's own VISIBLE silhouette:

       * where your tank is in the open, the stamp lands (its surface passed the
         depth test during the opaque pass) -> stencil 1 -> the stripes are
         refused there;
       * where your tank is behind a rock, its own surface FAILED that depth
         test, so nothing is stamped -> stencil 0 -> the stripes are allowed,
         which is the whole point of the effect;
       * where your hull is behind your own turret, the turret is the thing that
         passed, so it is the turret that stamps -> stencil 1 -> the hull is
         spared.

     Per pixel, per frame, exact, and it needs no second render of the world:
     the answer is already sitting in the depth buffer. It costs a handful of
     colour-write-off draws, and only for the one tank that is mirrored at all. */

  function buildMaskMaterial(){
    if(_maskMat) return _maskMat;
    try {
      _maskMat = new THREE.MeshBasicMaterial({
        /* No colour, no depth. Only the stencil write survives. */
        colorWrite: false,
        depthWrite: false,
        /* DEPTH TEST ON, AND THE MASK MUST COVER EVERY MESH OF THE TANK.

           The stamp means "this pixel is my tank, as seen". It is per-pixel, so
           the mesh that stamps a pixel is the one you would SEE there, not the
           one whose fragment happens to land on it:

             * the open: every tank pixel passes against the world behind it and
               stamps, so the stripes are refused on all of it;
             * behind a rock: the tank is farther than the rock, fails, stamps
               nothing, and the stripes draw — the entire point of the effect;
             * the hull under the turret: the hull fails, but the TURRET passes
               on those same pixels and stamps them, so the hull is spared. That
               case is why this is one mask per mesh and not one per tank.

           Depth test off instead stamps the tank's whole silhouette no matter
           what is in front, which erases the effect exactly where it is needed
           (a tank behind a wall stripes nothing). Both halves have to be right
           together, which is why the stripe side is Equal against 0.

           THE OFFSET ON THE MASK IS FOR THE SEAMS, AND ONLY FOR THE SEAMS.

           An outline is a back-face shell nudged just outside the hull it wraps.
           Where two hull panels meet, that shell for one panel can poke fractionally
           IN FRONT of the neighbouring panel, and it is then what wins the depth
           test. The hull's stripe fragment is genuinely "behind something", so
           GreaterDepth admits it — and since nothing stamps those pixels, thin
           hatched seams appear along every panel line of a tank in the open.

           Nudging the mask toward the camera by a few depth units settles those
           ties against its own tank. Far too small to beat a wall, which is metres
           nearer, so the case the effect exists for is untouched. */
        polygonOffset: true,
        polygonOffsetFactor: -8,
        polygonOffsetUnits:  -8,
        transparent: false,
        stencilWrite: true,
        stencilRef: 1,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilFail:  THREE.KeepStencilOp,
        stencilZFail: THREE.KeepStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
      });
    } catch(e){
      console.warn('[Xray] stencil mask unavailable:', e);
      _maskMat = null;
    }
    return _maskMat;
  }

  /* Mirror one tank's meshes into the stripe group.

     The copies share the source GEOMETRY outright — no extra vertex buffers, and
     the two draws cannot drift apart because they are literally the same
     positions. What is copied each frame is the world matrix, so the stripes
     track the hull, the turret swing, the recoil and the track animation without
     any of them having to know the stripes exist.

     Pairs are [source, stripe mesh, stencil mask or null]. Only the player's own
     tank gets a mask — it is the only tank that is ever striped, and a stencil
     written for any other tank would be meaningless. */
  function attach(tank){
    if(!tank || !tank.root || !_group) return null;
    /* No material yet means "not now", not "never": see build(). Bail out before
       creating anything, so a WebGPU startup race leaves nothing half-built to
       clean up and the next frame just tries again. */
    if(!build()) return null;
    /* Guarded on LENGTH, not on truthiness, and that is the whole bug this
       comment exists for.

       Tank models load asynchronously: Tank._loadModel() hands Models.load() a
       promise and only fills bodyGroup/turretGroup inside its .then(). The moment
       a tank is created its root holds two empty groups and no meshes at all. An
       attach at that point walks the tree, finds nothing, and caches an EMPTY
       array — and an empty array is truthy, so every later call returned early
       and the tank was never mirrored again. The effect silently did nothing on
       every single tank in the game, which is exactly how it looked: no stripes
       anywhere.

       So an empty result means "not yet", and sync() retries until the model has
       actually landed. */
    if(tank._xray && tank._xray.length) return tank._xray;

    const mat = build();
    const pairs = [];
    try {
      tank.root.updateMatrixWorld(true);
      tank.root.traverse((o) => {
        if(!o.isMesh || !o.geometry) return;
        /* OUTLINES ARE SKIPPED OUTRIGHT — NOT STRIPED, AND NOT MASKED.

           An outline is a back-face shell standing just outside the hull it
           wraps. Striping it draws the silhouette twice, once fatter than the
           other, and the two sets of bands beat against each other.

           An earlier version had them mask without striping, on the reasoning
           that the shell wins the depth test by a hair along panel joins and so
           needed stamping there to keep seams out. That is a workaround for a
           self-inflicted problem, and it bought its seam fix by putting the
           effect's own geometry into the pass: the shell is LARGER than the
           hull, so its mask stamped a ring of stencil around the whole tank
           that the stripes could never reach — and a stripe peeking out past
           the silhouette still read as a stripe on the outline. Adding it as a
           mask made the outline MORE present in the effect, not less.

           Skipping it completely keeps the pass to the two things that are
           actually the tank — body and turret — and leaves the outline to do
           the one job it already does perfectly, which is be the tank's black
           edge line. */
        if(o.userData && o.userData.isOutline) return;
        /* Anything that is not the tank — the ground ring above all. */
        if(isDecoration(o, tank)) return;

        /* The stencil stamp: what this pixel of my tank looks like. One draw per mesh,
           colour writes off, landing after the opaque world (renderOrder 995)
           and before the stripes. */
        let mask = null;
        if(tank.isLocal){
          const mm = buildMaskMaterial();
          if(mm){
            mask = new THREE.Mesh(o.geometry, mm);
            mask.name = 'xray-mask';
            mask.frustumCulled = false;
            mask.castShadow = false;
            mask.receiveShadow = false;
            mask.renderOrder = 995;
            mask.matrixAutoUpdate = false;
            mask.matrixWorldAutoUpdate = false;
            mask.matrixWorld.copy(o.matrixWorld);
            mask.userData.xrayOwner = tank;
            _group.add(mask);
          }
        }

        const s = new THREE.Mesh(o.geometry, mat);
        s.name = 'xray';
        s.frustumCulled = false;
        s.castShadow = false;
        s.receiveShadow = false;
        s.renderOrder = 996;          // after the world, before the aim overlay
        /* The matrix is written by hand every frame, so three must keep its
           hands off both halves of it. */
        s.matrixAutoUpdate = false;
        s.matrixWorldAutoUpdate = false;
        s.matrixWorld.copy(o.matrixWorld);
        /* Who this mirror belongs to, so pruning is a Set lookup instead of a
           search through every tank's pair list. */
        s.userData.xrayOwner = tank;
        _group.add(s);

        pairs.push([o, s, mask]);
      });
    } catch(e){
      console.warn('[Xray] attach failed:', e);
    }
    tank._xray = pairs;
    return pairs;
  }

  /* Make sure a tank's mirrors match the meshes it has RIGHT NOW, and return
     them.

     This exists because of the order two things happen in. Tank builds a cube
     placeholder so a tank is on screen immediately, then Tank._loadModel() clears
     those groups with _clearGroup() — which calls Object3D.remove(), which NULLS
     the child's parent — and builds the real model in their place.

     So the meshes an early attach walked are, a moment later, detached from the
     graph and replaced by different ones. Mirrors anchored to them keep tracking
     geometry that is no longer anywhere near the tank: they do not move with it,
     and they do not draw. An attach that only ever ran once therefore stopped
     working the instant the model arrived — which is on every single tank, and
     is why the effect was invisible in the game while working perfectly in a
     test scene built from boxes.

     The staleness test is `parent === null` rather than a mesh count. A mesh that
     has been removed from the graph always has a null parent, and the check costs
     one field read; a count would need a full traverse of the tank every frame to
     stay correct. */
  function ensure(tank){
    const pairs = tank._xray;
    if(pairs && pairs.length){
      let ok = true;
      for(let i = 0; i < pairs.length; i++){
        if(!pairs[i][0].parent){ ok = false; break; }
      }
      if(ok) return pairs;
      detach(tank);              // the model was swapped out from under us
    }
    return attach(tank);
  }

  /* Per-frame: make sure every live tank is mirrored, copy the transforms, apply
     the setting, and drop the tanks that have left.

     Pruning here rather than at every detach() call site is deliberate — a tank
     dies and is disposed along a dozen different paths, and a mirror left behind
     would hold its geometry alive and keep drawing it.

     `myTeam` is still in the signature — the game passes it, and nothing else
     calls this — but it is deliberately IGNORED. It used to decide "enemies
     only" versus "everyone", which is the exact rule that went wrong: the
     stripes are for the player's own tank and nobody else's. Each tank is
     matched by `isLocal`, which is the flag the game already sets on the one
     tank being driven, so there is no team comparison to get subtly wrong. */
  function sync(tanks, settings, nowSec, myTeam){
    if(!_group) return;
    const s = settings || {};
    const on = s.xrayEnabled !== false;

    if(on) setTime(nowSec || 0);

    const live = new Set();
    if(tanks) for(const t of tanks){
      if(!t) continue;

      /* Is the tank itself in the scene? Checked FIRST, and separately from the
         meshes, because a tank that has left the scene is not a tank to be
         re-mirrored — it is one to be hidden and then pruned. Rebuilding for it
         every frame would attach to meshes that are on their way out and churn a
         whole traverse per frame for nothing. */
      if(!inScene(t.root)){
        if(t._xray) for(let i = 0; i < t._xray.length; i++) t._xray[i][1].visible = false;
        continue;                       // not in `live`, so the prune takes it out
      }

      /* THIS is where a tank gets mirrored — not _finalizeTank, and not only
         once. The model swap above means there are two distinct moments that
         need mirroring, and this runs on every frame precisely so neither of them
         has to be predicted or hooked. */
      let pairs = null;
      try { pairs = ensure(t); } catch(e){}
      if(!pairs || !pairs.length) continue;

      live.add(t);
      /* NO STENCIL, NO MASK — SO DROP THE TEST RATHER THAN THE EFFECT.

         The stripe material only draws where the mask did NOT stamp, so on a
         context with no stencil buffer (some old mobile drivers, and anything
         that failed to give us one) that test can never pass and the lines
         would simply never appear. Losing the whole effect over a missing
         stencil is a far worse outcome than losing the self-occlusion fix, so
         the test is switched off at the source and the old behaviour —
         stripes on everything hidden, including the hull under the turret —
         comes back. */
      if(!!buildMaskMaterial() !== _stencilTestOn){
        _stencilTestOn = !!buildMaskMaterial();
        if(_mat){
          _mat.stencilWrite = _stencilTestOn;
          _mat.needsUpdate = true;
        }
      }
      /* ONE TANK GETS THE LINES: YOUR OWN.

         Not the enemies, and not your teammates. This is the part that is easy
         to get exactly backwards, and it was: the effect exists because the
         camera sits ON your tank, so your own turret and your own gun barrel
         hide real chunks of your own hull from you at all times — chunks you
         are steering blind into. Those chunks are what the stripes are for.

         Every other tank on the field is either in your eyeline, in which case
         there is nothing to reveal, or somebody else's tank, in which case
         marking up its hidden parts is at best noise and at worst handing your
         teammates' positions away on their own screen. Neither of them is what
         this is for, so `myTeam` and the old scope setting no longer take part:
         there is one tank this applies to and it is the one being driven. */
      const show = on && !!t.isLocal;
      for(let i = 0; i < pairs.length; i++){
        const src = pairs[i][0], dst = pairs[i][1], mask = pairs[i][2];
        /* Visibility follows the SOURCE, not just the setting. A part that has
           been hidden must not leave a striped ghost standing where it was. */
        const live = show && shown(src, t.root);
        /* `dst` is null for outlines — they mask and nothing else. */
        if(dst){
          if(live){
            dst.matrixWorld.copy(src.matrixWorld);
            dst.visible = true;
          } else {
            dst.visible = false;
          }
        }
        /* The stamp travels with the stripes, and is switched off with them:
           a hidden stamp would leave a stencil that nothing is allowed to draw
           into, erasing the stripes of whatever is behind it. */
        if(mask){
          if(live){
            mask.matrixWorld.copy(src.matrixWorld);
            mask.visible = true;
          } else {
            mask.visible = false;
          }
        }
      }
    }

    for(let i = _group.children.length - 1; i >= 0; i--){
      const c = _group.children[i];
      const owner = c.userData && c.userData.xrayOwner;
      if(!owner || !live.has(owner)) _group.remove(c);
    }
  }

  function detach(tank){
    if(!tank || !tank._xray) return;
    for(const p of tank._xray){
      if(p[1] && _group && p[1].parent === _group) _group.remove(p[1]);
      if(p[2] && _group && p[2].parent === _group) _group.remove(p[2]);
    }
    tank._xray = null;
  }

  function dispose(){
    if(_group){
      while(_group.children.length) _group.remove(_group.children[0]);
      if(_group.parent) _group.parent.remove(_group);
    }
    if(_mat && _mat.dispose){ try { _mat.dispose(); } catch(e){} }
    if(_maskMat && _maskMat.dispose){ try { _maskMat.dispose(); } catch(e){} }
    _group = null; _mat = null; _maskMat = null; _stencilTestOn = true; _u = null; _built = false; _scene = null;
  }

  /* The tests, and the settings screen, both need to know what exists. */
  function material(){ return build(); }
  function group(){ return _group; }
  function count(){ return _group ? _group.children.length : 0; }

  return { STYLES, DEFAULT_STYLE, PERIOD_CSS,
           init, attach, detach, sync, dispose,
           setStyle, setTime, setPixelRatio, setResolution, setColor, setOpacity,
           material, group, count };
})();