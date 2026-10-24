/* List top-level node names in a GLB. Used to answer "does this map have a
   void plane, and which maps do". Prints names only, never binary. */
const fs = require('fs');
const b = fs.readFileSync(process.argv[2]);
const len = b.readUInt32LE(8);
let off = 12, json = null;
while (off < len) {
  const c = b.readUInt32LE(off), t = b.readUInt32LE(off + 4).toString(16);
  if (t === '4e4f534a') json = JSON.parse(b.slice(off + 8, off + 8 + c).toString('utf8'));
  off += 8 + c + ((4 - (c % 4)) % 4);
}
const names = (json.nodes || []).map((n, i) => ({ name: n.name || ('node' + i), mesh: n.mesh !== undefined }));
const voids = names.filter(n => /void/i.test(n.name));
console.log('  total nodes : ' + names.length);
console.log('  void nodes  : ' + (voids.length ? voids.map(v => v.name + (v.mesh ? '[mesh]' : '[empty]')).join(', ') : 'NONE'));
/* Also list the distinct mesh names, which is where Blender puts the real
   object identity once nodes have been split by material. */
const mn = [...new Set((json.meshes || []).map((m, i) => m.name || ('mesh' + i)))];
const mv = mn.filter(n => /void/i.test(n));
console.log('  void meshes : ' + (mv.length ? mv.join(', ') : 'NONE'));
console.log('  meshes      : ' + mn.length);