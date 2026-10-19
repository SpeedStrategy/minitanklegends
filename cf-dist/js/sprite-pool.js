/* ============================================================
   sprite-pool.js — Recycled sprite particle pool
   Pre-allocates sprites + materials, reuses them to avoid
   per-particle alloc/GC churn.  Call acquire() to get a sprite,
   release() when done.  Max pool size is bounded.
   ============================================================ */
var SpritePool = {
  _pools: {},
  _maxPerType: 120,

  acquire(texName, opts){
    const key = texName || 'flare';
    let pool = this._pools[key];
    if(!pool){
      pool = { free: [], active: [] };
      this._pools[key] = pool;
    }
    let sprite;
    if(pool.free.length){
      sprite = pool.free.pop();
    } else {
      const tex = (typeof VFX !== 'undefined') ? VFX.getTex(key) : null;
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 1,
        depthWrite: false,
        blending: (opts && opts.blend === 'normal') ? THREE.NormalBlending : THREE.AdditiveBlending,
      });
      sprite = new THREE.Sprite(mat);
      sprite.frustumCulled = false;
    }
    const o = opts || {};
    if(o.color != null){ sprite.material.color.set(o.color); } else { sprite.material.color.set(0xffffff); }
    sprite.material.blending = (o.blend === 'normal') ? THREE.NormalBlending : THREE.AdditiveBlending;
    sprite.material.opacity = 1;
    sprite.visible = true;
    sprite.rotation.z = 0;
    pool.active.push(sprite);
    return sprite;
  },

  release(sprite, texName){
    if(!sprite) return;
    const key = texName || 'flare';
    const pool = this._pools[key];
    if(!pool) return;
    sprite.visible = false;
    sprite.material.opacity = 0;
    const idx = pool.active.indexOf(sprite);
    if(idx >= 0) pool.active.splice(idx, 1);
    if(pool.free.length < this._maxPerType){
      pool.free.push(sprite);
    } else {
      sprite.parent && sprite.parent.remove(sprite);
      sprite.material.dispose();
    }
  },

  releaseAll(texName){
    const key = texName || 'flare';
    const pool = this._pools[key];
    if(!pool) return;
    for(const s of pool.active){
      s.visible = false;
      s.material.opacity = 0;
      pool.free.push(s);
    }
    pool.active.length = 0;
  },

  disposeAll(){
    for(const key in this._pools){
      const pool = this._pools[key];
      for(const s of pool.active){
        s.parent && s.parent.remove(s);
        s.material.dispose();
      }
      for(const s of pool.free){
        s.parent && s.parent.remove(s);
        s.material.dispose();
      }
      pool.active.length = 0;
      pool.free.length = 0;
    }
    this._pools = {};
  }
};
