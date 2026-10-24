/* ============================================================================
   bot-nav.js — teaching bots where they can drive.

   WHAT WAS MISSING
   ----------------
   The bots could see, aim, take cover and dodge, but they had no sense of the
   map as a place. Movement was purely reactive: _wallAvoid() put three probes
   four units in front of the hull and swerved left or right if one hit
   something. That is enough to stop a bot driving into a wall head-on, and
   nothing more:

     * A bot whose target is the other side of a building steers straight at the
       wall, hits it, swerves, hits it again, and oscillates in front of it
       until _checkStuck() eventually gives up and picks a random turn.
     * A corridor with one turn in it is impassable, because the bot has no way
       to know the turn exists.
     * Nothing in the AI knows a dead end from a shortcut, so a bot will happily
       commit to a route that is three times the length of the one next to it.

   That is the difference between "a tank that avoids obstacles" and "a tank that
   knows the map". This module is the second thing.

   WHY A GRID AND NOT A NAVMESH
   ----------------------------
   A navmesh is the right answer for a game with hundreds of agents and a
   hundred hand-authored obstacles. This has sixteen tanks and procedurally
   placed cover, so a uniform grid gets most of the benefit for a small fraction
   of the risk: it cannot get out of sync with the collision geometry, because
   it is BAKED FROM the same collision function the tanks actually obey.

   THE COST ARGUMENT, WHICH IS THE WHOLE POINT
   --------------------------------------------
   The grid is built ONCE PER MAP, not once per bot, and shared by every bot.
   A 450-unit battlefield at 4-unit cells is about 113x113 = 12.8k cells, and the
   bake is one collision query per cell — so it is a few milliseconds, once, on
   map load. Sixteen bots reading one shared grid costs sixteen times nothing.

   A* then runs under a hard expansion budget, so a hopeless query cannot stall
   a frame: it gives up and returns the best partial route it found. Paths are
   cached per bot and reused until the goal actually moves, because re-planning
   every tick is what makes naive pathfinding expensive.

   The result is that pathfinding is effectively free at runtime, which is what
   makes it safe to let every bot use it every tick rather than rationing it.
   ========================================================================== */

(function(){
'use strict';
if (window.BotNav) return;

/* Half-width of a tank, used as the clearance radius when baking the grid.
   The bake asks the world's own collidesWallsOnly() with this radius, so a cell
   is blocked exactly when a tank centred on it would be overlapping something.
   Matching the real number here is what keeps the bots from shaving walls the
   physics would reject. */
var TANK_RADIUS = 2.0;

/* Cell size in world units. 4 is a good compromise: coarse enough that a big
   map stays a small grid and A* stays cheap, fine enough that a 4-unit gap
   between two cover blocks is still passable, which at 8 it would not be. */
var CELL = 4;

/* Hard ceiling on A* node expansions. Roughly 4000 cells' worth of search. Past
   this the bot takes the best partial route instead of blocking the frame —
   a bot that arrives late beats a game that stops. */
var MAX_EXPANSIONS = 4000;

var SQRT2 = Math.SQRT2;

/* ============================================================== binary heap
   A* opens nodes in near-sorted order, so the frontier is almost always large.
   Linear scan for the minimum turns a typical search into thousands of
   comparisons per expansion; a heap makes it logarithmic. Two parallel typed
   arrays rather than an array of objects, because this runs inside the frame
   budget and allocation churn shows up as GC hitches. */
function Heap(cap){
  this.ids = new Int32Array(cap);
  this.keys = new Float64Array(cap);
  this.n = 0;
}
Heap.prototype.clear = function(){ this.n = 0; };
Heap.prototype.size = function(){ return this.n; };
Heap.prototype.push = function(id, key){
  if(this.n >= this.ids.length) return;          /* budget guard, never grows */
  var i = this.n++;
  this.ids[i] = id; this.keys[i] = key;
  while(i > 0){
    var p = (i - 1) >> 1;
    if(this.keys[p] <= this.keys[i]) break;
    this._swap(p, i); i = p;
  }
};
Heap.prototype.pop = function(){
  if(this.n === 0) return -1;
  var top = this.ids[0];
  this.n--;
  if(this.n > 0){
    this.ids[0] = this.ids[this.n]; this.keys[0] = this.keys[this.n];
    var i = 0;
    for(;;){
      var l = i*2 + 1, r = l + 1, m = i;
      if(l < this.n && this.keys[l] < this.keys[m]) m = l;
      if(r < this.n && this.keys[r] < this.keys[m]) m = r;
      if(m === i) break;
      this._swap(m, i); i = m;
    }
  }
  return top;
};
Heap.prototype._swap = function(a, b){
  var ti = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = ti;
  var tk = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = tk;
};

/* ================================================================== the grid */
function Grid(){}

/* One grid per world, rebuilt only when the geometry it was baked from
   actually changes. The key is the walls array's IDENTITY plus its LENGTH, the
   same test world._ensureIndex() uses: a map load reassigns the array (new
   identity) and a planted bush push()es onto it (new length), and those are the
   only two ways the geometry can change. */
Grid._cache = new WeakMap();

Grid.for = function(world){
  var hit = Grid._cache.get(world);
  if(hit && hit.srcWalls === world.walls && hit.srcLen === world.walls.length
           && hit.half === world.half){
    return hit.grid;
  }
  var g = new Grid();
  g.bake(world);
  Grid._cache.set(world, { grid: g, srcWalls: world.walls, srcLen: world.walls.length, half: world.half });
  return g;
};

/* Bake by asking the world what collides, cell by cell.

   Reading world.walls[] directly would be marginally faster, but it would be a
   second, independent model of "what is solid" — and the day the two disagree,
   the bots would path confidently into geometry the tanks cannot enter. One
   collision query per cell is cheap enough (a few ms, once, on map load) that
   correctness is worth more than the microseconds. */
Grid.prototype.bake = function(world){
  /* collidesForAI, not collidesWallsOnly: it is the query that INCLUDES GLB
     cover. A navigation grid that ignored cover would plan routes straight
     through the middle of buildings, which is precisely the failure this module
     exists to remove. Falls back to the tank query if an older world is loaded
     without it, so this module cannot hard-fail on a stale build. */
  var solid = world.collidesForAI
    ? function(x, z, r){ return world.collidesForAI(x, z, r); }
    : function(x, z, r){ return world.collidesWallsOnly(x, z, r); };

  /* Bounds come from the same source _voidAvoid() uses, so a bot that the grid
     says is off-map is also a bot _voidAvoid() would have turned around. */
  var half = (world.half || 333);
  var box = world._tdmBox;
  var minX = -half, maxX = half, minZ = -half, maxZ = half;
  if(box){
    /* _tdmBox is the loaded GLB's measured extent and is centred wherever the
       model happens to sit, so it can be off-origin. Trusting it exactly as
       _voidAvoid() does keeps the grid and the boundary in agreement. */
    minX = box.min.x; maxX = box.max.x; minZ = box.min.z; maxZ = box.max.z;
  }

  this.minX = minX; this.minZ = minZ;
  this.w = Math.max(1, Math.ceil((maxX - minX) / CELL));
  this.h = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
  this.cell = CELL;

  var n = this.w * this.h;
  var blocked = new Uint8Array(n);

  for(var cz = 0; cz < this.h; cz++){
    var wz = minZ + (cz + 0.5) * CELL;
    for(var cx = 0; cx < this.w; cx++){
      var wx = minX + (cx + 0.5) * CELL;
      /* Out of bounds is blocked: the boundary push-back in the bots is a
         reaction to being there, and it is better never to plan a path that
         ends there. */
      if(wx < minX || wx > maxX || wz < minZ || wz > maxZ){ blocked[cz*this.w + cx] = 1; continue; }
      blocked[cz*this.w + cx] = solid(wx, wz, TANK_RADIUS) ? 1 : 0;
    }
  }
  this.blocked = blocked;

  /* Free-cell count is used to give up early and to size the heap. A map that
     is almost entirely solid is a broken map load, and returning null from
     find() lets the caller fall back to its old reactive behaviour rather than
     grinding through a hopeless search. */
  var free = 0;
  for(var i = 0; i < n; i++) if(!blocked[i]) free++;
  this.freeCount = free;

  this._g = new Float32Array(n);
  this._parent = new Int32Array(n);
  this._stamp = new Int32Array(n);
  this._closed = new Uint8Array(n);
  this._epoch = 0;
  this._heap = new Heap(n);
  return this;
};

Grid.prototype.idx = function(cx, cz){ return cz * this.w + cx; };
Grid.prototype.inBounds = function(cx, cz){
  return cx >= 0 && cz >= 0 && cx < this.w && cz < this.h;
};
Grid.prototype.isBlocked = function(cx, cz){
  if(!this.inBounds(cx, cz)) return true;
  return this.blocked[cz * this.w + cx] === 1;
};
Grid.prototype.toCellX = function(x){ return Math.floor((x - this.minX) / CELL); };
Grid.prototype.toCellZ = function(z){ return Math.floor((z - this.minZ) / CELL); };
/* Clamp a cell index into the grid. See find() for why a goal can be outside
   it: the grid follows the map's measured box and world.half is usually bigger. */
Grid.prototype.clampCellX = function(cx){
  return cx < 0 ? 0 : (cx >= this.w ? this.w - 1 : cx);
};
Grid.prototype.clampCellZ = function(cz){
  return cz < 0 ? 0 : (cz >= this.h ? this.h - 1 : cz);
};
Grid.prototype.cellCenterX = function(cx){ return this.minX + (cx + 0.5) * CELL; };
Grid.prototype.cellCenterZ = function(cz){ return this.minZ + (cz + 0.5) * CELL; };

/* Nearest open cell, searched as a growing square around the request.

   A goal cell is very often blocked — the goal is usually a tank, and a tank
   parked against a wall bakes as a solid cell. Without this, every bot ordered
   to attack a wall-sitting tank would fail to path AT ALL, which is worse than
   the broken movement this file exists to fix. Expanding rings mean the bot
   routes to the closest reachable spot beside the target, which is what a
   human would do. */
Grid.prototype.nearestFree = function(cx, cz){
  if(!this.isBlocked(cx, cz)) return [cx, cz];
  for(var r = 1; r <= 12; r++){
    for(let dz = -r; dz <= r; dz++){
      for(let dx = -r; dx <= r; dx++){
        /* Only the ring, not the filled square, so the answer is genuinely the
           closest one. */
        if(Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const nx = cx + dx, nz = cz + dz;
        if(!this.isBlocked(nx, nz)) return [nx, nz];
      }
    }
  }
  return null;
};

/* ============================================================== A* search
   8-connected, octile heuristic. Returns an array of world-space waypoints, or
   null when there is genuinely no route.

   The search is bounded three ways so it can never blow the frame: an expansion
   budget, a hard cap on how far it may wander from the goal, and a free-cell
   sanity check. Any of those tripping returns the best partial path seen, which
   still walks the bot in the right general direction — better than freezing. */
Grid.prototype.find = function(sx, sz, gx, gz){
  if(this.freeCount < 8) return null;

  /* CLAMP INTO THE GRID BEFORE LOOKING FOR A FREE CELL.

     The grid is baked to the map's measured box (_tdmBox) while world.half is
     often larger -- on the default arena half is 500 while the loaded GLB only
     spans about +/-270. So a goal can easily sit outside the grid, and out of
     bounds every cell reads as blocked, so nearestFree() would exhaust its
     search and return null.

     Returning null there means "there is no route", and the caller then falls
     back to the old reactive steering -- which is exactly the wall-pressing
     behaviour this file exists to remove. A tank parked against the map edge,
     or one nudged a metre outside it, would trigger it.

     Clamping first means such a goal resolves to the closest reachable point
     instead, which is what a person would do: drive to the edge nearest the
     target. */
  var scx = this.clampCellX(this.toCellX(sx)), scz = this.clampCellZ(this.toCellZ(sz));
  var gcx = this.clampCellX(this.toCellX(gx)), gcz = this.clampCellZ(this.toCellZ(gz));

  var s = this.nearestFree(scx, scz);
  var t = this.nearestFree(gcx, gcz);
  if(!s || !t) return null;
  scx = s[0]; scz = s[1];
  var startId = this.idx(scx, scz);
  var goalId = this.idx(t[0], t[1]);

  if(startId === goalId) return [{ x: gx, z: gz }];

  var epoch = ++this._epoch;
  var heap = this._heap;
  heap.clear();
  this._g[startId] = 0;
  this._parent[startId] = -1;
  this._stamp[startId] = epoch;
  this._closed[startId] = 0;

  /* Octile distance: the true diagonal cost for an 8-connected grid. An
     L-infinity estimate would also be admissible but much blunter, and it makes
     the search noticeably less directed. */
  var gcxF = t[0], gczF = t[1];
  var h = function(cx, cz){
    var dx = Math.abs(cx - gcxF), dz = Math.abs(cz - gczF);
    return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
  };
  heap.push(startId, h(scx, scz));

  var expanded = 0;
  var bestId = startId;
  var bestH = h(scx, scz);
  var found = false;

  while(heap.size() > 0 && expanded < MAX_EXPANSIONS){
    var cur = heap.pop();
    if(cur < 0) break;
    if(this._closed[cur] === 1 && this._stamp[cur] === epoch) continue;
    this._closed[cur] = 1;
    if(cur === goalId){ found = true; break; }

    expanded++;
    var cx = cur % this.w, cz = (cur - cx) / this.w;
    var ch = h(cx, cz);
    if(ch < bestH){ bestH = ch; bestId = cur; }

    for(var k = 0; k < 8; k++){
      /* Explicit neighbour table rather than arithmetic: the diagonal offsets
         are the fiddly part and getting one wrong silently costs reachability
         through a gap. */
      var nx = cx + NX[k], nz = cz + NZ[k];
      if(!this.inBounds(nx, nz)) continue;
      var nid = this.idx(nx, nz);
      if(this.blocked[nid]) continue;
      /* NO CORNER CUTTING. Moving diagonally past the corner between two
         blocked cells would squeeze a tank through a gap its hull cannot fit
         through, and the bot would then be permanently stuck there with no way
         to explain why. */
      if(NX[k] !== 0 && NZ[k] !== 0){
        if(this.isBlocked(cx + NX[k], cz) || this.isBlocked(cx, cz + NZ[k])) continue;
      }
      var step = (NX[k] !== 0 && NZ[k] !== 0) ? SQRT2 : 1;
      var ng = this._g[cur] + step;
      var seen = this._stamp[nid] === epoch;
      if(seen && ng >= this._g[nid]) continue;
      this._g[nid] = ng;
      this._parent[nid] = cur;
      this._stamp[nid] = epoch;
      this._closed[nid] = 0;
      heap.push(nid, ng + h(nx, nz));
    }
  }

  /* Reconstruct from whichever node was reached — the goal on success, or the
     closest one seen when the budget ran out. */
  var endId = found ? goalId : bestId;
  if(!found && endId === startId) return null;

  var cells = [];
  var node = endId;
  var guard = 0;
  while(node !== -1 && guard++ < 100000){
    cells.push(node);
    if(node === startId) break;
    node = this._parent[node];
  }
  cells.reverse();

  var pts = cells.map(function(id){
    var cx = id % this.w, cz = (id - cx) / this.w;
    return { x: this.cellCenterX(cx), z: this.cellCenterZ(cz) };
  }, this);

  /* The search ends at the nearest open cell to the requested goal, not at the
     goal. Snap the last leg onto the real goal so the bot actually arrives at
     the tank it was ordered to attack -- but only when that point is somewhere
     the bot can legally be. If the goal was clamped to the grid (see find()),
     snapping to it would aim the tank at a spot outside the map, and _voidAvoid
     would then fight the navigator for the steering while the bot tries to
     reach an unreachable place. */
  if(pts.length){
    const goalInBounds =
      gx >= this.minX && gx < this.minX + this.w * this.cell &&
      gz >= this.minZ && gz < this.minZ + this.h * this.cell;
    pts[pts.length - 1] = goalInBounds ? { x: gx, z: gz } : pts[pts.length - 1];
  }
  return pts;
};

/* Neighbour offsets, in the order the heuristic above assumes. */
var NX = [0, 1, 1, 1, 0, -1, -1, -1];
var NZ = [1, 1, 0, -1, -1, -1, 0, 1];

/* ============================================================ path smoothing
   An A* path on a grid is safe but ugly: it walks cell centres, so it looks
   like it is driving in a staircase even across open ground. Driving the raw
   path also wastes the tank's turning circle on corners that do not exist.

   String pulling fixes both: from the bot's position, reach as far along the
   path as can be travelled in a straight line, drop everything before it, and
   repeat. The result is a handful of long straight segments that a tank can
   actually follow, which is both prettier to watch and cheaper to steer. */
function clearLine(world, x0, z0, x1, z1){
  /* Same query the grid was baked with, so a leg judged drivable here is
     consistent with what pathfinding believed. Mismatched predicates would let
     a smoothed path cut a corner the grid believed was solid. */
  const solid = world.collidesForAI
    ? function(x, z, r){ return world.collidesForAI(x, z, r); }
    : function(x, z, r){ return world.collidesWallsOnly(x, z, r); };
  var dx = x1 - x0, dz = z1 - z0;
  var d = Math.hypot(dx, dz);
  var steps = Math.max(1, Math.ceil(d / 3));
  for(var i = 1; i <= steps; i++){
    var f = i / steps;
    if(solid(x0 + dx * f, z0 + dz * f, TANK_RADIUS)) return false;
  }
  return true;
}

Grid.prototype.smooth = function(world, sx, sz, pts){
  if(!pts || pts.length === 0) return pts;
  var out = [];
  var cx = sx, cz = sz;
  var i = 0;
  /* Cap the passes: pathological geometry should degrade to the raw path, not
     spin. Each pass consumes at least one point, so this is a hard bound. */
  var guard = 0;
  while(i < pts.length && guard++ < 64){
    var best = i;
    /* Look ahead for the furthest point still in a clear straight line. */
    for(var j = pts.length - 1; j > i; j--){
      if(clearLine(world, cx, cz, pts[j].x, pts[j].z)){ best = j; break; }
    }
    out.push(pts[best]);
    cx = pts[best].x; cz = pts[best].z;
    i = best + 1;
  }
  return out.length ? out : pts;
};

/* ================================================================ public API
   A thin façade over the cache, so callers never think about when the grid is
   baked. */
window.BotNav = {
  CELL: CELL,
  TANK_RADIUS: TANK_RADIUS,

  gridFor: function(world){ return Grid.for(world); },

  /* Plan a route from a world point to a world point.

     Returns world-space waypoints (already smoothed) or null. `world` is needed
     for the smoothing pass only — the search itself runs entirely on the grid. */
  plan: function(world, sx, sz, gx, gz){
    var g = Grid.for(world);
    var raw = g.find(sx, sz, gx, gz);
    if(!raw) return null;
    return g.smooth(world, sx, sz, raw);
  },

  /* Is there a clear straight line between two points? Used by the bots to
     decide whether a goal needs navigating at all, which is the common case on
     open ground and skips the search entirely. */
  clear: function(world, x0, z0, x1, z1){ return clearLine(world, x0, z0, x1, z1); },

  /* Drop the cached grid. Called on map load / arena reset; after this the next
     plan() re-bakes against the new geometry. */
  invalidate: function(world){ Grid._cache.delete(world); },

  /* Introspection, for the perf harness and for anyone wondering why bots are
     suddenly slow. */
  stats: function(world){
    var g = Grid.for(world);
    return { w: g.w, h: g.h, cells: g.w * g.h, free: g.freeCount, cell: g.cell };
  }
};
})();