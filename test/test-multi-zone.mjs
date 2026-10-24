/* ============================================================================
   test-multi-zone.mjs — Capture the Circle with more than one objective

   WHY THIS EXISTS
   ---------------
   The mode was written around exactly one capture point: one flag mesh, one
   ring, one percentage pair, one win at 100%. Signal Map declares TWO flag
   nodes and the rule is "hold both or you have not won".

   The failure this guards against is not a crash. It is a match that looks
   like it is working: two rings on the ground, two flags standing, two teams
   driving between them — and a win awarded for taking one of them. Nothing
   errors, nothing logs, and the mode quietly stops meaning what it says.

   So the assertions are about the WIN CONDITION, not about the artwork.
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

const cc  = read('js/capture-circle.js');
const wd  = read('js/world.js');
const mv  = read('js/map-voting.js');
const cfg = read('js/config.js');

/* Strip block comments so a phrase quoted in an explanation cannot satisfy a
   regex that is supposed to be looking at code. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\nworld.js — collecting every flag, not just the last');
{
  const c = code(wd);
  ok('flags are appended to a list',
    /this\._glbFlags\.push\(/.test(c));
  ok('the single-object assignment is gone from the parse path',
    !/this\._glbFlag = \{ x: fp\.x/.test(c),
    'a per-node assignment would drop every flag but the last');
  ok('_glbFlag is kept as the first entry, for existing readers',
    /if\(!this\._glbFlag\) this\._glbFlag = this\._glbFlags\[0\]/.test(c));
  ok('the list is reset when a map is torn down',
    /this\._glbFlags = \[\]/.test(c));
  /* Both reset sites matter: one clears at load, one at teardown. Missing
     either means the previous battle's flags survive into the next. */
  const resets = (c.match(/this\._glbFlags = \[\]/g) || []).length;
  ok('the list is reset at BOTH load and teardown', resets >= 2, 'found ' + resets);
}

console.log('\ncapture-circle.js — one zone per flag');
{
  const c = code(cc);
  ok('zones come from the map\'s flag list',
    /w\._glbFlags/.test(c));
  ok('a map with no flags still gets the original single zone at the origin',
    /if\(!marks\.length\) return \[\{ x: 0, z: 0 \}\]/.test(c));
  ok('every flag marker becomes a zone',
    /return marks\.map\(m => \(\{ x: m\.x \|\| 0, z: m\.z \|\| 0 \}\)\)/.test(c));
  ok('each zone carries its own percentage pair',
    /state: \{ bluePercent: 0, redPercent: 0, owner: null \}/.test(c));
  ok('the capture loop walks the zones',
    /for\(const z of _zones\)/.test(c));
}

console.log('\nThe capture point is measured from the zone, not the origin');
{
  const c = code(cc);
  ok('occupancy is tested against the zone centre',
    /Math\.hypot\(t\.x - cx, t\.z - cz\)/.test(c) &&
    /const cx = z\.cx \|\| 0, cz = z\.cz \|\| 0/.test(c));
  ok('the ring is placed at its own zone',
    /_glowDisc\.position\.set\(cx, 0\.08, cz\)/.test(c) &&
    /_zonePlane\.position\.set\(cx, 0\.12, cz\)/.test(c));
  ok('the ground probe casts over the zone it is positioning',
    /new THREE\.Vector3\(p\[0\] \+ _zc\.cx, 8, p\[1\] \+ _zc\.cz\)/.test(c),
    'a raycast at the origin probes the wrong floor on every zone but the first');
  ok('the sparkle field is offset, not left stacked at the origin',
    /_sparkHome\[i \* 3 \+ 2\] = pz \+ cz/.test(c));
}

console.log('\nthe win condition — hold EVERY zone');
{
  const c = code(cc);
  ok('a zone records its owner at 100%',
    /if\(_state\.bluePercent >= 100\) _state\.owner = 'blue'/.test(c));
  ok('zones held are counted per side',
    /if\(_state\.owner === 'blue'\) blueHolds\+\+/.test(c) &&
    /else if\(_state\.owner === 'red'\) redHolds\+\+/.test(c));
  ok('the winner is the side holding EVERY zone, not one of them',
    /blueHolds === needAll/.test(c) && /redHolds === needAll/.test(c));
  ok('needAll is the zone count',
    /const needAll = _zones\.length/.test(c));
  ok('a single zone still wins the old way',
    /const needAll = _zones\.length/.test(c) && /_zones\.length > 1/.test(c));
  ok('the toast says so when there is more than one flag',
    /All flags captured!/.test(c));
}

console.log('\nownership and cleanup');
{
  const c = code(cc);
  ok('dispose tears down every zone, not just the bound one',
    /for\(const z of _zones\)\{\s*_bindZone\(z\);/.test(c),
    'otherwise zones 1..N-1 leak their meshes into the next match');
  ok('the zone list is emptied on dispose',
    /_zones = \[\];/.test(c));
  ok('getState publishes the per-zone breakdown',
    /s\.zones = _zones\.map\(/.test(c) && /s\.zoneCount = _zones\.length/.test(c));
}

console.log('\nthe flag model goes to its own zone');
{
  const c = code(cc);
  ok('the zone is captured before the async load, not read in the callback',
    /const zone\s*=\s*_boundZone;/.test(c),
    'the callback runs after every zone is built; reading _boundZone there ' +
    'gives the wrong zone and every flag ends up in the last one');
  ok('the flag is written to the zone that requested it',
    /zone\.flag = root/.test(c));
  ok('the live names are only updated for the bound zone',
    /if\(_boundZone === zone\)/.test(c));
}

console.log('\nSignal Map is registered and sized for two separated zones');
{
  const m = code(mv);
  ok('the map is in the list',
    /id: 'signalmap'/.test(m));
  ok('it points at the exported asset',
    /glb: 'assets\/maps\/TL_signal_map\.glb'/.test(m));
  const scale = Number((m.match(/id: 'signalmap'[\s\S]*?scale:\s*([\d.]+)/) || [])[1]);
  ok('the scale is 120', scale === 120, 'got ' + scale);
  /* The point of 120: the two flags are 0.686 units apart in the source, so at
     120 they land 82 units apart. With a capture radius of 12 that is 3.4
     radii of clean ground — two genuinely separate objectives. A smaller scale
     puts the rings close enough that one tank could stand in both. */
  const sep = 0.686 * scale;
  ok('the flags land far enough apart to be separate objectives',
    sep > 2 * 12, sep.toFixed(1) + ' units apart vs a 12-unit radius');
  ok('a worldHalf is declared, so the arena is not the whole terrain',
    /id: 'signalmap'[\s\S]*?worldHalf:/.test(m));
}

console.log('\ncapture time');
{
  const t = Number((cfg.match(/captureTime:\s*(\d+)/) || [])[1]);
  ok('each flag takes 25 seconds', t === 25, 'got ' + t);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);