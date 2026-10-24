/* ============================================================================
   fireball.js — the explosion that plays when a tank is destroyed.

   WHAT IT IS
   A sphere that snaps open at the point of a blast, balloons fast, and burns
   through two flat colour stages — RED, then BLACK SMOKE. On top of that it
   carries the three things that make an explosion read as a DRAWN cartoon
   blast rather than a puff of smoke:

     1. LOBES   — the outline is pushed in and out by the noise in the vertex
                  stage, so the cloud grows in rounded puffs, the way a
                  hand-drawn explosion is built out of stacked blobs.
     2. INK     — the edge of the cloud is a dark line (cel shading), not a
                  soft glow.
     3. A RING  — a flat shock ring snaps outward in the first third of a
                  second, the way every cartoon explosion ever drawn does it.

   ONE TEXTURE, COLOURS FROM THE SHADER
   There is exactly one texture in here: a greyscale noise sheet. The sphere
   never changes its own texture and the texture is never re-tinted — every
   colour comes out of the shader, driven by how old the ball is. That is what
   keeps the fire and the smoke reading as the SAME cloud.

   TOON, NOT FADE
   The colours do not dissolve into each other. The two stages are separated by
   a hard step, so the ball reads like cel art: you can see exactly where one
   colour ends and the next begins. The noise is quantised into flat patches
   for the same reason — visible edges, not a soft gradient.

   TWO BACKENDS, ONE LOOK
   WebGL runs the GLSL below. WebGPU cannot run GLSL at all, so the same maths
   is transcribed into TSL (three's node language) further down; both are
   driven by the same uniform values, so an explosion looks the same either way.

   CLASSIC SCRIPT, NO `import`
   Like every other file in js/ this is injected as a classic script, and the
   TSL/WebGPU modules arrive through `await window.loadTSL()` (see index.html).
   ============================================================================ */

const Fireball = (() => {

  /* ---- the one and only texture: greyscale value noise ------------------- */
  let _noiseTex = null;
  function noiseTexture(){
    if(_noiseTex) return _noiseTex;
    const S = 256;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);

    // Lattice value noise, three octaves, wrapped so the sphere can sample the
    // same sheet from three axes without a visible seam.
    const P = 32;
    const lat = new Float32Array(P * P);
    for(let i = 0; i < P * P; i++) lat[i] = Math.random();
    const at = (x, y) => lat[((y % P) + P) % P * P + (((x % P) + P) % P)];
    const smooth = (x, y, freq) => {
      const fx = x * freq, fy = y * freq;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = at(x0, y0),     b = at(x0 + 1, y0);
      const d = at(x0, y0 + 1), e = at(x0 + 1, y0 + 1);
      const top = a + (b - a) * sx, bot = d + (e - d) * sx;
      return top + (bot - top) * sy;
    };

    for(let y = 0; y < S; y++){
      for(let x = 0; x < S; x++){
        const u = x / S, v = y / S;
        let n = smooth(u, v, 8) * 0.55 + smooth(u, v, 17) * 0.3 + smooth(u, v, 41) * 0.15;
        n = Math.max(0, Math.min(1, n));
        // Push the midtones apart so the shader's hard cuts have something to
        // bite into: soft, even noise would just look like fog.
        n = Math.pow(n, 1.25);
        const i = (y * S + x) * 4;
        const b = (n * 255) | 0;
        img.data[i] = b; img.data[i+1] = b; img.data[i+2] = b; img.data[i+3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    _noiseTex = new THREE.CanvasTexture(c);
    _noiseTex.wrapS = _noiseTex.wrapT = THREE.RepeatWrapping;
    _noiseTex.colorSpace = THREE.NoColorSpace;
    return _noiseTex;
  }

  /* ---- the flat stages --------------------------------------------------
     The ball burns through THREE stages now: a hot YELLOW at the instant of
     the blast, RED once the fire settles, then BLACK COAL SMOKE. Two crisp cuts
     instead of one.

     The order is the point. A real blast is yellow-white at the core for the
     first instants, red as the fire ball loses its heat, and black once it is
     soot. Starting straight at red skipped the hottest moment entirely, which
     is why the old ball read as "a red puff" rather than "something detonated".

     The colours are deliberately DEEP and SATURATED. An earlier version ran a
     pale white-hot core and a soft orange, and sampled straight off the
     framebuffer it came out at RGB 175,148,92 next to ground at 188,189,193 --
     a difference you cannot spot across a screen. The yellow in particular has
     to be a deep gold rather than a pale cream, because a light map is already
     sitting right behind it. Fire must out-saturate its own background. */
  const RAMP = {
    yellow: [1.00, 0.72, 0.06],  /* hot yellow core    */
    red:   [1.00, 0.09, 0.02],   /* burning red        */
    coal:  [0.05, 0.045, 0.04],  /* black coal smoke   */
    glow:  [1.00, 0.26, 0.05],   /* rim light          */
    ink:   [0.05, 0.04, 0.04],   /* the drawn edge     */
  };
  /* yellow -> red */
  const CUT_FIRE  = 0.30;
  /* red -> soot. Pushed later than the old single 0.45 cut so the red stage
     actually gets room to be seen now that yellow sits in front of it. */
  const CUT_SMOKE = 0.58;
  const CUT_GLOW  = 0.34;         /* when the rim light dies */

  /* ---- GLSL (WebGL) ----------------------------------------------------- */
  const VS = `
    varying vec3 vDir;
    varying vec3 vWorldNormal;
    varying vec3 vViewDir;
    varying float vLobe;
    uniform sampler2D uNoise;
    uniform float uTime;
    uniform float uProg;
    uniform float uSeed;
    void main(){
      vDir = normalize(position);
      /* 1. LOBES — the same noise that colours the ball also pushes its
         outline in and out here, so the cloud grows in rounded puffs instead
         of staying a smooth sphere. Two scales of noise read as the stacked
         blobs every hand-drawn explosion is built from. */
      vec3 q = normalize(vDir + vec3(uSeed));
      float l1 = texture2D(uNoise, q.xz * 0.5 + 0.5 + vec2( 0.13,  0.09) * uTime).r;
      float l2 = texture2D(uNoise, q.xy * 0.5 + 0.5 + vec2(-0.11,  0.07) * uTime).r;
      float l3 = texture2D(uNoise, q.zy * 0.5 + 0.5 + vec2( 0.08, -0.12) * uTime).r;
      vLobe = l1 * 0.42 + l2 * 0.32 + l3 * 0.26;
      float amp = 0.12 + 0.40 * smoothstep(0.0, 0.45, uProg);
      vec3 disp = position + normal * ((vLobe - 0.5) * amp);

      vec4 wp = modelMatrix * vec4(disp, 1.0);
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
      vViewDir = normalize(cameraPosition - wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const FS = `
    precision highp float;
    varying vec3 vDir;
    varying vec3 vWorldNormal;
    varying vec3 vViewDir;
    varying float vLobe;
    uniform sampler2D uNoise;
    uniform float uTime;
    uniform float uProg;      /* 0 = the instant of the blast, 1 = gone */
    uniform float uSeed;

    /* a hard step with a thin feather: the colour ends at a line, it does not
       fade out over half the ball */
    float cut(float x, float at, float f){ return smoothstep(at - f, at + f, x); }

    /* quantise into flat patches — cel shading */
    float bands(float x, float levels, float f){
      float s = x * (levels - 1.0);
      float fl = floor(s);
      return clamp((fl + smoothstep(0.5 - f, 0.5 + f, s - fl)) / (levels - 1.0), 0.0, 1.0);
    }

    void main(){
      vec3 p = normalize(vDir + vec3(uSeed));
      float t = uTime;
      float n1 = texture2D(uNoise, p.xz * 0.5 + 0.5 + vec2( 0.13,  0.09) * t).r;
      float n2 = texture2D(uNoise, p.xy * 0.5 + 0.5 + vec2(-0.11,  0.07) * t).r;
      float n3 = texture2D(uNoise, p.zy * 0.5 + 0.5 + vec2( 0.08, -0.12) * t).r;
      float n  = n1 * 0.40 + n2 * 0.32 + n3 * 0.28;

      float burn = smoothstep(0.05, 0.58, uProg);
      /* The cut line RISES as the ball ages: solid at the blast, then the
         sheet is eaten into by whatever noise is above it, until the smoke is
         a ragged cloud instead of a black ball with a clean silhouette. */
      float a = cut(n + (1.0 - burn) * 0.42, 0.28 + burn * 0.26, 0.035);
      a *= 1.0 - smoothstep(0.90, 1.0, uProg);     /* only the very end fades */
      float tone = bands(n, 4.0, 0.045);           /* flat patches inside */

      float fres = pow(1.0 - abs(dot(normalize(vWorldNormal), normalize(vViewDir))), 1.6);
      a = clamp(a + fres * (1.0 - burn) * 0.60, 0.0, 1.0);

      /* THE ramp — YELLOW, then RED, then BLACK. Two crisp cuts, no dissolve.
         The first cut is deliberately early and narrow-feathered: the yellow is
         the first instants of the blast, so it has to read as a FLASH of a
         stage, not as half the ball's life. */
      vec3 yellow = vec3(__YELLOW__);
      vec3 red  = vec3(__RED__);
      vec3 coal = vec3(__COAL__);
      vec3 fire = mix(yellow, red, cut(uProg, __CUT_FIRE__, 0.03));
      vec3 col = mix(fire, coal, cut(uProg, __CUT_SMOKE__, 0.035));
      col += vec3(__GLOW__) * fres * (1.0 - cut(uProg, __CUT_GLOW__, 0.04)) * 1.1;
      col *= 0.40 + 0.60 * tone;

      /* 2. INK — cel shading: the silhouette is a drawn dark line, so the
         cloud keeps a hard readable edge against the light map. */
      float ink = 1.0 - smoothstep(0.05, 0.42, abs(dot(normalize(vWorldNormal), normalize(vViewDir))));
      col = mix(col, vec3(__INK__), ink * 0.80);

      /* THE HIT: a hot flash over the first few hundredths of a second, so the
         frame the tank dies is the loudest frame of the whole effect. */
      col += vec3(__GLOW__) * 1.6 * (1.0 - cut(uProg, 0.05, 0.02));

      float body2 = mix(0.96, 0.82, cut(uProg, __CUT_SMOKE__, 0.035));
      gl_FragColor = vec4(col, a * (body2 + 0.06 * (1.0 - uProg)));
    }
  `
    /* GLOBAL replacement, every occurrence. String.replace() with a string
       pattern only ever replaces the FIRST one, and a token used twice used to
       survive as literal text — invalid GLSL that made the fireball silently
       draw nothing at all. */
    .split('__YELLOW__').join(RAMP.yellow.join(', '))
    .split('__RED__').join(RAMP.red.join(', '))
    .split('__COAL__').join(RAMP.coal.join(', '))
    .split('__GLOW__').join(RAMP.glow.join(', '))
    .split('__INK__').join(RAMP.ink.join(', '))
    .split('__CUT_FIRE__').join(CUT_FIRE.toFixed(3))
    .split('__CUT_SMOKE__').join(CUT_SMOKE.toFixed(3))
    .split('__CUT_GLOW__').join(CUT_GLOW.toFixed(3));

  /* ---- TSL twin (WebGPU) ------------------------------------------------ */
  function buildTSL(tex, u){
    const T = window.TSL, W = window.WebGPU;
    const { vec2, vec3, vec4, float, mix, smoothstep, clamp, pow, floor, fract, dot, abs,
            positionGeometry, normalGeometry, normalWorld, positionWorld, cameraPosition,
            uv, texture } = T;

    const uProg = u.uProg, t = u.uTime, uSeed = u.uSeed;

    /* The same two helpers as the GLSL, written so the thresholds are always
       PLAIN NUMBERS — wrapping a live node in float() made three emit WGSL it
       could not parse, and the ball silently vanished on WebGPU. */
    const cutN = (x, atNode, f) => smoothstep(atNode.sub(f), atNode.add(f), x);
    const cutF = (x, at, f)      => smoothstep(float(at - f), float(at + f), x);
    const bands = (x, levels, f) => {
      const s = x.mul(levels - 1);
      const fl = floor(s);
      const r = fract(s);
      const e = smoothstep(float(0.5 - f), float(0.5 + f), r);
      return clamp( fl.add(e).div(levels - 1), 0.0, 1.0 );
    };
    // three drifting sheets of the same noise, on the same three axes
    const sheet = (sel, off) => texture(tex, uv(sel.mul(0.5).add(0.5).add(vec2(off[0], off[1]).mul(t)))).r;

    const q  = positionGeometry.normalize().add(vec3(uSeed, uSeed.mul(0.5), uSeed.mul(0.25)));
    const l1 = sheet(q.xz, [0.13, 0.09]);
    const l2 = sheet(q.xy, [-0.11, 0.07]);
    const l3 = sheet(q.zy, [0.08, -0.12]);
    const lobe = l1.mul(0.42).add(l2.mul(0.32)).add(l3.mul(0.26));

    /* 1. LOBES — displace the surface by the same noise the colour uses */
    const amp = float(0.12).add( float(0.40).mul( smoothstep(float(0.0), float(0.45), uProg) ) );
    const displaced = positionGeometry.add( normalGeometry.mul( lobe.sub(0.5).mul(amp) ) );

    const n  = l1.mul(0.40).add(l2.mul(0.32)).add(l3.mul(0.28));
    const burn = smoothstep(float(0.05), float(0.58), uProg);
    const cutLine = burn.mul(0.26).add(0.28);
    let a = cutN( n.add(float(1).sub(burn).mul(0.42)), cutLine, 0.035 );
    a = a.mul( float(1).sub(smoothstep(float(0.90), float(1.0), uProg)) );
    const tone = bands(n, 4.0, 0.045);

    const vd = positionWorld.sub(cameraPosition).normalize();
    const facing = abs(dot(normalWorld, vd));
    const fres = pow( clamp( float(1).sub(facing), 0.0, 1.0 ), 1.6 );
    a = clamp( a.add( fres.mul( float(1).sub(burn) ).mul(0.60) ), 0.0, 1.0 );

    const yellow = vec3(...RAMP.yellow);
    const red  = vec3(...RAMP.red);
    const coal = vec3(...RAMP.coal);
    const glow = vec3(...RAMP.glow);
    const ink  = vec3(...RAMP.ink);
    const toRed   = cutF(uProg, CUT_FIRE,  0.03);
    const toSmoke = cutF(uProg, CUT_SMOKE, 0.035);
    const noGlow  = cutF(uProg, CUT_GLOW,  0.04);
    /* Same three stages as the GLSL: yellow flash, then red fire, then soot. */
    const fire = mix(yellow, red, toRed);
    let col = mix(fire, coal, toSmoke);
    col = col.add( glow.mul( fres ).mul( float(1).sub(noGlow) ).mul(1.1) );
    col = col.mul( float(0.40).add( tone.mul(0.60) ) );
    /* 2. INK — the same drawn edge */
    const inkAmt = float(1).sub( smoothstep(float(0.05), float(0.42), facing) );
    col = mix(col, ink, inkAmt.mul(0.80));

    const body2 = mix( float(0.96), float(0.82), toSmoke );
    // The same first-frame hit flash as the GLSL above.
    col = col.add( glow.mul(1.6).mul( float(1).sub( cutF(uProg, 0.05, 0.02) ) ) );
    const mat = new W.MeshBasicNodeMaterial();
    mat.positionNode = displaced;
    mat.colorNode = vec4(col, a.mul( body2.add( float(0.06).mul( float(1).sub(uProg) ) ) ));
    mat.transparent = true;
    mat.depthWrite  = false;
    mat.side        = THREE.DoubleSide;
    mat.toneMapped  = false;
    return mat;
  }

  /* ---- the ball + the shock ring ---------------------------------------- */
  const LIFE = 1.45;          /* seconds, blast -> last wisp of smoke */
  const POOL = 4;
  const RING_LIFE = 0.30;     /* the ring is over before the cloud is */

  class FireballFX {
    constructor(scene, useTSL){
      this.scene = scene;
      // A ball wants LOBES, so it needs enough segments to show them: the old
      // 24x18 sphere could not carry a readable silhouette.
      this.geo = new THREE.SphereGeometry(1, 40, 28);
      this.ringGeo = new THREE.RingGeometry(0.72, 1.0, 40);
      this.ringMat = new THREE.MeshBasicMaterial({
        color: RAMP.glow[0], transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      });
      this.balls = [];
      for(let i = 0; i < POOL; i++){
        this.balls.push({ mesh: null, ring: null, uniforms: null, life: 0, maxLife: LIFE, seed: 0, size: 8 });
      }
      this._useTSL = useTSL;
      this._tex = noiseTexture();
    }

    /* Every ball owns its own material, and therefore its own uProg / uTime /
       uSeed: two blasts in the air at once have to be able to sit at different
       stages. They all compile to the SAME shader program, so this costs four
       uniform buffers and no extra compiles. */
    _material(){
      if(this._useTSL && window.TSL && window.WebGPU){
        const nodes = {
          uTime: window.TSL.uniform(0),
          uProg: window.TSL.uniform(0),
          uSeed: window.TSL.uniform(0),
        };
        return { mat: buildTSL(this._tex, nodes), uniforms: nodes };
      }
      /* A leftover __TOKEN__ means invalid GLSL: the ball would silently fail
         to draw. Catch it here, where it can still be fixed. */
      if(/__[A-Z_]+__/.test(FS) || /__[A-Z_]+__/.test(VS)){
        console.error('[fireball] shader still has unreplaced tokens');
      }
      const uniforms = {
        uNoise: { value: this._tex },
        uTime:  { value: 0 },
        uProg:  { value: 0 },
        uSeed:  { value: 0 },
      };
      const mat = new THREE.ShaderMaterial({
        vertexShader: VS,
        fragmentShader: FS,
        uniforms: uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        toneMapped: false,
      });
      return { mat: mat, uniforms: uniforms };
    }

    spawn(x, y, z, size){
      let b = this.balls.find(v => !v.mesh || !v.mesh.visible);
      if(!b) b = this.balls[0];                 // every slot busy: reuse one
      if(!b.mesh){
        const m = this._material();
        b.uniforms = m.uniforms;
        b.mesh = new THREE.Mesh(this.geo, m.mat);
        b.mesh.frustumCulled = false;
        b.mesh.renderOrder = 998;
        b.mesh.visible = false;
        this.scene.add(b.mesh);
        // 3. the shock ring, flat on the ground
        b.ring = new THREE.Mesh(this.ringGeo, this.ringMat);
        b.ring.rotation.x = -Math.PI / 2;
        b.ring.frustumCulled = false;
        b.ring.renderOrder = 997;
        b.ring.visible = false;
        this.scene.add(b.ring);
      }
      b.life = 0;
      b.maxLife = LIFE * (0.85 + Math.random() * 0.3);
      b.size = size || 8;
      b.seed = Math.random();
      b.mesh.visible = true;
      b.mesh.position.set(x, y, z);
      b.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      /* It has to be THERE on the frame the tank dies — at full blast, not
         swelling into being. It was still arriving "a bit late" at half size,
         because the eye reads a small ball as nothing having happened yet and
         only registers the cloud once it is big. So it opens at full size and
         the remaining life is just the smoke creeping outward. */
      b.mesh.scale.set(b.size, b.size * 0.86, b.size);
      b.ring.visible = true;
      b.ring.position.set(x, Math.max(0.06, y - b.size * 0.14), z);
      b.ring.scale.set(b.size * 0.7, b.size * 0.7, b.size * 0.7);
      return b;
    }

    update(dt){
      for(const b of this.balls){
        if(!b.mesh || !b.mesh.visible) continue;
        b.life += dt;
        const k = b.life / b.maxLife;
        if(k >= 1){
          b.mesh.visible = false;
          if(b.ring) b.ring.visible = false;
          continue;
        }
        // The ring is a SNAP: it is nearly over in a third of a second, while
        // the cloud is still opening. That contrast is the whole joke.
        if(b.ring && b.ring.visible){
          const rk = b.life / RING_LIFE;
          if(rk >= 1){
            b.ring.visible = false;
          } else {
            const rs = b.size * (0.7 + 1.5 * (1 - Math.pow(1 - rk, 2.2)));
            b.ring.scale.set(rs, rs, rs);
            b.ringMat.opacity = (1 - rk) * (1 - rk) * 0.9;
          }
        }
        // Already at full size on frame one; from there it only creeps
        // outward as smoke turns to soot.
        const grow = 1 + k * 0.55;
        const s = b.size * grow;
        b.mesh.scale.set(s, s * 0.86, s);           /* squashed: a bloom, not a ball */
        b.mesh.position.y += dt * b.size * 0.10;    /* smoke lifts */
        b.mesh.rotation.y += dt * 0.35;
        const u = b.uniforms;
        if(u){
          u.uProg.value = Math.min(1, k);
          u.uTime.value += dt;
          u.uSeed.value = b.seed;
        }
      }
    }

    clear(){
      for(const b of this.balls){
        if(b.mesh) b.mesh.visible = false;
        if(b.ring) b.ring.visible = false;
      }
    }
  }

  return {
    /* Lazily built once per battle. */
    get(scene){
      if(!this._fx) this._fx = new FireballFX(scene, !!window.__isWebGPU);
      return this._fx;
    },
    spawn(scene, x, y, z, size){
      try { return this.get(scene).spawn(x, y, z, size); }
      catch(e){ return null; }
    },
    update(scene, dt){
      if(!this._fx) return;
      try { this._fx.update(dt); } catch(e){}
    },
    clear(){
      if(this._fx) this._fx.clear();
    },
  };
})();

if (typeof window !== 'undefined') window.Fireball = Fireball;
