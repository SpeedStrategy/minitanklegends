/* ============================================================
   gladiator-map.js — Built-in battle-royale arena: "Cliff Basin"
   Used by gladiator mode (SP + MP host) when no custom map is set.
   3x bigger open battlefield: wide cliff gateways, scattered
   trees/bushes, deterministic (seeded RNG) so every client
   renders the same arena.
   Object kinds understood by World.loadCustomMapData:
     spawnpoint (subType 'gladiator'), gladiatorbox,
     tree (brown trunk + green foliage, trunk collides, gives camo),
     bush (green cover, no collision), wall/cube (rocky cliff).
   ============================================================ */

var GLADIATOR_MAP = (function(){
  'use strict';
  const objects = [];
  const R = v => Math.round(v * 10) / 10;
  const push = o => objects.push(o);

  /* ---------- 10 spawn points on a ring, facing the center ---------- */
  for(let k = 0; k < 10; k++){
    const a = k * Math.PI / 5;
    push({ type: 'spawnpoint', subType: 'gladiator',
      x: R(165 * Math.sin(a)), z: R(165 * Math.cos(a)),
      ry: Math.round((a + Math.PI) * 100) / 100 });
  }

  /* ---------- 20 blue boxes: outer ring + inner ring ---------- */
  for(let k = 0; k < 12; k++){
    const a = k * Math.PI / 6;
    push({ type: 'gladiatorbox', x: R(150 * Math.sin(a)), z: R(150 * Math.cos(a)) });
  }
  for(let k = 0; k < 8; k++){
    const a = k * Math.PI / 4 + Math.PI / 4;
    push({ type: 'gladiatorbox', x: R(60 * Math.sin(a)), z: R(60 * Math.cos(a)) });
  }

  /* ---------- Cliff ring: 4 big gateway clusters around the lake ---------- */
  const cliff = (r, aDeg, sx, sy, sz, ry) => {
    const a = aDeg * Math.PI / 180;
    push({ type: 'wall', kind: 'cube',
      x: R(r * Math.sin(a)), z: R(r * Math.cos(a)),
      y: R(3 * sy), sx, sy, sz, ry });
  };
  [45, 135, 225, 315].forEach(d => {
    cliff(105, d, 3.6, 3.0, 3.6, 0.35);         // main boulder
    cliff(108, d + 16, 2.7, 2.2, 2.7, -0.25);   // flank 1
    cliff(86, d - 16, 3.0, 2.4, 3.0, 0.5);      // flank 2
  });
  /* scattered boulders between the gateways */
  [[0, 90, 2.2, 1.6], [92, 78, 2.2, 1.5], [180, 87, 2.4, 1.7],
   [268, 90, 2.1, 1.4], [354, 99, 1.8, 1.2]].forEach(b => {
    cliff(b[1], b[0], b[2], b[3], b[2], 0.4);
  });
  /* corner watchtower rocks */
  [[156, 156], [156, -156], [-156, 156], [-156, -156]].forEach(p => {
    push({ type: 'wall', kind: 'cube', x: p[0], z: p[1],
      y: R(3 * 3.5), sx: 5.0, sy: 3.5, sz: 5.0, ry: 0.7 });
  });

  /* ---------- Seeded RNG (identical on every client) ---------- */
  const mulberry32 = a => {
    return function(){
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  };
  const rng = mulberry32(20260717);

  const spawns = objects.filter(o => o.type === 'spawnpoint');
  const cliffs = objects.filter(o => o.type === 'wall');
  const boxes = objects.filter(o => o.type === 'gladiatorbox');
  const placed = [];

  const clear = (x, z, minDist, propR) => {
    if(Math.hypot(x, z) < 16) return false;
    if(Math.abs(x) > 210 || Math.abs(z) > 210) return false;
    for(const s of spawns){
      if(Math.hypot(x - s.x, z - s.z) < minDist) return false;
    }
    for(const c of cliffs){
      if(Math.hypot(x - c.x, z - c.z) < 6 * Math.max(c.sx, c.sz) / 2 + 3 + propR) return false;
    }
    for(const b of boxes){
      if(Math.hypot(x - b.x, z - b.z) < minDist) return false;
    }
    for(const p of placed){
      if(Math.hypot(x - p.x, z - p.z) < p.r) return false;
    }
    return true;
  };

  /* ---------- Trees (trunk collides, foliage hides you) ---------- */
  let placedTrees = 0, tries = 0;
  while(placedTrees < 36 && tries < 800){
    tries++;
    const x = (rng() * 2 - 1) * 195, z = (rng() * 2 - 1) * 195;
    if(!clear(x, z, 15, 6)) continue;
    push({ type: 'tree', x: R(x), z: R(z),
      sx: R(0.9 + rng() * 0.4), sy: R(1.0 + rng() * 0.6),
      ry: Math.round(rng() * 6) / 2 });
    placed.push({ x, z, r: 15 });
    placedTrees++;
  }

  /* ---------- Bushes (no collision, camo cover) ---------- */
  let placedBushes = 0; tries = 0;
  while(placedBushes < 36 && tries < 800){
    tries++;
    const x = (rng() * 2 - 1) * 195, z = (rng() * 2 - 1) * 195;
    if(!clear(x, z, 8, 3)) continue;
    const big = rng() < 0.35;
    push({ type: 'bush', kind: big ? 'cube' : 'cone',
      x: R(x), z: R(z),
      sx: big ? R(0.5 + rng() * 0.15) : R(0.45 + rng() * 0.2),
      sy: big ? R(0.25 + rng() * 0.1) : R(0.2 + rng() * 0.1),
      sz: big ? R(0.5 + rng() * 0.15) : R(0.45 + rng() * 0.2),
      y: big ? R(0.9) : R(0.7), ry: Math.round(rng() * 6) });
    placed.push({ x, z, r: 8 });
    placedBushes++;
  }
  /* lake-ring bushes for a soft shoreline */
  for(let k = 0; k < 8; k++){
    const a = k * Math.PI / 4 + Math.PI / 8;
    push({ type: 'bush', kind: 'cone',
      x: R(14 * Math.sin(a)), z: R(14 * Math.cos(a)),
      sx: 0.55, sy: 0.25, sz: 0.55, y: 0.85, ry: 0 });
  }

  return { name: 'Gladiator Cliffs', objects };
})();
