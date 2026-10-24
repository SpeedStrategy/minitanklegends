/* Report every image in a GLB with its mime type and byte size, plus each
   material's alphaMode / doubleSided. Used to prove whether an optimisation
   pass destroyed texture transparency by re-encoding PNG-with-alpha as JPEG. */
const fs = require('fs');
const b = fs.readFileSync(process.argv[2]);
const len = b.readUInt32LE(8);
let off = 12, json = null;
while (off < len) {
  const c = b.readUInt32LE(off), t = b.readUInt32LE(off + 4).toString(16);
  if (t === '4e4f534a') json = JSON.parse(b.slice(off + 8, off + 8 + c).toString('utf8'));
  off += 8 + c + ((4 - (c % 4)) % 4);
}
const BV = json.bufferViews || [];
console.log('--- images ---');
for (const im of json.images || []) {
  const bytes = im.bufferView != null ? (BV[im.bufferView].byteLength || 0) : 0;
  console.log('  ' + String(im.name).padEnd(44) +
    String(im.mimeType).padEnd(12) + (bytes / 1024).toFixed(0).padStart(6) + ' KB');
}
console.log('--- materials (alpha-relevant only) ---');
for (const m of json.materials || []) {
  const mode = m.alphaMode || 'OPAQUE';
  const bs = m.doubleSided ? ' dbl' : '';
  console.log('  ' + String(m.name).padEnd(44) + mode.padEnd(10) + bs);
}