# Mini Tank Legends — Cline build

A browser tank game. Free to play, accounts on Cloudflare, deployed to
`https://tanklg.pages.dev/`.

**If you are an AI or a new developer picking this up, read this file first.** It
exists because this project has been rebuilt by several assistants in a row, and
each one has re-learned the same things the hard way. Everything below is a fact
someone had to discover by breaking something.

---

## 1. The three design rules

These are not suggestions. Work that violates them has been sent back.

### Minimalistic
A player should understand a screen without being told. If a screen needs a
paragraph of explanation, the screen is wrong, not the paragraph. Delete
controls that duplicate another control's job. Show one value in one place —
never the same number, or the same name, twice.

### Stylized
Match the existing house style exactly. It is not a taste you can apply freely:

| Property | Value |
|---|---|
| Font | `Lilita One` (loaded from `css/style.css`) |
| Border | `3px solid #000` on every button and panel |
| Press shadow | `box-shadow: 0 3px 0 #000` — **no blur, no spread** |
| Pressed | shadow collapses to `0 0 0 #000`, element drops 3px |
| Radius | `10px` buttons, `14px` panels |
| Accent gold | `#ffd08a` |

Anything with a soft drop shadow, a gradient, or a different font reads as a
foreign object dropped into the game.

### Logic
No random logos, no mixed icon styles, no duplicated state. Every icon in a
group must be the same colour and the same family. If two elements hold the same
value, one of them is wrong — find which and delete it.

---

## 2. Layout

```
index.html              All markup. Script list at the bottom with ?v= stamps.
css/style.css           The house stylesheet. Everything visual lives here.
css/login-gate.css      The account gate only.
js/game.js              Match logic, rendering loop. ~14k lines. The core.
js/menu.js              Main menu, profile card, settings.
js/input.js             Mouse, keyboard, pointer lock.
js/auth.js              Account client. Talks to /api/*.
js/login-gate.js        The account gate. THE FILE MOST RECENTLY ADDED.
functions/api/          Cloudflare Pages Functions. Same-origin.
schema.sql              D1 schema. 6 idempotent tables.
test/                   Run both suites. 184 assertions.
server/mpserver.js      Node multiplayer server. For Oracle later, not live.
assets/ui/              Menu images that used to sit loose in the root
                        (settings-gear, mystery-crate, menu-background).
dev/                    /dev staging page. Its js/ copies now match js/.
scripts/dev/            Local helpers: play_with_friend, p2p/build verifiers,
                        node finders, tunnel. Run from anywhere; they resolve
                        the repo root themselves.
scripts/deploy/         deploy-pages.ps1, deploy.bat.
scripts/legacy-patchers/  One-off apply-*/dedup-* patch scripts. Already
                        applied; kept for history, do not re-run.
prototypes/             drift-demo.html, tank-party.html, Water.ts, glb-importer.js.
docs/                   ACCOUNTS-SETUP.md, TODO.md, garage screenshots.
archive/                Duplicates; copies of production game/tank/net.js from before the 2026-10-25 merge attempt.
test/harness/           Aim harness (was out-tests/).
```

Local test without Node: `python -m http.server 8765` in the repo root
(`.claude/launch.json` has it as "game"). Matchmaking/P2P need the Worker,
so multiplayer cannot be exercised on that server.

---

## 3. Deploying — read this twice

```powershell
$node = "$env:LOCALAPPDATA\Temp\opencode\node22\node-v22.11.0-win-x64\node.exe"
cd C:\Users\Nojus\Downloads\TL\MiniTankLegendsCline

# 1. Bump every cache-buster in index.html to the new stamp. ALL THREE.
#    js/auth.js?v=, js/login-gate.js?v=, css/login-gate.css?v=
#    ...and GATE_BUILD inside js/login-gate.js must be the same token.
#    The test suite fails if these disagree. Do not work around the test.

# 2. Sync changed files into the staging folder.
#    The staging folder holds HARDLINKS. If a copy silently does nothing,
#    the destination is still hardlinked to the old file — delete it first:
$stage = "$env:LOCALAPPDATA\Temp\opencode\mtl-deploy"
foreach ($f in @("index.html","js\auth.js","js\menu.js")) {
  $d = "$stage\$f"
  if (Test-Path $d) { Remove-Item -LiteralPath $d -Force }
  Copy-Item -LiteralPath "$pwd\$f" -Destination $d -Force
}

# 3. Deploy. --branch=main is mandatory, see below.
& $node ".\node_modules\wrangler\bin\wrangler.js" pages deploy "$stage" `
  --project-name=tanklg --branch=main --commit-message="what changed" --commit-dirty=true
```

**Non-obvious things that will cost you an hour if you skip them:**

- **`--branch=main` is required.** The project has no Git connection. Without it
  the deployment lands as a `preview` and `tanklg.pages.dev` never moves, so you
  deploy successfully and nothing changes for the user.
- **Aliases lag by ~30s.** After deploying, wait before checking. Checking too
  early makes you think the deploy failed and deploy it again.
- **Node is not installed system-wide.** Use the portable copy above.
- **`assets/maps/core2.blend` is 89 MB** and exceeds the 25 MiB Pages file limit.
  It is excluded from staging, NOT deleted. Do not delete it.
- **`.assetsignore` does not work on drag-drop Pages uploads.** That is why the
  staging folder with hardlinks exists.

### The caching trap that has cost the most time

Three separate bugs in this project were not logic bugs. They were a changed file
served from the browser's cache. It is invisible: the deploy succeeds, the tests
pass, the code on disk is correct, and the user's screen is wrong.

Rules:

1. **Every changed `.js` and `.css` gets a new `?v=` stamp.** No exceptions.
2. **`?v=` and `GATE_BUILD` must be the same token.** `test/test-chooser.mjs`
   asserts this. Editing one without the other is the exact failure that shipped
   a fix the user never received.
3. **Every gate screen prints its build stamp** at the bottom. When a user
   reports a bug you cannot reproduce, ask for that stamp first. It answers "are
   they even running my code" instantly, which no amount of guessing will.

---

## 4. Accounts

D1 database `mtl-accounts`, binding `DB`, same-origin through Pages Functions so
there is no second hostname and no CORS.

**Why D1 and not Workers KV:** KV allows 1,000 writes per day. A single match
writes profile state. KV dies within a day of real traffic. D1 allows 100,000
rows per day and does not care.

Routes, all in `functions/api/[[path]].js`:

```
POST /api/register        POST /api/login        POST /api/logout
GET  /api/me              GET  /api/profile      POST /api/profile
POST /api/forgot          POST /api/reset        GET  /api/verify-email
POST /api/change-password POST /api/admin-purge
```

Passwords are PBKDF2 in `functions/api/lib-auth.js`. Sessions are opaque random
tokens, stored hashed.

### The gate

`js/login-gate.js` renders Guest / Log In / Sign Up. It waits for the game to
finish booting (`lg-ready`) before appearing, so the loading screen plays first.

Two rules learned the hard way:

- **The chooser is a one-time screen.** Once `mtl_choice_made` is in
  localStorage it never appears again. That is fine only because there are two
  reliable ways back: `?login=1` on any URL, and the main menu's account button.
  Never ship a gate without an exit.
- **`Auth.open()` defaults to the chooser, not the login form.** Sending someone
  with no account straight to a login form is a dead end — there is nothing on
  that screen for them to click. All three options live on the chooser.

Guest progress carries into a new account on register. Do not break this.

---

## 5. Testing

```powershell
$node = "$env:LOCALAPPDATA\Temp\opencode\node22\node-v22.11.0-win-x64\node.exe"
cd C:\Users\Nojus\Downloads\TL\MiniTankLegendsCline

# Copy the snapshots FIRST or the tests run the previous version of the code.
Copy-Item js\login-gate.js test\login-gate.js -Force

& $node test\test-chooser.mjs     # 127 assertions
& $node test\test-accounts.mjs    # 61 assertions
```

`test/` contains **snapshot copies**. `test/login-gate.js` and
`test/lib-auth.mjs` are copies of the real files. Editing a real file without
re-copying means the suite silently tests stale code and passes. This has
happened.

`test-accounts.mjs` creates real accounts in the live D1. Purge them when done:

```powershell
& $node test\test-accounts.mjs --purge
```

---

## 6. Things that look like bugs and are not

| Looks broken | Actually |
|---|---|
| No OS cursor in a match | Dynamic aiming hides it and draws the crosshair. Ctrl brings it back. The game now says so once. |
| `assets/maps/core2.blend` missing from deploy | 89 MB, over the Pages limit. Excluded on purpose. |
| `THREE.ColladaLoader: Failed to parse` in console | Pre-existing, harmless, unrelated to your change. |
| `Game` is `undefined` on `window` | It is module-scoped. Not a failure. |
| Deploy finished but the site is unchanged | Alias lag, or you forgot `--branch=main`. |

---

## 7. Current state

- Live at `https://tanklg.pages.dev/`, working, accounts functional.
- Gate build stamp: see `GATE_BUILD` in `js/login-gate.js`.
- Four deployments are active. **Only `tanklg.pages.dev` is current.** The others
  (`mini-tank-legends.pages.dev`, `tanklg.nojus-t.workers.dev`,
  `clan-registry-api.nojus-t.workers.dev`) are stale. Test against the first one.
- Clans still use Workers KV and hit the 1,000 writes/day ceiling. **Not
  migrated to D1 yet.** This is the known scaling limit.
- Oracle Cloud Always Free A1 is planned for the real game server: 2 OCPU and
  12 GB, not 4 and 24. Deferred, not built.

## 8. What to do next

1. Migrate clans from Workers KV to D1. Same pattern as accounts.
2. Free-tier headroom is about 28.5 player-hours/day. The lever is input
   throttling and solo-skip, not more infrastructure.
3. Resend API key is unset, so password-reset emails are logged, not sent.
   `forgot` works, it just does not deliver yet.