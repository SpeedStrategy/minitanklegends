/* ============================================================================
   mortar-blast.js — the artillery impact.

   A growing fireball whose size is the SPLASH RADIUS, not a fixed number.

   WHY THIS EXISTS. The Mortar is the only weapon in the game that is aimed by
   picking a spot on the ground, and the splash ring is drawn there before the
   shot lands — so by the time the shell arrives the player already knows exactly
   how much ground is lethal. The bang then played at `splashRadius / 3`, a soft
   cluster of puffs a quarter the width of the circle the player was aiming
   inside. The explosion and the danger zone disagreed, and the eye believes the
   explosion.

   So the radius here is passed in and used VERBATIM: the fireball's horizontal
   radius lands on exactly splashRadius, and the ground shockwave's bright outer
   edge lands on exactly splashRadius, on the same frame. What you see is what
   kills you.

   TWO SHADERS, ONE EFFECT — the same arrangement fireball.js and
   flamethrower-effect.js use. `buildTSL` is the Three Shading Language version
   for WebGPU; `VS`/`FS` are the GLSL twin that runs on WebGL. Whichever the
   renderer supports is chosen once at material build time. They are kept
   deliberately close in structure so a change to one is obviously due in the
   other: the TSL is not a port of the GLSL, it is the same program twice.

   THE TSL IS CURRENTLY DORMANT. Nothing can execute TSL while the renderer is a
   WebGLRenderer — window.TSL is only populated on the WebGPU path (see
   loadTSL in index.html) — so on the live renderer the GLSL twin is what draws.
   The TSL is here so the effect is already written when that flips.
   ============================================================================ */
const MortarBlast = (() => {

  /* ---- the one texture: greyscale value noise, three octaves, wrapped -----
     Same construction as fireball's, and for the same reason: a ball needs LOBES,
     and soft even noise makes a smooth sphere look like a billiard ball. */
  let _noiseTex = null;
  function noiseTexture(){
    if(_noiseTex) return _noiseTex;
    const S = 256;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const P = 32;
    const lat = new Float32Array(P * P);
    for(let i = 0; i < P * P; i++) lat[i] = Math.random();
    const at = (x, y) => lat[((y % P) + P) % P * P + (((x % P) + P) % P)];
    const smooth = (x, y, freq) => {
      const fx = x * freq, fy = y * freq;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = at(x0, y0), b = at(x0 + 1, y0);
      const d = at(x0, y0 + 1), e = at(x0 + 1, y0 + 1);
      const top = a + (b - a) * sx, bot = d + (e - d) * sx;
      return top + (bot - top) * sy;
    };
    for(let y = 0; y < S; y++){
      for(let x = 0; x < S; x++){
        const u = x / S, v = y / S;
        let n = smooth(u, v, 7) * 0.55 + smooth(u, v, 16) * 0.30 + smooth(u, v, 38) * 0.15;
        n = Math.pow(Math.max(0, Math.min(1, n)), 1.25);
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

  /* ---- the four stages -----------------------------------------------------
     A shell detonating passes through white-hot, yellow, orange, soot. Starting
     at orange skipped the hottest instant, which is the one that reads as "a
     shell went off" rather than "a puff appeared".

     Deliberately deep and saturated. The toon-shaded tanks are pale, so a washed
     pastel blast simply does not register against them. */
  const HOT  = [1.00, 0.97, 0.84];
  const YEL  = [1.00, 0.78, 0.26];
  const ORG  = [0.95, 0.34, 0.08];
  const COAL = [0.15, 0.13, 0.13];

  /* ---- GLSL twin (WebGL) ---------------------------------------------------- */
  const VS = `
    uniform float uTime;
    uniform float uGrow;
    uniform float uSeed;
    uniform sampler2D uNoise;
    varying vec3  vObj;
    varying vec3  vNrmW;
    varying vec3  vWorld;

    float sheet(vec2 p, vec2 off){
      return texture2D(uNoise, p * 0.5 + 0.5 + off * uTime).r;
    }

    void main(){
      vec3 q = normalize(position) + vec3(uSeed, uSeed * 0.5, uSeed * 0.25);
      float l1 = sheet(q.xz, vec2( 0.13,  0.09));
      float l2 = sheet(q.xy, vec2(-0.11,  0.07));
      float l3 = sheet(q.zy, vec2( 0.08, -0.12));
      float lobe = l1 * 0.42 + l2 * 0.33 + l3 * 0.25;

      /* Lobes open up as it grows: a small blast is tight, a big one is ragged.
         Capped low because the sphere's SILHOUETTE is load-bearing here — it is
         the thing that has to match the splash circle — and past this much
         displacement the edge stops reading as a circle at all. */
      float amp = 0.10 + 0.16 * smoothstep(0.0, 0.7, uGrow);
      vec3 disp = position + normal * (lobe - 0.5) * amp;

      vObj = disp;
      vec4 wp = modelMatrix * vec4(disp, 1.0);
      vWorld = wp.xyz;
      vNrmW = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const FS = `
    uniform float uTime;
    uniform float uProg;
    uniform float uSeed;
    uniform float uAlpha;
    uniform sampler2D uNoise;
    varying vec3  vObj;
    varying vec3  vNrmW;
    varying vec3  vWorld;

    float sheet(vec2 p, vec2 off){
      return texture2D(uNoise, p * 0.5 + 0.5 + off * uTime).r;
    }

    /* CEL BANDS. This is the whole point of the rewrite.

       Everything else in this game is toon-shaded: flat stepped tones and a drawn
       black edge, no gradients. The first version of this blast shaded itself
       smoothly (0.55 + 0.75 * n), which put a soft airbrushed smoke ball in
       the middle of a world of flat colour, and it read as the wrong game.

       So the lighting term is QUANTISED into discrete steps rather than ramped.
       The third argument is the width of the soft edge between steps: small
       enough to be a hard boundary, big enough not to alias into noise at this
       resolution. */
    float bands(float x, float levels, float f){
      float s = x * (levels - 1.0);
      float fl = floor(s);
      float r  = s - fl;
      float e  = smoothstep(0.5 - f, 0.5 + f, r);
      return clamp((fl + e) / (levels - 1.0), 0.0, 1.0);
    }

    void main(){
      vec3 q = normalize(vObj) + vec3(uSeed, uSeed * 0.5, uSeed * 0.25);
      float l1 = sheet(q.xz, vec2( 0.13,  0.09));
      float l2 = sheet(q.xy, vec2(-0.11,  0.07));
      float l3 = sheet(q.zy, vec2( 0.08, -0.12));
      float n = l1 * 0.42 + l2 * 0.33 + l3 * 0.25;

      /* FRESNEL, and why it is needed: the noise texture is sampled from the
         OBJECT's own axes, so the whole surface shifts as the ball turns. Left
         alone that reads as a texture sliding over a ball. The rim term pins the
         edge to the silhouette so the thing reads as a volume turning. */
      vec3  vd     = normalize(vWorld - cameraPosition);
      float facing = abs(dot(normalize(vNrmW), vd));
      float fres   = pow(1.0 - facing, 1.7);

      float t1 = smoothstep(0.00, 0.14, uProg);
      float t2 = smoothstep(0.12, 0.40, uProg);
      float t3 = smoothstep(0.44, 0.86, uProg);
      vec3 col = mix(vec3(${HOT[0]}, ${HOT[1]}, ${HOT[2]}), vec3(${YEL[0]}, ${YEL[1]}, ${YEL[2]}), t1);
      col = mix(col, vec3(${ORG[0]}, ${ORG[1]}, ${ORG[2]}), t2);
      col = mix(col, vec3(${COAL[0]}, ${COAL[1]}, ${COAL[2]}), t3);

      /* Internal structure, in STEPS. Four tones is what the rest of the game
         uses, so this is the same vocabulary rather than its own. */
      float tone = bands(n, 4.0, 0.055);
      col *= 0.50 + 0.85 * tone;

      /* Rim glow, banded too — a smooth rim on banded body is the one
         combination that still looks like a gradient sneaking back in. */
      float rim = bands(fres, 3.0, 0.10);
      col += vec3(1.0, 0.55, 0.18) * rim * (1.0 - smoothstep(0.30, 0.82, uProg)) * 1.05;

      /* THE DRAWN EDGE — the other half of the toon look. A hard dark rim where
         the surface turns away, the same ink the fireball lays on and the same
         black rim every tank mesh is built with. Without it the blast has no
         outline and sits on the map looking like a photographic cut-out. */
      float inkAmt = 1.0 - smoothstep(0.05, 0.34, facing);
      col = mix(col, vec3(0.05, 0.035, 0.03), inkAmt * 0.85);

      /* Dense at the flash, thinning to smoke. Held opaque through the growth so
         the silhouette is solid while it is still the thing being measured.
         Also banded, so the cloud breaks into drawn shapes as it dissipates. */
      float a = smoothstep(0.015, 0.22, uProg) * (1.0 - smoothstep(0.52, 1.0, uProg));
      a *= 0.62 + 0.55 * tone;
      a += rim * 0.30 * (1.0 - smoothstep(0.28, 0.86, uProg));
      a = clamp(a, 0.0, 1.0) * uAlpha;

      gl_FragColor = vec4(col, a);
    }
  `;

  /* ---- TSL twin (WebGPU) ----------------------------------------------------
     The same program in three's node language. Note the helpers: every threshold
     is a PLAIN NUMBER passed through float(). Wrapping a live node in float()
     made three emit WGSL it could not parse and the mesh silently vanished — the
     same failure the fireball hit, kept from repeating here. */
  function buildTSL(tex, u){
    const T = window.TSL, W = window.WebGPU;
    const { vec2, vec3, vec4, float, mix, smoothstep, clamp, pow, floor, fract, dot, abs,
            positionGeometry, normalGeometry, normalWorld, positionWorld,
            cameraPosition, texture } = T;

    const t = u.uTime, prog = u.uProg, grow = u.uGrow, seed = u.uSeed;
    const cutF = (x, at, f) => smoothstep(float(at - f), float(at + f), x);
    const sheet = (sel, ox, oy) => texture(tex, sel.mul(0.5).add(0.5).add(vec2(ox, oy).mul(t))).r;

    /* The TSL twin of bands() in the GLSL above — quantise into discrete steps
       rather than ramping. Same helper shape as fireball's, and for the same
       reason: the steps are the toon look. */
    const bands = (x, levels, f) => {
      const s = x.mul(levels - 1);
      const fl = floor(s);
      const r  = fract(s);
      const e  = smoothstep(float(0.5 - f), float(0.5 + f), r);
      return clamp( fl.add(e).div(levels - 1), 0.0, 1.0 );
    };

    const q    = positionGeometry.normalize().add(vec3(seed, seed.mul(0.5), seed.mul(0.25)));
    const l1v  = sheet(q.xz,  0.13,  0.09);
    const l2v  = sheet(q.xy, -0.11,  0.07);
    const l3v  = sheet(q.zy,  0.08, -0.12);
    const lobe = l1v.mul(0.42).add(l2v.mul(0.33)).add(l3v.mul(0.25));

    /* Same displacement, same deliberate cap — see the GLSL twin. */
    const amp = float(0.10).add( float(0.16).mul( smoothstep(float(0.0), float(0.7), grow) ) );
    const displaced = positionGeometry.add( normalGeometry.mul( lobe.sub(0.5).mul(amp) ) );

    const qf   = normalGeometry.normalize().add(vec3(seed, seed.mul(0.5), seed.mul(0.25)));
    const f1   = sheet(qf.xz,  0.13,  0.09);
    const f2   = sheet(qf.xy, -0.11,  0.07);
    const f3   = sheet(qf.zy,  0.08, -0.12);
    const n    = f1.mul(0.42).add(f2.mul(0.33)).add(f3.mul(0.25));

    const vd     = positionWorld.sub(cameraPosition).normalize();
    const facing = abs(dot(normalWorld, vd));
    const fres   = pow( clamp( float(1).sub(facing), 0.0, 1.0 ), 1.7 );

    let col = mix(vec3(...HOT),  vec3(...YEL),  cutF(prog, 0.07,  0.05));
    col = mix(col, vec3(...ORG),  cutF(prog, 0.26,  0.10));
    col = mix(col, vec3(...COAL), cutF(prog, 0.65,  0.16));

    /* banded body + banded rim + the drawn ink edge */
    const tone = bands(n, 4.0, 0.055);
    col = col.mul( float(0.50).add( tone.mul(0.85) ) );
    const rim = bands(fres, 3.0, 0.10);
    col = col.add( vec3(1.0, 0.55, 0.18).mul(rim).mul( float(1).sub(cutF(prog, 0.56, 0.26)) ).mul(1.05) );
    const inkAmt = float(1).sub( smoothstep(float(0.05), float(0.34), facing) );
    col = mix(col, vec3(0.05, 0.035, 0.03), inkAmt.mul(0.85));

    let a = smoothstep(float(0.015), float(0.22), prog).mul( float(1).sub(smoothstep(float(0.52), float(1.0), prog)) );
    a = a.mul( float(0.62).add( tone.mul(0.55) ) );
    a = a.add( rim.mul(0.30).mul( float(1).sub(cutF(prog, 0.57, 0.29)) ) );
    a = clamp(a, 0.0, 1.0).mul(u.uAlpha);

    const mat = new W.MeshBasicNodeMaterial();
    mat.positionNode = displaced;
    mat.colorNode = vec4(col, a);
    mat.transparent = true;
    mat.depthWrite  = false;
    mat.side        = THREE.DoubleSide;
    mat.toneMapped  = false;
    return mat;
  }

  /* ---- the ground shockwave -------------------------------------------------
     Deliberately NOT a shader. It is a flat decal with its falloff baked into
     vertex alpha, which draws identically on both renderers and costs one
     material with no uniforms at all — where the fireball genuinely needs a
     shader, this does not, so giving it one would be ceremony.

     The falloff is the same language as the mortar's SPLASH RING in game.js:
     fully bright at the rim, fading inward, and stopping short of the middle, so
     it never reads as "everything in here is lethal" — only the rim is the
     actual boundary. Outermost vertex sits at exactly radius 1.0, so scaling by
     splashRadius puts the bright edge precisely on the damage circle. */
  function shockGeometry(){
    /* INNER and the exponent are tuned against the actual map, not in the
       abstract. The first pass used 0.62 / pow 2.0 and the ring was effectively
       invisible on the light grey Kaukaz ground — which defeats its whole
       purpose, since this is the piece that tells the player where the damage
       circle is. Narrower band (0.70) and a gentler exponent (1.4) keep the
       falloff entirely in the outer 30% of the radius while actually being
       bright enough to see. */
    const RINGS = 4, INNER = 0.70;
    const geo = new THREE.RingGeometry(INNER, 1.0, 96, RINGS);
    const p = geo.attributes.position;
    const col = new Float32Array(p.count * 4);
    for(let i = 0; i < p.count; i++){
      const r = Math.hypot(p.getX(i), p.getY(i));
      const t = Math.max(0, Math.min(1, (r - INNER) / (1.0 - INNER)));
      col[i*4] = 1; col[i*4+1] = 1; col[i*4+2] = 1;
      col[i*4+3] = Math.pow(t, 1.4);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    return geo;
  }

  /* TIMING. GROW is the whole point of the number: it is how long the ball takes
     to arrive at splashRadius, and the shockwave is locked to the same value so
     the two reach the damage circle on the same frame. It is short — under half a
     second — because the eye reads a small ball as nothing having happened yet,
     and the player is looking at the spot they aimed at, not at the fire. */
  const LIFE = 1.30;
  const GROW = 0.42;
  const POOL = 4;

  class MortarBlastFX {
    constructor(scene, useTSL){
      this.scene = scene;
      /* Enough segments to show the lobes: a 24-segment sphere cannot carry a
         readable silhouette, and here the silhouette is the gameplay. */
      this.geo = new THREE.SphereGeometry(1, 48, 32);
      /* THE INVERTED-HULL OUTLINE, and it is not optional decoration.

         Every tank, tree and crate in this game carries a black rim — that is the
         single strongest signal that the art style is cartoon, and the shader's
         own ink term could not supply it because the blast DISPLACES its surface
         along the normals. An outline that follows the undisplaced sphere sits
         in the wrong place once the lobes open, and the mismatch reads as a
         double edge. So the outline is its own sphere, not a scaled copy.

         BackSide, black, drawn first: the fireball then covers its middle and the
         sliver left around the edge is the line. 5.5% of the radius, which is
         thin enough to read as a drawn line and thick enough to survive being a
         silhouette at 30 metres. Lower resolution than the ball because all it
         ever does is describe an outline. */
      this.outlineGeo = new THREE.SphereGeometry(1, 32, 20);
      this.outlineMat = new THREE.MeshBasicMaterial({
        color: 0x000000, side: THREE.BackSide, toneMapped: false,
        transparent: true, opacity: 0.92, depthWrite: false,
      });
      this.shockGeo = shockGeometry();
      this.shockMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, vertexColors: true, transparent: true, opacity: 1,
        side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
      });
      this._useTSL = !!(useTSL && window.TSL && window.WebGPU);
      this._tex = noiseTexture();
      this.b = [];
      for(let i = 0; i < POOL; i++) this.b.push({ mesh:null, outline:null, shock:null, u:null, life:0, maxLife:LIFE, seed:0, radius:7.5 });
    }

    _material(){
      if(this._useTSL){
        const u = {
          uTime:  window.TSL.uniform(0),
          uProg:  window.TSL.uniform(0),
          uGrow:  window.TSL.uniform(0),
          uSeed:  window.TSL.uniform(0),
          uAlpha: window.TSL.uniform(1),
        };
        return { mat: buildTSL(this._tex, u), u: u };
      }
      const u = {
        uTime:  { value: 0 },
        uProg:  { value: 0 },
        uGrow:  { value: 0 },
        uSeed:  { value: 0 },
        uAlpha: { value: 1 },
        uNoise: { value: this._tex },
      };
      const mat = new THREE.ShaderMaterial({
        vertexShader: VS, fragmentShader: FS, uniforms: u,
        transparent: true, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.NormalBlending, toneMapped: false,
      });
      return { mat: mat, u: u };
    }

    /* radius IS splashRadius. It is not scaled, not divided, not clamped to a
       "reasonable explosion size" — the caller's number is the answer, which is
       the only way the picture and the damage can be made to agree. */
    spawn(x, y, z, radius){
      if(radius == null || !isFinite(radius) || radius <= 0) return null;
      let b = this.b.find(v => !v.mesh || !v.mesh.visible);
      if(!b) b = this.b[0];
      if(!b.mesh){
        const m = this._material();
        b.u = m.u;
        b.mesh = new THREE.Mesh(this.geo, m.mat);
        b.mesh.frustumCulled = false;
        b.mesh.renderOrder = 998;
        b.mesh.visible = false;
        this.scene.add(b.mesh);

        b.shock = new THREE.Mesh(this.shockGeo, this.shockMat.clone());
        b.shock.rotation.x = -Math.PI / 2;
        b.shock.frustumCulled = false;
        b.shock.renderOrder = 997;
        b.shock.visible = false;
        this.scene.add(b.shock);

        /* One outline sphere per slot, created once and reused, exactly like the
           ball — a pool of four that allocates on spawn would be steady garbage
           during a match with several mortars firing. */
        b.outline = new THREE.Mesh(this.outlineGeo, this.outlineMat.clone());
        b.outline.frustumCulled = false;
        b.outline.renderOrder = 997;
        b.outline.visible = false;
        this.scene.add(b.outline);
      }
      b.life = 0;
      b.maxLife = LIFE * (0.9 + Math.random() * 0.2);
      b.radius = radius;
      b.seed = Math.random();
      b.mesh.visible = true;
      b.mesh.position.set(x, y, z);
      b.mesh.rotation.set(Math.random()*3, Math.random()*3, Math.random()*3);
      /* Opens at ~30% rather than at zero. A blast that starts from nothing is
         read as a slow swell, not an impact — and the point at which it is
         measurable is the moment it reaches the circle. */
      b.mesh.scale.setScalar(radius * 0.30);
      b.outline.visible = true;
      b.outline.position.copy(b.mesh.position);
      b.outline.rotation.copy(b.mesh.rotation);
      b.shock.visible = true;
      b.shock.position.set(x, Math.max(0.05, y - radius * 0.10), z);
      b.shock.scale.setScalar(radius * 0.30);
      return b;
    }

    update(dt){
      for(const b of this.b){
        if(!b.mesh || !b.mesh.visible) continue;
        b.life += dt;
        const k = b.life / b.maxLife;
        if(k >= 1){
          b.mesh.visible = false;
          if(b.outline) b.outline.visible = false;
          if(b.shock) b.shock.visible = false;
          continue;
        }
        /* The one number that matters: 0 -> 1 across GROW, eased OUT, so the ball
           leaves fast and settles onto splashRadius rather than creeping into it.
           Linear growth reads as a balloon inflating; the ease reads as a blast. */
        const gk = Math.min(1, b.life / GROW);
        const ease = 1 - Math.pow(1 - gk, 2.4);
        const r = b.radius * (0.30 + 0.70 * ease);
        /* Horizontal radius is EXACTLY splashRadius at gk == 1 — that is the whole
           contract. Vertical is squashed to 0.74 so it reads as a bloom sitting
           on the ground rather than a ball hovering over it; the circle the
           player aimed inside is a ground-plane measurement and the width is what
           has to match. */
        b.mesh.scale.set(r, r * 0.74, r);
        b.mesh.position.y += dt * b.radius * 0.06;
        b.mesh.rotation.y += dt * 0.4;

        /* The outline tracks the ball every frame: same position, same rotation,
           same squash, plus 5.5%. It does NOT inherit the lobe displacement (it
           cannot -- different geometry, undisplaced), which is precisely why it
           is a separate sphere rather than a second pass over the ball's own
           vertices. 5.5% is the number to change if the line reads too thin or
           too heavy. */
        if(b.outline && b.outline.visible){
          b.outline.position.copy(b.mesh.position);
          b.outline.rotation.copy(b.mesh.rotation);
          b.outline.scale.set(r * 1.055, r * 0.74 * 1.055, r * 1.055);
          /* Fades out with the cloud: a hard black rim hanging in the air after
             the fire has gone is the one way an outline can look worse than none. */
          b.outline.material.opacity = 0.92 * Math.max(0, 1 - k * 1.25);
        }

        /* The shockwave is locked to the SAME ease, so its bright rim and the
           ball's silhouette arrive at the damage circle together. A ring that
           landed early or late would tell the player a different radius than the
           one their shell is about to obey. */
        if(b.shock && b.shock.visible){
          b.shock.scale.setScalar(r);
          /* Linear fade, not squared. The squared version was tuned when the ring
             was invisible anyway; once the band was bright enough to see, the
             square crushed it to nothing within a quarter of a second and the
             radius never got communicated at all. */
          b.shock.material.opacity = (1 - k) * 0.95;
        }

        const u = b.u;
        if(u){
          if(u.uTime)  u.uTime.value  += dt;
          if(u.uProg)  u.uProg.value  = Math.min(1, k);
          if(u.uGrow)  u.uGrow.value  = gk;
          if(u.uSeed)  u.uSeed.value  = b.seed;
          if(u.uAlpha) u.uAlpha.value = 1;
        }
      }
    }

    clear(){
      for(const b of this.b){
        if(b.mesh) b.mesh.visible = false;
        if(b.outline) b.outline.visible = false;
        if(b.shock) b.shock.visible = false;
      }
    }
  }

  return {
    get(scene){
      if(!this._fx) this._fx = new MortarBlastFX(scene, !!window.__isWebGPU);
      return this._fx;
    },
    spawn(scene, x, y, z, radius){
      try { return this.get(scene).spawn(x, y, z, radius); }
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

if (typeof window !== 'undefined') window.MortarBlast = MortarBlast;