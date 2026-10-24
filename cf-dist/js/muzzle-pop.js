/* ============================================================================
   muzzle-pop.js — the blast at the barrel every time a tank fires.

   WHAT IT IS
   A small cartoon cloud of fire that snaps on at the muzzle: WHITE in the
   middle with a RED band around the edge, ringed by a drawn dark outline, and
   then — almost immediately — it cools to BLACK COAL SMOKE, which drifts
   slowly up and along the barrel and finally thins out.

   It is built with exactly the technique that makes the explosion work, just
   tuned for a muzzle:

     1. LOBES — the same noise that colours the cloud also pushes its surface
        in and out, so it is a lumpy pile of puffs rather than a smooth ball.
        That is how a hand-drawn fireball is constructed: stacked blobs.
     2. HARD COLOUR CUTS — white, red and coal are separated by steps, never
        dissolved into one another. The colours do not fade into each other;
        one stops and the next begins, which is what "cartoon" means here.
     3. BANDED SHADING — the noise is quantised into flat patches, so the
        inside of the cloud is chunky and drawn rather than a soft airbrush.
     4. INK — a dark line around the silhouette, so the cloud keeps a crisp
        readable edge against a light battlefield instead of melting into it.

   WHY IT IS A SHADER AND NOT A PICTURE
   A flat billboard can never sit in the world: it would float over rocks, sit
   flat against the ground, and turn with the camera like a sticker. As a real
   deformed sphere it is foreshortened properly, goes behind scenery, and
   catches the eye the way the explosion does.

   COST
   The muzzle is the most-used effect in the game, so it is capped and pooled:
   a fixed set of clouds is created once and recycled, the oldest being reused
   once the cap is reached. Shots too far away to see are skipped entirely, and
   every cloud is built and drawn once at battle start so the first shot of a
   match never stalls while a shader is compiled.

   TWO BACKENDS, ONE LOOK
   WebGL runs the GLSL below; WebGPU cannot run GLSL, so the same maths is
   transcribed into TSL (three's node language) further down. Both are driven
   by the same uniforms.

   CLASSIC SCRIPT, NO `import`
   Like every other file in js/ this is a classic script; TSL arrives through
   `window.TSL` (see index.html).
   ============================================================================ */

const MuzzlePop = (() => {

  /* ---- the one and only texture: greyscale value noise ------------------- */
  let _noiseTex = null;
  function noiseTexture(){
    if(_noiseTex) return _noiseTex;
    const S = 128;                       /* smaller than the explosion's: there
                                            are far more of these on screen */
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);

    const P = 16;
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
        let n = smooth(u, v, 6) * 0.55 + smooth(u, v, 13) * 0.3 + smooth(u, v, 29) * 0.15;
        n = Math.max(0, Math.min(1, n));
        n = Math.pow(n, 1.25);   /* push midtones apart so the cuts bite */
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

  /* ---- the colours ------------------------------------------------------- */
  const RAMP = {
    white:  [1.00, 0.99, 0.97],  /* the hot middle — a true white, not cream */
    yellow: [1.00, 0.80, 0.10],  /* the band around that middle               */
    orange: [1.00, 0.42, 0.03],  /* a third stage, so it has depth            */
    coal:   [0.055, 0.050, 0.045], /* what it cools to                       */
    glow:   [1.00, 0.62, 0.12],  /* rim light on the first frames             */
    ink:    [0.05, 0.04, 0.04],  /* the drawn outline                        */
  };

  /* ---- timing ------------------------------------------------------------ */
  /* The whole sequence - flash, cool-down, smoke - is driven by uProg mapped
     from this life, so halving it plays the same show twice as fast. The user
     asked for exactly that: the flash is out of your face in half the time. */
  const LIFE      = 0.75;    /* total: flash, then the coal hanging in the air */

  /* How long the cloud stays GLUED to the gun, as a fraction of its life.
     While it is a flash it must sit on the muzzle: the tank keeps moving and
     turning during a shot, and a flash left behind in world space reads as
     "the barrel fired from over there". Once it has cooled to smoke it is
     released and drifts on its own, like real gunsmoke does. */
  const ANCHOR_HOR = 0.24;
  const FLASH_END = 0.080 / LIFE;   /* the hot part is over in 80ms            */
  const COOL_YEL  = 0.030 / LIFE;   /* white -> yellow, at about 45ms         */
  const COOL_END  = 0.150 / LIFE;   /* yellow -> orange -> coal, by 150ms     */
  const POOL      = 10;      /* hard cap on live clouds, oldest recycled     */
  const MAX_DIST  = 150;     /* further out the cloud is sub-pixel          */

  /* ---- GLSL (WebGL) ----------------------------------------------------- */
  const VS = `
    varying vec3 vDir;
    varying vec3 vNormalW;
    varying vec3 vView;
    varying float vLobe;
    uniform sampler2D uNoise;
    uniform float uTime;
    uniform float uProg;
    uniform float uSeed;
    void main(){
      vDir = normalize(position);
      /* 1. LOBES — the same noise that colours the cloud also pushes its
         outline in and out, so it reads as a pile of puffs.
         The seed is added as an OFFSET, never folded into the direction
         before normalising: normalising (vDir + seed) pulls every vertex
         toward one point, the noise comes back almost constant, and the
         "cloud" comes out a smooth billiard ball. The direction is kept and
         the seed only slides it to a different part of the noise sheet, so
         each cloud is lumpy AND different from the next one. */
      vec3 q = vDir;
      float l1 = texture2D(uNoise, q.xz * 0.85 + vec2(uSeed,        uSeed * 0.63) + vec2( 0.15,  0.11) * uTime).r;
      float l2 = texture2D(uNoise, q.xy * 0.85 + vec2(uSeed * 1.31, uSeed * 0.47) + vec2(-0.13,  0.09) * uTime).r;
      float l3 = texture2D(uNoise, q.zy * 0.85 + vec2(uSeed * 0.71, uSeed * 1.17) + vec2( 0.10, -0.14) * uTime).r;
      vLobe = l1 * 0.42 + l2 * 0.32 + l3 * 0.26;
      /* It opens hard at the shot, then keeps swelling slowly as smoke. */
      float amp = 0.26 + 0.28 * smoothstep(0.0, __FLASH_END__, uProg) + 0.26 * uProg;
      vec3 disp = position + normal * ((vLobe - 0.5) * amp);

      /* THE FLASH IS NOT A BALL. It is a spike of fire out of the barrel.
         This is the whole difference between a glow and cartoon fire: a small
         coloured sphere reads as a light bloom no matter how it is tinted,
         because a sphere has no direction. So during the hot frames the
         surface is hauled out along +Z — which is aimed down the barrel when
         the cloud spawns — into a few FLAT-TOPPED tongues, the sides pinch
         back, and the whole thing is withdrawn as it cools, leaving the
         lumpy cloud behind untouched.

         The tongues are quantised rather than smooth on purpose. Three steps
         with visible ledges between them is what "drawn" means; a smooth
         cone would just be a cone. */
      float hot = 1.0 - smoothstep(0.0, __FLASH_END__, uProg);
      if(hot > 0.001){
        vec3 nn = normalize(position);
        float tip = max(nn.z, 0.0);
        float t3 = floor(tip * 3.0) / 3.0;              /* flat ledges */
        disp += vec3(0.0, 0.0, 1.0) * (t3 * hot * 2.30); /* out along the barrel */
        disp -= nn * (tip * tip * hot * 0.34);           /* sides pull in */
      }

      vec4 wp = modelMatrix * vec4(disp, 1.0);
      vNormalW = normalize(mat3(modelMatrix) * normal);
      vView = normalize(cameraPosition - wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const FS = `
    precision highp float;
    varying vec3 vDir;
    varying vec3 vNormalW;
    varying vec3 vView;
    varying float vLobe;
    uniform sampler2D uNoise;
    uniform float uTime;
    uniform float uProg;
    uniform float uSeed;

    /* a hard step with a thin feather: colour ends at a LINE, it does not
       dissolve over half the cloud */
    float cut(float x, float at, float f){ return smoothstep(at - f, at + f, x); }

    /* quantise into flat patches — cel shading */
    float bands(float x, float levels, float f){
      float s = x * (levels - 1.0);
      float fl = floor(s);
      return clamp((fl + smoothstep(0.5 - f, 0.5 + f, s - fl)) / (levels - 1.0), 0.0, 1.0);
    }

    void main(){
      vec3 p = vDir;
      float t = uTime;
      float n1 = texture2D(uNoise, p.xz * 0.85 + vec2(uSeed,        uSeed * 0.63) + vec2( 0.15,  0.11) * t).r;
      float n2 = texture2D(uNoise, p.xy * 0.85 + vec2(uSeed * 1.31, uSeed * 0.47) + vec2(-0.13,  0.09) * t).r;
      float n3 = texture2D(uNoise, p.zy * 0.85 + vec2(uSeed * 0.71, uSeed * 1.17) + vec2( 0.10, -0.14) * t).r;
      float n  = n1 * 0.40 + n2 * 0.32 + n3 * 0.28;

      /* How far it has cooled. Drives the ragged edge eating into it.
         The ramp is deliberately SLOW: the smoke has to hang in the air for its
         full second and a half, and an early ramp left the cloud in pieces
         halfway through its own life. */
      float burn = smoothstep(0.10, 0.86, uProg);
      /* The cut line RISES as it cools: solid at the shot, then eaten into by
         the noise above it, until the smoke is a ragged cloud rather than a
         black ball with a clean outline. */
      float a = cut(n + (1.0 - burn) * 0.46, 0.32 + burn * 0.24, 0.035);
      a *= 1.0 - smoothstep(0.88, 1.0, uProg);      /* only the very end thins */
      /* 3. FLAT PATCHES — three hard bands, not a soft ramp. This is the
         difference between cel shading and an airbrush. */
      float tone = bands(n, 3.0, 0.020);

      float facing = abs(dot(normalize(vNormalW), normalize(vView)));
      float fres = pow(1.0 - facing, 1.5);

      /* 4. INK — a dark line right at the silhouette. Wide and strong on
         purpose: this line is what makes the cloud look DRAWN. */
      float inkLine = smoothstep(0.72, 0.95, fres);
      /* The red BAND sits just inside that outline: white middle, red edge,
         dark line on the very rim — exactly how toon fire is drawn.
         Both bands are kept TIGHT. A fresnel band is a fixed angular width, so
         on a small cloud a wide band swallows the whole disc and the flash
         turns into a red ring with a pale hole in it instead of a white-hot
         middle with red round the edge. */
      float warmBand = smoothstep(0.44, 0.74, fres) * (1.0 - inkLine);

      vec3 white  = vec3(__WHITE__);
      vec3 yellow= vec3(__YELLOW__);
      vec3 orange= vec3(__ORANGE__);
      vec3 coal  = vec3(__COAL__);
      vec3 glow  = vec3(__GLOW__);
      vec3 ink   = vec3(__INK__);

      /* The hot stage: white core, yellow band round it. */
      vec3 hot = mix(white, yellow, warmBand);
      hot += glow * fres * 0.28;
      hot *= 0.45 + 0.55 * tone;

      /* ...then it cools, one hard step at a time: yellow, then orange, then
         coal. Never a dissolve between them. */
      float toOrange = cut(uProg, __COOL_YEL__, 0.012);
      float cooled   = cut(uProg, __COOL_END__, 0.020);
      vec3 fire = mix(hot, orange, toOrange);
      vec3 col = mix(fire, coal * (0.40 + 0.95 * tone), cooled);
      col = mix(col, coal * 0.80, inkLine * cooled * 0.9);

      /* THE HIT — blended, NOT added.
         Adding white on top saturated every colour channel to 1.0 and turned
         the flash into a featureless glowing disc: the flat patches, the
         outline and the tongues all vanished. Blending toward a white that
         still carries the yellow band and the banded shading keeps every
         drawn edge, so the shot frame is loud AND still looks drawn. */
      float flashAmt = 1.0 - cut(uProg, 0.030, 0.012);
      vec3 flashCol = mix(white, yellow, warmBand) * (0.80 + 0.20 * tone);
      col = mix(col, flashCol, flashAmt * 0.80);

      /* INK goes on last, so the outline survives the hit flash. */
      col = mix(col, ink, inkLine * (1.0 - cooled) * 0.92);

      float body = mix(0.99, 0.88, cooled);
      gl_FragColor = vec4(col, a * body);
    }
  `;

  /* GLOBAL replacement, every occurrence. String.replace() with a string
     pattern only replaces the FIRST one, and a token that survived would be
     literal text in the shader — invalid GLSL that makes the cloud silently
     draw nothing at all. */
  const VS_READY = VS
    .split('__FLASH_END__').join(FLASH_END.toFixed(4));
  const FS_READY = FS
    .split('__WHITE__').join(RAMP.white.join(', '))
    .split('__YELLOW__').join(RAMP.yellow.join(', '))
    .split('__ORANGE__').join(RAMP.orange.join(', '))
    .split('__COAL__').join(RAMP.coal.join(', '))
    .split('__GLOW__').join(RAMP.glow.join(', '))
    .split('__INK__').join(RAMP.ink.join(', '))
    .split('__COOL_YEL__').join(COOL_YEL.toFixed(4))
    .split('__COOL_END__').join(COOL_END.toFixed(4));

  /* ---- TSL twin (WebGPU) ------------------------------------------------ */
  function buildTSL(tex, u){
    const T = window.TSL, W = window.WebGPU;
    const { vec2, vec3, vec4, float, mix, smoothstep, clamp, pow, floor, fract, dot, abs,
            positionGeometry, normalGeometry, normalWorld, positionWorld, cameraPosition,
            uv, texture } = T;

    const uProg = u.uProg, t = u.uTime, uSeed = u.uSeed;

    /* Thresholds stay PLAIN NUMBERS here: wrapping a live node in float() made
       three emit WGSL it could not parse, and the effect silently vanished. */
    const cutN = (x, atNode, f) => smoothstep(atNode.sub(f), atNode.add(f), x);
    const cutF = (x, at, f)      => smoothstep(float(at - f), float(at + f), x);
    const bands = (x, levels, f) => {
      const s = x.mul(levels - 1);
      const fl = floor(s);
      const r = fract(s);
      const e = smoothstep(float(0.5 - f), float(0.5 + f), r);
      return clamp( fl.add(e).div(levels - 1), 0.0, 1.0 );
    };
    const sheet = (sel, off) => texture(tex, uv(sel.add(vec2(off[0], off[1]).mul(t)))).r;

    /* The seed is an OFFSET, never folded into the direction before
       normalising — see the note in the GLSL above. */
    const q = positionGeometry.normalize();
    const l1 = sheet(q.xz.mul(0.85).add(vec2(uSeed,            uSeed.mul(0.63))), [ 0.15,  0.11]);
    const l2 = sheet(q.xy.mul(0.85).add(vec2(uSeed.mul(1.31), uSeed.mul(0.47))), [-0.13,  0.09]);
    const l3 = sheet(q.zy.mul(0.85).add(vec2(uSeed.mul(0.71), uSeed.mul(1.17))), [ 0.10, -0.14]);
    const lobe = l1.mul(0.42).add(l2.mul(0.32)).add(l3.mul(0.26));

    /* 1. LOBES — displace the surface by the same noise the colour uses */
    const amp = float(0.26)
      .add( float(0.28).mul( smoothstep(float(0.0), float(FLASH_END), uProg) ) )
      .add( float(0.26).mul(uProg) );
    const displaced = positionGeometry.add( normalGeometry.mul( lobe.sub(0.5).mul(amp) ) );

    /* THE FLASH IS NOT A BALL — see the note in the GLSL above. +Z is aimed
       down the barrel at spawn, so the tongues fire out of the gun. */
    const hotF = float(1).sub( smoothstep(float(0.0), float(FLASH_END), uProg) );
    const nn   = positionGeometry.normalize();
    const tip  = clamp( nn.z, 0.0, 1.0 );
    const t3   = floor( tip.mul(3.0) ).div(3.0);
    const spiked = displaced
      .add( vec3(0.0, 0.0, 1.0).mul( t3.mul(hotF).mul(2.30) ) )
      .sub( nn.mul( tip.mul(tip).mul(hotF).mul(0.34) ) );

    const n  = l1.mul(0.40).add(l2.mul(0.32)).add(l3.mul(0.28));
    const burn = smoothstep(float(0.10), float(0.86), uProg);
    const cutLine = burn.mul(0.24).add(0.32);
    let a = cutN( n.add(float(1).sub(burn).mul(0.46)), cutLine, 0.035 );
    a = a.mul( float(1).sub(smoothstep(float(0.88), float(1.0), uProg)) );
    /* 3. FLAT PATCHES — the same three hard bands as the GLSL */
    const tone = bands(n, 3.0, 0.020);

    const vd = positionWorld.sub(cameraPosition).normalize();
    const facing = abs(dot(normalWorld, vd));
    const fres = pow( clamp( float(1).sub(facing), 0.0, 1.0 ), 1.5 );

    const inkLine  = smoothstep(float(0.72), float(0.95), fres);
    const warmBand = smoothstep(float(0.44), float(0.74), fres).mul( float(1).sub(inkLine) );

    const white  = vec3(...RAMP.white);
    const yellow = vec3(...RAMP.yellow);
    const orange = vec3(...RAMP.orange);
    const coal   = vec3(...RAMP.coal);
    const glow   = vec3(...RAMP.glow);
    const ink    = vec3(...RAMP.ink);

    let hot = mix(white, yellow, warmBand);
    hot = hot.add( glow.mul(fres).mul(0.28) );
    hot = hot.mul( float(0.45).add( tone.mul(0.55) ) );

    const toOrange = cutF(uProg, COOL_YEL, 0.012);
    const cooled   = cutF(uProg, COOL_END, 0.020);
    const fire = mix( hot, orange, toOrange );
    let col = mix( fire, coal.mul( tone.mul(0.95).add(0.40) ), cooled );
    col = mix( col, coal.mul(0.80), inkLine.mul(cooled).mul(0.9) );

    /* THE HIT — blended, not added. See the note in the GLSL above. */
    const flashAmt = float(1).sub( cutF(uProg, 0.030, 0.012) );
    const flashCol = mix(white, yellow, warmBand).mul( tone.mul(0.20).add(0.80) );
    col = mix( col, flashCol, flashAmt.mul(0.80) );

    /* INK last, so the outline survives the hit flash. */
    col = mix( col, ink, inkLine.mul( float(1).sub(cooled) ).mul(0.92) );

    const body = mix( float(0.99), float(0.88), cooled );
    const mat = new W.MeshBasicNodeMaterial();
    mat.positionNode = spiked;
    mat.colorNode = vec4(col, a.mul(body));
    mat.transparent = true;
    mat.depthWrite  = false;
    mat.side        = THREE.DoubleSide;
    mat.toneMapped  = false;
    return mat;
  }

  /* ---- the cloud --------------------------------------------------------- */
  class MuzzleCloudFX {
    constructor(scene, useTSL){
      this.scene = scene;
      /* Enough segments for readable lobes, fewer than the explosion's: many
         of these can be alive at once. */
      this.geo = new THREE.SphereGeometry(1, 22, 14);
      this._useTSL = useTSL;
      this._tex = noiseTexture();
      this.clouds = [];
      for(let i = 0; i < POOL; i++){
        this.clouds.push({
          mesh: new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial()),
          uniforms: null, life: 0, maxLife: LIFE, seed: 0, size: 3,
          vx: 0, vy: 0, vz: 0, spin: 0, active: false,
          /* Barrel anchoring: while `anchor` is set and the cloud is still in
             its flash phase, the mesh is re-pinned to the gun every frame, so
             the flash cannot drift behind a moving/turning tank. */
          anchor: null, fx: 0, fz: 1, lead: 0, released: true,
        });
      }
      for(const c of this.clouds){
        c.mesh.visible = false;
        c.mesh.castShadow = false;
        c.mesh.receiveShadow = false;
        c.mesh.renderOrder = 997;
        this.scene.add(c.mesh);
      }
    }

    /* Each cloud owns its material, and so its own uProg / uTime / uSeed: two
       clouds in the air at once must be able to sit at different stages. They
       all compile to the SAME program, so this costs uniform buffers and no
       extra shader compiles. They are built once here, before the match. */
    _material(){
      if(this._useTSL && window.TSL && window.WebGPU){
        const nodes = {
          uTime: window.TSL.uniform(0),
          uProg: window.TSL.uniform(0),
          uSeed: window.TSL.uniform(0),
        };
        return { mat: buildTSL(this._tex, nodes), uniforms: nodes };
      }
      /* A leftover __TOKEN__ means invalid GLSL: the cloud would silently fail
         to draw. Catch it here, where it can still be fixed. */
      if(/__[A-Z_]+__/.test(VS_READY) || /__[A-Z_]+__/.test(FS_READY)){
        console.error('[muzzle-pop] shader still has unreplaced tokens');
      }
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uNoise: { value: this._tex },
          uTime: { value: 0 },
          uProg: { value: 0 },
          uSeed: { value: 0 },
        },
        vertexShader: VS_READY,
        fragmentShader: FS_READY,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      /* Hand back the material's OWN uniform block. Returning null here left
         uProg pinned at 0 forever on WebGL, so the cloud never cooled to
         smoke — it sat as one permanent white ball. */
      return { mat: mat, uniforms: mat.uniforms };
    }

    /* Called once at battle start so the first shot of a match never stalls. */
    warm(){
      for(const c of this.clouds){
        if(!c.mesh.material || c.mesh.material.type === 'MeshBasicMaterial'){
          const m = this._material();
          c.mesh.material = m.mat;
          c.uniforms = m.uniforms;
        }
        c.mesh.visible = true;
        c.mesh.position.set(0, -6000, 0);
        c.mesh.scale.set(3, 3, 3);
      }
      try { this.scene.userData && 0; } catch(e){}
    }

    _pick(){
      for(const c of this.clouds) if(!c.active) return c;
      /* Cap reached: the oldest is recycled. Nobody can tell which of a dozen
         simultaneous muzzle clouds was the oldest. */
      let best = this.clouds[0];
      for(const c of this.clouds) if(c.age > best.age) best = c;
      return best;
    }

    play(pos, dir, big, cameraPos, anchorTank){
      if(cameraPos){
        const d = Math.hypot(cameraPos.x - pos.x, cameraPos.z - pos.z);
        if(d > MAX_DIST) return;
      }
      const c = this._pick();
      const rx = dir ? (dir.x || 0) : 0, rz = dir ? (dir.z || 0) : 1;
      const rl = Math.hypot(rx, rz) || 1;
      const fx = rx / rl, fz = rz / rl;

      if(!c._built){ const m = this._material(); c.mesh.material = m.mat; c.uniforms = m.uniforms; c._built = true; }

      c.active  = true;
      c.life    = LIFE;
      c.maxLife = LIFE;
      c.age     = 0;
      /* Compact: a third of what it first was, then half as big again. */
      c.size    = big ? 0.77 : 0.67;
      c.seed    = Math.random() * 10;
      /* Straight out of the muzzle, then straight up as it cools. */
      c.mesh.position.set(pos.x + fx * (big ? 1.5 : 1.2), pos.y + 0.4, pos.z + fz * (big ? 1.5 : 1.2));
      c.mesh.scale.set(c.size * 0.5, c.size * 0.5, c.size * 0.5);
      c.mesh.visible = true;
      /* Aim +Z straight down the barrel. The flash's tongues are built along
         +Z in the shader, so this is what makes the fire come OUT of the gun
         instead of blooming around it. A random roll about that axis keeps
         twenty tanks firing at once from looking stamped. */
      _v1.set(fx, 0, fz).normalize();
      _q1.setFromUnitVectors(_v2.set(0, 0, 1), _v1);
      _q2.setFromAxisAngle(_v2.set(0, 0, 1), Math.random() * 6.28318);
      c.mesh.quaternion.copy(_q1).multiply(_q2);
      c.spin = 0;
      c.vx = fx * 2.4; c.vz = fz * 2.4; c.vy = 1.1;
      /* Glue it to the gun when the caller hands the tank over: while anchored
         the cloud follows the muzzle so the flash rides the barrel exactly. */
      if(anchorTank){
        c.anchor = anchorTank; c.fx = fx; c.fz = fz;
        c.lead = big ? 1.5 : 1.2; c.released = false;
      } else {
        c.anchor = null; c.released = true;
      }
      if(c.uniforms){ c.uniforms.uSeed.value = c.seed; c.uniforms.uProg.value = 0; c.uniforms.uTime.value = 0; }
    }

    update(dt, time){
      for(let i = 0; i < this.clouds.length; i++){
        const c = this.clouds[i];
        if(!c.active) continue;
        c.life -= dt;
        c.age  += dt;
        if(c.life <= 0){ c.active = false; c.mesh.visible = false; c.anchor = null; continue; }
        const k = 1 - c.life / c.maxLife;            /* 0 -> 1 */

        /* BARREL ANCHOR PHASE. Before the flash has cooled into smoke the
           cloud is re-pinned to the muzzle every frame - tank movement and
           turret turn included - so the flash stays fixed to the barrel, not
           to a point in the world. The muzzle can go away (tank destroyed, or
           the anchor is actually a remote ghost) or the flash phase expires;
           then the cloud is released into ordinary smoke drift. */
        if(c.anchor && !c.released){
          let ok = false;
          try {
            if(c.anchor.alive && !c.anchor.dying && c.anchor.muzzle){
              const m = c.anchor.muzzle();
              if(m && m.pos){
                c.mesh.position.set(
                  m.pos.x + c.fx * c.lead,
                  m.pos.y + 0.4,
                  m.pos.z + c.fz * c.lead
                );
                ok = true;
              }
            }
          } catch(e){}
          if(!ok || c.life < c.maxLife * (1 - ANCHOR_HOR)){
            /* Release: keep everything accumulated so the smoke simply picks
               up drifting from wherever the barrel left it. */
            c.released = true; c.anchor = null;
          } else {
            if(c.uniforms){ c.uniforms.uProg.value = k; c.uniforms.uTime.value = time; }
            continue;   /* anchored clouds skip the drift below */
          }
        }

        /* Drifts slowly along the barrel and up, and eases off as it goes. */
        const drag = 1 - 0.6 * k;
        c.mesh.position.x += c.vx * dt * drag;
        c.mesh.position.z += c.vz * dt * drag;
        c.mesh.position.y += c.vy * dt * drag;
        /* The aim quaternion set at spawn is left alone: the mesh has to stay
           pointed down the barrel for the flame tongues to fire out of the
           gun. The lumpy smoke does not need a spin to look alive. */

        /* Opens hard at the shot, then keeps swelling slowly as smoke. */
        const sc = c.size * (0.5 + 0.75 * smoothstep01(k / 0.054) + 0.62 * k);
        c.mesh.scale.set(sc, sc, sc);

        if(c.uniforms){ c.uniforms.uProg.value = k; c.uniforms.uTime.value = time; }
      }
    }

    clear(){
      for(const c of this.clouds){ c.active = false; c.mesh.visible = false; }
    }
  }

  /* Scratch objects, so aiming a cloud at the barrel allocates nothing. This
     runs on every single shot in the game. */
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
  const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

  /* tiny JS smoothstep so the scale curve matches the shader's */
  function smoothstep01(x){
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
  }

  return {
    get(scene){
      const useTSL = !!(window.WebGPU && window.TSL);
      if(!this._fx) this._fx = new MuzzleCloudFX(scene, useTSL);
      return this._fx;
    },
    play(scene, pos, dir, big, cameraPos, anchorTank){
      if(cameraPos){
        const d = Math.hypot(cameraPos.x - pos.x, cameraPos.z - pos.z);
        if(d > MAX_DIST) return;
      }
      try { this.get(scene).play(pos, dir, big, null, anchorTank); } catch(e){}
    },
    update(scene, dt){
      if(!this._fx) return;
      this._fx._t = (this._fx._t || 0) + dt;
      try { this._fx.update(dt, this._fx._t); } catch(e){}
    },
    warm(scene){
      if(!this._fx) this.get(scene);
      try { this._fx.warm(); } catch(e){}
    },
    clear(){ if(this._fx) this._fx.clear(); },
  };
})();

if (typeof window !== 'undefined') window.MuzzlePop = MuzzlePop;
