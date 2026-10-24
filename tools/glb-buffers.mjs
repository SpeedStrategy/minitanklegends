/* glb-buffers.mjs — counts distinct POSITION buffers per foliage kind in a .glb.
   Tells whether instances were flattened into unique meshes on export (which
   defeats byte-identity batching) or kept identical (batchable). */
import fs from 'fs';

const buf = fs.readFileSync(process.argv[2]);
let pos = 12, j = null;
const total = buf.readUInt32LE(8);
while(pos < total){
  const c = buf.readUInt32LE(pos), ty = buf.readUInt32LE(pos + 4);
  if(ty === 0x4E4F534A) j = JSON.parse(buf.slice(pos + 8, pos + 8 + c).toString());
  pos += 8 + c;
}
const key = (acc) => {
  const bv = j.bufferViews[acc.bufferView];
  return [acc.componentType, acc.type, acc.count, bv.byteOffset, bv.byteLength, bv.byteStride || 0].join(':');
};
const byKind = { taiga: new Set(), pine: new Set(), bush: new Set() };
const seen = new Map();
for(const n of j.nodes){
  const l = (n.name || '').toLowerCase();
  for(const k of Object.keys(byKind)){
    if(l.startsWith(k) && n.mesh != null){
      for(const pr of j.meshes[n.mesh].primitives){
        const kk = key(j.accessors[pr.attributes.POSITION]);
        byKind[k].add(kk);
        seen.set(kk, (seen.get(kk) || 0) + 1);
      }
    }
  }
}
for(const k of Object.keys(byKind)) console.log(k, 'distinct POSITION buffers:', byKind[k].size);
console.log('images:', (j.images || []).length, 'textures:', (j.textures || []).length, 'materials:', (j.materials || []).length);
