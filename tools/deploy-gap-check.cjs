#!/usr/bin/env node
/* deploy-gap-check.cjs — catch deploy-breaking tree drift before it ships.
 *
 * Reads 2026-10-20. When `wrangler pages deploy` runs from the project
 * ROOT, every file the game needs must exist in the ROOT tree. In the
 * Oct 20 incident the root tree was missing 75 files that existed only in
 * cf-dist (all map/tank/vfx .glb assets, vendor/three/three.module.js
 * + three.core.js, draco decoders, sounds, icons). The game froze
 * everyone at "Initializing..." because the boot module's import of
 * ./vendor/three/three.module.js was answered by the SPA fallback index.
 *
 * Usage: node tools/deploy-gap-check.cjs
 * Exit 0 = root is a superset of the cf-dist file list.
 * Exit 1 = gaps found (also printed as a copy-candidate list).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CFDIST = path.join(ROOT, 'cf-dist');

function walk(dir, prefix, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { console.error('walk failed on ' + dir + ': ' + e.message); process.exit(1); }
  for (const ent of entries) {
    const rel = prefix ? prefix + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(path.join(dir, ent.name), rel, out);
    else out.push(rel);
  }
  return out;
}

const cfFiles = walk(CFDIST, '', []);
const missing = cfFiles.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));

if (missing.length === 0) {
  console.log('deploy-gap-check: OK — root tree contains every cf-dist file (' + cfFiles.length + ' files checked)');
  process.exit(0);
}

console.error('deploy-gap-check: FAIL — ' + missing.length + ' file(s) exist in cf-dist but are MISSING in root:');
for (const rel of missing) console.error('  ' + rel);
console.error('\nCopy them into the project root before any `pages deploy` (a root that');
console.error('lacks game assets/vendor files freezes every player at "Initializing...").');
process.exit(1);
