/* ============================================================
   fog.js — fog of war.

   The whole map sits under dark fog. Around you and every teammate it clears
   out to a distance set by that tank's view range, and walls cast shadows into
   it: you see up to a wall, not past it. Nothing is remembered, so ground you
   leave fogs over again. Enemy tanks are hidden unless a teammate's view
   reaches them.

   HOW: a few times a second each ally casts a fan of rays against the map and
   its reach per direction is kept. Those polygons are punched out of a canvas
   that is the alpha of one dark plane over the map, and the same reach table
   answers "can anyone on my team see this tank?" without another raycast.
   Bots keep their own line-of-sight rules; this is only what the player sees.
   ============================================================ */
const FogOfWar = (() => {
  const RAYS = 120;
  const UPDATE_EVERY = 0.08;      /* seconds between vision updates */
  const WALL_PEEK = 2.5;          /* a wall's own face stays visible */
  const SIZE_OK = 512, SIZE_PHONE = 320;

  let _mesh = null, _ctx = null, _tex = null, _span = 0, _size = 0;
  let _timer = 0, _active = false;
  let _views = [];                /* [{x, z, reach:Float32Array}] */

  function rangeOf(t){
    return (t.viewRange || t.def.viewRange || 80) * ((CONFIG && CONFIG.FOG_VIEW_SCALE) || 0.875);
  }

  function isAlly(me, t){
    if(t === me) return true;
    if(me.team && t.team === me.team) return true;
    return !!((me.allyId && t.id === me.allyId) || (t.allyId && t.allyId === me.id));
  }

  /* Maps blocks, not units: tanks and shells never stop a line of sight. */
  const notActor = (c) => { const u = c && c.userData; return !(u && (u.type === 'tank' || u.type === 'shell')); };

  function castView(game, t){
    const R = rangeOf(t);
    const reach = new Float32Array(RAYS);
    const pw = game.physicsWorld;
    /* Above the roof: a nearby slope should not blind it, a real wall still blocks. */
    const y = t.root.position.y + (t.colOffY || 1) + (t.colHalfH || 1) + 1;
    let ray = null;
    if(pw && typeof RAPIER !== 'undefined' && RAPIER.Ray) ray = new RAPIER.Ray({ x: t.x, y, z: t.z }, { x: 0, y: 0, z: 1 });
    for(let i = 0; i < RAYS; i++){
      let r = R;
      if(ray){
        const a = i / RAYS * Math.PI * 2;
        ray.dir = { x: Math.sin(a), y: 0, z: Math.cos(a) };
        try {
          const hit = pw.castRay(ray, R, true, undefined, undefined, undefined, undefined, notActor);
          if(hit){
            const toi = hit.timeOfImpact != null ? hit.timeOfImpact : hit.toi;
            if(toi != null) r = Math.min(R, toi + WALL_PEEK);
          }
        } catch(e){}
      }
      reach[i] = r;
    }
    return { x: t.x, z: t.z, reach };
  }

  /* Is a point inside anyone's current view? pad = the tank's own size, so one
     poking out from behind a corner shows rather than popping in at its centre. */
  function seen(x, z, pad){
    for(const v of _views){
      const dx = x - v.x, dz = z - v.z;
      const d = Math.hypot(dx, dz);
      let a = Math.atan2(dx, dz);
      if(a < 0) a += Math.PI * 2;
      const i = Math.round(a / (Math.PI * 2) * RAYS) % RAYS;
      if(d - (pad || 0) <= v.reach[i]) return true;
    }
    return false;
  }

  function ensureMesh(game){
    const half = (game.world && game.world.half) || 500;
    const span = (half + 150) * 2;
    if(_mesh && _span === span) return;
    remove(game);
    _span = span;
    _size = document.body.classList.contains('is-mobile') ? SIZE_PHONE : SIZE_OK;
    const c = document.createElement('canvas');
    c.width = c.height = _size;
    _ctx = c.getContext('2d');
    _tex = new THREE.CanvasTexture(c);
    _tex.minFilter = THREE.LinearFilter;
    _tex.generateMipmaps = false;
    const geo = new THREE.PlaneGeometry(span, span);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x010204, alphaMap: _tex, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
    _mesh = new THREE.Mesh(geo, mat);
    _mesh.renderOrder = 900;
    _mesh.frustumCulled = false;
    game.scene.add(_mesh);
  }

  function paint(){
    const s = _size / _span, h = _span / 2, g = _ctx;
    g.filter = 'none';
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#fff';
    g.fillRect(0, 0, _size, _size);
    /* Soft edge: blur survives where the canvas supports it and is harmless
       where it does not. */
    g.filter = 'blur(' + Math.max(1, Math.round(_size / 170)) + 'px)';
    g.fillStyle = '#000';
    for(const v of _views){
      g.beginPath();
      for(let i = 0; i < RAYS; i++){
        const a = i / RAYS * Math.PI * 2, r = v.reach[i];
        const px = (v.x + Math.sin(a) * r + h) * s, py = (v.z + Math.cos(a) * r + h) * s;
        if(i) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.closePath();
      g.fill();
    }
    g.filter = 'none';
    _tex.needsUpdate = true;
  }

  function reveal(game){
    for(const t of (game.tanks || [])){
      if(t._fogHidden){ t._fogHidden = false; if(t.root) t.root.visible = true; }
    }
  }

  function remove(game){
    if(_mesh){
      if(_mesh.parent) _mesh.parent.remove(_mesh);
      _mesh.geometry.dispose(); _mesh.material.dispose();
      if(_tex) _tex.dispose();
    }
    _mesh = null; _ctx = null; _tex = null; _span = 0; _views = [];
  }

  function update(game, dt){
    const me = game.localTank;
    const on = !!(CONFIG && CONFIG.FOG_OF_WAR) && me && game.running &&
      (game._tdmState || game.glad) && !game._cinematicPhase && !(game._matchStartDelay > 0);
    if(!on){
      if(_active){ _active = false; remove(game); reveal(game); }
      return;
    }
    const sources = game.tanks.filter(t => t && t.root && t.alive && !t.dying && !t.isDummy && isAlly(me, t));
    /* Nobody left to see with (out of a free-for-all): show everything. */
    if(!sources.length){
      if(_active){ _active = false; remove(game); reveal(game); }
      return;
    }
    _active = true;
    ensureMesh(game);
    _mesh.position.y = me.root.position.y + 1;
    _timer -= dt;
    if(_timer > 0) return;
    _timer = UPDATE_EVERY;
    _views = sources.map(t => castView(game, t));
    paint();
    for(const t of game.tanks){
      if(!t || !t.root || t.isDummy) continue;
      const hide = !isAlly(me, t) && !seen(t.x, t.z, Math.max(t.colHalfW || 3, t.colHalfL || 3));
      if(hide !== !!t._fogHidden){
        t._fogHidden = hide;
        t.root.visible = !hide;
      }
    }
    if(me.viewCircle) me.viewCircle.visible = false;   /* the fog's edge shows it now */
  }

  function clear(game){
    _active = false;
    remove(game);
    reveal(game);
  }

  return { update, clear, seen, isActive: () => _active, views: () => _views };
})();
window.FogOfWar = FogOfWar;
