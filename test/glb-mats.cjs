/* List every material in a GLB with its base colour factor and alpha, so a
   black or invisible-looking surface can be traced back to the material that
   caused it rather than guessed at from a screenshot. */
const fs = require('fs');
const b = fs.readFileSync(process.argv[2]);
const len = b.readUInt32LE(8);
let off = 12, json = null;
while (off < len) {
  const c = b.readUInt32LE(off), t = b.readUInt32LE(off + 4).toString(16);
  if (t === '4e4f534a') json = JSON.parse(b.slice(off + 8, off + 8 + c).toString('utf8'));
  off += 8 + c + ((4 - (c % 4)) % 4);
}
for (const m of json.materials || []) {
  const p = m.pbrMetallicRoughness || {};
  const bf = p.baseColorFactor || [1, 1, 1, 1];
  const lum = 0.2126 * bf[0] + 0.7152 * bf[1] + 0.0722 * bf[2];
  /* Only call a material black if it can actually BE seen. A fully transparent
     material is allowed to have a zero base colour -- that is how the `void`
     kill plane is encoded: no surface at all. Judging it on luminance alone
     reported it as the black-sheet problem a second time after it was fixed. */
  const invisible = bf[3] === 0 || (m.alphaMode === 'BLEND' && bf[3] < 0.01);
  const hasMap = p.baseColorTexture !== undefined;
  let dark = !invisible && lum < 0.15 ? '  <== NEAR BLACK' : '';
  if (invisible) dark = '  (fully transparent - draws nothing)';
  console.log('  ' + String(m.name).padEnd(34) +
    'rgb ' + bf.slice(0, 3).map(v => v.toFixed(3)).join(',').padEnd(22) +
    'a=' + bf[3].toFixed(2) +
    ' map=' + (hasMap ? 'yes' : 'NO ') +
    ' ' + (m.alphaMode || 'OPAQUE') + dark);
}