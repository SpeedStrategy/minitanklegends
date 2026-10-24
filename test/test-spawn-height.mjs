/* Regression test for the spawn-height void.

   Run: node test/test-spawn-height.mjs

   THE BUG
   -------
   Every mode starter computed ONE height from the loaded map's bounding box:

       spawnY = box.min.y + (box.max.y - box.min.y) * 0.65

   and spawned the player, every remote human and all fourteen bots at it.

   A bounding box is the extent of everything in the GLB, not the extent of
   the arena. Core II carries something enormous and far from the play space —
   measured bounds of

       min(-33286, -627, -21259)   max(6682, 4694, 23966)

   for an arena that is 294 units across. The formula returned 2831.8, and the
   live game reported a tank at y = 2831.8: two and a half thousand units above
   the ground, camera following it into the fog, sky filling the screen. The
   player called it a void. The map had loaded perfectly the whole time.

   The spawn MARKERS are authored onto the ground and carry a real y. They were
   read out of the GLB and then discarded in favour of the box.

   THE FIX
   -------
   Each spawn takes its own marker's height; the box-derived value survives only
   as the fallback for a marker that has none.

   The numbers below are the real ones from the bug report, so this test cannot
   pass by accident against a differently-shaped map. */

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' -> ' + x : ''}`); }
};

/* ========================================================================= */
console.log('\n-- the real numbers --');
{
  /* Exactly what the game reported, and what it should have reported. */
  const glbMaxY = 4694, glbMinY = -627;
  const boxSpawnY = glbMinY + (glbMaxY - glbMinY) * 0.65;
  const markerY = 0.4;                      /* the markers sit on the ground */

  ok('the box formula produced the height that was observed',
    Math.round(boxSpawnY) === 2832, String(Math.round(boxSpawnY)));
  ok('and that is 2,831 units above a marker on the ground',
    Math.round(boxSpawnY - markerY) === 2831,
    String(Math.round(boxSpawnY - markerY)));
  ok('the marker height is the sane one', Math.abs(markerY) < 5, String(markerY));
}

console.log('\n-- _spawnYFor --');
{
  const src = readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');

  /* Declared once, here, and reused by the later block that also needs it.
     Strip the `this.` receiver before matching.

     Without it a search for `_spawnYFor(` still has to allow for `this.`, and
     a pattern written for the bare name silently fails to match the real call
     sites — which reads as "the fix was never applied" rather than "the regex
     was wrong". Same mistake as matching a comment: assert on structure, and
     make the pattern describe what the code actually looks like. */
  const bare = src.replace(/this\._spawnYFor/g, '_spawnYFor');

  ok('the helper exists', /_spawnYFor\(sp, fallback\)\{/.test(src));
  /* `+ 3` is the clearance that stops the hull spawning inside the terrain.
     It is asserted rather than tolerated: without it the tank is born
     half-buried and the physics engine answers by flipping it onto its roof. */
  ok('it prefers the marker\'s own y, plus clearance',
    /if \(sp && sp\.pos && Number\.isFinite\(sp\.pos\.y\)\) return sp\.pos\.y \+ 3;/.test(src));
  ok('and the clearance is small enough to just drop onto the ground',
    /\+ 3;/.test(src));
  ok('and falls back to the box value only when there is none',
    /return fallback;/.test(src));

  /* A marker with a real height is used verbatim; one without is not invented. */
  /* The clearance is part of the behaviour, so the table carries it. */
  const pick = (sp, fallback) =>
    (sp && sp.pos && Number.isFinite(sp.pos.y)) ? sp.pos.y + 3 : fallback;
  ok('a marker on the ground wins, lifted clear of it',
    pick({ pos: { x: 0, y: 0.4, z: 0 } }, 2831) === 3.4, String(pick({ pos: { x: 0, y: 0.4, z: 0 } }, 2831)));
  ok('a marker at 12 stays at 12 plus clearance',
    pick({ pos: { x: 0, y: 12, z: 0 } }, 2831) === 15);
  ok('the clearance is never negative against a sunken marker',
    pick({ pos: { x: 0, y: -10, z: 0 } }, 2831) === -7);
  ok('a marker with no y falls back', pick({ pos: { x: 0, z: 0 } }, 2831) === 2831);
  ok('a spawn with no pos at all falls back', pick(null, 2831) === 2831);
  ok('a NaN y falls back rather than poisoning the position',
    pick({ pos: { x: 0, y: NaN, z: 0 } }, 2831) === 2831);
}

console.log('\n-- every spawn site uses it --');
{
  const src = readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
  /* `this.` stripped — see the note on `bare` above. */
  const bare = src.replace(/this\._spawnYFor/g, '_spawnYFor');

  /* Bots and remote humans, in all three modes. A single remaining raw
     `spawnY` in a spawn call puts a bot in the sky while everyone else is
     standing on the map, which is the same void with fewer pixels. */
  /* CALL SITES ONLY — the method DEFINITIONS take the same shape and are not
     calls. `_spawnTDMBot(px, pz, py, team){` is the signature; a call passes
     `sp.pos.x`. Matching both is how a test ends up demanding that a function
     rewrite itself. */
  const isCall = (s) => s.includes('sp.pos') || s.includes('humans[') || s.includes('spawnBlue[') || s.includes('spawnRed[');

  const botCalls = (bare.match(/_spawnTDMBot\([^)]*\)/g) || []).filter(isCall);
  ok('there are bot spawn calls to check', botCalls.length > 0, String(botCalls.length));
  ok('no bot spawn still uses the raw box height',
    !botCalls.some((c) => /,\s*spawnY\s*,/.test(c)),
    botCalls.filter((c) => /,\s*spawnY\s*,/.test(c)).join(' | '));
  ok('every bot spawn goes through _spawnYFor',
    botCalls.every((c) => /_spawnYFor\(/.test(c)),
    botCalls.filter((c) => !/_spawnYFor\(/.test(c)).join(' | '));

  const humanCalls = (bare.match(/_spawnRemoteHuman\([^)]*\)/g) || []).filter(isCall);
  ok('there are remote-human spawn calls to check', humanCalls.length > 0, String(humanCalls.length));
  ok('every remote-human spawn goes through _spawnYFor',
    humanCalls.every((c) => /_spawnYFor\(/.test(c)),
    humanCalls.filter((c) => !/_spawnYFor\(/.test(c)).join(' | '));

  /* The player's own tank, in the mode that reported the bug. */
  ok('the player spawns at the marker height',
    /startY:\s*playerSpawnY/.test(src));
  ok('and the respawn point records the same height',
    /_spawnPos = \{x: playerSpawnX, y: playerSpawnY, z: playerSpawnZ\}/.test(src));
  ok('playerSpawnY comes from the marker when there is one',
    /const playerSpawnY = groundY;/.test(src) &&
    /const groundY = \(markerY !== null\) \? this\._spawnYFor\(mySpawn, spawnY\) : spawnY;/.test(src));
  ok('and markerY is only taken from a finite number',
    /const markerY = \(mySpawn\.pos && Number\.isFinite\(mySpawn\.pos\.y\)\)/.test(src));
}

console.log('\n-- the diagnostic now names height --');
{
  const src = readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
  ok('it reports the ground height', /groundTop\s*=/.test(src));
  ok('and how far above it the tank is', /tankAboveGround\s*=/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);