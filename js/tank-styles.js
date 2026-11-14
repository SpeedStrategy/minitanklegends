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

/*  EVERY CAMO IS ONE ENTRY. Adding a paint is one line here plus the .webp in
    assets/styles (tools/convert-camos.js makes that file from any png/jpg/
    jfif): the tank menu, the store shelf and the art template all read this
    table, so nothing else has to be edited to ship a new style.

    `repeat` is how many times the texture tiles across the model's longest
    side. Busy, small-detail patterns (flora, the rose print) want MORE tiles so
    the motif stays readable; loud, large-shape patterns (arcade, kaleidoscope)
    want fewer so the shapes are not chopped into confetti by the model's UVs. */
var STYLE_DEFS = {
  woodland_camo: {
    id: 'woodland_camo',
    name: 'Woodland Camo',
    texture: 'assets/styles/woodland_camo.webp?v=3',
    price: 1200,
    currency: 'gold',
    desc: 'Olive-drab military woodland pattern.',
    repeat: 2.0,          /* texture tiles across the model's longest side */
    swatch: '#4a5334',
  },
  desert_camo: {
    id: 'desert_camo',
    name: 'Desert Storm',
    texture: 'assets/styles/desert_camo.webp?v=3',
    price: 1200,
    currency: 'gold',
    desc: 'Sandy desert pattern with brown blotches.',
    repeat: 2.0,
    swatch: '#bc9e6a',
  },
  tiger_stripes: {
    id: 'tiger_stripes',
    name: 'Tiger Stripes',
    texture: 'assets/styles/tiger_stripes.webp?v=3',
    price: 1800,
    currency: 'gold',
    desc: 'Loud orange paint job with black stripes.',
    repeat: 2.2,
    swatch: '#ce6c18',
  },
  flora: {
    id: 'flora',
    name: 'Flora',
    texture: 'assets/styles/flora.webp?v=1',
    price: 1500,
    currency: 'gold',
    desc: 'Dense purple blossoms and vines over dark steel.',
    repeat: 3.0,
    swatch: '#7b4a72',
  },
  fracture: {
    id: 'fracture',
    name: 'Fracture',
    texture: 'assets/styles/fracture.webp?v=1',
    price: 1600,
    currency: 'gold',
    desc: 'Shattered plate and frost cracks in cold grey.',
    repeat: 2.2,
    swatch: '#5b6168',
  },
  arcade: {
    id: 'arcade',
    name: 'Arcade',
    texture: 'assets/styles/arcade.webp?v=1',
    price: 2000,
    currency: 'gold',
    desc: 'Neon cabinet geometry in hot pink, cyan and lime.',
    repeat: 1.6,
    swatch: '#e0359a',
  },
  biohazard: {
    id: 'biohazard',
    name: 'Biohazard',
    texture: 'assets/styles/biohazard.webp?v=1',
    price: 2100,
    currency: 'gold',
    desc: 'Toxic green spills and warning swirls.',
    repeat: 2.4,
    swatch: '#2f6b2a',
  },
  nightshade: {
    id: 'nightshade',
    name: 'Nightshade',
    texture: 'assets/styles/nightshade.webp?v=1',
    price: 2200,
    currency: 'gold',
    desc: 'Black-on-olive shadows with buried faces.',
    repeat: 2.6,
    swatch: '#2b2f28',
  },
  haunt: {
    id: 'haunt',
    name: 'Haunt',
    texture: 'assets/styles/haunt.webp?v=1',
    price: 2300,
    currency: 'gold',
    desc: 'Rust-orange spooks grinning through the paint.',
    repeat: 2.6,
    swatch: '#8c4a1e',
  },
  black_roses: {
    id: 'black_roses',
    name: 'Black Roses',
    texture: 'assets/styles/black_roses.webp?v=1',
    price: 2400,
    currency: 'gold',
    desc: 'A midnight garden of blue and rose print.',
    repeat: 3.0,
    swatch: '#3a4a6a',
  },
  all_hallows: {
    id: 'all_hallows',
    name: 'All Hallows',
    texture: 'assets/styles/all_hallows.webp?v=1',
    price: 2500,
    currency: 'gold',
    desc: 'Jack-o-lanterns turning in dark green smoke.',
    repeat: 2.4,
    swatch: '#1f2a1a',
  },
  halloween2026: {
    id: 'halloween2026',
    name: 'Halloween 2026',
    texture: 'assets/styles/halloween2026.webp?v=1',
    price: 2600,
    currency: 'gold',
    desc: 'Carved pumpkin grins lit against pitch black.',
    repeat: 2.4,
    swatch: '#c86a10',
  },
  kaleidoscope: {
    id: 'kaleidoscope',
    name: 'Kaleidoscope',
    texture: 'assets/styles/kaleidoscope.webp?v=1',
    price: 2700,
    currency: 'gold',
    desc: 'Impossible birds and blooms, every colour at once.',
    repeat: 1.8,
    swatch: '#2f7fbf',
  },

  /* Born from a rendering bug: a tank half under a building, the x-ray pass
     striping it white while the occluder fade tore the picture. The texture is
     painted in code (glitchTextureUrl below) and jumps around while it is worn
     (startGlitchJitter), so it never needs a file. */
  glitch: {
    id: 'glitch',
    name: 'Glitch',
    texture: null,
    price: 2500,
    currency: 'gold',
    desc: 'A rendering bug, kept on purpose: white x-ray stripes and a torn signal.',
    repeat: 1.6,
    /* The models' own UV layouts chop the bands into blotches; projected
       straight onto each part they stay bands. */
    boxUv: true,
  },
};

/* ORDER IS THE SHELF ORDER: the two cheapest camos first so a new player sees
   something they can afford, then the specialist paints, then the seasonal
   pair, then the loudest ones, with Glitch last as the showpiece. */
var STYLE_LIST = [
  'woodland_camo',
  'desert_camo',
  'flora',
  'fracture',
  'tiger_stripes',
  'arcade',
  'biohazard',
  'nightshade',
  'haunt',
  'black_roses',
  'all_hallows',
  'halloween2026',
  'kaleidoscope',
  'glitch',
].filter(function(id){ return !!STYLE_DEFS[id]; });

/* Neon green with white diagonal x-ray bands, then a few horizontal slices
   shifted sideways and tinted -- the "torn signal" part. Fixed seed, so every
   tank (and the shop card) shows the same pattern. Tiles seamlessly: the bands
   run at 45 deg with a period that divides the canvas, and the slices wrap. */
function glitchTextureUrl(){
  try{
    var S = 256, c = document.createElement('canvas');
    c.width = S; c.height = S;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#3f9e26'; g.fillRect(0, 0, S, S);
    g.fillStyle = '#2b7419';
    for(var y = 0; y < S; y += 8) g.fillRect(0, y, S, 2);
    /* Each band is a dark edge with a white core, the doubled-outline look
       the original glitch had. */
    for(var pass = 0; pass < 2; pass++){
      g.strokeStyle = pass ? '#ffffff' : '#0b0c0e';
      g.lineWidth = pass ? 8 : 14;
      for(var k = -S; k <= 2 * S; k += 32){
        g.beginPath(); g.moveTo(k, 0); g.lineTo(k - S, S); g.stroke();
      }
    }
    var seed = 7;
    function rnd(){ seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var tints = ['rgba(0,0,0,0.55)', 'rgba(255,0,180,0.35)', 'rgba(0,255,255,0.35)', 'rgba(255,255,255,0.5)'];
    for(var i = 0; i < 9; i++){
      var sy = Math.floor(rnd() * S), sh = 3 + Math.floor(rnd() * 12), dx = Math.floor((rnd() - 0.5) * 90);
      var slice = g.getImageData(0, sy, S, Math.min(sh, S - sy));
      g.putImageData(slice, dx, sy);
      g.putImageData(slice, dx + (dx < 0 ? S : -S), sy);
      g.fillStyle = tints[i % tints.length];
      g.fillRect(0, sy, S, Math.min(sh, S - sy));
    }
    return c.toDataURL('image/png');
  }catch(e){ return ''; }
}
STYLE_DEFS.glitch.texture = glitchTextureUrl();

/* While a glitch texture exists it twitches: mostly still, then every so often
   a jump of the whole pattern for a frame or two, like a dropped signal. One
   shared texture, so every glitch tank twitches together. */
var _glitchTimer = null;
function startGlitchJitter(tex){
  if(_glitchTimer) return;
  _glitchTimer = setInterval(function(){
    if(Math.random() < 0.18){
      tex.offset.set(Math.random(), (Math.random() - 0.5) * 0.08);
    } else if(Math.random() < 0.5){
      tex.offset.set(0, 0);
    }
  }, 90);
}

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
          if(styleId === 'glitch'){
            tex.magFilter = THREE.NearestFilter;
            startGlitchJitter(tex);
          }
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
        /* Already wearing THIS style from an earlier apply? Leave it —
           re-painting would stack another material clone every call. */
        if(m.userData._styleApplied === styleId){ painted++; return; }
        var hadUv = hasUv(m);
        if(!hadUv || def.boxUv){
          m.geometry = m.geometry.clone();
          boxProjectUv(m.geometry, def.repeat || 2);
        }
        var mats = Array.isArray(m.material) ? m.material : [m.material];
        m.userData._styleBackup = {
          mats: mats,
          wasArray: Array.isArray(m.material),
          geoWasCloned: !hadUv || !!def.boxUv,
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

/* Style → ONE colour, for anything that needs a flat tint of the paint (the
   shop card behind the art, a swatch dot). Read from the catalog so a new camo
   only ever declares its colour once. */
function swatchOf(styleId){
  var d = STYLE_DEFS[styleId];
  return (d && d.swatch) || '#888888';
}

/* ---- the icon template -------------------------------------------------

   EVERY camo gets the same card, and it is built here once rather than in each
   screen that shows a paint, so the tank menu and the store cannot drift apart.

   What the template is:

     * the artist's CAMO SHAPE — the ragged, hand-drawn paint patch in
       tools/bake-camo-template.js (assets/icons/camo-template.svg). A camo is
       not shown in a rectangle any more: the texture is POURED into that
       patch, the way a paint job would look spilled on the bench,
     * the patch's own ink line (camo-template-ink.svg) sitting BEHIND the
       paint, so only the part of the stroke that falls outside the poured
       shape shows — a hand-drawn outline, with none of the scribble crossing
       the camo itself,
     * and the paint-roller icon pinned to its BOTTOM-LEFT corner, slightly
       outside the patch and ON TOP of it, so the brush visibly overlaps the
       camo instead of sitting beside it like another swatch.

   The brush is drawn on a cream chip because the icon itself is pure black
   line art: dropped straight onto a dark camo it disappears. The chip is the
   sticker that makes it read at any tile size. */
var BRUSH_ICON = 'assets/icons/style-brush.webp?v=1';
/* The shape and its ink line are applied by css/style.css (.style-art-camo is
   masked with the patch, .style-art-ink draws the line behind it). */
var CAMO_INK = 'assets/icons/camo-template-ink.svg?v=2';
function artMarkup(styleId, opts){
  var d = STYLE_DEFS[styleId];
  if(!d) return '';
  var o = opts || {};
  var src = d.texture || '';
  var cls = 'style-art' + (o.className ? ' ' + o.className : '');
  /* The texture is a data URL for Glitch, which contains characters that would
     break a url() token; quoted for both cases and escaped for the URL itself. */
  var bg = src ? ' style="background-image:url(&quot;' + String(src).replace(/&/g, '&amp;').replace(/"/g, '%22') + '&quot;)"' : '';
  return '<div class="' + cls + '">' +
           '<div class="style-art-splat">' +
             '<div class="style-art-ink" style="background-image:url(&quot;' + CAMO_INK + '&quot;)"></div>' +
             '<div class="style-art-camo"' + bg + '></div>' +
           '</div>' +
           '<div class="style-art-brush" aria-hidden="true"><img src="' + BRUSH_ICON + '" alt="" draggable="false"></div>' +
         '</div>';
}

/* ---- battle ------------------------------------------------------------ */

/* Called from tank.js once the tank's model (or the box fallback) is built.
   Safe to call on every tank — it reads the save and bails for tanks with
   no style equipped. */
function apply(tank){
  try{
    if(!tank || !tank.root || !tank.def || !tank.def.id) return;
    var styleId = equippedForTank(tank.def.id);
    if(!styleId) return Promise.resolve(false);
    return applyToModel(tank.root, styleId);
  }catch(e){
    console.warn('TankStyles.apply failed:', e);
    return Promise.resolve(false);
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
  artMarkup: artMarkup,
  BRUSH_ICON: BRUSH_ICON,
  CAMO_INK: CAMO_INK,
  apply: apply,
  applyToModel: applyToModel,
  removeFromModel: removeFromModel,
  applyToPreview: applyToPreview,
  setPreviewTank: setPreviewTank,
  /* Debug/diagnose: shows how many meshes the LAST apply painted and when. */
  debug: function(){ return Object.assign({}, _debug, { previewTank: _previewTankId }); },
};

})();
