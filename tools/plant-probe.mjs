/* plant-probe.mjs — classifies the plant nodes in a GLB as FLAT CUTOUT
   (billboard quads: ~2 tris per facing, no depth) or REAL 3D (real shrubs:
   hundreds of tris, substantial Y/Z extent). Usage:
     node tools/plant-probe.mjs <path-to-glb>
*/
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const file = process.argv[2];
if(!file){ console.error('usage: node plant-probe.mjs <glb>'); process.exit(1); }
const bin = readFileSync(file);
const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
if(dv.getUint32(0, true) !== 0x46546C67){ console.error('not glb'); process.exit(1); }
const jsonLen = dv.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bin.buffer, bin.byteOffset + 20, jsonLen)));

const meshes = json.meshes || [];
const nodesById = new Map((json.nodes || []).map((n, i) => [i, n]));

function meshStats(meshName){
  const m = meshes.find(x => x.name === meshName);
  if(!m) return null;
  let tris = 0, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for(const prim of (m.primitives || [])){
    const acc = json.accessors[prim.attributes.POSITION];
    tris += (prim.mode === undefined || prim.mode === 4)
      ? (acc.count / 3) | 0 : (prim.mode === 5 ? ((acc.count - 2) | 0) : 0);
    if(acc.min){ yMin = Math.min(yMin, acc.min[1]); yMax = Math.max(yMax, acc.max[1]); }
    if(acc.min){ zMin = Math.min(zMin, acc.min[2]); zMax = Math.max(zMax, acc.max[2]); }
  }
  return { tris, y: (yMax - yMin).toFixed(3), z: (zMax - zMin).toFixed(3) };
}

/* Group: plant node name base -> mesh stats + the node's world-ish scale */
const seen = new Map();
for(const [i, n] of nodesById){
  if(!n.name) continue;
  const lower = n.name.toLowerCase();
  if(!(/bush|taiga|pine|tree/.test(lower))) continue;
  const base = n.name.replace(/\.\d+$/, '').replace(/\s*\d+$/, '');
  if(!seen.has(base)) seen.set(base, []);
  let meshName = null;
  if(n.mesh !== undefined) meshName = meshes[n.mesh].name;
  seen.get(base).push({ node: n.name, scale: n.scale, mesh: meshName });
}

console.log('FILE: ' + basename(file));
for(const [base, list] of seen){
  for(const it of list.slice(0, 3)){
    const st = it.mesh ? meshStats(it.mesh) : null;
    console.log(
      base.padEnd(22),
      'node=' + (it.node || '').padEnd(14),
      'scale=' + JSON.stringify(it.scale || null).padEnd(24),
      st ? ('mesh=' + st.tris + 'tris Y=' + st.y + ' Z=' + st.z) : 'no-mesh'
    );
  }
}
