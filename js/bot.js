/* ============================================================
   bot.js — bot players.
   BotSquad (one per team) reads the mode's goal and gives each bot an order.
   BotBrain follows its order and fights inside it. BOT_PLAYSTYLES says how a
   tank should be played, BOT_PERSONALITIES who is playing it, iq how well.
   ============================================================ */

/* ============================================================
   PLAYSTYLES — how each TANK MODEL fights, not just how smart.

   The IQ levels (below, per brain) say HOW WELL a bot plays;
   this table says WHAT the play is. Everybody with the same IQ
   otherwise danced to the same beat: a mortar holding at brawler
   distance, a slow demolisher "flanking" a whole map away. Each
   profile is a handful of multipliers the existing behaviour code
   reads, so a tank's role lives in one place and a def that later
   changes its shell range re-tunes itself:

     closeIn       stand-off range as a FRACTION of the gun's range.
                   Artillery keeps 1.6x (fights from the far edge);
                   brawlers .4 (walk up and land shells).
     retreatHpMul  scales the IQ's retreat eagerness. Demolisher is
                   a brick; mortar is paper with the longest barrel.
     peekMul       stretches (sniper lingers on its peek) or shrinks
                   (flanker jabs and goes) the peek timeout.
     flankBias     coordinated pushes: how OFTEN this tank is willing
                   to set them up (cooldown = base / bias).
     coverSeek     hides in cover when idle, like def.seeksCover.
   ============================================================ */
const BOT_PLAYSTYLES = {
  coolbuddy:   { role:'flanker',   closeIn:0.55, retreatHpMul:0.75, peekMul:0.75, flankBias:1.7, coverSeek:false },
  sturmratte:  { role:'flanker',   closeIn:0.50, retreatHpMul:0.70, peekMul:0.70, flankBias:1.8, coverSeek:false },
  helix:       { role:'rusher',    closeIn:0.40, retreatHpMul:0.80, peekMul:0.80, flankBias:1.3, coverSeek:false },
  striker:     { role:'sniper',    closeIn:1.25, retreatHpMul:1.25, peekMul:1.40, flankBias:0.6, coverSeek:true },
  ghost:       { role:'ambusher',  closeIn:0.80, retreatHpMul:1.10, peekMul:1.20, flankBias:1.2, coverSeek:true },
  predator:    { role:'ambusher',  closeIn:0.75, retreatHpMul:1.00, peekMul:1.20, flankBias:1.1, coverSeek:true },
  grom:        { role:'brawler',   closeIn:0.45, retreatHpMul:0.75, peekMul:0.90, flankBias:1.0, coverSeek:false },
  demolisher:  { role:'brawler',   closeIn:0.40, retreatHpMul:0.65, peekMul:0.85, flankBias:0.8, coverSeek:false },
  double:      { role:'mid',       closeIn:0.80, retreatHpMul:1.00, peekMul:1.00, flankBias:1.2, coverSeek:false },
  burst:       { role:'skirmisher',closeIn:0.85, retreatHpMul:1.05, peekMul:1.00, flankBias:1.1, coverSeek:false },
  mortar:      { role:'artillery', closeIn:1.60, retreatHpMul:1.40, peekMul:1.60, flankBias:0.4, coverSeek:true },
  tankdisplay: { role:'mid',       closeIn:1.00, retreatHpMul:1.00, peekMul:1.00, flankBias:1.0, coverSeek:false },
};
/* A tank that is not in the table (an editor import, a future model) still
   plays sanely: close to just inside the gun's range, ordinary profile. */
const BOT_DEFAULT_STYLE = { role:'mid', closeIn:0.90, retreatHpMul:1.00, peekMul:1.00, flankBias:1.0, coverSeek:false };

/* ============================================================
   PERSONALITIES — who is driving, on top of what they drive.

     aggr      how far forward it plays and how readily it chases
     patience  holds angles and uses cover over side-stepping in the open
     team      sticks to the group; low = goes its own way on a wide lane
     nerve     HP share at which it pulls back
     aim       aim error multiplier (lower is better)
     react     reaction time multiplier
     guard     how much it prefers defending when a base needs it
   ============================================================ */
const BOT_PERSONALITIES = {
  hothead:  { aggr:0.90, patience:0.20, team:0.35, nerve:0.18, aim:1.30, react:0.75, guard:0.0 },
  veteran:  { aggr:0.55, patience:0.75, team:0.80, nerve:0.40, aim:0.65, react:0.85, guard:0.4 },
  guardian: { aggr:0.30, patience:0.90, team:0.90, nerve:0.40, aim:0.90, react:1.00, guard:1.0 },
  wingman:  { aggr:0.50, patience:0.50, team:1.00, nerve:0.35, aim:1.00, react:1.00, guard:0.5 },
  loner:    { aggr:0.60, patience:0.65, team:0.10, nerve:0.35, aim:0.90, react:0.90, guard:0.1 },
  cautious: { aggr:0.25, patience:1.00, team:0.70, nerve:0.55, aim:1.00, react:1.10, guard:0.7 },
  rookie:   { aggr:0.50, patience:0.35, team:0.40, nerve:0.25, aim:1.70, react:1.60, guard:0.2 },
};
/* Each kind of tank draws from the people who would pick it. */
const BOT_PERSONALITY_POOLS = {
  artillery:  ['cautious','veteran','guardian','rookie'],
  sniper:     ['cautious','veteran','loner','guardian','rookie'],
  ambusher:   ['loner','veteran','cautious','wingman','rookie'],
  brawler:    ['hothead','wingman','guardian','veteran','rookie'],
  rusher:     ['hothead','hothead','wingman','loner','rookie'],
  flanker:    ['loner','hothead','wingman','veteran','rookie'],
  skirmisher: ['wingman','veteran','loner','hothead','rookie'],
  mid:        ['wingman','veteran','guardian','hothead','loner','rookie'],
};

/* ============================================================
   BotSquad — one per team, the only thing that thinks about the team.

   About once a second it looks at the mode's goal and the state of the fight
   and hands every bot an ORDER: a post to go to, how far it may chase from it,
   how fast to get there and which way to watch. Bots then fight on their own
   inside that. One team-level pass a second replaces a lot of per-bot guessing,
   and it is what makes defending, regrouping and pushing together possible.
   ============================================================ */
class BotSquad {
  static get(game, team){
    if(!game._botSquads) game._botSquads = {};
    return game._botSquads[team] || (game._botSquads[team] = new BotSquad(team));
  }

  static playHalf(game){
    const box = game.world && game.world._tdmBox;
    if(box) return Math.min(box.max.x - box.min.x, box.max.z - box.min.z) / 2 - 8;
    return ((game.world && game.world.half) || 300) - 15;
  }
  static playCentre(game){
    const box = game.world && game.world._tdmBox;
    return box ? { x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2 } : { x: 0, z: 0 };
  }
  /* The nearest open ground to a point, so no post is ever inside a building. */
  static freeSpot(game, x, z){
    const w = game.world;
    if(!w || !w.collidesForAI || !w.collidesForAI(x, z, 3)) return { x, z };
    for(let r = 5; r <= 25; r += 5){
      for(let i = 0; i < 8; i++){
        const a = i / 8 * Math.PI * 2;
        const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
        if(!w.collidesForAI(px, pz, 3)) return { x: px, z: pz };
      }
    }
    return { x, z };
  }

  constructor(team){
    this.team = team;
    this.at = -99;
    this.orders = new Map();
    this.progress = 0.3;
    this.focus = null;
    this.contact = null;
    this.baseHp = null;
    this.baseHitAt = -99;
    this.home = null;
    this.front = null;
  }

  orderFor(tank, game, now){
    if(now - this.at >= 1 || !this.orders.has(tank.id)) this._update(game, now);
    return this.orders.get(tank.id) || null;
  }

  _centroid(list, read){
    let x = 0, z = 0, n = 0;
    for(const t of list){ const p = read(t); if(p){ x += p.x; z += p.z; n++; } }
    return n ? { x: x / n, z: z / n } : null;
  }

  _update(game, now){
    const dt = Math.min(2, now - this.at);
    this.at = now;
    const usable = t => t && t.alive && !t.dying && !t.isPanzer && !t.isDummy;
    const members = [], bots = [], enemies = [];
    for(const t of game.tanks){
      if(!usable(t)) continue;
      if(t.team === this.team){ members.push(t); if(t.brain) bots.push(t); }
      else enemies.push(t);
    }
    /* Spawns stay put when tanks die, so these are stable for the whole match. */
    const all = game.tanks.filter(t => t && !t.isPanzer && !t.isDummy);
    this.home = this._centroid(all.filter(t => t.team === this.team), t => t._spawnPos) || this.home || { x: 0, z: 0 };
    const centre = BotSquad.playCentre(game);
    this.front = this._centroid(all.filter(t => t.team && t.team !== this.team), t => t._spawnPos)
      || this.front || { x: centre.x * 2 - this.home.x, z: centre.z * 2 - this.home.z };

    /* What the team actually knows, not where the enemies really are. */
    const known = [];
    if(game._botRadio){
      for(const [id, r] of game._botRadio){
        if(now - r.at > 5 || !r.t.alive){ game._botRadio.delete(id); continue; }
        if(r.t.team !== this.team) known.push(r);
      }
    }
    const mid = this._centroid(members, t => t) || this.home;
    this.mid = mid;
    this.contact = null; this.focus = null;
    let bestC = Infinity, bestF = Infinity;
    for(const r of known){
      const d = Math.hypot(r.x - mid.x, r.z - mid.z);
      if(d < bestC){ bestC = d; this.contact = r; }
      const frac = r.t.maxHp ? r.t.hp / r.t.maxHp : 1;
      const score = d * 0.4 + frac * 60;
      if(score < bestF){ bestF = score; this.focus = r.t; }
    }

    this.orders.clear();
    if(!bots.length) return;
    const ctx = { game, now, dt, members, bots, enemies, known, mid };
    if(game._baseDefendMode && typeof BaseDefend !== 'undefined' && BaseDefend.getState()) this._baseOrders(ctx);
    else if(game._captureCircleMode && typeof CaptureCircle !== 'undefined' && CaptureCircle.getState()) this._circleOrders(ctx);
    else this._pushOrders(ctx, bots);
  }

  _post(tank, ctx, kind, x, z, opts){
    const P = tank.brain.person;
    const s = BotSquad.freeSpot(ctx.game, x, z);
    this.orders.set(tank.id, Object.assign({
      kind, x: s.x, z: s.z, r: 5,
      leash: 30 + P.aggr * 35,
      pace: 0.55 + P.aggr * 0.35,
      face: this.front,
      rally: this.home,
      hide: false,
    }, opts || {}));
  }

  /* A fixed spot around a point for each bot, so a team spreads out on arrival. */
  _slot(tank, spread){
    const b = tank.brain;
    return { x: Math.sin(b._phase * 7) * spread * (0.4 + (b._phase % 1) * 0.6), z: Math.cos(b._phase * 7) * spread * (0.4 + (b._phase % 1) * 0.6) };
  }

  /* Move forward as a group: the line only advances once enough of the team has
     caught up, and gives ground when it is losing. Lanes keep them from driving
     in single file, ranged tanks hang back, loners take a wide route. */
  _pushOrders(ctx, list){
    const { game, members, enemies, bots, now, dt } = ctx;
    const dx = this.front.x - this.home.x, dz = this.front.z - this.home.z;
    const len = Math.max(1, Math.hypot(dx, dz));
    const ax = dx / len, az = dz / len, px = az, pz = -ax;
    const lineAt = p => ({ x: this.home.x + dx * p, z: this.home.z + dz * p });
    const line = lineAt(this.progress);

    let caught = 0;
    for(const t of list) if(Math.hypot(t.x - line.x, t.z - line.z) < 50) caught++;
    const strength = members.length / Math.max(1, enemies.length);
    /* Radio contacts alone must not stop the push: two teams that know about each
       other through a wall would otherwise wait there all match. Only actual
       fighting holds the line, and a long quiet spell moves it regardless. */
    let fighting = false;
    for(const t of bots) if(t.brain._numVisibleEnemies > 0){ fighting = true; break; }
    if(fighting) this.quietAt = now;
    const quiet = now - (this.quietAt === undefined ? (this.quietAt = now) : this.quietAt);
    if(strength < 0.7 && fighting) this.progress = Math.max(0.15, this.progress - 0.04 * dt);
    else if(!fighting && (caught >= list.length * 0.5 || quiet > 10)) this.progress = Math.min(1, this.progress + 0.05 * dt);
    else if(strength >= 1.4) this.progress = Math.min(1, this.progress + 0.02 * dt);

    /* Nothing found at the far end: someone has a hunch where they went. */
    let goal = lineAt(this.progress);
    if(!fighting && quiet > 18 && enemies.length){
      /* Nobody has seen a fight in a while: go and find one. */
      if(now > (this._hunchAt || 0) || !this._hunch){
        this._hunchAt = now + 12;
        const e = this.contact ? this.contact : enemies[Math.random() * enemies.length | 0];
        this._hunch = { x: e.x + (Math.random() - 0.5) * 30, z: e.z + (Math.random() - 0.5) * 30 };
      }
      goal = this._hunch;
    } else if(this.progress >= 0.95 && !ctx.known.length && enemies.length){
      if(now > (this._hunchAt || 0) || !this._hunch){
        this._hunchAt = now + 12;
        const e = enemies[Math.random() * enemies.length | 0];
        this._hunch = { x: e.x + (Math.random() - 0.5) * 50, z: e.z + (Math.random() - 0.5) * 50 };
      }
      goal = this._hunch;
    } else if(this.contact && Math.hypot(this.contact.x - goal.x, this.contact.z - goal.z) < 90){
      goal = { x: (goal.x + this.contact.x) / 2, z: (goal.z + this.contact.z) / 2 };
    }

    const half = BotSquad.playHalf(game), c = BotSquad.playCentre(game);
    list.forEach((t, i) => {
      const b = t.brain, P = b.person;
      /* Lanes are close enough that the team still covers one another. */
      const lane = Math.max(-2, Math.min(2, ((i + 1) >> 1) * (i % 2 ? 1 : -1)));
      const role = b.style.role;
      const back = role === 'artillery' ? 42 : role === 'sniper' ? 28 : role === 'brawler' || role === 'rusher' ? -8 : 0;
      const wide = (role === 'flanker' ? 1.3 : 1) * (1 + (1 - P.team) * 0.6);
      let x = goal.x + px * lane * 11 * wide - ax * back;
      let z = goal.z + pz * lane * 11 * wide - az * back;
      x = Math.max(c.x - half, Math.min(c.x + half, x));
      z = Math.max(c.z - half, Math.min(c.z + half, z));
      this._post(t, ctx, 'advance', x, z, {
        hide: b.style.coverSeek,
        face: this.contact || this.front,
        rally: { x: goal.x - ax * 45, z: goal.z - az * 45 },
      });
    });
  }

  /* Most of the team stands in the circle; the ranged tanks and the last few
     watch over it from outside, on the side the enemy comes from. Zones we do not
     hold come first, and a zone the enemy is close to taking outranks all. */
  _circleOrders(ctx){
    const { bots } = ctx;
    const st = CaptureCircle.getState();
    const zones = st.zones || [];
    if(!zones.length) return this._pushOrders(ctx, bots);
    const R = (typeof GAMEMODES !== 'undefined' && GAMEMODES.captureTheCircle && GAMEMODES.captureTheCircle.circleRadius) || 12;
    const mine = this.team === 'blue' ? 'bluePercent' : 'redPercent';
    const theirs = this.team === 'blue' ? 'redPercent' : 'bluePercent';
    const urgency = z => (z.owner === this.team ? 0 : 40) + (z[theirs] || 0) - (z[mine] || 0) * 0.3;
    const order = zones.slice().sort((a, b) => urgency(b) - urgency(a));

    /* Split the team across zones by need: never fewer than one on the top zone. */
    const lists = order.map(() => []);
    const left = bots.slice();
    if(order.length > 1){
      const share = Math.max(1, Math.ceil(bots.length * (urgency(order[1]) > 20 ? 0.4 : 0.25)));
      left.sort((a, b) => Math.hypot(a.x - order[1].cx, a.z - order[1].cz) - Math.hypot(b.x - order[1].cx, b.z - order[1].cz));
      lists[1] = left.splice(0, Math.min(share, Math.max(0, left.length - 1)));
    }
    lists[0] = left;

    lists.forEach((team, zi) => {
      const z = order[zi];
      const dx = this.front.x - z.cx, dz = this.front.z - z.cz, len = Math.max(1, Math.hypot(dx, dz));
      const ax = dx / len, az = dz / len;
      const pressing = (z.owner !== this.team && (z[theirs] || 0) > 50);
      const sorted = team.slice().sort((a, b) => b.brain.style.closeIn - a.brain.style.closeIn);
      const watchers = pressing ? 0 : Math.floor(sorted.length * 0.35);
      sorted.forEach((t, i) => {
        const b = t.brain;
        if(i < watchers){
          /* Hold just off the circle towards home, gun range covering it. */
          const off = Math.min(40, (t.def.shellRange || 60) * 0.45);
          const side = (i % 2 ? 1 : -1) * 12;
          this._post(t, ctx, 'overwatch', z.cx - ax * off + az * side, z.cz - az * off - ax * side, {
            leash: 22, hide: b.style.coverSeek, face: { x: z.cx, z: z.cz }, pace: 0.7,
            rally: { x: z.cx - ax * (off + 25), z: z.cz - az * (off + 25) },
          });
        } else {
          const s = this._slot(t, R * 0.7);
          /* A team that is capturing does not stroll there. */
          this._post(t, ctx, 'capture', z.cx + s.x, z.cz + s.z, {
            r: 3, leash: R + 12, pace: pressing ? 1 : 0.85, face: this.contact || this.front,
            rally: { x: z.cx - ax * 25, z: z.cz - az * 25 },
          });
        }
      });
    });
  }

  /* Base Defend: how many stay home follows from how the base is doing. */
  _baseOrders(ctx){
    const { bots, now, known, game } = ctx;
    const bd = BaseDefend.getState();
    const me = bd.bases.find(b => b.team === this.team);
    const them = bd.bases.find(b => b.team !== this.team);
    if(!me || !them || bd.winner) return this._pushOrders(ctx, bots);

    if(this.baseHp !== null && me.hp < this.baseHp - 0.01) this.baseHitAt = now;
    this.baseHp = me.hp;
    const myHp = me.hp / Math.max(1, me.maxHp), theirHp = them.hp / Math.max(1, them.maxHp);
    const hitLately = now - this.baseHitAt < 6;

    let attacker = null, bestA = 90;
    for(const r of known){
      const d = Math.hypot(r.x - me.x, r.z - me.z);
      if(d < bestA){ bestA = d; attacker = r; }
    }

    let share;
    if(myHp < 0.35) share = hitLately || attacker ? 0.8 : 0.5;
    else if(hitLately || attacker) share = myHp < 0.65 ? 0.6 : 0.4;
    else if(myHp < 0.65) share = 0.3;
    else share = 0.15;
    /* Their base is nearly down and ours is fine: everyone goes for the win. */
    if(theirHp < 0.25 && myHp > theirHp + 0.2 && !attacker) share = 0;
    const count = Math.min(bots.length, Math.round(bots.length * share));

    /* Guardians first, then whoever is already closest to home. */
    const ranked = bots.slice().sort((a, b) =>
      (Math.hypot(a.x - me.x, a.z - me.z) - a.brain.person.guard * 80) -
      (Math.hypot(b.x - me.x, b.z - me.z) - b.brain.person.guard * 80));
    const dx = them.x - me.x, dz = them.z - me.z, len = Math.max(1, Math.hypot(dx, dz));
    const ax = dx / len, az = dz / len;

    ranked.slice(0, count).forEach(t => {
      const towards = attacker || { x: me.x + ax * 30, z: me.z + az * 30 };
      const d = Math.max(1, Math.hypot(towards.x - me.x, towards.z - me.z));
      const s = this._slot(t, 14);
      this._post(t, ctx, 'defend', me.x + (towards.x - me.x) / d * 20 + s.x, me.z + (towards.z - me.z) / d * 20 + s.z, {
        leash: 42, pace: hitLately || myHp < 0.5 ? 1 : 0.7, face: towards,
        rally: { x: me.x, z: me.z },
      });
    });

    /* The rest gather short of the enemy base, then go in together. */
    const strike = ranked.slice(count);
    if(!strike.length) return;
    const hold = Math.min(len * 0.5, 110);
    const stage = { x: them.x - ax * hold, z: them.z - az * hold };
    if(this._attackAt === undefined) this._attackAt = now + 18;
    let ready = 0;
    for(const t of strike) if(Math.hypot(t.x - stage.x, t.z - stage.z) < 40 || Math.hypot(t.x - them.x, t.z - them.z) < hold) ready++;
    if(ready >= Math.ceil(strike.length * 0.6) || now > (this._attackAt || 0)){
      if(!this._attacking) this._attackAt = now + 30;
      this._attacking = true;
    }
    if(this._attacking && ready < strike.length * 0.25 && now > (this._attackAt || 0)){
      this._attacking = false;
      this._attackAt = now + 25;
    }
    strike.forEach(t => {
      const s = this._slot(t, 16);
      const r = Math.min(52, (t.def.shellRange || 60) * 0.75);
      const dest = this._attacking ? { x: them.x - ax * r + s.x, z: them.z - az * r + s.z } : { x: stage.x + s.x, z: stage.z + s.z };
      this._post(t, ctx, 'attack', dest.x, dest.z, {
        leash: 38, face: { x: them.x, z: them.z }, siege: this._attacking,
        rally: { x: stage.x - ax * 30, z: stage.z - az * 30 },
      });
    });
  }
}

class BotBrain {
  constructor(tank, opts){
    this.tank = tank;
    const o = opts || {};
    this._botId = Math.random().toString(36).slice(2, 8);
    this._phase = Math.random() * Math.PI * 2;

    /* Perception. All empty until the first think, so a bot that joins mid-match
       starts blind rather than with someone else's memory. */
    this._seen = null;        /* uid -> { t, x, z, at }  last known position */
    this._seenAt = 0;
    this._visible = null;     /* uid -> { t, x, z, at, dist }  in sight now   */
    this._heard = null;       /* teammates' radio */
    this._numVisibleEnemies = 0;
    this._curTarget = null;
    this.targetLastSeen = null;
    this._path = null;
    this._pathGoal = null;
    this._allyPositions = [];
    this._stuckAt = 0;
    this._stuckCheckPos = {x: tank.x, z: tank.z};
    this._separationRadius = 5;
    this._losCache = {};
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.wanderTimer = 0;
    this.wanderHeading = Math.random() * Math.PI * 2;

    this.iq = o.iq || (['low','medium','medium','high'])[Math.random()*4|0];
    this.reactionDelay = this.iq === 'high' ? 0.12 : this.iq === 'medium' ? 0.25 : 0.45;

    this.style = BOT_PLAYSTYLES[(tank.def && tank.def.id) || ''] || BOT_DEFAULT_STYLE;
    const pool = BOT_PERSONALITY_POOLS[this.style.role] || BOT_PERSONALITY_POOLS.mid;
    this.personality = o.personality || pool[Math.random() * pool.length | 0];
    this.person = BOT_PERSONALITIES[this.personality];
  }

  /* One think. Bots no longer run a state machine that restarts its plan every
     few seconds. Each think answers three questions in order: what does my team
     want from me (the squad's order), am I fit to do it (retreat), and is there
     someone to shoot right now (fight). Everything else is following the order. */
  decide(game){
    const me = this.tank;
    if(!me.alive) return {throttle:0, turn:0, turretWorldAngle:me.turretAngle, fire:false};
    const now = game.time || 0;

    this._perceive(me, game);
    const order = me.team ? BotSquad.get(game, me.team).orderFor(me, game, now) : this._soloOrder(me, game, now);
    this._order = order;

    const pick = this._chooseTarget(me, game, order, now);
    const target = pick.target, canSee = !!pick.canSee;
    this._curTarget = target;
    if(target){ this.targetLastSeen = { x: target.x, z: target.z }; this._lostAt = now; }
    else if(this.targetLastSeen && now - (this._lostAt || 0) > 4) this.targetLastSeen = null;

    /* A new target takes a moment to react to; a veteran is quicker than a rookie. */
    if(target !== this._engaged){
      this._engaged = target;
      this._engagedAt = now;
      this._fireReadyAt = now + this.reactionDelay * this.person.react + Math.random() * 0.25;
    }

    const out = { throttle: 0, turn: 0, turretAngle: me.turretAngle, fire: false };
    const hp = me.hp / Math.max(1, me.maxHp);

    if(!this._retreatUntil && hp < this._nerve(order) && now > (this._retreatCd || 0) && (canSee || now - (me._lastHitAt || -99) < 3)){
      this._retreatUntil = now + 5 + this.person.nerve * 4;
      this._retreatCd = this._retreatUntil + 14;
    }
    if(this._retreatUntil && now > this._retreatUntil) this._retreatUntil = 0;

    const shell = now > (this._dodgeCd || 0) ? this._detectIncomingShell(me, game) : null;
    if(shell){
      this._dodgeCd = now + 1.6;
      if(Math.random() < (this.iq === 'high' ? 0.85 : this.iq === 'medium' ? 0.55 : 0.3)){
        this._dodgeUntil = now + 0.55;
        this.dodgeDir = this._getDodgeAngle(shell, me);
      }
    }

    if(target && target.isBase) this._attackBase(me, target, game, out, now);
    else if(this._retreatUntil) this._retreat(me, target, game, out, now);
    else if(target && canSee) this._fight(me, target, order, game, out, now);
    else this._followOrder(me, target, order, game, out, now);

    if(target && !target.isBase && canSee) this._aimAndFire(me, target, game, out, now);

    if(this._dodgeUntil && now < this._dodgeUntil){
      out.turn = Math.max(-1, Math.min(1, this._angleDiff(this.dodgeDir, me.heading) * 2.5));
      out.throttle = 1;
    }

    this._separateFromAllies(me, out, game);

    if(out.throttle !== 0 && this._checkStuck(me, now)){
      /* Back off and swing round rather than pressing on into whatever stopped it. */
      this._unstickUntil = now + 1.3;
      this._unstickDir = Math.random() < 0.5 ? 1 : -1;
      this._dropPath();
    }
    if(this._unstickUntil && now < this._unstickUntil){
      out.throttle = -0.8;
      out.turn = this._unstickDir;
    }

    try { this._maybeSuper(me, target, canSee, game); } catch(e){}
    return this._clamp({ throttle: out.throttle, turn: out.turn, turretWorldAngle: out.turretAngle, fire: out.fire, aimPitch: out.aimPitch || 0 });
  }

  /* The frames between thinks: keep driving the plan, and let the turret track a
     target still in view, with the same aim error the think chose. */
  heldInput(plan){
    const t = this._curTarget, me = this.tank;
    const live = t && t.alive && t.camoFactor > 0 && !t.isBase && this._visible && this._visible[t.id];
    return {
      throttle: plan.throttle,
      turn: plan.turn,
      turretWorldAngle: live ? Math.atan2(t.x - me.x, t.z - me.z) + (this._aimErr || 0) : plan.turretWorldAngle,
      fire: plan.fire,
      handbrake: plan.handbrake,
      aimPitch: plan.aimPitch || 0,
    };
  }

  _nerve(order){
    const base = this.person.nerve * this.style.retreatHpMul * 0.8;
    return order && (order.kind === 'capture' || order.kind === 'defend') ? base * 0.6 : base;
  }

  /* Drive at a point, slowing to turn first instead of arcing wide into a wall. */
  _go(me, out, x, z, game, pace){
    this._driveTo(me, out, x, z, game, 1.8);
    const wp = this._path && this._path[0];
    const a = Math.atan2((wp ? wp.x : x) - me.x, (wp ? wp.z : z) - me.z);
    const off = Math.abs(this._angleDiff(a, me.heading));
    out.throttle = pace * (off > 1.5 ? 0.15 : off > 0.8 ? 0.55 : 1);
    this._wallAvoid(me, out, game);
  }

  /* Give ground the way a person does: backwards, gun still on the enemy. */
  _backOff(me, out, x, z, game){
    const a = Math.atan2(x - me.x, z - me.z);
    const rev = this._angleDiff(a + Math.PI, me.heading);
    if(Math.abs(rev) < 1.6){
      out.turn = Math.max(-1, Math.min(1, rev * 1.8));
      out.throttle = -0.75;
      this._voidAvoid(me, out, game);
    } else {
      this._go(me, out, x, z, game, 0.8);
    }
  }

  _fight(me, t, order, game, out, now){
    const P = this.person, st = this.style;
    const dist = Math.hypot(t.x - me.x, t.z - me.z);
    const range = me.def.shellRange || 60;
    const want = Math.max(10, Math.min(range * 0.9, range * st.closeIn * (1.25 - 0.5 * P.aggr)));

    let friends = 0;
    for(const a of this._allyPositions) if(Math.hypot(a.x - me.x, a.z - me.z) < 32) friends++;
    const outnumbered = this._numVisibleEnemies > friends + 1 + (P.aggr > 0.7 ? 1 : 0);

    /* How far the order lets this bot chase before it would abandon the job. */
    const leash = order ? order.leash : 60;
    const fromPost = order ? Math.hypot(me.x - order.x, me.z - order.z) : 0;
    const reloading = Math.max(me.reloadLeft || 0, me.magReloadLeft || 0);

    if(order && order.siege && fromPost > 8){
      /* The wave keeps rolling towards the base, gun free to shoot whoever is in the way. */
      this._go(me, out, order.x, order.z, game, 0.75);
    } else if(outnumbered && order && !(order.kind === 'capture' || order.kind === 'defend')){
      const back = order.rally || order;
      this._backOff(me, out, back.x, back.z, game);
    } else if(reloading > 1.2 && P.patience > 0.6 && st.closeIn > 0.5 && (this._coverNow(me, t, game, now))){
      this._go(me, out, this._coverSpot.x, this._coverSpot.z, game, 0.8);
    } else if(dist > want + 7){
      if(fromPost > leash) this._go(me, out, order.x, order.z, game, 0.7);
      else this._go(me, out, t.x, t.z, game, 0.45 + 0.45 * P.aggr);
    } else if(dist < want - 7){
      const a = Math.atan2(me.x - t.x, me.z - t.z);
      const d = want - dist + 8;
      this._backOff(me, out, me.x + Math.sin(a) * d, me.z + Math.cos(a) * d, game);
    } else if(P.patience < 0.8 || this._numVisibleEnemies > 1){
      /* In range: side-step so return fire has to lead, swapping now and then. */
      if(now > (this.strafeTimer || 0)){
        this.strafeTimer = now + 1.2 + Math.random() * 2 + P.patience * 2;
        this.strafeDir = Math.random() < 0.5 ? 1 : -1;
        this._strafeStill = Math.random() < P.patience * 0.5;
      }
      if(!this._strafeStill){
        const a = Math.atan2(t.x - me.x, t.z - me.z) + this.strafeDir * Math.PI / 2;
        this._go(me, out, me.x + Math.sin(a) * 14, me.z + Math.cos(a) * 14, game, 0.55);
      }
    }
  }

  _coverNow(me, t, game, now){
    if(now > (this._coverAt || 0)){
      this._coverAt = now + 1.5;
      this._coverSpot = this._findCoverFromTarget(me, t, game);
    }
    return !!this._coverSpot;
  }

  _aimAndFire(me, t, game, out, now){
    const dist = Math.hypot(t.x - me.x, t.z - me.z);
    const lead = this._calcLead(me, t, dist);
    /* Aim wanders and settles the longer it stays on one target. A moving bot is
       worse, a rookie much worse. Humans miss; bots with perfect aim feel like bots. */
    const settle = 1 - Math.min(1, (now - (this._engagedAt || 0)) / 2.5) * 0.6;
    const amp = (this.iq === 'high' ? 0.022 : this.iq === 'medium' ? 0.045 : 0.08) * this.person.aim * settle * (Math.abs(out.throttle) > 0.2 ? 1.4 : 1);
    this._aimErr = amp * Math.sin(now * 1.7 + this._phase) + amp * 0.5 * Math.sin(now * 4.3 + this._phase * 2);
    const aim = Math.atan2(t.x + lead.x - me.x, t.z + lead.z - me.z) + this._aimErr;
    out.turretAngle = aim;
    /* The shell can only leave within the wedge. A target above or below it cannot
       be hit from here: back away until it is inside, like a player has to. */
    const aimAt = game._pitchToward(me, t.x, game._tankAimY(t), t.z);
    out.aimPitch = aimAt.pitch;
    if(aimAt.clamped){
      const away = Math.atan2(me.x - t.x, me.z - t.z);
      this._backOff(me, out, me.x + Math.sin(away) * 20, me.z + Math.cos(away) * 20, game);
      return;
    }
    const range = me.def.shellRange || 60;
    if(dist > range * (0.8 + 0.2 * this.person.aggr)) return;
    if(now < (this._fireReadyAt || 0)) return;
    const tol = Math.max(0.04, Math.min(0.2, 3 / Math.max(1, dist)));
    if(Math.abs(this._angleDiff(aim, me.turretAngle)) > tol) return;
    if((me.reloadLeft || 0) > 0 || (me.magReloadLeft || 0) > 0) return;
    if(this._allyInLine(me, t, dist)) return;
    out.fire = true;
    this._lastFireTime = now;
  }

  _allyInLine(me, t, dist){
    const ax = (t.x - me.x) / Math.max(1, dist), az = (t.z - me.z) / Math.max(1, dist);
    for(const a of this._allyPositions){
      const dx = a.x - me.x, dz = a.z - me.z;
      const along = dx * ax + dz * az;
      if(along > 2 && along < dist && Math.abs(dx * az - dz * ax) < 3.5) return true;
    }
    return false;
  }

  _attackBase(me, target, game, out, now){
    const d = Math.hypot(target.x - me.x, target.z - me.z);
    const range = Math.min(55, (me.def.shellRange || 65) * 0.8);
    const aim = Math.atan2(target.x - me.x, target.z - me.z);
    out.turretAngle = aim;
    if(d > range){
      this._go(me, out, target.x, target.z, game, 0.7);
    } else if(now > (this._fireReadyAt || 0) && Math.abs(this._angleDiff(aim, me.turretAngle)) < 0.12){
      out.fire = true;
    }
  }

  _retreat(me, target, game, out, now){
    const order = this._order;
    let spot = order && order.rally;
    let near = null, best = 70;
    for(const a of this._allyPositions){
      const d = Math.hypot(a.x - me.x, a.z - me.z);
      if(d < best){ best = d; near = a; }
    }
    if(near) spot = near;
    if(!spot && target) spot = this._findRetreatCover(me, target, game);
    if(target && this._coverNow(me, target, game, now) && !near) spot = this._coverSpot;
    if(!spot){ out.throttle = 0; return; }
    if(Math.hypot(spot.x - me.x, spot.z - me.z) > 9) this._backOff(me, out, spot.x, spot.z, game);
    if(target) out.turretAngle = Math.atan2(target.x - me.x, target.z - me.z);
  }

  /* Nobody to shoot: go where the team needs this bot, then watch that way. */
  _followOrder(me, target, order, game, out, now){
    let gx = order ? order.x : me.x, gz = order ? order.z : me.z;
    const lastSeen = target || null;
    /* A bot that has drifted far from its team regroups on the way, instead of
       arriving at its post alone. Loners keep more distance. */
    const squad = me.team && game._botSquads ? game._botSquads[me.team] : null;
    if(squad && squad.mid && order && order.kind === 'advance'){
      const far = Math.hypot(me.x - squad.mid.x, me.z - squad.mid.z);
      if(far > 45 + (1 - this.person.team) * 40){ gx = (gx + squad.mid.x) / 2; gz = (gz + squad.mid.z) / 2; }
    }

    /* Bold bots go and look where someone just was, while it stays near the job. */
    if(lastSeen && this.person.aggr > 0.45 && order && Math.hypot(lastSeen.x - order.x, lastSeen.z - order.z) < order.leash){
      const mem = this._seen && this._seen[lastSeen.id];
      if(mem){ gx = mem.x; gz = mem.z; }
    } else if(order && order.hide && this._wantsCover(me)){
      /* Ambushers wait inside a bush near their post if one is close. */
      if(this._bushFor !== order.x + order.z){
        this._bushFor = order.x + order.z;
        this._bush = this._findFoliageCover({ x: order.x, z: order.z, team: me.team }, game);
        if(this._bush && Math.hypot(this._bush.x - order.x, this._bush.z - order.z) > 22) this._bush = null;
      }
      if(this._bush){ gx = this._bush.x; gz = this._bush.z; }
    }

    const dist = Math.hypot(gx - me.x, gz - me.z);
    const arrive = order ? order.r || 5 : 5;
    if(dist > arrive){
      const pace = (order ? order.pace : 0.6) * (dist < 14 ? Math.max(0.35, dist / 14) : 1);
      this._go(me, out, gx, gz, game, pace);
    }

    let look;
    if(lastSeen) look = Math.atan2(lastSeen.x - me.x, lastSeen.z - me.z);
    else if(order && order.face) look = Math.atan2(order.face.x - me.x, order.face.z - me.z) + Math.sin(now * 0.6 + this._phase) * 0.7;
    else look = me.heading + Math.sin(now * 0.6 + this._phase) * 1.2;
    out.turretAngle = look;
  }

  /* Free-for-all has no team to answer to: patrol the middle, bolder bots closer in. */
  _soloOrder(me, game, now){
    if(!this._solo || now > this._soloUntil || Math.hypot(me.x - this._solo.x, me.z - this._solo.z) < 8){
      const half = BotSquad.playHalf(game);
      const cx = BotSquad.playCentre(game);
      const spread = half * (0.75 - this.person.aggr * 0.45);
      const a = Math.random() * Math.PI * 2;
      this._solo = BotSquad.freeSpot(game, cx.x + Math.sin(a) * spread * Math.random(), cx.z + Math.cos(a) * spread * Math.random());
      this._soloUntil = now + 10 + this.person.patience * 12;
    }
    return { kind: 'patrol', x: this._solo.x, z: this._solo.z, r: 6, leash: 40 + this.person.aggr * 50, pace: 0.5 + this.person.aggr * 0.4, face: null, hide: true };
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

  /* Who goes to cover when idle. The def opt-in first (striker), then the
     playstyle table: snipers/ambushers/artillery all want to be hard to see,
     brawlers do not - they want to be IN your face. */
  _wantsCover(tank){
    if(tank && tank.def && tank.def.seeksCover) return true;
    const st = this.style;
    return !!(st && st.coverSeek);
  }

  /* Already under enough foliage to be hidden? Used to leave TAKINGCOVER once
     the bot has arrived, and to decide whether an incoming contact is worth
     breaking cover for. */
  _inCover(tank){
    return !!(tank && tank.camoFactor <= 0);
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
      if(Math.abs(w.x - me.x) > 65 || Math.abs(w.z - me.z) > 65) continue;
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
      if(Math.abs(w.x - me.x) > 50 || Math.abs(w.z - me.z) > 50) continue;
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

  _hasLOS(me, target, game, now){
    const c = this._losCache[target.id];
    if(c && now - c.at < 0.5 && Math.hypot(c.x - target.x, c.z - target.z) < 3 && Math.hypot(c.mx - me.x, c.mz - me.z) < 3) return c.ok;
    const dx = target.x - me.x, dz = target.z - me.z;
    const steps = Math.min(Math.ceil(Math.hypot(dx, dz) / 4), 14);
    let ok = true;
    for(let i = 1; i < steps; i++){
      /* collidesForAI: shells stop at GLB cover, so sight has to as well. */
      if(game.world.collidesForAI(me.x + dx / steps * i, me.z + dz / steps * i, 0.5)){ ok = false; break; }
    }
    this._losCache[target.id] = { ok, at: now, x: target.x, z: target.z, mx: me.x, mz: me.z };
    return ok;
  }

  _detectIncomingShell(me, game){
    if(!game.projectiles) return null;
    for(const p of game.projectiles){
      /* Mines, molotovs and panzer drops are projectiles with no direction;
         reading p.dir.x on one stopped every bot's brain for the whole match. */
      if(p.dead || p.owner === me || !p.dir) continue;
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

  _checkStuck(me, now){
    if(Math.hypot(me.x - this._stuckCheckPos.x, me.z - this._stuckCheckPos.z) > 2){
      this._stuckCheckPos = {x: me.x, z: me.z};
      this._stuckAt = now;
      return false;
    }
    if(now - this._stuckAt > 1.5){
      this._stuckAt = now;
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
    /* atan2, not %: JS % keeps the sign, so half of all bearings came out outside
       -PI..PI and bots turned the long way round. */
    const d = a - b;
    return Math.atan2(Math.sin(d), Math.cos(d));
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
      /* One path search a frame across all bots; the rest wait for their next think. */
      const frame = game._frameNo || 0;
      if(!direct && goalMoved && window.BotNav && game._navFrame !== frame){
        game._navFrame = frame;
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

  /* SUPERS. Bots never used theirs -- the super logic only ran for the
     player. Now, once the meter is full, a bot waits a moment (a human does
     not fire it the instant it charges) and uses it when it fits the ability:
     damage supers on a visible enemy in range, escape supers when hurt,
     support supers when a fight is on. Targeted supers hand the game a ground
     point through tank._botSuperPick (game.js _superPick). */
  _maybeSuper(me, target, canSee, game){
    if(!me.hasSuper || !me.hasSuper() || me.superCdLeft > 0) return;
    if(me.superState && me.superState !== 'done') return;
    const now = game.time || 0;
    if(this._superReadyAt === undefined) this._superReadyAt = now + 0.8 + Math.random() * 2;
    if(now < this._superReadyAt) return;
    const type = me.def.superType;
    const seen = target && canSee && !target.isBase;
    const dist = target ? Math.hypot(target.x - me.x, target.z - me.z) : Infinity;
    const hurt = me.hp / Math.max(1, me.maxHp) < 0.5;
    let use = false, pick = null;
    if((type === 'airstrike' && seen && dist < 70) || (type === 'barrage' && seen && dist < 110)){
      /* Bombs land ~3 s later: aim where the target is heading. */
      let vx = 0, vz = 0;
      try { const v = target._physBody && target._physBody.linvel(); if(v){ vx = v.x; vz = v.z; } } catch(e){}
      const lead = (me.def.airstrikeDelay || 3) * 0.6;
      use = true; pick = { x: target.x + vx * lead, z: target.z + vz * lead };
    } else if(type === 'molotov' && seen && dist < 55){
      use = true; pick = { x: target.x, z: target.z };
    } else if(type === 'landfield' && seen && dist < 14){
      use = true; pick = { x: (me.x + target.x) / 2, z: (me.z + target.z) / 2 };
    } else if((type === 'cloak' || type === 'bush') && hurt && (seen || this._hitPanicTimer > 0)){
      use = true;
    } else if((type === 'panzers' || type === 'reload_boost') && seen && dist < 50){
      use = true;
    } else if(type === 'hunt' && seen && dist < 60){
      use = true;
    } else if(type === 'twin_salvo' && seen && dist < 50){
      use = true;
    } else if(type === 'nova' && seen && dist < 13){
      use = true;
    } else if(type === 'big_shells' && seen && dist < 45){
      use = true;
    } else if(type === 'mine_dash' && seen && dist < 40){
      use = true;
    } else if(type === 'oil' && seen && dist < 14){
      use = true;
    }
    if(!use) return;
    if(me.activateSuper()){
      if(me.superState === 'targeting' && pick) me._botSuperPick = pick;
      this._superReadyAt = undefined;
    }
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
    /* Each bot looks around on its own phase a few times a second. */
    if(!this._seenAt || now - this._seenAt > 0.3) this._sweep(me, game, now);
    return this._visible || null;
  }

  _sweep(me, game, now){
    this._seenAt = now;
    const visible = {};
    /* The same view the player gets: top-down all round, as far as this tank's
       fog radius, blocked by walls. Bots are not fooled by which way a hull faces
       and they do not see further than you do. */
    const RANGE = (me.viewRange || me.def.viewRange || 80) * ((CONFIG && CONFIG.FOG_VIEW_SCALE) || 0.875);
    let n = 0;
    const allies = [];
    for(const t of game.tanks){
      if(!t.alive || t === me) continue;
      if(me.team && t.team && me.team === t.team){ allies.push(t); continue; }
      if((me.allyId && t.id === me.allyId) || (t.allyId && t.allyId === me.id)){ allies.push(t); continue; }
      const dx = t.x - me.x, dz = t.z - me.z;
      const d = Math.hypot(dx, dz);
      if(d > RANGE || t.camoFactor <= 0) continue;
      if(!this._hasLOS(me, t, game, now)) continue;
      visible[t.id] = { t, x: t.x, z: t.z, at: now, dist: d };
      n++;
      this._seen = this._seen || {};
      this._seen[t.id] = { t, x: t.x, z: t.z, at: now };
    }
    this._allyPositions = allies;
    this._numVisibleEnemies = n;

    /* Being shot tells you where someone is, even if you can't see them yet. */
    const atk = me._lastAttacker;
    if(atk && atk.alive && now - (me._lastHitAt || -99) < 2 && !visible[atk.id] && !(me.team && atk.team === me.team)){
      this._seen = this._seen || {};
      this._seen[atk.id] = { t: atk, x: atk.x, z: atk.z, at: now };
    }
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

  /* Who to fight. Something in view beats a memory, and the current target is
     kept unless another is clearly better, so a bot does not thrash its turret. */
  _chooseTarget(me, game, order, now){
    const squad = me.team && game._botSquads ? game._botSquads[me.team] : null;
    const zones = (game._captureCircleMode && typeof CaptureCircle !== 'undefined' && CaptureCircle.getState())
      ? CaptureCircle.getState().zones : null;
    const zoneR = ((typeof GAMEMODES !== 'undefined' && GAMEMODES.captureTheCircle && GAMEMODES.captureTheCircle.circleRadius) || 12) + 4;
    let best = null, bestS = Infinity;
    if(this._visible){
      for(const id in this._visible){
        const v = this._visible[id];
        if(!v.t.alive) continue;
        let s = v.dist;
        const frac = v.t.maxHp ? v.t.hp / v.t.maxHp : 1;
        s -= (1 - frac) * 30;
        if(zones && zones.some(z => Math.hypot(v.t.x - z.cx, v.t.z - z.cz) < zoneR)) s -= 25;
        /* Shoot what the team is shooting; shoot back at what is shooting you. */
        if(squad && squad.focus === v.t) s -= 12 + this.person.team * 16;
        if(me._lastAttacker === v.t && now - (me._lastHitAt || -99) < 3) s -= 18;
        /* A defender cares most about whoever is at the base. */
        if(order && order.kind === 'defend' && order.rally && Math.hypot(v.t.x - order.rally.x, v.t.z - order.rally.z) < 45) s -= 30;
        if(this._curTarget === v.t) s -= 15;
        if(s < bestS){ bestS = s; best = v.t; }
      }
    }
    /* Attackers in position shell the base unless a tank is right on top of them.
       The base is what wins the match; a far-off tank is not worth stopping for. */
    if(order && order.siege && game._baseDefendMode && typeof BaseDefend !== 'undefined'){
      const bt = BaseDefend.botTargetFor(me.team);
      const close = best && Math.hypot(best.x - me.x, best.z - me.z) < 26;
      const range = Math.min(58, (me.def.shellRange || 60) * 0.85);
      if(bt && !close && Math.hypot(bt.x - me.x, bt.z - me.z) < range) return { target: { x: bt.x, z: bt.z, id: 'base-' + bt.team, isBase: true }, canSee: false };
    }
    if(best) return { target: best, canSee: true };

    let d = Infinity;
    if(this._seen){
      for(const id in this._seen){
        const s = this._seen[id];
        if(!s.t.alive) continue;
        const dd = Math.hypot(s.x - me.x, s.z - me.z);
        if(dd < d){ d = dd; best = s.t; }
      }
    }
    if(!best && this._heard){
      for(const id in this._heard){
        const h = this._heard[id];
        if(!h.t.alive) continue;
        const dd = Math.hypot(h.x - me.x, h.z - me.z);
        if(dd < d && dd < 70){ d = dd; best = h.t; }
      }
    }
    return { target: best, canSee: false };
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

      const steer = { turn, throttle };
      this._wallAvoid(me, steer, game);
      turn = steer.turn; throttle = steer.throttle;

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
    const aimPitch = target ? game._pitchToward(me, target.x, game._tankAimY(target), target.z).pitch : 0;
    return this._clamp({throttle, turn, turretWorldAngle: turretAngle, fire, aimPitch});
  }
}
