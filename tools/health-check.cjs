/* health-check: verifies this session's fixes are still on disk */
const fs = require('fs');

const rw = s => null;
const w = fs.readFileSync('js/world.js', 'utf8').replace(/\r\n/g, '\n');
const g = fs.readFileSync('js/game.js', 'utf8').replace(/\r\n/g, '\n');
const n = fs.readFileSync('js/net.js', 'utf8').replace(/\r\n/g, '\n');
const v = fs.readFileSync('js/map-voting.js', 'utf8').replace(/\r\n/g, '\n');
const i = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n');
const c = fs.readFileSync('css/style.css', 'utf8').replace(/\r\n/g, '\n');

const checks = [
  ['world member rename',      /const member = members\[i\]/.test(w)],
  ['world toLocal in loop',    /      const toLocal = batch\.grpInv \|\| null;/.test(w)],
  ['world toLocal not at top', !/\n    const toLocal = batch\.grpInv \|\| null;/.test(w)],
  ['world taiga->bush',        /noBillboard = lower\.includes\('taiga'\)/.test(w)],
  ['world bush-branch taiga',  /\(lower\.includes\('bush'\) \|\| lower\.includes\('taiga'\)\)/.test(w)],
  ['game orphan tail gone',    !/\n        time: this\.time,\n        glad: this\.glad/.test(g)],
  ['game windFoliage merge',   /this\._windFoliage = gPines\.concat\(_uprightBushes\)/.test(g)],
  ['game billboard skip',      /if\(b\.noBillboard\) continue;/.test(g)],
  ['net Object.assign',        /Object\.assign\(Net, \{/.test(n)],
  ['voting hill entry',        /id: 'hill',/.test(v)],
  ['html kickers',             (/gm-card-kicker/.test(i))],
  ['html title accent',        /gm-title-accent/.test(i)],
  ['html css version bump',    /css\/style\.css\?v=2026(1018[b-z]|10(19|[23]\d)[a-z])/.test(i)],
  ['css GM 2.0 block',         /GM 2.0/.test(c)],
  ['css searchlight',          /gmSearchlight/.test(c)]
];
let bad = 0;
for(const [name, ok] of checks){
  if(!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
}
process.exit(bad ? 1 : 0);
