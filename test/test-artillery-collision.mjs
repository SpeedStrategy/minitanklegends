/* ============================================================================
   test-artillery-collision.mjs — artillery must stop at the map

   WHY THIS EXISTS
   ---------------
   Mortar shells are the one projectile in the game with no Rapier body. The
   constructor refuses them one on purpose:

       this._physWorld = this._isMortar ? null : (physicsWorld || null);

   so they never get a collision event, and _updateArtillery had to answer the
   same question itself. It answered it with two tests, and both were wrong:

     * GROUND was `if (this.y <= 0.35)` -- a hardcoded world plane. Maps are GLB
       models sitting wherever their author put them, so on any map whose floor
       is not at world y = 0 the shell descended THROUGH the terrain and burst
       underneath it.

     * WALLS were not tested at all. Direct-fire shells call
       `world.collidesWallsOnly(...)`; artillery had no equivalent, so shells
       passed through buildings that ordinary gunfire bounces off.

   Both failures are silent: the shell flies, and then it bursts in the wrong
   place (or through something solid). Nothing throws.
   ============================================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ->  ' + detail : '')); }
};

/* Comments explain the bug and quote its own code; strip them so a phrase in
   prose cannot satisfy an assertion meant to look at code. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const proj = read('js/projectile.js');
const game = read('js/game.js');
const cp   = code(proj);
const cg   = code(game);

console.log('\nartillery has no body, so the step must ask what it hit');
{
  ok('mortar shells still get no rigid body',
    /this\._physWorld = this\._isMortar \? null/.test(cp),
    'that is deliberate and unchanged -- the arc is pre-solved');
  ok('_updateArtillery casts the segment it is about to travel',
    /game\._shellSegmentHit\(this\.x, this\.y, this\.z, nx, ny, nz\)/.test(cp));
  ok('a hit bursts the shell there and stops',
    /this\._detonate\(game\);\s*\n\s*return;/.test(cp));
  ok('it bursts AT the hit point, not one sub-step past it',
    /this\.x = hit\.x; this\.y = hit\.y; this\.z = hit\.z;/.test(cp));
}

console.log('\nthe ground plane is a fallback, not the test');
{
  ok('the hardcoded plane still exists, as a last resort',
    /if\(this\.y <= 0\.35\)/.test(cp),
    'a shell with no colliders must still land somewhere');
  /* The real question is ORDER: the segment cast has to come first, otherwise
     the plane wins on every map whose floor is above y = 0.35. */
  const cast = cp.indexOf('game._shellSegmentHit');
  const plane = cp.indexOf('if(this.y <= 0.35)');
  ok('the segment cast happens BEFORE the plane',
    cast > -1 && plane > -1 && cast < plane,
    'cast at ' + cast + ', plane at ' + plane);
  ok('the integration is no longer a blind += on the position',
    !/this\.x \+= this\._vel\.x \* h;/.test(cp),
    'the step is computed first so it can be tested before it is taken');
}

console.log('\nthe cast itself');
{
  ok('a helper exists that casts a segment',
    /_shellSegmentHit\(x0, y0, z0, x1, y1, z1\)/.test(cg));
  ok('it uses Rapier against the real collider, not a THREE raycast',
    /castRayAndGetNormal|castRay/.test(cg) && /new RAPIER\.Ray/.test(cg),
    'a THREE.Raycaster would miss the physics trimesh entirely');
  ok('dynamic bodies are excluded',
    /EXCLUDE_DYNAMIC/.test(cg),
    'tanks keep their own descending-and-low test, which handles the owner ' +
    'whose hull the shell spawns inside');
  ok('it normalises the direction, so maxToi means distance',
    /Math\.sqrt\(dx\*dx \+ dy\*dy \+ dz\*dz\)/.test(cg) &&
    /x: dx\/len, y: dy\/len, z: dz\/len/.test(cg));
  ok('it survives a physics world that is missing',
    /if\(!this\.physicsWorld \|\| typeof RAPIER === 'undefined'\) return null/.test(cg) &&
    /catch\(e\)\{\s*\n\s*return null;/.test(cg));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);