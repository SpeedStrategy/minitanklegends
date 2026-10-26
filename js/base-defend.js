/* ============================================================
   base-defend.js — Base Defend game mode
   ------------------------------------------------------------
   Two teams, unlimited respawns, one destructible base each.
   First team to take the enemy base to zero wins.

   THE MAP DECIDES WHERE THE BASES ARE
   ────────────────────────────────
   A map marks its bases by NAME, the same vocabulary the rest of
   the GLB loader already speaks (see World.loadGLBModel):

       base        a base, side not stated
       bluebase    the blue team's base
       redbase     the red team's base

   `base.001` and `red_base` work too — GLTFLoader appends `.001`
   to de-duplicate names, and nobody writes a separator
   consistently. A map with no base at all still plays: the bases
   are placed at the two spawn clusters instead, which is the same
   piece of ground each team is defending anyway.

   WHAT A BASE IS RIGHT NOW
   ───────────────────────
   A cube. That is deliberate and it is not a placeholder left by
   accident — it is the whole hit-volume story. Base Defend has no
   physics body and no collider for its bases, so a shell is caught
   by a 2D distance test against the base's position (see
   _baseDefendHit). A cube drawn at exactly the size that test
   uses cannot be shot "around the corner of", and swapping in a
   real model later means changing ONE number, `baseSize`.

   Visuals are still worth doing properly, because the base is the
   single object the player is aiming at all match:
     • a solid toon-shaded core in the owning team's colour
     • a darker plinth so it reads as a building, not a floating box
     • four corner posts and a top rail in a brighter tint
     • a soft ground glow in team colour
     • a hovering HP panel drawn to canvas — team name, a bar, the
       number — which redraws only when the value actually changes
     • hit flash, and a shake when it is struck
     • on death: the core falls away and the wreck smokes
   ============================================================ */

const BaseDefend = (() => {
  let _game = null;
  let _state = null;

  let _hudEls = null;          // cached DOM for the HUD panel
  let _hudKey = '';            // last string written, so we only touch the DOM on change

  const BLUE = 0x4488ff, RED = 0xff4444;
  const AMBER = 0xfbbf24, WHITE = 0xffffff;

  const CFG = () => GAMEMODES.baseDefend;
  const MAX_HP = () => CFG().baseHp || 1000;
  const SIZE  = () => CFG().baseSize || 16;

  /* The shell-to-base test needs a radius, and it is derived from the SIZE the
     cube is actually drawn at rather than being a second number that can drift
     out of step with it. A shell that visually clips the corner of the base and
     sails past it because the hitbox is smaller than the model is the single
     most annoying thing this mode could do. */
  const HIT_R = () => SIZE() * 0.62;

  /* ── canvas helpers ──────────────────────────────────────────────────── */
  const _hex = (n) => '#' + ('000000' + (n >>> 0).toString(16)).slice(-6);

  function _radialGlow(){
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0.0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.28)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.LinearFilter;
    return t;
  }

  /* ── where the bases go ─────────────────────────────────────────────── */

  /* A map may state a base's side in its name, may leave it out, and may ship
     no base at all. All three are answered here, in one place, so the placement
     rules are readable together instead of being spread across the loader and
     the starter. */
  function _resolvePlacements(marks, ctx){
    const blueSpawns = (ctx && ctx.blueSpawns) || [];
    const redSpawns  = (ctx && ctx.redSpawns)  || [];
    const out = [];

    const centroid = (list) => {
      if(!list || !list.length) return null;
      let x = 0, z = 0;
      for(const s of list){ x += s.pos.x; z += s.pos.z; }
      return { x: x / list.length, z: z / list.length };
    };
    const blueC = centroid(blueSpawns);
    const redC  = centroid(redSpawns);

    /* The marks the loader already read off the map. */
    for(const m of (marks || [])){
      let team = m.team;
      /* A bare `base` has no side in its name, so it is assigned by which
         spawn cluster it is nearer. Guessing here rather than refusing is
         deliberate: a map that names one base `base` and the other
         `redbase` is a normal thing for a level designer to produce, and
         the geometry already says which is which. */
      if(!team){
        if(blueC && redC){
          const dBlue = Math.hypot(m.x - blueC.x, m.z - blueC.z);
          const dRed  = Math.hypot(m.x - redC.x,  m.z - redC.z);
          team = (dBlue <= dRed) ? 'blue' : 'red';
        } else {
          team = 'blue';
        }
      }
      out.push({ team, x: m.x, y: m.y, z: m.z, fromMap: true, name: m.name });
    }

    /* FALLBACK: no base entity, or only one side marked. The bases go on the
       teams' own ground — the spawn cluster, pushed a little further back from
       the middle so they are BEHIND the spawns rather than in the middle of
       them. That ordering matters: a base sitting among its own spawn points
       gets a respawning tank parked inside it, and the thing the player is
       defending becomes a place they cannot drive.

       Push distance is a fraction of the gap between the two clusters rather
       than a fixed number of units, so it behaves the same on a 240-unit map
       and a 1700-unit one. */
    const need = {};
    for(const t of ['blue', 'red']) if(!out.some(b => b.team === t)) need[t] = true;

    if(need.blue || need.red){
      let cx = 0, cz = 0, n = 0;
      if(blueC){ cx += blueC.x; cz += blueC.z; n++; }
      if(redC){ cx += redC.x; cz += redC.z; n++; }
      if(!n){ cx = 0; cz = 0; }
      else { cx /= n; cz /= n; }

      const gap = (blueC && redC) ? Math.hypot(redC.x - blueC.x, redC.z - blueC.z) : 120;
      const back = Math.max(18, gap * 0.16);

      if(need.blue){
        const p = blueC || { x: cx - gap * 0.4, z: cz };
        const dx = blueC ? (blueC.x - cx) : -1;
        const dz = blueC ? (blueC.z - cz) : 0;
        const len = Math.hypot(dx, dz) || 1;
        out.push({
          team:'blue', fromMap:false,
          x: p.x + (dx / len) * back, z: p.z + (dz / len) * back,
          y: 0, name:'blue base (auto)',
        });
      }
      if(need.red){
        const p = redC || { x: cx + gap * 0.4, z: cz };
        const dx = redC ? (redC.x - cx) : 1;
        const dz = redC ? (redC.z - cz) : 0;
        const len = Math.hypot(dx, dz) || 1;
        out.push({
          team:'red', fromMap:false,
          x: p.x + (dx / len) * back, z: p.z + (dz / len) * back,
          y: 0, name:'red base (auto)',
        });
      }
    }

    /* One base per side, always. If a map somehow declares two blue bases the
       extras are dropped rather than all being given hit points — this mode has
       exactly two objectives and the HUD, the win check and the bot target
       picker are all written on that basis. */
    const seen = new Set();
    const final = [];
    for(const b of out){
      if(seen.has(b.team)) continue;
      seen.add(b.team);
      final.push(b);
    }
    for(const t of ['blue', 'red']){
      if(!seen.has(t)) final.push({ team:t, x:0, z:0, y:0, fromMap:false, name:t + ' base (auto)' });
    }
    return final;
  }

  /* ── one base ────────────────────────────────────────────────────────── */

  function _buildBase(spot, groundY){
    const teamHex = (spot.team === 'blue') ? BLUE : RED;
    const s = SIZE();
    const half = s / 2;
    const grp = new THREE.Group();
    grp.position.set(spot.x, groundY, spot.z);

    /* Core. The hit volume (HIT_R) is derived from `s`, so this box and the
       shell test are the same size by construction. */
    const coreMat = Toon.mat({
      color: teamHex, emissive: teamHex, emissiveIntensity: 0.18,
      transparent:true, opacity:0.94,
    });
    const core = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.82, s), coreMat);
    core.position.y = s * 0.41 + s * 0.06;
    core.castShadow = true; core.receiveShadow = true;
    grp.add(core);

    /* Plinth. Dark, wider and flatter, so the base reads as a building standing
       on the ground rather than a cube hovering over it. */
    const plinthMat = Toon.mat({ color: 0x1b2030, emissive: 0x000000, emissiveIntensity: 0 });
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(s * 1.16, s * 0.14, s * 1.16), plinthMat);
    plinth.position.y = s * 0.07;
    plinth.receiveShadow = true;
    grp.add(plinth);

    /* Corner posts + top rail, in a brighter tint of the team colour. These are
       what make the silhouette legible from across the arena, which is the whole
       job of an objective marker in a mode where the camera is behind a tank. */
    const trimMat = Toon.mat({
      color: teamHex, emissive: teamHex, emissiveIntensity: 0.55,
    });
    const t = s * 0.075;
    const postH = s * 0.9;
    for(const sx of [-1, 1]) for(const sz of [-1, 1]){
      const post = new THREE.Mesh(new THREE.BoxGeometry(t, postH, t), trimMat);
      post.position.set(sx * (half - t), s * 0.06 + postH / 2, sz * (half - t));
      post.castShadow = true;
      grp.add(post);
    }
    const railGeoLR = new THREE.BoxGeometry(s, t, t);
    const railGeoFB = new THREE.BoxGeometry(t, t, s);
    const railY = s * 0.06 + postH;
    const railA = new THREE.Mesh(railGeoLR, trimMat); railA.position.set(0, railY,  half - t);
    const railB = new THREE.Mesh(railGeoLR, trimMat); railB.position.set(0, railY, -(half - t));
    const railC = new THREE.Mesh(railGeoFB, trimMat); railC.position.set( half - t, railY, 0);
    const railD = new THREE.Mesh(railGeoFB, trimMat); railD.position.set(-(half - t), railY, 0);
    grp.add(railA, railB, railC, railD);

    /* Ground glow — a soft disc of team colour under the whole thing. */
    const glowTex = _radialGlow();
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(s * 2.6, s * 2.6),
      new THREE.MeshBasicMaterial({
        map: glowTex, color: teamHex, transparent:true, opacity:0.34,
        depthWrite:false, blending:THREE.AdditiveBlending, toneMapped:false,
      })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.05;
    glow.renderOrder = 1;
    grp.add(glow);

    /* The floating HP panel. Drawn to canvas like the Circle's, because it is
       the same problem — a crisp number and bar that always faces the player and
       costs one sprite. */
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 104;
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent:true, depthWrite:false, depthTest:false,
    }));
    sprite.scale.set(s * 1.5, s * 1.5 * (104 / 320), 1);
    sprite.position.y = s * 1.35;
    sprite.renderOrder = 9;
    grp.add(sprite);

    return {
      team: spot.team, teamHex, fromMap: !!spot.fromMap, name: spot.name,
      x: spot.x, z: spot.z, y: groundY,
      hp: MAX_HP(), maxHp: MAX_HP(),
      alive: true, deadAt: 0,
      grp, core, plinth, glow, sprite,
      mats: [coreMat, plinthMat, trimMat],
      tex, canvas, glowTex,
      /* Runtime-only animation state. */
      _flash: 0, _shake: 0, _wobble: Math.random() * Math.PI * 2,
      _smoke: null, _smokeT: 0,
      _drawKey: '',
    };
  }

  /* ── the panel above the base ────────────────────────────────────────── */

  function _drawPanel(b, frac){
    const key = Math.round(frac * 100) + '|' + b.team + '|' + (b.alive ? 1 : 0);
    if(key === b._drawKey) return;
    b._drawKey = key;

    const c = b.canvas, x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    const col = _hex(b.teamHex);

    /* Frame */
    x.fillStyle = 'rgba(6,9,16,0.78)';
    x.beginPath(); x.roundRect(6, 10, 308, 84, 14); x.fill();
    x.lineWidth = 3;
    x.strokeStyle = b.alive ? col : 'rgba(255,255,255,0.25)';
    x.stroke();

    x.textAlign = 'center';
    x.fillStyle = b.alive ? col : '#8a90a4';
    x.font = 'bold 22px Arial';
    x.fillText((b.team === 'blue' ? 'BLUE' : 'RED') + ' BASE', 160, 40);

    if(!b.alive){
      x.fillStyle = '#ff5b3b';
      x.font = 'bold 26px Arial';
      x.fillText('DESTROYED', 160, 78);
      b.tex.needsUpdate = true;
      return;
    }

    /* Bar: dark track, then the filled portion with a glossy core. */
    const bx = 22, by = 54, bw = 276, bh = 20;
    x.fillStyle = '#15171c';
    x.beginPath(); x.roundRect(bx, by, bw, bh, 10); x.fill();

    const fw = Math.max(0, Math.min(1, frac)) * (bw - 4);
    if(fw > 2){
      x.save();
      x.beginPath(); x.roundRect(bx + 2, by + 2, bw - 4, bh - 4, 8); x.clip();
      x.fillStyle = col;
      x.fillRect(bx + 2, by + 2, fw, bh - 4);
      x.fillStyle = 'rgba(255,255,255,0.34)';
      x.fillRect(bx + 2, by + 2, fw, (bh - 4) * 0.42);
      x.restore();
    }

    x.fillStyle = '#fff';
    x.font = 'bold 17px Arial';
    x.fillText(Math.ceil(b.hp) + ' / ' + b.maxHp, 160, 90);
    b.tex.needsUpdate = true;
  }

  /* ── init / dispose ──────────────────────────────────────────────────── */

  function init(game, marks, ctx){
    _game = game;
    const spots = _resolvePlacements(marks, ctx);

    /* Sit each base on the ground under it rather than at the marker's own Y.
       GLB spawn markers carry y = 0 and the terrain is frequently not at 0
       (paperland's floor sits below the origin), so a base placed on the raw
       marker Y is buried — and a buried base cannot be seen, aimed at, or
       believed to be there.

       One downward ray per base, taken after the trimesh exists. If it misses,
       the marker's own Y is used, which is correct for the common case of a
       flat map authored with its floor at the origin. */
    const groundY = (spot) => {
      const fallback = (ctx && (ctx.box ? ctx.box.min.y : ctx.spawnY)) || 0;
      try {
        const ray = new THREE.Raycaster(
          new THREE.Vector3(spot.x, fallback + 400, spot.z),
          new THREE.Vector3(0, -1, 0), 0, 900
        );
        /* Sprites in the scene need a camera to raycast against; without one
           three.js logs an error per sprite. They are skipped below anyway. */
        ray.camera = _game.camera;
        const hits = ray.intersectObject(_game.scene, true);
        for(const h of hits){
          const o = h.object;
          if(!o || !o.visible || o.isSprite || o.isPoints || o.isLine) continue;
          if(o.userData && o.userData.noPhysics) continue;
          /* Skip anything already inside another base. */
          if(_state && _state.bases.some(b => b.grp === o || b.core === o)) continue;
          if(isFinite(h.point.y)) return h.point.y;
        }
      } catch(e){}
      return (spot.y != null) ? spot.y : fallback;
    };

    _state = { bases: [], winner: null, endedAt: 0, _client: false };
    for(const spot of spots){
      const b = _buildBase(spot, groundY(spot));
      _state.bases.push(b);
      _game.scene.add(b.grp);
    }

    /* HUD. */
    const hud = document.getElementById('base-hud');
    if(hud) hud.classList.remove('hidden');

    console.log('[base] bases placed:', _state.bases.map(b =>
      b.team + (b.fromMap ? ' (map: ' + b.name + ')' : ' (auto)')).join(', '));
    return _state;
  }

  function _kill(b){
    if(!b || !_game || !_game.scene) return;
    _game.scene.remove(b.grp);
    const seen = new Set();
    b.grp.traverse(o => {
      if(o.geometry && !seen.has(o.geometry)){ seen.add(o.geometry); o.geometry.dispose(); }
    });
    for(const m of b.mats) if(m) m.dispose();
    if(b.sprite && b.sprite.material) b.sprite.material.dispose();
    if(b.tex) b.tex.dispose();
    if(b.glowTex) b.glowTex.dispose();
    if(b.glow && b.glow.material) b.glow.material.dispose();
    if(b._smoke){ _kill(b._smoke); b._smoke = null; }
  }

  function dispose(){
    if(_state) for(const b of _state.bases) _kill(b);
    const hud = document.getElementById('base-hud');
    if(hud) hud.classList.add('hidden');
    _hudEls = null; _hudKey = '';
    _state = null; _game = null;
  }

  function getState(){ return _state; }

  /* ── damage ──────────────────────────────────────────────────────────── */

  /* THE ONE PLACE BASE HEALTH MOVES.

     Called from projectile.js for direct fire and from artillery splash. It
     takes the damage and the shooter rather than deciding whether the hit is
     legal, because the "is this allowed" rules differ between the two callers
     and duplicating them here is how a mode ends up with friendly fire nobody
     asked for.

     Returns true when a base was actually hit, which is the projectile's signal
     that the shell has been consumed. */
  function damage(b, amount, fromTank){
    if(!b || !b.alive || !_state || _state.winner) return false;
    if(amount <= 0) return false;

    b.hp -= amount;
    b._flash = 1;
    b._shake = 1;

    /* Credit the shooter. This is what the results screen and the battle cash
       read, and a base is worth far more damage than a tank — without this the
       winning blow would score nothing at all. */
    if(fromTank && fromTank !== b){
      fromTank.damageDealt = (fromTank.damageDealt || 0) + amount;
      if(!fromTank._damagedBy) fromTank._damagedBy = new Map();
      fromTank._damagedBy.set(b, (fromTank._damagedBy.get(b) || 0) + amount);
    }

    if(b.hp <= 0){
      b.hp = 0;
      b.alive = false;
      b.deadAt = _game ? (_game.time || 0) : 0;
      _onBaseDestroyed(b);
    }
    return true;
  }

  function _onBaseDestroyed(b){
    if(!b || !_state) return;
    b.alive = false;

    /* The core is REMOVED, not just hidden: a base at zero health that is still
       standing there looks like the hit did not count, and the player will keep
       shooting it. What is left is the plinth and the trim, so the wreck still
       marks where the objective was. */
    if(b.core && b.core.parent) b.core.parent.remove(b.core);
    b.core = null;

    if(_game){
      _game.spawnExplosion(b.x, b.y + SIZE() * 0.4, b.z, b.teamHex, 26, 'boom');
      _game.spawnBurst && _game.spawnBurst(b.x, b.y + SIZE() * 0.4, b.z, {
        count: 26, tex:'spark', speed: 22, size: 0.8, life: 0.9, rise: 6, gravity: 20, blend:'add',
      });
      _game.spawnBurst && _game.spawnBurst(b.x, b.y + SIZE() * 0.3, b.z, {
        count: 18, tex:'smoke', speed: 5, size: 2.2, life: 2.4, rise: 4, gravity: -0.8, grow: 3.2, blend:'normal', fade: 0.55,
      });
      if(_game.addShake){
        const me = _game.localTank;
        const d = me ? Math.hypot(me.x - b.x, me.z - b.z) : 999;
        if(d < 90) _game.addShake(4.0 * (1 - d / 90));
      }
    }

    /* THE MATCH IS OVER — and the winner is the OTHER team.

       Getting this backwards is the obvious mistake and it would hand the match
       to the side that just lost, so it is worth stating: a base at zero health
       means the team that OWNED it lost. */
    const winner = (b.team === 'blue') ? 'red' : 'blue';
    _finish(winner, b.team);
  }

  function _finish(winnerTeam, loserTeam){
    if(!_state || _state.winner) return;

    /* A CLIENT DOES NOT DECIDE THE MATCH — and the guard has to come BEFORE the
       winner is recorded, not after it.

       It used to sit below `_state.winner = winnerTeam`, which meant a client
       that damaged a base locally latched its OWN answer. That is not a
       cosmetic disagreement: applyHostSnapshot only accepts the host's winner
       `if(s.winner && !_state.winner)`, so a latch here makes the client
       IGNORE the host's real verdict and keep the wrong one. The client would
       then show a match as won by the team that lost it.

       Reaching this path at all on a client should be impossible — the host
       owns damage — so this is a guard on a bug rather than a design. */
    if(_state._client) return;

    _state.winner = winnerTeam;
    _state.endedAt = _game ? (_game.time || 0) : 0;
    if(!_game) return;

    const myTeam = (_game.localTank && _game.localTank.team) || 'blue';
    const won = (myTeam === winnerTeam);
    /* Guarded, unlike most of the calls to Menu in this codebase. This one runs
       from inside a damage handler, so a throw here does not merely lose a
       toast — it unwinds the rest of _onBaseDestroyed, which has already
       removed the core and committed the winner, leaving the match decided and
       silent. The toast is worth a typeof; the state change is not worth
       risking. */
    try {
      if(typeof Menu !== 'undefined' && Menu.toast){
        Menu.toast((_game._displaySide ? _game._displaySide(winnerTeam) : winnerTeam) === 'blue'
          ? 'Blue team wins! Enemy base destroyed!'
          : 'Red team wins! Enemy base destroyed!');
      }
    } catch(e){}

    /* Tell the match server, so a networked match ends for everyone at once and
       the clients show the same results screen the host does. */
    try {
      if(typeof Net !== 'undefined' && Net.sendMatchEnd) Net.sendMatchEnd({ winnerTeam, reason: 'base' });
    } catch(e){}

    setTimeout(() => {
      if(!_game || !_game.running) return;
      _game._awardBattleCash({
        damage: _game.localTank ? (_game.localTank.damageDealt || 0) : 0,
        assists: _game.localTank ? (_game.localTank.assists || 0) : 0,
        kills:  _game.localTank ? (_game.localTank.kills || 0) : 0,
        won,
      });
      _game._showResults({ outcome: won ? 'win' : 'loss', headline: won ? 'VICTORY' : 'DEFEAT' });
    }, 2500);
  }

  /* THE CALLBACK projectile.js LOOKS FOR. Same shape as _gladBoxHit, on
     purpose: that one is the established way a mode makes a shell stop at
     something that is not a tank, and matching it keeps both hooks readable
     side by side in the projectile update.

     A hitbox, not a collider. The bases have no rigid body, so this is a 2D
     distance test against the shell's path position — which is exactly how
     _gladBoxHit works and why adding real physics to a static objective would
     be a change of approach, not a detail. */
  function hitByShell(shell){
    if(!_state || _state.winner || !shell || shell.dead) return false;
    const r = HIT_R();
    for(const b of _state.bases){
      if(!b.alive) continue;
      /* NO FRIENDLY FIRE ON YOUR OWN BASE. A shell that leaves your own base
         area must not damage it — otherwise a defender sitting behind their own
         base chips it down every time they fire, and the mode quietly becomes
         self-defeat for whoever hides best. */
      if(shell.owner && shell.owner.team && b.team === shell.owner.team) continue;
      const dx = shell.x - b.x, dz = shell.z - b.z;
      const rr = r + (shell.radius || 0.4);
      if(dx * dx + dz * dz < rr * rr){
        const dmg = shell.damage || 0;
        damage(b, dmg, shell.owner);
        if(_game){
          _game.spawnExplosion(shell.x, 1.2, shell.z, b.teamHex, 6, 'boom');
          if(shell.owner === _game.localTank) _game.spawnHitMarker && _game.spawnHitMarker();
        }
        return true;
      }
    }
    return false;
  }

  /* Artillery splash. Separate from hitByShell because the blast is an AREA and
     not a contact, so it falls off with distance and cannot simply consume the
     shell — the shell lands, bursts, and damages whatever is near it. */
  function splashAt(x, z, radius, maxD, minD, owner){
    if(!_state || _state.winner) return false;
    let any = false;
    for(const b of _state.bases){
      if(!b.alive) continue;
      if(owner && owner.team && b.team === owner.team) continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if(d > radius) continue;
      /* Linear ramp, matching the tank splash in projectile.js. A blast that lands
         ON the base should be worth more than one that clips its edge, and the
         same curve for both means a player can learn it. */
      const f = 1 - (d / radius);
      const dmg = (minD + (maxD - minD) * f) * 1.5;
      damage(b, dmg, owner);
      any = true;
    }
    return any;
  }

  /* ── the frame ───────────────────────────────────────────────────────── */

  function update(dt){
    if(!_state || !_game) return;
    const t = _game.time || 0;

    for(const b of _state.bases){
      /* Wreck smoke, started once when the base dies. */
      if(!b.alive && !b._smoke && _game.scene && typeof THREE !== 'undefined'){
        const g = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({
          color: 0x2a2a30, transparent:true, opacity:0.30, depthWrite:false,
        });
        for(let i = 0; i < 5; i++){
          const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(SIZE() * 0.22, 1), mat);
          puff.position.set((Math.random() - 0.5) * SIZE() * 0.5,
                           SIZE() * (0.2 + i * 0.14),
                           (Math.random() - 0.5) * SIZE() * 0.5);
          puff.userData.phase = Math.random() * Math.PI * 2;
          puff.userData.y0 = puff.position.y;
          g.add(puff);
        }
        g.position.set(b.x, b.y, b.z);
        _game.scene.add(g);
        b._smoke = g;
        b._smokeMat = mat;
      }
      if(b._smoke && b._smokeMat){
        b._smokeMat.opacity = Math.max(0, 0.30 - (t - b.deadAt) * 0.04);
        for(const p of b._smoke.children){
          p.position.y = p.userData.y0 + Math.sin(t * 0.9 + p.userData.phase) * 0.5 + (t - b.deadAt) * 0.25;
          p.rotation.y += dt * 0.4;
        }
      }

      if(!b.alive){ _drawPanel(b, 0); continue; }

      /* Hit flash: the core goes white and settles back over ~0.25s. Colour is
         restored from the stored team hex every frame rather than by lerping
         toward it, so a rapid second hit cannot leave the base stuck pale. */
      if(b._flash > 0){
        b._flash = Math.max(0, b._flash - dt * 4);
        const m = b.core && b.core.material;
        if(m && m.color){
          m.color.setHex(WHITE).lerp(new THREE.Color(b.teamHex), 1 - b._flash);
          if(m.emissive) m.emissive.setHex(WHITE).lerp(new THREE.Color(b.teamHex), 1 - b._flash);
        }
      }

      /* Impact shake, decaying. */
      if(b._shake > 0){
        b._shake = Math.max(0, b._shake - dt * 3.2);
        const a = Math.sin(t * 60) * b._shake * 0.28;
        b.grp.position.x = b.x + a;
        b.grp.position.z = b.z + Math.cos(t * 54) * b._shake * 0.28;
      } else if(b.grp.position.x !== b.x){
        b.grp.position.set(b.x, b.y, b.z);
      }

      /* Panel redraw, gated on the value having changed. */
      _drawPanel(b, b.hp / b.maxHp);
    }

    _updateHud();
  }

  /* ── HUD ─────────────────────────────────────────────────────────────── */

  function _updateHud(){
    if(!_state) return;
    const hud = document.getElementById('base-hud');
    if(!hud) return;

    if(!_hudEls){
      _hudEls = {
        mine:  document.getElementById('base-hud-mine-fill'),
        mineN: document.getElementById('base-hud-mine-num'),
        mineT: document.getElementById('base-hud-mine-team'),
        theirs:  document.getElementById('base-hud-theirs-fill'),
        theirsN: document.getElementById('base-hud-theirs-num'),
        theirsT: document.getElementById('base-hud-theirs-team'),
      };
      if(!_hudEls.mine) return;   /* markup missing; stay silent rather than throw */
    }

    /* RELATIVE, ALWAYS. Left is YOUR base and right is THEIRS, whatever the
       teams are actually called — the same rule the Circle's ring and its panel
       follow, for the same reason: a panel that labels the player's own base RED
       is a panel that tells them the wrong thing to protect. The COLOURS come
       from Game._displayColor so they match the rest of the HUD; the LABELS are
       fixed words, because here they mean "yours" and "theirs" rather than team
       ids. */
    const myTeam = (_game && _game.localTank && _game.localTank.team) || 'blue';
    const enemy  = myTeam === 'blue' ? 'red' : 'blue';
    const mine   = _state.bases.find(b => b.team === myTeam);
    const theirs = _state.bases.find(b => b.team === enemy);

    const myFrac = mine ? Math.max(0, mine.hp / mine.maxHp) : 0;
    const thFrac = theirs ? Math.max(0, theirs.hp / theirs.maxHp) : 0;

    const key = Math.round(myFrac * 200) + '|' + Math.round(thFrac * 200) + '|' +
                (mine && !mine.alive ? 1 : 0) + '|' + (theirs && !theirs.alive ? 1 : 0) +
                '|' + (mine ? mine.fromMap : 0) + '|' + (theirs ? theirs.fromMap : 0);
    if(key === _hudKey) return;
    _hudKey = key;

    const col = (t) => (_game && _game._displayColor) ? _game._displayColor(t) : (t === 'blue' ? BLUE : RED);
    const dead = (b) => !b || !b.alive;

    if(_hudEls.mine){
      _hudEls.mine.style.width = (myFrac * 100).toFixed(1) + '%';
      _hudEls.mine.style.background = dead(mine) ? '#5a5f6b' : _hex(col(myTeam));
      _hudEls.mineN.textContent = mine ? (dead(mine) ? 'DESTROYED' : Math.ceil(mine.hp) + ' HP') : '—';
      /* A base placed by the fallback rather than by the map is worth saying so,
         quietly: a designer looking at a screenshot should be able to tell that
         the map has no `base` entity without reading the console. */
      _hudEls.mineT.textContent = (mine && !mine.fromMap) ? 'AUTO-PLACED' : 'MAP ENTITY';
    }
    if(_hudEls.theirs){
      _hudEls.theirs.style.width = (thFrac * 100).toFixed(1) + '%';
      _hudEls.theirs.style.background = dead(theirs) ? '#5a5f6b' : _hex(col(enemy));
      _hudEls.theirsN.textContent = theirs ? (dead(theirs) ? 'DESTROYED' : Math.ceil(theirs.hp) + ' HP') : '—';
      _hudEls.theirsT.textContent = (theirs && !theirs.fromMap) ? 'AUTO-PLACED' : 'MAP ENTITY';
    }
  }

  /* ── networking ──────────────────────────────────────────────────────── */

  /* The host is authoritative over base health exactly as it is over tank
     health: clients send input, not damage. Everything a client needs to draw
     the same fight is here, and nothing else — positions are static, so only the
     numbers that change are worth the bytes at 12Hz. */
  function snapshot(){
    if(!_state) return null;
    return {
      bases: _state.bases.map(b => ({ team: b.team, hp: b.hp, alive: b.alive })),
      winner: _state.winner,
    };
  }

  function applyHostSnapshot(s){
    if(!s || !s.bases) return;
    /* The client may not have opened the arena yet — the first snapshot can
       arrive before the map finishes loading. Building the mode here would put
       bases at the origin of an empty scene; the arena's own init will build
       them from the map a moment later and the next snapshot fills in the
       numbers. */
    if(!_state) return;

    for(const rec of s.bases){
      const b = _state.bases.find(x => x.team === rec.team);
      if(!b) continue;
      b.hp = rec.hp;
      /* Death is applied through the same path a local hit uses, minus the
         explosion: the client is being told this already happened, so playing
         the bang here would fire it once per snapshot for every player. */
      if(rec.alive === false && b.alive){
        b.alive = false; b.hp = 0; b.deadAt = _game ? (_game.time || 0) : 0;
        if(b.core && b.core.parent) b.core.parent.remove(b.core);
        b.core = null;
        b._drawKey = '';
      }
    }

    if(s.winner && !_state.winner){
      /* Marked as the host's answer, not decided locally: _finish() is what pays
         out and shows results, and on a client that has to be the host's
         matchend message instead (see _armNetMode's Net.onMatchEnd). */
      _state.winner = s.winner;
    }
  }

  /* Mark this instance as a client replica. Called once by the arena starter
     when Game is running as a client, so a locally-simulated hit can never
     declare a winner the host disagrees with. */
  function setClient(v){ if(_state) _state._client = !!v; }

  /* Where a bot on `team` should shoot. Returns null when the enemy base is
     already down or this is not a Base Defend match. bot.js asks for it. */
  function botTargetFor(team){
    if(!_state || _state.winner) return null;
    const enemy = (team === 'blue') ? 'red' : 'blue';
    const b = _state.bases.find(x => x.team === enemy);
    if(!b || !b.alive) return null;
    return { x: b.x, z: b.z, radius: HIT_R(), team: enemy, isBase: true, base: b };
  }

  return {
    init, update, dispose, getState, damage, hitByShell, splashAt,
    snapshot, applyHostSnapshot, setClient, botTargetFor,
    HIT_R,
  };
})();
