/* convert-png-to-webp.mjs — batch-convert remaining PNG textures to WebP.
 *
 * Writes a .webp next to every .png (same basename), verifies the output is a
 * real decodable image, then deletes the PNG. Run with the bundled node:
 *   node tools/convert-png-to-webp.mjs            (convert everything)
 *   node tools/convert-png-to-webp.mjs path1.png  (convert specific files)
 *
 * Quality: lossy q=90 with full alpha (alphaQuality 100). Good enough that no
 * texture visibly degrades, and every icon keeps its clean edges.
 */
import sharp from 'sharp';
import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = ['.git', 'node_modules', 'cf-dist', '.wrangler'];

function findPngs(dir, out = []){
  for(const name of readdirSync(dir)){
    if(SKIP_DIRS.includes(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch(e){ continue; }
    if(st.isDirectory()) findPngs(p, out);
    else if(name.toLowerCase().endsWith('.png')) out.push(p);
  }
  return out;
}

function refsOf(absPath){
  /* textual files that may name this image with a relative path */
  const rel = relative(ROOT, absPath).split('\\').join('/');
  return rel;
}

const argvFiles = process.argv.slice(2);
let pngs;
if(argvFiles.length){
  pngs = argvFiles.map(f => join(ROOT, f)).filter(f => f.toLowerCase().endsWith('.png') && existsSync(f));
} else {
  pngs = findPngs(ROOT);
}

let saved = 0, converted = 0;
const lines = [];
for(const png of pngs){
  const webp = png.slice(0, -4) + '.webp';
  try {
    const out = await sharp(png, { failOn: 'none' }).webp({ quality: 90, alphaQuality: 100, effort: 4, smartSubsample: false }).toFile(webp);
    /* verify it decodes and is not a zero-byte bribe */
    const meta = await sharp(webp).metadata();
    if(!out || !meta || !meta.width) throw new Error('bad output');
    converted++;
    const rel = refsOf(png);
    lines.push(`  ${rel}  ${(statSync(png).size/1024).toFixed(0)}KB -> ${(out.size/1024).toFixed(0)}KB`);
    saved += statSync(png).size - out.size;
    unlinkSync(png);
  } catch(err){
    lines.push(`  SKIP ${relative(ROOT, png)}  (${err.message})`);
    /* leave the original in place if conversion failed */
    try { if(existsSync(webp)) unlinkSync(webp); } catch(e){}
  }
}
console.log(`Converted ${converted}/${pngs.length} PNGs, saved ${(saved/1024/1024).toFixed(2)} MiB`);
console.log(lines.join('\n'));
