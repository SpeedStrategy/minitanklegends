/* ============================================================================
   bump-stamps.mjs — rewrite the ?v= cache stamps in index.html, correctly.

   WHY THIS IS A SCRIPT AND NOT A ONE-LINER
   -----------------------------------------
   index.html loads the game as:

       'js/tank.js?v=20261011d'

   and that stamp is the ONLY thing that busts the browser cache when a file
   changes. Get it wrong in either direction and you ship something broken:

     * forget to bump it  -> players keep the old file and the fix "did nothing"
     * mangle it          -> 'js/tank.js?v=20261016a20261011d'

   That mangled form happened twice, both times from the same mistake: doing a
   plain string Replace of 'js/tank.js?v=' with 'js/tank.js?v=20261016a'. A
   prefix replace PREPENDS, it does not substitute. The result still looked
   like a stamp, which is why it survived a glance and deployed.

   So this parses each reference, replaces the whole stamp, and refuses to
   write if anything about the file looks wrong. It also reports what it
   changed, so the stamps in index.html can be read rather than inferred.

   Usage:
       node tools/bump-stamps.mjs js/tank.js js/config.js
       node tools/bump-stamps.mjs --check          # verify only, write nothing
   ============================================================================ */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const INDEX = join(ROOT, 'index.html');

/* A stamp we write ourselves is always this shape. Anything else in the file --
   a doubled stamp, a stray character -- is caught by the checks at the bottom
   rather than being carried forward. */
const STAMP_RE = /\?v=[0-9]{8}[a-z]{1,2}(?=['",\s)])/;

/* Date-based, with a letter suffix that increments when two changes land on
   the same day. The clock alone cannot separate them: two deploys in one
   afternoon would produce an identical stamp and the second would not bust. */
function nextStamp(previous) {
  const d = new Date();
  /* EIGHT DIGITS: YYYYMMDD. This read `String(y).slice(2)` and produced
     "261016" instead of "20261016" -- a six-character stamp that still differed
     from the previous value, so it still busted the cache and nothing broke
     visibly, and the length check (which only rejects stamps LONGER than ten)
     had no reason to look at it. The stamps in index.html are 20261014i,
     20261015a: four-digit year, two-digit month, two-digit day, one letter. */
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const base = `${y}${m}${day}`;
  if (base.length !== 8) throw new Error(`stamp base "${base}" is ${base.length} chars, expected 8`);
  if (!previous) return base + 'a';
  const pm = previous.match(/^(\d{8})([a-z])$/);
  if (!pm) return base + 'a';
  if (pm[1] !== base) return base + 'a';
  const c = pm[2].charCodeAt(0);
  return base + (c < 97 + 25 ? String.fromCharCode(c + 1) : 'a');
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const files = args.filter(a => !a.startsWith('--'));

const raw = readFileSync(INDEX, 'utf8');
const problems = [];

/* The BOM is load-bearing. It was stripped once while rewriting this file, the
   non-ASCII count silently dropped from 129 to 128, and the page still rendered
   -- so nothing reported a problem. Assert it here rather than discovering it
   in the deploy script after the fact. */
const hasBom = raw.charCodeAt(0) === 0xFEFF;
if (!hasBom) problems.push('index.html has no UTF-8 BOM (it must keep one)');

let out = raw;
const changed = [];

if (files.length) {
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) {
      problems.push(`${f}: no such file in this directory`);
      continue;
    }
    /* Match the reference and its stamp together, so the stamp is REPLACED
       rather than having something prepended in front of it. */
    const re = new RegExp("(['\"])" + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                          "\\?v=([0-9a-z]+)(['\"])");
    const m = re.exec(out);
    if (!m) {
      problems.push(`${f}: not referenced in index.html, or its stamp is malformed`);
      continue;
    }
    const prev = m[2];
    /* Only bump the date form we own. An epoch stamp belongs to a reference
       this script did not create and has no business rewriting. */
    if (!/^\d{8}[a-z]$/.test(prev)) {
      problems.push(`${f}: stamp is '${prev}', which is not the date form ` +
                    `(\\d{8}[a-z]) this script manages — bump it by hand`);
      continue;
    }
    const next = nextStamp(prev);
    out = out.replace(re, `$1${f}?v=${next}$3`);
    changed.push(`${f}: ${prev} -> ${next}`);
  }
}

/* index.html carries TWO kinds of stamp and both are legitimate:

     ?v=20261014i      8 digits + a letter  -- what this script writes
     ?v=1787330007     epoch seconds         -- older references, left alone

   So the health check is not "is it the shape I write" but "is it absurdly
   long". The failure this guards against is a DOUBLED stamp, which is what a
   prefix-replace produces: 20261016a20261011d is 18 characters where 9 is
   right. Anything past 10 is a mistake; 9 and 10 are both fine. */
const tokens = out.match(/\?v=[0-9a-z]+/g) || [];
const bad = tokens.filter(t => {
  const s = t.slice(3);
  /* Long = two stamps run together. Wrong shape = this tool wrote it wrong,
     which is not hypothetical: the first version of nextStamp() sliced the
     year to two digits and emitted "261016a". Nothing else complained: it was
     still different from the previous stamp, so it still busted the cache. */
  if (s.length > 10) return true;
  return !(/^\d{8}[a-z]$/.test(s) || /^\d{10}$/.test(s));
});
if (bad.length) {
  problems.push(`malformed stamp(s): ${bad.join(', ')} — each must be ` +
                `\\d{8}[a-z] (what this script writes) or \\d{10} (epoch, left alone)`);
}

const nonAscii = (out.match(/[^\x00-\x7F]/g) || []).length;
/* Baseline updated 2026-10-24: the file was legitimately rewritten that day
   (duplicate-U cleanup + webp asset pass), taking the non-ASCII count from
   the old 129 to 46 — 45 real characters plus the (restored) BOM. The BOM
   itself was missing from disk even at HEAD; it is restored and asserted
   above, and 46 is the honest current count, re-verified with a byte scan. */
if (nonAscii !== 46) {
  problems.push(`non-ASCII count is ${nonAscii}, expected 46 — the file has been ` +
                `damaged or is being read/written with the wrong encoding`);
}

if (problems.length) {
  console.error('bump-stamps: NOT writing.');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

if (checkOnly) {
  console.log(`bump-stamps: index.html is healthy (BOM present, ${nonAscii} non-ASCII, stamps well formed).`);
} else if (changed.length) {
  writeFileSync(INDEX, out, 'utf8');
  console.log('bump-stamps: updated ' + changed.length + ' stamp(s)');
  for (const c of changed) console.log('  ' + c);
} else {
  console.log('bump-stamps: nothing to do (no files given).');
}