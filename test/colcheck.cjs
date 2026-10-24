/* Print the runtime collider for two tanks straight out of config.js, using the
   same formula tank.js uses, so "these are the same size" can be checked rather
   than asserted. GLOBAL_SCALE is Tank.GLOBAL_SCALE from tank.js. */
const fs = require('fs');
const s = fs.readFileSync(process.argv[2]).toString().replace(/\r\n/g, '\n');
const GS = 2.0;                       /* Tank.GLOBAL_SCALE, tank.js:635 */
for (const id of process.argv.slice(3)) {
  const i = s.indexOf("id:'" + id + "'");
  if (i < 0) { console.log('  ' + id + ': NOT FOUND'); continue; }
  const seg = s.slice(i, i + 700);
  const bd = /body:\s*\{\s*w:\s*([\d.]+),\s*h:\s*([\d.]+),\s*l:\s*([\d.]+)/.exec(seg);
  const md = /model:'([^']+)',\s*modelScale:([\d.]+)/.exec(seg);
  if (!bd) { console.log('  ' + id + ': no body dims'); continue; }
  console.log('  ' + id.padEnd(11) +
    ' body ' + bd[1] + 'x' + bd[2] + 'x' + bd[3] +
    '  ->  half ' + (bd[1] * 0.55 * GS).toFixed(3) +
    ' x ' + (bd[3] * 0.55 * GS).toFixed(3) +
    ' x ' + (bd[2] * 0.5 * GS).toFixed(3) +
    '   model: ' + (md ? md[1] + ' @' + md[2] : '(built-in mesh)'));
}