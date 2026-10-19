/* ============================================================
   bot.js — WoT-style tactical AI for bots.
   Cover-based combat: hold position, peek, shoot, retreat.
   Different IQ levels affect reaction time, accuracy, lead.
   Player-like behaviors: turret fidget, look at allies, cautious.
   States: HOLDING → PEEKING → SHOOTING → RETREATING →
           FLANKING → FOLLOWING → WANDERING → SCOUTING → DODGING
   ============================================================ */

class BotBrain {
  constructor(tank, opts){
    this.tank = tank;
    const o = opts || {};

    this.state = 'SEEKING';
    this.wanderHeading = Math.random()*Math.PI*2;
    this.wanderTimer = 0;
    this.coverPos = null;
    this.coverDir = null;
    this.peekTimer = 0;
    this.retreatTimer = 0;
    this.pushTimer = 0;
    this.waitTimer = 0;
    this.dodgeTimer = 0;
    this.dodgeDir = 0;
    this.targetLastSeen = null;
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = 0;
    this._lastTargetId = null;
    this._lostTimer = 0;

    /* --- perception and navigation state -------------------------------
       All null/empty on purpose: the first decide() fills them, and every one
       has a defined meaning when absent, so a brain constructed mid-match (a
       bot-fill joining rounds already in progress) starts blind rather than
       reading someone else's memory. */
    this._seen = null;        /* uid -> { t, x, z, at }  last known position */
    this._seenAt = 0;         /* when the last sweep ran                       */
    this._visible = null;     /* uid -> { t, x, z, at, dist }  in sight now   */
    this._heard = null;       /* teammates' radio, merged in from game        */
    this._heardGoal = null;
    this._numVisibleEnemies = 0;
    this._numAliveEnemies = 0;
    this._curTarget = null;
    this._path = null;        /* remaining waypoints, world space              */
    this._pathGoal = null;    /* what that path was planned for               */

    this.iq = o.iq || (['low','medium','medium','high'])[Math.random()*4|0];
    this.reactionDelay = this.iq === 'high' ? 0.08 : this.iq === 'medium' ? 0.2 : 0.4;
    this._reactTimer = 0;
    this._lastFireTime = 0;
    this._fidgetTimer = 0;
    this._fidgetCooldown = 2 + Math.random() * 4;
    this._lookAtAllyTimer = 0;
    this._heldTurretAngle = null;
    this._preaimAngle = null;
    this._hitPanicTimer = 0;
    this._allyPositions = [];
    this._allyCheckTimer = 0;
    this._numVisibleEnemies = 0;
    this._numAliveAllies = 0;
    this._retreatThreshold = this.iq === 'high' ? 2 : this.iq === 'medium' ? 1.5 : 1;
    this._flankCooldown = 0;
    this._lastCoverPos = null;
    this._sidePeek = Math.random() < 0.5 ? 1 : -1;

    this._groupTimer = 0;
    this._coordinatedPushTarget = null;
    this._lowHpThreshold = 0.3;
    this._teamCoordTimer = 0;
    this._lastAllyNearby = false;
    this._shootRetreatCooldown = 0;
    this._stuckTimer = 0;
    this._stuckCheckPos = {x: tank.x, z: tank.z};
    this._separationRadius = 5;
    this._botId = Math.random().toString(36).slice(2, 8);
  }

  decide(game){
    const me = this.tank;
    if(!me.alive) return {throttle:0, turn:0, turretWorldAngle:me.turretAngle, fire:false};

    const isAlly = (t) => t === me || (me.team && t.team && me.team === t.team);

    /* PERCEPTION FIRST, THEN TARGETING.

       The old loop walked game.tanks and took the nearest enemy, which meant a
       bot locked onto a target it had no line of sight to -- through a wall, or
       round a corner -- and then drove at the wall between them. It also had no
       memory at all: lose sight of a target and the bot immediately swiveled to
       whatever else happened to be nearest, including something behind it.

       _perceive() establishes what can actually be seen (field of view, line of
       sight, camouflage, allies' radio) and remembers where things were, and
       _chooseTarget() then picks with hysteresis so a bot does not thrash. */
    this._perceive(me, game);
    const pick = this._chooseTarget(me, game);
    const target = pick.target;
    this._curTarget = target;

    let enemyCount = 0;
    const allies = [];
    for(const t of game.tanks){
      if(!t.alive) continue;
      if(isAlly(t)){
        if(t !== me) allies.push(t);
        continue;
      }
      enemyCount++;
    }
    /* _numVisibleEnemies is what the behaviour layer reads to decide how scared
       to be, so it must stay the count of things SEEN -- not of things alive on
       the far side of the map. Counting every living enemy made bots nervous
       about fights they had no way of knowing about. */
    this._numAliveEnemies = enemyCount;
    this._numAliveAllies = allies.length;
    this._allyPositions = allies;

    /* If the bot is chasing a memory rather than a sighting, it should still
       drive to where it was last seen -- that is the whole point of remembering
       it. Without this the "go and look" behaviour would have nowhere to go. */
    let targetX = target ? target.x : 0;
    let targetZ = target ? target.z : 0;
    if(target && this._seen && this._seen[target.id]){
      targetX = this._seen[target.id].x;
      targetZ = this._seen[target.id].z;
    } else if(!target && this._heard){
      for(const id in this._heard){
        const h = this._heard[id];
        if(!this._heardGoal){
          const d = Math.hypot(h.x - me.x, h.z - me.z);
          if(!this._heardGoal || d < this._heardGoal.d) this._heardGoal = { d: d, x: h.x, z: h.z };
        }
      }
      if(this._heardGoal){ targetX = this._heardGoal.x; targetZ = this._heardGoal.z; }
    }

    /* BASE DEFEND: THE BASE IS A TARGET TOO, BUT ONLY SOMETIMES.

       A bot that only ever shoots tanks cannot finish this mode. Both teams
       respawn without limit, so ten bots trading kills leaves both bases at
       full health and the match runs until the heat death of the universe —
       the mode's entire win condition is unreachable by the AI that fills nine
       tenths of every roster.

       So the enemy base is offered as a target here, and the caller decides
       whether to take it. It is a FIGHTING target, not a movement objective:
       every line below reads target.x, target.z, target.id and target._physBody,
       and a base object supplies all four. _calcLead reads _physBody, which is
       absent on a base, so it returns no lead — which is correct, because a
       building does not move.

       The last one to have a live enemy tank keeps fighting that tank. Without
       this the base would out-prioritise an opponent standing in front of it,
       and a bot would shell a wall while a tank shot it in the back. */
    /* PROMOTE THE BASE TO `target`, which is what the rest of this function
       reads.

       The substitution rather than a separate code path is the cheap part of
       this being a small change: every state below already treats `target` as
       "something with an x and a z to point the turret at and a position to
       drive toward", and that is exactly what a base is. A second state machine
       for attacking an objective would be a hundred lines to keep in step with
       the first one, and would drift.

       What the stand-in deliberately does NOT carry is anything the state
       machine might read off a tank. Only .x, .z, .id and ._physBody are ever
       touched (grep-verified against this file), and the stand-in supplies the
       first three and pointedly NOT the fourth — a moving target gets its lead
       computed from its velocity, and a building has none to give.

       WHEN A BOT GOES FOR IT. Only when it has nothing better to shoot: a live
       enemy tank always wins, because a bot that shells a wall while a tank
       shoots it in the back is not playing the objective, it is ignoring it.
       So the base is a fallback for the moments the field is empty — which in
       this mode is most of them, since respawns are unlimited and the tanks are
       never all dead at once. */
    this._baseTarget = null;
    if(game._baseDefendMode && typeof BaseDefend !== 'undefined' && BaseDefend.getState()){
      const bt = BaseDefend.botTargetFor(me.team);
      /* botTargetFor returns null once the enemy base is down, so a bot with
         nothing left to shoot simply has no target and goes back to its normal
         wandering — rather than driving to a wreck. */
      if(bt && !target){
        target = { x: bt.x, z: bt.z, id: 'base-' + bt.team, isBase: true };
        this._baseTarget = target;
      }
    }

    if(target){
      this.targetLastSeen = {x:target.x, z:target.z};
      /* Kept as a live REFERENCE, not just a position, so that when the
         decision is throttled the bot can still re-aim at where its target
         actually IS every frame. A cached position would leave the turret
         pointing at where the enemy used to be. */
      this._curTarget = target;
      this._lostTimer = 4;
    } else if(this.targetLastSeen){
      this._lostTimer -= game.dt;
      if(this._lostTimer <= 0) this.targetLastSeen = null;
    }

    /* Perception already established this on its last sweep, so it is asked here
       rather than re-raycast. Note the deliberate difference from the old code:
       this is now "can this bot SEE its target", not "would a shell get
       through" -- the field-of-view cone means a target directly behind a bot is
       no longer something it fires at just because nothing is in the way. */
const canSeeTarget = target ? !!pick.canSee : false;
    const incomingShell = this._detectIncomingShell(me, game);

    if(this._hitPanicTimer > 0) this._hitPanicTimer -= game.dt;
    if(this._flankCooldown > 0) this._flankCooldown -= game.dt;
    if(this._shootRetreatCooldown > 0) this._shootRetreatCooldown -= game.dt;

    const myHpRatio = me.hp / me.maxHp;
    const allyNearby = allies.length > 0 ? allies.some(a => Math.hypot(a.x-me.x, a.z-me.z) < 25) : false;
    this._lastAllyNearby = allyNearby;

    if(this.state !== 'DODGING' && this.state !== 'GROUPING' && this.state !== 'COORDPUSH'){
      if(myHpRatio < this._lowHpThreshold && allies.length > 0 && this.state !== 'RETREATING'){
        const nearAlly = allies.reduce((best, a) => {
          const d = Math.hypot(a.x-me.x, a.z-me.z);
          return d < best.d ? {a, d} : best;
        }, {a: null, d: Infinity});
        if(nearAlly.d < 40){
          const offsetAngle = this._botId.charCodeAt(0) / 127 * Math.PI * 2;
          const offsetDist = 5 + (this._botId.charCodeAt(1) % 5);
          this.coverPos = {x: nearAlly.a.x + Math.sin(offsetAngle)*offsetDist, z: nearAlly.a.z + Math.cos(offsetAngle)*offsetDist};
          this.state = 'GROUPING';
          this._groupTimer = 0;
        }
      }
      else if(enemyCount >= 2 && allies.length >= 1 && !allyNearby && this.state !== 'SEEKING' && this.state !== 'APPROACHING'){
        this._teamCoordTimer += game.dt;
        if(this._teamCoordTimer > 1.5){
          const nearAlly = allies.reduce((best, a) => {
            const d = Math.hypot(a.x-me.x, a.z-me.z);
            return d < best.d ? {a, d} : best;
          }, {a: null, d: Infinity});
          if(nearAlly.a){
            const offsetAngle = this._botId.charCodeAt(2) / 127 * Math.PI * 2;
            this.coverPos = {x: nearAlly.a.x + Math.sin(offsetAngle)*8, z: nearAlly.a.z + Math.cos(offsetAngle)*8};
            this.state = 'GROUPING';
            this._groupTimer = 0;
          }
          this._teamCoordTimer = 0;
        }
      } else {
        this._teamCoordTimer = 0;
      }

      /* ARK SEEKS COVER.

         Ark is the glass cannon: 140 HP, longest barrel in the game, and it dies
         to anything that sees it first. So an Ark that is not already hidden and
         has no shot worth taking goes and puts its body in a tree or a bush.

         Restricted to its OWN half of the map. An Ark that wandered off to hide
         on the far side would be hiding in the wrong country -- nowhere near its
         team, unable to support a push, and gone from the fight for as long as it
         takes to drive back. The half is decided from the map centre and the
         team, which is the same convention the spawn fallbacks use (blue sits at
         centre.x - , red at centre.x +). */
      if(this._wantsCover(me) && !target && this.state !== 'RETREATING' &&
         this.state !== 'DODGING' && this.state !== 'TAKINGCOVER'){
        this.state = 'TAKINGCOVER';
        this._coverTarget = null;
        this._coverSearchTimer = 0;
      }
      /* ...and drop out of cover the moment hiding stops being the best plan:
         an enemy in the open, or nothing left worth hiding from. */
      if(this.state === 'TAKINGCOVER' && (target || this._inCover(me))){
        if(target && this._inCover(me)) this.state = 'HOLDING';
        else if(target) this.state = 'SEEKING';
      }

      if(this.state !== 'GROUPING' && enemyCount >= 2 && allies.length >= 2 && this._flankCooldown <= 0){
        const closeAllies = allies.filter(a => Math.hypot(a.x-me.x, a.z-me.z) < 20);
        if(closeAllies.length >= 1 && target && canSeeTarget){
          const dist = Math.hypot(target.x-me.x, target.z-me.z);
          if(dist < me.def.shellRange * 0.8){
            this.state = 'COORDPUSH';
            this.pushTimer = 0;
            this._coordinatedPushTarget = {x: target.x, z: target.z};
            this._flankCooldown = 6 + Math.random()*4;
          }
        }
      }
    }

    const out = {throttle:0, turn:0, turretAngle:me.turretAngle, fire:false};

    if(incomingShell){
      this._reactTimer += game.dt;
      if(this._reactTimer < this.reactionDelay){
        out.turretAngle = target ? Math.atan2(target.x-me.x, target.z-me.z) : me.turretAngle;
        return this._clamp({throttle:out.throttle, turn:out.turn, turretWorldAngle:out.turretAngle, fire:false});
      }
      this._reactTimer = 0;
      const dodgeAngle = this._getDodgeAngle(incomingShell, me);
      const angDiff = this._angleDiff(dodgeAngle, me.heading);
      out.turn = Math.max(-1, Math.min(1, angDiff*2));
      out.throttle = 1;
      if(target) out.turretAngle = Math.atan2(target.x-me.x, target.z-me.z);
      this.state = 'DODGING';
      this.dodgeTimer = 0.6 + Math.random()*0.4;
      this.dodgeDir = dodgeAngle;
      return this._clamp({throttle:out.throttle, turn:out.turn, turretWorldAngle:out.turretAngle, fire:out.fire});
    }

    this._updateFidget(me, game, out);

    switch(this.state){
      case 'SEEKING':      this._doSeeking(me, target, canSeeTarget, game, out); break;
      case 'HOLDING':      this._doHolding(me, target, canSeeTarget, game, out); break;
      case 'APPROACHING':  this._doApproaching(me, target, canSeeTarget, game, out); break;
      case 'PEEKING':      this._doPeeking(me, target, canSeeTarget, game, out); break;
      case 'SHOOTING':     this._doShooting(me, target, canSeeTarget, game, out); break;
      case 'RETREATING':   this._doRetreating(me, target, canSeeTarget, game, out); break;
      case 'FLANKING':     this._doFlanking(me, target, canSeeTarget, game, out); break;
      case 'FOLLOWING':    this._doFollowing(me, target, canSeeTarget, game, out); break;
      case 'WANDERING':    this._doWandering(me, target, game, out); break;
      case 'SCOUTING':     this._doScouting(me, target, canSeeTarget, game, out); break;
      case 'DODGING':      this._doDodging(me, target, game, out); break;
      case 'TAKINGCOVER':  this._doTakingCover(me, target, canSeeTarget, game, out); break;
      case 'GROUPING':     this._doGrouping(me, target, canSeeTarget, game, out); break;
      case 'COORDPUSH':    this._doCoordinatedPush(me, target, canSeeTarget, game, out); break;
    }

    this._separateFromAllies(me, out, game);

    if(out.throttle !== 0 && this._checkStuck(me, game)){
      this.wanderHeading = me.heading + (Math.random()-0.5)*Math.PI;
      this.wanderTimer = 1.5;
      this.state = 'WANDERING';
      out.turn += (Math.random() < 0.5 ? 1 : -1) * 0.8;
      out.throttle = 0.8;
    }

    if(out.turretAngle === undefined || out.turretAngle === null) out.turretAngle = me.turretAngle;
    return this._clamp({throttle:out.throttle, turn:out.turn, turretWorldAngle:out.turretAngle, fire:out.fire});
  }

  _doSeeking(me, target, canSee, game, out){
    if(!target){
      this.state = 'WANDERING';
      this.wanderHeading = me.heading + (Math.random()-0.5)*1.5;
      this.wanderTimer = 2+Math.random()*3;
      return;
    }
    const dist = Math.hypot(target.x-me.x, target.z-me.z);
    const isTDM = !!game._tdmState;
    const cover = this._findCoverFromTarget(me, target, game);
    const allyNearby = this._allyPositions.some(a => Math.hypot(a.x-me.x, a.z-me.z) < 20);

    if(isTDM && !allyNearby && this._numVisibleEnemies > 1){
      const groupTarget = this._allyPositions.length > 0
        ? this._allyPositions.reduce((b, a) => Math.hypot(a.x-me.x,a.z-me.z) < b.d ? {a,d:Math.hypot(a.x-me.x,a.z-me.z)} : b, {a:null,d:Infinity}).a
        : null;
      if(groupTarget){
        const offsetA = this._botId.charCodeAt(3) / 127 * Math.PI * 2;
        this.coverPos = {x: groupTarget.x + Math.sin(offsetA)*10, z: groupTarget.z + Math.cos(offsetA)*10};
        this.coverDir = Math.atan2(this.coverPos.x-me.x, this.coverPos.z-me.z);
        this.state = 'APPROACHING';
      } else {
        this.state = 'GROUPING';
        const offsetA = this._botId.charCodeAt(0) / 127 * Math.PI * 2;
        this.coverPos = {x: me.x + Math.sin(offsetA)*12, z: me.z + Math.cos(offsetA)*12};
        this._groupTimer = 0;
      }
    } else if(cover){
      const offsetA = this._botId.charCodeAt(4) / 127 * 3;
      this.coverPos = {x: cover.x + Math.sin(offsetA)*3, z: cover.z + Math.cos(offsetA)*3};
      this.coverDir = Math.atan2(cover.x-me.x, cover.z-me.z);
      this.state = 'APPROACHING';
    } else {
      this.state = 'FOLLOWING';
    }
    out.turretAngle = Math.atan2(target.x-me.x, target.z-me.z);
  }

  _doHolding(me, target, canSee, game, out){
    this.waitTimer += game.dt;
    out.throttle = 0;
    out.turn = 0;

    if(this.coverPos){
      const toCover = Math.hypot(this.coverPos.x-me.x, this.coverPos.z-me.z);
      if(toCover > 5){
        this.state = 'APPROACHING';
        return;
      }
    }

    if(this._heldTurretAngle === null){
      this._heldTurretAngle = target
        ? Math.atan2(target.x-me.x, target.z-me.z)
        : me.heading + Math.PI;
    }
    out.turretAngle = this._heldTurretAngle;

    const isTDM = !!game._tdmState;

    if(target && canSee){
      const aimAngle = Math.atan2(target.x-me.x, target.z-me.z);
      const aimDiff = Math.abs(this._angleDiff(aimAngle, me.turretAngle));
      if(aimDiff < 0.12 && me.reloadLeft <= 0){
        out.turretAngle = aimAngle;
        this.state = 'PEEKING';
        this.peekTimer = 0;
        this._sidePeek = Math.random() < 0.5 ? 1 : -1;
        return;
      }
      if(me.reloadLeft > 0 && aimDiff < 0.3){
        this._heldTurretAngle = aimAngle;
      }
      out.turretAngle = this._heldTurretAngle || aimAngle;
      this._heldTurretAngle = out.turretAngle;
    }

    const holdTime = isTDM ? 3 + Math.random()*3 : 5 + Math.random()*3;
    if(this.waitTimer > holdTime){
      if(target){
        const cover = this._findCoverFromTarget(me, target, game);
        if(cover){
          this.coverPos = cover;
          this.state = 'APPROACHING';
        } else {
          this.state = 'FOLLOWING';
        }
      } else {
        this.state = 'WANDERING';
        this.wanderHeading = me.heading + (Math.random()-0.5)*2;
        this.wanderTimer = 2+Math.random()*3;
      }
      this.waitTimer = 0;
    }

    if(target && canSee && this.waitTimer > 0.5){
      const dist = Math.hypot(target.x-me.x, target.z-me.z);
      const enemyCount = this._numVisibleEnemies;
      const allyCount = this._numAliveAllies;
      if(enemyCount > allyCount * this._retreatThreshold && dist < me.def.shellRange * 0.6){
        const cover = this._findRetreatCover(me, target, game);
        if(cover){
          this.coverPos = cover;
          this.state = 'RETREATING';
          this.retreatTimer = 0;
        }
      }
    }
  }

  _doApproaching(me, target, canSee, game, out){
    if(!target){ this.state = 'SEEKING'; return; }

    const isTDM = !!game._tdmState;
    const dist = Math.hypot(target.x-me.x, target.z-me.z);

    if(this.coverPos){
      const toCover = Math.hypot(this.coverPos.x-me.x, this.coverPos.z-me.z);
      if(toCover < 3){
        this.state = 'HOLDING';
        this.waitTimer = 0;
        this._heldTurretAngle = target ? Math.atan2(target.x-me.x, target.z-me.z) : me.heading + Math.PI;
        return;
      }
      this._driveTo(me, out, this.coverPos.x, this.coverPos.z, game, 1.8);
      const speedMul = toCover < 10 ? 0.6 : 1.0;
      out.throttle = (this.iq === 'low' ? 0.5 : 0.75) * speedMul;
    } else {
      const cover = this._findCoverFromTarget(me, target, game);
      if(cover){
        this.coverPos = cover;
        return;
      }
      this.state = 'FOLLOWING';
      return;
    }

    out.turretAngle = Math.atan2(target.x-me.x, target.z-me.z);
    if(canSee && dist < me.def.shellRange * 0.85 && me.reloadLeft <= 0){
      const aimDiff = Math.abs(this._angleDiff(out.turretAngle, me.turretAngle));
      if(aimDiff < 0.18){
        const lead = this._calcLead(me, target, dist);
        out.turretAngle = Math.atan2(target.x+lead.x-me.x, target.z+lead.z-me.z);
        if(Math.abs(this._angleDiff(out.turretAngle, me.turretAngle)) < 0.15){
          out.fire = true;
          this._lastFireTime = game.time;
        }
      }
    }

    this._wallAvoid(me, out, game);
  }

  _doPeeking(me, target, canSee, game, out){
    this.peekTimer += game.dt;

    if(!target){ this.state = 'SEEKING'; return; }

    const dist = Math.hypot(target.x-me.x, target.z-me.z);
    out.turretAngle = Math.atan2(target.x-me.x, target.z-me.z);

    if(this.coverDir !== undefined && this.coverDir !== null){
      const perpAngle = this.coverDir + Math.PI/2 * this._sidePeek;
      const peekDist = Math.min(3, 1.5 + this.peekTimer * 3);
      const peekX = me.x + Math.sin(perpAngle) * peekDist;
      const peekZ = me.z + Math.cos(perpAngle) * peekDist;
      const toPeek = Math.atan2(peekX - me.x, peekZ - me.z);
      this._driveTo(me, out, peekX, peekZ, game, 2.5);
      out.throttle = this.peekTimer < 0.3 ? 0.7 : 0;
    } else {
      /* Drive at where the target is, or at where it was LAST SEEN when it has
         broken line of sight. Steering at the live position of a target you
         cannot see is steering at nothing: the point moves as they do, and the
         bot chases a ghost it has no information about. */
      const mem = (this._seen && this._seen[target.id]) || null;
      this._driveTo(me, out, mem ? mem.x : target.x, mem ? mem.z : target.z, game, 2);
      out.throttle = this.peekTimer < 0.3 ? 0.6 : 0;
    }

    if(canSee && dist < me.def.shellRange){
      const aimDiff = Math.abs(this._angleDiff(out.turretAngle, me.turretAngle));
      if(aimDiff < 0.12 && me.reloadLeft <= 0){
        const lead = this._calcLead(me, target, dist);
        out.turretAngle = Math.atan2(target.x+lead.x-me.x, target.z+lead.z-me.z);
        if(Math.abs(this._angleDiff(out.turretAngle, me.turretAngle)) < 0.15){
          out.fire = true;
          this._lastFireTime = game.time;
          this.state = 'SHOOTING';
          this.retreatTimer = 0;
        }
      }
    }

    const peekTimeout = this.iq === 'high' ? 1.0 : this.iq === 'medium' ? 1.5 : 2.0;
    if(this.peekTimer > peekTimeout){
      this.state = 'RETREATING';
      this.retreatTimer = 0;
    }
  }

  _doShooting(me, target, canSee, game, out){
    this.retreatTimer += game.dt;
    out.turretAngle = target ? Math.atan2(target.x-me.x, target.z-me.z) : me.turretAngle;
    out.throttle = 0;
    out.turn = 0;

    if(canSee && Math.abs(this._angleDiff(out.turretAngle, me.turretAngle)) < 0.15 && me.reloadLeft <= 0){
      if(target){
        const dist = Math.hypot(target.x-me.x, target.z-me.z);
        const lead = this._calcLead(me, target, dist);
        out.turretAngle = Math.atan2(target.x+lead.x-me.x, target.z+lead.z-me.z);
        if(Math.abs(this._angleDiff(out.turretAngle, me.turretAngle)) < 0.15){
          out.fire = true;
        }
      }
    }

    const shootTime = this.iq === 'high' ? 0.1 : this.iq === 'medium' ? 0.2 : 0.3;
    if(this.retreatTimer > shootTime){
      this.state = 'RETREATING';
      this.retreatTimer = 0;
    }
  }

  _doRetreating(me, target, canSee, game, out){
    this.retreatTimer += game.dt;

    if(this._allyPositions.length > 0 && this.retreatTimer < 0.5){
      const nearestAlly = this._allyPositions.reduce((best, a) => {
        const d = Math.hypot(a.x-me.x, a.z-me.z);
        return d < best.d ? {a, d} : best;
      }, {a: null, d: Infinity});
      if(nearestAlly.d < 35){
        const awayAngle = Math.atan2(nearestAlly.a.x-me.x, nearestAlly.a.z-me.z);
        this.coverPos = {
          x: nearestAlly.a.x + Math.cos(awayAngle) * 8 + (Math.random()-0.5)*6,
          z: nearestAlly.a.z + Math.sin(awayAngle) * 8 + (Math.random()-0.5)*6
        };
      }
    }

    if(this.coverPos){
      const toCover = Math.hypot(this.coverPos.x-me.x, this.coverPos.z-me.z);
      if(toCover < 2.5 || this.retreatTimer > 2.5){
        this.state = 'HOLDING';
        this.waitTimer = 0;
        this._heldTurretAngle = target ? Math.atan2(target.x-me.x, target.z-me.z) : me.heading + Math.PI;
        return;
      }
      this._driveTo(me, out, this.coverPos.x, this.coverPos.z, game, 2);
      out.throttle = 0.9;
    } else {
      const reverseAngle = me.heading + Math.PI;
      const angDiff = this._angleDiff(reverseAngle, me.heading);
      out.turn = Math.max(-1, Math.min(1, angDiff*2));
      out.throttle = -0.6;
    }

    this._wallAvoid(me, out, game);

    if(target){
      out.turretAngle = Math.atan2(target.x-me.x, target.z-me.z);
      if(canSee && Math.abs(this._angleDiff(out.turretAngle, me.turretAngle)) < 0.2 && me.reloadLeft <= 0){
        out.fire = true;
      }
    }

    if(this.retreatTimer > 3){
      this.coverPos = this._findCoverFromTarget(me, target, game) || this.coverPos;
      if(this.coverPos){
        this.state = 'APPROACHING';
      } else {
        this.state = 'FOLLOWING';
      }
    }
  }

  _doFlanking(me, target, canSee, game, out){
    this.pushTimer += game.dt;
    if(!target){ this.state = 'SEEKING'; return; }

    const flankTarget = this._getFlankPosition(me, target, game);
    const dist = Math.hypot(flankTarget.x-me.x, flankTarget.z-me.z);

    if(dist < 4){
      this.state = 'HOLDING';
      this.waitTimer = 0;
      this.coverPos = flankTarget;
      this._heldTurretAngle = Math.atan2(target.x-me.x, target.z-me.z);
      return;
    }

    this._driveTo(me, out, flankTarget.x, flankTarget.z, game, 1.5);
    out.throttle = 0.8;
    out.turretAngle = Math.atan2(target.x-me.x, target.z-me.z);
    this._wallAvoid(me, out, game);

    if(canSee && Math.hypot(target.x-me.x, target.z-me.z) < me.def.shellRange && me.reloadLeft <= 0){
      const aimDiff = Math.abs(this._angleDiff(out.turretAngle, me.turretAngle));
      if(aimDiff < 0.2){
        out.fire = true;
      }
    }

    if(this.pushTimer > 8){
      this.state = 'SEEKING';
      this.pushTimer = 0;
    }
  }

  _doFollowing(me, target, canSee, game, out){
    if(!target){
      this.state = 'WANDERING';
      this.wanderHeading = me.heading + (Math.random()-0.5)*2;
      this.wanderTimer = 2+Math.random()*3;
      return;
    }

    const isTDM = !!game._tdmState;
    const dist = Math.hypot(target.x-me.x, target.z-me.z);

    let followTarget;
    if(isTDM){
      const allies = this._allyPositions;
      if(allies.length > 0){
        const nearestAlly = allies.reduce((best, a) => {
          const d = Math.hypot(a.x-me.x, a.z-me.z);
          return d < best.d ? {a, d} : best;
        }, {a: null, d: Infinity});
        if(nearestAlly.d < 30){
          const perpAngle = Math.atan2(target.x-nearestAlly.a.x, target.z-nearestAlly.a.z) + Math.PI/2 * this._sidePeek;
          followTarget = {
            x: (nearestAlly.a.x + target.x)/2 + Math.sin(perpAngle) * 10,
            z: (nearestAlly.a.z + target.z)/2 + Math.cos(perpAngle) * 10
          };
        } else {
          followTarget = {
            x: target.x + (Math.random()-0.5)*15,
            z: target.z + (Math.random()-0.5)*15
          };
        }
      } else {
        followTarget = {
          x: target.x + (Math.random()-0.5)*15,
          z: target.z + (Math.random()-0.5)*15
        };
      }
    } else {
      const allies = this._allyPositions;
      followTarget = null;
      if(allies.length > 0){
        let closestAlly = null, closestDist = Infinity;
        for(const a of allies){
          const d = Math.hypot(a.x-me.x, a.z-me.z);
          if(d < closestDist && d < 50){ closestDist = d; closestAlly = a; }
        }
        if(closestAlly){
          const aheadX = closestAlly.x + Math.sin(closestAlly.heading || 0) * 12;
          const aheadZ = closestAlly.z + Math.cos(closestAlly.heading || 0) * 12;
          followTarget = {x: aheadX, z: aheadZ};
        }
      }
      if(!followTarget){
        followTarget = {x: (me.x + target.x)/2, z: (me.z + target.z)/2};
      }
    }

    const cover = this._findCoverFromTarget(me, target, game);
    if(!isTDM && cover){
      this.coverPos = cover;
      this.coverDir = Math.atan2(cover.x-me.x, cover.z-me.z);
      this.state = 'APPROACHING';
      return;
    }

    this._driveTo(me, out, followTarget.x, followTarget.z, game, 1.5);
    out.throttle = isTDM ? 0.85 : 0.65;
    out.turretAngle = Math.atan2(target.x-me.x, target.z-me.z);
    this._wallAvoid(me, out, game);

    if(canSee && dist < me.def.shellRange && me.reloadLeft <= 0){
      const aimDiff = Math.abs(this._angleDiff(out.turretAngle, me.turretAngle));
      if(aimDiff < (isTDM ? 0.2 : 0.18)){
        out.fire = true;
      }
    }
  }

  _doWandering(me, target, game, out){
    if(target){
      this.state = 'SEEKING';
      return;
    }

    const isTDM = !!game._tdmState;
    this.wanderTimer -= game.dt;
    if(this.wanderTimer <= 0){
      this.wanderHeading = me.heading + (Math.random()-0.5)*2;
      this.wanderTimer = 2+Math.random()*4;
    }

    const angDiff = this._angleDiff(this.wanderHeading, me.heading);
    out.turn = Math.max(-1, Math.min(1, angDiff*1.5));
    out.throttle = isTDM ? 0.8 : 0.4;
    this._wallAvoid(me, out, game);
  }

  _doScouting(me, target, canSee, game, out){
    this.pushTimer += game.dt;

    if(target && canSee){
      const dist = Math.hypot(target.x-me.x, target.z-me.z);
      const cover = this._findCoverFromTarget(me, target, game);
      if(cover){
        this.coverPos = cover;
        this.coverDir = Math.atan2(cover.x-me.x, cover.z-me.z);
        this.state = 'APPROACHING';
        return;
      }
    }

    const scoutPoint = this._getScoutPosition(me, game);
    this._driveTo(me, out, scoutPoint.x, scoutPoint.z, game, 1.5);
    out.throttle = 0.55;
    out.turretAngle = me.heading + Math.PI + (Math.random()-0.5)*0.8;
    this._wallAvoid(me, out, game);

    if(this.pushTimer > 6 || (target && canSee)){
      this.state = 'SEEKING';
      this.pushTimer = 0;
    }
  }

  _doGrouping(me, target, canSee, game, out){
    this._groupTimer += game.dt;

    if(!this.coverPos){
      this.state = 'SEEKING';
      return;
    }

    const toCover = Math.hypot(this.coverPos.x-me.x, this.coverPos.z-me.z);
    if(toCover < 4){
      this.state = 'HOLDING';
      this.waitTimer = 0;
      this._heldTurretAngle = target ? Math.atan2(target.x-me.x, target.z-me.z) : me.heading + Math.PI;
      return;
    }

    this._driveTo(me, out, this.coverPos.x, this.coverPos.z, game, 1.8);
    out.throttle = 0.9;
    out.turretAngle = target ? Math.atan2(target.x-me.x, target.z-me.z) : me.heading;
    this._wallAvoid(me, out, game);

    if(canSee && target){
      const dist = Math.hypot(target.x-me.x, target.z-me.z);
      if(dist < me.def.shellRange * 0.9 && me.reloadLeft <= 0){
        const aimDiff = Math.abs(this._angleDiff(out.turretAngle, me.turretAngle));
        if(aimDiff < 0.2){
          out.fire = true;
        }
      }
    }

    if(this._groupTimer > 5){
      this.state = 'SEEKING';
      this._groupTimer = 0;
    }
  }

  _doCoordinatedPush(me, target, canSee, game, out){
    this.pushTimer += game.dt;
    if(!target){
      this.state = 'SEEKING';
      return;
    }

    const dist = Math.hypot(target.x-me.x, target.z-me.z);
    const pushTarget = this._coordinatedPushTarget || {x: target.x, z: target.z};

    const sideAngle = Math.atan2(pushTarget.x-me.x, pushTarget.z-me.z);
    const uniqueSide = this._botId.charCodeAt(0) % 2 === 0 ? 1 : -1;
    const flankAngle = sideAngle + (Math.PI/3) * uniqueSide;
    const idealDist = Math.min(me.def.shellRange * 0.6, 20);
    const tx = pushTarget.x + Math.sin(flankAngle) * idealDist;
    const tz = pushTarget.z + Math.cos(flankAngle) * idealDist;

    this._driveTo(me, out, tx, tz, game, 1.8);
    out.throttle = 0.85;
    out.turretAngle = Math.atan2(target.x-me.x, target.z-me.z);
    this._wallAvoid(me, out, game);

    if(canSee && dist < me.def.shellRange && me.reloadLeft <= 0){
      const aimDiff = Math.abs(this._angleDiff(out.turretAngle, me.turretAngle));
      if(aimDiff < 0.15){
        const lead = this._calcLead(me, target, dist);
        out.turretAngle = Math.atan2(target.x+lead.x-me.x, target.z+lead.z-me.z);
        if(Math.abs(this._angleDiff(out.turretAngle, me.turretAngle)) < 0.15){
          out.fire = true;
          this._lastFireTime = game.time;
          this._shootRetreatCooldown = 0.5;
        }
      }
    }

    if(this._shootRetreatCooldown > 0 && this._shootRetreatCooldown < 0.3){
      const cover = this._findCoverFromTarget(me, target, game);
      if(cover){
        this.coverPos = cover;
        this.state = 'RETREATING';
        this.retreatTimer = 0;
        this._shootRetreatCooldown = 0;
        return;
      }
    }

    if(this.pushTimer > 8 || dist < 5){
      if(target){
        const cover = this._findCoverFromTarget(me, target, game);
        if(cover){
          this.coverPos = cover;
          this.state = 'HOLDING';
          this.waitTimer = 0;
        } else {
          this.state = 'SEEKING';
        }
      } else {
        this.state = 'SEEKING';
      }
      this.pushTimer = 0;
    }
  }

  _doDodging(me, target, game, out){
    this.dodgeTimer -= game.dt;
    if(this.dodgeTimer <= 0){
      if(target){
        const cover = this._findCoverFromTarget(me, target, game);
        if(cover){
          this.coverPos = cover;
          this.state = 'APPROACHING';
        } else {
          this.state = 'SEEKING';
        }
      } else {
        this.state = 'WANDERING';
      }
      return;
    }

    const angDiff = this._angleDiff(this.dodgeDir, me.heading);
    out.turn = Math.max(-1, Math.min(1, angDiff*2.5));
    out.throttle = 1;
    this._wallAvoid(me, out, game);

    if(target){
      out.turretAngle = Math.atan2(target.x-me.x, target.z-me.z);
    }
  }

  _updateFidget(me, game, out){
    this._fidgetTimer += game.dt;

    if(this._fidgetTimer > this._fidgetCooldown){
      this._fidgetTimer = 0;
      this._fidgetCooldown = 1.5 + Math.random() * 5;

      if(Math.random() < 0.3 && this._allyPositions.length > 0){
        const ally = this._allyPositions[Math.random()*this._allyPositions.length|0];
        out.turretAngle = Math.atan2(ally.x-me.x, ally.z-me.z);
      } else if(Math.random() < 0.4){
        out.turretAngle = me.turretAngle + (Math.random()-0.5)*2;
      } else {
        out.turretAngle = me.heading + Math.PI + (Math.random()-0.5)*1.5;
      }
    }

    if(Math.random() < 0.003){
      this.strafeDir *= -1;
    }
  }

  _calcLead(me, target, dist){
    if(!target || dist > me.def.shellRange) return {x:0, z:0};
    // Shells really fly at shellSpeed/SPEED_DIV (see Shell's constructor) —
    // predicting with the raw config number would aim at where the target
    // was, not where it will be when the shell arrives.
    const shellSpeed = (me.def.shellSpeed || 30) / 2.25;
    const travelTime = dist / shellSpeed;
    const tvx = target._physBody ? (target._physBody.linvel()?.x || 0) : 0;
    const tvz = target._physBody ? (target._physBody.linvel()?.z || 0) : 0;
    const iqMul = this.iq === 'high' ? 1.0 : this.iq === 'medium' ? 0.7 : 0.4;
    return { x: tvx * travelTime * iqMul, z: tvz * travelTime * iqMul };
  }

  /* ============================================================================
     ARK: DRIVING ITSELF INTO SOME FOLIAGE

     _findCoverFromTarget above picks a spot behind a WALL relative to a known
     enemy. That is the wrong tool here for two reasons: there is no target to be
     cover-from (this runs precisely when there is nothing to shoot), and a wall
     does not hide you at all under the new rules -- only foliage does, and only
     once enough of the footprint is under it.

     So this looks at the plants themselves and returns a point that is INSIDE
     one, which is the only kind of position that actually gets a tank to
     camoFactor 0.

     WHY THE TEAM'S OWN HALF

     The map centre splits the arena, and the spawn fallbacks put blue at
     centre.x - and red at centre.x +. Using the same convention means "my half"
     means the same thing to the cover picker as it does to the spawn logic, and
     an Ark hiding on its own side is still near its team and still in the fight.
     An Ark that crossed the midline to hide would be out of the game for the
     whole drive back.

     Falls back to the far side ONLY when the team has no foliage at all, so a
     bot on a bare map still has somewhere to try rather than standing still. */
  _findFoliageCover(me, game){
    const world = game && game.world;
    if(!world) return null;

    /* Midline from the live map bounds when there is one, so it follows a GLB
       map of any size instead of assuming a fixed arena. */
    const box = world._tdmBox;
    const mid = box ? (box.min.x + box.max.x) / 2 : 0;
    const sign = (me.team === 'red') ? 1 : -1;

    const list = (typeof world._coverList === 'function') ? world._coverList() : null;
    if(!list || !list.length) return null;

    let best = null, bestScore = -Infinity, anyOwnHalf = false;
    for(let i = 0; i < list.length; i++){
      const c = list[i];
      const onOwnHalf = ((c.x - mid) * sign) <= 0;
      if(onOwnHalf) anyOwnHalf = true;

      /* Only aim at places the tank could actually stand: the plant's centre
         is inside its own foliage by construction, so a point there is covered. */
      const d = Math.hypot(c.x - me.x, c.z - me.z);
      if(d < 0.5) continue;
      /* Not absurdly far -- a bot that has to cross the map to hide has stopped
         participating in the fight entirely, which is worse than not hiding. */
      if(d > 90) continue;

      /* Prefer near, and prefer big plants (a bigger radius hides a bigger tank
         outright rather than leaving it half out). */
      const score = -d + (c.r || 3) * 2;
      if(score > bestScore){ bestScore = score; best = c; }
    }
    /* Own half had nothing in it. Rather than freeze, take whatever is nearest
       anywhere -- still better than standing in the open on purpose. */
    if(!anyOwnHalf){
      best = null; bestScore = -Infinity;
      for(let i = 0; i < list.length; i++){
        const c = list[i];
        const d = Math.hypot(c.x - me.x, c.z - me.z);
        if(d < 0.5 || d > 90) continue;
        const score = -d + (c.r || 3) * 2;
        if(score > bestScore){ bestScore = score; best = c; }
      }
    }
    return best ? {x:best.x, z:best.z} : null;
  }

  /* Only Ark. A per-tank opt-in rather than a hardcoded id list, so a tank that
     is given the trait later does not need this file edited as well. */
  _wantsCover(tank){
    return !!(tank && tank.def && tank.def.seeksCover);
  }

  /* Already under enough foliage to be hidden? Used to leave TAKINGCOVER once
     the bot has arrived, and to decide whether an incoming contact is worth
     breaking cover for. */
  _inCover(tank){
    return !!(tank && tank.camoFactor <= 0);
  }

  /* Drive to the chosen plant, then hold still in it.

     The throttle tapers off over the last few units so the bot arrives at a
     crawl instead of overshooting and ploughing straight through the far side --
     which would both shake the foliage it came for and look absurd.

     Throttle 0 on arrival is the whole point: cover that shakes is not cover. */
  _doTakingCover(me, target, canSee, game, out){
    /* Something worth shooting turned up. Cover is worth less than a shot, and
       the enemy is visible, so go fight. */
    if(target){
      this.state = 'SEEKING';
      return;
    }
    /* Already hidden: stop moving and let the foliage settle. */
    if(this._inCover(me)){
      out.throttle = 0;
      out.turn = 0;
      out.turretAngle = me.heading + Math.PI;
      return;
    }

    this._coverSearchTimer = (this._coverSearchTimer || 0) + game.dt;
    /* Re-pick periodically rather than every frame: the list is walked in full
       and a bot running this at 60Hz would do it 60 times a second. Half a
       second is often enough for a plant that is tens of units away. */
    if(!this._coverTarget || this._coverSearchTimer > 0.5){
      this._coverSearchTimer = 0;
      this._coverTarget = this._findFoliageCover(me, game);
    }

    if(!this._coverTarget){
      /* Nowhere to hide. Do something rather than sit there. */
      this.state = 'SCOUTING';
      this.pushTimer = 0;
      return;
    }

    const dx = this._coverTarget.x - me.x;
    const dz = this._coverTarget.z - me.z;
    const dist = Math.hypot(dx, dz);
    if(dist < 2.5){
      out.throttle = 0;
      out.turn = 0;
      out.turretAngle = me.heading + Math.PI;
      return;
    }

    this._driveTo(me, out, me.x + dx, me.z + dz, game, 1.5);
    /* Ease off inside 8 units so it settles into the foliage instead of
       overshooting -- and so the last few metres are under COVER_SHAKE_SPEED,
       which is what stops the arrival from giving it away. */
    out.throttle = dist < 8 ? Math.max(0.18, dist / 8) : 1;
    /* Keep the turret on the way it came while it drives in, which is the same
       angle both the "already hidden" and "arrived" branches hold, so the
       turret does not snap backwards at the moment it stops. This line read
       `= a` -- an undefined identifier -- so it threw a ReferenceError on every
       single frame a cover-seeking bot was en route: the state machine never
       got past it, and _update()'s catch turned that into a warning 60 times a
       second. */
    out.turretAngle = me.heading + Math.PI;
    this._wallAvoid(me, out, game);

    /* Safety net: if it has been trying for a long time and still has not got
       under cover, give up rather than drive at a plant forever. */
    this._coverStuckTimer = (this._coverStuckTimer || 0) + game.dt;
    if(this._coverStuckTimer > 12){
      this._coverStuckTimer = 0;
      this._coverTarget = null;
      this.state = 'SCOUTING';
      this.pushTimer = 0;
    }
  }

  _findCoverFromTarget(me, target, game){
    const walls = game.world.coverPoints || game.world.walls;
    if(!walls || !walls.length) return null;

    const cacheKey = Math.floor(me.x/5) + '_' + Math.floor(me.z/5) + '_' + (target ? Math.floor(target.x/5) + '_' + Math.floor(target.z/5) : 'x');
    const now = game.time || 0;
    if(this._coverCacheKey === cacheKey && this._coverCacheTime && (now - this._coverCacheTime) < 1.0){
      return this._coverCacheResult;
    }
    this._coverCacheKey = cacheKey;
    this._coverCacheTime = now;

    const angleToTarget = Math.atan2(target.x-me.x, target.z-me.z);
    let bestCover = null, bestScore = -Infinity;

    for(const w of walls){
      const hx = w.w/2, hz = w.d/2;
      const corners = [
        {x:w.x-hx-2.5, z:w.z-hz-2.5},
        {x:w.x+hx+2.5, z:w.z-hz-2.5},
        {x:w.x-hx-2.5, z:w.z+hz+2.5},
        {x:w.x+hx+2.5, z:w.z+hz+2.5},
        {x:w.x-hx-2.5, z:w.z},
        {x:w.x+hx+2.5, z:w.z},
        {x:w.x, z:w.z-hz-2.5},
        {x:w.x, z:w.z+hz+2.5},
      ];

      for(const c of corners){
        const distToMe = Math.hypot(c.x-me.x, c.z-me.z);
        if(distToMe < 2 || distToMe > 45) continue;

        const angleFromTarget = Math.atan2(c.x-target.x, c.z-target.z);
        const coverAngle = Math.abs(this._angleDiff(angleToTarget, angleFromTarget));

        if(coverAngle > Math.PI*0.3){
          const distToTarget = Math.hypot(c.x-target.x, c.z-target.z);
          const score = coverAngle * 12 - distToMe * 0.4 - distToTarget * 0.15;
          if(score > bestScore){
            bestScore = score;
            bestCover = c;
          }
        }
      }
    }
    this._coverCacheResult = bestCover;
    return bestCover;
  }

  _findRetreatCover(me, target, game){
    const walls = game.world.coverPoints || game.world.walls;
    if(!walls || !walls.length) return null;

    /* Cache it, exactly like _findCoverFromTarget does.

       This had NO cache while its sibling had a 1 second one, and it is reached
       from _doHolding and _doRetreating -- both of which run every frame for a
       bot under fire, because BOT_THINK_EVERY is overridden by _botDirty /
       _hurtThisFrame / a nearby shell. So a pinned bot searched EVERY wall in
       the level (hundreds on a GLB map) 60 times a second, allocating four
       corner objects per wall per call: over a thousand short-lived objects per
       frame per threatened bot.

       That is both a GC source and, on a busy map, enough arithmetic to blow
       the frame budget outright -- and it is worst exactly when the fight is
       busiest, which is what made the freezes feel random. */
    const cacheKey = Math.floor(me.x/5) + '_' + Math.floor(me.z/5) + '_' + (target ? Math.floor(target.x/5) + '_' + Math.floor(target.z/5) : 'x');
    const now = game.time || 0;
    if(this._retreatCoverKey === cacheKey && this._retreatCoverTime && (now - this._retreatCoverTime) < 1.0){
      return this._retreatCoverResult;
    }
    this._retreatCoverKey = cacheKey;
    this._retreatCoverTime = now;

    const angleAway = Math.atan2(me.x-target.x, me.z-target.z);
    let bestCover = null, bestScore = -Infinity;

    for(const w of walls){
      const hx = w.w/2, hz = w.d/2;
      const corners = [
        {x:w.x-hx-2.5, z:w.z-hz-2.5},
        {x:w.x+hx+2.5, z:w.z-hz-2.5},
        {x:w.x-hx-2.5, z:w.z+hz+2.5},
        {x:w.x+hx+2.5, z:w.z+hz+2.5},
      ];

      for(const c of corners){
        const distToMe = Math.hypot(c.x-me.x, c.z-me.z);
        if(distToMe < 2 || distToMe > 30) continue;

        const angleFromMe = Math.atan2(c.x-me.x, c.z-me.z);
        const retreatScore = Math.abs(this._angleDiff(angleAway, angleFromMe));
        const distToTarget = Math.hypot(c.x-target.x, c.z-target.z);
        const score = retreatScore * 8 + distToTarget * 0.3 - distToMe * 0.5;

        if(score > bestScore){
          bestScore = score;
          bestCover = c;
        }
      }
    }
    this._retreatCoverResult = bestCover;
    return bestCover;
  }

  _getFlankPosition(me, target, game){
    const baseAngle = Math.atan2(target.x-me.x, target.z-me.z);
    const flankAngle = baseAngle + (Math.PI/2 + Math.random()*0.5) * this._sidePeek;
    const dist = 15 + Math.random() * 15;
    let fx = me.x + Math.sin(flankAngle) * dist;
    let fz = me.z + Math.cos(flankAngle) * dist;
    const half = game.world.half - 10;
    fx = Math.max(-half, Math.min(half, fx));
    fz = Math.max(-half, Math.min(half, fz));
    return {x: fx, z: fz};
  }

  _getScoutPosition(me, game){
    const angle = me.heading + (Math.random()-0.5)*1.5;
    const dist = 15 + Math.random()*15;
    let sx = me.x + Math.sin(angle) * dist;
    let sz = me.z + Math.cos(angle) * dist;
    const half = game.world.half - 10;
    sx = Math.max(-half, Math.min(half, sx));
    sz = Math.max(-half, Math.min(half, sz));
    return {x: sx, z: sz};
  }

  _hasLOS(me, target, game){
    const tid = target.id || 't';
    const now = game.time || 0;
    if(this._losTargetId === tid && this._losTime && (now - this._losTime) < 0.3){
      return this._losResult;
    }
    this._losTargetId = tid;
    this._losTime = now;

    const dx = target.x - me.x;
    const dz = target.z - me.z;
    const dist = Math.hypot(dx, dz);
    const steps = Math.min(Math.ceil(dist / 3), 15);
    const sx = dx / steps;
    const sz = dz / steps;

    for(let i = 1; i < steps; i++){
      const tx = me.x + sx * i;
      const tz = me.z + sz * i;
      /* collidesForAI, not collidesWallsOnly. A line of sight has to be blocked by
       cover: shells are real physics bodies that stop at it, so a bot that can
       see through a building is seeing something the game says is not there, and
       will happily aim at -- and drive at -- an enemy it should have no way to
       know about. collidesWallsOnly skips GLB cover, which made every ray clear. */
      if(game.world.collidesForAI(tx, tz, 0.5)){
        this._losResult = false;
        return false;
      }
    }
    this._losResult = true;
    return true;
  }

  _detectIncomingShell(me, game){
    if(!game.projectiles) return null;
    for(const p of game.projectiles){
      if(p.dead || p.owner === me) continue;
      if(p.owner && me.team && p.owner.team === me.team) continue;
      const dist = Math.hypot(p.x-me.x, p.z-me.z);
      if(dist > 25) continue;

      const dx = me.x - p.x;
      const dz = me.z - p.z;
      const dot = dx*p.dir.x + dz*p.dir.z;
      if(dot < 0) continue;

      const projX = p.x + p.dir.x * dot;
      const projZ = p.z + p.dir.z * dot;
      const missDist = Math.hypot(projX-me.x, projZ-me.z);

      if(missDist < 5 && dist < 15){
        return p;
      }
    }
    return null;
  }

  _getDodgeAngle(shell, me){
    const perpX = -shell.dir.z;
    const perpZ = shell.dir.x;
    const cross = perpX*(me.z-shell.z) - perpZ*(me.x-shell.x);
    const dir = cross > 0 ? 1 : -1;
    return Math.atan2(perpX*dir, perpZ*dir);
  }

  _wallAvoid(me, out, game){
    /* collidesForAI so the probes can actually SEE the cover they are meant to
       avoid. Against collidesWallsOnly they reported clear on a map made
       entirely of it, which is why bots used to drive into buildings and lean
       on them. */
    const solid = game.world.collidesForAI ? game.world.collidesForAI.bind(game.world)
                                            : game.world.collidesWallsOnly.bind(game.world);
    const probeX = me.x + Math.sin(me.heading)*4;
    const probeZ = me.z + Math.cos(me.heading)*4;
    if(solid(probeX, probeZ, 2)){
      const probeR = me.x + Math.sin(me.heading+0.8)*4;
      const probeRR = me.z + Math.cos(me.heading+0.8)*4;
      const probeL = me.x + Math.sin(me.heading-0.8)*4;
      const probeLZ = me.z + Math.cos(me.heading-0.8)*4;

      if(!solid(probeR, probeRR, 2)){
        out.turn += 0.8;
      } else if(!solid(probeL, probeLZ, 2)){
        out.turn -= 0.8;
      } else {
        out.turn += (Math.random() < 0.5 ? 1 : -1) * 0.8;
      }
      out.throttle = Math.min(out.throttle, 0.5);
    }
    this._voidAvoid(me, out, game);
  }

  _voidAvoid(me, out, game){
    if(!game.world) return;
    let half = (game.world.half || 333) - 15;
    const box = game.world._tdmBox;
    if(box){
      const hx = (box.max.x - box.min.x) / 2 - 5;
      const hz = (box.max.z - box.min.z) / 2 - 5;
      half = Math.min(half, hx, hz);
      const cx = (box.max.x + box.min.x) / 2;
      const cz = (box.max.z + box.min.z) / 2;
      const relX = me.x - cx, relZ = me.z - cz;
      const distX = half - Math.abs(relX);
      const distZ = half - Math.abs(relZ);
      if(distX < 8 || distZ < 8){
        const pushX = relX > 0 ? -1 : 1;
        const pushZ = relZ > 0 ? -1 : 1;
        let targetAngle;
        if(distX < distZ){ targetAngle = Math.atan2(pushX, 0); }
        else { targetAngle = Math.atan2(0, pushZ); }
        const diff = this._angleDiff(targetAngle, me.heading);
        out.turn += Math.max(-1, Math.min(1, diff * 2));
        out.throttle = Math.max(0.4, out.throttle);
        return;
      }
    }
    const dx = me.x, dz = me.z;
    const distX = half - Math.abs(dx);
    const distZ = half - Math.abs(dz);
    const margin = 25;
    if(distX < margin || distZ < margin){
      const pushX = dx > 0 ? -1 : 1;
      const pushZ = dz > 0 ? -1 : 1;
      let targetAngle;
      if(distX < distZ){
        targetAngle = Math.atan2(pushX, 0);
      } else {
        targetAngle = Math.atan2(0, pushZ);
      }
      const diff = this._angleDiff(targetAngle, me.heading);
      out.turn += Math.max(-1, Math.min(1, diff * 2));
      out.throttle = Math.max(0.3, out.throttle);
    }
  }

  _separateFromAllies(me, out, game){
    let pushX = 0, pushZ = 0, count = 0;
    for(const t of game.tanks){
      if(t === me || !t.alive) continue;
      if(me.team && t.team && me.team === t.team){
        const dx = me.x - t.x;
        const dz = me.z - t.z;
        const d = Math.hypot(dx, dz);
        if(d < this._separationRadius && d > 0.1){
          const force = (this._separationRadius - d) / this._separationRadius;
          pushX += (dx / d) * force;
          pushZ += (dz / d) * force;
          count++;
        }
      }
    }
    if(count > 0){
      const avgX = pushX / count;
      const avgZ = pushZ / count;
      const pushAngle = Math.atan2(avgX, avgZ);
      const pushAngDiff = this._angleDiff(pushAngle, me.heading);
      out.turn += Math.max(-0.6, Math.min(0.6, pushAngDiff * 1.5));
      out.throttle = Math.max(out.throttle, 0.3);
    }
  }

  _checkStuck(me, game){
    const dx = me.x - this._stuckCheckPos.x;
    const dz = me.z - this._stuckCheckPos.z;
    const moved = Math.hypot(dx, dz);
    if(moved > 2){
      this._stuckCheckPos = {x: me.x, z: me.z};
      this._stuckTimer = 0;
      return false;
    }
    this._stuckTimer += game.dt;
    if(this._stuckTimer > 1.5){
      this._stuckTimer = 0;
      this._stuckCheckPos = {x: me.x, z: me.z};
      return true;
    }
    return false;
  }

  _clamp(out){
    out.throttle = Math.max(-1, Math.min(1, out.throttle));
    out.turn = Math.max(-1, Math.min(1, out.turn));
    return out;
  }

  _angleDiff(a,b){
    let d = ((a-b+Math.PI)%(Math.PI*2))-Math.PI;
    return d;
  }

  /* ==========================================================================
     NAVIGATION — DRIVE TO A POINT WITHOUT DRIVING INTO THE BUILDING
     --------------------------------------------------------------------------
     Every behaviour that wants to go somewhere used to do this:

         const a = Math.atan2(dest.x - me.x, dest.z - me.z);
         out.turn = clamp(this._angleDiff(a, me.heading) * 1.8);

     which is a correct answer to "which way is the point" and a useless answer
     to "how do I get there". If a wall sits between the tank and the point, the
     answer is the wall, every frame, forever — the bot presses against it until
     _checkStuck() eventually interrupts with a random turn. That reads as a bot
     that has hit something and given up.

     This is the single point every movement behaviour now routes through.

     THE FAST PATH IS THE POINT.
     On open ground -- most of the time, on most maps -- the goal is already in
     a clear straight line. That is one of the cheap clearLine() samples, and
     when it succeeds the steering is identical to what the bot always did. The
     pathfinder is only consulted when something is genuinely in the way, so the
     common case costs one line test and no allocation at all. Bots keep their
     existing feel on open maps and gain a sense of place on complicated ones.

     A* is bounded internally (see bot-nav.js) and the resulting path is cached
     on the bot and reused until the goal actually moves, so a bot crossing open
     ground pays for one search and then nothing.
     ========================================================================== */
  _driveTo(me, out, gx, gz, game, gain){
    gain = gain || 1.8;
    if(!game.world) return;

    /* --- consume waypoints we have already reached ------------------------ */
    if(this._path && this._path.length){
      while(this._path.length){
        const wp = this._path[0];
        if(Math.hypot(wp.x - me.x, wp.z - me.z) > 6) break;
        this._path.shift();
      }
      if(!this._path.length) this._path = null;
    }

    /* --- do we need a path at all? --------------------------------------- */
    const direct = !this._path && window.BotNav && window.BotNav.clear(game.world, me.x, me.z, gx, gz);

    if(direct || !this._path){
      /* Replan only when the goal has drifted far enough to matter, or when the
         previous path ran out. Re-planning on every tick is what turns path
         following into a frame-rate problem. */
      const goalMoved = !this._pathGoal || Math.hypot(gx - this._pathGoal.x, gz - this._pathGoal.z) > 8;
      if(!direct && goalMoved && window.BotNav){
        const p = window.BotNav.plan(game.world, me.x, me.z, gx, gz);
        this._path = p;
        this._pathGoal = { x: gx, z: gz };
      } else if(direct){
        this._path = null;
        this._pathGoal = null;
      }
    }

    /* --- where are we actually pointing right now? ------------------------- */
    let ax = gx, az = gz;
    if(this._path && this._path.length){
      const wp = this._path[0];
      ax = wp.x; az = wp.z;
    }

    const a = Math.atan2(ax - me.x, az - me.z);
    out.turn = Math.max(-1, Math.min(1, this._angleDiff(a, me.heading) * gain));
  }

  /* A path planned for a goal that has since died is worse than no path. */
  _dropPath(){ this._path = null; this._pathGoal = null; }

  /* ==========================================================================
     PERCEPTION — WHAT THE BOT BELIEVES IS OUT THERE
     --------------------------------------------------------------------------
     The old target selection looped every tank in the arena and picked the
     NEAREST enemy. Two things were wrong with that, and both were visible on
     screen:

       * It had no line of sight. A bot locked onto a target through a building,
         and kept steering at the building. LOS was computed LATER, only to
         decide whether it could shoot.
       * It had no memory. The instant a target broke line of sight, the nearest
         enemy became someone else, and the bot turned to face whatever happened
         to be closest -- including an enemy behind it that it had never seen.
         Bots visibly twitched between two enemies across a wall.

     Now: a bot can only ACQUIRE an enemy inside its field of view and in clear
     line of sight, it remembers where a lost target was and goes there to look,
     and allies radio each other's sightings so one pair of eyes covers an angle
     the others cannot.

     All of it is throttled and staggered below, because perception is the one
     part of the AI that scales with (bots x enemies).
     ========================================================================== */
  _perceive(me, game){
    const now = game.time || 0;

    /* Every bot re-checks its eyes on its own phase, roughly twice a second,
       rather than every frame. A bot looking at the same static wall four times
       between changes learns nothing; it just burns the frame budget. The
       window is only for the full sweep -- threat and allies are always current
       because the behaviour layer reads the live arrays anyway. */
    const due = !this._seenAt || (now - this._seenAt) > 0.45;
    this._numVisibleEnemies = 0;
    if(due) this._sweep(me, game, now);
    return this._visible || null;
  }

  _sweep(me, game, now){
    this._seenAt = now;
    const visible = {};
    const FOV = Math.PI * 0.78;              /* ~140 degrees of awareness */
    const RANGE = 95;

    for(const t of game.tanks){
      if(!t.alive) continue;
      const ally = t === me || (me.team && t.team && me.team === me.team);
      const dx = t.x - me.x, dz = t.z - me.z;
      const d = Math.hypot(dx, dz);
      if(d > RANGE) continue;
      if(ally) continue;

      /* Camouflage is a hard invisibility: a tank under enough foliage cannot
         be acquired no matter how well it is placed. Kept consistent with the
         old target loop. */
      if(t.camoFactor <= 0) continue;

      /* Something already on top of you is seen regardless of which way the
         hull is pointing -- you do not need peripheral vision to notice a tank
         touching your tread. */
      const bearing = Math.atan2(dx, dz);
      const off = Math.abs(this._angleDiff(bearing, me.heading));
      if(d > 12 && off > FOV / 2) continue;

      if(!this._hasLOS(me, t, game)) continue;

      visible[t.id] = { t: t, x: t.x, z: t.z, at: now, dist: d };
      this._numVisibleEnemies++;

      /* Record where it was. This is the memory that survives losing sight of
         it, and it decays: a sighting twenty seconds old is a guess, not
         knowledge, and by then it is noise rather than a lead. */
      this._seen = this._seen || {};
      this._seen[t.id] = { t: t, x: t.x, z: t.z, at: now };
    }

    /* FORGET. Anything not confirmed visible and not re-confirmed within a few
       seconds is dropped. Without this the map of remembered positions grows
       without bound over a long match. */
    if(this._seen){
      for(const id in this._seen){
        if(now - this._seen[id].at > 6) delete this._seen[id];
      }
    }

    this._visible = visible;
    this._radio(me, game, now);
  }

  /* TEAM RADIO.

     Allies share sightings, so a bot does not have to personally walk into the
     room where the enemy is in order to know the enemy is in the room. One pair
     of eyes covers an angle the others cannot, and the resulting behaviour --
     a group converging on a contact that only one of them spotted -- is most of
     what makes bots read as a team rather than as several individuals.

     It is nearly free: the data is already computed above and the round trip
     is one property assignment on an existing object. */
  _radio(me, game, now){
    if(!game._botRadio) game._botRadio = new Map();
    if(this._visible && Object.keys(this._visible).length){
      for(const id in this._visible){
        const v = this._visible[id];
        game._botRadio.set(id, { t: v.t, x: v.x, z: v.z, at: now, by: me.id });
      }
    }
    /* Pull teammates' contacts, discounted slightly so a bot prefers what it
       saw itself over what it was told. */
    this._heard = null;
    for(const [id, r] of game._botRadio){
      if(now - r.at > 3) continue;
      if(me.team && r.t.team && r.t.team === me.team) continue;
      if(this._seen && this._seen[id]) continue;      /* already known better */
      if(this._visible && this._visible[id]) continue;
      if(!this._heard) this._heard = {};
      this._heard[id] = r;
    }
  }

  /* Pick who to fight, the way a person does: keep the target you have unless
     there is a good reason to change. Flipping to whichever enemy is nearest on
     every tick is what made the old bots look twitchy. */
  _chooseTarget(me, game){
    const cur = this._curTarget;
    const now = game.time || 0;

    if(cur && cur.alive && this._seen && this._seen[cur.id]
       && (now - this._seen[cur.id].at) < 2.5){
      /* Still worth shooting. Switching costs the turret traverse and the aim
         solution, so it needs to be worth something. */
      const stillHere = this._visible && this._visible[cur.id];
      if(stillHere) return { target: cur, canSee: true };
      return { target: cur, canSee: false };
    }

    /* Nothing held: take the nearest thing currently in view, else the nearest
       remembered position, else whatever a teammate reported. */
    let best = null, bestD = Infinity, sawIt = false;
    if(this._visible){
      for(const id in this._visible){
        const v = this._visible[id];
        if(v.dist < bestD){ bestD = v.dist; best = v.t; sawIt = true; }
      }
    }
    if(!best && this._seen){
      for(const id in this._seen){
        const s = this._seen[id];
        if(s.t === cur) continue;
        const d = Math.hypot(s.x - me.x, s.z - me.z);
        if(d < bestD){ bestD = d; best = s.t; }
      }
    }
    if(!best && this._heard){
      for(const id in this._heard){
        const h = this._heard[id];
        const d = Math.hypot(h.x - me.x, h.z - me.z) * 1.15;   /* heard is worth slightly less than seen */
        if(d < bestD){ bestD = d; best = h.t; }
      }
    }
    if(!best) return { target: null, canSee: false };
    return { target: best, canSee: sawIt || (this._visible && !!this._visible[best.id]) };
  }
}

class PanzerBrain extends BotBrain {
  constructor(tank, master){
    super(tank);
    this.master = master;
  }

  decide(game){
    const me = this.tank;
    if(!me.alive) return {throttle:0, turn:0, turretWorldAngle:me.turretAngle, fire:false};

    const isAlly = (t) => t === me || (me.allyId && (t.id === me.allyId || t.allyId === me.id)) || (me.team && t.team && me.team === t.team);

    let target = null, best = Infinity;
    for(const t of game.tanks){
      if(isAlly(t) || !t.alive) continue;
      if(t.camoFactor <= 0) continue;
      const d = Math.hypot(t.x - me.x, t.z - me.z);
      if(d < best){ best = d; target = t; }
    }

    let throttle = 0, turn = 0;
    let turretAngle = me.turretAngle;
    let fire = false;

    const m = this.master && this.master.alive ? this.master : null;
    const dMaster = m ? Math.hypot(me.x - m.x, me.z - m.z) : Infinity;

    if(m && dMaster > 10){
      const a = Math.atan2(m.x - me.x, m.z - me.z);
      const angDiff = this._angleDiff(a, me.heading);
      turn = Math.max(-1, Math.min(1, angDiff * 1.5));
      throttle = 1;
      turretAngle = a;
    } else if(target){
      const dx = target.x - me.x, dz = target.z - me.z;
      const dist = Math.hypot(dx, dz);
      const angleToTarget = Math.atan2(dx, dz);
      turretAngle = angleToTarget;
      const angDiff = this._angleDiff(angleToTarget, me.heading);
      turn = Math.max(-1, Math.min(1, angDiff * 1.5));
      const idealDist = Math.min(me.def.shellRange * 0.6, 26);
      if(dist > idealDist + 5) throttle = 1;
      else if(dist < idealDist - 5) throttle = -0.6;
      else throttle = 0.2 * Math.sin(game.time * 0.7 + me.x);

      this._wallAvoid(me, {turn, throttle}, game);

      const turDiff = Math.abs(this._angleDiff(turretAngle, me.turretAngle));
      if(turDiff < 0.15 && dist < me.def.shellRange && me.reloadLeft <= 0){
        fire = true;
      }
    } else {
      this.wanderTimer -= game.dt;
      if(this.wanderTimer <= 0){ this.wanderHeading = Math.random() * Math.PI * 2; this.wanderTimer = 2 + Math.random() * 3; }
      turn = Math.max(-1, Math.min(1, this._angleDiff(this.wanderHeading, me.heading)));
      throttle = 0.7;
    }
    return this._clamp({throttle, turn, turretWorldAngle: turretAngle, fire});
  }
}
