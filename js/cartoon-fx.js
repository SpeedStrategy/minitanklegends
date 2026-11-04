/* ============================================================
   cartoon-fx.js — hit sparks and explosions, cartoon style.

   Everything here is pooled InstancedMeshes, so a whole battle's worth of
   sparks is one draw call, explosion fire one, smoke one, their black
   outlines two, debris one and shock rings one, however many are live.
   Nothing is created per hit; spawning only writes into the pools.

     CartoonFX.sparks(scene, x, y, z, dirX, dirZ, opts)
       Hot metal sparks thrown away from an impact. dir is the way they fly
       (away from the hull that was hit); they fan out, arc down under gravity
       and stretch along their speed.

     CartoonFX.explosion(scene, x, y, z, radius, opts)
       A real explosion read as a cartoon: a white-hot flash that swells into
       yellow and orange fire balls, rolls up into dark toon-shaded smoke,
       throws debris and a shock ring along the ground. Fire and smoke carry
       the game's black outline.

     CartoonFX.update(scene, dt)   once per frame
   ============================================================ */
const CartoonFX = (() => {
  const MAX_SPARKS = 320, MAX_FIRE = 160, MAX_SMOKE = 140, MAX_DEBRIS = 90, MAX_RINGS = 12;
  const GRAVITY = 26;
  let scene = null, built = false;
  let sparkMesh, fireMesh, fireLine, smokeMesh, smokeLine, debrisMesh, ringMesh;
  const sparks = [], fire = [], smoke = [], debris = [], rings = [];
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  const _z = new THREE.Vector3(0, 0, 1), _v = new THREE.Vector3(), _c = new THREE.Color(), _e = new THREE.Euler();

  /* Black hull outline that shares the puffs' instance matrices: same draw
     data, pushed out along the normal, back faces only. */
  function outlineOf(src, geo, max, width){
    const mat = new THREE.MeshBasicMaterial({ color: 0x0b0c0e, side: THREE.BackSide, transparent: true, depthWrite: false });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n transformed += normal * ' + width.toFixed(3) + ';');
    };
    const m = new THREE.InstancedMesh(geo, mat, max);
    m.instanceMatrix = src.instanceMatrix;
    m.count = 0; m.frustumCulled = false; m.renderOrder = 5;
    return m;
  }

  function build(sc){
    if(built && scene === sc) return true;
    if(typeof THREE === 'undefined' || !sc) return false;
    if(built) clear();
    scene = sc;
    const toon = (opts) => (typeof Toon !== 'undefined' && Toon.mat) ? Toon.mat(opts) : new THREE.MeshLambertMaterial(opts);

    const sGeo = new THREE.BoxGeometry(1, 1, 1);
    sGeo.translate(0, 0, -0.5);                      /* tail behind the head */
    sparkMesh = new THREE.InstancedMesh(sGeo, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }), MAX_SPARKS);
    sparkMesh.setColorAt(0, _c.set(0xffffff));

    const puff = new THREE.IcosahedronGeometry(1, 1);
    fireMesh = new THREE.InstancedMesh(puff, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false }), MAX_FIRE);
    fireMesh.setColorAt(0, _c.set(0xffffff));
    fireLine = outlineOf(fireMesh, puff, MAX_FIRE, 0.07);

    smokeMesh = new THREE.InstancedMesh(puff, toon({ color: 0xffffff }), MAX_SMOKE);
    smokeMesh.setColorAt(0, _c.set(0x555555));
    smokeLine = outlineOf(smokeMesh, puff, MAX_SMOKE, 0.06);

    debrisMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.6, 0.8), toon({ color: 0x3a3a3e }), MAX_DEBRIS);
    debrisMesh.castShadow = false;

    const rGeo = new THREE.RingGeometry(0.82, 1, 40);
    rGeo.rotateX(-Math.PI / 2);
    ringMesh = new THREE.InstancedMesh(rGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false, fog: false }), MAX_RINGS);

    for(const m of [sparkMesh, fireMesh, smokeMesh, debrisMesh, ringMesh]){
      m.count = 0; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
    }
    sparkMesh.renderOrder = 6; fireMesh.renderOrder = 4; smokeMesh.renderOrder = 3; ringMesh.renderOrder = 2;
    scene.add(fireLine); scene.add(smokeLine);
    built = true;
    return true;
  }

  function clear(){
    for(const m of [sparkMesh, fireMesh, fireLine, smokeMesh, smokeLine, debrisMesh, ringMesh]){
      if(!m) continue;
      if(m.parent) m.parent.remove(m);
      try { m.material.dispose(); } catch(e){}
    }
    try { sparkMesh.geometry.dispose(); fireMesh.geometry.dispose(); debrisMesh.geometry.dispose(); ringMesh.geometry.dispose(); } catch(e){}
    sparks.length = fire.length = smoke.length = debris.length = rings.length = 0;
    built = false; scene = null;
  }

  const rnd = (a, b) => a + Math.random() * (b - a);

  /* ---------------------------------------------------------------- sparks */
  function spawnSparks(sc, x, y, z, dx, dz, opts){
    if(!build(sc)) return;
    const o = opts || {};
    const n = Math.min(o.count || 10, 24);
    const speed = o.speed || 13;
    const len = Math.hypot(dx || 0, dz || 0);
    const hasDir = len > 1e-4;
    const bx = hasDir ? dx / len : 0, bz = hasDir ? dz / len : 0;
    for(let i = 0; i < n; i++){
      if(sparks.length >= MAX_SPARKS) sparks.shift();
      /* A cone around the throw direction, or all round when there is none,
         always kicked upward a little so they arc. */
      let a = hasDir ? Math.atan2(bx, bz) + rnd(-1.1, 1.1) : rnd(0, Math.PI * 2);
      const v = speed * rnd(0.45, 1.25);
      sparks.push({
        x, y, z,
        vx: Math.sin(a) * v, vz: Math.cos(a) * v, vy: rnd(1.5, 7) + (hasDir ? 0 : 2),
        life: rnd(0.22, 0.5), age: 0, w: rnd(0.07, 0.12),
      });
    }
  }

  /* ------------------------------------------------------------- explosion */
  function spawnExplosion(sc, x, y, z, radius, opts){
    if(!build(sc)) return;
    const R = Math.max(1.5, radius || 6);
    const o = opts || {};
    const big = R >= 6;
    /* The flash and fire: a few large balls in the middle, smaller ones round
       them, all growing fast and cooling white -> yellow -> orange -> red. */
    const nf = Math.min(big ? 14 : 8, MAX_FIRE);
    for(let i = 0; i < nf; i++){
      if(fire.length >= MAX_FIRE) fire.shift();
      const a = rnd(0, Math.PI * 2), r = i < 3 ? 0 : rnd(0.1, 0.45) * R;
      fire.push({
        x: x + Math.sin(a) * r, y: y + rnd(0.1, 0.35) * R, z: z + Math.cos(a) * r,
        vx: Math.sin(a) * rnd(1, 4), vy: rnd(1.5, 4.5), vz: Math.cos(a) * rnd(1, 4),
        size: (i < 3 ? rnd(0.42, 0.55) : rnd(0.2, 0.36)) * R, age: -i * 0.012, life: rnd(0.38, 0.6),
      });
    }
    /* Smoke rolls up out of the fire and lingers. */
    const ns = Math.min(big ? 12 : 6, MAX_SMOKE);
    for(let i = 0; i < ns; i++){
      if(smoke.length >= MAX_SMOKE) smoke.shift();
      const a = rnd(0, Math.PI * 2), r = rnd(0, 0.4) * R;
      smoke.push({
        x: x + Math.sin(a) * r, y: y + rnd(0.2, 0.6) * R, z: z + Math.cos(a) * r,
        vx: Math.sin(a) * rnd(0.4, 1.6), vy: rnd(2, 4.5), vz: Math.cos(a) * rnd(0.4, 1.6),
        size: rnd(0.25, 0.42) * R, age: -rnd(0.12, 0.3), life: rnd(1.2, 1.9),
        shade: rnd(0.22, 0.38),
      });
    }
    if(o.debris !== false){
      const nd = big ? 10 : 4;
      for(let i = 0; i < nd; i++){
        if(debris.length >= MAX_DEBRIS) debris.shift();
        const a = rnd(0, Math.PI * 2), v = rnd(6, 13) * Math.min(1.6, R / 6);
        debris.push({ x, y: y + 0.5, z, vx: Math.sin(a) * v, vz: Math.cos(a) * v, vy: rnd(6, 13),
          gy: o.groundY != null ? o.groundY : y - 0.3, size: rnd(0.25, 0.55), age: 0, life: rnd(1.1, 1.8),
          rx: rnd(0, 6), ry: rnd(0, 6), sr: rnd(-12, 12) });
      }
    }
    if(rings.length >= MAX_RINGS) rings.shift();
    rings.push({ x, y: (o.groundY != null ? o.groundY : y) + 0.15, z, R: R * 1.3, age: 0, life: 0.45 });
    /* A spray of sparks from the core sells the bang. */
    spawnSparks(sc, x, y + 0.4 * R, z, 0, 0, { count: big ? 18 : 8, speed: 14 + R });
  }

  /* --------------------------------------------------------------- update */
  function fireColor(t){
    /* white-hot -> yellow -> orange -> deep red */
    if(t < 0.12) return _c.setRGB(1, 1, 0.9);
    if(t < 0.35) return _c.setRGB(1, 0.86, 0.25);
    if(t < 0.65) return _c.setRGB(1, 0.52, 0.1);
    return _c.setRGB(0.78, 0.2, 0.06);
  }

  function update(sc, dt){
    if(!built) return;
    if(sc && sc !== scene){ clear(); return; }
    dt = Math.min(dt || 0.016, 0.05);
    let n = 0;
    for(let i = sparks.length - 1; i >= 0; i--){
      const s = sparks[i];
      s.age += dt;
      if(s.age >= s.life){ sparks[i] = sparks[sparks.length - 1]; sparks.pop(); continue; }
      s.vy -= GRAVITY * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
      _v.set(s.vx / sp, s.vy / sp, s.vz / sp);
      _q.setFromUnitVectors(_z, _v);
      const k = 1 - s.age / s.life;
      _s.set(s.w, s.w, Math.min(1.6, sp * 0.06) * (0.4 + 0.6 * k));
      _m.compose(_p.set(s.x, s.y, s.z), _q, _s);
      sparkMesh.setMatrixAt(n, _m);
      sparkMesh.setColorAt(n, _c.setRGB(1, 0.75 + 0.25 * k, 0.35 + 0.55 * k * k).multiplyScalar(k));
      n++;
    }
    sparkMesh.count = n;
    if(n){ sparkMesh.instanceMatrix.needsUpdate = true; sparkMesh.instanceColor.needsUpdate = true; }

    n = 0;
    for(let i = fire.length - 1; i >= 0; i--){
      const f = fire[i];
      f.age += dt;
      if(f.age >= f.life){ fire[i] = fire[fire.length - 1]; fire.pop(); continue; }
      if(f.age < 0) continue;
      const t = f.age / f.life;
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
      f.vx *= 0.92; f.vz *= 0.92;
      /* Pops up fast, then shrinks away as it cools. */
      const sc2 = f.size * (t < 0.25 ? 0.35 + 2.6 * t : 1.0 - 0.75 * (t - 0.25) / 0.75);
      _m.compose(_p.set(f.x, f.y, f.z), _q.identity(), _s.set(sc2, sc2 * 0.92, sc2));
      fireMesh.setMatrixAt(n, _m);
      fireMesh.setColorAt(n, fireColor(t));
      n++;
    }
    fireMesh.count = fireLine.count = n;
    if(n){ fireMesh.instanceMatrix.needsUpdate = true; fireMesh.instanceColor.needsUpdate = true; }

    n = 0;
    for(let i = smoke.length - 1; i >= 0; i--){
      const p = smoke[i];
      p.age += dt;
      if(p.age >= p.life){ smoke[i] = smoke[smoke.length - 1]; smoke.pop(); continue; }
      if(p.age < 0) continue;
      const t = p.age / p.life;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vy *= 0.97;
      const sc2 = p.size * (0.6 + 0.9 * Math.min(1, t * 2.2)) * (t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1);
      _m.compose(_p.set(p.x, p.y, p.z), _q.identity(), _s.setScalar(Math.max(0.001, sc2)));
      smokeMesh.setMatrixAt(n, _m);
      /* Starts lit orange from the fire under it, then goes to soot grey. */
      const warm = Math.max(0, 1 - t * 4);
      smokeMesh.setColorAt(n, _c.setRGB(p.shade + 0.6 * warm, p.shade + 0.25 * warm, p.shade));
      n++;
    }
    smokeMesh.count = smokeLine.count = n;
    if(n){ smokeMesh.instanceMatrix.needsUpdate = true; smokeMesh.instanceColor.needsUpdate = true; }

    n = 0;
    for(let i = debris.length - 1; i >= 0; i--){
      const d = debris[i];
      d.age += dt;
      if(d.age >= d.life){ debris[i] = debris[debris.length - 1]; debris.pop(); continue; }
      if(d.y > d.gy){
        d.vy -= GRAVITY * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        d.rx += d.sr * dt; d.ry += d.sr * 0.7 * dt;
        if(d.y <= d.gy){ d.y = d.gy; d.vx = d.vz = d.vy = 0; }
      }
      const k = d.age > d.life - 0.3 ? (d.life - d.age) / 0.3 : 1;
      _q.setFromEuler(_e.set(d.rx, d.ry, 0));
      _m.compose(_p.set(d.x, d.y, d.z), _q, _s.setScalar(d.size * k));
      debrisMesh.setMatrixAt(n, _m);
      n++;
    }
    debrisMesh.count = n;
    if(n) debrisMesh.instanceMatrix.needsUpdate = true;

    n = 0;
    for(let i = rings.length - 1; i >= 0; i--){
      const r = rings[i];
      r.age += dt;
      if(r.age >= r.life){ rings[i] = rings[rings.length - 1]; rings.pop(); continue; }
      const t = r.age / r.life;
      const sc2 = r.R * (0.25 + 0.75 * Math.sqrt(t));
      _m.compose(_p.set(r.x, r.y, r.z), _q.identity(), _s.set(sc2, 1, sc2));
      ringMesh.setMatrixAt(n, _m);
      n++;
    }
    ringMesh.count = n;
    if(n) ringMesh.instanceMatrix.needsUpdate = true;
    ringMesh.material.opacity = rings.length ? 0.5 * (1 - Math.min(1, rings[0].age / rings[0].life)) : 0;
  }

  return { sparks: spawnSparks, explosion: spawnExplosion, update, clear };
})();
window.CartoonFX = CartoonFX;
