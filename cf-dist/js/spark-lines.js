/* ============================================================
   SparkLines — glowing-line hit sparks.

   A shell striking a tank kicks up 2-5 SHORT GLOWING LINES from
   the exact bullet-impact point: bright streaks that launch away
   from the tank (roughly half up, half sideways), arc under a
   little gravity and fade out in under half a second.

   WHY A SINGLE BATCHED MESH, NOT SPRITES.

   The rest of the effects layer draws one billboard sprite per
   particle, which is fine for smoke but wrong for a streak: a
   round texture cannot read as a line of light, stretching a
   sprite only squares it off, and the spark count is capped by
   how many draw calls we are willing to pay. So this system is
   ONE mesh: every live spark is one quad inside a shared
   BufferGeometry, head and tail positions are written on the CPU
   each frame (cheap: at most 64 sparks), and a small vertex
   shader turns each quad into a camera-facing line. One draw
   call, no textures — the glow is built from the gradient across
   and along the quad inside the fragment shader.

   CAPACITY. 64 concurrent sparks, reused ring-buffer style. A
   full pool recycles the oldest slot, so a firefight can never
   queue effects behind each other and never grow the batch: the
   worst case for the whole battle is one 64-quad mesh.
   ============================================================ */
const SparkLines = (() => {
  const MAX = 64;

  /* Fixed per-spark records, reused ring-buffer style. Never allocated
     again after startup. */
  const slots = new Array(MAX);
  for(let i = 0; i < MAX; i++){
    slots[i] = {
      x: 0, y: 0, z: 0,          /* head position */
      vx: 0, vy: 0, vz: 0,
      life: 0, maxLife: 1,
      width: 0.05,               /* half-width of the ribbon */
      tailK: 0.055,              /* tail lags head by vel * tailK seconds */
      active: false,
    };
  }
  let cursor = 0;                /* next slot to recycle when the pool is full */

  let mesh = null;
  let geo = null;
  /* At combat range the old 1.6x intensity read as a hair-thin flicker under
     the fireball's bloom — verified dim in a live match. 3.2 carries the
     orange-to-white gradient clearly at 80+ units. */
  let mat = null;
  let scene = null;

  /* Scratch buffers, fixed size, written per frame — no allocation during
     play ever. */
  const _headArr  = new Float32Array(MAX * 4 * 3);
  const _tailArr  = new Float32Array(MAX * 4 * 3);
  const _alphaArr = new Float32Array(MAX * 4);
  const _widthArr = new Float32Array(MAX * 4);

  /* Corner template: uv.x is the side (-1/+1) and uv.y runs tail(0)..head(1).
     Corner order matches the index buffer: (tail,-1)(tail,+1)(head,-1)(head,+1). */
  const _uvArr = new Float32Array(MAX * 4 * 2);
  for(let q = 0; q < MAX; q++){
    const b = q * 8;
    _uvArr[b+0] = -1; _uvArr[b+1] = 0;
    _uvArr[b+2] =  1; _uvArr[b+3] = 0;
    _uvArr[b+4] = -1; _uvArr[b+5] = 1;
    _uvArr[b+6] =  1; _uvArr[b+7] = 1;
  }

  function build(){
    if(mesh) return true;
    geo = new THREE.BufferGeometry();
    /* position IS the head corner position (the shader draws everything
       from head + tail + uv). */
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 4 * 3), 3));
    geo.setAttribute('aTail',    new THREE.BufferAttribute(_tailArr, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(_uvArr, 2));
    geo.setAttribute('aWidth',   new THREE.BufferAttribute(_widthArr, 1));
    geo.setAttribute('aAlpha',   new THREE.BufferAttribute(_alphaArr, 1));

    /* Two triangles per quad, indexed once, forever. */
    const idx = new Uint16Array(MAX * 6);
    for(let q = 0; q < MAX; q++){
      const v = q * 4;
      idx[q*6+0] = v+0; idx[q*6+1] = v+1; idx[q*6+2] = v+2;
      idx[q*6+3] = v+2; idx[q*6+4] = v+1; idx[q*6+5] = v+3;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);

    mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: [
        'attribute vec3 aTail;',
        'attribute float aWidth;',
        'attribute float aAlpha;',
        'varying float vAlpha;',
        'varying float vT;',
        'varying float vSide;',
        'void main(){',
        '  vec3 head = position;',
        '  vec3 dir = head - aTail;',
        '  float len = length(dir);',
        '  dir = len > 1e-5 ? dir / len : vec3(0.0, 1.0, 0.0);',
        '  /* Billboard: width axis is perpendicular to both the streak and the',
        '     eye line, so the quad always faces the player wherever it flies. */',
        '  vec3 vd = cameraPosition - head;',
        '  float vdl = length(vd);',
        '  vd = vdl > 1e-5 ? vd / vdl : vec3(0.0, 0.0, 1.0);',
        '  vec3 perp = cross(dir, vd);',
        '  float pl = length(perp);',
        '  perp = pl > 1e-5 ? perp / pl : vec3(1.0, 0.0, 0.0);',
        '  float side = uv.x;   /* -1 or +1 */',
        '  float t = uv.y;      /* 0 = tail, 1 = head */',
        '  vAlpha = aAlpha; vT = t; vSide = side;',
        '  vec3 p = mix(aTail, head, t) + perp * side * aWidth * (1.0 - t * 0.45);',
        '  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'precision mediump float;',
        'varying float vAlpha;',
        'varying float vT;',
        'varying float vSide;',
        'void main(){',
        '  /* Cross-section falloff: a soft line of light, not a hard bar. */',
        '  float edge = 1.0 - abs(vSide);',
        '  float lobe = pow(max(0.0, edge), 1.6);',
        '  /* Along the streak: dim amber tail rising to a white-hot head. */',
        '  float head = smoothstep(0.0, 0.22, vT) * (0.30 + 0.70 * vT);',
        '  vec3 col = mix(vec3(1.0, 0.62, 0.18), vec3(1.0, 0.97, 0.90), vT * vT);',
        '  float i = lobe * head * vAlpha * 3.2;',
        '  gl_FragColor = vec4(col * i, i);',
        '}'
      ].join('\n')
    });

    mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 995;
    mesh.visible = false;
    return true;
  }

  return {
    /* Fire `count` glowing lines from one impact point. (ax, az) is the
       direction pointing AWAY from the tank, on the ground plane. */
    spawn(sceneIn, hx, hy, hz, ax, az, opts){
      const o = opts || {};
      if(!build()) return;
      const n = Math.max(1, Math.min(8, o.count | 0 || (4 + (Math.random() * 4 | 0))));
      /* Follow the scene that is asking (rebuilt on new match). */
      if(scene !== sceneIn) scene = sceneIn;
      if(!scene) return;
      if(mesh.parent !== scene) scene.add(mesh);

      /* Away direction: a hit that lands dead-centre (or a caller with no
         direction) falls back to a random side so sparks never refuse to
         fly. */
      let ox = ax || 0, oz = az || 0;
      const ol = Math.hypot(ox, oz);
      if(ol < 1e-4){ const a = Math.random() * Math.PI * 2; ox = Math.cos(a); oz = Math.sin(a); }
      else { ox /= ol; oz /= ol; }

      for(let i = 0; i < n; i++){
        const s = slots[cursor];
        cursor = (cursor + 1) % MAX;
        /* Cone away from the hull: ~±30° of lateral jitter. */
        const la = Math.atan2(oz, ox) + (Math.random() - 0.5) * 1.05;
        /* "Halfly up / halfly side": vertical share and horizontal share are
           the same order of magnitude, so sparks fountain upward-and-out
           rather than skimming the deck or rocketing straight up. */
        const fwd = (0.45 + Math.random() * 0.75);
        const spd = (o.speed || 12) * (0.8 + Math.random() * 0.5);
        s.vx = Math.cos(la) * spd * fwd;
        s.vz = Math.sin(la) * spd * fwd;
        s.vy = spd * fwd * (0.55 + Math.random() * 0.5);
        /* Tight jitter around the exact bullet-impact point, not the tank. */
        s.x = hx + (Math.random() - 0.5) * 0.10;
        s.y = hy + (Math.random() - 0.5) * 0.10;
        s.z = hz + (Math.random() - 0.5) * 0.10;
        s.maxLife = s.life = (o.life || 0.5) * (0.7 + Math.random() * 0.6);
        s.width = (o.width || 0.10) * (0.75 + Math.random() * 0.5);
        s.tailK = o.tailK || 0.16;
        s.active = true;
      }
    },

    update(sceneIn, dt){
      if(!mesh || !sceneIn) return;
      if(scene !== sceneIn){ scene = sceneIn; if(mesh.parent !== scene) scene.add(mesh); }
      let n = 0; /* active-quad write cursor */
      for(let i = 0; i < MAX; i++){
        const s = slots[i];
        if(!s.active) continue;
        s.life -= dt;
        if(s.life <= 0){ s.active = false; continue; }
        /* Motion: slight air drag + gravity, so the streaks arc — not
           perfectly straight rays. */
        const drag = Math.max(0, 1 - 2.2 * dt);
        s.vx *= drag; s.vz *= drag;
        s.vy = s.vy * drag - 9.5 * dt;
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;

        /* Fade: quickly in (avoids a hard pop), then off on a steep curve. */
        const age = s.maxLife - s.life;
        const inK = Math.min(1, age * 30);
        const outK = s.life / s.maxLife;
        const a = inK * outK * outK;
        const k = s.tailK;

        const b = n * 12;
        _headArr[b+0] = _headArr[b+3] = _headArr[b+6] = _headArr[b+9]  = s.x;
        _headArr[b+1] = _headArr[b+4] = _headArr[b+7] = _headArr[b+10] = s.y;
        _headArr[b+2] = _headArr[b+5] = _headArr[b+8] = _headArr[b+11] = s.z;
        _tailArr[b+0] = _tailArr[b+3] = _tailArr[b+6] = _tailArr[b+9]  = s.x - s.vx * k;
        _tailArr[b+1] = _tailArr[b+4] = _tailArr[b+7] = _tailArr[b+10] = s.y - s.vy * k;
        _tailArr[b+2] = _tailArr[b+5] = _tailArr[b+8] = _tailArr[b+11] = s.z - s.vz * k;

        const ab = n * 4;
        const w = s.width;
        _alphaArr[ab+0] = a; _alphaArr[ab+1] = a; _alphaArr[ab+2] = a; _alphaArr[ab+3] = a;
        _widthArr[ab+0] = w; _widthArr[ab+1] = w; _widthArr[ab+2] = w; _widthArr[ab+3] = w;
        n++;
      }
      geo.setDrawRange(0, n * 6);
      mesh.visible = n > 0;
      if(n > 0){
        geo.attributes.position.needsUpdate = true;
        geo.attributes.aTail.needsUpdate = true;
        geo.attributes.aAlpha.needsUpdate = true;
        geo.attributes.aWidth.needsUpdate = true;
      }
    },

    /* Debug/tests */
    get liveCount(){ let n = 0; for(let i = 0; i < MAX; i++) if(slots[i].active) n++; return n; },
    get capacity(){ return MAX; },
  };
})();
window.SparkLines = SparkLines;
