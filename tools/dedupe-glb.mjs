/* dedupe-glb.mjs — rewrites a flattened .glb so identical content is stored once.

   Some .glb exports (this map's original, for one) duplicate the same vertex
   bytes into nineteen separate bufferViews, one per instanced tree, so the
   engine's foliage batching — which keys on vertex bytes AND on geometries
   being the SAME BufferGeometry object after GLTFLoader dedupes by mesh index —
   sees nineteen "different" meshes and cannot merge anything shared. This tool
   canonicalises two layers of that duplication:

     1. ACCESSORS: every accessor whose decoded bytes are identical is re-pointed
        at the first such accessor's (bufferView, byteOffset). BIN is untouched:
        unreferenced bufferViews are legal glTF.
     2. MESHES: every mesh whose primitives' (canonical accessor set, mode,
        material) matches another is re-pointed from every node that references
        it. Shared mesh index is what makes GLTFLoader hand every node the same
        BufferGeometry — the thing the engine's batching needs.

   Sparse accessors are rejected: their data cannot be canonicalised by hashing
   the base buffer alone, and no Blender path produces them here anyway.

   USAGE:  node tools/dedupe-glb.mjs "path/to/file.glb" [--out result.glb]
   A .orig.glb backup is written beside the file on first in-place run. */

import fs from 'fs';
import crypto from 'crypto';

const file = process.argv[2];
const outArg = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
if(!file){ console.error('usage: node dedupe-glb.mjs <file.glb> [--out result.glb]'); process.exit(1); }

const buf = fs.readFileSync(file);
if(buf.readUInt32LE(0) !== 0x46546C67){ console.error('not a GLB'); process.exit(1); }
let pos = 12, j = null, bin = null;
const total = buf.readUInt32LE(8);
while(pos < total){
  const c = buf.readUInt32LE(pos), ty = buf.readUInt32LE(pos + 4);
  if(ty === 0x4E4F534A) j = JSON.parse(buf.slice(pos + 8, pos + 8 + c).toString());
  else if(ty === 0x004E4942) bin = buf.slice(pos + 8, pos + 8 + c);
  pos += 8 + c;
}
if(!j || !bin){ console.error('missing json/bin chunk'); process.exit(1); }

const TYPES = {5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
const NCOMP = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};

function viewSlice(view){
  return bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
}
function accessorKey(a){
  if(a.sparse){ throw new Error('sparse accessor (index ' + j.accessors.indexOf(a) + ') — not supported by this tool'); }
  const view = j.bufferViews[a.bufferView];
  const itemSize = NCOMP[a.type] * TYPES[a.componentType];
  const stride = view.byteStride || itemSize;
  const data = viewSlice(view);
  const h = crypto.createHash('sha1');
  for(let i = 0; i < a.count; i++){
    h.update(data.subarray((a.byteOffset || 0) + i * stride, (a.byteOffset || 0) + i * stride + itemSize));
  }
  return [a.componentType, a.type, a.count, stride, h.digest('hex')].join(':');
}

/* --- pass 1: canonicalise accessors -------------------------------------- */
const accByKey = new Map();
let accMerged = 0;
for(let i = 0; i < j.accessors.length; i++){
  const a = j.accessors[i];
  const k = accessorKey(a);
  if(accByKey.has(k)){
    const canon = accByKey.get(k);
    a.bufferView = canon.bufferView;
    a.byteOffset = canon.byteOffset || 0;
    accMerged++;
  } else accByKey.set(k, a);
}

/* --- pass 2: canonicalise meshes (by canonical accessor set + material) -- */
const canonAccIndex = new Array(j.accessors.length);
{
  const byKey2 = new Map();
  for(let i = 0; i < j.accessors.length; i++){
    const k = accessorKey(j.accessors[i]);
    if(byKey2.has(k)) canonAccIndex[i] = byKey2.get(k);
    else { byKey2.set(k, i); canonAccIndex[i] = i; }
  }
}
function meshKey(mesh){
  return mesh.primitives.map(p => JSON.stringify({
    attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, canonAccIndex[v]])),
    idx: p.indices != null ? canonAccIndex[p.indices] : -1,
    mode: p.mode != null ? p.mode : 4,
    mat: p.material != null ? p.material : -1,
    targets: p.targets ? true : false
  })).join('||');
}
const meshByKey = new Map();
const meshCanonOf = new Map();
let meshMerged = 0;
for(let i = 0; i < j.meshes.length; i++){
  const k = meshKey(j.meshes[i]);
  if(meshByKey.has(k)){ meshCanonOf.set(i, meshByKey.get(k)); meshMerged++; }
  else meshByKey.set(k, i);
}

/* --- pass 3: re-point every node at its canonical mesh ------------------- */
let nodesRepointed = 0;
for(const n of j.nodes){
  if(n.mesh != null && meshCanonOf.has(n.mesh)){
    n.mesh = meshCanonOf.get(n.mesh);
    nodesRepointed++;
  }
}

/* --- write GLB back out -------------------------------------------------- */
const jsonText = JSON.stringify(j);
const jsonPad = (4 - (jsonText.length % 4)) % 4;
const jsonChunk = Buffer.from(jsonText + ' '.repeat(jsonPad), 'utf8');
const binPad = (4 - (bin.length % 4)) % 4;
const binChunk = bin.length + binPad === bin.length ? bin : Buffer.concat([bin, Buffer.alloc(binPad)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546C67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const c1 = Buffer.alloc(8); c1.writeUInt32LE(jsonChunk.length, 0); c1.writeUInt32LE(0x4E4F534A, 4);
const c2 = Buffer.alloc(8); c2.writeUInt32LE(binChunk.length, 0); c2.writeUInt32LE(0x004E4942, 4);

const outFile = outArg || file;
if(!outArg && !fs.existsSync(file + '.orig.glb')) fs.copyFileSync(file, file + '.orig.glb');
fs.writeFileSync(outFile, Buffer.concat([header, c1, jsonChunk, c2, binChunk]));
console.log('accessors merged:', accMerged, '/', j.accessors.length,
  '| meshes merged:', meshMerged, '/', j.meshes.length,
  '| nodes re-pointed:', nodesRepointed,
  '| out:', outFile, (fs.statSync(outFile).size / 1e6).toFixed(1) + 'MB');
