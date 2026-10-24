/* ============================================================
   tank-sprays.js — spray stamps, shared by the tank menu and the
   battle.

   ONE TANK, ONE FRAME.

   A stamp used to be authored in the tank menu's own preview frame and
   then re-fitted into the battle tank by comparing two bounding boxes and
   guessing a rotation between them. The two frames were never the same
   shape. The menu loaded the GLB itself and put the solved model
   quaternion on the MODEL GROUP; the battle puts it on orientation
   groups nested inside bodyGroup and turretGroup, splits the hull from
   the turret into two different hierarchies, centres the model before it
   rotates it rather than after, and layers the editor's rotation and
   offset on top. Six separate differences, and a box remap cannot undo
   any of them — which is why stamps drifted off the hull, landed on the
   wrong face, or vanished entirely.

   So there is no remap any more. Both places build the tank with
   `new Tank(...)` — the only code that knows how a tank is supposed to
   look — and a stamp is stored in THAT tank's own root space. The menu's
   turntable spins a group ABOVE the tank root, so it cancels out of the
   record on its own.

   The consequence is that project() below is called from both sides with
   the same arguments on a tank built the same way, and the two cannot
   disagree. That shared path is the whole fix; keep it that way.

   Only your own tank is painted — a spray lives in your save file, not on
   the server.
   ============================================================ */

window.TankSprays = (function(){
  'use strict';

  var KEY = 'tankparty_sprays';
  var SPRAY_SIZE = 2.0;
  var SPRAY_DEPTH = 1.6;
  var GUN_NAME = /(gun|barrel|cannon|muzzle|tube)/;

  /* Records written before the shared frame existed were measured against
     the menu's hand-built preview frame, which no longer exists, so they
     cannot be converted — only re-placed. Their frame marker is absent. */
  var PLACEMENT_V = 2;

  var _texCache = {};
  var _matCache = new Map();
  var _tmpBox = new THREE.Box3();
  var _tmpBox2 = new THREE.Box3();
  var _tmpMat = new THREE.Matrix4();

  /* --- save file ------------------------------------------------------ */

  function readData(){
    try{ return JSON.parse(localStorage.getItem(KEY) || '{}'); }catch(e){ return {}; }
  }

  function owns(sprayId, data){
    if(data.owned && data.owned.indexOf(sprayId) !== -1) return true;
    try{
      return !!(window.getOwnedSprays && (getOwnedSprays() || []).indexOf(sprayId) !== -1);
    }catch(e){ return false; }
  }

  /* One texture per spray for the whole page, loaded once. Both the menu
     and the battle ask this cache, so opening the tank menu has already
     paid for the texture by the time a match starts. */
  function texture(path){
    if(!path) return Promise.resolve(null);
    if(!_texCache[path]){
      _texCache[path] = new Promise(function(res){
        new THREE.TextureLoader().load(path, function(tex){
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          /* The stamp is seen at a glancing angle from most angles, which is
             exactly where an unmipmapped texture shimmers. Mip chains plus a
             little anisotropy cost a few KB on a 256px stamp and remove it. */
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.anisotropy = 4;
          res(tex);
        }, undefined, function(){ res(null); });
      });
    }
    return _texCache[path];
  }

  /* ONE material per texture, shared by every stamp that wears it — on
     every tank, in the menu and in a match alike.

     It is flagged sharedWithCache because Tank.dispose() frees the
     materials on a dying tank unless they say otherwise: without the
     flag the first tank to explode would take the paint off every other
     tank in the round. The geometries are NOT shared — those are built
     per stamp and the dying tank is right to free them. */
  function materialFor(tex){
    if(!tex) return null;
    var hit = _matCache.get(tex.uuid);
    if(hit) return hit;
    var mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      side: THREE.DoubleSide
    });
    mat.userData.sharedWithCache = true;
    _matCache.set(tex.uuid, mat);
    return mat;
  }

  /* --- which meshes may carry paint ------------------------------------ */

  /* The tank's own parts — hull and turret. The root also carries overlays
     (nameplate, drown bar) that must never be measured or painted. */
  function parts(tank){
    var g = [];
    if(tank.bodyGroup) g.push(tank.bodyGroup);
    if(tank.turretGroup && tank.turretGroup !== tank.bodyGroup) g.push(tank.turretGroup);
    if(!g.length && tank.root) g.push(tank.root);
    return g;
  }

  /* A gun part, by the name its author gave it. On a real model the barrel
     is usually baked into the turret mesh and has no name of its own, which
     is what the gun ZONE below is for; this catches the models that do ship
     a separate one. */
  function isGunMesh(o){
    if(!o) return false;
    return GUN_NAME.test(String(o.name || '').toLowerCase());
  }

  function isPaintable(o){
    if(!o || !o.isMesh || o.visible === false) return false;
    var u = o.userData || {};
    if(u.isSpray || u.isOutline || u.noSpray || u.noStyle) return false;
    if(!o.geometry || !o.geometry.getAttribute('position')) return false;
    if(isGunMesh(o)) return false;
    return true;
  }

  /* The box a mesh's geometry occupies. Computed on demand rather than assumed
     from the mesh list: a tank STYLE swaps in a cloned geometry once the model
     is on (TankStyles box-projects UVs onto it), and a fresh clone carries no
     bounding box until something asks for one. */
  function geometryBox(mesh){
    var g = mesh.geometry;
    if(!g) return null;
    if(!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox || null;
  }

  /* Cached on the tank: the mesh list cannot change after the model has
     finished building, and re-walking it per stamp is what made placing
     three stamps cost three full traversals. */
  function paintableMeshes(tank){
    var root = tank.root;
    var hit = root.userData._sprayMeshes;
    if(hit) return hit;
    var out = [];
    parts(tank).forEach(function(gr){
      gr.traverse(function(o){
        if(!isPaintable(o)) return;
        if(!geometryBox(o)) return;
        out.push(o);
      });
    });
    root.userData._sprayMeshes = out;
    return out;
  }

  /* Bounds of those parts in the tank's OWN root space — the frame a stamp
     is written in.

     Stable for the life of the tank, because in the battle the root only
     ever translates and in the menu the turntable sits above it, so this is
     measured once. */
  function localBox(tank){
    var root = tank.root;
    var hit = root.userData._sprayBox;
    if(hit) return hit;
    root.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    var box = new THREE.Box3().makeEmpty();
    var meshes = paintableMeshes(tank);
    for(var i = 0; i < meshes.length; i++){
      var m = meshes[i];
      var gb = geometryBox(m);
      if(!gb) continue;
      m.updateWorldMatrix(true, false);
      box.union(gb.clone().applyMatrix4(m.matrixWorld).applyMatrix4(inv));
    }
    root.userData._sprayBox = box;
    return box;
  }

  /* THE GUN ZONE — the front third of the tank, the central strip, above the
     hull. On a real model the barrel is baked into the turret mesh, so there
     is no part to flag and no node to ask; this box is where every barrel
     sits. It is computed from the same bounds on both sides, so a spot the
     menu refuses is exactly a spot the battle refuses. */
  function gunBox(box){
    var s = box.getSize(new THREE.Vector3());
    if(s.x <= 0 || s.y <= 0 || s.z <= 0) return null;
    return new THREE.Box3(
      new THREE.Vector3(box.min.x + s.x * 0.35, box.min.y + s.y * 0.45, box.max.z - s.z * 0.35),
      new THREE.Vector3(box.max.x - s.x * 0.35, box.max.y, box.max.z)
    );
  }

  function boxVolume(b){
    var s = b.getSize(new THREE.Vector3());
    return (s.x > 0 && s.y > 0 && s.z > 0) ? s.x * s.y * s.z : 0;
  }
  function overlapFraction(meshBox, gun){
    if(!gun) return 0;
    var v = boxVolume(meshBox);
    if(v <= 0) return 0;
    var iv = boxVolume(_tmpBox2.copy(meshBox).intersect(gun));
    return iv > 0 ? iv / v : 0;
  }

  /* World-space box the projector occupies. DecalGeometry clips ±size/2 on
     every axis, so parts nowhere near the stamp cost nothing. */
  function projectorBox(pos, quat, size){
    var m = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
    return new THREE.Box3(
      new THREE.Vector3(-size.x/2, -size.y/2, -size.z/2),
      new THREE.Vector3( size.x/2,  size.y/2,  size.z/2)
    ).applyMatrix4(m);
  }

  /* r185's DecalGeometry feeds the orientation to
     Matrix4.makeRotationFromEuler(), so it must be an Euler — a Quaternion
     would silently keep the identity rotation and the stamp would always
     project straight down. */
  function quatToEuler(q){
    return new THREE.Euler().setFromQuaternion(q, 'XYZ');
  }

  /* --- frames ---------------------------------------------------------- */

  /* Root space <-> world. The menu raycasts in world space and saves in root
     space; battle goes the other way. Both go through here so the two
     directions cannot drift apart. */
  function toRootFrame(tank, posW, quatW){
    var root = tank.root;
    var q = new THREE.Quaternion();
    root.getWorldQuaternion(q).invert();
    return {
      pos:  root.worldToLocal(posW.clone()),
      quat: q.multiply(quatW)
    };
  }
  function toWorldFrame(tank, pos, quat){
    var root = tank.root;
    var q = new THREE.Quaternion();
    root.getWorldQuaternion(q);
    return {
      pos:  root.localToWorld(pos.clone()),
      quat: q.multiply(quat)
    };
  }

  /* --- the projection -------------------------------------------------- */

  /* Turn one saved record into decal geometry, parented to the part that
     owns the surface it landed on: a hull stamp rides the hull as it
     pitches, a turret stamp rides the turret as it aims.

     The bounding-box tests all run in ROOT space, where the record and the
     gun zone both live and neither depends on where the tank currently is.
     Only the DecalGeometry call itself needs world coordinates.

     Returns [{parent, geometry}]. An empty array means the stamp lands on
     nothing — which the caller must treat as "do not record it", or a
     stamp that cannot be seen would still take one of the three slots. */
  function project(tank, rec){
    var out = [];
    if(!tank || !tank.root || !rec || !rec.pos) return out;

    /* Refresh the whole ancestor chain, not just the tank: the menu's
       turntable rotation lives above the root and DecalGeometry projects
       against real world-space geometry, so a stale parent matrix puts the
       stamp on the tank's other side. */
    /* Refresh the tank's own subtree.

       Deliberately NOT a walk up to the scene root: three's updateMatrixWorld
       recurses into every child when it is forced, so starting at the scene
       would re-compose the entire battle graph once per stamp. Starting at the
       tank touches only the tank and composes against its ancestors'
       already-current matrixWorld, which the render loop keeps current and
       which the menu's own click handler refreshes before it raycasts. */
    tank.root.updateMatrixWorld(true);

    var meshes = paintableMeshes(tank);
    if(!meshes.length) return out;

    var root = tank.root;
    var invRoot = _tmpMat.copy(root.matrixWorld).invert().clone();

    var pos  = new THREE.Vector3().fromArray(rec.pos);
    var quat = new THREE.Quaternion().fromArray(rec.quat || [0, 0, 0, 1]);
    var w = (rec.size && rec.size[0]) || SPRAY_SIZE;
    var h = (rec.size && rec.size[1]) || w;
    var size = new THREE.Vector3(w, h, SPRAY_DEPTH);

    var lb = localBox(tank);
    if(lb.isEmpty()) return out;
    var gun = gunBox(lb);
    if(gun && gun.containsPoint(pos)) return [];    /* never paint the gun */

    var pbox = projectorBox(pos, quat, size);
    var posW = pos.clone().applyMatrix4(root.matrixWorld);
    var quatW = new THREE.Quaternion();
    root.getWorldQuaternion(quatW).multiply(quat);
    var eul = quatToEuler(quatW);

    for(var i = 0; i < meshes.length; i++){
      var mesh = meshes[i];
      var gb = geometryBox(mesh);
      if(!gb) continue;
      /* One matrix multiply per mesh. The old code called
         Box3.setFromObject(mesh) here, which re-walks the subtree and
         recomputes bounds — for every mesh, for every stamp. */
      _tmpBox.copy(gb)
        .applyMatrix4(_tmpMat.multiplyMatrices(invRoot, mesh.matrixWorld));
      if(!pbox.intersectsBox(_tmpBox)) continue;
      if(overlapFraction(_tmpBox, gun) >= 0.5) continue;   /* the barrel itself */

      var geo;
      try{ geo = new THREE.DecalGeometry(mesh, posW, eul, size); }
      catch(e){ continue; }
      if(!geo.attributes.position || geo.attributes.position.count === 0){
        geo.dispose();
        continue;
      }

      /* DecalGeometry bakes its vertices in WORLD space, but the mesh lives
         in the part's own frame. Convert, and the stamp then follows that
         part for free. */
      var parent = mesh.parent || root;
      parent.updateWorldMatrix(true, false);
      geo.applyMatrix4(_tmpMat.copy(parent.matrixWorld).invert());
      out.push({ parent: parent, geometry: geo });
    }
    return out;
  }

  /* DecalGeometry output is position/normal/uv with no index, so the pieces
     of one stamp that crossed a seam concatenate directly. */
  function mergeGeometries(geos){
    if(geos.length === 1) return geos[0];
    var count = 0, i;
    for(i = 0; i < geos.length; i++) count += geos[i].attributes.position.count;
    var pos = new Float32Array(count * 3);
    var nrm = new Float32Array(count * 3);
    var uv  = new Float32Array(count * 2);
    var at = 0;
    for(i = 0; i < geos.length; i++){
      var g = geos[i], a = g.attributes, n = a.position.count;
      pos.set(a.position.array, at * 3);
      if(a.normal) nrm.set(a.normal.array, at * 3);
      if(a.uv) uv.set(a.uv.array, at * 2);
      at += n;
      g.dispose();
    }
    var merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merged.setAttribute('normal',   new THREE.BufferAttribute(nrm, 3));
    merged.setAttribute('uv',       new THREE.BufferAttribute(uv, 2));
    merged.computeBoundingSphere();
    return merged;
  }

  /* Turn projected geometry into meshes — ONE per parent part, however many
     of the stamp's meshes it crossed.

     A stamp that runs over an edge used to become a separate draw call for
     every panel it touched, and every one of them carried its own material.
     Running over an edge is the whole point of the depth, so the pieces are
     merged: same pixels, one call, one shared material. */
  function addDecals(tank, pieces, tex){
    if(!tank || !pieces || !pieces.length) return 0;
    var mat = materialFor(tex);
    if(!mat) return 0;

    var byParent = new Map();
    for(var i = 0; i < pieces.length; i++){
      var p = pieces[i].parent;
      var list = byParent.get(p);
      if(!list){ list = []; byParent.set(p, list); }
      list.push(pieces[i].geometry);
    }

    var made = 0;
    byParent.forEach(function(geos, parent){
      var mesh = new THREE.Mesh(mergeGeometries(geos), mat);
      mesh.renderOrder = 998;
      mesh.userData.isSpray = true;
      mesh.frustumCulled = true;
      parent.add(mesh);
      made++;
    });
    return made;
  }

  /* --- battle ---------------------------------------------------------- */

  function apply(tank){
    try{
      if(!tank || !tank.root || !tank.isLocal) return;
      if(tank.root.userData.spraysApplied) return;
      if(!tank.def || !tank.def.id) return;

      var data = readData();
      var sprayId = (data.equipped && data.equipped[tank.def.id]) || null;
      if(!sprayId || !owns(sprayId, data)) return;
      var placement = data.placements && data.placements[tank.def.id];
      if(!placement || !placement.stamps || !placement.stamps.length) return;
      /* Authored against a frame that no longer exists. The menu drops these
         (with a backup) the first time the tank is opened; anything that
         reaches a match without that never drew correctly anyway. */
      if(placement.v !== PLACEMENT_V) return;

      tank.root.userData.spraysApplied = true;

      Promise.all(placement.stamps.map(function(st){ return texture(st.texture); }))
        .then(function(textures){
          if(!tank.root) return;
          placement.stamps.forEach(function(rec, i){
            if(!textures[i]) return;
            addDecals(tank, project(tank, rec), textures[i]);
          });
        });
    }catch(e){
      console.warn('TankSprays failed:', e);
    }
  }

  return {
    SPRAY_SIZE: SPRAY_SIZE,
    SPRAY_DEPTH: SPRAY_DEPTH,
    PLACEMENT_V: PLACEMENT_V,
    KEY: KEY,
    texture: texture,
    materialFor: materialFor,
    isPaintable: isPaintable,
    isGunMesh: isGunMesh,
    localBox: localBox,
    gunBox: gunBox,
    projectorBox: projectorBox,
    toRootFrame: toRootFrame,
    toWorldFrame: toWorldFrame,
    project: project,
    addDecals: addDecals,
    apply: apply
  };
})();