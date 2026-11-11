#!/usr/bin/env node
/* ============================================================================
   sync-release-branch.mjs — mirror the desktop app into refs/heads/desktop-app
   WITHOUT touching the working tree or the main index.

   WHY THIS EXISTS
   ---------------
   The parent repo's dev history carries the whole game (1.2+ GB of blobs) and
   was never pushed to GitHub; pushing it would hit GitHub's 100 MiB blob
   limit and any sane transfer limit. But the desktop RELEASE pipeline only
   needs these paths to exist at the pushed tag:

       desktop/**                 (app source, scripts, build resources)
       .github/workflows/desktop-release.yml
       .gitignore                 (keeps dist/node_modules out of CI)

   So the release branch is an ORPHAN branch holding exactly those paths.
   Releases are then:  bump version → node scripts/sync-release-branch.mjs
                       → git tag desktop-vX.Y.Z <that commit> → push both.

   HOW (temp-index trick, no checkout):
       read-tree --empty  →  add the paths from the working tree
       →  write-tree  →  commit-tree (no parent = orphan root)
       →  update-ref refs/heads/desktop-app

   Re-running rebuilds the branch from the CURRENT working tree, so later
   releases just re-run it. A second commit gets appended on top of the
   previous branch head (parent = old head) when that head exists, so the
   branch history stays browsable.
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BRANCH = process.env.TL_RELEASE_BRANCH || 'desktop-app';
const COPY = [
  'desktop',
  '.github/workflows/desktop-release.yml',
  '.gitignore',
];

function git(args, opts = {}) {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 26,
    ...opts,
  }).toString().trim();
}

try {
  git(['rev-parse', '--git-dir']);
} catch {
  console.error('Not inside a git repository.');
  process.exit(1);
}

const idx = path.join(
  'C:\\Users\\Nojus\\Downloads\\TL\\.build-cache\\tmp',
  `tl-rel-idx-${process.pid}-${Date.now()}`
);
fs.mkdirSync(path.dirname(idx), { recursive: true });
const env = { ...process.env, GIT_INDEX_FILE: idx };

try {
  git(['read-tree', '--empty'], { env });

  for (const p of COPY) {
    if (!fs.existsSync(p)) {
      console.error('Missing path for release branch: ' + p);
      process.exit(1);
    }
    git(['add', '--', p], { env });
  }

  const tree = git(['write-tree'], { env });
  const parentHead = (() => {
    try { return git(['rev-parse', `refs/heads/${BRANCH}`]); } catch { return null; }
  })();

  const msg = `Desktop app release snapshot\n\nMirrored from the working tree by scripts/sync-release-branch.mjs.\nContains only the desktop Electron app + its release workflow.`;
  const commitArgs = ['commit-tree', tree, '-m', msg];
  if (parentHead) commitArgs.push('-p', parentHead);
  const commit = git(commitArgs, { env });

  git(['update-ref', `refs/heads/${BRANCH}`, commit, ...(parentHead ? [parentHead] : [])]);
  console.log(`refs/heads/${BRANCH} = ${commit}${parentHead ? ' (on top of ' + parentHead.slice(0, 8) + ')' : ' (orphan root)'}`);
  console.log(`Files: ${git(['ls-tree', '-r', '--name-only', tree], { env }).split('\n').length}`);
} finally {
  fs.rmSync(idx, { force: true });
}
