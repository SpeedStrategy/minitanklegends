/* ============================================================================
   results.js — the screen shown when a battle ends.

   LAYOUT: the leaderboards pinned to the top corners, a central column with the
   result banner, the four stat cards, the rewards panel and the missions line,
   and underneath all of it the stage: the diorama from assets/results-scene.glb
   with the player's tank, the best enemy and the best teammate standing on the
   three floor markers, a light over each, and DMG / KILLS / ASSISTS floating
   above them in white.

   WHY A SEPARATE RENDERER, AND WHY IT MATTERS

   The tanks have to be real 3D models you can drag to spin. The obvious way is
   to reuse the battle's renderer and swap its scene — and that is wrong, for a
   reason that is easy to discover the hard way. The battle renderer is owned by
   an arena that is about to be torn down: _resetArena() disposes every tank
   geometry and material, the physics world is emptied, the map GLB is dropped,
   and every per-match object is nulled. If the results screen borrowed that
   renderer and then anything called leaveToMenu() — a stray Escape, the
   reconnect timer, the match-end timeout that was already scheduled — the tanks
   on show would be disposed out from under the screen, mid-frame, while the
   renderer was actively drawing them. That is the "the results screen shows a
   half-built tank" class of bug, and it is much cheaper to never share.

   So this builds its OWN renderer, scene and camera on its own small canvas.
   Two WebGL contexts is nothing; browsers allow a dozen. The cost is a few MB
   of VRAM and three extra draws, and the benefit is that the results screen
   cannot be broken by anything that happens to the battle.

   THE DATA COMES FROM GAME, NOT FROM HERE

   Nothing is computed in this file. Damage, kills, assists, placement and the
   reward figures are all read from the tanks the game already has, because the
   host is the only machine that holds the real numbers — a client's own copy is
   its prediction, not the truth. See Game._showResults() for where the snapshot
   of them is taken.
   ========================================================================== */

(function (global) {
  'use strict';

  /* THE LENS, AND HOW MUCH ROOM IT LEAVES.

     `fovDefault` is the vertical field of view used when the stage file's camera
     empty is a plain Object3D rather than a real glTF camera node, and so
     carries no lens of its own. Blender's default camera is 50mm on a 36mm
     sensor, which works out at 39.6 degrees vertical; 44 is the round number
     just under it and is what this screen has always opened with, so it is what
     the solve starts from.

     `margin` is how much of the half-frame the outermost tank is allowed to
     reach. Below 1 it keeps a band of empty frame around the group, which is
     what stops a tank being cropped the instant it is spun against the edge. */
  const END_CAM = {
    fovDefault: 44,
    margin: 0.92,
  };

  const Results = {
    open: false,
    _raf: 0,
    _timer: 0,
    _renderer: null,
    _scene: null,
    _camera: null,
    _turntable: null,
    _tank: null,
    /* The objects this screen built for itself, kept by name so they can be freed
       without a blanket traverse of the scene. See _stopTurntable. */
    _floor: null,
    _floorTex: null,
    _shadow: null,
    _disposed: false,
    _onWinResize: null,
    /* No idle spin: the tank stands still until dragged. See _frame. */
    _dragAngle: 0,
    _dragVel: 0,
    _dragging: false,
    _lastX: 0,
    _lastT: 0,
    /* ------------------------------------------------------------------ show */

    /* `data` shape:
         {
           outcome: 'win' | 'loss' | 'draw',
           headline: 'VICTORY' | 'DEFEAT' | ...,
           place: 1..n | null,          the player's finishing position overall
           stats: { damage, kills, assists, placeInTeam, teamPlace, teamSize },
           rewards: { cash },
           missions: [ {name, progress, target, done} ],
           teams: {
             mine:   [ {name, tankId, damage, kills, assists, isYou} ],
             theirs: [ {name, tankId, damage, kills, assists, isYou} ],
           },
           tankId: 'coolbuddy',         the tank to show on the turntable
           tankName: 'Player',
         }
    */
    show(data){
      const el = document.getElementById('results-overlay');
      if(!el) return;
      this.data = data || {};

      /* Shown BEFORE the DOM is written, and not left to the end.

         The measurements that follow need a laid-out element: _buildStage
         reads the canvas's rect to size its drawing buffer, and flexbox has not
         resolved until the element is visible and in flow. Building the DOM
         while the overlay is still `hidden` measures zero, and a renderer made
         against a zero-size canvas has a 0x0 drawing buffer and draws nothing at
         all — which reads on screen as "the tank is missing". */
      el.classList.remove('hidden');

      this._buildDOM(el);

      this._buildStage(el);
      this._bindResize();
      this.open = true;

      /* Pointer lock would send every mouse movement to the game as camera
         input, so dragging the tank to spin it would instead swing the camera
         behind the results screen. */
      try { if(document.pointerLockElement) document.exitPointerLock(); } catch(e){}
      try { if(document.exitPointerLock) document.exitPointerLock(); } catch(e){}
    },

    hide(){
      this.open = false;
      /* Before anything else. The count-up runs on its own rAF chain and writes
         into DOM nodes that hide() is about to tear the meaning of — left
         running it keeps ticking a detached overlay, and its window keydown
         listener survives to skip the NEXT battle's count-up before it starts. */
      this._stopScoreClimb();
      try { document.body.classList.remove('res-open'); } catch(e){}
      const el = document.getElementById('results-overlay');
      if(el) el.classList.add('hidden');
      this._stopTurntable();
    },

    /* THE BANNER'S OWN FALLBACK.

       `_buildDOM` writes both the <img> and the styled word into
       `.res-banner-art`; the stylesheet stacks them in one box and
       `res-has-art` is the class that cross-fades from the word to the picture.

       The class is added on DECODE, not on request, and that ordering is the
       whole point. Adding it the moment the <img> is inserted — the obvious way
       to do this — leaves the banner showing neither alternative for as long as
       the fetch takes, because the artwork is opacity-controlled and an image
       that has not loaded has nothing to show. On a cold cache or a busy server
       that is a second of blank where the word should have been the whole time.

       Two listeners, because there are two endings and only one of them is
       success:

         load    the image is there. Swap to it, but only if it actually has
                 pixels — a `load` with naturalWidth 0 means the decode failed
                 and the word is the better answer.
         error   it never arrived. Leave the word.

       And one case needs no listener at all: an image the browser already
       failed on, which is `complete` with no intrinsic size. That is the second
       time the screen is built in a session after the first fetch 404'd, and
       it is settled before this runs. */
    _armBannerArt(artKey){
      const wrap = document.querySelector('#results-overlay .res-banner-art');
      if(!wrap) return;

      const img = wrap.querySelector('.res-banner-img');
      if(!img || !artKey){
        /* No artwork for this outcome — a skipped battle. There is deliberately
           no neutral banner, so the word is the whole thing. */
        try { wrap.classList.remove('res-has-art'); } catch(e){}
        return;
      }

      /* Already known-broken: do not even ask, and do not leave the word
         hidden waiting for a load event that is never coming. */
      if(img.complete && img.naturalWidth === 0){
        try { wrap.classList.remove('res-has-art'); } catch(e){}
        return;
      }

      /* The word is up by default — nothing here has to set it. */
      try {
        wrap.classList.remove('res-has-art');
        img.addEventListener('load', () => {
          try {
            if(img.naturalWidth > 0) wrap.classList.add('res-has-art');
            else wrap.classList.remove('res-has-art');
          } catch(e){}
        }, { once: true });
        img.addEventListener('error', () => {
          try { wrap.classList.remove('res-has-art'); } catch(e){}
        }, { once: true });
      } catch(e){}
    },

    /* ------------------------------------------------------------------- DOM */

    _buildDOM(el){
      const d = this.data || {};
      const s = d.stats || {};
      const myTeamName = (d.myTeamName || 'YOUR TEAM').toUpperCase();
      const theirTeamName = (d.theirTeamName || 'ENEMY TEAM').toUpperCase();

      /* THE ICONS ARE SVG SYMBOLS FROM ONE SPRITE, not images.

         They used to be `assets/currency/cash.png`, `coin.png` and `gold.png`,
         which put a picture of money next to the damage figure. Beyond being
         simply wrong — it says the damage WAS cash — it was wrong in a way that
         could not be fixed by swapping files, because no other icons existed to
         swap to. These are drawn to match each other, inherit their colour, and
         stay sharp at every size the screen uses them. */
      /* THE FOUR STAT CARDS.

         `value` is escaped; `valueHtml` is not, for the one card that needs
         markup — "place in team" carries a muted "/ 6" beside the number, and
         passing that as a plain string escapes it and the player reads
         `<span class=...>` on the screen.

         NO ICON. Every card used to carry a drawn glyph beside its number — a
         shell, a crosshair, a chevron. They are gone. Each one was a second
         thing to learn on a screen whose whole job is to be read in the second
         after a battle, and they cost the labels their meaning: a number with a
         picture beside it gets read as a picture with a number beside it. The
         word under the number says what the number is. */
      const statCard = (value, label, valueHtml) =>
        '<div class="res-stat res-plate">' +
          '<div class="res-stat-body">' +
            '<div class="res-stat-val">' + (valueHtml != null ? valueHtml : esc(value)) + '</div>' +
            '<div class="res-stat-cap">' + esc(label) + '</div>' +
          '</div>' +
        '</div>';

      /* REWARDS. Cash only — a battle pays nothing else. See
         Game._awardBattleCash. This is the ONE place a currency icon belongs,
         and it is the real cash icon rather than a drawn one, because it has to
         match the icon the rest of the game shows for cash.

         PROGRESSION 2.0: upgrade points (XP ÷ 10) and golden upgrade points
         (one per win) now ride along; read from the progression module's
         last-award record so the panel only shows what THIS battle granted. */
      const cash = (d.rewards && d.rewards.cash) || 0;
      const tpAward = (window.Progression && Progression.getLastAward && Progression.getLastAward()) || {};
      const showUp = tpAward.up > 0;
      const showGup = tpAward.gup > 0;
      const rewardRow =
        '<div class="res-reward">' +
          '<img class="res-reward-icon" src="assets/currency/cash.png" alt="">' +
          '<span class="res-reward-val">' + fmtNum(cash) + '</span>' +
          '<span class="res-reward-cap">CASH</span>' +
        '</div>' +
        (showUp
          ? '<div class="res-reward">' +
              '<img class="res-reward-icon" src="assets/rewards/upgradepoints.png" alt="">' +
              '<span class="res-reward-val">' + fmtNum(tpAward.up) + '</span>' +
              '<span class="res-reward-cap">UPGRADE PTS</span>' +
            '</div>'
          : '') +
        (showGup
          ? '<div class="res-reward">' +
              '<img class="res-reward-icon" src="assets/rewards/goldupgradepoints.png" alt="">' +
              '<span class="res-reward-val">' + fmtNum(tpAward.gup) + '</span>' +
              '<span class="res-reward-cap">GOLDEN PTS</span>' +
            '</div>'
          : '');

      /* MISSIONS: A COUNT, AND NOTHING ELSE.

         This listed every quest the battle moved, with its name, a tick and a
         progress fraction. On a results screen that was the wrong shape three
         ways: it repeated the quest log, it put a row of text where the tank
         should be, and it asked the player to re-read names they had read an
         hour ago in order to arrive at one integer.

         So: one number — how many missions this battle actually FINISHED. Note
         finished, not advanced; a quest nudged from 40% to 60% is not a thing
         that happened to you.

         Zero and the whole block is left out. "0" sitting where the rewards are
         reads as a scold, and a battle that finished nothing has not failed at
         anything. */
      const ms = d.missions || [];
      const finishedCount = ms.filter(function(m){ return !!m.finished; }).length;
      const missionHtml = finishedCount > 0
        ? '<div class="res-missions" title="Missions completed in this battle">' +
            '<span class="res-missions-num">' + finishedCount + '</span>' +
            '<span class="res-missions-cap">' +
              (finishedCount === 1 ? 'MISSION DONE' : 'MISSIONS DONE') +
            '</span>' +
          '</div>'
        : '';

      /* THE SUB-LINE UNDER THE HEADLINE.

         The word on its own is a label. One short line of tracked capitals
         underneath it turns it into a title card, and it carries the outcome in
         words as well, so a defeat is never left to be read off the colour of
         a stripe. */
      const SUBLINE = {
        win:  'THE ENEMY LINE BROKE',
        draw: 'NEITHER SIDE GAVE GROUND',
        loss: 'THE FIELD IS LOST'
      };

      /* THE HEADLINE IS ARTWORK, AND THE TEXT IS THE FALLBACK.

         `assets/endmenu/victory.webp` and `defeat.webp` are the drawn banners —
         a crown and chevrons over VICTORY, a skull and chevrons over DEFEAT — and
         they are what the screen now leads with.

         The CSS word is still in the DOM underneath, and that is deliberate on
         three counts rather than one:

           * the artwork is a WEBP, and a webp is a thing that can fail to
             arrive. The onerror handler below swaps back to the styled word, so
             a missing file degrades to the screen this one replaced instead of
             to a hole with a sub-line under it;
           * it is the accessible name. The <img> carries `alt`, and the text is
             left in the document rather than removed, so a screen reader and a
             full-text search both still find "VICTORY" on this screen;
           * a skipped battle has no artwork. "BATTLE ENDED" is neither side's
             win and neither side's defeat, so it gets the word on its own —
             there is deliberately no neutral banner to fall back on, because
             drawing one would be putting a crown or a skull on a battle that
             neither happened in. */
      const ART = { win: 'victory', loss: 'defeat' };
      /* `skipped` first, and it has to come first.

         A skipped battle arrives with outcome 'loss' — there is no 'skip'
         outcome — so reading ART[d.outcome] alone put the DEFEAT skull and its
         crossed chevrons over a battle that was not lost. That is the one thing
         this artwork must never do: it tells the player they were beaten when
         they walked away from a match that was called off. `skipped` is checked
         ahead of the outcome so the word is shown alone instead.

         The <img> is emitted either way, with no src when there is nothing to
         fetch. A stable element is worth more than a tidier one here: it is what
         lets the swap be a single class on one wrapper instead of a different
         shape of DOM per outcome, and a src-less image draws nothing and fires
         nothing, so it costs nothing but four bytes of markup.

         `alt` is empty on purpose. The word it stands in for is in the document
         immediately beside it as real text, so an alt of "VICTORY" would make a
         screen reader say the word twice — once as the image and once as the
         text — and the artwork is decorative where the text is not. */
      const artKey = d.skipped ? null : ART[d.outcome];
      const bannerArt =
        '<div class="res-banner-art">' +
          '<img class="res-banner-img"' +
              (artKey ? ' src="assets/endmenu/' + artKey + '.webp"' : '') +
              ' alt="" decoding="async" draggable="false">' +
          '<div class="res-banner-text">' + esc(d.headline || '') + '</div>' +
        '</div>';

      /* THE TEAM SCORE.

         Was two proportional bars drawn against each other under a caption, with
         each number printed at the end of its own bar. On a screen whose brief
         is minimalistic, a pair of filled troughs was the most decorative thing
         on it — and it was also the least informative, because it showed the
         same two numbers it was drawn from, just as a picture.

         The numbers are the information. The bars were a picture of them. So:
         the team, the number, and the player who is currently being added to
         it. No trough, no fill, no keyline.

         The number is not written into the markup at its final value. It starts
         at zero and is driven up by _scoreClimb, one player's damage at a time,
         so the total is never just a number — you watch who on the team earned
         it. `data-res-score-*` are the hooks that animation drives; the markup
         has to exist whether or not it ever runs (reduced motion, a screen with
         no damage at all), which is why _scoreSettle can always finish the job. */
      const sumDamage = rows => (rows || []).reduce((t, r) => t + ((r && r.damage) || 0), 0);
      const myDamage    = sumDamage(d.teams && d.teams.mine);
      const theirDamage = sumDamage(d.teams && d.teams.theirs);
      const scoreRow = (label, side, cls) =>
        '<div class="res-score-row ' + (cls || 'blue') + '" data-res-score="' + side + '">' +
          '<span class="res-score-name">' + esc(label) + '</span>' +
          '<span class="res-score-val" data-res-score-val>0</span>' +
          '<span class="res-score-who" data-res-score-who></span>' +
        '</div>';
      const scoreHtml = (myDamage || theirDamage)
        ? '<div class="res-score" data-res-score-root>' +
            '<div class="res-score-cap">TEAM DAMAGE</div>' +
            scoreRow(myTeamName, 'mine',   d.myTeamClass   || 'blue') +
            scoreRow(theirTeamName, 'theirs', d.theirTeamClass || 'red') +
            '<div class="res-score-skip" data-res-score-skip>click to skip</div>' +
          '</div>'
        : '';

      /* THE TANK IS THE SCENE, NOT A PANEL.

         The canvas is a fixed, full-viewport layer at the very back, and the UI
         floats over it. It used to sit in a bordered box in the middle of a
         column, which made the tank look like a thumbnail inside a widget rather
         than the subject of the screen — and it wasted the one thing the results
         screen has that no other screen does, which is room to show the tank
         properly. */
      el.innerHTML =
        '<div class="res-backdrop"></div>' +
        '<canvas id="res-tank-canvas" class="res-canvas"></canvas>' +

        /* THE FOG, IN FRONT OF THE SCENE.

           This element was previously `.res-backdrop::before`, which put the fog
           on the layer BEHIND the canvas — where it could never be seen, because
           the results renderer clears to an OPAQUE buffer (alpha:true but
           clearAlpha 1, and the scene has no background of its own, so every
           pixel it draws is alpha 255). Measured: the whole backdrop, and
           everything else on layer 0, is invisible on this screen.

           That is worth writing down because it is not obvious and it wasted a
           pass: the layer LOOKS like it is doing something and is not. It also
           explains what the fog on this screen actually was — every previous
           attempt was editing an invisible layer while the grey, hard-edged
           shape everyone was seeing at the bottom was the 3D floor slab fading
           into the 3D scene fog.

           So the fog is its own element now, placed after the canvas and given
           z-index 2: in front of the scene, behind the boards and the centre
           column at z-index 3. It fogs the bottom of the picture the player is
           looking at, and the placeholders are still drawn over it. */
        '<div class="res-fog"></div>' +

        /* THE SCORE PLATES THAT FLOAT OVER THE TANKS.

           Sits between the canvas and the HUD: above the 3D layer so the
           numbers are never swallowed by it, below the leaderboards so a plate
           that drifts near a board goes behind it instead of covering a row.
           Empty until _buildFloats fills it. */
        '<div class="res-floats"></div>' +

        /* TOP: the two boards, side by side, across the width.

           Moved up from flanking a centre column. The reasoning is that a
           leaderboard is a table, and a table wants to be read in one horizontal
           sweep; flanking a narrow central column forced it into a tall thin
           strip that was awkward to scan and left the middle of the screen empty. */
        '<div class="res-top">' +
          '<div class="res-board res-board-left">' +
            '<div class="res-board-title ' + (d.myTeamClass || 'blue') + '">' +
              '<span class="res-board-name">' + esc(myTeamName) + '</span>' +
              '<span class="res-board-count">' + ((d.teams && d.teams.mine) || []).length + '</span>' +
            '</div>' +
            this._boardRows(d.teams && d.teams.mine) +
          '</div>' +

          '<div class="res-board res-board-right">' +
            '<div class="res-board-title ' + (d.theirTeamClass || 'red') + '">' +
              '<span class="res-board-name">' + esc(theirTeamName) + '</span>' +
              '<span class="res-board-count">' + ((d.teams && d.teams.theirs) || []).length + '</span>' +
            '</div>' +
            this._boardRows(d.teams && d.teams.theirs) +
          '</div>' +
        '</div>' +

        /* CENTRE: the banner, then the score chart, then the stats over the tank. */
        '<div class="res-centre">' +
          '<div class="res-banner ' + (d.outcome || 'loss') + '">' +
            '<div class="res-banner-main">' +
                bannerArt +
              '<div class="res-banner-sub">' + esc(SUBLINE[d.outcome] || SUBLINE.loss) + '</div>' +
            '</div>' +
            (d.place != null
              ? '<div class="res-banner-place"><b>' + esc(String(d.place)) + '</b><i>PLACE</i></div>'
              : '') +
          '</div>' +

          /* THE CHART, DIRECTLY UNDER THE BANNER.

             It sits where the eye lands after the word, and before the four
             stat cards, because it is the one element here that can be read
             without reading: two bars against each other say how the battle
             went faster than any figure underneath them. */
          scoreHtml +

          /* A SKIPPED BATTLE SAYS SO, UNDER THE BANNER.

             Without this line the screen reads as an ordinary result, and the
             cash on it looks like a full battle's payout — which it is not, and
             which is the whole reason the win bonus is withheld. One line of text
             is enough to stop "I skipped that and got paid for a win" being a
             reasonable thing for a player to believe. */
          (d.skipped
            ? '<div class="res-skipped">Battle ended early &mdash; cash is for what you did, with no win bonus</div>'
            : '') +

          /* STATS AND REWARDS SHARE A ROW.

             They were stacked, which cost about a hundred pixels of vertical
             space and put the lower half of the tank behind the UI. The four
             stat cards and the reward panel are the same kind of thing — a
             number you came to read — so they belong side by side, and the
             freed height goes to the tank, which is the reason the screen
             exists. */
          '<div class="res-mainrow">' +
            '<div class="res-stats">' +
              statCard(fmtNum(s.damage), 'DAMAGE DEALT') +
              statCard(fmtNum(s.kills),  'KILLS') +
              statCard(fmtNum(s.assists),'ASSISTS') +
              statCard(fmtNum(s.teamPlace), 'PLACE IN TEAM',
                fmtNum(s.teamPlace) + '<span class="res-stat-of"> / ' + fmtNum(s.teamSize) + '</span>') +
            '</div>' +

            '<div class="res-rewards res-plate">' +
              '<div class="res-rewards-cap">REWARDS</div>' +
              '<div class="res-rewards-row">' + rewardRow + '</div>' +
            '</div>' +
          '</div>' +

          missionHtml +

          '<div class="res-foot">' +
            '<div class="res-hint">Drag a tank to spin it</div>' +
            '<button class="res-continue" id="res-continue">CONTINUE</button>' +
          '</div>' +
        '</div>';

      const btn = document.getElementById('res-continue');
      if(btn){
        btn.onclick = () => {
          if(typeof Results.onContinue === 'function') Results.onContinue();
          else Results.hide();
        };
      }

      /* Wire the banner's fallback now that the markup exists. */
      this._armBannerArt(artKey);

      /* Body class so the CSS can hold the game still underneath, and so the
         watchdog in Game._showResults can tell whether the screen really came
         up rather than assuming it did. */
      try { document.body.classList.add('res-open'); } catch(e){}
      this._shownOk = true;

      /* The count-up starts LAST, once the markup it writes into is in the
         document. Started any earlier it measures the rows against a detached
         tree, finds them all null, and silently settles to the final numbers —
         which looks like the animation was skipped on purpose. */
      this._startScoreClimb(d);
    },

    /* --------------------------------------------------------- the count-up */

    /* BUILD THE TIMELINE, ONCE, BEFORE ANY OF IT RUNS.

       Absolute start and end times per segment rather than a running accumulator
       advanced by delta-time. The accumulator version drifts: every frame adds
       its own rounding, and a sequence of forty short segments is where that
       shows — the pauses come out visibly different lengths, which is exactly
       the thing a "steady rhythm" is supposed to prevent.

       ORDER. The winning side counts first and holds while the losing side does
       the same, so the number you came to see is the one that lands last. A
       SKIPPED battle has no winner — it was pulled out of, and calling either
       side the winner would be inventing a result — so it runs both together
       instead of picking a victor it does not have.

       PLAYERS WHO DEALT NOTHING are left out of the sequence entirely. They
       contribute zero, so a climb from 400 to 400 is a pause with a number
       frozen behind it: pure dead time that reads as a stutter.

       TIMING IS A BUDGET, NOT A CONSTANT. Every segment gets the same nominal
       length and then the whole sequence is scaled to fit, which is what makes
       the rhythm identical in a 3v3 and a 8v8 — the pauses shorten rather than
       the screen being locked for half a minute. */
    _scorePlan(d){
      const byDamage = rows => (rows || []).slice().sort((a, b) =>
        (b.damage || 0) - (a.damage || 0) || (b.kills || 0) - (a.kills || 0));
      const mine   = byDamage(d.teams && d.teams.mine);
      const theirs = byDamage(d.teams && d.teams.theirs);

      const skipped  = !!d.skipped;
      const mineWins = d.outcome === 'win';

      const CLIMB = 300, HOLD = 430, GAP = 300;
      const BUDGET = 6200;

      const totals = { mine: 0, theirs: 0 };

      /* ONE PLAYER = ONE CLIMB + ONE HOLD, built ONCE per side.

         This used to be a `pushSide(side)` call inside the loop that walks the
         two teams together, which re-ran the WHOLE list on every iteration —
         seven indices produced seven full passes over each roster and 72
         segments for eleven players. The damage ran out after the third player
         in my first test data and hid it, because every extra pass emitted
         nothing after the total was already reached. Splitting the two jobs —
         "work out this side's climbs" and "interleave the sides" — is also why
         the running total can only ever be computed once. */
      const builds = (side) => {
        const rows = side === 'mine' ? mine : theirs;
        const out = [];
        let run = 0;
        for(let i = 0; i < rows.length; i++){
          const r = rows[i];
          const amount = Math.max(0, r.damage || 0);
          /* A player who dealt nothing is left out entirely. A climb from 400
             to 400 is a pause with a number frozen behind it: dead time that
             reads as a stutter. */
          if(amount <= 0) continue;
          const from = run;
          run += amount;
          out.push({ side: side, from: from, to: run, name: r.name || '' });
        }
        totals[side] = run;
        return out;
      };
      const mineSteps = builds('mine');
      const theirSteps = builds('theirs');

      const emit = (steps, step) => {
        steps.push({ kind: 'climb', side: step.side, from: step.from, to: step.to, name: step.name });
        steps.push({ kind: 'hold',  side: step.side, name: step.name });
      };

      const steps = [];
      if(skipped){
        /* BOTH AT ONCE. A skipped battle has no winner — it was pulled out of,
           and calling either side the winner would be inventing a result — so
           there is nothing to put first. The two are interleaved player for
           player, which also keeps them level: whichever roster is longer simply
           has more steps left over at the end. */
        const n = Math.max(mineSteps.length, theirSteps.length);
        for(let i = 0; i < n; i++){
          if(i < mineSteps.length)   emit(steps, mineSteps[i]);
          if(i < theirSteps.length) emit(steps, theirSteps[i]);
        }
      } else {
        /* The winning side counts first and holds while the losing side does the
           same, so the figure the player came to see is the one that lands
           last. `outcome` is the match result, not the damage comparison — a
           team can win on objectives having done less damage. */
        const order = mineWins ? ['mine', 'theirs'] : ['theirs', 'mine'];
        order.forEach((side, oi) => {
          const arr = side === 'mine' ? mineSteps : theirSteps;
          for(let i = 0; i < arr.length; i++) emit(steps, arr[i]);
          if(oi < order.length - 1) steps.push({ kind: 'gap', ms: GAP });
        });
      }

      /* Scale to the budget. Every segment keeps its proportion, so a climb is
         always the same multiple of a hold and the rhythm never changes shape —
         it only gets quicker. That is what makes a 3v3 and a 10v10 feel like
         the same animation rather than one of them being a cutscene. */
      const nominal = steps.reduce((t, s) =>
        t + (s.kind === 'climb' ? CLIMB : (s.kind === 'hold' ? HOLD : GAP)), 0);
      const k = (nominal > BUDGET && nominal > 0) ? (BUDGET / nominal) : 1;

      let t = 0;
      steps.forEach((s) => {
        s.ms = (s.kind === 'climb' ? CLIMB : (s.kind === 'hold' ? HOLD : GAP)) * k;
        s.t0 = t;
        t += s.ms;
        s.t1 = t;
      });

      return { seq: steps, totals: totals };
    },

    /* FINISH. The one place that writes the real numbers, so there is exactly
       one answer for what the screen should say and no path that can disagree
       with it — running, skipped, reduced motion, or a battle where nobody
       dealt damage and the sequence was empty from the start. */
    _scoreSettle(root, plan){
      if(!root || !plan) return;
      ['mine', 'theirs'].forEach((side) => {
        const v = root.querySelector('[data-res-score="' + side + '"] [data-res-score-val]');
        if(v) v.textContent = fmtNum((plan.totals && plan.totals[side]) || 0);
        const w = root.querySelector('[data-res-score="' + side + '"] [data-res-score-who]');
        if(w){ w.textContent = ''; w.classList.remove('on'); }
      });
      const skip = root.querySelector('[data-res-score-skip]');
      if(skip) skip.classList.add('gone');
    },

    _stopScoreClimb(){
      if(this._scoreTimer){ try { global.clearTimeout(this._scoreTimer); } catch(e){} this._scoreTimer = 0; }
      if(this._scoreSkipEl && this._scoreSkipFn){
        try { this._scoreSkipEl.removeEventListener('pointerdown', this._scoreSkipFn); } catch(e){}
      }
      /* The key listener lives on window, so removing the element above does not
         reach it. Left behind it fires into an already-settled screen on the
         NEXT battle and skips a count-up that has not started yet. */
      if(this._scoreKeyFn){
        try { global.removeEventListener('keydown', this._scoreKeyFn); } catch(e){}
      }
      this._scoreSkipEl = null;
      this._scoreSkipFn = null;
      this._scoreKeyFn  = null;
    },

    _startScoreClimb(d){
      this._stopScoreClimb();
      const el = document.getElementById('results-overlay');
      const root = el ? el.querySelector('[data-res-score-root]') : null;
      const plan = this._scorePlan(d);
      this._scorePlanCache = plan;

      /* No markup means there was no damage worth scoring, and no sequence means
         every player dealt zero. Both settle, and neither animates. */
      if(!root || !plan.seq.length){ this._scoreSettle(root, plan); return; }

      let reduced = false;
      try {
        reduced = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch(e){}
      if(reduced){ this._scoreSettle(root, plan); return; }

      const seq = plan.seq;
      const total = seq.length ? seq[seq.length - 1].t1 : 0;
      const self = this;

      const valOf = (side) => root.querySelector('[data-res-score="' + side + '"] [data-res-score-val]');
      const whoOf = (side) => root.querySelector('[data-res-score="' + side + '"] [data-res-score-who]');
      const vals = { mine: valOf('mine'), theirs: valOf('theirs') };
      const whos = { mine: whoOf('mine'), theirs: whoOf('theirs') };

      const setVal = (side, v) => { const e = vals[side]; if(e) e.textContent = fmtNum(v); };
      const setWho = (side, txt) => {
        const e = whos[side]; if(!e) return;
        if(!txt){ e.textContent = ''; e.classList.remove('on'); return; }
        e.textContent = txt;
        /* Re-adding the class restarts its keyframe animation. A running class
           that never leaves does nothing on the second pass. */
        e.classList.remove('on');
        void e.offsetWidth;
        e.classList.add('on');
      };

      ['mine', 'theirs'].forEach((s) => { setVal(s, 0); setWho(s, ''); });

      const t0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
      let cur = -1;

      /* A TIMER, NOT requestAnimationFrame.

         This is a DOM text animation. It writes two textContent values a few
         dozen times and drives nothing that is rendered, so it gains nothing
         from being on the frame loop — and it loses something important by being
         on it. rAF is suspended outright in a hidden tab, and a battle can end
         while the player is alt-tabbed: the count-up would start, tick zero
         times, and leave BOTH TEAM FIGURES READING 0 on the screen they come
         back to. Not "paused" — wrong, permanently, because nothing else on the
         screen writes those numbers.

         setTimeout is merely throttled in a hidden tab, not stopped, so the
         animation completes. It arrives in coarse jumps because the absolute
         timeline below is measured in real time, which is exactly the behaviour
         wanted: the figures are correct the instant the player looks. */
      const FRAME = 16;

      const tick = () => {
        if(!self._scoreTimer) return;
        const stamp = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
        const el2 = stamp - t0;

        let idx = -1;
        for(let i = 0; i < seq.length; i++){
          if(el2 < seq[i].t1){ idx = i; break; }
        }

        if(idx >= 0 && idx !== cur){
          cur = idx;
          const s = seq[idx];
          /* The name lands on the HOLD, not the climb: it is the player whose
             damage has just finished arriving, so it appears with the number
             they are being credited to rather than before it. */
          if(s.kind === 'hold') setWho(s.side, '+ ' + s.name);
          else                   setWho(s.side, '');
        }

        if(idx >= 0){
          const s = seq[idx];
          if(s.kind === 'climb'){
            const raw = Math.max(0, Math.min(1, (el2 - s.t0) / (s.ms || 1)));
            /* EASE-OUT CUBIC. The number leaps most of the way almost at once
               and settles onto the exact figure, which is what a count-up
               should feel like; linear motion reads as a loading bar. */
            const e = 1 - Math.pow(1 - raw, 3);
            setVal(s.side, s.from + (s.to - s.from) * e);
          }
        }

        if(el2 >= total){
          self._scoreSettle(root, plan);
          self._scoreTimer = 0;
          return;
        }
        self._scoreTimer = global.setTimeout(tick, FRAME);
      };
      this._scoreTimer = global.setTimeout(tick, FRAME);

      /* SKIP. A six-second count the player cannot get out of is a worse fault
         than the one it is animating. Bound to the score block itself rather
         than the whole overlay, because the overlay is also where you drag a
         tank to spin it — skipping the animation on a drag to admire the tank
         would be a coin flip every time. */
      const skip = (e) => {
        if(e && e.button != null && e.button !== 0) return;
        self._scoreSettle(root, plan);
        self._stopScoreClimb();
      };
      const onKey = (e) => {
        if(e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') skip(null);
      };
      root.addEventListener('pointerdown', skip);
      global.addEventListener('keydown', onKey);
      this._scoreSkipEl = root;
      this._scoreSkipFn = skip;
      this._scoreKeyFn  = onKey;
    },

    /* ONE LEADERBOARD.

       THE COLUMN HEADERS WERE MISSING, which is not a cosmetic gap.

       The board showed three bare numbers after a name and no indication of what
       any of them meant. A player could see that somebody had "4 200" and "3" and
       had no way to know that was damage and kills — and assists, which the
       results screen was specifically built to show, were not in the table at
       all even though the game tracks them. So the one number that most needed a
       label had no column.

       The header row names every column and carries a tooltip, and the rows now
       include assists. Each row also carries its own full breakdown on hover, so
       the numbers stay unlabelled on screen but are never ambiguous.

       Sorted by damage, because that is the number the mode is scored on and
       because it is the one that does not collapse to zero for a player who
       played well defensively. */
    _boardRows(rows){
      const list = (rows || []).slice().sort((a, b) =>
        (b.damage || 0) - (a.damage || 0) || (b.kills || 0) - (a.kills || 0));

      if(!list.length){
        return '<div class="res-row empty">No tanks</div>';
      }

      /* Header. WORDS, not glyphs — these used to be the same three icons the
         stat cards used, at a smaller size, on the argument that a player would
         learn one vocabulary instead of two. In practice the two columns most
         worth naming are the two a glance cannot infer, and three letters of
         caps beat a pictogram for both of them. The tooltips carry the full
         sentence for anyone who wants it. */
      const head =
        '<div class="res-row res-row-head">' +
          '<span class="res-rank"></span>' +
          '<span class="res-name">PLAYER</span>' +
          '<span class="res-dmg" title="Damage dealt">DMG</span>' +
          '<span class="res-kills" title="Enemy tanks destroyed">K</span>' +
          '<span class="res-assists" title="Tanks you damaged that a teammate finished off">A</span>' +
        '</div>';

      const body = list.map((r, i) => {
        /* The hover breakdown spells everything out in words, which is the whole
           point of the tooltip: the columns stay terse on screen, but nothing is
           left to guesswork. `title` is used rather than a custom tooltip
           because it is keyboard- and screen-reader-accessible for free, and a
           bespoke div is neither. */
        const tip = r.name + ' — ' + fmtNum(r.damage) + ' damage, '
                  + fmtNum(r.kills) + ' ' + (r.kills === 1 ? 'kill' : 'kills') + ', '
                  + fmtNum(r.assists) + ' ' + (r.assists === 1 ? 'assist' : 'assists')
                  + (r.isYou ? ' — you' : '');
        return '<div class="res-row' + (r.isYou ? ' you' : '') + '" title="' + esc(tip) + '" tabindex="0">' +
          '<span class="res-rank">' + (i + 1) + '</span>' +
          '<span class="res-name">' +
            (r.isYou ? '<span class="res-you-tag">YOU</span>' : '') +
            esc(r.name || 'Unknown') +
          '</span>' +
          '<span class="res-dmg">' + fmtNum(r.damage) + '</span>' +
          '<span class="res-kills">' + fmtNum(r.kills) + '</span>' +
          '<span class="res-assists">' + fmtNum(r.assists) + '</span>' +
        '</div>';
      }).join('');

      return head + body;
    },

    /* ------------------------------------------------------------ the stage

       THE SCREEN IS A SCENE, NOT A TURNTABLE.

       assets/results-scene.glb is a small diorama with four plain empties in it:

         "1"      where the player's own tank stands
         "2"      where the top tank of the ENEMY team stands
         "3"      where the top tank of YOUR team stands
         "camera" where the results camera stands

       A light is dropped on each of the three floor markers, so every tank gets
       its own pool of light instead of sharing one flat key — which is what
       makes three separate objects read as three separate subjects rather than
       one group photo. Each marker also gets a score plate floating above the
       tank (DMG / KILLS / ASSISTS) built from HTML rather than a texture: it
       stays crisp at any size, it uses the same fonts as the HUD, and updating
       it costs nothing but a transform.

       The camera takes its position AND its rotation from the "camera" empty.
       Only the lens is computed here, because the empty cannot know how wide
       the player's window is. See _frameCamera.

       WHAT THE STAGE IS, GEOMETRICALLY. scene.2.glb holds one object: a unit cube
       scaled to 1907 x 1.48 x 2298 with a "Stylized Concrete" material. It is
       not a diorama with a floor, walls and props — it is one enormous flat
       slab, i.e. an endless concrete plate with nothing standing on it.

       That is a better thing to build this screen on than the old stage, and the
       reason is the fog. A slab that size has no far edge to see, so fog brought
       in close swallows everything past the tanks and the floor simply runs on
       into haze. The previous stage stopped dead on a visible silhouette at 130
       units; this one cannot, because there is nothing there to stop against.

       WHY THE MARKERS ARE ALSO LITERAL VALUES. The GLB is a network request
       like any other, and a screen that composes itself from a file which
       happens to be missing is a screen with three tanks at the origin and a
       camera standing inside one of them. The literals below are the values the
       file shipped with, so a failed fetch degrades to a slightly plainer
       version of the same layout instead of to nothing at all.
    */

    _stageUrl:  'assets/results-scene.glb',

    /* THE COLOUR OF THE ROOM, IN ONE PLACE.

       Used for BOTH the fog and the renderer's clear colour, and that is the
       whole point of it. The two must be identical: fog is applied per-fragment,
       so it only ever touches geometry that gets drawn, and above the floor's
       horizon there is no geometry at all — that gap is filled by the clear
       colour. Anything else puts a seam across the top of the screen, and no
       amount of extra fog closes it because there is nothing out there for the
       fog to act on.

       Two separate literals for the two is exactly how that regressed once: the
       fog was retuned to a colder grey and the clear colour was not, and the
       screen gained a hard band that looked like a renderer fault. */
    _stageFogColour: 0x161b23,
    _stageMark: null,
    _foundMark: null,
    _stage:     null,
    _origMats:  null,
    _origTexs:  null,
    _ownedMats: null,
    _slots:     null,
    _floats:    null,
    _lights:    null,
    _resTanks:  null,
    _resFloor:  null,
    _projV:     null,
    _ray:       null,
    _solo:      -1,
    _soloAngle: 0,
    _soloVel:   0,
    _canvasEl:  null,
    /* One footprint for all three tanks; see _fitSlot. */
    _tankSpan:  6.4,

    /* The four markers, resolved once: whatever the GLB carried, else the
       literals. Everything downstream reads this and never the file. */
    _markers(){
      if(this._stageMark) return this._stageMark;
      const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
      const F = this._foundMark || {};
      this._stageMark = {
        one:   F.one   || V([0, 1.6860616207122803, 9.010071754455566]),
        two:   F.two   || V([9.053805351257324, 1.6528435945510864, -1.8107612133026123]),
        three: F.three || V([-9.112598419189453, 1.6278356313705444, -1.8225194215774536]),
        cam:   F.cam   || V([0, 2.931403160095215, 27.235301971435547]),
        camQuat: F.camQuat ||
          new THREE.Quaternion(0.025827640667557716, 0, 0, 0.9996663928031921),
        /* Only a POSITION makes this an authored shot. The fallback literals
           above are the same numbers as the ones in the file, so a file that
           fails to parse and a file that genuinely has no camera both have to
           take the same branch — and both take the non-authored one. */
        camFov: F.camFov || END_CAM.fovDefault,
        fromFile: !!F.cam,
      };
      return this._stageMark;
    },

    async _buildStage(el){
      const canvas = document.getElementById('res-tank-canvas');
      if(!canvas || typeof THREE === 'undefined') return;
      if(typeof THREE.WebGLRenderer === 'undefined') return;

      /* Before the first await: show() binds the resize listener the moment
         this call returns, and _stopTurntable unbinds it. */
      this._stopTurntable();
      this._disposed  = false;
      this._canvasEl  = canvas;
      this._slots     = [];
      this._floats    = [];
      this._lights    = [];
      this._resTanks  = [];
      this._ownedMats = [];
      this._origMats  = [];
      this._origTexs  = [];
      this._stage     = null;
      this._foundMark = null;
      this._stageMark = null;
      this._resFloor  = null;
      this._pads      = null;
      this._padHalos  = null;
      this._solo      = -1;
      this._soloAngle = 0;
      this._soloVel   = 0;
      this._dragAngle = 0;
      this._dragVel   = 0;
      this._projV     = new THREE.Vector3();

      try {
        this._initScene(canvas);
        this._initRenderer();
      } catch(err){
        console.error('[Results] renderer refused:', err);
        this._stopTurntable();
        return;
      }

      this._stage = await this._loadStageModel();
      if(this._disposed) return;
      this._applyStage();

      try { this._initLights(); } catch(e){ console.warn('[Results] lights:', e); }

      /* Shadow flags AFTER the lights, not before.

         _enableShadows() decides which lights cast by reading `this._lights`, and
         that array is only filled by _initLights(). Called any earlier it sees an
         empty array, casts with nothing, and every tank sits lit from every side
         with nothing on the floor under it — which is exactly the flat,
         unpolished look this was meant to fix, while looking like the shadows
         were simply absent rather than mis-ordered.

         The mesh flags are harmless to set twice, so this ordering only has to be
         right in one direction. */
      this._enableShadows();

      await this._spawnSlots();
      if(this._disposed) return;

      this._buildFloats();
      this._frameCamera();

      this._bindDrag(canvas);
      this._startLoop();
      this.onResize();
    },

    _initScene(canvas){
      this._scene = new THREE.Scene();
      /* FOG: A DARK GREY HALL, not a hint of haze.

         The scene had `Fog(0x0b0e13, 34, 130)` — a colour so close to black it was
         indistinguishable from the backdrop, starting 34 units out on a stage
         whose nearest tank marker is 9 units from the camera. Nothing in frame was
         ever far enough to catch it, so the "atmosphere" was not weak, it was
         absent: the far edge of the stage ended on a hard silhouette against a
         flat wall.

         A dark grey fog, brought in close, is what makes the room feel like a
         room. It separates the three tanks in depth — the back two read as
         further away — and it eats the stage's far edge so it fades into the
         backdrop instead of stopping dead. The colour is a desaturated
         blue-grey rather than the backdrop's near-black, so the haze is visible
         as haze and not just as darkness. */
      /* FOG: DENSE, AND DENSE ON PURPOSE.

         The stage is a single slab 1907 units across, so there is no far edge to
         hide behind — but with the old weak fog (16 to 62) the camera, sitting
         about 26 units back and 9 up, could still see a long way past the three
         markers, and the floor ran out into a flat grey nothing. "You could not
         see through it" means the far floor has to be gone before it starts, not
         merely dimmer by the time it ends.

         So: start almost at the lens and end a little under 60 units out. Every
         marker sits within 24 units of the camera, so all three are still clear,
         and everything past them is fully fogged well inside the slab's own
         extent. The tanks therefore read as three lit objects in a dark room with
         no visible edge to the world at all.

         The colour is a cold slate rather than the backdrop's near-black, so the
         haze is visible as haze instead of reading as absence. */
      try { this._scene.fog = new THREE.Fog(this._stageFogColour, 18, 54); } catch(e){}

      const w = Math.max(2, canvas.clientWidth  || global.innerWidth  || 1280);
      const h = Math.max(2, canvas.clientHeight || global.innerHeight || 720);
      const cam = new THREE.PerspectiveCamera(44, w / h, 0.1, 500);
      cam.position.set(0, 2, 18);
      this._camera = cam;
    },

    _initRenderer(){
      const canvas = document.getElementById('res-tank-canvas');
      if(!canvas) return;
      const w = Math.max(2, canvas.clientWidth  || global.innerWidth  || 1280);
      const h = Math.max(2, canvas.clientHeight || global.innerHeight || 720);

      /* Set BEFORE construction: alpha:false on a canvas that already has a
         context is ignored, and the second battle of a session would keep the
         first battle's setting. */
      let lowSpec = false;
      try {
        if(typeof GraphicsSettings !== 'undefined' && GraphicsSettings.isLowSpec){
          lowSpec = GraphicsSettings.isLowSpec();
        }
      } catch(e){}

      let renderer = null;
      try {
        renderer = new THREE.WebGLRenderer({
          canvas: canvas,
          antialias: !lowSpec,
          alpha: true,
          powerPreference: 'high-performance',
        });
      } catch(e){
        try { renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: true }); }
        catch(e2){ console.error('[Results] WebGL unavailable:', e2); this._stopTurntable(); return; }
      }

      renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, lowSpec ? 1 : 2));
      renderer.setSize(w, h, false);
      /* OPAQUE, IN THE FOG'S OWN COLOUR.

         This was a transparent clear so the banded toon backdrop in the CSS
         would show through "wherever the stage does not reach". On the old
         diorama that was right: the stage had edges, and seeing the page through
         them stopped it reading as a cut-out.

         On a 1900-unit slab it is exactly wrong, and it is what produced the hard
         band across the top of the screen. Fog is applied to FRAGMENTS — geometry
         that is drawn. Above the horizon there is no geometry at all, so nothing
         is fogged there and the transparent clear let the page straight through,
         giving a light band sitting on top of a dark fogged band with a hard seam
         between them. Denser fog does not help, because there is nothing out there
         for it to act on.

         Clearing to the fog colour instead means the empty space above the floor
         IS the fog, the floor fades up into it, and the seam disappears — which is
         the whole point of fogging a floor to hide its edges. */
      const FOGC = this._stageFogColour;
      try { renderer.setClearColor(FOGC, 1); } catch(e){}
      if(renderer.getContext && renderer.getContext().alpha !== undefined){
        /* Asking for an opaque buffer is what actually stops the compositor
           blending the page in underneath, even where the clear colour is set. */
        try {
          const gl = renderer.getContext();
          const attrs = gl.getContextAttributes();
          if(attrs && attrs.alpha === true){
            gl.getExtension('WEBGL_preserveDrawingBuffer');
          }
        } catch(e){}
      }
      renderer.toneMapping = THREE.NoToneMapping;
      if(renderer.outputColorSpace !== undefined && THREE.SRGBColorSpace){
        renderer.outputColorSpace = THREE.SRGBColorSpace;
      }
      if(renderer.shadowMap){
        renderer.shadowMap.enabled = !lowSpec;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        /* Enabling the shadow map is only half of it. three.js renders a shadow
           for a mesh that has `castShadow` set, into a map that a mesh with
           `receiveShadow` set samples — and neither flag was set on anything on
           this stage. So the map was built, every frame, and nothing ever read or
           wrote it: the tanks sat on the floor lit from every side at once, which
           is the flattest thing toon shading can be, and no amount of extra light
           fixed it because the problem was the absence of contact.

           The shadow is what tells you a tank is ON the floor rather than pasted
           in front of it. */
        renderer.shadowMap.autoUpdate = true;
      }
      this._renderer = renderer;
    },

    /* ---------------------------------------------------------- the stage GLB */

    _loadStageModel(){
      return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const done = (v) => {
          if(settled) return;
          settled = true;
          if(timer) clearTimeout(timer);
          resolve(v);
        };
        /* A loader that never answers would leave the screen half-built until
           Game's watchdog throws the player back to the menu. Five seconds is
           longer than any sane fetch of a 100 KB file and shorter than that
           watchdog, so the fallback always wins in time. */
        timer = setTimeout(() => done(null), 5000);

        let L = null;
        try { L = (window.THREE && THREE.GLTFLoader) || window.GLTFLoader || null; } catch(e){}
        if(!L){ done(null); return; }
        let loader = null;
        try { loader = new L(); } catch(e){ done(null); return; }

        try {
          loader.load(this._stageUrl,
            (gltf) => done(gltf && gltf.scene ? gltf.scene : null),
            undefined,
            () => done(null));
        } catch(e){ done(null); }
      });
    },

    _applyStage(){
      const s  = this._scene;
      const st = this._stage;
      if(st && s){
        try { st.updateWorldMatrix(true, true); } catch(e){}
        this._foundMark = this._readMarkers(st);
        this._toonify(st);
        s.add(st);
      } else {
        this._addFallbackFloor();
      }
      /* The rings go on whether or not the stage arrived: they are what tells the
         player where each tank is standing, and on the fallback floor that is the
         only positional cue there is. */
      this._toneStage();
      this._buildPads();
    },

    /* DARKEN THE SLAB.

       "Stylized Concrete" is a pale material — mid-to-light grey with a warm
       cast — and lit at all it fills the entire lower two thirds of the screen
       with near-white. That ruins three things at once: the white rings vanish
       into it because additive white on a bright floor is just brighter white,
       the fog stops against it in a hard line rather than dissolving into it, and
       the tanks have nothing to be brighter than.

       Multiplying the material colour is the right lever rather than dimming the
       lights, because dimming the lights would flatten the tanks as well — they
       are the subject. Darkening the surface under them costs the subject
       nothing and gives the whole screen the dark-room read the fog was already
       built for.

       Multiplied rather than set, so the concrete's own mottling and the texture
       detail survive; set flat, the floor would go to one dead grey. */
    _toneStage(){
      const st = this._stage;
      if(!st || !st.traverse) return;
      try {
        st.traverse((o) => {
          if(!o.isMesh || !o.material || Array.isArray(o.material)) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for(const m of mats){
            if(!m || !m.color) continue;
            /* Below about 0.25 the floor stops reading as a lit surface at all
               and becomes a hole, which is the same failure as a bright one. */
            m.color.multiplyScalar(0.24);
          }
        });
      } catch(e){}
    },

    /* THE THREE RINGS: a white glowing CIRCLE, unfilled, under each tank.

       A ring and not a disc. A filled disc is a bright plate under each tank and
       the tank's own shadow lands on it and disappears into it, so the subject
       loses its contact with the ground exactly where contact is what makes it
       sit there. A ring marks the spot without lighting the floor under it.

       NOT ONE SHARED MESH. Three meshes, because each has to be found and faded
       out on its own when its slot is empty — a mode with fewer than three tanks
       shows a ring with nothing standing in it, which reads as a bug. One merged
       ring would be one draw call cheaper and would make that impossible to
       express.

       Emissive, unlit, additive, and drawn after the floor: a MeshBasicMaterial
       would be shaded by nothing and so read as flat paper, and normal blending
       would darken the floor it is meant to sit over. Additive is what makes it
       read as light rather than paint. */
    _buildPads(){
      const s = this._scene;
      if(!s || this._pads) return;
      const M = this._markers();
      /* Sized off the tank, not off the marker spacing. The tanks are normalised
         to a 6.4-unit span, so their hull is about 3.2 units across the diagonal;
         a 10-unit ring around a 3-unit tank does not read as a marker for that
         tank, it reads as a third of the floor lit up, and three of them washed
         most of the slab out. This sits just outside the tracks. */
      const OUTER = 3.9;
      const WIDTH = 0.26;

      /* A RingGeometry is an annulus in the XY plane, so it has to be laid flat
         before anything else asks where it is. */
      const geo = new THREE.RingGeometry(OUTER - WIDTH, OUTER, 72, 1);
      geo.rotateX(-Math.PI / 2);

      this._pads = [];
      const spots = [M.one, M.two, M.three];
      for(let i = 0; i < spots.length; i++){
        const at = spots[i];
        if(!at) continue;
        let mat = null, mesh = null;
        try {
          mat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            /* Low. Additive white on a surface is additive to WHATEVER IS ALREADY
               THERE, so at 0.85 over a mid-grey floor the ring was brighter than
               white and read as a hole cut in the floor rather than as light on
               it. The floor is now darkened in _toneStage, which is what lets a
               ring this faint still read cleanly. */
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
            fog: false,
          });
          mesh = new THREE.Mesh(geo, mat);
          /* A hair above the slab, not on it: coplanar geometry z-fights, and
             with depthWrite off and additive blending the flicker is very
             visible against a surface this flat. */
          mesh.position.set(at.x, at.y + 0.06, at.z);
          mesh.renderOrder = 4;
          s.add(mesh);
        } catch(e){ mesh = null; mat = null; }
        this._pads.push({ mesh, mat, at: at.clone ? at.clone() : at, i });
      }

      /* The soft outer bloom.

         This was a second, wider RingGeometry, and it was wrong: an annulus has a
         hard edge on both sides, so a faint additive one read as a flat grey DISC
         sitting around each tank rather than as light falling off. Three dull
         circles on the floor, larger than the rings, is a worse picture than no
         bloom at all.

         A glow needs a gradient with no edge, so it is a plane carrying a radial
         falloff, drawn additively: transparent inside the ring, brightest just
         outside it, gone by the outer edge. The crisp ring on top supplies the
         edge that the glow deliberately does not have. */
      const HALO_R = OUTER + 1.2;
      let haloTex = null;
      try {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 128;
        const g = cv.getContext('2d');
        if(g){
          const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
          /* Clear across the middle — this is a glow AROUND the ring, not a pool
             of light under the tank, which would flatten the shadow. */
          grad.addColorStop(0.00, 'rgba(255,255,255,0)');
          grad.addColorStop(0.55, 'rgba(255,255,255,0)');
          grad.addColorStop(0.76, 'rgba(255,255,255,0.85)');
          grad.addColorStop(0.88, 'rgba(255,255,255,0.28)');
          grad.addColorStop(1.00, 'rgba(255,255,255,0)');
          g.fillStyle = grad;
          g.fillRect(0, 0, 128, 128);
          haloTex = new THREE.CanvasTexture(cv);
          haloTex.colorSpace = THREE.SRGBColorSpace;
        }
      } catch(e){ haloTex = null; }

      const halo = haloTex ? new THREE.PlaneGeometry(HALO_R * 2, HALO_R * 2) : null;
      if(halo) halo.rotateX(-Math.PI / 2);
      this._padHalos = [];
      for(const p of this._pads){
        if(!p.mesh || !halo) { this._padHalos.push(null); continue; }
        let m = null;
        try {
          m = new THREE.Mesh(halo, new THREE.MeshBasicMaterial({
            map: haloTex,
            color: 0xbcd8ff,
            transparent: true,
            opacity: 0.55,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
            fog: false,
          }));
          m.position.copy(p.mesh.position);
          m.renderOrder = 3;
          s.add(m);
        } catch(e){ m = null; }
        this._padHalos.push(m);
      }
      /* Deliberately NOT pushed onto _ownedMats.

         That list is disposed generically in the teardown, and the pad materials
         are freed by the ring-specific block alongside it, which knows they are
         SHARED (one geometry across three meshes each). Registering them here
         would dispose them twice — harmless — while leaving the geometry, which
         is not on that list at all, undisposed.

         This line also used to name `mat`, which is scoped to the loop above and
         does not exist out here. It threw a ReferenceError on every single load,
         out of _applyStage, which aborted _buildStage before it ever reached
         _enableShadows() or _spawnSlots(): the rings appeared and the tanks never
         did. */
      if(haloTex && haloTex.dispose){ try { haloTex.dispose(); } catch(e){} }
    },

    /* A ring belongs to a tank, so it follows one. Called from _place, which is
       the only thing that already knows where a slot is. */
    _syncPad(slot){
      if(!this._pads) return;
      const p = this._pads[slot.padIndex != null ? slot.padIndex : -1];
      const halo = this._padHalos ? this._padHalos[slot.padIndex] : null;
      const at = slot.pivot ? slot.pivot.position : null;
      if(!p || !p.mesh || !at) return;
      p.mesh.visible = !!slot.pivot && !!slot.tank;
      if(halo) halo.visible = p.mesh.visible;
      if(p.mesh.visible){
        p.mesh.position.set(at.x, at.y + 0.06, at.z);
        if(halo) halo.position.copy(p.mesh.position);
      }
    },

    /* FLAGS THAT ACTUALLY PUT A SHADOW ON THE FLOOR.

       The renderer was building a shadow map every frame that nothing read and
       nothing wrote. Shadow casting in three.js is opt-in per mesh in BOTH
       directions: the caster must set `castShadow`, the surface must set
       `receiveShadow`, and only then does the light rig need a light that is
       actually able to cast (a DirectionalLight, with its own `castShadow` on).

       The classification is by orientation rather than by name. A horizontal
       surface receives; a vertical one casts. That holds for a tank (hull sides
       cast, the deck and turret roof are horizontal enough to catch a little) and
       for a stage (floor receives, walls and gantries cast), without this file
       needing to know what anything is called — the models are authored elsewhere
       and the names differ per map.

       CALLED AFTER _initLights(), because it reads `this._lights`. */
    _enableShadows(){
      const s = this._scene;
      if(!s) return;

      /* EXACTLY ONE CASTER: the brightest directional light.

         The obvious version — "let every directional light cast" — was what ran
         first, and it put three shadows on the floor from three directions at
         once. They land on top of each other at slightly different angles, so
         every tank had a smear of two or three soft edges rather than one
         definite one: it read as a smudge, not as contact, and it cost three
         shadow passes to do it.

         The brightest directional is the key light by definition of the word, and
         it is picked by measurement rather than by position or by a hardcoded
         index, so it keeps working if the rig is retuned. */
      let key = null;
      for(const L of this._lights){
        if(!L || !L.isDirectionalLight) continue;
        if(!key || L.intensity > key.intensity) key = L;
      }
      if(key){
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.near = 1;
        key.shadow.camera.far = 90;
        const r = 24;
        try {
          key.shadow.camera.left = -r; key.shadow.camera.right = r;
          key.shadow.camera.top = r;   key.shadow.camera.bottom = -r;
          /* Both biases are needed. `bias` alone lets the shadow detach from the
             tank's silhouette and float free of it; `normalBias` alone leaves
             acne on the large flat surfaces of the hull. */
          key.shadow.bias = -0.0012;
          key.shadow.normalBias = 0.035;
          key.shadow.camera.updateProjectionMatrix();
        } catch(e){}
      }
      /* Everything else is explicitly not a caster, so a rig that already had a
         flag set somewhere else cannot quietly add a second shadow. */
      for(const L of this._lights){
        if(!L || L === key) continue;
        if(L.castShadow) L.castShadow = false;
      }

      /* Flag the stage. */
      if(this._stage){
        this._stage.traverse((o) => {
          if(!o.isMesh) return;
          const horiz = this._isHorizontal(o);
          if(horiz){ o.receiveShadow = true; o.castShadow = false; }
          else     { o.castShadow = true;    o.receiveShadow = false; }
        });
      }

      /* And the fallback floor, when the GLB did not load. */
      if(this._resFloor){ this._resFloor.receiveShadow = true; }
    },

    /* Is this mesh's surface facing up? Measured from the geometry's own
       normals rather than from its world rotation, because the stage GLB carries
       transforms on its parents and a mesh lying flat can have a rotated parent. */
    _isHorizontal(o){
      try {
        if(!o.geometry || !o.geometry.attributes || !o.geometry.attributes.normal) return false;
        o.updateWorldMatrix(true, false);
        const nm = new THREE.Matrix3().setFromMatrix4(o.matrixWorld).invert().transpose();
        const v  = new THREE.Vector3();
        let flat = 0, total = 0;
        const n = o.geometry.attributes.normal;
        /* Every 8th vertex is plenty: this only needs to know which way the
           surface points, not to measure an area. */
        const step = Math.max(1, Math.floor(n.count / 64));
        for(let i = 0; i < n.count; i += step){
          v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
          total++;
          if(Math.abs(v.y) > 0.72) flat++;
        }
        return total > 0 && (flat / total) > 0.5;
      } catch(e){ return false; }
    },

    /* The four empties, read in world space. GLTFLoader keeps node names, so
       the single digits survive as-is; the name is still normalised, because a
       re-export that turns "1" into "Axis.001" should fall back to the literals
       rather than silently dropping a marker.

       A node exported as a real glTF CAMERA rather than a plain empty carries a
       lens, and it is kept as `camFov`. Blender exports a camera as a camera
       node only when it is the scene's active camera, so this may or may not be
       populated — which is why `fromFile` only requires the POSITION. A file
       with no lens on the camera still composes correctly and falls back to
       END_CAM.fovDefault. */
    _readMarkers(root){
      const out = {};
      if(!root || !root.traverse) return out;
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      root.traverse((o) => {
        const n = String(o.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        let key = null;
        if(n === '1') key = 'one';
        else if(n === '2') key = 'two';
        else if(n === '3') key = 'three';
        else if(n === 'camera' || n === 'cam') key = 'cam';
        if(!key) return;
        try {
          o.getWorldPosition(p);
          o.getWorldQuaternion(q);
          out[key] = p.clone();
          if(key === 'cam'){
            out.camQuat = q.clone();
            if(o.isCamera && isFinite(o.fov) && o.fov > 1 && o.fov < 170) out.camFov = o.fov;
          }
        } catch(e){}
      });
      return out;
    },

    /* CEL SHADING FOR THE STAGE.

       The GLB arrives with standard materials — smooth ramps of light, which is
       exactly the look this screen is trying to get away from. Every one of
       them is rebuilt as a three-step toon material sharing the original colour
       and map, so the diorama shades in hard bands like the rest of the art.

       MeshBasicMaterial is left alone on purpose: the tanks' outlines are basic
       black silhouettes, and toon-shading an outline lights it up. */
    _toonify(root){
      if(typeof Toon === 'undefined' || !Toon || !Toon.mat) return;
      if(!root || !root.traverse) return;
      const own  = this._ownedMats;
      const orig = this._origMats;
      const texs = this._origTexs;
      const seen = new Map();
      const TEX_SLOTS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap',
                         'metalnessMap', 'aoMap', 'alphaMap', 'lightMap'];

      root.traverse((o) => {
        if(!o.isMesh) return;
        const src = o.material;
        if(!src) return;

        const build = (m) => {
          if(!m || m.isMeshToonMaterial || m.isMeshBasicMaterial) return m;
          orig.push(m);
          for(const k of TEX_SLOTS){ if(m[k] && texs.indexOf(m[k]) < 0) texs.push(m[k]); }
          if(seen.has(m.uuid)) return seen.get(m.uuid);

          const opts = {
            color:       m.color ? m.color.clone() : new THREE.Color(0xffffff),
            map:         m.map || null,
            transparent: !!m.transparent,
            opacity:     (m.opacity != null ? m.opacity : 1),
            side:        (m.side != null ? m.side : THREE.FrontSide),
            alphaTest:   m.alphaTest || 0,
            depthWrite:  m.depthWrite !== false,
          };
          if(m.emissive)                  opts.emissive       = m.emissive.clone();
          if(m.emissiveMap)               opts.emissiveMap    = m.emissiveMap;
          if(m.emissiveIntensity != null) opts.emissiveIntensity = m.emissiveIntensity;
          if(m.alphaMap)                  opts.alphaMap       = m.alphaMap;

          let t = null;
          try { t = Toon.mat(opts); } catch(e){ t = null; }
          if(!t) return m;
          own.push(t);
          seen.set(m.uuid, t);
          return t;
        };

        o.material = Array.isArray(src) ? src.map(build) : build(src);
      });
    },

    /* Only used when the GLB did not load — a plain toon disc under the three
       markers so the tanks are not floating over the void. */
    _addFallbackFloor(){
      const s = this._scene;
      if(!s) return;
      try {
        const M = this._markers();
        const y = (M.one ? M.one.y : 1.55) - 0.02;
        const geo = new THREE.CircleGeometry(70, 56);
        geo.rotateX(-Math.PI / 2);
        let mat = null;
        if(typeof Toon !== 'undefined' && Toon && Toon.mat) mat = Toon.mat({ color: 0x39414d });
        if(!mat) mat = new THREE.MeshBasicMaterial({ color: 0x39414d });
        const m = new THREE.Mesh(geo, mat);
        m.position.y = y;
        s.add(m);
        this._resFloor = m;
        if(mat.isMeshToonMaterial) this._ownedMats.push(mat);
      } catch(e){}
    },

    /* FOUR LIGHTS THAT SHAPED THE OBJECT, PLUS A LIGHT PER MARKER.

       The key/fill/rim give every surface its band; the three point lights are
       the ones the markers ask for. Each sits five units above its floor so the
       pool lands ON the tank rather than glowing out of its belly, with decay 2
       so the pool falls off and the three subjects stay separate instead of
       being flooded by one flat wash. */
    _initLights(){
      const s = this._scene;
      if(!s) return;
      const M = this._markers();

      /* THE RIG, RETUNED FOR AN OPEN SLAB.

         The previous numbers were balanced against a small enclosed diorama, and
         on a floor 1900 units wide with no walls they read as three spotlights
         in a void: the pools fell off into darkness within a few metres and the
         slab between them went flat black, so the tanks looked pasted onto
         nothing rather than standing on a floor.

         Three changes, all in service of the floor reading as a floor:

         HEMISPHERE UP, and lighter underneath. The slab is a horizontal surface
         seen from a shallow angle, so nearly everything the eye reads about it is
         lit by the sky term. At 0.55 with a near-black ground colour it got
         almost nothing. The ground colour is now a mid slate, not 0x2a313d,
         because a hemisphere's lower half is what stands in for light bouncing
         back UP off the floor onto the tanks' undersides.

         KEY RAISED AND WARMED. Higher, so the shadow it throws is shorter and
         reads as contact rather than as a long smear, and warmer than the fill so
         the lit faces separate from the shaded ones by hue as well as by value.

         THE THREE POOLS WIDENED. decay 2 with the old 34 at 5 units up put a hot
         spot on each tank's roof and nothing at all on the floor beside it. They
         are lower, dimmer and much further out, so each one is a broad wash on
         the slab with the tank standing in it — which is what separates three
         subjects from each other. */
      const key  = new THREE.DirectionalLight(0xfff0d2, 0.92);
      key.position.set(-11, 24, 16);
      const fill = new THREE.DirectionalLight(0x9dc3ff, 0.26);
      fill.position.set(15, 7, -13);
      const rim  = new THREE.DirectionalLight(0xffe4bd, 0.50);
      rim.position.set(3, 9, -20);
      const hemi = new THREE.HemisphereLight(0xbfd6f2, 0x4a545f, 0.50);
      s.add(key, fill, rim, hemi);
      this._lights.push(key, fill, rim, hemi);

      const pools = [M.one, M.two, M.three];
      const tints = [0xfff2dc, 0xffe4e0, 0xe4f0ff];
      for(let i = 0; i < pools.length; i++){
        const p = pools[i];
        if(!p) continue;
        const L = new THREE.PointLight(tints[i], 30, 30, 2);
        L.position.set(p.x, p.y + 7.5, p.z);
        s.add(L);
        this._lights.push(L);
      }
    },

    /* ------------------------------------------------------------- the tanks */

    /* Which row stands on which marker.

       1  the player, always — that is who the screen is for
       2  the best enemy by damage
       3  the best TEAMMATE by damage, excluding the player, so the same tank is
          never shown twice when you happen to be top of your own team

       A row that does not exist (a mode with no teams) leaves that marker empty
       rather than inventing a duplicate to fill the frame. */
    _slotRows(d){
      const teams = d.teams || {};
      const rank  = (list) => (list || []).slice().sort((a, b) =>
        (b.damage || 0) - (a.damage || 0) || (b.kills || 0) - (a.kills || 0));

      const mine   = teams.mine   || [];
      const theirs = teams.theirs || [];

      const you = mine.filter(r => r.isYou)[0] || null;
      const me  = you || {
        name:    d.tankName || 'You',
        tankId:  d.tankId || null,
        damage:  (d.stats && d.stats.damage)  || 0,
        kills:   (d.stats && d.stats.kills)   || 0,
        assists: (d.stats && d.stats.assists) || 0,
        isYou:   true,
      };
      me.side = 'mine';

      const out = [me];

      const foes = rank(theirs);
      if(foes.length){ foes[0].side = 'theirs'; out.push(foes[0]); }

      const mates = rank(mine).filter(r => !r.isYou);
      if(mates.length){ mates[0].side = 'mine'; out.push(mates[0]); }

      return out.slice(0, 3);
    },

    /* The Tank class takes a tank DEFINITION, not an id. Passing a bare string
       reaches `def.body.w` inside the constructor and throws, which is how this
       screen ended up drawing its HUD over an empty canvas. */
    _defFor(id){
      try {
        const tables = [];
        try { if(typeof TANKS !== 'undefined' && TANKS) tables.push(TANKS); } catch(e){}
        try {
          if(typeof CONFIG !== 'undefined' && CONFIG && CONFIG.TANKS) tables.push(CONFIG.TANKS);
        } catch(e){}
        for(const t of tables){ if(id && t[id]) return t[id]; }
        for(const t of tables){ if(t.coolbuddy) return t.coolbuddy; }
      } catch(e){}
      return null;
    },

    async _spawnSlots(){
      const s = this._scene;
      if(!s || typeof THREE === 'undefined') return;

      const M         = this._markers();
      const rows      = this._slotRows(this.data || {});
      const anchors   = [M.one, M.two, M.three];
      /* Where the viewer will actually be standing, which is the authored empty
         when the stage file has one. See _cameraPlacement. */
      const camPos    = this._cameraPlacement();
      const FACE_YAW  = [0.20, -0.18, 0.18];

      for(let i = 0; i < rows.length && i < 3; i++){
        const row = rows[i];
        const at  = anchors[i];
        if(!at) continue;
        const def = this._defFor(row && row.tankId);
        if(!def) continue;

        /* Built at the origin with no rotation, measured, and only then moved
           onto its marker: Box3.setFromObject works in WORLD space, so
           measuring a pivot that is already translated and spun returns the
           AABB of a rotated, displaced box — which would centre the tank on
           nothing and size it to a pose that is about to change. */
        const pivot = new THREE.Group();
        s.add(pivot);

        let tank = null;
        try {
          tank = new Tank(def, {
            id:          'res_slot_' + i,
            name:        row.name || 'Tank',
            team:        row.side === 'theirs' ? 'red' : 'blue',
            heading:     0,
            turretAngle: 0,
          });
        } catch(e){ console.warn('[Results] tank build failed:', e); }

        const slot = {
          pivot: pivot, tank: tank, row: row,
          yaw: 0, spin: 0, box: null, height: 2.6,
          /* Which of the three rings this slot owns. Carried on the slot rather
             than derived from position, because the slots and the rings are
             created by two different functions and a positional guess would
             break the moment a marker moved. */
          padIndex: i,
          anchor: new THREE.Vector3(at.x, at.y + 3.4, at.z),
        };
        /* Point the front at the camera, then a small mirrored offset so the
           three do not read as one pose copied.

           Read from _cameraPlacement(), which returns the stage file's "camera"
           empty when it has one. That is the same single source the camera
           itself is placed from, so the tanks and the viewer can never
           disagree about where the viewer is — which is what lets the empty be
           moved in the file without touching this code, and what stops the two
           desynchronising if the camera path is ever changed again.

           The offset is a YAW around the tank's own axis, so it survives a
           camera that has been swung round to any angle: the three end up
           slightly differently posed rather than as three copies of one. */
        try { slot.yaw = Math.atan2(camPos.x - at.x, camPos.z - at.z) + FACE_YAW[i]; }
        catch(e){ slot.yaw = FACE_YAW[i]; }

        this._slots.push(slot);
        if(!tank){ this._place(slot, at); continue; }
        this._resTanks.push(tank);
        try { pivot.add(tank.root); } catch(e){}

        const ready = tank._modelReady;
        if(ready && typeof ready.then === 'function'){
          try { await ready; } catch(e){}
        }
        if(this._disposed) return;

        this._fitSlot(slot, tank, at);

        /* Cast a shadow. The stage was flagged in _applyStage, but the tanks did
           not exist yet at that point — they are built here, after the GLB has
           loaded — so their cast flag has to be set separately or all three sit
           lit from every side with nothing on the floor beneath them.

           Set only after the model is ready and measured, because the flag is
           applied by walking the mesh tree, and walking it before the GLB lands
           walks an empty root and marks nothing. */
        try {
          tank.root.traverse((o) => {
            if(!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = false;
          });
        } catch(e){}
      }
    },

    /* Scale, stand and centre one tank, then park the pivot on its marker.

       Settle the pose BEFORE measuring: bodyGroup carries heading + modelYaw and
       is only ever written by update()/_syncTransform, so measuring first sizes
       the tank to a hull pointing the wrong way. */
    _fitSlot(slot, tank, at){
      try { tank.update(0, null, null); } catch(e){}
      try {
        if(tank.bodyGroup){
          tank.bodyGroup.rotation.y = (tank.heading || 0) + (tank._modelYaw || 0);
        }
      } catch(e){}
      try { tank.root.position.set(0, 0, 0); } catch(e){}
      try { tank.root.updateMatrixWorld(true); } catch(e){}

      try {
        let box = new THREE.Box3().setFromObject(tank.root);
        const sx = box.max.x - box.min.x;
        const sz = box.max.z - box.min.z;
        const span = Math.max(sx, sz, 0.001);
        if(span > 0.001 && span < 1e6){
          tank.root.scale.multiplyScalar(this._tankSpan / span);
          tank.root.updateMatrixWorld(true);
          box = new THREE.Box3().setFromObject(tank.root);
        }
        /* Feet on the marker and centred on the pivot's axis, so spinning the
           tank turns it on the spot instead of orbiting it. */
        tank.root.position.x -= (box.min.x + box.max.x) * 0.5;
        tank.root.position.y -= box.min.y;
        tank.root.position.z -= (box.min.z + box.max.z) * 0.5;
        tank.root.updateMatrixWorld(true);

        slot.box    = new THREE.Box3().setFromObject(tank.root);
        slot.height = Math.max(0.6, slot.box.max.y - Math.min(0, slot.box.min.y));
      } catch(e){ console.warn('[Results] tank fit failed:', e); }

      slot.anchor.set(at.x, at.y + slot.height + 1.35, at.z);
      this._place(slot, at);
    },

    _place(slot, at){
      try {
        slot.pivot.position.set(at.x, at.y, at.z);
        slot.pivot.rotation.y = slot.yaw;
      } catch(e){}
      /* The ring goes where the tank goes, from here — the one function that
         already owns "this slot is at that point". */
      try { this._syncPad(slot); } catch(e){}
    },

    /* WHERE THE CAMERA GOES. One place, read by everything that needs to know:
       the camera itself, and the three tanks' facing.

       THE STAGE FILE'S "camera" EMPTY WINS. Its position is returned verbatim
       whenever the GLB carries one, which is the whole point of the empty being
       in the file: somebody composed this shot, and the code that then placed
       the camera somewhere else was not improving on that composition, it was
       discarding it. This function used to return a hard-coded (-24, 9, 6) and
       the empty was read, copied into the camera, and then overwritten on the
       next line — so the marker existed, was found, and had no effect at all.

       The authored empty in the current file sits at [0, 2.93, 27.24] with a
       three-degree downward pitch: square on, centred, aimed at the middle of
       the trio. That is where the diorama was composed to be seen from, and
       that is where it is now seen from.

       The hard-coded vector is kept ONLY as the fallback for a stage file with
       no camera empty in it, so a missing marker degrades to "a plausible
       three-quarter view" instead of "the camera is inside a wall".

       Because the facing is derived from this vector rather than hard-coded, the
       three tanks re-aim themselves at the real viewpoint on their own. */
    _cameraPlacement(){
      const M = this._markers();
      if(M.fromFile && M.cam) return M.cam;
      if(!this._camPlace) this._camPlace = new THREE.Vector3(-24, 9, 6);
      return this._camPlace;
    },

    /* ---------------------------------------------------- the score plates */

    _buildFloats(){
      const host = document.querySelector('#results-overlay .res-floats');
      if(!host) return;
      try { host.innerHTML = ''; } catch(e){}
      this._floats = [];

      const stat = (v, k) =>
        '<span class="res-float-stat"><b>' + v + '</b><i>' + k + '</i></span>';

      for(const slot of this._slots){
        const r = slot.row || {};
        const cls = r.isYou ? ' you' : (r.side === 'theirs' ? ' foe' : ' ally');
        const el = document.createElement('div');
        el.className = 'res-float' + cls;

        /* TWO LINES: the name, then the numbers under it in a smaller face.

           One line carried name + DMG + KILLS + ASSISTS with the labels inline,
           which made each plate roughly twice as wide as the tank under it. Three
           plates of that width across a row of three tanks overlap long before
           the viewport gets narrow — and they were all CENTRED on their tank, so
           every plate grew equally in both directions and two of them met in the
           middle. The player's plate and the enemy #1's were the pair that met.

           Two lines and a smaller second line is the fix for the width: the
           widest thing on the plate is now the name, and the numbers are set
           under it rather than beside it. Assists are gone from here — they are
           on both leaderboards, in a column, where a column is the right place
           for the third number of three. What is left over a tank is what you
           want while looking AT the tank: who it is and what they did.

           `side` records which way this plate should lean; _drawFloats reads it
           and anchors the plate to the tank's outer edge rather than centring
           it. See the note there for why that is the part that actually stops
           the collision. */
        el.innerHTML =
          '<span class="res-float-name">' + esc(r.name || '') + '</span>' +
          '<span class="res-float-stats">' +
            '<span class="res-float-stat"><i>DMG</i><b>' + fmtNum(r.damage) + '</b></span>' +
            '<span class="res-float-stat"><i>KILLS</i><b>' + fmtNum(r.kills) + '</b></span>' +
          '</span>';
        host.appendChild(el);
        this._floats.push({ el: el, anchor: slot.anchor, isYou: !!r.isYou, row: r });
      }
    },

    /* Project each anchor to screen space. Done in HTML rather than as a sprite
       so the numbers stay sharp and cost nothing to change. */
    _drawFloats(){
      const fs = this._floats;
      if(!fs || !fs.length) return;
      if(!this._camera || !this._projV) return;

      const w = global.innerWidth  || 1280;
      const h = global.innerHeight || 720;
      try { this._camera.updateMatrixWorld(); } catch(e){}

      const v = this._projV;
      for(const f of fs){
        if(!f.el || !f.anchor) continue;
        v.copy(f.anchor).project(this._camera);
        const sx = (v.x * 0.5 + 0.5) * w;
        const sy = (-v.y * 0.5 + 0.5) * h;
        const hidden = (v.z > 1 || v.z < -1) ||
                       sx < -160 || sx > w + 160 || sy < -60 || sy > h + 60;
        if(hidden){
          if(f.el.style.visibility !== 'hidden') f.el.style.visibility = 'hidden';
          continue;
        }
        if(f.el.style.visibility === 'hidden') f.el.style.visibility = '';

        /* GROW AWAY FROM THE CENTRE OF THE SCREEN, NOT OUT FROM THE TANK.

           The plates used to be centred on their tank — translate(-50%,-100%) —
           so every plate extended the same distance both ways regardless of
           where it sat. A plate to the LEFT of centre therefore spent most of
           its width pointing further left, into empty screen, while the half
           nearest its neighbour reached right into that neighbour's plate. The
           player's tank is the middle of the three markers, so it is the worst
           case: it grows into both of its neighbours at once.

           Anchoring the plate to the OUTER edge instead — flush right for a tank
           left of centre, flush left for one right of it — makes each plate grow
           into the empty side by construction. Two plates then cannot meet no
           matter how wide they are or how narrow the window gets, because there
           is no configuration in which both grow towards the same gap.

           THE PLAYER'S PLATE ALWAYS LEANS LEFT. It is the middle tank, so the
           rule above ties, and a tie broken by float order is a coin flip that
           puts the player's numbers under the enemy #1's about half the time.
           Left is chosen because that is the side with no other plate: the
           player's tank sits between the best enemy and the best teammate, and
           of those two, the enemy's board is the one on the right.

           The gap is a fixed offset from the tank rather than a percentage of
           the plate, so the number does not shift as the type scales with the
           viewport. */
        const mid = w * 0.5;
        let dir = (sx < mid) ? -1 : 1;
        if(f.isYou) dir = -1;
        const GAP = 14;
        f.el.style.transform =
          'translate(' + (dir < 0 ? '-100%' : '0') + ',-100%) translate(' +
          (sx + dir * GAP).toFixed(1) + 'px,' + sy.toFixed(1) + 'px)';
      }
    },

    /* ---------------------------------------------------------- the camera */

    /* WHAT IS AUTHORED AND WHAT IS SOLVED

       The stage GLB carries a "camera" empty, and BOTH its position and its
       orientation are taken from it, verbatim. That empty is the composition:
       somebody stood a camera at that point, pointed it at that angle, and
       arranged the floor and the lights around it. Anything the code does to
       that is not an improvement on it.

       This function used to do the opposite. It read the empty, copied its
       position and quaternion into the camera, and then immediately replaced
       both with a hard-coded (-24, 9, 6) and a lookAt at the trio's centroid —
       so the empty was found, honoured for one line, and discarded. The symptom
       was that the diorama was always seen from off to one side, and no amount
       of moving the empty in the file changed anything.

       WHAT IS STILL SOLVED HERE IS ONLY THE LENS.

       The empty cannot know how wide the player's window is, so the field of
       view is not taken from the file — see _frameCamera, which solves it from
       the real bounding boxes of the three tanks and can only ever WIDEN it.
       That is the one thing here that genuinely has to be computed at runtime,
       because it is a property of the viewport and not of the composition.

       Projection is linear in tan(halfFov), so no iteration is needed: a point d
       in front of the camera at height y lands at ndc.y = y / (d * tanV).
       Requiring |ndc| to stay inside the frame therefore gives tanV directly,
       and the four requirements — keep the top in, keep the bottom in, keep the
       sides in, and leave a margin — collapse to one max(). */
    _aimStageCamera(cam, M){
      /* Authored shot: position and orientation both come from the empty and
         neither is touched again. No lookAt, no centroid, no nudge — a
         three-degree pitch the artist dialled in is a three-degree pitch, and
         `lookAt` at the trio's middle would replace it with whatever the marker
         heights happen to average to on any given stage. */
      if(M.fromFile && M.cam){
        cam.position.copy(M.cam);
        if(M.camQuat) cam.quaternion.copy(M.camQuat);
        return;
      }

      /* No camera in the file: place one. Three-quarters and lifted, which is a
         view that separates a one-front-two-back group well enough to read, and
         aimed at the trio's middle a little below the marker heights, where the
         hulls actually are. This is the fallback and only the fallback. */
      const trio = [M.one, M.two, M.three].filter(Boolean);
      if(!trio.length) return;
      const cx = trio.reduce((a, v) => a + v.x, 0) / trio.length;
      const cy = trio.reduce((a, v) => a + v.y, 0) / trio.length;
      const cz = trio.reduce((a, v) => a + v.z, 0) / trio.length;

      cam.position.copy(this._cameraPlacement());
      cam.lookAt(cx, cy - 0.35, cz);
    },

    _frameCamera(){
      const cam = this._camera;
      if(!cam) return;
      const M = this._markers();

      try {
        /* Position and orientation, from the file or from the fallback. All of
           it lives in _aimStageCamera, which is the single place either is
           decided.

           This used to copy `M.cam` and `M.camQuat` in on the two lines before
           this call, which looked like the authored shot was being applied and
           was the reason it was so hard to see that it was not: the copy
           happened, then _aimStageCamera replaced both with hard-coded numbers,
           and the net effect of the two was "the marker is ignored". */
        this._aimStageCamera(cam, M);
        cam.updateMatrixWorld(true);
      } catch(e){}

      const aspect = (isFinite(cam.aspect) && cam.aspect > 0) ? cam.aspect : 1.7;

      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up    = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      const fwd   = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).negate();
      const org   = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);

      let maxUp = -Infinity, minUp = Infinity, maxSide = 0, any = false;
      const push = (x, y, z) => {
        const vx = x - org.x, vy = y - org.y, vz = z - org.z;
        const d = vx * fwd.x + vy * fwd.y + vz * fwd.z;
        if(!(d > 0.5)) return;
        const rUp = (vx * up.x + vy * up.y + vz * up.z) / d;
        const rSd = (vx * right.x + vy * right.y + vz * right.z) / d;
        if(rUp > maxUp) maxUp = rUp;
        if(rUp < minUp) minUp = rUp;
        const a = Math.abs(rSd);
        if(a > maxSide) maxSide = a;
        any = true;
      };

      if(this._slots){
        for(const sl of this._slots){
          const b = sl.box;
          if(!b || !sl.pivot) continue;
          /* A SWEPT CIRCLE, not the current AABB: the player can spin a tank a
             full 360, and a frame fitted to the pose it happens to be in crops
             it the moment they turn it. */
          const dx = b.max.x - b.min.x;
          const dz = b.max.z - b.min.z;
          const r  = 0.5 * Math.sqrt(dx * dx + dz * dz);
          const px = sl.pivot.position.x;
          const py = sl.pivot.position.y;
          const pz = sl.pivot.position.z;
          const y0 = py + Math.min(0, b.min.y);
          const y1 = py + b.max.y;
          for(let k = 0; k < 4; k++){
            const sx = (k & 1) ? r : -r;
            const sz = (k & 2) ? r : -r;
            push(px + sx, y0, pz + sz);
            push(px + sx, y1, pz + sz);
          }
        }
      }

      if(!any || !isFinite(maxUp) || !isFinite(minUp)){
        const fallback = END_CAM.fovDefault;
        if(cam.fov !== fallback){ cam.fov = fallback; cam.updateProjectionMatrix(); }
        return;
      }

      /* THE LENS IS A NO-CROP GUARANTEE, NOT A FRAMING DECISION.

         This is the one part of the camera that cannot come from the file, and
         the difference matters now that the file's camera is actually used. The
         empty was placed for one window shape; the player's window is whatever
         it is, from a 4:3 laptop to a 21:9 monitor, and on a narrow one the
         outer two tanks fall off the sides of the frame.

         So: start from the AUTHORED lens — `M.camFov`, not `cam.fov` — and take
         whichever is wider of that and whatever the geometry needs. It never
         goes narrower than the authored lens, and because the starting point is
         the authored value and not the current one, the answer is the same every
         time it is asked rather than a running maximum.

         That distinction is the whole reason it is written this way. Starting
         from `cam.fov` reads identically and is a trap: one resize to a narrow
         window widens the lens to its ceiling, every later call sees a camera
         that is already wide and widens it no further, and the diorama stays
         permanently zoomed out for the rest of the session even after the
         window goes back to a normal shape.

         The old code solved the field of view from scratch — filling exactly 70%
         of the height — which is a re-framing decision dressed up as a
         constraint, and it is why the camera could be corrected back to the
         empty's position and still not look like the shot in the file.

         The four requirements collapse to one max(): keep the top in, keep the
         bottom in, keep both sides in, and leave a margin so a tank being spun
         right up against the edge does not clip. */
      let tanV = Math.tan(Math.max(M.camFov, END_CAM.fovDefault) * 0.5 * Math.PI / 180);

      /* The trio is NOT centred on the camera's axis — the empty aims slightly
         above them — so fitting the extent alone would be happy while the
         bottom of the nearest tank ran off the edge. */
      if(maxUp > 0)   tanV = Math.max(tanV, maxUp   / END_CAM.margin);
      if(minUp < 0)   tanV = Math.max(tanV, -minUp  / END_CAM.margin);
      if(maxSide > 0) tanV = Math.max(tanV, maxSide / (END_CAM.margin * aspect));

      /* 30deg..74deg. Below that the diorama becomes a telescope; above it the
         straight lines of a cartoon stage bow into a fisheye. */
      const MIN = Math.tan(15 * Math.PI / 180);
      const MAX = Math.tan(37 * Math.PI / 180);
      tanV = Math.max(MIN, Math.min(MAX, tanV));

      const fov = 2 * Math.atan(tanV) * 180 / Math.PI;
      if(Math.abs(cam.fov - fov) > 0.005){
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    },
    /* ------------------------------------------------------------ drag to spin */

    /* WHICH TANK IS UNDER THE POINTER.

       There are three tanks on this screen, and "drag to spin" only makes sense
       per tank: a player who grabs the enemy's tank expects THAT one to turn.
       Dragging empty space still turns all three, so nothing the old screen did
       is lost. Returns -1 when nothing is hit. */
    _pick(clientX, clientY){
      try {
        if(typeof THREE === 'undefined' || !THREE.Raycaster) return -1;
        if(!this._camera || !this._slots || !this._slots.length) return -1;
        if(!this._canvasEl) return -1;

        /* Through the canvas rect, not the window: on a narrow screen the canvas
           is only the lower band of the page, and mapping to the window would
           pick a tank the pointer is nowhere near. */
        const r = this._canvasEl.getBoundingClientRect();
        const w = r.width  || global.innerWidth  || 1280;
        const h = r.height || global.innerHeight || 720;
        if(!(w > 0 && h > 0)) return -1;
        const nx = ((clientX - r.left) / w) * 2 - 1;
        const ny = -(((clientY - r.top) / h) * 2 - 1);
        if(!isFinite(nx) || !isFinite(ny)) return -1;

        if(!this._ray) this._ray = new THREE.Raycaster();
        this._ray.setFromCamera({ x: nx, y: ny }, this._camera);

        const meshes = [];
        for(const sl of this._slots){
          if(!sl.pivot) continue;
          sl.pivot.traverse((o) => { if(o.isMesh) meshes.push(o); });
        }
        if(!meshes.length) return -1;

        const hits = this._ray.intersectObjects(meshes, false);
        if(!hits || !hits.length) return -1;

        for(const hit of hits){
          for(let i = 0; i < this._slots.length; i++){
            let p = hit.object;
            while(p){
              if(p === this._slots[i].pivot) return i;
              p = p.parent;
            }
          }
        }
      } catch(e){}
      return -1;
    },

    /* Hand the accumulated solo spin over to the tank it belongs to before
       picking a new one, so a tank never snaps back to the pose it had when the
       screen opened. */
    _beginSolo(idx){
      const prev = this._solo;
      if(prev >= 0 && this._slots && this._slots[prev]){
        this._slots[prev].spin += this._soloAngle;
      }
      this._solo = (idx >= 0 && this._slots && this._slots[idx]) ? idx : -1;
      this._soloAngle = 0;
      this._soloVel   = 0;
      this._dragVel   = 0;
    },

    _bindDrag(canvas){
      const down = (e) => {
        this._dragging = true;
        const px = (e.touches ? e.touches[0].clientX : e.clientX);
        const py = (e.touches ? e.touches[0].clientY : e.clientY);
        this._lastX = px;
        this._lastT = performance.now();
        this._beginSolo(this._pick(px, py));
        if(e.preventDefault) e.preventDefault();
      };
      const move = (e) => {
        if(!this._dragging) return;
        const x = (e.touches ? e.touches[0].clientX : e.clientX);
        const dx = x - this._lastX;
        this._lastX = x;
        if(this._solo >= 0) this._soloAngle += dx * 0.011;
        else                 this._dragAngle += dx * 0.011;
        /* Inertia: flick it and it keeps turning, easing down. Measured against
           the wall clock rather than a frame count, so it feels the same on a
           60Hz and a 144Hz display. */
        const now = performance.now();
        const dt = Math.max(0.001, (now - this._lastT) / 1000);
        this._lastT = now;

        /* Velocity, CLAMPED.

           Dividing by dt makes this correct for a real drag — a fast flick and a
           slow one produce different speeds, which is what makes it feel like
           momentum rather than a fixed step. But it also makes the result
           unbounded when dt is very small, and dt is very small whenever two
           mousemove events land in the same millisecond: a synthetic burst, a
           stuttering main thread, or a browser coalescing events after the tab
           has been blocked. Measured unclamped, a single 70-pixel jump produced
           a release speed of 269 rad/s, which sent the tank through 58 radians
           — eight and a half full turns — in the third of a second the test
           waited.

           6 rad/s is about one turn per second: a firm flick coasts to a stop
           in roughly a second and a half. That is the right weight for a heavy
           tank on a display turntable — 14 rad/s spun it through half a turn in
           a third of a second, which read as a toy rather than a machine.

           Clamping the SPEED rather than the per-event step means a genuine fast
           flick still feels faster than a slow one; it just cannot leave the
           plausible range. */
        const vel = (dx * 0.011 / dt) * 0.35;
        const MAX = 6;
        const clamped = vel > MAX ? MAX : (vel < -MAX ? -MAX : vel);
        /* Only the mode actually being dragged may coast: leaving the global
           velocity live during a solo spin would start turning the other two
           tanks the moment they were meant to sit still. */
        if(this._solo >= 0) this._soloVel = clamped;
        else                 this._dragVel = clamped;
        if(e.preventDefault) e.preventDefault();
      };
      const up = () => { this._dragging = false; };

      canvas.addEventListener('mousedown', down);
      global.addEventListener('mousemove', move);
      global.addEventListener('mouseup', up);
      canvas.addEventListener('touchstart', down, { passive:false });
      canvas.addEventListener('touchmove', move, { passive:false });
      global.addEventListener('touchend', up);

      /* Torn down with the screen, or a hidden results screen keeps eating
         mousemove for the whole next battle. */
      this._unbindDrag = () => {
        canvas.removeEventListener('mousedown', down);
        global.removeEventListener('mousemove', move);
        global.removeEventListener('mouseup', up);
        canvas.removeEventListener('touchstart', down);
        canvas.removeEventListener('touchmove', move);
        global.removeEventListener('touchend', up);
      };
    },

    /* ------------------------------------------------------------------- loop */

    /* THE RENDER LOOP, AND WHY THERE ARE TWO CLOCKS.

       requestAnimationFrame is the right clock for this — it is synced to the
       display, so the tank turns as smoothly as the monitor can show. But rAF is
       THROTTLED HARD by the browser whenever the tab is not visible: measured in
       this project, a background tab gets between 1 and 6 rAF callbacks per
       second while setInterval keeps firing at full rate.

       That matters more here than it does in the battle, because the results
       screen is exactly where a player is likely to alt-tab — check a message,
       look something up — and on a hidden tab the turntable stops dead. Come
       back and it resumes, so it is not permanently broken, but a player who
       switches away for ten seconds and comes back to a frozen tank reads it as
       a broken screen rather than a paused one.

       So: rAF drives the loop normally, and a timer fires a frame only when rAF
       has been quiet for more than 100 ms. That threshold is measured, not
       guessed — a 200 ms one was tried and skipped on 711 of 770 ticks, because
       a background tab's rAF still fires often enough to clear 200 ms while
       being far too slow to look smooth. 100 ms is the point where a human can
       actually see the difference. */

       STALE_RAF_MS: 100,

    _startLoop(){
      if(this._timer) return;

      this._lastFrameAt = 0;

      const step = (nowMs) => {
        if(this._disposed || !this.open) return;
        this._raf = requestAnimationFrame(step);

        /* Real elapsed time, not a hardcoded 1/60.

           A fixed timestep makes the animation frame-rate DEPENDENT: on a 144Hz
           display the tank would turn two and a half times faster than on a 60Hz
           one. Worse, the frame that runs after a stall would advance the spin
           by 16ms when half a second has actually passed, so the tank visibly
           stutters rather than catching up. Clamped so a long stall — switching
           away and back — does not teleport the tank through half a revolution
           on the first frame back. */
        const now = nowMs || performance.now();
        let dt = this._lastFrameAt ? (now - this._lastFrameAt) / 1000 : 1 / 60;
        this._lastFrameAt = now;
        if(!(dt > 0)) dt = 1 / 60;
        if(dt > 0.1) dt = 0.1;

        this._frame(dt);
      };

      this._raf = requestAnimationFrame(step);

      /* The fallback. Kept as a plain setInterval so it keeps firing while the
         tab is hidden, which is the entire reason it exists. */
      this._timer = setInterval(() => {
        if(this._disposed || !this.open) return;
        /* Only step in when rAF has genuinely stopped keeping up. When it is
           running normally this never fires, so a visible tab pays nothing for
           the safety net. */
        if(performance.now() - this._lastFrameAt < this.STALE_RAF_MS) return;
        const now = performance.now();
        let dt = (now - this._lastFrameAt) / 1000;
        this._lastFrameAt = now;
        if(!(dt > 0)) dt = 1 / 60;
        if(dt > 0.1) dt = 0.1;
        this._frame(dt);
      }, 33);
    },

    /* One rendered frame. Split out of the loop so both clocks drive exactly
       the same code — a duplicated frame body is where two clocks quietly drift
       apart. */
    _frame(dt){
      if(this._slots && this._slots.length){
        /* NO IDLE SPIN. The tanks stand still until one of them is dragged.

           It used to turn slowly on its own forever, handing the spin back to an
           idle whenever the flick ran out. That was wrong for the screen: a
           rotating tank cannot be read, so the one thing the results screen is
           for — looking at your tank and comparing it with how it performed —
           was made harder by the presentation. It also meant the tank was never
           still long enough to take in, and a player comparing two tanks could
           never see either of them square-on.

           The camera angle is chosen so the resting pose is the good one (three
           quarters, slightly above), which is why nothing needs to move for the
           tank to look its best. */
        if(!this._dragging && this._dragVel !== 0){
          this._dragAngle += this._dragVel * dt;
          this._dragVel *= Math.pow(0.94, dt * 60);   /* inertia decay, per-60fps-step */
          if(Math.abs(this._dragVel) < 0.02) this._dragVel = 0;
        }
        /* The same coast for a tank being spun on its own. Its velocity is zeroed
           whenever a different tank — or empty space — is picked, so this can
           never run against the wrong subject. */
        if(!this._dragging && this._solo >= 0 && this._soloVel !== 0){
          this._soloAngle += this._soloVel * dt;
          this._soloVel *= Math.pow(0.94, dt * 60);
          if(Math.abs(this._soloVel) < 0.02) this._soloVel = 0;
        }

        /* dragAngle turns all three together; spin is what each tank has been
           turned by on its own; soloAngle is the spin still under the finger. */
        const solo = this._solo;
        for(let i = 0; i < this._slots.length; i++){
          const sl = this._slots[i];
          if(!sl || !sl.pivot) continue;
          sl.pivot.rotation.y =
            sl.yaw + this._dragAngle + (sl.spin || 0) + (i === solo ? this._soloAngle : 0);
        }
        this._drawFloats();
      }

      if(this._renderer && this._scene && this._camera){
        this._renderer.render(this._scene, this._camera);
      }
    },

    _stopLoop(){
      if(this._raf){ cancelAnimationFrame(this._raf); this._raf = 0; }
      if(this._timer){ clearInterval(this._timer); this._timer = 0; }
    },

    _stopTurntable(){
      this._disposed = true;
      this._stopLoop();
      this._unbindResize();
      if(this._unbindDrag){ this._unbindDrag(); this._unbindDrag = null; }

      /* THE TANKS GO FIRST, and each through Tank.dispose().

           Tank.dispose() is deliberately selective: model geometry is SHARED
           through Models._cache across every tank of that class, so it frees
           only the per-tank objects it made. Which is exactly why this must not
           be replaced with a blanket traverse-and-dispose of the scene. Doing
           that would free the cached hull geometry, and the next battle — or the
           next tank built from the same cache entry — would render with no
           geometry at all: an invisible tank, with no error anywhere to point
           at. */
      if(this._resTanks){
        for(const t of this._resTanks){ try { t.dispose(); } catch(e){} }
        this._resTanks = null;
      }
      this._slots = null;

      /* The score plates are plain DOM, and the container stays in the overlay
         for the next battle, so it is emptied rather than removed. */
      const floats = document.querySelector('#results-overlay .res-floats');
      if(floats){ try { floats.innerHTML = ''; } catch(e){} }
      this._floats = null;

      /* THE STAGE IS THIS SCREEN'S OWN COPY of the GLB — it never goes through
         Models._cache — so its geometry, the materials it arrived with, the
         toon materials that replaced them and their textures are all owned here
         and all have to go, once per battle. */
      if(this._stage){
        try {
          this._stage.traverse((o) => {
            if(o.isMesh && o.geometry){ try { o.geometry.dispose(); } catch(e){} }
          });
        } catch(e){}
        this._stage = null;
      }
      for(const listKey of ['_origMats', '_origTexs', '_ownedMats']){
        const list = this[listKey];
        if(list){ for(const x of list){ try { x.dispose(); } catch(e){} } }
        this[listKey] = null;
      }
      if(this._resFloor){
        if(this._resFloor.geometry){ try { this._resFloor.geometry.dispose(); } catch(e){} }
        if(this._resFloor.material){ try { this._resFloor.material.dispose(); } catch(e){} }
        this._resFloor = null;
      }
      /* The rings: three meshes and three halos, and their two geometries are
         SHARED across all six meshes. Disposing a shared geometry once per mesh
         would free it three times over; the first dispose wins and the rest are
         harmless no-ops, but the pairing below is the honest one. */
      if(this._pads || this._padHalos){
        const seenGeo = new Set();
        const all = (this._pads || []).map(p => p.mesh).concat(this._padHalos || []);
        for(const m of all){
          if(!m) continue;
          if(m.geometry && !seenGeo.has(m.geometry)){ seenGeo.add(m.geometry); try { m.geometry.dispose(); } catch(e){} }
          if(m.material){ try { m.material.dispose(); } catch(e){} }
        }
        this._pads = null;
        this._padHalos = null;
      }
      this._lights   = null;
      this._stageMark = null;
      this._foundMark = null;
      this._canvasEl  = null;
      this._ray       = null;
      this._projV     = null;
      this._solo      = -1;
      this._soloAngle = 0;
      this._soloVel   = 0;
      this._dragAngle = 0;
      this._dragVel   = 0;
      this._turntable = null;
      this._tank      = null;
      this._floor     = null;
      this._floorTex  = null;
      this._shadow    = null;

      if(this._scene){
        this._scene.clear();
        this._scene = null;
      }
      if(this._renderer){
        try { this._renderer.dispose(); } catch(e){}
        try { this._renderer.forceContextLoss && this._renderer.forceContextLoss(); } catch(e){}
        this._renderer = null;
      }
      this._camera = null;
    },

    /* Re-measure on resize, or the tank is stretched on any window change.

       Three things have to happen together, and doing only the first is the
       common version of this bug:

         1. the renderer's drawing buffer is resized, with updateStyle=false so
            the canvas keeps its 100%/100% CSS size and only the buffer changes.
            Without the flag a resize scales the canvas element itself and drags
            the whole layout with it;

         2. the camera's aspect is corrected, or the tank comes out stretched
            rather than merely re-rendered sharper;

         3. the framing is RECOMPUTED. The panel is not a fixed shape — it goes
            from three columns to two to one as the window narrows — so the
            aspect the camera was fitted for is not the aspect it has now. On a
            wide-to-narrow resize the old framing is fitted to a shape that no
            longer exists, and the tank is cropped. Refitting is cheap because
            it measures the box again rather than doing any work per frame. */
    onResize(){
      if(!this.open || !this._renderer) return;
      if(!document.getElementById('res-tank-canvas')) return;
      const w = Math.max(2, global.innerWidth  || 1280);
      const h = Math.max(2, global.innerHeight || 720);
      this._renderer.setSize(w, h, false);
      if(this._camera){
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
      }
      if(this._slots && this._slots.length) this._frameCamera();
      /* Draw once immediately. Between the resize event and the next animated
         frame there is a visible beat where the canvas shows the OLD buffer
         stretched into the new box — a single frame of a squashed tank. */
      this._frame(0);
    },

    /* Attach the window listener for the lifetime of the screen.

       Deliberately NOT attached at load: a permanent listener on a screen that is
       open once per battle means every resize between battles calls into a
       renderer that has been disposed. Attaching on show and detaching on hide
       means the handler only ever runs while there is something to resize. */
    _bindResize(){
      if(this._onWinResize) return;
      this._onWinResize = () => this.onResize();
      global.addEventListener('resize', this._onWinResize);
      global.addEventListener('orientationchange', this._onWinResize);
    },

    _unbindResize(){
      if(!this._onWinResize) return;
      global.removeEventListener('resize', this._onWinResize);
      global.removeEventListener('orientationchange', this._onWinResize);
      this._onWinResize = null;
    },
  };

  /* ---------------------------------------------------------------- helpers */

  function esc(v){
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Thousands separators, the way every number in a results screen is written.
     Plain String(number) would put "87950" where the reference has "87 950". */
  function fmtNum(n){
    const v = Math.round(Number(n) || 0);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  global.Results = Results;
})(typeof window !== 'undefined' ? window : globalThis);
