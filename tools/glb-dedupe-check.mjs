/* glb-dedupe-check.mjs — hashes each foliage mesh's full attribute+index bytes
   and reports how many are byte-identical. If most are identical, the GLB can
   be deduped at the file level so the engine's InstancedMesh batching (which
   keys on vertex bytes) can merge them. */
import fs from 'fs';
import crypto from 'crypto';

const buf = fs.readFileSync(process.argv[2]);
let pos = 12, j = null, bin = null;
const total = buf.readUInt32LE(8);
while(pos < total){
  const c = buf.readUInt32LE(pos), ty = buf.readUInt32LE(pos + 4);
  if(ty === 0x4E4F534A) j = JSON.parse(buf.slice(pos + 8, pos + 8 + c).toString());
  else if(ty === 0x004E4942) bin = buf.slice(pos + 8, pos + 8 + c);
  pos += 8 + c;
}

function viewBytes(view){
  return bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
}
function accessorHash(a){
  const TYPES = {5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
  const NCOMP = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
  if(a.sparse) throw new Error('sparse accessor not supported');
  const view = j.bufferViews[a.bufferView];
  const stride = view.byteStride || (NCOMP[a.type] * TYPES[a.componentType]);
  const data = viewBytes(view);
  const h = crypto.createHash('sha1');
  const itemSize = NCOMP[a.type] * TYPES[a.componentType];
  for(let i = 0; i < a.count; i++){
    h.update(data.subarray((a.byteOffset || 0) + i * stride, (a.byteOffset || 0) + i * stride + itemSize));
  }
  return a.componentType + ':' + a.type + ':' + a.count + ':' + (stride) + ':' + h.digest('hex').slice(0, 16);
}

function meshSig(mesh){
  return mesh.primitives.map(p => {
    const attrs = {};
    for(const [k, v] of Object.entries(p.attributes)) attrs[k] = accessorHash(j.accessors[v]);
    const idx = p.indices != null ? accessorHash(j.accessors[p.indices]) : 'noidx';
    return JSON.stringify({attrs, idx, mode: p.mode != null ? p.mode : 4, mat: p.material});
  }).join('||');
}

const byKind = {};
const seenNodes = new Set();
for(const n of j.nodes){
  const l = (n.name || '').toLowerCase();
  const kind = Object.keys(byKind).find(k => l.startsWith(k));
  if(!kind || n.mesh == null || seenNodes.has(n.mesh)) continue;
  seenNodes.add(n.mesh);
  // one entry per node instance (not per mesh): iterate nodes again below
}
const perKind = { taiga: [], pine: [] };
for(const n of j.nodes){
  const l = (n.name || '').toLowerCase();
  const kind = l.startsWith('taiga') && n.mesh != null ? 'taiga' : (l.startsWith('pine') && n.mesh != null ? 'pine' : null);
  if(!kind) continue;
  const sig = meshSig(j.meshes[n.mesh]);
  perKind[kind].push({node: n.name, meshRef: n.mesh, sig: sig.slice(0, 60)});
}
for(const kind of Object.keys(perKind)){
  const uniq = new Set(perKind[kind].map(e => e.sig));
  console.log(kind + ': ' + perKind[kind].length + ' nodes, ' + uniq.size + ' distinct byte signatures');
}
