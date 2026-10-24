/* Which tank models are actually embedded, and where. glb_data.js is the
   in-game embed; garage-inline.js is the menu's. A tank configured with a model
   that is in neither falls back to primitive boxes painted with def.color,
   which is what "the game repainted my model" looks like. */
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const s = fs.readFileSync(f, 'utf8');
  const keys = [...new Set(
    [...s.matchAll(/__GLB_DATA__\s*\[\s*"([^"]+)"\s*\]/g)].map(m => m[1])
  )];
  console.log('  ' + f);
  console.log('     embedded: ' + keys.length + (keys.length ? '\n       ' + keys.join('\n       ') : ''));
}