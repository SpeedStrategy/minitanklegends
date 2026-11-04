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
  const RAYS = 180;
  const BAND = 0.16;              /* half-fog ring, as a share of the view radius */
  const WALL_PEEK = 2.5;          /* a wall's own face stays visible */
  const SIZE_OK = 768, SIZE_PHONE = 512;
  const FOG_RGB = '1,2,4', FOG_ALPHA = 0.72, HALF_ALPHA = 0.38;   /* you can see the map through it */
  const OUTLINE = '#4b4f55', OUTLINE_W = 1.5;   /* world units */

  let _mesh = null, _ctx = null, _tex = null, _span = 0, _size = 0;
  let _timer = 0, _active = false, _dirty = true;
  let _paintX = 0, _paintZ = 0, _paintY = 0;
  let _ray = null;
  const _dir = { x: 0, y: 0, z: 1 };
  let _views = [];                /* [{t, x, z, reach, band}] */
  let _next = 0;                  /* whose rays are refreshed this tick */

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

  /* Fills prev's arrays when it has them, so a moving tank makes no garbage. */
  function castView(game, t, prev, every){
    const stepBy = every || 1;
    const R = rangeOf(t);
    const reach = prev ? prev.reach : new Float32Array(RAYS), band = prev ? prev.band : new Float32Array(RAYS);
    const edge = R * (1 + BAND);
    const pw = game.physicsWorld;
    /* Above the roof: a nearby slope should not blind it, a real wall still blocks. */
    const y = t.root.position.y + (t.colOffY || 1) + (t.colHalfH || 1) + 1;
    let ray = null;
    if(pw && typeof RAPIER !== 'undefined' && RAPIER.Ray){
      if(!_ray) _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, _dir);
      ray = _ray;
      ray.origin = { x: t.x, y, z: t.z };
      ray.dir = _dir;
    }
    for(let i = 0; i < RAYS; i += stepBy){
      let r = R, b = edge;
      if(ray){
        const a = i / RAYS * Math.PI * 2;
        _dir.x = Math.sin(a); _dir.z = Math.cos(a);
        try {
          /* Ground you could drive up is not a wall. A tank in a dip used to cast
             straight into the slope around it and see nothing, which blacked out
             the whole screen. Only steep faces stop sight; a ray that meets a
             slope carries on along it from a little above the contact. */
          let start = 0, ox = t.x, oy = y, oz = t.z;
          for(let k = 0; k < 4; k++){
            ray.origin = { x: ox, y: oy, z: oz };
            const hit = pw.castRayAndGetNormal ? pw.castRayAndGetNormal(ray, R - start, true, undefined, undefined, undefined, undefined, notActor)
                                               : pw.castRay(ray, R - start, true, undefined, undefined, undefined, undefined, notActor);
            if(!hit) break;
            const toi = hit.timeOfImpact != null ? hit.timeOfImpact : hit.toi;
            if(toi == null) break;
            const ny = hit.normal ? Math.abs(hit.normal.y) : 0;
            if(ny > 0.55){
              start += toi + 0.5;
              if(start >= R) break;
              ox += _dir.x * (toi + 0.5); oz += _dir.z * (toi + 0.5); oy += 3;
              continue;
            }
            /* Behind a wall there is no half-fog either: the wall stops it all. */
            r = Math.min(R, start + toi + WALL_PEEK); b = r + 0.5;
            break;
          }
        } catch(e){}
      }
      reach[i] = r; band[i] = b;
    }
    /* Teammates cast every other ray; the gaps take the shorter neighbour, so a wall
       is never seen through. */
    if(stepBy > 1){
      for(let i = 1; i < RAYS; i += stepBy){
        const a = (i + RAYS - 1) % RAYS, c = (i + 1) % RAYS;
        reach[i] = Math.min(reach[a], reach[c]);
        band[i] = Math.min(band[a], band[c]);
      }
    }
    const v = prev || { t, reach, band };
    v.x = t.x; v.z = t.z; v.castX = t.x; v.castZ = t.z; v.castAt = game.time || 0; v.R = R;
    return v;
  }

  /* What is DRAWN is a smoothed copy of the rays; what is SEEN still uses them raw.
     A median over three neighbours removes the single rays that slip past a post or
     a tree for one tick. Small changes then apply at once, so the edge stays tight
     on walls while you drive; a big jump (a gap opening) grows over a few ticks
     instead of popping. Returns true while the drawn shape is still changing. */
  function settle(v){
    const R = v.reach, B = v.band;
    const fresh = !v.shownR;
    if(fresh){ v.shownR = new Float32Array(RAYS); v.shownB = new Float32Array(RAYS); }
    const SR = v.shownR, SB = v.shownB;
    let moving = false, changed = fresh;
    for(let i = 0; i < RAYS; i++){
      const p = i ? i - 1 : RAYS - 1, q = i + 1 < RAYS ? i + 1 : 0;
      let x = R[p], y = R[i], z = R[q];
      let r = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
      x = B[p]; y = B[i]; z = B[q];
      let c = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
      if(!fresh){
        let d = r - SR[i];
        if(d > 1.5 || d < -1.5){ moving = true; r = SR[i] + d * 0.25; }
        d = c - SB[i];
        if(d > 1.5 || d < -1.5){ moving = true; c = SB[i] + d * 0.25; }
        if(c < r + 0.5) c = r + 0.5;
        if(r !== SR[i] || c !== SB[i]) changed = true;
      }
      SR[i] = r; SB[i] = c;
    }
    v.settling = moving;
    return changed;
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
    _tex.minFilter = _tex.magFilter = THREE.LinearFilter;
    _tex.generateMipmaps = false;
    _tex.wrapS = _tex.wrapT = THREE.ClampToEdgeWrapping;
    if(THREE.SRGBColorSpace) _tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(span, span);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ map: _tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
    _mesh = new THREE.Mesh(geo, mat);
    _dirty = true;
    _mesh.renderOrder = 900;
    _mesh.frustumCulled = false;
    game.scene.add(_mesh);
  }

  /* The canvas covers only what the camera can see, not the whole map, so its
     pixels are small enough for a smooth edge. The plane is still map-sized: the
     canvas border is painted solid and stretches over everything outside it. */
  function paint(game){
    const cam = game.camera;
    const y = cam ? Math.max(20, cam.position.y - _mesh.position.y) : 60;
    const tan = Math.tan(((cam && cam.fov) || 55) * Math.PI / 360);
    const seenW = y * tan * 2 * Math.max(1, (cam && cam.aspect) || 1.8);
    /* Canvas size and centre sit on a fixed grid. Sliding the canvas by fractions of
       a pixel with the camera made every edge shimmer. */
    const W = Math.min(_span, Math.ceil(Math.max(180, seenW * 1.35) / 24) * 24);
    const s = _size / W, g = _ctx, texel = W / _size;
    const cx = Math.round((cam ? cam.position.x : game.localTank.x) / texel) * texel;
    const cz = Math.round((cam ? cam.position.z : game.localTank.z) / texel) * texel;
    const toX = x => (x - cx + W / 2) * s, toY = z => (z - cz + W / 2) * s;
    const trace = (key) => {
      g.beginPath();
      for(const v of _views){
        const arr = v[key];
        for(let i = 0; i < RAYS; i++){
          const a = i / RAYS * Math.PI * 2, r = arr[i];
          const px = toX(v.x + Math.sin(a) * r), py = toY(v.z + Math.cos(a) * r);
          if(i) g.lineTo(px, py); else g.moveTo(px, py);
        }
        g.closePath();
      }
    };
    const cut = (key) => {
      trace(key);
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
      g.fill('nonzero');
      g.globalCompositeOperation = 'source-over';
    };
    /* TOON: solid fog, a ring of half fog (still fog: nothing in it is seen), then
       clear, with a dark gray line on both edges. Each outline is stroked and its
       inside then cut away, so only the outer rim of the team's whole view has a
       line and none runs through a teammate's clear area. */
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, _size, _size);
    g.fillStyle = 'rgba(' + FOG_RGB + ',' + FOG_ALPHA + ')';
    g.fillRect(0, 0, _size, _size);
    g.lineJoin = 'round';
    g.lineWidth = OUTLINE_W * 2 * s;
    g.strokeStyle = OUTLINE;
    trace('shownB');
    g.stroke();
    cut('shownB');
    trace('shownB');
    g.fillStyle = 'rgba(' + FOG_RGB + ',' + HALF_ALPHA + ')';
    g.fill('nonzero');
    trace('shownR');
    g.stroke();
    cut('shownR');
    /* The border pixels are what clamp-to-edge stretches across the rest of the map. */
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(' + FOG_RGB + ',' + FOG_ALPHA + ')';
    g.clearRect(0, 0, _size, 2); g.clearRect(0, _size - 2, _size, 2); g.clearRect(0, 0, 2, _size); g.clearRect(_size - 2, 0, 2, _size);
    g.strokeRect(0, 0, _size, _size);
    const rep = _span / W;
    _tex.repeat.set(rep, rep);
    _tex.offset.set((W / 2 - _span / 2 - cx) / W, 1 - (_span / 2 - cz + W / 2) / W);
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
    _mesh = null; _ctx = null; _tex = null; _span = 0; _views = []; _dirty = true; _ray = null;
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
    /* Added, not assigned, so ticks stay evenly spaced whatever the frame times do. */
    _timer = Math.max(-0.05, _timer) + (document.body.classList.contains('is-mobile') ? 0.05 : 0.033);
    const old = _views;
    _next++;
    const others = sources.filter(t => t !== me);
    /* Teammates on screen are refreshed two a tick, so their views do not visibly
       lag and jump; ones off screen only feed the "can we see this enemy" check. */
    const camNow = game.camera;
    const onScreen = others.filter(t => camNow && Math.hypot(t.x - camNow.position.x, t.z - camNow.position.z) < 170);
    const offScreen = others.filter(t => onScreen.indexOf(t) < 0);
    const turns = [];
    if(onScreen.length){ turns.push(onScreen[_next % onScreen.length]); if(onScreen.length > 1) turns.push(onScreen[(_next + 1) % onScreen.length]); }
    if(offScreen.length && _next % 4 === 0) turns.push(offScreen[(_next >> 2) % offScreen.length]);
    _next += turns.length > 1 ? 1 : 0;
    if(old.length !== sources.length) _dirty = true;
    const now = game.time || 0;
    _views = sources.map(t => {
      const prev = old.find(v => v.t === t);
      if(!prev){ _dirty = true; const nv = castView(game, t, null, t === me ? 1 : 2); nv.needSettle = true; return nv; }
      /* A tank that has not moved sees what it saw: no rays, no repaint. Checked
         again now and then in case something moved around it. */
      const movedSinceCast = Math.hypot(t.x - prev.castX, t.z - prev.castZ) > 0.3;
      if((t === me || turns.indexOf(t) >= 0) && (movedSinceCast || now - prev.castAt > 0.5)){
        const before = prev.reach[0] + prev.reach[45] + prev.reach[90] + prev.reach[135];
        castView(game, t, prev, t === me ? 1 : 2);
        prev.needSettle = true;
        if(movedSinceCast || before !== prev.reach[0] + prev.reach[45] + prev.reach[90] + prev.reach[135]) _dirty = true;
      } else if(Math.abs(prev.x - t.x) + Math.abs(prev.z - t.z) > 0.05){
        prev.x = t.x; prev.z = t.z;
        _dirty = true;
      }
      return prev;
    });
    const cam = game.camera;
    if(cam && (Math.abs(cam.position.x - _paintX) > 0.5 || Math.abs(cam.position.z - _paintZ) > 0.5 || Math.abs(cam.position.y - _paintY) > 0.5)) _dirty = true;
    for(const v of _views){
      if(v.needSettle || v.settling){
        v.needSettle = false;
        if(settle(v)) _dirty = true;
      }
    }
    if(_dirty){
      paint(game);
      _dirty = false;
      if(cam){ _paintX = cam.position.x; _paintZ = cam.position.z; _paintY = cam.position.y; }
    }
    for(const t of game.tanks){
      if(!t || !t.root || t.isDummy) continue;
      /* Seen now, or a moment ago: a tank right on the edge of the view must not blink
         on and off with every tick. */
      const inView = isAlly(me, t) || seen(t.x, t.z, Math.max(t.colHalfW || 3, t.colHalfL || 3));
      if(inView) t._fogSeenAt = now;
      const hide = !inView && now - (t._fogSeenAt === undefined ? -9 : t._fogSeenAt) > 0.3;
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
