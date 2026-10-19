class BulletTrailManager {
  constructor(scene, opts){
    this.scene = scene;
    const o = opts || {};
    this.maxTrails = o.maxTrails || 48;
    this.fadeTime = o.fadeTime || 1;
    this.width = o.width || 0.12;
    this.color = new THREE.Color(o.color || 0xffcc00);
    this.maxOpacity = o.maxOpacity != null ? o.maxOpacity : 1;
    this.noBurst = o.noBurst || false;
    this.maxPts = o.maxPts || 32;
    this._pool = [];
    this._active = [];
    this._sparks = [];
    this._sparkPool = [];
    this._sparkTex = this._makeSparkTex();
    this._right = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._toCam = new THREE.Vector3();
    for(let i = 0; i < this.maxTrails; i++) this._pool.push(this._createTrail());
  }

  _createTrail(){
    const maxV = this.maxPts * 2;
    const maxI = (this.maxPts - 1) * 6;
    const posArr = new Float32Array(maxV * 3);
    const idxArr = new Uint16Array(maxI);
    for(let i = 0; i < this.maxPts - 1; i++){
      const vi = i * 2;
      const ii = i * 6;
      idxArr[ii]   = vi;
      idxArr[ii+1] = vi + 1;
      idxArr[ii+2] = vi + 2;
      idxArr[ii+3] = vi + 1;
      idxArr[ii+4] = vi + 3;
      idxArr[ii+5] = vi + 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: this.color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, pts: [], fading: false, fadeTimer: 0, age: 0 };
  }

  _makeSparkTex(){
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,200,100,1)');
    g.addColorStop(1, 'rgba(255,200,100,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  }

  _createSpark(pos){
    const mat = new THREE.SpriteMaterial({ map: this._sparkTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const spr = new THREE.Sprite(mat);
    spr.position.copy(pos);
    spr.scale.setScalar(0.3);
    this.scene.add(spr);
    return { sprite: spr, vel: new THREE.Vector3(), life: 0.3, maxLife: 0.3 };
  }

  _burstSparks(pos, count){
    for(let i = 0; i < count; i++){
      const s = this._sparkPool.length ? this._sparkPool.pop() : this._createSpark(pos);
      s.sprite.position.copy(pos);
      s.sprite.material.opacity = 1;
      s.sprite.visible = true;
      s.life = 0.2 + Math.random() * 0.15;
      s.maxLife = s.life;
      const angle = Math.random() * Math.PI * 2;
      const elev = (Math.random() - 0.5) * Math.PI * 0.6;
      const speed = 3 + Math.random() * 5;
      s.vel.set(Math.cos(angle) * Math.cos(elev) * speed, Math.sin(elev) * speed * 0.6, Math.sin(angle) * Math.cos(elev) * speed);
      s.sprite.scale.setScalar(0.15 + Math.random() * 0.25);
      this._sparks.push(s);
    }
  }

  spawn(startPos){
    if(!this._pool.length) return null;
    const t = this._pool.pop();
    t.pts = [{x: startPos.x, y: startPos.y, z: startPos.z}];
    t.fading = false;
    t.fadeTimer = 0;
    t.age = 0;
    t.mesh.material.color.copy(this.color);
    t.mesh.material.opacity = this.maxOpacity;
    t.mesh.visible = true;
    t.mesh.geometry.setDrawRange(0, 0);
    this._active.push(t);
    return t;
  }

  pushPosition(trail, x, y, z){
    if(!trail || trail.fading) return;
    const pts = trail.pts;
    const last = pts[pts.length - 1];
    const dx = x - last.x, dy = y - last.y, dz = z - last.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if(dist < 1.5) return;
    pts.push({x: x, y: y, z: z});
    if(pts.length > this.maxPts) pts.shift();
  }

  endTrail(trail){
    if(!trail || trail.fading) return;
    trail.fading = true;
    trail.fadeTimer = this.fadeTime;
    if(!this.noBurst){
      const end = trail.pts[trail.pts.length - 1];
      if(end) this._burstSparks({x: end.x, y: end.y, z: end.z}, 4 + Math.floor(Math.random() * 4));
    }
  }

  update(dt, camera){
    const arr = this._active;
    const camPos = camera.position;
    const right = this._right, dir = this._dir, toCam = this._toCam;
    const tmpL = new THREE.Vector3(), tmpR = new THREE.Vector3();

    for(let i = arr.length - 1; i >= 0; i--){
      const t = arr[i];
      const m = t.mesh;
      const posAttr = m.geometry.attributes.position;
      const verts = posAttr.array;
      t.age += dt;

      if(t.fading){
        t.fadeTimer -= dt;
        t.mesh.material.opacity = Math.max(0, t.fadeTimer / this.fadeTime) * this.maxOpacity;
        if(t.fadeTimer <= 0){
          m.visible = false;
          t.mesh.material.color.copy(this.color);
          this._pool.push(t);
          arr.splice(i, 1);
          continue;
        }
      }

      const pts = t.pts;
      const n = pts.length;
      if(n < 2){ m.visible = false; continue; }

      let vi = 0;
      for(let j = 0; j < n; j++){
        const p = pts[j];
        if(j < n - 1){
          const nx = pts[j+1].x - p.x, nz = pts[j+1].z - p.z;
          const nl = Math.sqrt(nx*nx + nz*nz) || 1;
          dir.set(nx / nl, 0, nz / nl);
        } else if(j > 0){
          const px = p.x - pts[j-1].x, pz = p.z - pts[j-1].z;
          const pl = Math.sqrt(px*px + pz*pz) || 1;
          dir.set(px / pl, 0, pz / pl);
        } else {
          dir.set(1, 0, 0);
        }
        toCam.copy(camPos).sub(new THREE.Vector3(p.x, p.y, p.z));
        right.crossVectors(dir, toCam);
        if(right.lengthSq() < 1e-6) right.set(1, 0, 0);
        right.normalize();
        const hw = this.width * 0.5;
        tmpL.set(p.x + right.x * hw, p.y + right.y * hw, p.z + right.z * hw);
        tmpR.set(p.x - right.x * hw, p.y - right.y * hw, p.z - right.z * hw);
        verts[vi] = tmpL.x; verts[vi+1] = tmpL.y; verts[vi+2] = tmpL.z;
        verts[vi+3] = tmpR.x; verts[vi+4] = tmpR.y; verts[vi+5] = tmpR.z;
        vi += 6;
      }
      posAttr.needsUpdate = true;
      m.geometry.setDrawRange(0, (n - 1) * 2 * 3);
      m.visible = true;
    }

    for(let i = this._sparks.length - 1; i >= 0; i--){
      const s = this._sparks[i];
      s.life -= dt;
      if(s.life <= 0){
        s.sprite.visible = false;
        this._sparkPool.push(s);
        this._sparks.splice(i, 1);
        continue;
      }
      const p = s.life / s.maxLife;
      s.sprite.material.opacity = p * p;
      s.sprite.scale.multiplyScalar(1 - dt * 1.5);
      s.sprite.position.x += s.vel.x * dt;
      s.sprite.position.y += s.vel.y * dt;
      s.sprite.position.z += s.vel.z * dt;
      s.vel.y -= 9.8 * dt;
    }
  }

  dispose(){
    [...this._active, ...this._pool].forEach(t => {
      this.scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
    });
    this._active.length = 0;
    this._pool.length = 0;
    this._sparks.forEach(s => { this.scene.remove(s.sprite); s.sprite.material.dispose(); });
    this._sparkPool.forEach(s => { this.scene.remove(s.sprite); s.sprite.material.dispose(); });
    this._sparks.length = 0;
    this._sparkPool.length = 0;
    if(this._sparkTex) this._sparkTex.dispose();
  }
}
