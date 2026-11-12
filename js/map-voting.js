/* ============================================================
   map-voting.js — Pre-battle map voting overlay.

   WHAT WAS WRONG
   --------------
   Two separate complaints pointed at this one file.

   1) "I pick a map and get dumped back on the main menu, and only
      ~10 seconds later do I actually drop into the battle."

      The overlay ran a fixed countdown that ALWAYS ran to zero.
      Clicking a map card only recorded a vote (`_vote`); it never
      finalized. So picking a map did nothing at all for ten seconds,
      and because the overlay's backdrop is translucent you could see
      the main menu sitting behind it the whole time. That is exactly
      the "moved to main menu" symptom.

      FIX: picking a map ENDS the round. Vote, then finalize, then
      straight into the battle. There is no mandatory wait any more.

   2) "Both tabs are voting and it says 1 vote total, it should say 2."

      `_votes` was a purely local object. Each browser tab counted only
      its own vote, so two players voting on the same map produced two
      independent "1 vote" tallies that never met.

      The server has had a voting endpoint for a while now
      (POST /api/match/vote {playerId, map} -> {votes, tally, winner})
      but nothing ever called it. Now it does: votes are pushed to the
      server, the shared tally is polled back, and every tab renders the
      same numbers. Two players on the same map really do show "2".

   With more than one human in the match the round holds briefly so
   both players can vote and both drop into the SAME map -- one second
   of lock-in, and "all humans have voted" ends it early. Solo, it is
   instant.
   ============================================================ */

const MapVoting = (() => {
  /* =========================================================================
     THE ROSTER — Dream, Core, Core II, Last Frontier.

     THE ROSTER IS FIVE MAPS NOW. It was ten. Every extra card is another model
     the player might download, and the vote screen only has room to make a map
     legible at a glance. Four read at a glance; ten read as a spreadsheet.

     WHAT WAS REMOVED, AND WHY IT IS SAFE.

       default      Classic Arena had glb:null — it was never a real map, it was
                    "whatever the mode loads when nothing is chosen". There is
                    now always a real map on the card list.
       oldchool     Gone.  valley    Gone.  kamchatka  Gone.
       kaukaz       Gone.  kaukaz3   Gone.
       paperland    GONE FROM THE VOTE ONLY — THE FILE AND THE MODE STAY.

     PAPERLAND: GONE FROM THE VOTE ONLY — AND THIS IS A REAL REGRESSION, NOT
     THE NONE I FIRST DESCRIBED.

     The earlier note here said removing Paperland "does NOT break Base Defend",
     on the grounds that the mode hardcodes its own map. That was wrong, and it
     is worth writing down why it was wrong, because the mistake was reading
     config.js and stopping there:

         GAMEMODES.baseDefend.glbUrl = 'assets/maps/TL_paperland.glb'   <- the FALLBACK
         Game.startBaseDefend:  if(voted && voted.glb) glbUrl = voted.glb   <- actually used

     The config value is only reached when there is NO voted map. But a vote
     ALWAYS runs before Base Defend starts — Menu._startBaseDefendSafely does
     `game.setVotedMap(this._votedMap)` immediately before `startBaseDefend()`.
     So `_votedMap` is set in practice, and the voted map is what loads. The
     hardcoded URL was a fallback that, in normal play, was never reached.

     CONSEQUENCE. Paperland is the only map in the game that ships `base`
     entities — `bluebase` and `redbase001`. With it out of the roster, NO map
     this mode can be voted onto has one, so every Base Defend round now falls
     back to base-defend.js _resolvePlacements()'s automatic placement. The mode
     still works — bases appear, take damage and can be destroyed — but they are
     guessed positions rather than designed ones, and the HUD honestly labels
     them AUTO-PLACED rather than MAP ENTITY.

     The fix is in Game.startBaseDefend, not here. A vote for Base Defend is a
     vote for an arena; the objectives belong to the map that was designed to
     have them. See the note on that branch.

     THE FILES THEMSELVES ARE NOT DELETED. TL_paperland.glb and every other
     .glb stay in assets/maps: each removed map is one commented-out entry away
     from coming back, and silently deleting a model someone spent days on is
     not something a menu edit should do on its own. Paperland in particular
     must stay — it is the Base Defend map and the only one with real bases.
     ========================================================================= */

  const MAPS_BASE = [
    {
      id: 'dream',
      name: 'Dream',
      desc: 'A dreamlike landscape with pine forests.',
      /* UNCHANGED. Dream is one of the two survivors, so its numbers are exactly
         what they always were: 120x an authored ~6.09 units lands at ~731. */
      glb: 'assets/maps/TL_dream_map.glb',
      scale: 120,
      preview: null
    },
    {
      id: 'dreamland',
      name: 'Dreamland',
      desc: 'A dreamlike landscape.',
      glb: 'assets/maps/dreamland.glb',
      scale: 96,
      worldHalf: 146,
      preview: null
    },
    {
      id: 'signalmap',
      name: 'Signal Map',
      desc: 'Two flags. Hold both to win — whoever takes one holds it.',
      /* NEW. The only map with more than ONE flag node, and therefore the map
         that made capture-the-circle a multi-zone mode.

         SOURCE. Arrived as a 62MB .blend ("TL_signal map.blend") at the repo
         root, so unlike lastfrontier it was exported here rather than dropped
         in pre-built. Blender 3.6, glTF with export_yup -- the .blend is
         authored Z-up and the game is Y-up, and that conversion is what puts
         the teams on Z and the ground on Y. Verified in the export rather than
         assumed: after conversion the blue empties sit at z = -1.26, the red at
         z = +1.29, and both flags at z = -0.003, so the teams genuinely face
         each other across the ground plane instead of being stacked on it.

         The flat "void" plane was dropped on export. Every other shipped map
         leaves it out; it is a kill-plane helper, not arena geometry.

         SIZE, AND WHY IT IS NOT OBVIOUS. The authored arena is 11.57 x 2.27 x
         13.78 units, but the ACTION is not spread across it. All sixteen
         markers live in a 0.95 x 2.54 slab at the centre:

             blue / red   x -0.575 .. 0.371   z -1.286 .. 1.257
             flag / flag.001                   x -0.345 .. 0.341, z -0.003

         So there are two defensible scales and they differ by 2.5x:

           * scale ~50 makes the whole 13.78-unit terrain a sensible arena
             comparable to Last Frontier, but shrinks the flag-to-flag gap to
             ~34 units. With a capture radius of 12 the two rings would be
             barely two radii apart -- a single tank standing between them
             would be in both at once, and "capture both" would collapse into
             "capture once".

           * scale 120 spreads the action to 305 units, which is the number
             that matters, and puts the flags 82 units apart -- 3.4 capture
             radii of clean ground between them, so the zones are genuinely
             separate objectives that need holding at the same time.

         120 is chosen for that reason, and it also keeps the zone-to-arena
         proportion at 7.9%, within a whisker of Core II's 7.5%, so the ring
         reads at the same size on this map as on the map players already know
         how to judge distance on.

         worldHalf is DECLARED rather than derived, and it is the one number
         here worth changing first if the arena feels wrong. Derived from the
         terrain it would be ~890 -- a 1780-unit arena whose fight is a
         305-unit island in the middle, which would make the ring microscopic
         and the minimap mostly scenery. 260 puts the boundary a clear margin
         outside the furthest spawn (~165 units) so nobody is ever stopped by
         an invisible wall during a normal fight, while keeping the arena
         honest about where the action is. */
      glb: 'assets/maps/TL_signal_map.glb',
      scale: 120,
      worldHalf: 260,
      preview: null
    },
    {
      id: 'hill',
      name: 'The Hill',
      desc: 'A grassy hill between pine lines — 7 vs 7 around one flag.',
      /* NEW. Arrived pre-built (TL/TL_the hillfix.glb, exported from Blender,
         glTF Y-up), so it needed no conversion, just a decision about scale:
         it is copied into assets/maps under the same name it shipped with —
         the space IS the name, and the precedent is "last frontier.glb",
         which shipped with one and kept it.

         SCALE = 120, measured with tools/glb-measure.mjs, which applies the
         full node transform chain to every POSITION accessor and prints the
         real extents the way glb-arena.ps1 did for core2. The authored
         terrain is 2.884 x 2.819 units (0.423 tall), so x120 lands at
         ~346 x 338 units — Kaukaz-sized, halfway between Core (241) and
         Last Frontier (639).

         worldHalf = 187 is the derived boundary, 346 / 2 x 1.08. It has to be
         DECLARED because _fitWorldToMap floors every boundary at 500, and a
         346-unit arena under that floor would let a tank drive 170 units past
         the visible edge of the map and fall.

         THE SPAWNS ARE AUTHORED, 7v7 — seven `blue` empties, seven `red`, one
         `flag`, all found BY NAME by _parseGLBSpawns, with the two teams
         facing each other across the y=0 line (blue cluster +Z, red cluster
         -Z, flag at the centre). Renaming any of those nodes on a future
         export silently drops them; see the same warning on core2.

         FOLIAGE: 19 authored `Pine_2.*` trees and 19 `taiga` scrub bushes.
         Both names ride the engine's foliage classification — which as of
         this map reads pines as TREES (wind, no collider, no shadow map,
         ground-shadow blobs) and taiga as BUSHES (the full bush stack:
         camouflage, wind and contact shake, noPhysics, natural orientation,
         instancing). See the naming-convention comment in world.js. */
      glb: 'assets/maps/TL_the hillfix.glb',
      scale: 120,
      worldHalf: 187,
      preview: null
    },
    {
      id: 'shootingrange',
      name: 'Shooting Range',
      desc: 'Open range — 4 flags, 7 vs 7.',
      glb: 'assets/maps/TL_shooting_range_opt.glb',
      scale: 120,
      worldHalf: 351,
      captureTime: 50,
      preview: null
    },
    {
      id: 'kaukaz',
      name: 'Kaukaz',
      desc: 'Steal the enemy flag and run it home — 5 vs 5 capture the flag.',
      /* BACK IN THE ROSTER, REBUILT. The old kaukaz cards were removed when the
         vote was trimmed to five maps (see the removal table in the header);
         this is a NEW model — assets/maps/kaukaz.glb, measured with
         tools/glb-measure.mjs:

           terrain   346 x 521 units at scale 120, floor at y ~ -42
           markers   5 `blue` on the +x side, 5 `red` on the -x side, both
                     clusters at z +372..430 — i.e. the teams face each other
                     ACROSS the x axis, not the z axis
           flags     TWO `flag` nodes, one inside each spawn cluster:
                     flag.002 at (-88, 388) on the red side, flag.003 at
                     (+95, 409) on the blue side

         SCALE 120. Same decision as Signal Map and The Hill: it is the number
         the whole engine's props, shells and foliage already assume, and it
         puts the flag-to-flag distance at ~184 units — long enough that a run
         home is a chase, not a shove.

         worldHalf 470, DECLARED. Derived from the terrain it would be 640,
         because the model's ground extends to z = 593 while every ACTION —
         spawns and both flags — lives inside z ~ 455. A 640 boundary would
         let a tank keep going 200 units past the last spawn marker into empty
         scenery; 470 puts the kill boundary just past the fight (the
         boundary-kill in Game.update runs at `world.half - 10`), and
         _clampSpawnsToMap widens it on its own if a future export pushes a
         spawn further out. */
      glb: 'assets/maps/kaukaz.glb',
      scale: 120,
      worldHalf: 470,
      preview: null
    },
    {
      id: 'spacestation',
      name: 'Spacestation',
      desc: 'Knockout inside a steel station — 5 vs 5. Flags if the map has them.',
      /* NEW. Shipped pre-built as TL/spacestation.glb (glTF, Y-up). Measured
         in the engine itself (three.js Box3 over the loaded scene) at 2.18 x
         1.06 x 2.15 authored units, so x120 lands at ~261 x 258 — between The
         Hill (346) and the Circle's arena, which is the right size for a 5v5
         knockout box.

         MEASURED IN THE ENGINE, not with tools/glb-measure.mjs: that tool takes
         each accessor's min/max and scales it, which is wrong for a node that
         carries BOTH a non-uniform scale and a rotation — a box has to be
         rotated corner by corner. On prototype.glb it reported 3.52 units long
         where the loaded model is 2.05, and a boundary derived from that would
         sit a hundred units outside the map.

         SPAWNS ARE AUTHORED 5v5: five `blue` empties at x ~ +0.9 (z +0.35..+0.95)
         and five `red` at x ~ -0.6 (z -0.55..-0.92), i.e. the teams face each
         other across BOTH axes, not down one lane. Six `bush` nodes ride the
         engine's bush stack as cover.

         ONE `flag` AT THE ORIGIN — which is why this map is offered for Steal
         the Flag. The mode gives a bare flag to the nearest spawn cluster and
         auto-places the other side's flag behind its own spawns, so the map
         plays without a second authored flag; it just loses that label.

         worldHalf 152 is DECLARED, and it is the engine's own derived number:
         the loaded box runs x -120.5..140.9, z -134.7..123.3, so the half is
         140.9 (it is measured from the ORIGIN, not from the centre) and the
         boundary is 140.9 x 1.08 = 152. Stated here because Gladiator sizes its
         zone from world.half BEFORE the map loads and would otherwise see the
         500 floor. */
      glb: 'assets/maps/spacestation.glb',
      scale: 109,
      worldHalf: 138,
      /* Knockout and Capture the Flag, which is what the brief for this map
         said. The menu's spelling is used ('team-deathmatch'); _normMode makes
         either spelling work regardless. */
      modes: ['team-deathmatch', 'stealFlag'],
      preview: null
    },
    {
      id: 'prototype',
      name: 'Prototype',
      desc: 'Knockout and capture the flag on a test-range blockout — 5 vs 5.',
      /* NEW. TL/prototype.glb, measured the same way (loaded scene, three.js
         Box3): 2.13 x 0.85 x 2.05 authored units, so x120 is ~256 x 246 —
         The Hill's footprint with a third of its height, which is what a bare
         blockout should be.

         SPAWNS: five `blue` at x ~ -0.75, five `red` at x ~ +0.8, so the teams
         line up across x and fight down the length.

         TWO FLAGS, authored as `FLAG` and `FLAG.001` (uppercase — the loader
         lowercases names before matching, so they are found). Both sit near the
         centre line at x 0, z 0.21 and 0.9, which lands one with each side's
         spawn cluster: blue's nearest is FLAG (0.76 units away vs 0.81) and
         red's is FLAG.001 (1.12 vs 1.14). That is a midfield-flag match rather
         than a run-the-length-of-the-map one, and it is what the author drew.

         The map is named Prototype and IS one: no plants, no cover set, plain
         blockout geometry. It exists to test the two modes on, which is exactly
         what `modes` below says.

         worldHalf 140 is DECLARED, the engine's derived number again: the box
         runs x -129.2..126.6, z -120.8..124.7, half 129.2, x 1.08 = 140. Same
         reason as spacestation's — the 500 floor would sit far outside the
         model, and Gladiator reads world.half before the load. */
      glb: 'assets/maps/prototype.glb',
      scale: 120,
      worldHalf: 140,
      modes: ['team-deathmatch', 'stealFlag'],
      preview: null
    }
  ];

  /* The live roster the vote screen renders. Starts as the built-in list and
     grows with dropped-in maps (below) on every refresh. */
  let MAPS = MAPS_BASE.slice();

  /* =======================================================================
     DROP-IN MAPS — a .glb in assets/maps/custom/ shows up on the vote
     screen by itself. No code change.

     HOW: the local server (server/mpserver.js) lists that folder at
     /api/maps/custom on every request, so a file copied in or replaced is
     live on the very next lobby. Anything the file name offers — spaces,
     unicode — is fine; the endpoint ships the URL encoded and static serving
     decodes it. Spawn/markers follow the existing convention the engine
     already parses: nodes named `blue`/`red` (spawn clusters), `flag`.

     SCALE / WALLS. scale defaults to 120 like the rest of the roster and
     worldHalf is left undeclared on purpose: _fitWorldToMap derives the
     boundary from the model's own extents after load, the same path every
     map without a declared boundary already takes. If a particular map
     deserves hand-picked numbers, drop a <samename>.json sidecar next to
     the .glb:

        { "name": "Cold Ridge", "desc": "one-line card blurb",
          "scale": 140, "worldHalf": 460, "preview": "thumb.jpg" }

     On a static host (the pages deploy) /api/maps/custom does not exist —
     the fetch 404s and the game runs the built-in roster exactly as before.
     A silent skip, never an error. */
  const CUSTOM_URL = 'api/maps/custom';
  let _customSig = '';        /* last list we applied — repaint only on change */

  function _referer(){ return 'assets/maps/custom/'; }

  function _customEntries(raw){
    if(!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for(const m of raw){
      try {
        if(!m || typeof m.url !== 'string' || !m.url) continue;
        if(typeof m.id !== 'string' || seen.has(m.id)) continue;
        seen.add(m.id);
        out.push({
          id: m.id,
          name: (typeof m.name === 'string' && m.name.trim())
            ? m.name.trim().slice(0, 40)
            : decodeURIComponent(m.url).replace(/\.glb$/i, '').replace(/[_-]+/g, ' ').trim(),
          desc: (typeof m.desc === 'string' && m.desc.trim())
            ? m.desc.trim().slice(0, 80)
            : 'Custom map — dropped into assets/maps/custom.',
          glb: _referer() + m.url,
          scale: (Number.isFinite(m.scale) && m.scale > 0) ? m.scale : 120,
          worldHalf: (Number.isFinite(m.worldHalf) && m.worldHalf > 0) ? Math.round(m.worldHalf) : undefined,
          preview: (typeof m.preview === 'string' && m.preview) ? _referer() + m.preview : null
        });
      } catch(e){ /* one bad entry never kills the list */ }
    }
    return out;
  }

  /* Re-list the folder and, if the roster actually changed, say so. Called
     from boot and re-called every time a vote screen opens — when a file name
     showed up mid-session it lands on the cards that round. */
  async function refreshCustomMaps(){
    let list = null;
    try {
      const r = await fetch(CUSTOM_URL, { cache: 'no-store' });
      if(r.ok){
        const d = await r.json();
        if(d && Array.isArray(d.maps)) list = d.maps;
      }
    } catch(e){ /* static host / server down -> built-in roster, as always */ }
    const entries = _customEntries(list || []);
    const sig = entries.map(m => m.id).join('|');
    if(sig === _customSig) return false;
    _customSig = sig;
    MAPS = MAPS_BASE.concat(entries);
    console.log('[vote] custom maps:', entries.map(m => m.id).join(', ') || '(none)');
    return true;
  }

  /* Listed as soon as the page loads, so the FIRST vote screen already has
     the folder's contents rather than waiting on the call in _show(). */
  const _bootCustom = refreshCustomMaps();

  /* Every round lasts exactly this long, whether you are alone or not, and
     whether or not everyone has voted. It is the single thing that ends the
     round, so nobody is ever locked out of a vote by clicking faster than
     somebody else. */
  const VOTE_DURATION = 15;   /* was 10 -- too little time to read six maps */

  let _overlay = null;
  let _cardsEl = null;
  let _timerEl = null;
  let _labelEl = null;
  let _votes = {};
  let _remoteVotes = {};
  let _myVote = null;
  let _onComplete = null;
  let _finishTimer = null;
  let _pollTimer = null;
  let _totalTimer = null;
  let _finalized = false;
  let _startedAt = 0;
  let _multiplayer = false;
  let _playerId = null;
  let _workerUrl = null;
  /* The match code, which is what the vote endpoint actually keys on. The old
     fetch body only sent playerId, and the server had no /vote route that
     accepted it, so every shared vote silently 404'd. */
  let _matchCode = null;
  /* How many real humans are actually in this match. Drives the lock-in: a
     solo player (or a bot-filled queue) picks a map and goes straight in, two
     or more get a short shared window so both can vote and both land on the
     same map. */
  let _expectedHumans = 1;

  /* Keep the last rendered state so the countdown can be painted from the
     rAF-free interval below without re-rendering the DOM every tick. */
  let _lastLabel = null;

  /* WHICH MAPS A MODE CAN ACTUALLY PLAY.

     This used to be a single pin — Steal the Flag was hard-wired to kaukaz,
     because kaukaz was the only map that shipped a `flag` node per base. That
     stopped being true the moment a second map arrived with flags, and a pin
     cannot express "this map is good for two modes, that one for three".

     So a map may now DECLARE the modes it is built for:

         modes: ['teamDeathmatch', 'stealFlag']

     and the vote screen offers a map when it either declares nothing (the
     original behaviour — everything plays everywhere) or names the mode being
     voted on. A map that declares nothing is never filtered, so no existing
     card changes. A renamed/removed map can never empty the screen either: if
     the filter leaves nothing, the full roster is offered rather than a blank
     vote nobody can complete. */
  let _modeFilter = null;
  let _limitOverride = null;

  /* MODES THAT MAY ONLY RUN ON NAMED MAPS.

     Steal the Flag is the one mode that cannot be improvised: it needs a `flag`
     entity standing where each team's base is. A map without authored flags
     still "works" — the mode auto-places one behind each spawn cluster — but
     that is a rescue path, not a designed objective, and the mode is balanced
     around the flag-to-flag gap.

     So the CTF vote is the maps that ship flags: kaukaz (flag.002 + flag.003,
     one in each base) plus the two blockouts added alongside this list —
     spacestation (one central `flag`, the other side auto-placed) and prototype
     (FLAG + FLAG.001, one per side). A map id that is renamed simply drops off
     this list until it is renamed here too.

     Every other mode takes the whole roster, minus any map that has narrowed
     itself with a `modes` array. */
  const MODE_MAPS = {
    stealflag: ['kaukaz', 'spacestation', 'prototype'],
  };

  /* MODE IDS ARE SPELLED TWO WAYS IN THIS CODEBASE, so they are compared with
     the punctuation and case stripped. The menu's mode buttons use
     'team-deathmatch' while GAMEMODES keys that same mode 'teamDeathmatch',
     and `opts.mode` is whatever `_selectedGamemode` holds — the MENU spelling.
     A literal indexOf against a def that says 'teamDeathmatch' would therefore
     filter Team Deathmatch's own new maps straight out of its own vote, which
     is a silent empty hand: the map would simply never appear. */
  function _normMode(m){
    return String(m || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  function _roster(){
    if(!_modeFilter) return MAPS;
    const want = _normMode(_modeFilter);
    const allow = MODE_MAPS[want] || null;
    const fits = MAPS.filter(m => {
      if(allow && allow.indexOf(m.id) < 0) return false;
      /* A map that declares its modes only plays those. */
      if(Array.isArray(m.modes) && m.modes.length &&
         !m.modes.some(x => _normMode(x) === want)) return false;
      return true;
    });
    return fits.length ? fits : MAPS;   /* a renamed map must never empty the screen */
  }

  function _init(){
    _overlay = document.getElementById('map-vote-overlay');
    _cardsEl = document.getElementById('mv-cards');
    _timerEl = document.getElementById('mv-timer');
    _labelEl = document.getElementById('mv-votes-label');
  }

  function _renderCards(){
    _cardsEl.innerHTML = '';
    _roster().forEach(map => {
      const card = document.createElement('div');
      card.className = 'mv-card';
      card.dataset.mapId = map.id;

      const preview = document.createElement('div');
      preview.className = 'mv-card-preview';
      if(map.preview){
        preview.style.backgroundImage = 'url(' + map.preview + ')';
      } else {
        preview.style.background = _gradientForMap(map.id);
      }

      const votesEl = document.createElement('div');
      votesEl.className = 'mv-card-votes';
      votesEl.id = 'mv-votes-' + map.id;
      votesEl.textContent = '0';

      const info = document.createElement('div');
      info.className = 'mv-card-info';
      info.innerHTML = '<div class="mv-card-name">' + map.name + '</div><div class="mv-card-desc">' + map.desc + '</div>';

      card.appendChild(preview);
      card.appendChild(votesEl);
      card.appendChild(info);

      card.addEventListener('click', () => _vote(map.id));
      _cardsEl.appendChild(card);
    });
  }

  /* Placeholder art for a map card with no preview image.
     These are gradients only — no map in the roster ships one — and they are
     there so a card is never a flat grey rectangle. Each one is picked to match
     what the map actually looks like, because on a four-card screen the colour
     is most of what tells them apart. */
  function _gradientForMap(id){
    const grads = {
      /* Purple: the dreamlike one, unchanged from before. */
      'dream': 'linear-gradient(135deg, #3a1e5a 0%, #5a2e7a 50%, #4a246a 100%)',
      'dreamland': 'linear-gradient(135deg, #2a4a6a 0%, #4a7aaa 50%, #3a5a8a 100%)',
      /* Green: forest and grass cover. */
      /* Concrete and metal — deliberately desaturated against Core's green, so
         the two 7v7 maps do not read as the same card. */
      /* Cold: snow, with the stone of the church and the village behind it. */
      /* Hill: grass rising into a dry, sunlit crown — distinct from Core's
         deep forest green and from Last Frontier's cold stone. */
      'hill': 'linear-gradient(135deg, #24561f 0%, #4e7a33 45%, #93a05a 100%)',
      /* Shooting range: neutral grey-green field. */
      'shootingrange': 'linear-gradient(135deg, #3a4a3a 0%, #5a6a5a 45%, #7a7a6a 100%)',
      /* Kaukaz: two bases across a contested ridge — a cold purple into an
         amber midtone, so it reads as neither the Circle's blue-green roster nor
         the Hill's grass card and is distinct at a glance from the other six. */
      'kaukaz': 'linear-gradient(135deg, #2a2440 0%, #4a3a6a 45%, #7a5a3a 100%)',
      /* Spacestation: steel hull plates and cold interior lighting — blue-grey
         with a warm strip of corridor light through the middle. */
      'spacestation': 'linear-gradient(135deg, #1c2430 0%, #3c5064 45%, #a08a5a 100%)',
      /* Prototype: bare test-range grey with an unfinished amber warning stripe
         — the map is a blockout, so the card says so. */
      'prototype': 'linear-gradient(135deg, #2a2a28 0%, #55564f 45%, #8a7a3a 100%)'
    };
    /* Flat grey for a map with no entry reads as "unfinished", which is the
       honest signal if someone adds a map and forgets this table. */
    /* Flat grey only ever covered the KNOWN ids that lack an entry. A custom
       map gets a stable gradient derived from its own id instead, so five
       dropped maps are five distinguishable cards rather than five greys. */
    if(id && id.indexOf('custom-') === 0){
      let h = 0;
      for(let i = 7; i < id.length; i++){ h = (h * 31 + id.charCodeAt(i)) >>> 0; }
      const h1 = h % 360, h2 = (h1 + 45) % 360, h3 = (h1 + 210) % 360;
      return 'linear-gradient(135deg, hsl(' + h1 + ',38%,24%) 0%, hsl(' + h2 + ',42%,40%) 50%, hsl(' + h3 + ',34%,30%) 100%)';
    }
    return grads[id] || 'linear-gradient(135deg, #333, #555)';
  }

  /* Paint (or repaint) the vote list from the current MAPS. The one block
     that clears, seeds and renders — factored out because a custom map that
     lands in the folder between refreshes triggers a second call mid-round. */
  function _paintVoteList(){
    /* A repaint that happens after the player already voted must carry that
       vote forward, or the tally silently loses it. */
    const keep = _myVote;
    _votes = {};
    _roster().forEach(m => _votes[m.id] = 0);
    if(keep) _votes[keep] = 1;
    _renderCards();
    _syncUI();
  }

  function _isMultiplayer(){
    return _multiplayer && !!_workerUrl && !!_playerId;
  }

  /* Push my vote to the server so every tab in this match can see it.

     This goes over the WebSocket now, not fetch(). Polling /api/match/status
     once a second to discover a vote that had already happened was the old
     design; it cost a request per player per second for the whole vote and
     still showed stale numbers for up to a second. The server now pushes the
     tally to everyone in the match the moment it changes (Net.onVote), so the
     numbers on screen are the numbers on the server. */
  function _publishVote(mapId){
    if(!_isMultiplayer()) return;
    try {
      if(typeof Net !== 'undefined' && typeof Net.sendVote === 'function'){
        Net.sendVote(mapId);
        return;
      }
    } catch(e){ /* fall through to the HTTP path below */ }

    /* Fallback for a page without the socket transport. The vote still counts
       locally; it just is not shared. Never let this stop the match starting. */
    try {
      fetch(_workerUrl + '/api/match/vote', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({playerId: _playerId, code: _matchCode, map: mapId}),
      }).then(r => r.json()).then(d => { if(d && d.ok) _applyRemote(d); }).catch(()=>{});
    } catch(e){}
  }

  /* Server-pushed tally. Wires up once, on first show. */
  let _voteHooked = false;
  function _hookNetVotes(){
    if(_voteHooked) return;
    if(typeof Net === 'undefined' || typeof Net.onVotes !== 'function') return;
    _voteHooked = true;
    Net.onVotes((votes) => {
      _applyRemote({ votes: votes });
    });
  }

  function _applyRemote(data){
    if(!data) return;
    if(data.votes && typeof data.votes === 'object') _remoteVotes = data.votes;
    _syncUI();
  }

  /* No polling.

     The server pushes the shared tally to every client in the match whenever a
     vote lands (see _hookNetVotes), so there is nothing to poll for. The old
     1Hz /api/match/status poll existed only because the vote was published over
     fetch and nobody had a push channel -- it cost a request per player per
     second for the whole round and still lagged a second behind.

     The fallback poll is kept for a page with no socket transport, and is
     skipped entirely whenever the push hook is in place. */
  function _startVotePolling(){
    _stopVotePolling();
    if(!_isMultiplayer()) return;
    _hookNetVotes();
    if(_voteHooked) return;          /* push channel is live; nothing to poll */
    _pollTimer = setInterval(async () => {
      if(_finalized || !_isMultiplayer()) return;
      try {
        const resp = await fetch(_workerUrl + '/api/match/status?playerId=' + _playerId);
        const data = await resp.json();
        if(data && data.mapVote) _applyRemote({votes: data.mapVote});
      } catch(e){ /* transient network error; next tick tries again */ }
    }, 1000);
  }

  function _stopVotePolling(){
    if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }
  }

  function _tallyFor(mapId){
    /* One vote for me plus one for every OTHER player the server has heard
       from. My own playerId is counted by _votes, not by the remote map, so
       the two can never double-count. */
    let n = (_votes[mapId] || 0);
    for(const id in _remoteVotes){
      if(id === _playerId) continue;
      if(_remoteVotes[id] === mapId) n++;
    }
    return n;
  }

  function _totalVotes(){
    let t = 0;
    _roster().forEach(m => { t += _tallyFor(m.id); });
    return t;
  }

  function _remoteCount(){
    let n = 0;
    for(const id in _remoteVotes){ if(id !== _playerId) n++; }
    return n;
  }

  function _vote(mapId){
    if(_finalized) return;
    if(_myVote === mapId) return;
    if(_myVote !== null) _votes[_myVote] = Math.max(0, (_votes[_myVote] || 0) - 1);
    _myVote = mapId;
    _votes[mapId] = (_votes[mapId] || 0) + 1;
    _syncUI();
    if(Audio && Audio.click) Audio.click();

    /* Share it, then decide whether we can go now. */
    _publishVote(mapId);
    _maybeFinishEarly();
  }

  /* The vote ALWAYS runs the full VOTE_DURATION.

     It used to cut short the moment every human had voted -- and, when playing
     alone, the instant you touched a card. Both were wrong:

       * a 1-1 tie is common with two players, and whoever had not clicked yet
         was locked out of the round entirely;
       * with two players it ended the round in well under a second, so the
         shared tally was never actually seen -- it flashed past;
       * solo, the whole vote screen appeared and vanished in one frame, which
         reads as the UI glitching.

     Voting early now only records the choice and shows it on the cards. The
     timer is the single thing that ends the round, so every player gets the
     same 10 seconds to see the others' picks before the map is locked. */
  function _maybeFinishEarly(){
    /* Intentionally does not finalize. Kept as a call site so _vote() stays
       readable; the timer in _startTimer() owns the ending of the round. */
  }

  function _syncUI(){
    const totalVotes = _totalVotes();

    _roster().forEach(m => {
      const el = document.getElementById('mv-votes-' + m.id);
      if(el) el.textContent = _tallyFor(m.id);

      const card = _cardsEl.querySelector('[data-map-id="' + m.id + '"]');
      if(card){
        card.classList.toggle('voted', _myVote === m.id);
      }
    });

    if(_labelEl){
      let text;
      if(_roster().length === 1){
        /* One arena: there is nothing to tally, so say what the round is. */
        const only = _roster()[0];
        text = only.name + ' is the only arena this mode is built for';
      } else if(_myVote){
        const chosen = MAPS.find(m => m.id === _myVote);
        text = 'You voted for ' + chosen.name + ' — ' + totalVotes + ' total vote' + (totalVotes !== 1 ? 's' : '');
      } else {
        text = 'Tap a map to vote! ' + totalVotes + ' vote' + (totalVotes !== 1 ? 's' : '');
      }
      if(_isMultiplayer()){
        const others = _remoteCount();
        if(others > 0) text += ' (' + others + ' other player' + (others !== 1 ? 's' : '') + ' voting)';
      }
      /* Only touch the DOM when the text really changed: this runs on every
         vote sync and rewriting identical text still costs a layout pass. */
      if(text !== _lastLabel){
        _labelEl.textContent = text;
        _lastLabel = text;
      }
    }
  }

  /* One timer for the whole round, and it always runs the FULL VOTE_DURATION.

     There used to be two different lengths: a 3s MULTIPLAYER_LOCKIN for a
     multiplayer round and the full 10s for a solo one -- and the displayed
     countdown did not even agree with the limit it was counting down to,
     because the number shown was VOTE_DURATION while the round ended on the
     shorter lock-in. So the timer visibly said 8 while the round ended at 0.6
     seconds.

     Now the limit IS VOTE_DURATION, always, and the number on screen is the
     number that actually ends the round. */
  function _startTimer(){
    _startedAt = Date.now();
    const limit = _limitOverride || VOTE_DURATION;

    const step = () => {
      if(_finalized) return;
      const elapsed = (Date.now() - _startedAt) / 1000;

      const secs = Math.max(0, Math.ceil(limit - elapsed));
      if(_timerEl){
        /* The countdown always counts down to the round's end.

           It used to turn into a tick mark the moment you voted, which hid the
           time actually remaining -- so a player who voted early saw "✓" and
           had no idea whether the round was about to close or had ten seconds
           left. The ring still shows the remaining time either way. */
        _timerEl.textContent = String(secs);
        _timerEl.style.setProperty('--timer-pct', (Math.min(1, (limit - elapsed) / limit) * 100) + '%');
        if(_myVote === null) _timerEl.style.background = '';
      }

      if(elapsed >= limit) _finalize();
    };
    step();
    _totalTimer = setInterval(step, 200);
  }

  function _stopTimers(){
    if(_totalTimer){ clearInterval(_totalTimer); _totalTimer = null; }
    if(_finishTimer){ clearTimeout(_finishTimer); _finishTimer = null; }
    _stopVotePolling();
  }

  /* Highest tally wins. Ties break on the local vote, then at random, so two
     players who picked different maps still agree on one map. */
  function _pickWinner(){
    const roster = _roster();
    if(roster.length === 1) return roster[0].id;
    let bestId = null, best = -1;
    roster.forEach(m => {
      const t = _tallyFor(m.id);
      if(t > best){ best = t; bestId = m.id; }
    });
    if(best <= 0){
      return roster[Math.floor(Math.random() * roster.length)].id;
    }
    const tied = roster.filter(m => _tallyFor(m.id) === best).map(m => m.id);
    if(tied.length === 1) return tied[0];
    if(_myVote && tied.indexOf(_myVote) >= 0) return _myVote;
    return tied[Math.floor(Math.random() * tied.length)];
  }

  function _finalize(){
    if(_finalized) return;
    _finalized = true;
    _stopTimers();

    const winnerId = _pickWinner();
    const winner = MAPS.find(m => m.id === winnerId) || _roster()[0];

    MAPS.forEach(m => {
      const card = _cardsEl.querySelector('[data-map-id="' + m.id + '"]');
      if(!card) return;
      if(m.id === winnerId){
        card.classList.add('winner');
      } else {
        card.style.opacity = '0.3';
        card.style.transform = 'scale(0.95)';
        card.style.pointerEvents = 'none';
      }
    });

    /* Gold, not the old green — the winner card, the label and the ring are all
       gold now, and the wipe that follows is gold too. One accent per screen. */
    if(_labelEl){
      _labelEl.textContent = '⚡ ' + winner.name + ' selected!';
      _labelEl.style.color = '#ffd257';
      _lastLabel = _labelEl.textContent;
    }
    if(_timerEl){
      _timerEl.textContent = '✓';
      _timerEl.style.setProperty('--timer-pct', '100%');
      _timerEl.style.background = '#ffd257';
      _timerEl.style.color = '#1a1208';
    }

    /* A short beat so the winning card is visible, then the wipe covers the
       screen, then straight in.

       The 50ms that used to sit between the hide and the callback is gone: the
       wipe IS that gap now, and it does the job better — during those 50ms the
       main menu was visible through a cut, which is the exact thing the wipe
       exists to stop. The winner card is on screen for 700ms first, so the
       result is still readable before anything moves. */
    _finishTimer = setTimeout(() => {
      _hide(() => {
        const cb = _onComplete;
        _onComplete = null;
        if(cb) cb(winner);
      });
    }, 700);
  }

  /* THE WIPE.
     Two halves of one motion: a gold bar sweeps in from the left to reveal the
     vote screen, and sweeps back out to the left to take it away.

     The reason it is a class on the overlay rather than a CSS transition on
     the overlay itself is that the overlay is toggled with .hidden, which is
     display:none. Nothing can transition out of display:none, so the old
     opacity fade could only ever run on the way IN and never on the way out —
     which is why closing used to feel like a cut. Driving the bar explicitly
     gives both halves.

     _wipeState exists because the animation's own end has to be observed, and
     `animationend` fires for EVERY animation on the element and its children.
     The bar is one element with one animation, but the vote screen behind it
     animates too (the card stagger, the content fade), so filtering by the
     target and the animation name is not optional — without it the first card
     to finish its entrance would dismiss the whole screen. */
  /* These MUST match the animation durations in CSS (.mv-wipe-in / .mv-wipe-out).
     They are the fallback for animationend not firing, so if they drift longer
     than the CSS the panel sits mid-wipe for the difference — which is how the
     bar ended up parked across the screen the first time. Kept here as the
     single place to change when the CSS timing changes; the CSS comment on
     .mv-wipe says the same numbers and why they are what they are.

     IN  0.22s, OUT 0.18s. Deliberately quick: the vote round is ten seconds
     total and a curtain that takes half a second is a tenth of the round spent
     on a transition nobody asked to watch. */
const WIPE_IN_MS = 220;
  const WIPE_OUT_MS = 180;
  let _wipeState = null;          // 'in' | 'out'
  let _hideAfterWipe = null;      // callback queued by an interrupted 'in'

  function _wipeEl(){
    return _overlay ? _overlay.querySelector('.mv-wipe') : null;
  }

  function _wipeIn(){
    const w = _wipeEl();
    if(!w) return;
    /* An 'out' already running means the screen is on its way away; cancel it
       and come back in rather than stacking two animations on one transform. */
    _overlay.classList.remove('mv-wipe-out');
    _overlay.classList.add('mv-wipe-in');
    _wipeState = 'in';

    const done = function(e){
      /* Only this bar's own animation ends the wipe — see _wipeState above. */
      if(e.target !== w || e.animationName !== 'mvWipeIn') return;
      w.removeEventListener('animationend', done);
      /* REMOVE THE CLASS. This is the whole fix, and leaving it on is what
         breaks the screen.

         The animation is declared `both`, so it fills FORWARD from its last
         keyframe once it finishes — and the last keyframe of mvWipeIn is
         translateX(0), i.e. the bar sitting exactly across the screen. Holding
         `mv-wipe-in` therefore parks a full-screen gold panel over the entire
         vote UI for the whole round, with no way to dismiss it.

         Removing the class drops it back to the
         `:not(.mv-wipe-in):not(.mv-wipe-out)` rule, which parks the bar off the
         left edge. The comment here used to say the class "stays so the CSS
         keeps it out of the way", which is backwards: keeping it is precisely
         what puts the bar ON the screen. */
      _overlay.classList.remove('mv-wipe-in');
      _wipeState = null;
      /* A hide that arrived while we were still wiping in. */
      if(_hideAfterWipe){
        const cb = _hideAfterWipe;
        _hideAfterWipe = null;
        _wipeOut(cb);
      }
    };
    w.addEventListener('animationend', done);

    /* The same belt-and-braces the wipe-out has, and for a much worse failure:
       if this one does not fire, the bar is left sitting ACROSS THE SCREEN with
       the vote UI completely unreachable behind it. A backgrounded tab can
       swallow animationend, so "it always fires" is not a safe assumption for
       the one failure that bricks the screen.

       Guarded on _wipeState so it cannot fight the real handler — whichever
       runs first clears the state and the other becomes a no-op. */
    setTimeout(function(){
      if(_wipeState !== 'in') return;
      _overlay.classList.remove('mv-wipe-in');
      _wipeState = null;
      if(_hideAfterWipe){
        const cb = _hideAfterWipe;
        _hideAfterWipe = null;
        _wipeOut(cb);
      }
    }, WIPE_IN_MS + 100);
  }

  function _wipeOut(then){
    const w = _wipeEl();
    if(!w){ if(then) then(); return; }

    /* Ask to leave during the wipe-in: wait for it to finish, then go. Without
       this, opening and closing inside half a second leaves the class in the
       wrong state and the bar is stuck across the screen. */
    if(_wipeState === 'in'){ _hideAfterWipe = then; return; }

    _overlay.classList.remove('mv-wipe-in');
    _overlay.classList.add('mv-wipe-out');
    _wipeState = 'out';

    const done = function(e){
      if(e.target !== w || e.animationName !== 'mvWipeOut') return;
      w.removeEventListener('animationend', done);
      _overlay.classList.remove('mv-wipe-out');
      _wipeState = null;
      if(then) then();
    };
    w.addEventListener('animationend', done);

    /* The belt-and-braces timeout. If the tab is backgrounded mid-animation the
       browser may not deliver animationend at all, and the callback that drops
       the player into the battle MUST run. Firing twice is harmless because
       _finalize already latches and the callback is nulled. */
    setTimeout(function(){
      if(_wipeState !== 'out') return;
      _wipeState = null;
      _overlay.classList.remove('mv-wipe-out');
      if(then) then();
    }, WIPE_OUT_MS + 80);
  }

  function _show(opts){
    _init();
    _votes = {};
    _remoteVotes = {};
    _myVote = null;
    _finalized = false;
    _lastLabel = null;
    _modeFilter = (opts && typeof opts.mode === 'string' && opts.mode) ? opts.mode : null;
    _limitOverride = null;
    _multiplayer = !!(opts && opts.multiplayer);
    _workerUrl = (opts && opts.workerUrl) || null;
    _playerId = (opts && opts.playerId) || null;
    _matchCode = (opts && opts.code) || null;
    _expectedHumans = Math.max(1, (opts && opts.humans) ? opts.humans : 1);

    /* Seed from the match's existing tally so a player who joins a vote late
       still sees what the others have already picked. */
    if(opts && opts.mapVote && typeof opts.mapVote === 'object'){
      _remoteVotes = Object.assign({}, opts.mapVote);
    }

    _paintVoteList();
    refreshCustomMaps().then(changed => { if(changed) _paintVoteList(); });

    const lbl = document.getElementById('mv-votes-label');
    if(lbl) lbl.style.color = '';
    const tmr = document.getElementById('mv-timer');
    if(tmr){
      /* background AND color: the winner state sets both (gold fill, dark
         digit), and clearing only the fill leaves dark-on-gold digits for the
         whole of the next round. */
      tmr.style.background = '';
      tmr.style.color = '';
    }
    _overlay.classList.remove('hidden');
    _wipeIn();

    /* One arena: pre-cast the vote and shorten the beat. Done AFTER the
       overlay is up so the card is visibly voted on rather than simply
       appearing already marked. */
    if(_roster().length === 1){
      _limitOverride = 3;
      const only = _roster()[0];
      _myVote = only.id;
      _votes[only.id] = 1;
      _publishVote(only.id);
      _syncUI();
    }

    _startVotePolling();
    _startTimer();
  }

  /* `then` runs AFTER the bar has covered the screen, so whatever the player is
     about to see is revealed rather than appearing under a half-drawn curtain.
     Callers that pass nothing get the old instant-hide behaviour, which is what
     an abort wants. */
  function _hide(then){
    _stopTimers();
    _remoteVotes = {};
    _playerId = null;
    _workerUrl = null;
    _multiplayer = false;
    _modeFilter = null;
    _limitOverride = null;

    if(!then){ _overlay.classList.add('hidden'); return; }
    _wipeOut(function(){
      _overlay.classList.add('hidden');
      then();
    });
  }

  /* opts.multiplayer / opts.humans / opts.playerId / opts.workerUrl /
     opts.mapVote are all optional, so every existing call site keeps working. */
  function showVote(callback, opts){
    _onComplete = callback;
    _show(opts || {});
  }

  function getMaps(){ return MAPS; }
  function getMapById(id){ return MAPS.find(m => m.id === id); }

  return { showVote, getMaps, getMapById, refreshCustomMaps };
})();
