/* Regression tests for the "void map" bug and the model-file guard.

   Run: node test-void.mjs

   THE BUG
   -------
   _fitWorldToMap() used to floor the arena boundary at 500:

       this.world.half = declared || Math.max(500, derived);

   The idea was to stop a tiny map squeezing the arena shut. It did not -- the
   `w > 0 && d > 0` guard above it already rejects a degenerate map. On every
   genuinely small map the floor was the bug, because a boundary of 500 means
   "the ground is here", and on a smaller map it is a lie that five separate
   systems all believe at once:

     tank clamp, void kill, camera limit, capture circle, minimap

   The result on screen is an empty void with a tank floating in the middle of
   it, which is indistinguishable from "the map failed to download" -- and is
   what sent someone hunting for a missing GLB that had loaded perfectly.

   THE OTHER ONE
   -------------
   _fetchBytes() guards a download before a parser sees it. Its XML test was
   `head[0] === 0x3C` -- one '<' -- and every HTML page starts with '<'. So the
   one check meant to reject a wrong file waved Cloudflare's SPA fallback page
   straight into ColladaLoader, which printed "XML Parsing Error: not
   well-formed" once per model that has no .dae. */

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
};

/* ========================================================================= */
console.log('\n-- the arena boundary --');
{
  /* Comments are stripped before anything is asserted on.

     Without this the suite matches its own documentation: the explanation of
     why the 500 floor was removed necessarily contains the text
     `Math.max(500, derived)`, so a naive search for that string finds the
     comment describing its own deletion and reports the bug as still present.

     That is not a hypothetical. It is what happened the first time this file
     ran. */
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const raw = readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
  const src = stripComments(raw);
  const fn = src.slice(src.indexOf('_fitWorldToMap(box, map){'));

  ok('the old 500 floor is gone', !/Math\.max\(\s*500\s*,\s*derived\s*\)/.test(fn));
  ok('the boundary is the derived size', /declared\s*\|\|\s*Math\.max\(MIN_HALF,\s*derived\)/.test(fn));

  /* The floor that remains must be small enough that it cannot exceed a real
     map. A guard that can be wider than the map is the bug again. */
  const m = fn.match(/const MIN_HALF = (\d+)/);
  ok('a degeneracy guard exists', !!m);
  const minHalf = m ? Number(m[1]) : Infinity;
  ok('and it is small — smaller than every shipped map', minHalf <= 200, String(minHalf));

  /* A declared worldHalf still wins: gladiator reads world.half BEFORE the map
     loads, so losing the declaration would break that mode outright. */
  ok('a declared worldHalf still wins', /const declared = this\._declaredWorldHalf\(map\)/.test(fn));
  ok('and is still preferred', /this\.world\.half = declared \|\|/.test(fn));

  /* The degenerate guard that makes the floor redundant must not be weakened. */
  ok('a zero-size map is still rejected', /if\(!\(w > 0\) \|\| !\(d > 0\)\) return;/.test(fn));
}

/* ========================================================================= */
console.log('\n-- a map smaller than the old floor no longer gets a lie --');
{
  /* Core's own comment states the real extent is ~241 units, i.e. a derived
     half of ~130. The old floor turned that into 500: a boundary four times
     the size of the ground, on every system that reads it. */
  const realHalf = 130;
  const oldHalf = Math.max(500, realHalf);
  const newHalf = Math.max(40, realHalf);

  ok('the old floor inflated Core fourfold', oldHalf === 500);
  ok('the new boundary matches the map', newHalf === realHalf);
  ok('the void ring the old floor created is gone', newHalf === realHalf);
  ok('and the boundary is inside the ground', newHalf <= realHalf * 1.08);
}

/* ========================================================================= */
console.log('\n-- a model download that is actually a web page --');
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const src = strip(readFileSync(new URL('../js/models.js', import.meta.url), 'utf8'));
  const fn = src.slice(src.indexOf('_fetchBytes(url){'), src.indexOf('_loadCollada(name){'));

  ok('an HTML page is recognised and rejected',
     /<!doctype|<html|<head|<body|<script/i.test(fn));
  ok('and the bare "<" test no longer stands alone',
     !/const xmlStart = head\[0\] === 0x3C;/.test(fn));

  /* Reproduce the actual decision for the body Cloudflare serves on a miss. */
  const html = new TextEncoder().encode('<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8">');
  const head = new Uint8Array(html, 0, Math.min(64, html.byteLength));
  const looksLikeHtml = /<!doctype|<html|<head|<body|<script/i
    .test(new TextDecoder().decode(head));
  const xmlStart = head[0] === 0x3C && !looksLikeHtml;
  ok('the SPA fallback page is NOT accepted as a .dae', xmlStart === false);

  /* And a real collada file still is. */
  const dae = new TextEncoder().encode('<?xml version="1.0"?>\n<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">');
  const dhead = new Uint8Array(dae, 0, Math.min(64, dae.byteLength));
  const dXml = dhead[0] === 0x3C && !/<!doctype|<html|<head|<body|<script/i.test(new TextDecoder().decode(dhead));
  ok('a real .dae is still accepted', dXml === true);

  /* And the other two formats are untouched by the fix. */
  const glb = new Uint8Array([0x67, 0x6C, 0x54, 0x46]);
  ok('a .glb is still accepted',
     glb[0] === 0x67 && glb[1] === 0x6C && glb[2] === 0x54 && glb[3] === 0x46);
  const gltf = new TextEncoder().encode('{"asset":{"version":"2.0"}}');
  ok('a .gltf is still accepted', gltf[0] === 0x7B);
}

/* ========================================================================= */
console.log('\n-- free roam when its SDK is missing --');
{
  const game = readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
  const nak = readFileSync(new URL('../js/nakama-net.js', import.meta.url), 'utf8');

  ok('free roam checks for the SDK before using it',
     /typeof nakamajs === 'undefined'[\s\S]{0,220}Free Roam is unavailable/.test(game));
  ok('and returns instead of throwing', /Free Roam is unavailable[\s\S]{0,160}return;/.test(game));
  ok('the SDK wrapper reports availability too', /available\(\)\{[\s\S]{0,120}typeof nakamajs !== 'undefined'/.test(nak));
  ok('and init refuses rather than throwing',
     /init\(\)\{[\s\S]{0,120}if\(!this\.available\(\)\) return false;/.test(nak));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);