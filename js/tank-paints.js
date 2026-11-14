/* ============================================================
   tank-paints.js — tank PAINTS (cosmetics tab → Paint).

   A STYLE IS THE WHOLE TANK. A PAINT IS ONE PART.

   That is the entire difference, and it is why this file exists next
   to tank-styles.js instead of inside it. A style pours one seamless
   texture over every paintable mesh of the model. A paint is chosen
   for the HULL or for the TURRET, and the two parts can wear two
   different paints — a crimson turret on a gunmetal hull.

   THE COST IS PER PART. Paints come from the two packs in the store,
   and every paint in a pack arrives with TWO COATS. One coat covers
   one part, so a single paint can dress a whole tank (hull + turret)
   and then it is spent until another pack is opened. Taking a coat
   off gives it back, so trying a colour on and changing your mind
   costs nothing — only a coat left ON a part is spent.

   THREE PAINTS IN EACH PACK ARE ANIMATED. They are painted in code
   (canvas → CanvasTexture) and their texture is moved slowly by one
   shared ticker: nothing else in the game animates a tank surface
   this way, so it gets its own small loop rather than a hook in the
   render path.

   Persistence, own key `tankparty_paints`:
     packs:  { paint_pack: true, big_paint_pack: true }
     owned:  { paintId: coatsEverGranted }
     coats:  { paintId: coatsLeft }
     parts:  { tankId: { hull: paintId, turret: paintId } }
   Mirrored ownership into the settings save the same way the styles
   and sprays do, so a settings round-trip cannot drop a purchase.

   Battle: TankPaints.apply(tank) — chained off tank.js next to the
   style apply.
   Preview: TankPaints.applyToTank(previewTank) from tank-menu.js.
   ============================================================ */
window.TankPaints = (function(){
'use strict';

var KEY = 'tankparty_paints';
var COATS_PER_PAINT = 2;

/* ---------------------------------------------------------------- catalog */

var DEFS = {};
var LIST = [];

function solid(id, name, color, desc){
  DEFS[id] = { id:id, name:name, color:color, desc:desc, kind:'solid' };
  LIST.push(id);
}

/* An animated paint: `bg`/`fg` are the canvas painter's two colours, `pattern`
   is which painter to run, `anim` is how the finished texture moves. */
function anim(id, name, bg, fg, pattern, speed, desc){
  DEFS[id] = {
    id:id, name:name, color:bg, bg:bg, fg:fg,
    kind:'anim', pattern:pattern, speed:speed,
    desc:desc,
  };
  LIST.push(id);
}

/* ---- PACK 1 — "Paint Pack": 12 paints, 2 coats each --------------------- */

solid('olive_drab',   'Olive Drab',   '#4a5334', 'The colour of doing what you are told.');
solid('desert_tan',   'Desert Tan',   '#c3a878', 'Sand, dust and no shade for miles.');
solid('slate_grey',   'Slate Grey',   '#5f6875', 'Neutral, quiet, hard to place on a map.');
solid('gunmetal',     'Gunmetal',     '#2e3540', 'Factory finish, straight off the line.');
solid('rust_coat',    'Rust Coat',    '#8d4c26', 'Twenty years in a field and still rolling.');
solid('arctic_white', 'Arctic White', '#dfe7ec', 'For snow, and for being seen.');
solid('crimson',      'Crimson',      '#a52f31', 'A warning nobody reads twice.');
solid('navy_blue',    'Navy Blue',    '#2c4068', 'Deep water, deeper cover.');
solid('moss_green',   'Moss Green',   '#3e6b3d', 'Borrowed from a wall.');

anim('hazard_ribbons', 'Hazard Ribbons', '#e8c22b', '#14161a', 'ribbons', 0.06,
     'Caution-tape yellow with black ribbons crawling across the plate.');
anim('plum_pulse',     'Plum Pulse',     '#5a2a63', '#c07ad6', 'dots',    0.5,
     'Purple with dots that swell and shrink like something breathing.');
anim('copper_wave',    'Copper Wave',    '#1e6b6b', '#c8823a', 'wave',    0.1,
     'Teal and copper banded like an old boiler room.');

/* The first pack ends here. Recorded rather than counted by hand, so adding a
   colour to either pack never silently moves it into the other one. */
var PACK1_END = LIST.length;

/* ---- PACK 2 — "Big Paint Pack": 30 paints, 2 coats each ----------------- */

solid('charcoal',   'Charcoal',   '#22262c', 'Black with a little life left in it.');
solid('ash',        'Ash',        '#6f747c', 'Cold grey, freshly burnt.');
solid('bone',       'Bone',       '#e4ddc9', 'Pale, dry, and older than the war.');
solid('khaki',      'Khaki',      '#b7a878', 'The classic field colour.');
solid('terracotta', 'Terracotta', '#b4553d', 'Fired clay, all year round.');
solid('clay',       'Clay',       '#8d6a55', 'Soft brown, wrong for a tank, right for a look.');
solid('coral',      'Coral',      '#e8705b', 'Bright enough to regret at range.');
solid('peach',      'Peach',      '#f2b48c', 'A paint job with no survival instinct.');
solid('amber',      'Amber',      '#d99a2b', 'Warm, loud, impossible to lose in a forest.');
solid('brass',      'Brass',      '#b3863c', 'Parade-ground shine.');
solid('lemon',      'Lemon',      '#e3d24a', 'Seen from orbit.');
solid('lime',       'Lime',       '#a4c93c', 'Acid green, hard on the eyes.');
solid('emerald',    'Emerald',    '#2f8f5b', 'Green with money behind it.');
solid('seafoam',    'Seafoam',    '#7fc9a9', 'A pale green that almost blends.');
solid('teal',       'Teal',       '#2a7f85', 'Blue-green, cool and steady.');
solid('cyan',       'Cyan',       '#47b6c8', 'Signal colour, no subtlety.');
solid('sky',        'Sky',        '#7fb4dd', 'Light blue, light armour.');
solid('cobalt',     'Cobalt',     '#2f4f9e', 'Deep, saturated, serious.');
solid('indigo',     'Indigo',     '#40367a', 'Nearly night.');
solid('violet',     'Violet',     '#7a4fa5', 'Purple that means it.');
solid('orchid',     'Orchid',     '#b06cc0', 'A flower with a gun.');
solid('magenta',    'Magenta',    '#c02a6e', 'Nothing on the battlefield is this colour.');
solid('bubblegum',  'Bubblegum',  '#e78ab0', 'Sugary, and completely unbothered.');
solid('wine',       'Wine',       '#6b1f34', 'Dark red, aged badly.');
solid('espresso',   'Espresso',   '#3a2a22', 'Almost black, with warmth.');
solid('jade',       'Jade',       '#3f9a86', 'Stone green, polished.');
solid('rose_quartz','Rose Quartz','#d8a3a8', 'Soft pink, badly out of place and happy about it.');

anim('mint_swirl',    'Mint Swirl',   '#b7e3c6', '#2f7f5f', 'ribbons', 0.045,
     'Mint with dark green ribbons drifting like slow water.');
anim('ember_dots',    'Ember Dots',   '#2a1512', '#e2823a', 'dots',    0.4,
     'Dark ember with amber dots that breathe in and out.');
anim('royal_chevron', 'Royal Chevron', '#20325e', '#d8b45a', 'chevron', 0.07,
     'Royal blue with gold chevrons sliding past each other.');

/* THE TWO PACKS. `free: true` is the brief: both are free in the store right
   now, so they are shown as FREE cards and can be claimed once each. */
var PACKS = {
  paint_pack: {
    id: 'paint_pack',
    name: 'Paint Pack',
    desc: '12 paints — 9 flat, 3 animated. Two coats of each, one coat per part.',
    free: true,
    paints: LIST.slice(0, PACK1_END),
  },
  big_paint_pack: {
    id: 'big_paint_pack',
    name: 'Big Paint Pack',
    desc: '30 paints — 27 flat, 3 animated. Two coats of each, one coat per part.',
    free: true,
    paints: LIST.slice(PACK1_END),
  },
};
var PACK_LIST = ['paint_pack', 'big_paint_pack'];

/* ---------------------------------------------------------------- save */

function readData(){
  try{ return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
  catch(e){ return {}; }
}
function writeData(d){
  try{ localStorage.setItem(KEY, JSON.stringify(d)); }catch(e){}
}

function ownsPaint(id){
  var d = readData();
  return !!(d.owned && d.owned[id]);
}
function coatsOf(id){
  var d = readData();
  if(!d.owned || !d.owned[id]) return 0;
  var left = (d.coats && d.coats[id] != null) ? d.coats[id] : d.owned[id];
  return Math.max(0, Math.min(d.owned[id], left));
}
function packOwned(packId){
  var d = readData();
  return !!(d.packs && d.packs[packId]);
}

/* Grant a pack. Idempotent per pack: claiming twice adds nothing, so a
   double-click on a free offer cannot mint coats. */
function grantPack(packId){
  var pack = PACKS[packId];
  if(!pack) return 0;
  var d = readData();
  d.packs = d.packs || {};
  d.owned = d.owned || {};
  d.coats = d.coats || {};
  if(d.packs[packId]) return 0;
  d.packs[packId] = true;
  var n = 0;
  pack.paints.forEach(function(id){
    d.owned[id] = (d.owned[id] || 0) + COATS_PER_PAINT;
    d.coats[id] = (d.coats[id] || 0) + COATS_PER_PAINT;
    n++;
  });
  writeData(d);
  mirrorSettings(d);
  return n;
}

/* Ownership is also mirrored into the settings save, exactly like the sprays
   and styles: either copy counts, so a reset of one does not lose the pack. */
function mirrorSettings(d){
  try{
    var s = typeof loadSettings === 'function' ? loadSettings() : null;
    if(!s) return;
    if(!Array.isArray(s.ownedPaints)) s.ownedPaints = [];
    Object.keys(d.owned || {}).forEach(function(id){
      if(s.ownedPaints.indexOf(id) === -1) s.ownedPaints.push(id);
    });
    if(typeof saveSettings === 'function') saveSettings(s);
  }catch(e){}
}

/* ---------------------------------------------------------------- parts */

var PART_LABEL = { hull: 'Hull', turret: 'Turret' };

function partsFor(tankId){
  var d = readData();
  var p = (d.parts && d.parts[tankId]) || {};
  var out = {};
  ['hull', 'turret'].forEach(function(part){
    var id = p[part];
    if(id && DEFS[id] && ownsPaint(id)) out[part] = id;
  });
  return out;
}
function paintOn(tankId, part){
  return partsFor(tankId)[part] || null;
}

/* One coat, one part. Returns a short status string so the caller can say
   why it refused without inventing its own wording. */
function paintPart(tankId, part, paintId){
  if(!tankId || !part || !DEFS[paintId]) return { ok:false, why:'Unknown paint' };
  if(part !== 'hull' && part !== 'turret') return { ok:false, why:'Unknown part' };
  var d = readData();
  if(!d.owned || !d.owned[paintId]) return { ok:false, why:'Not owned — open a paint pack' };
  d.parts = d.parts || {};
  var cur = (d.parts[tankId] || {})[part];
  if(cur === paintId) return { ok:true, why:'Already painted' };
  var coats = (d.coats && d.coats[paintId] != null) ? d.coats[paintId] : d.owned[paintId];
  if(coats <= 0) return { ok:false, why:'Out of coats — every coat is on a tank' };
  d.coats[paintId] = coats - 1;
  /* Taking a part out of an old paint gives that coat back, so swapping
     colours never quietly eats the budget. */
  if(cur && DEFS[cur] && d.coats[cur] != null){
    d.coats[cur] = Math.min(d.owned[cur] || COATS_PER_PAINT, d.coats[cur] + 1);
  }
  d.parts[tankId] = d.parts[tankId] || {};
  d.parts[tankId][part] = paintId;
  writeData(d);
  return { ok:true, why:'Painted' };
}

function clearPart(tankId, part){
  var d = readData();
  var rec = d.parts && d.parts[tankId];
  if(!rec || !rec[part]) return false;
  var cur = rec[part];
  delete rec[part];
  if(!Object.keys(rec).length) delete d.parts[tankId];
  if(DEFS[cur] && d.coats && d.coats[cur] != null){
    d.coats[cur] = Math.min(d.owned[cur] || COATS_PER_PAINT, d.coats[cur] + 1);
  }
  writeData(d);
  return true;
}

/* ---------------------------------------------------------------- texture */

var _texCache = {};
var _patternMatCache = {};
var _animTex = [];
var _animTimer = null;
var _lastAnim = 0;

function canvas2d(S){
  var c = document.createElement('canvas');
  c.width = S; c.height = S;
  return c;
}

/* The painters. Every one of them tiles: the periods divide the canvas, so a
   texture scrolled by half a canvas still meets itself at the seam. */
function paintPattern(def){
  var S = 256;
  var c = canvas2d(S);
  var g = c.getContext('2d');
  g.fillStyle = def.bg; g.fillRect(0, 0, S, S);
  g.fillStyle = def.fg;
  g.strokeStyle = def.fg;

  if(def.pattern === 'ribbons'){
    /* 45° caution ribbons: slope 1, period 64, both divide 256. */
    g.lineWidth = 22;
    for(var k = -S; k <= 2 * S; k += 64){
      g.beginPath(); g.moveTo(k, 0); g.lineTo(k + S, S); g.stroke();
    }
  } else if(def.pattern === 'dots'){
    var r = 22, step = 64;
    for(var y = 0; y < S; y += step){
      for(var x = 0; x < S; x += step){
        /* Offsetting every other row keeps the tile seamless only if the
           offset is half a step and the rows wrap — hence the double draw. */
        var ox = ((y / step) % 2) ? step / 2 : 0;
        [-1, 0, 1].forEach(function(dx){
          g.beginPath();
          g.arc(x + ox + dx * S, y, r, 0, Math.PI * 2);
          g.fill();
        });
      }
    }
  } else if(def.pattern === 'wave'){
    for(var yy = 0; yy < S; yy++){
      var t = Math.sin((yy / S) * Math.PI * 6) * 0.5 + 0.5;
      g.globalAlpha = 0.25 + 0.55 * t;
      g.fillRect(0, yy, S, 1);
    }
    g.globalAlpha = 1;
  } else if(def.pattern === 'chevron'){
    g.lineWidth = 20;
    for(var cy = 0; cy <= S; cy += 64){
      for(var cx = 0; cx <= S; cx += 64){
        g.beginPath();
        g.moveTo(cx, cy + 32);
        g.lineTo(cx + 32, cy);
        g.lineTo(cx + 64, cy + 32);
        g.stroke();
      }
    }
  }
  return c;
}

function textureFor(id){
  if(_texCache[id]) return _texCache[id];
  var def = DEFS[id];
  if(!def || def.kind !== 'anim') return null;
  var canvas = paintPattern(def);
  var tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(2, 2);
  tex.userData.baseRepeat = 2;
  tex.userData.paintId = id;
  _texCache[id] = tex;
  _animTex.push(tex);
  startTicker();
  return tex;
}

/* ONE TICKER FOR EVERY ANIMATED PAINT.

   Slower than a frame on purpose: these are cosmetic drifts, not motion. 24
   updates a second is smooth for a pattern this large and costs nothing --
   the interval only exists while an animated texture is actually alive. */
function startTicker(){
  if(_animTimer) return;
  _lastAnim = (window.performance && performance.now) ? performance.now() : Date.now();
  _animTimer = setInterval(function(){
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var dt = Math.min(0.2, (now - _lastAnim) / 1000);
    _lastAnim = now;
    for(var i = 0; i < _animTex.length; i++){
      var tex = _animTex[i];
      var def = DEFS[tex.userData.paintId];
      if(!def) continue;
      if(def.pattern === 'dots'){
        /* Growing and shrinking dots: the pattern itself is scaled about its
           centre, so the dots breathe instead of sliding. */
        var s = 1 + Math.sin(now / 1400) * 0.12;
        var base = tex.userData.baseRepeat;
        tex.repeat.set(base * s, base * s);
      } else {
        tex.offset.x = (tex.offset.x + def.speed * dt) % 1;
        tex.offset.y = (tex.offset.y + def.speed * 0.35 * dt) % 1;
      }
    }
  }, 42);
}

/* ---------------------------------------------------------------- painting */

/* Which meshes of a tank take paint — the same rules the styles use: never
   the ink outline shells, never a spray stamp, never a hidden helper. */
function paintableMeshes(root){
  var out = [];
  if(!root) return out;
  root.traverse(function(o){
    if(!o.isMesh || o.visible === false) return;
    var u = o.userData || {};
    /* isPaintHl: the paint tab's own white outline/ribbon overlays are copies
       of the part's geometry. Without this they are paintable, so they would
       be added to the mesh list and painted over themselves. */
    if(u.isSpray || u.isOutline || u.isPaintHl || u.noSpray || u.noStyle) return;
    var n = String(o.name || '').toLowerCase().replace(/[\s_\-]/g, '');
    if(n === 'hitbox') return;
    out.push(o);
  });
  return out;
}

/* WHICH PART IS THIS MESH? Walk up to see whether the turret group is an
   ancestor. The preview and the battle tank both expose `turretGroup`, so
   this needs no second table of mesh names — which is the bug the styles
   system exists to avoid. */
function partOfMesh(mesh, tank){
  var turret = tank && (tank.turretGroup || tank._turretG);
  if(!turret) return 'hull';
  for(var o = mesh; o; o = o.parent){
    if(o === turret) return 'turret';
  }
  return 'hull';
}

function materialFor(id){
  if(_patternMatCache[id]) return _patternMatCache[id];
  var def = DEFS[id];
  if(!def) return null;
  var mat;
  if(def.kind === 'anim'){
    mat = Toon.mat({ map: textureFor(id), color: 0xffffff, side: THREE.DoubleSide });
  } else {
    /* Flat paint: no albedo map at all. Multiplying a camouflage texture by
       a red tint gives muddy brown, not red — a painted plate is paint over
       steel, which is what a coloured material actually looks like. */
    mat = Toon.mat({ color: new THREE.Color(def.color), side: THREE.DoubleSide });
  }
  mat.userData = { isPaint: true, paintId: id };
  _patternMatCache[id] = mat;
  return mat;
}

function paintMeshes(meshes, part, paintId){
  var mat = materialFor(paintId);
  if(!mat) return 0;
  var n = 0;
  meshes.forEach(function(m){
    /* The ORIGINAL material is remembered once. Painting hull and turret in
       any order therefore always strips back to the real surface, never to
       another paint. */
    if(!m.userData._paintBase) m.userData._paintBase = m.material;
    m.material = mat;
    m.userData._paintPart = part;
    n++;
  });
  return n;
}

function stripPaints(root){
  if(!root) return;
  root.traverse(function(o){
    if(!o || !o.userData) return;
    if(o.userData._paintBase){
      o.material = o.userData._paintBase;
      delete o.userData._paintBase;
    }
    delete o.userData._paintPart;
    delete o.userData._viewPainted;
  });
}

/* Apply a tank's saved paints. Safe on every tank: a tank with no paint
   equipped is stripped and left exactly as it was. */
function applyToTank(tank){
  try{
    if(!tank || !tank.root || !tank.def || !tank.def.id) return false;
    stripPaints(tank.root);
    var parts = partsFor(tank.def.id);
    var painted = false;
    var meshes = paintableMeshes(tank.root);
    ['hull', 'turret'].forEach(function(part){
      var id = parts[part];
      if(!id) return;
      var mine = meshes.filter(function(m){ return partOfMesh(m, tank) === part; });
      if(paintMeshes(mine, part, id) > 0) painted = true;
    });
    return painted;
  }catch(e){
    console.warn('TankPaints.apply failed:', e);
    return false;
  }
}

/* Battle hook, mirrors TankStyles.apply. */
function apply(tank){
  return applyToTank(tank);
}

/* ---------------------------------------------------------------- art */

/* The card art: an animated paint gets ONE rendered frame of its own canvas,
   a flat paint gets a plain chip, so a card always looks like the paint it
   sells. Cached, because the grid is rebuilt on every click. */
var _thumbCache = {};
function swatchUrl(id){
  if(_thumbCache[id]) return _thumbCache[id];
  var def = DEFS[id];
  if(!def) return '';
  var url = '';
  if(def.kind === 'anim'){
    try{ url = paintPattern(def).toDataURL('image/png'); }catch(e){ url = ''; }
  }
  _thumbCache[id] = url;
  return url;
}

function swatchColor(id){
  var d = DEFS[id];
  return (d && d.color) || '#888888';
}

/* ---------------------------------------------------------------- public */

return {
  DEFS: DEFS,
  LIST: LIST,
  PACKS: PACKS,
  PACK_LIST: PACK_LIST,
  PART_LABEL: PART_LABEL,
  COATS_PER_PAINT: COATS_PER_PAINT,
  ownsPaint: ownsPaint,
  coatsOf: coatsOf,
  packOwned: packOwned,
  grantPack: grantPack,
  partsFor: partsFor,
  paintOn: paintOn,
  paintPart: paintPart,
  clearPart: clearPart,
  partOfMesh: partOfMesh,
  paintableMeshes: paintableMeshes,
  materialFor: materialFor,
  apply: apply,
  applyToTank: applyToTank,
  stripPaints: stripPaints,
  swatchUrl: swatchUrl,
  swatchColor: swatchColor,
  /* Debug: how many animated textures are alive right now. */
  debug: function(){ return { animated: _animTex.length, packs: readData().packs || {}, coats: readData().coats || {} }; },
};

})();
