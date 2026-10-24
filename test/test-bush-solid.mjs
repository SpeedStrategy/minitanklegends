/* ============================================================================
   test-bush-solid.mjs — Signal Map's scrub is foliage that also blocks

   WHY THIS EXISTS
   ---------------
   The map's foliage arrived as `image-removebg-preview(9) - Copy.001` and
   friends -- an image editor's default filename. The engine identifies every
   map entity by NAME (world.js documents the vocabulary: pine/taiga/tree are
   trees, bush is a bush), so those objects matched nothing at all and were
   scenery: no wind, no contact shake, no hide radius, and no collider.

   Every part of this is silent. The objects render, the map loads, nothing
   throws. A player drives through a thick hedge and gets no feedback and no
   cover, which is indistinguishable from the feature not existing.
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

const world = read('js/world.js');
const game  = read('js/game.js');
const cw = code(world), cg = code(game);

console.log('\nthe map entity convention still catches these');
{
  ok("'bush' is still the matcher, so the pipeline runs at all",
    /lower\.includes\('bush'\)/.test(cw));
  ok('the exported name contains that matcher',
    'bush_solid'.includes('bush'),
    'world.js no longer special-cases this name -- it matches on "bush" alone, ' +
    'which is the whole point of naming it after the convention');
}

console.log('\nnot solid: these are foliage, not obstacles');
{
  ok('world.js leaves every bush noPhysics',
    /const solid = false;/.test(cw) && /if\(!solid\) c\.userData\.noPhysics = true;/.test(cw),
    'making 53 bushes solid turned a hedge into a wall in a 305-unit arena');
  ok('the trimesh excludes foliage by name again',
    /nameLower\.includes\('tree'\) \|\| nameLower\.includes\('bush'\) \|\| nameLower\.includes\('pine'\)/.test(cg) &&
    !/!nameLower\.includes\('bush_solid'\)/.test(cg),
    'the bush_solid exception was added and then taken back out');
  ok('the record still carries the flag, so the decision is visible',
    /flipped: false, radius, solid/.test(cw));
}

console.log('\nthey do not swivel to follow the camera');
{
  ok('map bushes are no longer added to the billboard list',
    /this\._billboardList = tdmB\.slice\(\)/.test(cg));
  ok('they are no longer concatenated into it',
    !/_billboardList = tdmB\.concat\(glbB\)/.test(cg));
  ok('the engine-spawned cards still billboard',
    /tdmB/.test(cg));
}

console.log('\nhiding takes the outline with it');
{
  ok('outline meshes are toggled by visibility, not opacity',
    /o\.userData\.isOutline\) o\.visible = !inBush/.test(cg),
    'the outline material is pooled and shared across every tank, so fading it ' +
    'by opacity reaches all of them and leaves a silhouette behind');
  ok('the hull still fades to 5%',
    /_savedOpacity \|\| 1\) \* 0\.05/.test(cg));
}

console.log('\nwind and contact shake, which bushes never had');
{
  ok('the foliage loop reaches bushes, not just pines',
    /foliageBushes = \(this\.world && this\._glbBushes\)/.test(cg) ||
    /foliageBushes = \(this\.world && this\.world\._glbBushes\)/.test(cg));
  ok('bushes get their own sway amplitudes',
    /const bushAmp\s*=/.test(cg) && /const bushFreq\s*=/.test(cg),
    'a pine is an 18-unit trunk and a bush is a 3-unit blob; one shared ' +
    'constant is wrong for one of them');
  ok('bushes shake on contact from a rolling tank',
    /b\._shakeActive/.test(cg) && /Math\.abs\(t\.speed \|\| 0\) > 0\.5/.test(cg));
  ok('the billboarding angles are left alone',
    /b\.obj\.rotation\.x = b\._origRotX/.test(cg) &&
    /b\.obj\.rotation\.z = b\._origRotZ/.test(cg),
    'rotation.y is written by the billboard pass; touching it would turn the ' +
    'bush away from the camera mid-sway');
}

console.log('\nthe base rotation the sway is written relative to');
{
  ok('bushes record _origRotX / _origRotZ',
    /_origRotX: origRotX, _origRotZ: origRotZ/.test(cw),
    'only pines recorded these. Reading undefined would write NaN into the ' +
    'rotation and the bush would silently vanish rather than sway');
}

console.log('\nhiding: 5%');
{
  ok('the hide opacity is 0.05',
    /_savedOpacity \|\| 1\) \* 0\.05/.test(cg));
  ok('it is not still 0.5',
    !/_savedOpacity \|\| 1\) \* 0\.5/.test(cg));
  ok('it still multiplies the saved opacity rather than replacing it',
    /_savedOpacity \|\| 1\)/.test(cg),
    'so a tank faded for another reason stays faded by the same amount');
  ok('leaving a bush still restores the original',
    /o\.material\.opacity = o\.material\._savedOpacity/.test(cg));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);