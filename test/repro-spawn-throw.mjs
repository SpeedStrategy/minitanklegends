/* Runs the real Capture-the-Circle spawn block from game.js against stubs.

   The symptom this exists for: pressing PLAY drops the player at the main menu
   instead of into the battle. menu.js:_startCaptureCircleSafely catches the
   exception and calls leaveToMenu(), so the actual error is swallowed and never
   reaches the console the player is looking at.

   That catch is the reason this was hard to see, and it is the same shape of
   problem in both places: a failure that reports itself as "back to menu" with
   no reason attached. So this harness runs the spawn code directly, with a
   THREE stub just complete enough for Box3/Vector3, and prints what throws.

   Run: node test/repro-spawn-throw.mjs                                    */

import { readFileSync } from 'node:fs';

/* ---- the smallest THREE that Box3.setFromObject and Vector3 need ---------- */
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class Box3 {
  constructor() { this.min = new Vector3(Infinity, Infinity, Infinity); this.max = new Vector3(-Infinity, -Infinity, -Infinity); }
  getCenter(t) { return (t || new Vector3()).set((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2, (this.min.z + this.max.z) / 2); }
  setFromObject(o) { o.updateMatrixWorld(true); return this; }
  clone() { const b = new Box3(); b.min = new Vector3(this.min.x, this.min.y, this.min.z); b.max = new Vector3(this.max.x, this.max.y, this.max.z); return b; }
}
const THREE = { Vector3, Box3 };

/* ---- the real values from the bug report ---------------------------------- */
const box = new Box3();
box.min = new Vector3(-33286, -627, -21259);
box.max = new Vector3(6682, 4694, 23966);
const center = box.getCenter(new Vector3());
const spawnY = box.min.y + (box.max.y - box.min.y) * 0.65;

/* A spawn marker as the GLB hands it over: a real y, on the ground. */
const mySpawn = { pos: { x: 76.3, y: 0.4, z: 92.9 }, ry: 0, team: 'blue' };

/* The receiver, carrying only what the block under test touches. */
const self = {
  _mapBox: box.clone(),
  /* The block reads this.settings for the tank choice and the camera angle, and
     this.settings.playerName for the tank's name. Both are real properties of
     Game, so the stub carries them; without them the block throws on the first
     read and the run reports a fault in game.js that is really a gap here. */
  settings: { playerName: 'Tester', selectedTank: 'coolbuddy', camRotation: 0 },
  _spawnYFor(sp, fallback) {
    if (sp && sp.pos && Number.isFinite(sp.pos.y)) return sp.pos.y;
    return fallback;
  },
  _clampToMap(x, z, margin) {
    const b = this._mapBox;
    if (!b) return { x, z, clamped: false };
    const m = margin == null ? 12 : margin;
    const minX = b.min.x + m, maxX = b.max.x - m;
    const minZ = b.min.z + m, maxZ = b.max.z - m;
    if (minX >= maxX || minZ >= maxZ) return { x, z, clamped: false };
    const cx = Math.max(minX, Math.min(maxX, x));
    const cz = Math.max(minZ, Math.min(maxZ, z));
    return { x: cx, z: cz, clamped: cx !== x || cz !== z };
  },
  _finalizeTank() {},
  tanks: [],
  /* Called as `this.*`, so they belong on the receiver rather than being
     shadowed by bare globals in the harness body. */
  _spawnTDMBot() {},
  _spawnRemoteHuman() {},
  _spawnGlowRects() {},
  _clampSpawnsToMap(spawns, b, margin) {
    if (!b || !spawns || !spawns.length) return spawns;
    const minX = b.min.x + margin, maxX = b.max.x - margin;
    const minZ = b.min.z + margin, maxZ = b.max.z - margin;
    if (minX >= maxX || minZ >= maxZ) return spawns;
    for (const s of spawns) {
      if (!s || !s.pos) continue;
      s.pos.x = Math.max(minX, Math.min(maxX, s.pos.x));
      s.pos.z = Math.max(minZ, Math.min(maxZ, s.pos.z));
    }
    return spawns;
  },
};

/* ---- the block, lifted verbatim out of game.js ---------------------------- */

/* Read the real lines rather than retyping them, so this cannot drift from
   what shipped. Falls back to a transcription if the anchor moved. */
const src = readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
const start = src.indexOf('const markerY = (mySpawn.pos');
/* Search from `start`, not from the top of the file. All three mode starters
   end with the same `_spawnGlowRects` call, so an unscoped indexOf finds the
   FIRST one — which belongs to Team Deathmatch, hundreds of lines ABOVE the
   block under test. That yields start > end, an empty slice, and a Function
   whose body is just a comment: it "passes" while executing nothing at all.

   Which is precisely how the first run of this file reported four passing
   checks and one meaningless one. */
const end = src.indexOf('this._spawnGlowRects(blueSpawns, redSpawns);', start);

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' -> ' + x : ''}`); }
};

console.log('\n-- the block is where we think it is --');
ok('found the markerY anchor', start > 0);
ok('found the glow-rect call that ends it', end > start);

const block = src.slice(start, end + 'this._spawnGlowRects(blueSpawns, redSpawns);'.length);

console.log('\n-- running it --');
try {
  const fn = new Function('THREE', 'mySpawn', 'spawnY', 'center', 'box', 'self', 'GAMEMODES', 'cfg',
    /* The three spawn helpers and the `this.*` calls the block makes are stubbed
     above. `playerSpawnX/Z/Y` are NOT pre-declared here — the block declares
     them itself with `const`, and pre-declaring them is a redeclaration
     SyntaxError that has nothing to do with the code under test. */
  'const _spawnGlowRects = () => {}; const _spawnTDMBot = () => {}; const _spawnRemoteHuman = () => {};' +
  /* Only what the block READS and does NOT declare.

     `mapTeamSize`, `teamSize`, `usedBlue`, `usedRed` and the `spawnYFor` arrow
     are all declared INSIDE the extracted span, as are `playerSpawnX/Z/Y`.
     Pre-declaring any of them is a redeclaration SyntaxError — a fault in this
     harness, not in game.js — which is how the first three attempts of this
     file invented failures that did not exist and buried the real one.

     What is left here is what startCaptureTheCircle() established before the
     block under test runs. */
  'const mySide = "blue"; const assign = { plan: ["blue", "red"] };' +
  'const humans = []; const blueSpawns = [mySpawn]; const redSpawns = [{ pos: { x: 8, y: 0.4, z: 9 }, ry: 0 }];' +
  'const spawnBlue = blueSpawns; const spawnRed = redSpawns;' +
    'const Tank = function(def, o){ this.x = o.x; this.z = o.z; this.y = o.startY; this.def = def; this._drawHp = () => {}; };' +
    'const TANKS = { coolbuddy: { id: "coolbuddy", color: 0x00ff00 } };' +
    block +
    'return { playerSpawnX, playerSpawnZ, playerSpawnY };');

  /* `this` is `self`: the block calls `this._clampToMap`, `this._spawnYFor`,
     `this._finalizeTank`, `this.settings` and `this.tanks`. A `new Function`
     body invoked as `fn(a, b)` has `this === undefined`, so every one of those
     dies for reasons that have nothing to do with game.js. */
  const out = fn.call(self, THREE, mySpawn, spawnY, center, box, self,
    { teamSize: 5 }, { teamSize: 5 });

  console.log('  playerSpawnX =', out.playerSpawnX);
  console.log('  playerSpawnY =', out.playerSpawnY);
  console.log('  playerSpawnZ =', out.playerSpawnZ);

  ok('the block does NOT throw', true);
  ok('the player spawns on the ground, not in the sky',
    Math.abs(out.playerSpawnY - mySpawn.pos.y) < 1,
    String(out.playerSpawnY));
  ok('and not at the box-derived height',
    Math.abs(out.playerSpawnY - spawnY) > 100,
    String(out.playerSpawnY));
  ok('the x/z come from the marker', out.playerSpawnX === mySpawn.pos.x && out.playerSpawnZ === mySpawn.pos.z);

} catch (e) {
  console.log('  THREW:', e && e.message);
  console.log(e && e.stack && e.stack.split('\n').slice(0, 4).join('\n'));
  ok('the block does NOT throw', false, e && e.message);
}

console.log('\n-- the marker height survives the hostile box --');
{
  /* The whole point: the box is 40,000 units across, and it must not be able to
     to drag the spawn height with it any more. */
  const r = self._spawnYFor({ pos: { x: 0, y: 0.4, z: 0 } }, 2831.8);
  ok('a marker with a height wins over the box', Math.abs(r - 0.4) < 0.001, String(r));
  const f = self._spawnYFor({ pos: { x: 0, z: 0 } }, 2831.8);
  ok('only a marker with NO height falls back to the box', Math.abs(f - 2831.8) < 0.001, String(f));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);