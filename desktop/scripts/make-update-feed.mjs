#!/usr/bin/env node
/* ============================================================================
   make-update-feed.mjs — turn electron-builder's generated update manifests
   into the feed that https://tanklg.pages.dev/updates/ serves.

   WHY THIS EXISTS
   ---------------
   electron-updater's "generic" provider downloads `latest.yml` from a plain
   URL and then fetches the installer path named inside it. Cloudflare caps a
   single file at 25 MiB, but a Windows installer is ~90 MB — so the feed
   (tiny) lives on tanklg.pages.dev while the installers (big) live on GitHub
   Releases. This script rewrites the relative file names in the manifests
   into absolute URLs pointing at a release's assets.

   If you ever move hosting somewhere without the 25 MiB cap, run it with
   --base pointing at your own host (or upload the installers next to the
   manifests) and the feed becomes fully self-hosted on your domain again.

   INPUT   desktop/dist/latest.yml, latest-mac.yml, latest-linux.yml
           (written by electron-builder next to the installers)
   OUTPUT  <repo-root>/updates/latest*.yml   — copied into the site deploy so
           the app's update check hits tanklg.pages.dev/updates/latest.yml

   USAGE   node scripts/make-update-feed.mjs [--dist DIR] [--out DIR]
                                             [--repo OWNER/NAME] [--tag TAG]
                                             [--base FULL_URL_PREFIX]
   ========================================================================== */

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..');

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const distDir = path.resolve(argValue('--dist') || path.join(DESKTOP_DIR, 'dist'));
const outDir = path.resolve(argValue('--out') || path.join(REPO_ROOT, 'updates'));
const repo = argValue('--repo') || 'SpeedStrategy/minitanklegends';

const FEEDS = [
  { file: 'latest.yml', label: 'windows' },
  { file: 'latest-mac.yml', label: 'macos' },
  { file: 'latest-linux.yml', label: 'linux' },
];

/* The tag the workflow releases under. File URLs are pinned to the exact tag
   so a feed always names binaries that provably exist. */
let version = null;

function readYamlVersion(text) {
  const m = text.match(/^version:\s*(\S+)/m);
  return m ? m[1] : null;
}

/* Minimal, surgical rewrite: prefix every relative `url:`/`path:` value with
   the release URL. Only these two keys carry file names in the manifests
   electron-builder emits; sha512/size/date lines are left untouched. */
function rewrite(text, fileUrlBase) {
  return text
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*(?:-\s*)?(?:url|path):\s*)(.+?)\s*$/);
      if (!m) return line;
      const value = m[2].replace(/^['"]|['"]$/g, '');
      if (/^https?:\/\//i.test(value)) return line;
      return m[1] + fileUrlBase + value;
    })
    .join('\n');
}

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

const baseFlag = argValue('--base');
const tagFlag = argValue('--tag');

fs.mkdirSync(outDir, { recursive: true });

let wroteAny = false;

for (const feed of FEEDS) {
  const src = path.join(distDir, feed.file);
  if (!fs.existsSync(src)) {
    console.log('feed: ' + feed.label.padEnd(7) + ' — ' + feed.file + ' not built on this machine, skipped');
    continue;
  }

  const text = fs.readFileSync(src, 'utf8');
  const v = tagFlag || (version ? 'desktop-v' + version : null) || (() => {
    version = readYamlVersion(text);
    return version ? 'desktop-v' + version : null;
  })();

  if (!v) fail(feed.file + ' has no version line — is this really an electron-builder manifest?');
  if (version === null) version = readYamlVersion(text);

  /* Pin every referenced file to the release tag, and verify it exists in the
     build output so a broken feed can never reach the site silently. */
  const fileUrlBase = baseFlag
    ? (baseFlag.endsWith('/') ? baseFlag : baseFlag + '/')
    : `https://github.com/${repo}/releases/download/${v}/`;

  const urlMatches = [...text.matchAll(/(?:-\s*)?url:\s*(\S+)/g)].map((m) => m[1]);
  const missing = urlMatches.filter((u) => !/^https?:/i.test(u) && !fs.existsSync(path.join(distDir, u)));
  if (missing.length) {
    fail(feed.label + ' references files not found in ' + distDir + ': ' + missing.join(', '));
  }

  const out = rewrite(text, fileUrlBase);
  const dst = path.join(outDir, feed.file);
  fs.writeFileSync(dst, out, 'utf8');
  wroteAny = true;
  console.log('feed: ' + feed.label.padEnd(7) + ' — ' + dst);
  console.log('        version ' + version + ', base ' + fileUrlBase);
}

if (!wroteAny) {
  fail('no latest*.yml manifests found in ' + distDir + '. Run an electron-builder target first.');
}

console.log('\nNext: deploy the site with this ' + outDir + ' folder included so');
console.log('https://tanklg.pages.dev/updates/latest.yml exists. The game deploy');
console.log('build (tools/build-cloudflare.js) already includes an updates/ folder');
console.log('at the repo root automatically.');
