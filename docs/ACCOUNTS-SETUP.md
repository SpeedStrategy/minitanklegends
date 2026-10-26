# ============================================================================
#  Mini Tank Legends — D1 account system, step by step
# ============================================================================
#
#  Read this top to bottom the first time. It takes about 10 minutes and costs
#  nothing. Every command is copy-pasteable as-is.
#
#  WHAT YOU ARE BUILDING
#  ---------------------
#  Accounts move from Workers KV to D1.
#
#    KV (what you have)    1,000 writes per DAY   -> ~333 signups a day, then dead
#    D1 (what this gives) 100,000 rows per DAY   -> effectively never the limit
#
#  You also get password reset by email, email verification, sessions stored as
#  hashes, rate limiting, and a self-service password change.
#
#  THE MOST IMPORTANT PROPERTY: your accounts survive updates.
#  ------------------------------------------------------------
#  The schema is idempotent and versioned. Every deploy checks which migrations
#  have already run and applies only the missing ones. Deploying never drops a
#  table, never clears a table, and never loses an account. If a deploy fails
#  halfway, the next one picks up where it left off.
#
#  NOTHING BREAKS IF YOU STOP HERE. Nothing is live until step 6.
# ============================================================================


STEP 1 — Install Node.js (once)
-----------------------------------------------------------------------------
Skip if `node --version` already prints something like v20 or v22.

  1. Go to      https://nodejs.org/en/download
  2. Download the **LTS** version (the left big green button)
  3. Run the installer
  4. Close and reopen PowerShell

Check it worked:

  node --version

If you see v20.x or v22.x, you are done.


STEP 2 — Get into the project folder
-----------------------------------------------------------------------------
Open PowerShell and run:

  cd C:\Users\Nojus\Downloads\TL\MiniTankLegendsCline

Confirm you are in the right place:

  dir functions

You should see an `api` folder.


STEP 3 — Log in to Cloudflare (once per computer)
-----------------------------------------------------------------------------
This opens a browser. A page appears asking you to allow Wrangler. Click
**Allow**. That is the whole step.

  npx wrangler login

If it prints "Successfully logged in", good.


STEP 4 — Create the database (once)
-----------------------------------------------------------------------------
  npx wrangler d1 create mtl-accounts

It prints something like:

  [[d1_databases]]
  binding = "DB"
  database_name = "mtl-accounts"
  database_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

**COPY THAT WHOLE BLOCK.** You need it in step 5.


STEP 5 — Tell the project the database ID
-----------------------------------------------------------------------------
Open `wrangler.toml` in your code editor. It currently contains only three
lines. Replace the whole file with the block you just copied, plus the Pages
settings that were already in it.

It should end up looking like this (your database_id will be different):

  name = "mini-tank-legends"
  compatibility_date = "2024-12-01"
  pages_build_output_dir = "."

  [[d1_databases]]
  binding = "DB"
  database_name = "mtl-accounts"
  database_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

Save the file.


STEP 6 — Build the tables (once, and after every schema change)
-----------------------------------------------------------------------------
  npx wrangler d1 execute mtl-accounts --file=./schema.sql --remote

It should list the tables it created. **This is the command that makes your
accounts safe across updates** — it is safe to run again at any time, it just
does nothing to rows that already exist.


STEP 7 — Set the email key (optional, but you want it)
-----------------------------------------------------------------------------
WITHOUT this, everything works and reset emails are printed to the log instead
of sent. Nothing breaks. Do it later if you like.

  1. Sign up at https://resend.com  (free, no card)
  2. Click **API Keys** -> **Create API Key**
  3. Copy the key. It looks like `re_abc123...`
  4. Run this, and PASTE the key when it asks, then press Enter:

  npx wrangler pages secret put RESEND_API_KEY

  Nothing will appear while you paste. That is normal — it is not accepting
  input. Press Enter once, then wait for "Success".

You should NOT paste that key into a chat window or anywhere online.


STEP 8 — Deploy the game
-----------------------------------------------------------------------------
  npx wrangler pages deploy . --project-name=mini-tank-legends

It prints a URL. That is your game, live.

  IMPORTANT: if your live game is tanklg.pages.dev rather than
  mini-tank-legends.pages.dev, then your Pages project name is `tanklg`, and
  you should run this instead:

  npx wrangler pages deploy . --project-name=tanklg

  You can see the real project name in the Cloudflare dashboard under
  Workers & Pages -> your project, or by running:

  npx wrangler pages project list


STEP 9 — Check it worked
-----------------------------------------------------------------------------
Open this in a browser:

  https://tanklg.pages.dev/api/health

You should see:

  {"ok":true,"service":"mtl-accounts","storage":"d1","db":"up", ...}

  "db":"up"     the database is connected and the tables exist
  "mail":"log-only"   you have not added the email key yet, which is fine

If it says `"ok":false` or `"db":"down"`, go back to step 6.

Now open the game and try creating an account.


STEP 10 — Delete the old accounts (optional)
-----------------------------------------------------------------------------
Your old accounts live in a *different* system (Workers KV) that the new code
no longer reads. So from the game's point of view they are already gone — every
player simply starts fresh with a clean slate.

To wipe the old KV data as well, so it cannot be recovered:

  npx wrangler kv key list --namespace-id 8c5f6a7a957c47269ce0ef94ba4fd4e6

That prints the keys. To delete them all, tell me and I will give you the exact
loop, or run this:

  $ns = "8c5f6a7a957c47269ce0ef94ba4fd4e6"
  npx wrangler kv key list --namespace-id $ns | ConvertFrom-Json |
    Where-Object { $_.name -notlike "DO_NOT_DELETE*" } |
    ForEach-Object { npx wrangler kv key delete --namespace-id $ns $_.name }

Read that twice before running it. It deletes old account records permanently
and cannot be undone. If anybody has progress they care about in those old
accounts, do not run it — the new system already ignores them, so there is no
need.


STEP 11 — Deleting accounts later, on purpose
-----------------------------------------------------------------------------
The API has a purge endpoint that is locked behind a secret key, so it cannot be
triggered by anyone who finds the URL. Set the key once:

  npx wrangler pages secret put PURGE_KEY

Type something long and random — for example, twenty characters of nonsense.
Keep it in your password manager; you will need it for the purge call.

Then, to wipe every account:

  curl -X POST https://tanklg.pages.dev/api/auth/admin/purge `
    -H "Content-Type: application/json" `
    -H "X-Purge-Key: YOUR_KEY_HERE" `
    -d '{"confirm":true}'

It replies with the number of accounts removed. There is no undo.


============================================================================
TROUBLESHOOTING
============================================================================

"wrangler: command not found"
  Node is not installed or PowerShell has not been reopened. Do step 1.

"Expected 4 args, got 0" or "binding not found"
  The D1 block is missing from wrangler.toml, or the binding is not spelled
  exactly `DB`. Step 5.

"/api/health says db:down"
  Step 6 did not run, or ran against the local copy instead of the real one.
  Re-run step 6 exactly as written (the `--remote` flag is what matters).

"Everything works but no email arrives"
  Check https://tanklg.pages.dev/api/health. If it says `"mail":"log-only"`,
  you have not set the key — step 7. Emails are being written to the Worker
  log instead, which you can read with:

  npx wrangler pages deployment tail --project-name=tanklg

  That prints the reset link. You can paste it into a browser to test the whole
  reset flow without sending any real email at all.

"Account creation says 'Cannot reach the account server'"
  The old hardcoded URL is still in the game. Search `js/config.js` and
  `js/payments.js` for CLAN_API_URL — those two still point at the dead worker
  for CLANS, which is a separate system and fine, but confirm the account
  calls in `js/auth.js` now use `/api/...`. They should.

"Login says Incorrect username or password" right after registering
  The browser is holding an old token from the previous system. Open
  DevTools -> Application -> Local Storage and delete `mtl_token` and
  `mtl_user`, then reload.


============================================================================
WHAT CHANGED IN YOUR CODE
============================================================================

NEW
  schema.sql                    the tables
  functions/api/[[path]].js     every endpoint
  functions/api/lib-auth.js     passwords, tokens, sessions, rate limits
  functions/api/lib-mail.js     sending mail
  css/login-gate.css            the login screen
  js/login-gate.js              the login screen's behaviour
  js/local-reset.js             clears the old pre-account local progress
  test/test-accounts.mjs        61 tests, run with node
  test/test-gate.mjs            27 tests, run with node

CHANGED
  js/auth.js                    rewritten for the same-origin API; its boot now
                                stands aside when the login gate is present
  index.html                    the lock, the login gate, three account panels
  css/style.css                 styles for the account panels

UNTOUCHED
  Everything else. The game, the models, the matchmaker, the garage. Accounts
  were always a side system, and they still are.


============================================================================
THE LOGIN GATE — GUEST, LOG IN, OR SIGN UP
============================================================================

After the loading screen, the player is asked ONCE how they want to play:

    [ Play as Guest ]   [ Log In ]   [ Sign Up ]

Nothing is selected at first and the green OK button is dead until one is
clicked, so the choice is a real decision rather than a default nobody noticed.
Clicking a card shows a short explanation underneath, and OK acts on it.

    GUEST  Progress is NOT saved. Everything else works — battles, clans, the
           shop, chat. It stays on this device and is gone when the tab closes.
           "You can make an account at any time from the menu."

    LOG IN Your coins, tanks and clans are waiting exactly as you left them.

    SIGN UP Progress is saved to your account and follows you to every device.
           Reversible — you can choose guest instead.

The choice is remembered (`mtl_choice_made`), so nobody is asked twice.

A GUEST IS NOT A SECOND-CLASS PLAYER
------------------------------------
Nothing is disabled for guests. Clans, chat, the shop and matchmaking all work.
The only difference is persistence: without a session token, `saveSettings()`
finds nothing to upload and progress simply stays local. That is already how the
existing code behaves, so guest play needed no separate path through the game.

GOING GUEST -> ACCOUNT DOES NOT LOSE ANYTHING
---------------------------------------------
The gate captures the guest's local progress BEFORE registering, then uploads it
to the new account. Coins, tanks and unlocks carry across. The guest flag is
cleared the moment a real session exists.

THE LOOK
--------
Built from your own game's button language rather than a generic dialog:
Lilita One, a 3px black border, and a hard `0 6px 0 #000` shadow that presses
away when clicked — the same construction as `.shop-buy-btn` and `.platoon-btn`.
Full screen, no framed card. Green OK button. Respects
`prefers-reduced-motion`, and reflows to stacked cards on a narrow phone.

THE LOGO IS THE FAVICON
-----------------------
The gate uses `assets/icons/favicon.png` — the exact image already shown in the
browser tab and on a phone's home screen. One file, one mark, and the player
recognises it before clicking anything.

It is deliberately NOT the 1254x1254 `tank legends logo new.png` at the
repository root. That is the same art exported as plain RGB with a baked-in
black background (PNG colour type 2, no alpha channel), so it rendered as a
black square sitting on the photograph. The favicon is colour type 6 — genuinely
transparent — so it sits on the art with nothing behind it. The duplicate was
deleted; there is now exactly one tank image in the project.

Two tests in test/test-chooser.mjs assert the gate's `src` equals the page's
`<link rel="icon">` href, and that the gate block contains exactly one `<img>`.
That is what stops a second, subtly different tank creeping back in.

THE CURSOR
----------
Four white bars in a crosshair with the centre cut out, 4px thick and 13px long
inside a 38px box, leaving a 12px gap. Over anything clickable the bars push
outward 4px and turn gold; on press they tighten. Hidden entirely on touch
(`pointer: coarse`), where a crosshair cannot be pointed.

Four elements rather than two crossed bars on purpose: crossed bars meet in the
middle and read as a solid blob covering the thing you are pointing at. The gap
is what keeps the exact point visible.

THE BACKGROUND
--------------
The gate uses the same photograph as the loading screen,
`assets/TL_loadingscreen.jpg`, on your game's own desert art.

The URL in `css/login-gate.css` must be absolute (`/assets/...`), not relative.
A relative `url()` in a stylesheet resolves against the STYLESHEET, not the
document — and that stylesheet lives in `css/`, so `url('assets/...')` asked the
browser for `/css/assets/TL_loadingscreen.jpg`, got a 404, and rendered the gate
as flat dark grey. There is also a copy as an inline style on the element, which
resolves against the document and cannot be broken that way.

THE SEQUENCE
------------
    assets/TL_loadingscreen.jpg + the game's loading bar
      -> the gate (only once boot has finished)
        -> the menu (only once the player has chosen)

The gate waits for `lg-ready`, which is added when game.js clears its own
`booting` class — the one moment that actually means the assets are in.

ONE HONEST LIMITATION
---------------------
This is a browser, so anyone with a developer console can delete the lock. That
is not fixable in client code and is not what it is for. The reason for the
gate is that an account is how progress is identified.

TO TEST WITHOUT DEPLOYING
-------------------------

  npx wrangler pages dev . --d1=DB --port 8788

Reset emails are printed in that terminal instead of sent, so you can click the
link in the log and test the whole flow with no email service at all.

THE OLD LOCAL ACCOUNTS ARE CLEARED AUTOMATICALLY
------------------------------------------------

The pre-account progress (coins, tanks, unlocks, stored under tankparty_* in
localStorage) is deleted on first load after this deploy. That is deliberate:
left in place it would be merged into new accounts, so a garage full of tanks
somebody never earned would follow them onto every device.

It runs ONCE per browser and is stamped. It does not delete:
  * your session (mtl_token / mtl_user)
  * volume, graphics, night mode — device settings, not progress

To run the wipe again later, change RESET_VERSION at the top of
js/local-reset.js. You do not need to edit this file by hand.

IF THE LOGIN GATE BLOCKS YOU AND YOU NEED IT GONE
---------------------------------------------------

Set this line to false in js/login-gate.js and change the two class names in
the inline lock script at the top of index.html from `auth-locked` to
`auth-disabled`. The gate will stop appearing. Do not delete the gate: it is what
keeps a signed-out player from playing into a local profile that silently stops
syncing.

TO TEST WITHOUT DEPLOYING
-------------------------

  npx wrangler pages dev . --d1=DB --port 8788

Then open http://localhost:8788. Password reset emails will be printed in that
terminal instead of sent, so you can click the link in the log and test the
whole flow with no email service set up at all.


============================================================================
WHAT THIS DOES NOT FIX
============================================================================

* The 100,000 requests/day Worker limit. Accounts barely touch it now, but the
  match server still runs on Cloudflare and still has that ceiling.
* Clans still use Workers KV, which still has 1,000 writes a day. A clan
  heartbeat is one write per 30 seconds per member with the screen open, so
  roughly 33 member-hours a day before the quota is gone. Moving clans to D1
  is the same change we just made here, whenever you want it.
* Nothing about storage of your 187 MB of game files. Those are free and
  unlimited and stay exactly as they are.