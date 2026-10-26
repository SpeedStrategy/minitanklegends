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

  const MAPS = [
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
      id: 'core',
      name: 'Core',
      desc: 'Compact cover arena, 7 vs 7.',
      /* THE PLAYER'S OWN MAP, imported from TL/TL_core.glb. A tight little
         arena: a square ground plane, low cube cover scattered around it, a
         stand of pines and a flag in the middle. Fourteen spawn markers (blue
         x7, red x7) plus the flag, all named plainly, so _parseGLBSpawns picks
         them up and both modes size their teams from the map -- the 7v7 is
         honoured, same as Kaukaz.

         SCALE = 167, which is 500 / 3: the arena is deliberately a third of
         what it was, and about the size of Kaukaz (the other small 7v7 map).
         The authored map is tiny -- the ground plane works out at 1.402 units
         across, a 2-unit Blender plane on a node scaled 0.701 -- so the
         multiplier is what makes it an arena at all:

            100 ->  145 units   (a courtyard)
            167 ->  241 units   (current)
            300 ->  434 units
            500 ->  723 units   (the size it was before)

         For reference the others land at Kaukaz ~314 (x120), Old School ~530,
         Dream ~731, Ruins ~1253, Kaukaz III ~1731.

         A note on reading this file's numbers, because it is a trap: the union
         of the raw POSITION accessor bounds says 5.728 across and 9.04 tall,
         and neither is real. Every mesh is exported at a 5.728-unit size and
         then shrunk by a scale on its own node (0.04 to 0.7), so the raw
         accessor numbers are pre-transform and describe nothing you can drive
         on. tools/glb-markers.ps1 in TL/tools applies the node transforms and
         prints the real extent; that is where 1.445 came from. Measured with
         the same tool against TL_map_kaukaz_v2.glb, whose scale of 120 the
         comment above says lands at ~310 units: 2.619 x 120 = 314, so the tool
         and the arithmetic agree.

         worldHalf = 130 EXISTS BECAUSE OF worldHalf. _fitWorldToMap floors the
         boundary at 500 so a tiny or degenerate map cannot squeeze the arena
         shut, and at 241 units that floor is twice the map. Leaving it there
         was not cosmetic:

           * the tank clamp (tank.js) is world.half - 3, so you could drive
             350+ units past the edge of the ground and fall;
           * the void kill (game.js) is world.half - 10;
           * the capture circle's starting radius is world.half, so the circle
             covered the entire map from the first second and never closed;
           * the minimap maps the world to a world.size square, so it drew a
             quarter of the arena;
           * the camera limit is world.half, so it panned four times past the
             terrain.

         130 is not a magic number: it is exactly what _fitWorldToMap derives
         for this map with the floor removed -- 241 / 2 x 1.08 = 130.3. The
         8% margin is the same one the derived path uses, which keeps the visual
         edge of the ground inside the kill boundary. Declaring it here means
         only THIS map is affected; the floor stays for the other seven. */
      glb: 'assets/maps/TL_core.glb',
      scale: 167,
      worldHalf: 130,
      preview: null
    },
    {
      id: 'core2',
      name: 'Core II',
      desc: 'The rebuilt core — concrete, metal and a satellite dish.',
      /* NEW. Converted from assets/maps/core2.blend, which is an 89MB Blender file
         the browser cannot load at all — it had to be exported before it could
         be voted on. See tools/export-core2.py.

         SCALE = 228.33, measured with tools/glb-markers.ps1 rather than guessed,
         then divided by 1.8 to tighten the arena. With node transforms applied
         the authored arena is 1.290 units across:

             228.33 x 1.290 = 294.5 units   (was 411 x 1.290 = 530)

         For reference Dream lands at ~731 and the original Core at ~241, so this
         now sits just above Core — a compact courtyard rather than the roomy
         arena it was at 530.

         worldHalf = 159 is that size's derived boundary, 294.5 / 2 x 1.08 =
         159.06. Stated explicitly for exactly the reason Core states 130:
         _fitWorldToMap floors worldHalf at 500, and at 294.5 units that floor is
         nearly twice the terrain, so the void kill and the camera limit would
         both be wrong.

         THE SPAWNS ARE THE CAVEAT. The seven-per-side spawns are authored into
         the GLB and found BY NAME, so shrinking the arena does not move them —
         it just packs all fourteen into 56% of the room they had. Worth an
         eyeball on whether they now overlap or sit inside geometry.

         7 spawns a side and a flag, hence "7 vs 7" in the desc. Those are empty
         objects named blue / red / flag and they survive the export untouched —
         the game finds spawns BY NAME (World._parseGLBSpawns), so renaming
         anything on the way out would silently drop the spawns.

         THE SIZE. core2.blend was 89MB and exported to 2.92MB. Almost none of
         that was geometry — 12,118 triangles is nothing. 70 of its 113 packed
         textures were referenced by no material at all, and the rest were 2048
         maps with the ROUGHNESS and METALLIC layers costing more than everything
         else combined. Resolution is now budgeted by role: base colour 1024,
         normals 512, roughness/metallic/occlusion 256. The surface a player
         actually looks at is unchanged or better; the maps that only modulate
         shading are a quarter of the size. */
      glb: 'assets/maps/TL_core2.glb',
      scale: 228.33,
      worldHalf: 159,
      preview: null
    },
    {
      id: 'lastfrontier',
      name: 'Last Frontier',
      desc: 'Snowbound outpost — village, church and open ground.',
      /* NEW. Arrived as an already-exported glb, so unlike core2 it needed no
         conversion, only shrinking. See tools/optimize-glb.py.

         SCALE = 118, measured. The authored arena is 5.418 units across:

             118 x 5.418 = 639 units   (current)

         Second-largest of the four, and a genuinely big one — which is why it is
         worth the download.

         worldHalf = 520. It used to be 345 (639 / 2 x 1.08), but the arena is
         NOT centred on the origin and the boundary is: the west spawns sit at
         x = -415..-453, outside 345, so the void kill took two-thirds of the
         field on every respawn. 520 clears the furthest spawn by ~65 units.

         THE FILENAME KEEPS ITS SPACE. "assets/maps/last frontier.glb" is
         unappealing and looks like a typo, but it is the name the file arrived
         under and renaming it would mean either a second copy on disk or a
         silent 404 if any other file still points at the old path. If it is ever
         renamed, rename it in one place and grep for the old string first.

         13 blue and 14 red spawns — built for a full roster. The desc does not
         claim a team size because the map does not impose one; the mode sizes
         the team and the spawn list is simply long enough to draw from. */
      glb: 'assets/maps/last frontier.glb',
      scale: 118,
      worldHalf: 520,
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
    }
  ];

  /* Every round lasts exactly this long, whether you are alone or not, and
     whether or not everyone has voted. It is the single thing that ends the
     round, so nobody is ever locked out of a vote by clicking faster than
     somebody else. */
  const VOTE_DURATION = 10;

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

  function _init(){
    _overlay = document.getElementById('map-vote-overlay');
    _cardsEl = document.getElementById('mv-cards');
    _timerEl = document.getElementById('mv-timer');
    _labelEl = document.getElementById('mv-votes-label');
  }

  function _renderCards(){
    _cardsEl.innerHTML = '';
    MAPS.forEach(map => {
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
      /* Green: forest and grass cover. */
      'core': 'linear-gradient(135deg, #1f3d2b 0%, #356b45 50%, #244d33 100%)',
      /* Concrete and metal — deliberately desaturated against Core's green, so
         the two 7v7 maps do not read as the same card. */
      'core2': 'linear-gradient(135deg, #2b3038 0%, #4d5560 50%, #363c45 100%)',
      /* Cold: snow, with the stone of the church and the village behind it. */
      'lastfrontier': 'linear-gradient(135deg, #39424e 0%, #7d8794 50%, #a8b2bd 100%)',
      /* Hill: grass rising into a dry, sunlit crown — distinct from Core's
         deep forest green and from Last Frontier's cold stone. */
      'hill': 'linear-gradient(135deg, #24561f 0%, #4e7a33 45%, #93a05a 100%)'
    };
    /* Flat grey for a map with no entry reads as "unfinished", which is the
       honest signal if someone adds a map and forgets this table. */
    return grads[id] || 'linear-gradient(135deg, #333, #555)';
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
    MAPS.forEach(m => { t += _tallyFor(m.id); });
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

    MAPS.forEach(m => {
      const el = document.getElementById('mv-votes-' + m.id);
      if(el) el.textContent = _tallyFor(m.id);

      const card = _cardsEl.querySelector('[data-map-id="' + m.id + '"]');
      if(card){
        card.classList.toggle('voted', _myVote === m.id);
      }
    });

    if(_labelEl){
      let text;
      if(_myVote){
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
    const limit = VOTE_DURATION;

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
    let bestId = null, best = -1;
    MAPS.forEach(m => {
      const t = _tallyFor(m.id);
      if(t > best){ best = t; bestId = m.id; }
    });
    if(best <= 0){
      return MAPS[Math.floor(Math.random() * MAPS.length)].id;
    }
    const tied = MAPS.filter(m => _tallyFor(m.id) === best).map(m => m.id);
    if(tied.length === 1) return tied[0];
    if(_myVote && tied.indexOf(_myVote) >= 0) return _myVote;
    return tied[Math.floor(Math.random() * tied.length)];
  }

  function _finalize(){
    if(_finalized) return;
    _finalized = true;
    _stopTimers();

    const winnerId = _pickWinner();
    const winner = MAPS.find(m => m.id === winnerId) || MAPS[0];

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

    MAPS.forEach(m => _votes[m.id] = 0);
    _renderCards();
    _syncUI();

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

  return { showVote, getMaps, getMapById };
})();
