/* ============================================================
   tank-styles.js — tank STYLE skins (cosmetics tab → Style).

   A style is ONE seamless texture mapped over the tank's whole
   model (exactly what a "style" is in this game: one texture
   applied on the tank model): a camo, a desert pattern, stripes.

   Owns its own save key `tankparty_styles`:
     { owned: [styleId], equipped: { tankId: styleId } }

   A style can be worn on only one tank at a time (same rule the
   sprays use). Ownership is ALSO mirrored into the settings
   save (`ownedStyles`) the same way the sprays mirror theirs, so
   a settings round-trip never silently drops it.

   Battle: TankStyles.apply(tank) — called from tank.js once the
   model finished building.
   Preview: TankStyles.applyToModel(grp, styleId) — called from
   tank-menu.js after the preview tank is built.
   ============================================================ */

window.TankStyles = (function(){
'use strict';

var KEY = 'tankparty_styles';

/* ---- the catalog ------------------------------------------------------ */

var STYLE_DEFS = {
  woodland_camo: {
    id: 'woodland_camo',
    name: 'Woodland Camo',
    texture: 'assets/styles/woodland_camo.webp?v=2',
    price: 1200,
    currency: 'gold',
    desc: 'Olive-drab military woodland pattern.',
    repeat: 2.0,          /* texture tiles across the model's longest side */
  },
  desert_camo: {
    id: 'desert_camo',
    name: 'Desert Storm',
    texture: 'assets/styles/desert_camo.webp?v=2',
    price: 1200,
    currency: 'gold',
    desc: 'Sandy desert pattern with brown blotches.',
    repeat: 2.0,
  },
  tiger_stripes: {
    id: 'tiger_stripes',
    name: 'Tiger Stripes',
    texture: 'assets/styles/tiger_stripes.webp?v=2',
    price: 1800,
    currency: 'gold',
    desc: 'Loud orange paint job with black stripes.',
    repeat: 2.2,
  },
};

var STYLE_LIST = ['woodland_camo', 'desert_camo', 'tiger_stripes'];

/* ---- save / load ------------------------------------------------------ */

function readData(){
  try{ return JSON.parse(localStorage.getItem(KEY) || '{}'); }
  catch(e){ return {}; }
}
function writeData(d){
  localStorage.setItem(KEY, JSON.stringify(d));
}

function ownsStyle(id){
  var d = readData();
  if(Array.isArray(d.owned) && d.owned.indexOf(id) !== -1) return true;
  /* The settings mirror counts too — same as the sprays, where a purchase
     files ownership in both places and either copy is enough. */
  try{
    var s = typeof loadSettings === 'function' ? loadSettings() : null;
    if(s && Array.isArray(s.ownedStyles) && s.ownedStyles.indexOf(id) !== -1) return true;
  }catch(e){}
  return false;
}

function addOwnedStyle(id){
  if(!STYLE_DEFS[id]) return false;
  var d = readData();
  if(!Array.isArray(d.owned)) d.owned = [];
  if(d.owned.indexOf(id) === -1){
    d.owned.push(id);
    writeData(d);
  }
  /* Mirror into the settings file, exactly the way the sprays do. */
  try{
    var s = typeof loadSettings === 'function' ? loadSettings() : null;
    if(s){
      if(!Array.isArray(s.ownedStyles)) s.ownedStyles = [];
      if(s.ownedStyles.indexOf(id) === -1) s.ownedStyles.push(id);
      if(typeof saveSettings === 'function') saveSettings(s);
    }
  }catch(e){}
  return true;
}

function equippedForTank(tankId){
  var d = readData();
  var eq = d.equipped || {};
  var id = eq[tankId];
  /* Equipped only counts while you still own it — mirrors the spray rule. */
  if(!id || !STYLE_DEFS[id] || !ownsStyle(id)) return null;
  return id;
}

function ownerOfStyle(styleId){
  var d = readData();
  var eq = d.equipped || {};
  for(var k in eq){ if(eq[k] === styleId) return k; }
  return null;
}

function equipStyle(tankId, styleId){
  if(styleId !== null && (!STYLE_DEFS[styleId] || !ownsStyle(styleId))) return false;
  var d = readData();
  if(!d.equipped) d.equipped = {};
  if(styleId === null){
    delete d.equipped[tankId];
  }else{
    /* One style lives on exactly one tank: refuse rather than silently steal
       it off the tank that is wearing it (same rule as the sprays). */
    var owner = ownerOfStyle(styleId);
    if(owner && owner !== tankId) return false;
    d.equipped[tankId] = styleId;
  }
  writeData(d);
  return true;
}

/* ---- the texture ------------------------------------------------------ */

var _texCache = {};
var _debug = { lastPainted: 0, lastStyle: null };

function getTexture(styleId){
  var def = STYLE_DEFS[styleId];
  if(!def) return Promise.resolve(null);
  if(!_texCache[styleId]){
    _texCache[styleId] = new Promise(function(res){
      new THREE.TextureLoader().load(
        def.texture,
        function(tex){
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          /* Procedurally-baked PNGs carry no colour-space tag, and an sRGB
             image read as linear comes out washed and cold — the same bug
             the WebP maps hit. Tag it here. */
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          res(tex);
        },
        undefined,
        function(){ res(null); }
      );
    });
  }
  return Promise.resolve(_texCache[styleId]);
}

/* ---- the painter ------------------------------------------------------ */

function hasUv(mesh){
  return !!(mesh.geometry && mesh.geometry.getAttribute('uv'));
}

/* Box-project UVs from geometry-local bounding box: every vertex gets a UV
   from its dominant normal axis, scaled so the texture tiles `rep` times
   across the part. Not seam-perfect across every authored model, but it puts
   a pattern over the whole surface even when the export shipped no UV map. */
function boxProjectUv(geo, rep){
  var pos = geo.getAttribute('position');
  if(!pos) return false;
  if(!geo.boundingBox) geo.computeBoundingBox();
  var bb = geo.boundingBox;
  var size = new THREE.Vector3();
  bb.getSize(size);
  var nx = Math.max(size.x, 1e-6), ny = Math.max(size.y, 1e-6), nz = Math.max(size.z, 1e-6);
  var uvs = new Float32Array(pos.count * 2);
  var v = new THREE.Vector3();
  var nor = geo.getAttribute('normal');
  for(var i = 0; i < pos.count; i++){
    v.fromBufferAttribute(pos, i);
    var u, w;
    if(nor){
      var ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
      if(ay >= ax && ay >= az){        u = (v.x - bb.min.x) / nx; w = (v.z - bb.min.z) / nz; }
      else if(ax >= az){               u = (v.z - bb.min.z) / nz; w = (v.y - bb.min.y) / ny; }
      else{                            u = (v.x - bb.min.x) / nx; w = (v.y - bb.min.y) / ny; }
    }else{
      u = (v.x - bb.min.x) / nx; w = (v.y - bb.min.y) / ny;
    }
    uvs[i * 2]     = u * rep;
    uvs[i * 2 + 1] = w * rep;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return true;
}

/* Which meshes of a group get painted — never the outline shells, never the
   spray stamps, never hidden helpers (hitbox) and never anything flagged
   noStyle by another system. */
function styleableMeshes(grp){
  var out = [];
  grp.updateMatrixWorld(true);
  grp.traverse(function(o){
    if(!o.isMesh || o.visible === false) return;
    var u = o.userData || {};
    if(u.isSpray || u.isOutline || u.noSpray || u.noStyle) return;
    var n = String(o.name || '').toLowerCase().replace(/[\s_\-]/g, '');
    if(n === 'hitbox') return;
    out.push(o);
  });
  return out;
}

/* Apply a style to a model group. Returns a promise resolving true when at
   least one mesh was painted. */
function applyToModel(grp, styleId){
  if(!grp || !styleId || !STYLE_DEFS[styleId]) return Promise.resolve(false);
  return getTexture(styleId).then(function(tex){
    if(!tex || !grp.parent && !grp.isObject3D) return false;
    var def = STYLE_DEFS[styleId];
    var meshes = styleableMeshes(grp);
    var painted = 0;
    meshes.forEach(function(m){
      try{
        if(!m.geometry) return;
        /* The style texture needs UVs. Whatever the model shipped, a clone
           keeps the master untouched for the next clone (geometries are
           shared across clones — see Models._clone). */
        if(!hasUv(m)){
          m.geometry = m.geometry.clone();
          boxProjectUv(m.geometry, def.repeat || 2);
        }
        var mats = Array.isArray(m.material) ? m.material : [m.material];
        /* Already wearing THIS style from an earlier apply? Leave it —
           re-painting would stack another material clone every call. */
        if(m.userData._styleApplied === styleId){ painted++; return; }
        m.userData._styleBackup = {
          mats: mats,
          wasArray: Array.isArray(m.material),
          geoWasCloned: !hasUv(m),
        };
        var src = mats[0] || {};
        var mat = Toon.mat({
          map: tex,
          color: new THREE.Color(0xffffff),
          transparent: !!src.transparent,
          opacity: (src.opacity !== undefined) ? src.opacity : 1,
          side: THREE.DoubleSide,
          alphaTest: src.alphaTest || 0,
        });
        mat.userData = { isStyle: true, styleId: styleId };
        m.material = mat;
        m.userData._styleApplied = styleId;
        painted++;
      }catch(e){
        console.warn('TankStyles paint mesh failed:', e);
      }
    });
    if(painted > 0){
      _debug.lastPainted = painted;
      _debug.lastStyle = styleId;
      _debug.lastTime = Date.now();
    }
    return painted > 0;
  });
}

/* Strip the style and put the original materials/geometries back. */
function removeFromModel(grp){
  if(!grp) return;
  grp.traverse(function(o){
    if(!o || !o.userData || typeof o.userData._styleApplied !== 'string') return;
    var bak = o.userData._styleBackup;
    if(bak && Array.isArray(bak.mats) && bak.mats.every(Boolean)){
      o.material = bak.wasArray ? bak.mats : bak.mats[0];
    }
    if(bak && bak.geoWasCloned && bak.mats && bak.mats[0]){
      /* The material carries the old geometry's map; give the original mesh
         its original geometry back by re-deriving it from the backup. */
      /* Not tracked — geometry was cloned in place, so leaving the cloned
         geometry is harmless: it is the same vertex data plus UVs. Skip. */
    }
    delete o.userData._styleApplied;
    delete o.userData._styleBackup;
  });
}

/* Style → ONE colour, for the tank-menu swatch that shows what the style
   reads as at a glance. */
var SWATCH = {
  woodland_camo: '#4a5334',
  desert_camo:   '#bc9e6a',
  tiger_stripes: '#ce6c18',
};
function swatchOf(styleId){ return SWATCH[styleId] || '#888888'; }

/* ---- battle ------------------------------------------------------------ */

/* Called from tank.js once the tank's model (or the box fallback) is built.
   Safe to call on every tank — it reads the save and bails for tanks with
   no style equipped. */
function apply(tank){
  try{
    if(!tank || !tank.root || !tank.def || !tank.def.id) return;
    var styleId = equippedForTank(tank.def.id);
    if(!styleId) return;
    applyToModel(tank.root, styleId);
  }catch(e){
    console.warn('TankStyles.apply failed:', e);
  }
}

/* ---- tank-menu preview ------------------------------------------------- */

/* tank-menu.js sets the id it is showing, then asks for the preview to be
   painted after installModel/buildBoxTank finish. */
var _previewTankId = null;
function setPreviewTank(tankId){
  _previewTankId = tankId;
}
function applyToPreview(grp, tankId){
  var id = tankId || _previewTankId;
  if(!grp || !id) return Promise.resolve(false);
  var styleId = equippedForTank(id);
  if(!styleId) return Promise.resolve(false);
  return applyToModel(grp, styleId);
}

/* ---- public interface -------------------------------------------------- */

return {
  DEFS: STYLE_DEFS,
  LIST: STYLE_LIST,
  ownsStyle: ownsStyle,
  addOwnedStyle: addOwnedStyle,
  equippedForTank: equippedForTank,
  equipStyle: equipStyle,
  ownerOfStyle: ownerOfStyle,
  swatchOf: swatchOf,
  apply: apply,
  applyToModel: applyToModel,
  removeFromModel: removeFromModel,
  applyToPreview: applyToPreview,
  setPreviewTank: setPreviewTank,
  /* Debug/diagnose: shows how many meshes the LAST apply painted and when. */
  debug: function(){ return Object.assign({}, _debug, { previewTank: _previewTankId }); },
};

})();
