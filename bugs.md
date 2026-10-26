# Bugs found

Every bug found while working on Mini Tank Legends (Oct 25–26, 2026), with
where it was and what happened to it. Status: **Fixed**, **Open** (known, not
fixed yet) or **Reverted** (a fix that caused problems and was rolled back).

Most were already in the game before these sessions; the few I introduced
myself are marked *(mine)*.

## Matches and game modes

| # | Bug | Where | Status |
|---|-----|-------|--------|
| 1 | Bots never fired at anyone in any team mode: the "is this an ally?" check compared a bot's team with **itself** (`me.team === me.team`), so every tank looked like a teammate. Every match ended 0 damage / 0 kills. | `js/bot.js` `_sweep` | Fixed |
| 2 | Bots had no objective in Capture the Circle — with no enemy in sight they wandered randomly, so teams never met and nobody stood in the zone. | `js/bot.js` | Fixed |
| 3 | Base Defend bots froze: `const target` was reassigned to the enemy base, which threw on every think, and the error was swallowed. | `js/bot.js` `decide` | Fixed |
| 4 | Base Defend bots treated the base like a tank (look for cover, peek, hold) and never advanced on it. | `js/bot.js` | Fixed |
| 5 | Tanks spawned outside the map's kill boundary on Last Frontier (spawns at x≈-450, boundary 345) and Core II — two-thirds of the field died on every respawn. | `js/game.js` `_fitWorldToMap`, `js/map-voting.js` | Fixed |
| 6 | Huge terrain pieces (hills, platforms up to 128×128) were registered as solid "cover", blocking bots' line of sight and paths across the middle of Paperland. | `js/world.js` | Fixed |
| 7 | Bots pathed straight into cliffs — the navigation grid had no idea of ground height (The Hill's plateau). | `js/bot-nav.js` | Fixed |
| 8 | Bots got stuck on props and kept ramming the same spot. | `js/bot.js` | Fixed |
| 9 | Bots stalked enemies they could no longer see instead of going for the zone on the bigger maps. | `js/bot.js` | Fixed |
| 10 | Bots never used their super abilities — supers only ran for the player. | `js/game.js` `_updateSupers` | Fixed |
| 11 | Every super could be used **once per match**: its `'done'` state was never cleared and blocked reactivation. | `js/tank.js` `activateSuper`, `js/game.js` | Fixed |
| 12 | Double's Minefield and Inferno's Molotov dropped an **airstrike** instead — the airstrike branch caught every targeting super. | `js/game.js` | Fixed |
| 13 | Minefield never started its cooldown (hidden by bug 11). | `js/game.js` | Fixed |
| 14 | Duplicate bot names on one scoreboard (two "Red Hellcat"s). | `js/game.js` | Fixed |
| 15 | PLAY did nothing after the first match: leaving a match wiped PLAY's click handler. | `js/menu.js` `_hidePlayCountdown` | Fixed |
| 16 | Endless "SEARCHING" when the match server was unreachable: a socket still *connecting* counted as connected. | `js/net.js` `_open` | Fixed |
| 17 | Escape opened the pause menu but could never close it. | `js/menu.js` | Fixed |
| 18 | A won Capture the Circle / Base Defend match was always recorded as a **loss** (no golden point, no box). | `js/game.js` | Fixed |
| 19 | The results screen showed the **previous** match's rewards (the battle was recorded after the screen read it). | `js/game.js` | Fixed |
| 20 | Elimination wins recorded the battle twice (double XP). | `js/game.js` | Fixed |

## Physics

| # | Bug | Where | Status |
|---|-----|-------|--------|
| 21 | Tanks flipped onto their backs/sides and never recovered — on The Hill more than half the tanks ended up upside down, spinning in place. | `js/tank.js` `_keepUpright` | Fixed |
| 22 | Physics used one variable-length step per frame: jittery contacts, tunnelling on slow frames, and the whole game in slow motion below 30 fps. Now equal sub-steps of at most 1/60 s. | `js/game.js` main loop | Fixed |
| 23 | Tanks could climb on top of each other and get stuck there. | `js/tank.js` `_unstack` | Fixed |
| 24 | *(mine)* First version of the anti-stacking fix shoved falling tanks off the map at spawn. | `js/tank.js` | Fixed |

## Camera and controls

| # | Bug | Where | Status |
|---|-----|-------|--------|
| 25 | Mouse aim was dead: the mouse movement was read twice per frame and the second (always zero) read pinned the turret to one direction. | `js/game.js` | Fixed |
| 26 | Camera turned the long way round (wrong angle wrapping for negative angles, 3 places). | `js/game.js` | Fixed |
| 27 | The strategic camera direction was never reset between matches. | `js/game.js` | Fixed |
| 28 | Uncaught pointer-lock error on phones every match. | `js/input.js` | Fixed |
| 29 | Camera settings and ◀ ▶ rotate buttons that did nothing after the camera change. | `js/menu.js`, `css/style.css` | Fixed (removed) |

## Menus, mobile and economy

| # | Bug | Where | Status |
|---|-----|-------|--------|
| 30 | Tall menus lost their top past the screen edge on phones (could not scroll to it). | `css/style.css` | Fixed |
| 31 | Several menus had no reachable back button on phones; the phone back gesture left the page. | `js/menu.js` | Fixed |
| 32 | Sandbox panel didn't scroll — map arrows unreachable. | `css/style.css` | Fixed |
| 33 | Login dialog had no close button and its top was cut off on phones. | `js/menu.js`, `css/style.css` | Fixed |
| 34 | Main-menu tank preview off-centre and oversized. | `js/menu.js` | Fixed |
| 35 | Garbled characters in player-visible text ("Team Deathmatch Ã¢â‚¬â€ Round 1") from double-encoded UTF-8. | `js/game.js`, `js/login-gate.js`, `css/style.css` | Fixed |
| 36 | Starter boxes were handed out again on every settings load (10 free boxes each time) — with upgrade points in boxes, an unlimited upgrade-point source. | `js/config.js` `ensureStarterBoxes` | Fixed |
| 37 | The four crate slots on the main menu were decorative — clicking them did nothing. | `index.html` | Fixed (now the win-box tracker) |
| 38 | "Turning speed" upgrade described itself as turret speed. | `js/upgrade-tree.js` | Fixed |

## Loading and stability

| # | Bug | Where | Status |
|---|-----|-------|--------|
| 39 | Intermittent dead start ("CONFIG is not defined"): game scripts were downloaded in parallel and **executed in arrival order**, not list order. | `index.html` script loader | Fixed |
| 40 | Errors thrown inside the match update are swallowed (logged at most 5 times as `FREEZE-GUARD`), which hid bug 3 completely. | `js/game.js` | Open — kept as a safety net; watch the console for `[FREEZE-GUARD]` |
| 41 | 18 harmless 404s on every boot from probing model files that never exist. | `js/game.js` | Fixed |
| 42 | `THREE.Sprite` raycast errors when placing Base Defend bases. | `js/base-defend.js` | Fixed |
| 43 | `assets/menu.mp3` is requested but has never existed (one 404 per menu visit). | `js/menu.js` | Open (harmless) |

## Multiplayer

| # | Bug | Where | Status |
|---|-----|-------|--------|
| 44 | Non-host players feel lag and get pulled back: the host re-simulates their tank from late input and corrects them toward it. | `js/game.js`, `js/tank.js`, `js/net.js` | Open — a fix exists in `dev/js/` |
| 45 | *(mine)* Copying the `dev/` netcode into the live game broke aiming, turrets, physics and the Mortar. | `js/` | Reverted |
| 46 | The `dev/` version of `spawnShot` used an undeclared variable — every shot would throw. | `dev/js/game.js` | Open in `dev/` only |

## Known limits (not bugs, but worth knowing)

- On The Hill, only one team's spawn sits near a ramp, so captures there are lopsided.
- Multiplayer has not been tested end-to-end in these sessions (it needs the online match server).
