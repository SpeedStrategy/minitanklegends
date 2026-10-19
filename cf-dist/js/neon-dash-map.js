/* ============================================================
   neon-dash-map.js — Built-in race map for the NEON DASH gamemode.
   A single winding parkour track across the world:
   - 10 spawn points at the west start line (subType 'neon')
   - 3 checkpoint gates + 1 finish gate (must pass gates in order)
   - 2 cycling laser walls, 2 pusher pads, 2 slow zones, 2 boost pads
   - Corridor walls (neonwall) every ~4 units along the centerline;
     leaving the track floor = falling off (respawn at last checkpoint)
   Deterministic (seeded RNG) so every client builds the same track.
   ============================================================ */

var NEON_MAP = (function(){
  'use strict';
  const objects = [];
  const R = v => Math.round(v * 10) / 10;
  const push = o => objects.push(o);

  const mulberry32 = a => {
    return function(){
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  };
  const rng = mulberry32(20260820);

  /* ---------- Track centerline (west -> east) ---------- */
  const WAY = [
    [-195, 0], [-150, 28], [-105, -12], [-60, 30], [-15, 0],
    [30, -32], [75, 10], [120, -25], [165, 8], [195, 0],
  ];
  const HALF_W = 11; // corridor half width

  const segs = [];
  for(let i = 0; i < WAY.length - 1; i++){
    const x0 = WAY[i][0], z0 = WAY[i][1];
    const x1 = WAY[i + 1][0], z1 = WAY[i + 1][1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    segs.push({ x0, z0, x1, z1, len, dx: (x1 - x0) / len, dz: (z1 - z0) / len });
  }

  /* ---------- Corridor walls (both sides of every segment) ---------- */
  for(const s of segs){
    const px = -s.dz, pz = s.dx; // perpendicular (left of travel)
    const n = Math.max(1, Math.floor(s.len / 4.0));
    for(let k = 0; k <= n; k++){
      const t = (k / n) * s.len;
      const mx = s.x0 + s.dx * t;
      const mz = s.z0 + s.dz * t;
      const jit = (rng() - 0.5) * 0.6;
      for(const side of [-1, 1]){
        push({ type: 'neonwall', kind: 'cube',
          x: R(mx + px * HALF_W * side + jit * px),
          z: R(mz + pz * HALF_W * side + jit * pz),
          y: 1.86, sx: 0.73, sy: 0.62, sz: 0.73, ry: R((rng() - 0.5) * 0.4) });
      }
    }
  }

  /* ---------- Track floor tiles (also define the "on track" zones) ---------- */
  for(const s of segs){
    const mx = (s.x0 + s.x1) / 2, mz = (s.z0 + s.z1) / 2;
    push({ type: 'neonfloor', x: R(mx), z: R(mz),
      sx: R((s.len + 8) / 6), sz: 4, y: 0.02 });
  }
  // Extra tile over the start line so spawns always sit on the track
  push({ type: 'neonfloor', x: -188, z: 1, sx: 2.2, sz: 4, y: 0.02 });

  /* ---------- Start line: 10 spawns facing east ---------- */
  const s1 = segs[0];
  const spawnRy = Math.atan2(s1.dx, s1.dz); // face along the track
  for(let k = 0; k < 10; k++){
    push({ type: 'spawnpoint', subType: 'neon',
      x: R(-193 + (rng() - 0.5) * 1.2),
      z: R(1.2 + (k - 4.5) * 1.8 + (rng() - 0.5) * 0.4),
      ry: R(spawnRy + (rng() - 0.5) * 0.1) });
  }

  /* ---------- Checkpoint gates (cross in order) + finish ---------- */
  const gate = (x, z, dirX, dirZ, index) => {
    push({ type: 'neoncheckpoint', x, z, index,
      spawnX: R(x - dirX * 5), spawnZ: R(z - dirZ * 5),
      spawnRy: R(Math.atan2(dirX, dirZ)) });
  };
  // CP0 — entry of the first long straight (seg 4)
  gate(-55, 28, 0.83, 0.55, 0);
  // CP1 — mid-track (seg 7)
  gate(80, 6, 0.79, 0.61, 1);
  // CP2 — final stretch (seg 9)
  gate(163, 6, 0.97, 0.26, 2);
  push({ type: 'neonfinish', x: 197, z: 0 });

  /* ---------- Traps ---------- */

  // Laser walls (cycle on/off, damage while active, block nothing)
  push({ type: 'neonlaser', x: -35, z: 14, index: 0,
    y: 1.86, sx: 0.2, sy: 0.6, sz: 3.7,
    ry: R(Math.atan2(-0.55, 0.83)) });
  push({ type: 'neonlaser', x: 100, z: -9, index: 1,
    y: 1.86, sx: 0.2, sy: 0.6, sz: 3.7,
    ry: R(Math.atan2(-0.59, 0.81)) });

  // Pusher pads (green, launch tanks toward the void)
  push({ type: 'neonpusher', x: -95, z: 14, y: 0.06,
    sx: 1.34, sy: 0.12, sz: 1.34, ry: 0,
    dirX: 0.68, dirZ: -0.73 });
  push({ type: 'neonpusher', x: 135, z: 3, y: 0.06,
    sx: 1.34, sy: 0.12, sz: 1.34, ry: 0,
    dirX: 0.59, dirZ: -0.81 });

  // Slow zones (yellow, waste your time)
  push({ type: 'neonslow', x: -50, z: 10, y: 0.06, sx: 3, sy: 0.12, sz: 1.67, ry: 0 });
  push({ type: 'neonslow', x: 148, z: 4, y: 0.06, sx: 2, sy: 0.12, sz: 1.33, ry: 0 });

  // Boost pads (cyan, forward burst)
  push({ type: 'neonboost', x: -140, z: 24, y: 0.06, sx: 1, sy: 0.12, sz: 0.67, ry: 0 });
  push({ type: 'neonboost', x: 55, z: 0, y: 0.06, sx: 1, sy: 0.12, sz: 0.67, ry: 0 });

  /* ---------- Parkour obstacles inside the corridor ---------- */
  push({ type: 'neonwall', kind: 'cube', x: -128, z: 21, y: 1.65, sx: 1, sy: 0.55, sz: 1, ry: 0.3 });
  push({ type: 'neonwall', kind: 'cube', x: 86, z: 8, y: 1.65, sx: 1, sy: 0.55, sz: 1, ry: -0.2 });
  push({ type: 'neonwall', kind: 'cube', x: 148, z: -6, y: 1.65, sx: 0.83, sy: 0.55, sz: 1.33, ry: 0.4 });

  return { name: 'Neon Dash Circuit', objects };
})();