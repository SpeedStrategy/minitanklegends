/* Inspect glb_data.js: how many model assignments, how big each blob is, and
   whether the file is one model or many. Reports names only, never base64. */
const fs = require('fs');
const s = fs.readFileSync(process.argv[2], 'utf8');

const re = /__GLB_DATA__\s*\[\s*["']([^"']+)["']\s*\]\s*=\s*"([^"]*)"/g;
let m, total = 0, rows = [];
while ((m = re.exec(s)) !== null) {
  total++;
  rows.push({ name: m[1], chars: m[2].length, approxKB: Math.round(m[2].length / 1024) });
  if (re.lastIndex > s.length) break;   /* guard against a pathological match */
}
console.log('  file          : ' + (s.length / 1024 / 1024).toFixed(2) + ' MB');
console.log('  assignments   : ' + total);
for (const r of rows) console.log('    ' + r.name.padEnd(24) + r.approxKB + ' KB of base64');
const accounted = rows.reduce((a, r) => a + r.chars, 0);
console.log('  accounted for : ' + (accounted / 1024 / 1024).toFixed(2) + ' MB of ' +
            (s.length / 1024 / 1024).toFixed(2) + ' MB');