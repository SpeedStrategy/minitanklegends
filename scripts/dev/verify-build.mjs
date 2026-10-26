s=require("fs").readFileSync(
"js/tank-editor.js",
"utf8");
out=[];
fn=/function\s+(\w+)\(\)/g; let m; while(m=fn.exec(s)){out.push(m[1]);}
console.log("=== function order (first 40) ===");
for(let i=0;i<Math.min(40,out.length);i++){console.log((i+1).toString().padStart(3), out[i]);}
console.log();

function count(name){return (s.match(new RegExp(name,"g"))||[]).length;}
console.log("=== structural checks ===");
console.log("pasteTankCode() defined:", count("function pasteTankCode()"));
console.log("clipboard.readText:", count("navigator.clipboard.readText"));
console.log("atob(raw) decode path:", count("var bin = atob(raw)"));
console.log("JSON.parse(raw) fallback:", count("var json = JSON.parse(raw)"));
console.log("setOv(blob.tank, blob.data):", count("setOv(blob.tank, blob.data)"));
console.log("applyValuesToScene():", count("applyValuesToScene()"));
console.log("rebuildTracksPreview():", count("rebuildTracksPreview()"));
console.log("success toast:", count("Tank code applied to"));
console.log("fail toast:", count("Could not read that as a tank code or setup JSON"));
console.log("firePoint export:", count("out.firePoint = { x: v.shell.x"));
console.log("casingPoint export:", count("out.casingPoint = { x: v.casing.x"));
console.log("turret merge w/h/l:", count("out.turret = Object.assign({}, (def && def.turret)"));
console.log("OLD shell line (must be 0):", count("out.shell = {"));
console.log("OLD casing line (must be 0):", count("out.casing = {"));
const oldTurretReg = /out\.turret = \{ x: v\.turret\.x, y: v\.turret\.y, z: v\.turret\.z \}/g;
console.log("OLD turret-only line (must be 0):", (s.match(oldTurretReg)||[]).length);
console.log("te-paste-code id count:", count("te-paste-code"));
console.log("pasteTankCode(); wiring calls:", count("pasteTankCode();"));
console.log("Paste tank code label:", count("Paste tank code"));
console.log();
function bodyLen(fnName){const r=s.indexOf("function "+fnName+"()"); const e=s.indexOf("function ", r+1); return [r, e-r, e];}
const [pr,pb,pe]=bodyLen("pasteTankCode"); const po=(s.slice(pr,pe).match/{/g||[]).length; const pc=(s.slice(pr,pe).match/}/g||[]).length;
const [sr,sb,se]=bodyLen("buildSetupJSON"); const so=(s.slice(sr,se).match/{/g||[]).length; const sc=(s.slice(sr,se).match/}/g||[]).length;
const [tr,tb,te2]=bodyLen("TURRET_OVERLAY"); const to=(s.slice(tr,te2).match/{/g||[]).length; const toc=(s.slice(tr,te2).match/}/g||[]).length;
const [ar,ab,ae]=bodyLen("applyEditorCode"); const ao=(s.slice(ar,ae).match/{/g||[]).length; const ac=(s.slice(ar,ae).match/}/g||[]).length;
console.log("pasteTankCode body braces open/close:", po, pc);
console.log("buildSetupJSON body braces open/close:", so, sc);
console.log("TURRET_OVERLAY body braces open/close:", to, toc);
console.log("applyEditorCode body braces open/close:", ao, ac);
console.log();
const FO=(s.match/{/g||[]).length; const FC=(s.match/}/g||[]).length;
const FP=(s.match/\(/g||[]).length; const FPF=(s.match/\)/g||[]).length;
console.log("FILE braces open/close:", FO, FC, " => "+(FO===FC?"BALANCED":"NOT BALANCED"));
console.log("FILE parens open/close:", FP, FPF, " => "+(FP===FPF?"BALANCED":"NOT BALANCED"));
console.log();
console.log("=== copy + paste round-trip witness ===");
const applyI=s.indexOf("function applyEditorCode"); const applyEnd=s.indexOf("\nfunction ", applyI+1);
const applyBody=s.slice(applyI, applyEnd).replace(/\s+navigator\.clipboard\.readText[^\n]*\n/g,"").replace(/\/\*[\s\S]*?\*\//g,"");
const applyOuts=[...applyBody.matchAll(/out\.\w+\.\w+ = \{/g)].map(m=>m[0].split(".")[1])
  .filter((v,i,a)=>a.indexOf(v)===i);
console.log("applyEditorCode target sub-objects (round-trip merge targets):", applyOuts.join(", "));
console.log();
const config=require("fs").readFileSync("js/config.js","utf8");
const cf=[...config.matchAll(/(\w+)\s*:\s*\{/g)].map(m=>m[1]).filter((v,i,a)=>a.indexOf(v)===i);
console.log("config.js top-level part fields:", cf.join(", "));
const buildSetupOut=[...s.matchAll(/out\.(\w+) = \{/g)].map(m=>m[1]);
const buildSetupSet=new Set(buildSetupOut);
const missing=cf.filter(k=>!buildSetupSet.has(k));
const extra=buildSetupOut.filter(k=>!cf.includes(k));
console.log("buildSetupJSON covers every config.js part field:", missing.length===0 ? "YES" : ("NO (missing: "+missing.join(", ")+")"));
console.log("buildSetupJSON extra non-config fields:", extra.length ? extra.join(", ") : "none");
console.log();
console.log("=== copy deflection witness ===");
const cdI=s.indexOf("function buildCopyDefJSON"); const cdEnd=s.indexOf("\nfunction ", cdI+1);
const cdBody=s.slice(cdI, cdEnd);
const cdOuts=[...cdBody.matchAll(/out\.(\w+) = /g)].map(m=>m[1]).filter((v,i,a)=>a.indexOf(v)===i);
console.log("buildCopyDefJSON exports:", cdOuts.join(", "));
const shareI=s.indexOf("function compareScriptTargets");
if(shareI>0){const shareEnd=s.indexOf("\nfunction ", shareI+1);
  console.log("compareScriptTargets body size:", shareEnd-shareI, "chars");
} else { console.log("compareScriptTargets: NOT FOUND"); }
const eraseW=s.match(/state\.edits\[id\]\s*=\s*null/);
console.log("erase writeback state.edits[id]=null:", eraseW ? "present" : "MISSING");
const eraseLive=s.match(/applyValuesToScene\(\);\s*rebuildTracksPreview\(\);\s*saveOverrides\(\);/);
console.log("live build on erase:", eraseLive ? "present" : "MISSING");
console.log();
const ok = FO===FC && FP===FPF && count("Paste tank code")>0 && count("function pasteTankCode()")>0
  && count("navigator.clipboard.readText")>0 && count("var bin = atob(raw)")>0
  && count("setOv(blob.tank, blob.data)")>0 && count("applyValuesToScene()")>0
  && count("rebuildTracksPreview()")>0 && count("out.firePoint = { x: v.shell.x")>0
  && count("out.casingPoint = { x: v.casing.x")>0
  && count("out.turret = Object.assign({}, (def && def.turret)")>0
  && count("out.shell = {")===0 && count("out.casing = {")===0
  && (s.match(/out\.turret = \{ x: v\.turret\.x, y: v\.turret\.y, z: v\.turret\.z \}/g)||[]).length===0
  && missing.length===0;
console.log("=== result ===", ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");
process.exit(ok ? 0 : 1);

