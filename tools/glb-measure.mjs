/* glb-measure.mjs — measures a .glb the way the game will see it.
   USAGE: node tools/glb-measure.mjs "path/to/file.glb"
   Prints:
     - the world-space AABB of ALL geometry (full node transform chain applied)
     - the same for "markers only" (blue/red/flag/spawn nodes, by the game's
       naming conventions in world.js) with their world positions
     - how many / which nodes match pine | taiga | bush | tree
   Read from accessor min/max per POSITION primitive (Blender exports write
   them), corners transformed through each node's accumulated world matrix.
   No deps, no BIN chunk needed. */

import fs from 'fs';

const file = process.argv[2];
if(!file){ console.error('usage: node glb-measure.mjs <file.glb>'); process.exit(1); }

const buf = fs.readFileSync(file);
if(buf.readUInt32LE(0) !== 0x46546C67){ console.error('not a GLB'); process.exit(1); }
const total = buf.readUInt32LE(8);
let pos = 12, json = null;
while(pos < total){
  const clen = buf.readUInt32LE(pos);
  const ctype = buf.readUInt32LE(pos + 4);
  if(ctype === 0x4E4F534A) json = JSON.parse(buf.slice(pos + 8, pos + 8 + clen).toString('utf8'));
  pos += 8 + clen;
}

/* column-major glTF */
function defaultMatrix(){ return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function eulerMatrix(t){
  const q = t.quaternion || [0,0,0,1];
  const s = t.scale || [1,1,1];
  const tr = t.translation || [0,0,0];
  return [
    (1-2*(q[1]*q[1]+q[2]*q[2]))*s[0], (2*(q[0]*q[1]+q[2]*q[3]))*s[0], (2*(q[0]*q[2]-q[1]*q[3]))*s[0], 0,
    (2*(q[0]*q[1]-q[2]*q[3]))*s[1], (1-2*(q[0]*q[0]+q[2]*q[2]))*s[1], (2*(q[1]*q[2]+q[0]*q[3]))*s[1], 0,
    (2*(q[0]*q[2]+q[1]*q[3]))*s[2], (2*(q[1]*q[2]-q[0]*q[3]))*s[2], (1-2*(q[0]*q[0]+q[1]*q[1]))*s[2], 0,
    tr[0], tr[1], tr[2], 1
  ];
}
function mul(a, b){ /* a * b (both column-major 4x4), apply b first */
  const o = new Array(16).fill(0);
  for(let c = 0; c < 4; c++)
    for(let r = 0; r < 4; r++)
      for(let k = 0; k < 4; k++)
        o[c*4+r] += a[k*4+r] * b[c*4+k];
  return o;
}
function xfm(m, x, y, z){
  return [ m[0]*x + m[4]*y + m[8]*z + m[12],
           m[1]*x + m[5]*y + m[9]*z + m[13],
           m[2]*x + m[6]*y + m[10]*z + m[14] ];
}

const world = new Map(); /* node index -> world matrix */
function computeWorld(i, parent){
  const n = json.nodes[i];
  const local = n.matrix || eulerMatrix(n);
  const w = parent ? mul(parent, local) : local;
  world.set(i, w);
  (n.children || []).forEach(c => computeWorld(c, w));
}
(json.scenes[json.scene || 0].nodes || []).forEach(i => computeWorld(i, null));

const mn = [1e30,1e30,1e30], mx = [-1e30,-1e30,-1e30];
const f = (i, r, w) => { for(let c = 0; c < 8; c++){
  const p = xfm(w, (c&1)?r.max[0]:r.min[0], (c&2)?r.max[1]:r.min[1], (c&4)?r.max[2]:r.min[2]);
  for(let a = 0; a < 3; a++) if(p[a] < mn[a]) mn[a] = p[a]; else if(p[a] > mx[a]) mx[a] = p[a];
} };
const mark = [];
const plant = [];
for(let i = 0; i < json.nodes.length; i++){
  const n = json.nodes[i];
  const lower = (n.name || '').toLowerCase();
  if(/(pine|taiga|bush|tree)/.test(lower)) plant.push({name: n.name, mesh: n.mesh != null});
  if(/^((blue|red)[._-]?)?(spawn)?/.test(lower) && /blue|red|flag|spawn/.test(lower)){
    const w = world.get(i) || defaultMatrix();
    const p = xfm(w, 0, 0, 0);
    mark.push({name: n.name || '(noname)', x: +p[0].toFixed(2), y: +p[1].toFixed(2), z: +p[2].toFixed(2)});
  }
  if(n.mesh == null) continue;
  const w = world.get(i);
  for(const prim of json.meshes[n.mesh].primitives){
    const a = prim.attributes.POSITION != null ? json.accessors[prim.attributes.POSITION] : null;
    if(!a || !a.min || !a.max) { continue; }
    f(i, {min: a.min, max: a.max}, w);
  }
}

const size = [mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]];
console.log('FILE     :', file.split(/[\\/]/).pop());
console.log('AABB min :', mn.map(v => +v.toFixed(3)).join('  '));
console.log('AABB max :', mx.map(v => +v.toFixed(3)).join('  '));
console.log('SIZE     : X', size[0].toFixed(3), ' Y', size[1].toFixed(3), ' Z', size[2].toFixed(3));
console.log('X-span @scale s :', size[0].toFixed(3), 'x s   (s=120 ->', (size[0]*120).toFixed(0), ')');
console.log('Z-span @scale s :', size[2].toFixed(3), 'x s   (s=120 ->', (size[2]*120).toFixed(0), ')');
console.log('MARKERS  :', mark.length);
mark.slice().sort((a,b)=> (a.name>b.name?1:-1)).forEach(m => console.log('   ', m.name, ' ', m.x, m.y, m.z));
const counts = {};
plant.forEach(p => { counts[p.name] = (counts[p.name]||0) + 1; });
console.log('PLANT NODES (pine|taiga|bush|tree by name):', Object.keys(counts).length);
Object.entries(counts).slice(0, 40).forEach(([k, v]) => console.log('    ', k, 'x' + v));
