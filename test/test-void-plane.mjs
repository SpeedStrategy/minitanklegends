/* ============================================================================
   test-void-plane.mjs — a `void` node is a kill volume, not scenery

   WHY THIS EXISTS
   ---------------
   The `void` plane in the authored map is invisible, carries no collider, and
   kills anything that touches it. Getting any one of those three wrong is
   silent:

     * drawn  -> a dark sheet lying across the map
     * solid  -> a wall you are stopped by instead of dying to
     * never read -> the plane does nothing at all and the map has a hole in
                    its rules that nobody notices until someone falls through it

   The third is the one this guards hardest, because the plane was in the .blend
   from the start, was dropped on the first export as "just a Blender helper",
   and came back with no engine-side behaviour attached to it whatsoever.
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
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const world = code(read('js/world.js'));
const game  = code(read('js/game.js'));

console.log('\nworld.js -- the plane is recognised, hidden, and never solid');
{
  ok('a node named void is matched',
    /\^void\[\.\\d\]\*\$/.test(world));
  ok('it is not rendered at all',
    /o\.visible = false/.test(world) && /c\.visible = false/.test(world),
    'a transparent material is still submitted and still writes depth');
  ok('it is excluded from physics',
    /c\.userData\.noPhysics = true/.test(world));
  ok('its world bounds are recorded for the kill test',
    /this\._void = \{/.test(world) && /minX: vb\.min\.x, maxX: vb\.max\.x/.test(world));
  ok('bounds come from the scaled mesh, not the authored numbers',
    /new THREE\.Box3\(\)\.setFromObject\(o\)/.test(world));
  ok('it is cleared when a map is torn down',
    (world.match(/this\._void = null;/g) || []).length >= 2,
    'both at load and at teardown, or the next battle inherits the last map\'s kill plane');
  ok('the clear is not inside the flag branch',
    !/if\(!this\._glbFlags\) this\._glbFlags = \[\];\s*\n\s*this\._void = null;/.test(world),
    'a replace-all once put the reset inside the flag push, which wiped the ' +
    'void on every flag the parser found');
}

console.log('\ngame.js -- touching it kills, in every mode');
{
  ok('the kill reads the plane the world recorded',
    /this\.world && this\.world\._void/.test(game));
  ok('death needs the footprint AND the height',
    /insideXZ && t\.y <= v\.topY/.test(game),
    'footprint alone kills a tank driving over the ground under the plane; ' +
    'height alone kills every tank on a map whose floor is below it');
  ok('it runs outside TDM',
    /if\(v \|\| \(this\._tdmState && this\._tdmState\.roundActive\)\)/.test(game),
    'the square-boundary kill was TDM-only, so the plane would have been inert ' +
    'on Capture the Circle -- the one mode this map is built for');
  ok('the square boundary still works on maps with no plane',
    /Math\.abs\(t\.x\) > half \|\| Math\.abs\(t\.z\) > half/.test(game));
  ok('contact costs the tank all its hit points',
    /t\.takeDamage\(t\.hp, null, null\)/.test(game));
  ok('the player is told why',
    /You fell into the void!/.test(game));
  ok('there is a little slack so a clipped hull counts as contact',
    /t\.y <= v\.topY \+ 1\.5/.test(game),
    'the test is on the tank centre, which has width');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);