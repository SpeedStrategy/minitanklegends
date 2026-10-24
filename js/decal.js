/* ============================================================
   decal.js — Spray System for Three.js r128

   Uses the official THREE.DecalGeometry from Three.js examples.
   Requires: DecalGeometry.js loaded via CDN in index.html

   Usage:
     // 1. Load a spray texture
     SpraySystem.loadTexture('spray_skull', 'assets/sprays/skull.png');

     // 2. Place a spray via raycast
     SpraySystem.place({
       textureKey: 'spray_skull',
       scene: scene,
       raycaster: raycaster,
       size: { w: 2, h: 2 },
       lifetime: 30,          // seconds, 0 = permanent
       depthTest: true,
     });

     // 3. Update each frame (for fading / expiry)
     SpraySystem.update();

     // 4. Clear all sprays
     SpraySystem.clear();
   ============================================================ */


const SpraySystem = window.SpraySystem = {

  _textures: {},    // key → THREE.Texture
  _meshes: [],      // active spray meshes
  _maxSprays: 50,

  /* Load a spray texture from URL */
  loadTexture(key, url, cb) {
    if (this._textures[key]) { if (cb) cb(this._textures[key]); return; }
    const loader = new THREE.TextureLoader();
    loader.load(url, (tex) => {
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      this._textures[key] = tex;
      if (cb) cb(tex);
    });
  },

  /* Register an already-loaded texture */
  setTexture(key, tex) {
    this._textures[key] = tex;
  },

  /* Place a spray on the first mesh hit by a ray */
  place(opts) {
    const texKey    = opts.textureKey;
    const scene     = opts.scene;
    const raycaster = opts.raycaster;
    const size      = opts.size || { w: 2, h: 2 };
    const lifetime  = opts.lifetime != null ? opts.lifetime : 0;
    const depthTest = opts.depthTest != null ? opts.depthTest : true;
    const opacity   = opts.opacity != null ? opts.opacity : 1;
    const rotation  = opts.rotation || 0;  // Z-axis rotation in radians

    const tex = this._textures[texKey];
    if (!tex) { console.warn('SpraySystem: texture not loaded:', texKey); return null; }

    const intersects = raycaster.intersectObjects(scene.children, true);
    if (!intersects.length) return null;

    const hit = intersects[0];
    const mesh = hit.object;

    if (!mesh.geometry || !mesh.geometry.getAttribute('position')) return null;

    const pos  = hit.point.clone();
    const norm = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();

    // Build orientation from hit normal
    const quat = new THREE.Quaternion();
    quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), norm);

    // Apply user rotation around the decal's local Z axis
    if (rotation) {
      const rQuat = new THREE.Quaternion();
      rQuat.setFromAxisAngle(norm, rotation);
      quat.premultiply(rQuat);
    }

    const dim = new THREE.Vector3(size.w, size.h, 0.1);
    const decalGeo = new THREE.DecalGeometry(mesh, pos, quat, dim);

    if (decalGeo.attributes.position.count === 0) {
      decalGeo.dispose();
      return null;
    }

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: opacity,
      depthTest: depthTest,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      side: THREE.DoubleSide,
    });

    const decalMesh = new THREE.Mesh(decalGeo, mat);
    decalMesh.renderOrder = 998;
    scene.add(decalMesh);

    const entry = {
      mesh: decalMesh,
      texKey: texKey,
      born: performance.now(),
      lifetime: lifetime * 1000,
      fadeStart: lifetime > 0 ? (lifetime * 1000) * 0.7 : 0,
      alive: true,
    };

    this._meshes.push(entry);

    while (this._meshes.length > this._maxSprays) {
      const old = this._meshes.shift();
      this._destroy(old);
    }

    return entry;
  },

  /* Update fading / expiry — call each frame */
  update() {
    const now = performance.now();
    for (let i = this._meshes.length - 1; i >= 0; i--) {
      const e = this._meshes[i];
      if (!e.alive) continue;

      const age = now - e.born;

      if (e.lifetime > 0 && age > e.lifetime) {
        this._destroy(e);
        this._meshes.splice(i, 1);
        continue;
      }

      if (e.fadeStart > 0 && age > e.fadeStart) {
        const t = (age - e.fadeStart) / (e.lifetime - e.fadeStart);
        e.mesh.material.opacity = 1 - t;
      }
    }
  },

  /* Remove a specific spray */
  remove(entry) {
    const idx = this._meshes.indexOf(entry);
    if (idx !== -1) {
      this._destroy(entry);
      this._meshes.splice(idx, 1);
    }
  },

  /* Remove all sprays */
  clear() {
    for (const e of this._meshes) this._destroy(e);
    this._meshes.length = 0;
  },

  _destroy(e) {
    e.alive = false;
    if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
    e.mesh.geometry.dispose();
    e.mesh.material.dispose();
  },
};
