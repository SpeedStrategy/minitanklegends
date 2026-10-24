/* List the model keys embedded in glb_data.js and diff them against the models
   config.js asks for. A tank whose model is absent falls back to primitive
   boxes tinted with def.color, which looks like "the game repainted my model". */
const fs = require('fs');
const glb = fs.readFileSync(process.argv[2], 'utf8');
const cfg = fs.readFileSync(process.argv[3], 'utf8');

const embedded = [...glb.matchAll(/__GLB_DATA__\["([^"]+)"\]\s*=/g)].map(m => m[1]);
const wanted = [...new Set([...cfg.matchAll(/model:'([^']+)'/g)].map(m => m[1]))];

console.log('  embedded in glb_data.js : ' + embedded.length);
console.log('    ' + embedded.join(', '));
console.log('');
console.log('  models config.js wants   : ' + wanted.length);
const missing = wanted.filter(w => !embedded.includes(w));
const extra = embedded.filter(e => !wanted.includes(e));
console.log('  MISSING (tank falls back to a primitive box): ' +
            (missing.length ? '\n    ' + missing.join('\n    ') : 'none'));
if (extra.length) console.log('  embedded but unused: ' + extra.join(', '));