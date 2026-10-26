const fs = require('fs');
const path = 'index.html';
let d = fs.readFileSync(path, 'utf8');

// Console HTML — injected before </body>
const consoleHTML = `
  <!-- Hidden dev console (buffy) -->
  <div id="dev-console" style="display:none; position:fixed; bottom:0; left:0; right:0; background:#111; color:#0f0; font:12px monospace; padding:8px; z-index:999999; border-top:2px solid #0f0;">
    <div style="display:flex; gap:4px; align-items:center; margin-bottom:4px;">
      <button id="dev-console-toggle" style="background:#222; color:#0f0; border:1px solid #0f0; padding:2px 8px; cursor:pointer;">Show console</button>
      <button id="dev-console-clear" style="background:#222; color:#0f0; border:1px solid #0f0; padding:2px 8px; cursor:pointer;">Clear</button>
      <span style="color:#0f0; font-size:11px;">hidden dev console — type JS to eval</span>
    </div>
    <div id="dev-console-log" style="display:none; height:120px; overflow:auto; background:#000; padding:4px; border:1px solid #0f0; margin-bottom:4px;"></div>
    <div id="dev-console-debug" style="display:none;"></div>
    <input id="dev-console-input" type="text" disabled placeholder="eval..." style="width:100%; background:#000; color:#0f0; border:1px solid #0f0; padding:4px; font:12px monospace; display:none;">
  </div>
`.trim();

// Inject before </body>
const bodyClose = '</body>';
const idx = d.indexOf(bodyClose);
if (idx < 0) {
  console.error('ERROR: </body> not found');
  process.exit(1);
}

d = d.slice(0, idx) + '\n' + consoleHTML + '\n' + d.slice(idx);

fs.writeFileSync(path, d, 'utf8');
console.log('Injected console HTML before </body> at char', idx);
console.log('New file size:', d.length, 'bytes');
