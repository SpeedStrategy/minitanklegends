/* ============================================================
   video-vfx.js — Chroma-key video VFX for Three.js

   Plays a video on a quad with a shader that discards two
   background colors (the two colors used to create the
   transparent background effect). Works on all platforms
   (no WebM alpha needed).

   Usage:
     const vfx = VideoVFX.create({
       src: 'assets/vfx/explosion.mp4',
       width: 4, height: 4,
       chroma1: [0.0, 1.0, 0.0],   // green (RGB 0-1)
       chroma2: [0.0, 0.0, 0.0],   // black
       threshold: 0.25,             // tolerance per channel
       loop: false,
       playbackRate: 1,
       parent: scene,
       position: new THREE.Vector3(0, 1, 0),
       duration: 2,                 // auto-remove after seconds (0 = manual)
     });
     vfx.play();
     vfx.remove();                  // manual cleanup

   VideoTexture uploads are capped at VideoVFX.maxUploadHz
   (45 by default). Set it to 0 to turn pacing off entirely.
   ============================================================ */

const VideoVFX = {

  _active: [],

  /* ── UPLOAD CAP ──────────────────────────────────────────────────────────
     The ceiling on how often a VideoTexture's pixels may be re-sent to the
     GPU, in uploads per second. 45 is the default; 0 (or anything <= 0)
     disables pacing and restores three's own behaviour exactly.

     WHY A CAP IS WORTH HAVING — and it is NOT the reason usually quoted for
     it, which is worth being straight about, because a comment that lies
     about the code above it is worse than no comment.

     The usual story is "r128's VideoTexture re-uploads the whole decoded frame
     on every rendered frame, so a 30fps clip is uploaded 60 times a second".
     Checked against the actual r128 source, r128 does not do that. Its
     constructor already registers a requestVideoFrameCallback whose entire body
     is `scope.needsUpdate = true`, and update() only sets needsUpdate
     unconditionally in the branch where rVFC is MISSING:

         if (hasVideoFrameCallback === false &&
             video.readyState >= video.HAVE_CURRENT_DATA)
                 this.needsUpdate = true;

     r185 — which index.html actually loads; the r128 tag only survives in
     index.r128.backup.html and tank-party.html — does the same thing and also
     stores the rVFC handle so dispose() can cancel it. So on any browser with
     rVFC (Chrome, Edge, Firefox, Safari 15.4+) a 30fps clip already uploads
     about 30 times a second and the "2x wasted" claim is simply false there.

     What IS real is the ceiling. WebGLTextures.updateVideoTexture() calls
     texture.update() once per RENDER frame, and setTexture2D() re-uploads
     whenever texture.version has moved — so a VideoTexture is uploaded at most
     once per rendered frame, i.e. once per 1/refreshRate. Any clip whose real
     frame rate reaches the refresh rate therefore uploads a full RGBA picture
     every single frame. That is not a hypothetical in this game: the helix
     strip runs at playbackRate = 5, so a 30fps source presents up to 150
     frames a second and saturates the 60Hz upload ceiling on its own.

     So: 45 against a 60Hz render is a 25% cut in video-texture upload
     bandwidth for every effect sitting over the cap, and an exact no-op for
     the ones already under it. The no-op is the correct outcome, not a missed
     optimisation — an 11ms explosion has nothing to upload at 45Hz and should
     not be made to pretend otherwise. */
  maxUploadHz: 45,

  /* ── PLANE GEOMETRY CACHE ────────────────────────────────────────────────
     Every VFX is a PlaneGeometry(w, h) and nothing ever mutates one, so the
     geometry is interchangeable between effects of the same size. They were
     being rebuilt and thrown away per effect before; in a fight that is a
     GL buffer create + delete per explosion, which is a driver call on the
     render thread's critical path.

     Slots are reference counted rather than kept on a free list. That is the
     part that matters for safety: _destroy() used to dispose the geometry, and
     that was only ever safe because each effect owned a private copy. With a
     shared copy, disposing on release would delete the vertex buffer out from
     under every other live quad of that size — a crash or an invisible
     explosion depending on the driver. `uses` makes it impossible to dispose
     something that is still on screen. */
  _geoCache: new Map(),
  _GEO_CACHE_MAX: 16,

  create(opts) {
    const src      = opts.src || '';
    const w        = opts.width || 2;
    const h        = opts.height || 2;
    const c1       = opts.chroma1 || [0, 1, 0];   // first discard color
    const c2       = opts.chroma2 || [0, 0, 0];   // second discard color
    const thresh   = opts.threshold != null ? opts.threshold : 0.25;
    const loop     = !!opts.loop;
    const rate     = opts.playbackRate || 1;
    const parent   = opts.parent;
    const pos      = opts.position || new THREE.Vector3();
    const rotation = opts.rotation || null;         // Euler or null
    const duration = opts.duration || 0;
    const blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    const opacity  = opts.opacity != null ? opts.opacity : 1;

    // HTML video element
    const el = document.createElement('video');
    el.src = src;
    el.muted = true;
    el.loop = loop;
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.playbackRate = rate;
    el.play().catch(() => {});

    // Video texture
    const tex = new THREE.VideoTexture(el);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;

    // Paced, so the decoder cannot drive the render thread at its own rate.
    // See paceTexture() for what is actually being intercepted.
    const pacer = this.paceTexture(tex, el);

    // Geometry — shared with every other effect of the same size.
    const slot = this._acquirePlane(w, h);

    /* Materials are deliberately NOT pooled, unlike the geometry and unlike the
       sprite pool in game.js. Each effect carries its own opacity and its own
     chroma-key uniforms, and those are read every frame: one shared material
     would mean one explosion fading another one out. The chroma values are
     also baked into per-instance uniforms, so a reuse would have to overwrite
     the live effect's key colour with the next one's. */

    // Material with chroma-key discard shader
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: opacity,
      blending: blending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    mat.onBeforeCompile = (shader) => {
      // Inject uniforms at the top of the fragment shader
      const uDeclare = `
        uniform vec3 uChroma1;
        uniform vec3 uChroma2;
        uniform float uThreshold;
      `;
      // Prepended rather than spliced around "void main() {": three adds its own
      // prefix later, so top-of-file declarations are always legal GLSL.
      shader.fragmentShader = uDeclare + shader.fragmentShader;

      // Set the uniform values
      shader.uniforms.uChroma1  = { value: new THREE.Color(c1[0], c1[1], c1[2]) };
      shader.uniforms.uChroma2  = { value: new THREE.Color(c2[0], c2[1], c2[2]) };
      shader.uniforms.uThreshold = { value: thresh };

      // Chroma-key discard, injected just before three's output chunk (see
      // window.glslInject in index.html for why the literal line is gone).
      shader.fragmentShader = window.glslInject(
        shader.fragmentShader,
        `float d1 = distance(outgoingLight, uChroma1);
         float d2 = distance(outgoingLight, uChroma2);
         if(d1 < uThreshold || d2 < uThreshold) discard;`
      );
    };

    const mesh = new THREE.Mesh(slot.geo, mat);
    mesh.position.copy(pos);
    if (rotation) mesh.rotation.copy(rotation);
    mesh.renderOrder = 999;
    if (parent) parent.add(mesh);

    const entry = {
      mesh, mat, tex, el, parent,
      startTime: performance.now(),
      duration: duration * 1000,
      alive: true,
      // private bookkeeping, not part of the shape game.js reads
      _geoSlot: slot,
      _pacer: pacer,
    };

    this._active.push(entry);
    return entry;
  },

  /* Update loop — call from game animate() */
  update() {
    const now = performance.now();
    for (let i = this._active.length - 1; i >= 0; i--) {
      const e = this._active[i];
      if (!e.alive) continue;

      // Auto-remove after duration
      if (e.duration > 0 && (now - e.startTime) > e.duration) {
        this._destroy(e);
        this._active.splice(i, 1);
      }
    }
  },

  /* Force-remove a specific VFX entry */
  remove(entry) {
    const idx = this._active.indexOf(entry);
    if (idx !== -1) {
      this._destroy(entry);
      this._active.splice(idx, 1);
    }
  },

  /* Remove all active VFX */
  removeAll() {
    for (const e of this._active) this._destroy(e);
    this._active.length = 0;
  },

  _destroy(e) {
    e.alive = false;
    if (e.parent && e.mesh) e.parent.remove(e.mesh);

    /* The geometry goes back to the cache rather than being disposed — see the
       _geoCache comment above. Disposing it here is the one change from the
       old code that could have produced garbage on screen, because it is now
       shared. The material is still private to this effect, so it still goes. */
    if (e.mesh) e.mesh.material.dispose();
    this._releasePlane(e);
    this._trimGeoCache();

    if (e.tex) {
      /* Take the pacing shadow off before disposing. The accessor holds a
         closure over the <video> element, so leaving it installed would keep a
         dead element reachable through a disposed texture. delete falls back
         to Texture.prototype's own accessor, i.e. exactly three's behaviour. */
      this._unpaceTexture(e.tex, e.el, e._pacer);
      e.tex.dispose();
    }
    if (e.el) { e.el.pause(); e.el.src = ''; }
  },

  /* ── PLANE GEOMETRY CACHE ────────────────────────────────────────────────*/

  _acquirePlane(w, h) {
    // Keyed on w/h rounded to 2dp: sizes come from callers as arbitrary floats,
    // and a 1e-7 difference in width is not a difference anybody can see, but
    // it would miss the cache every time and rebuild the buffer every time.
    const key = Math.round(w * 100) / 100 + 'x' + Math.round(h * 100) / 100;
    let slot = this._geoCache.get(key);
    if (!slot) {
      slot = { key, geo: new THREE.PlaneGeometry(w, h), uses: 0 };
      this._geoCache.set(key, slot);
    }
    slot.uses++;
    return slot;
  },

  _releasePlane(e) {
    const slot = e && e._geoSlot;
    if (!slot) return;
    if (slot.uses > 0) slot.uses--;
    e._geoSlot = null;
  },

  /* Keep the cache bounded. Only slots with uses === 0 are eligible, so this
     can never dispose the geometry of a quad that is still in the scene; if
     every slot is live the cache is allowed to sit above the limit for now and
     the next acquire trims it again. Iteration is insertion-ordered, so the
     oldest free slot goes first. */
  _trimGeoCache() {
    while (this._geoCache.size > this._GEO_CACHE_MAX) {
      let freed = false;
      for (const slot of this._geoCache.values()) {
        if (slot.uses > 0) continue;
        slot.geo.dispose();
        this._geoCache.delete(slot.key);
        freed = true;
        break;
      }
      if (!freed) return;   // everything is in use; nothing safe to trim
    }
  },

  /* ── FRAME PACING ────────────────────────────────────────────────────────
     Exposed rather than kept private because game.js builds its OWN VideoTextures
     outside this module — _createVideoPlane() and _ensureHelixVideo() — and
     those are the ones that actually run several at a time. Anything that owns
     a <video> + VideoTexture can hand both to this and get the same cap:

         const pacer = VideoVFX.paceTexture(tex, el);

     WHAT IS INTERCEPTED, AND WHY IT IS NOT VideoTexture.update()

     update() is the obvious hook and it is the wrong one, because it is not
     the only writer. VideoTexture's constructor registers its own
     requestVideoFrameCallback whose whole body is `scope.needsUpdate = true`,
     and that closure captures the texture directly — it never calls update(),
     so anything gated inside update() is simply written around.

     The real hook is `needsUpdate` itself. It is an accessor on
     Texture.prototype in both revisions this game ships (r128:
     `if (value === true) this.version++`; r185: the same plus
     `this.source.needsUpdate = true`), and its entire effect is to bump
     `version` — which is precisely the value WebGLTextures.setTexture2D()
     caches as __version and compares against to decide whether to re-upload.
     Shadowing it with an own accessor on the one texture therefore intercepts
     every route to an upload: three's rVFC, the no-rVFC branch inside
     update(), and anything else that asks. Own-property rather than prototype
     so the blast radius is this texture and nothing else. */
  paceTexture(tex, el) {
    const self = this;

    const pacer = {
      last:     performance.now(),  // for refilling the bucket
      tokens:   1,          // start with one, so the very first frame always uploads
      seenTime: -1,         // el.currentTime at the last granted upload
      pending:  false,      // a decoded frame is waiting to be shown
      rvfc:     !!(el && typeof el.requestVideoFrameCallback === 'function'),
      rvfcId:   0,
      dead:     false,
      uploads:  0,          // telemetry: granted uploads
      skips:    0,          // telemetry: writes refused by the cap
    };

    Object.defineProperty(tex, 'needsUpdate', {
      configurable: true,
      get() { return this.version > 0; },
      set(value) {
        if (value !== true) return;
        self._pacerTick(pacer, tex, el);
      },
    });
    tex.__vfxPacer = pacer;

    /* rVFC is the correct "a new frame really landed" signal — it fires when a
       frame is submitted for composition, not on a timer, so it cannot be
       fooled by a decoder that is merely still catching up. Chrome, Edge,
       Firefox and Safari 15.4+ all have it. */
    if (pacer.rvfc) {
      const step = () => {
        if (pacer.dead) return;
        pacer.pending = true;
        /* The grant happens HERE rather than only setting `pending`, because
           whether three registers an rVFC of its own for a VideoTexture is a
           property of the revision, not of this file. Both r128 and r185 do it
           today, so the flag alone would be enough — but a build that did not
           would leave this texture frozen on its first frame with nothing to
           indicate why, and that failure is silent. Granting from our own
           callback means the cap works with or without three's. */
        self._pacerTick(pacer, tex, el);
        pacer.rvfcId = el.requestVideoFrameCallback(step);
      };
      pacer.rvfcId = el.requestVideoFrameCallback(step);
    }

    return pacer;
  },

  _unpaceTexture(tex, el, pacer) {
    if (pacer) {
      pacer.dead = true;
      // Without this the callback re-arms itself forever, holding the disposed
      // texture and the <video> element alive for the rest of the session.
      if (pacer.rvfcId && el && typeof el.cancelVideoFrameCallback === 'function') {
        try { el.cancelVideoFrameCallback(pacer.rvfcId); } catch (e) {}
      }
      pacer.rvfcId = 0;
    }
    if (tex) delete tex.needsUpdate;
  },

  /* Decide whether a write to needsUpdate turns into an actual upload, and if
     so bump version (which is what the renderer watches). */
  _pacerTick(pacer, tex, el) {
    /* FIRST: is there actually anything new to show?
       With rVFC this is just a flag read — our callback set it when the decoder
       presented a frame. Without it, the only caller is three's update(),
       which fires once per render frame whether or not the decoder produced
       anything, so "has it advanced" has to be answered by hand from
       currentTime.

       That comparison is also what stops a dead effect from spinning the
       renderer: a paused video does not advance currentTime, and a finished
       one sits on its last value forever, so neither can produce another
       upload. They keep drawing the frame they last had, which is what a
       finished explosion should do anyway. */
    if (pacer.rvfc) {
      if (!pacer.pending) return;
    } else {
      if (!el || el.readyState < el.HAVE_CURRENT_DATA) return;
      if (el.currentTime === pacer.seenTime) return;
    }

    /* SECOND: the cap, as a token bucket and NOT as a minimum interval between
       uploads. The interval formulation looks equivalent and is not: at 45Hz
       the gap is 22.22ms, a 60Hz render frame is 16.67ms, and a plain
       "at least 22.22ms since the last one" test can therefore only ever fire
       on every SECOND frame — 30 uploads a second, not 45. The player asked for
       45 and this would have silently delivered 30.

       Refilling a bucket and spending one token per upload fixes it: 45 tokens
       a second is 0.75 tokens per 60Hz frame, so four of every five frames
       upload and the average lands on 45 exactly, with the odd pair of
       back-to-back uploads that any rate this close to the refresh rate needs.

       Accumulation is clamped to 2 tokens so a stall — a tab switch, a GC pause,
       a frame that took 300ms — cannot bank enough credit to upload a dozen
       frames in a row afterwards.

       Checked after freshness rather than before, because a write refused here
       must NOT spend the token it was carrying: otherwise a genuinely new frame
       arriving 1ms after a refusal would wait a further 22ms for nothing. */
    const hz = this.maxUploadHz;
    if (hz > 0) {
      const now = performance.now();
      const dt = now - pacer.last;
      pacer.last = now;
      // performance.now() is monotonic, but a negative dt would mint tokens.
      if (dt > 0) pacer.tokens = Math.min(2, pacer.tokens + (dt * hz) / 1000);
      if (pacer.tokens < 1) { pacer.skips++; return; }
      pacer.tokens -= 1;
    }

    if (!pacer.rvfc) pacer.seenTime = el.currentTime;
    pacer.pending = false;
    pacer.uploads++;
    tex.version++;
    // r185's setter flags the Source as well; r128's Texture has no `source`.
    if (tex.source) tex.source.needsUpdate = true;
  },
};