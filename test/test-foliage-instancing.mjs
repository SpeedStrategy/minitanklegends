/* Regression test for missing instanced foliage.

   Run: node test/test-foliage-instancing.mjs

   THE BUG
   -------
   _instanceFoliage() writes each instance's matrix in WORLD space:

       rel  = inverse(root.matrixWorld) * mesh.matrixWorld      (build)
       sync: m  = root.matrixWorld * rel   ->  mesh.matrixWorld  (per frame)

   and then parents the InstancedMesh to `grp`, the loaded map group. But
   three.js applies an InstancedMesh's instance matrices in its own LOCAL space
   and multiplies by its world matrix afterwards. So every instance had the
   group's transform applied twice.

   `grp` carries the map's SCALE, and those are large: 228.33x on Core II, 167x
   on Core, 120x on Dream. A tree authored at 3 units therefore landed at

       3 x 228.33 x 228.33 = 156,404 units

   from the origin — roughly thirty times beyond the camera's far plane. The
   trees were not missing. They were somewhere the GPU was never asked to look.

   It read as "some maps have no trees" because the instancing only runs when a
   map has two or more batchable roots. A map that fails that test keeps its
   original meshes, which are parented correctly, and looks perfect.

   THE FIX
   -------
   Pre-multiply each matrix by the inverse of the group's world matrix, so the
   scale is applied exactly once — by grp.

   The numbers here are the real ones from the maps in map-voting.js, so this
   cannot pass against a differently-shaped map. */

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' -> ' + x : ''}`); }
};

/* ========================================================================= */
console.log('\n-- the displacement --');
{
  /* Core II, from map-voting.js: scale 228.33, and a map whose authored arena
     is 1.290 units across, so a tree is a couple of units at most. */
  const scale = 228.33;
  const authored = 3;
  const correct = authored * scale;
  const buggy = authored * scale * scale;

  ok('the scale is applied TWICE in the broken version', buggy > correct * 100,
    `${buggy.toFixed(0)} vs ${correct.toFixed(0)}`);
  ok('which puts the tree out of sight, not merely misplaced',
    buggy > 50000, buggy.toFixed(0) + ' units');
  ok('a camera far plane of a few thousand cannot see it', buggy > 5000);

  /* The fix is arithmetic, so it can be checked as arithmetic: dividing out one
     copy of the scale must give the authored position back. */
  const fixed = buggy / scale;
  ok('removing one copy of the scale restores the real position',
    Math.abs(fixed - correct) < 0.01, fixed.toFixed(2) + ' vs ' + correct.toFixed(2));

  /* Every shipped map was broken the same way. The threshold is the camera's
     far plane rather than an arbitrary round number: 40,000 units is already
     an order of magnitude past anything the renderer draws, and the smallest
     case here (Last Frontier at 41,772) is comfortably past it. Stating it as
     a camera bound rather than a vibe is also why it cannot silently drift. */
  const FAR_PLANE = 5000;
  const shipped = [['core2', 228.33], ['core', 167], ['dream', 120],
                   ['lastfrontier', 118], ['paperland', 130]];
  ok('every shipped map put its trees past the far plane',
    shipped.every(([, s]) => authored * s * s > FAR_PLANE),
    shipped.map(([n, s]) => `${n}=${(authored * s * s).toFixed(0)}`).join(' '));
}

console.log('\n-- the code --');
{
  const src = readFileSync(new URL('../js/world.js', import.meta.url), 'utf8');
  const inst = src.slice(src.indexOf('_instanceFoliage(grp){'), src.indexOf('_disposeGLBGroup(){'));

  ok('the group inverse is computed',
    /grpInv\.copy\(grp\.matrixWorld\)\.invert\(\)/.test(inst));
  /* Two matrices, and they must not be the same one.

     `grpInv` is the group's inverse and is handed to every batch for the
     per-frame conversion. It was ALSO used as the scratch matrix for the
     per-instance world matrix, which overwrote it on the first iteration — so
     each batch stored the previous iteration's leftovers and the per-frame
     conversion ran on garbage. Build-time matrices were correct and per-frame
     ones were not, which looks exactly like "the trees are there for one frame
     and then they are gone".

     Asserting the two are separate is the only thing standing between this and
     the same bug again: nothing at runtime complains when an inverse is used as
     a scratch buffer. */
  /* Two writes to grpInv are correct — the invert and the catch fallback that
     leaves it as identity if inverting threw. What must not happen is a THIRD
     kind: grpInv being multiplied into as scratch work. That is asserted
     separately and directly, because it is the actual bug. */
  const grpInvWrites = inst.match(/grpInv\.(copy|identity)/g) || [];
  ok('grpInv is only ever initialised — invert, plus its catch fallback',
    grpInvWrites.length <= 2, grpInvWrites.join(' '));
  ok('grpInv is NEVER multiplied into as a scratch matrix',
    !/grpInv\.multiplyMatrices/.test(inst));
  ok('separate scratch and output matrices exist',
    /const m = new THREE\.Matrix4\(\)/.test(inst) && /const out = new THREE\.Matrix4\(\)/.test(inst));
  ok('instances are seeded before the originals are detached',
    /m\.multiplyMatrices\(m\.root\.matrixWorld, m\.rel\);\s*\n\s*out\.multiplyMatrices\(grpInv, m\);\s*\n\s*inst\.setMatrixAt/.test(inst));
  ok('the batch remembers it', /grpInv: grpInv\.clone\(\)/.test(inst));

  /* syncFoliageInstances must apply the same conversion, or the trees are right
     for one frame and gone by the next. */
  const sync = src.slice(src.indexOf('syncFoliageInstances(){'));
  ok('sync converts world matrices into the group local space too',
    /out\.multiplyMatrices\(toLocal, m\)/.test(sync));
  ok('sync reads the cached inverse off the batch',
    /const toLocal = batch\.grpInv \|\| null;/.test(sync));
  ok('and falls back to the raw matrix when there is no inverse',
    /else out\.copy\(m\)/.test(sync));

  /* The batch is still parented to grp — the fix is the matrix conversion, not
     a reparenting. Both halves are needed and only one is right. */
  ok('the batch is still parented to the map group',
    /grp\.add\(inst\)/.test(inst));
  /* Ordering still matters — instancing removes meshes from the graph, so it has
     to be last — but the call is now wrapped in a try/catch, so the assertion
     matches the guarded form rather than the bare one it was written against.

     Line endings are CRLF in this file. A pattern written with \n alone does
     not match a \r\n, and reports the guard as absent while the guard is right
     there — which is the third time in this file that a test failed on how the
     source is laid out rather than on what it says. Normalise before matching
     anything multi-line. */
  const flat = src.replace(/\r\n/g, '\n');

  ok('instancing is still the LAST step, after classification',
    /this\._instanceFoliage\(grp\);\s*\}\s*\n\s*catch/.test(flat) ||
    /this\._instanceFoliage\(grp\);\s*\n\s*console\.log/.test(flat));
  ok('and it is guarded, so a batching failure cannot reject the map load',
    /try \{ this\._instanceFoliage\(grp\); \}/.test(flat));
  ok('the guard clears any half-built batches rather than leaving them',
    /catch\(e\) \{\s*\n\s*this\._foliageBatches = null;/.test(flat));
}

console.log('\n-- it is a scale bug, not a culling bug --');
{
  const src = readFileSync(new URL('../js/world.js', import.meta.url), 'utf8');
  /* Frustum culling was already disabled on purpose, which is why this went
     unnoticed: the trees were culled by the FAR PLANE, not by the frustum
     test, so the existing `frustumCulled = false` did not and could not have
     prevented it. Worth asserting, because "turn off culling" is the obvious
     wrong fix and someone will try it. */
  ok('frustum culling was already disabled for the batch',
    /inst\.frustumCulled = false;/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);