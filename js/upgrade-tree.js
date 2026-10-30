/* ============================================================
   upgrade-tree.js — TANK PROGRESSION 2.0
   Per-tank XP + manual level-ups (cash + upgrade points → +1
   tech point) + the two-path upgrade tree._money lives per tank
   so every tank in the collection progresses on its own curve.

   THE ECONOMY (from the design spec):
     1 damage dealt        =  1 XP   for the tank that dealt it
     1 kill                =  250 XP
     1 HP healed (allies)  =  2 XP
     1 minute battled      =  25 XP
     participate           =  10 XP  (so a 30-second scrape still counts)
     XP to next level      =  250 + 75 · level     (max level 25)
     level-up price        =  cash 100 + 50·level  AND  upgrade points 25 + 25·level
     each bought level     =  +1 tech point for that tank
     battle ends           =  upgrade points = XP earned ÷ 10, win = +1 golden
   Upgrade tree nodes cost TECH POINTS (25 over a maxed-out level curve,
   the tree is deliberately deep enough that you can't buy everything).

   window.Progression  — the system (currencies, xp, tree, stats)
   window.UpgradeTree  — compat shim: same names game.js and tank.js
                         already call (getRibbons, recordBattle).
   ============================================================ */

window.Progression = (function () {
  'use strict';

  var LS_KEY = 'tankparty_progression_v1';

  /* ---------------------------------------------------------- knobs */
  var KNOBS = {
    XP_PER_MIN: 25,
    XP_KILL: 250,
    XP_HEAL: 2,
    XP_PARTICIPATE: 10,
    MAX_LEVEL: 25,
    GUP_PER_WIN: 1,
    REGEN_DELAY: 8,         /* s without taking damage before regen starts */
    REGEN_BASE_PCT: 3,      /* % max HP per second once regen is unlocked  */
    ARMOR_PCT: 5,           /* Reinforced hull, % less damage taken        */
    LASTSTAND_PCT: 15,      /* Last stand, % more damage below 35% HP      */
    SCAVENGER_PCT: 20,      /* Scavenger, % max HP healed per kill         */
    OVERDRIVE_S: 2.5,       /* Overdrive, seconds of +30% speed per kill   */
    CRIT_PCT: 8,            /* Weak spot, % chance of a x1.75 hit          */
    LIFESTEAL_PCT: 5,       /* Leech rounds, % of damage dealt healed      */
    EXEC_PCT: 25,           /* Executioner, % more damage vs targets <30%  */
    SHELL_VEL_PCT: 12,      /* Shell velocity, % faster shells             */
    MAX_HP_BONUS: 7,        /* Health node         */
    MAX_DMG_BONUS: 3,       /* Damage node         */
    SPD_BONUS: 3,           /* Speed node, km/h    */
    RICO_BONUS: 4,          /* Ricochet angle, deg */
    REVERSE_BONUS: 3,       /* Reverse speed, km/h */
    TURN_MULT: 0.10,        /* Turning speed       */
    TURRET_MULT: 0.05,      /* Tower turning speed */
    SUPER_CUT: 1,           /* Super cool, seconds */
    CHARGE_MULT: 0.10,      /* Super charge rate   */
    PASSIVE_RATE: 0.01,     /* Passive super charge, fraction of cd / s */
    FIRE_CUT: 0.1,          /* Firerate, seconds   */
    SUPER_CD_FLOOR: 8,      /* never make the super spammable */
    RELOAD_FLOOR: 0.05,
    MAG_RELOAD_FLOOR: 0.3,
    PEN_CAP_PRC: 60,
  };

  /* ------------------------------------------ upgrade tree (the spec)--
   * A forking tree, drawn on a 6-lane grid (gx = lane, half steps between
   * lanes; gy = tier, 0 = start):
   *   3 starts      Health · Speed · Damage
   *   each forks    into two parallel upgrades (tier 1)
   *   merges        Reverse|Turning -> Regen time, Turret|Pen -> Super cool
   *   two lanes     climb in parallel (tiers 3-4)
   *   capstone      Fire rate needs BOTH lanes.
   *   outer lanes   combat perks: Reinforced hull -> Last stand -> Scavenger
   *                 (left), Shell velocity -> Weak spot -> Leech rounds ->
   *                 Executioner (right); Overdrive hangs off Turning.
   * Perk effects are applied in tank.js (takeDamage, _tickFieldRepairs,
   * the speed cap) and only on the local player's tank.
   * Node ids are the save keys -- never rename one.
   * Slot rows keep the three paths readable: each column stacks its
   * chain top-down.  `req` is a list; entries are satisfied if the named
   * node has AT LEAST that many levels bought.  When `orMode` is set the
   * list is an OR (Super cool accepts gadget-cool×2 OR ricochet×3);
   * otherwise every entry must be satisfied. `reserved` marks nodes whose
   * mechanic does not exist in the game yet — buyable, marked in the UI. */
  var TREE = {
    /* ---- HEALTH PATH (left column) ---- */
    health: {
      name: 'Health', col: 'health', row: 0, gx: 0.5, gy: 0,
      max: 3, cost: 1, desc: '+ 7 HP',
      req: [], per: { hp: 7 },
    },
    ricoshet: {
      name: 'Ricochet angle', col: 'health', row: 1, gx: 0, gy: 1,
      max: 3, cost: 2, desc: 'Increases ricochet angle by 4 degrees',
      req: [{ id: 'health', lvl: 2 }], per: { rico: 4 },
    },
    reverse: {
      name: 'Reverse speed', col: 'health', row: 2, gx: 1, gy: 1,
      max: 1, cost: 2, desc: '+ 3 km/h reverse speed',
      req: [{ id: 'health', lvl: 2 }], per: { reverse: 3 },
    },
    armor: {
      name: 'Reinforced hull', col: 'health', row: 3, gx: 0, gy: 2,
      max: 3, cost: 2, desc: 'Take 5% less damage',
      req: [{ id: 'ricoshet', lvl: 2 }], per: { armor: 5 },
    },
    laststand: {
      name: 'Last stand', col: 'health', row: 4, gx: 0, gy: 3,
      max: 2, cost: 2, desc: 'Below 35% HP: +15% damage',
      req: [{ id: 'armor', lvl: 2 }], per: { lastStand: 15 },
    },
    scavenger: {
      name: 'Scavenger', col: 'health', row: 5, gx: 0, gy: 4,
      max: 1, cost: 3, desc: 'Each kill repairs 20% HP',
      req: [{ id: 'laststand', lvl: 1 }], per: { scavenge: 20 },
    },

    /* ---- MOBILITY PATH (middle column) ---- */
    speed: {
      name: 'Speed', col: 'speed', row: 0, gx: 2.5, gy: 0,
      max: 5, cost: 1, desc: '+ 3 km/h speed',
      req: [], per: { speed: 3 },
    },
    turning: {
      name: 'Turning speed', col: 'speed', row: 1, gx: 2, gy: 1,
      max: 2, cost: 2, desc: 'Increases hull turning speed by 10%',
      req: [{ id: 'speed', lvl: 1 }], per: { turn: 10 },
    },
    towerturn: {
      name: 'Tower turning speed', col: 'speed', row: 2, gx: 3, gy: 1,
      max: 2, cost: 2, desc: 'Increases tower turning speed by 5%',
      req: [{ id: 'speed', lvl: 1 }], per: { turret: 5 },
    },
    regen: {
      name: 'Field repairs', col: 'speed', row: 3, gx: 1.5, gy: 2,
      max: 2, cost: 3, desc: 'Repair 3% HP/s after 8s out of fire (2nd level: 5.5s)',
      req: [{ id: 'reverse', lvl: 1 }, { id: 'turning', lvl: 2 }], orMode: true, per: { regenS: 2.5 },
    },
    overdrive: {
      name: 'Overdrive', col: 'speed', row: 3, gx: 2.5, gy: 2,
      max: 2, cost: 2, desc: 'Each kill: +30% speed for 2.5s',
      req: [{ id: 'turning', lvl: 1 }], per: { overdriveS: 2.5 },
    },
    towerturn2: {
      name: 'Tower turning speed 2', col: 'speed', row: 4, gx: 1.5, gy: 3,
      max: 2, cost: 2, desc: 'Increases tower turning speed by 5%',
      req: [{ id: 'regen', lvl: 2 }], per: { turret: 5 },
    },
    regenstr: {
      name: 'Regen strength', col: 'speed', row: 5, gx: 1.5, gy: 4,
      max: 1, cost: 1, desc: 'Field repairs heal +3% HP/s',
      req: [{ id: 'towerturn2', lvl: 2 }], per: { regenPct: 3 },
    },

    /* ---- DAMAGE PATH (right column) ---- */
    damage: {
      name: 'Damage', col: 'damage', row: 0, gx: 4.5, gy: 0,
      max: 3, cost: 1, desc: '+ 3 dmg',
      req: [], per: { dmg: 3 },
    },
    pen: {
      name: 'Penetration', col: 'damage', row: 1, gx: 4, gy: 1,
      max: 1, cost: 2, desc: '+ 1% penetration',
      req: [{ id: 'damage', lvl: 3 }], per: { pen: 1 },
    },
    /* id kept from the old "Gadget cool" node (it did nothing) so saves keep
       their levels; it is now a real upgrade. */
    gadgetcool: {
      name: 'Shell velocity', col: 'damage', row: 2, gx: 5, gy: 1,
      max: 2, cost: 2, desc: '+ 12% shell speed',
      req: [{ id: 'damage', lvl: 2 }], per: { shellVel: 12 },
    },
    critical: {
      name: 'Weak spot', col: 'damage', row: 3, gx: 5, gy: 2,
      max: 2, cost: 2, desc: '8% chance a hit deals x1.75',
      req: [{ id: 'gadgetcool', lvl: 1 }], per: { crit: 8 },
    },
    lifesteal: {
      name: 'Leech rounds', col: 'damage', row: 4, gx: 5, gy: 3,
      max: 2, cost: 3, desc: 'Heal 5% of the damage you deal',
      req: [{ id: 'critical', lvl: 1 }], per: { lifesteal: 5 },
    },
    executioner: {
      name: 'Executioner', col: 'damage', row: 5, gx: 5, gy: 4,
      max: 1, cost: 3, desc: '+25% damage to tanks under 30% HP',
      req: [{ id: 'lifesteal', lvl: 1 }], per: { exec: 25 },
    },
    supercool: {
      name: 'Super cool', col: 'damage', row: 3, gx: 3.5, gy: 2,
      max: 5, cost: 1, desc: 'Super needs 5 less damage to charge',
      /* towerturn×2 OR pen×1 — Mobility and Firepower merge here */
      req: [
        { id: 'towerturn', lvl: 2 },
        { id: 'pen', lvl: 1 },
      ], orMode: true, per: { superS: 1 },
    },
    supercharge: {
      name: 'Super charge rate', col: 'damage', row: 4, gx: 3.5, gy: 3,
      max: 2, cost: 3, desc: '+ 10% super charge rate',
      req: [{ id: 'supercool', lvl: 5 }], per: { chargeMult: 10 },
    },
    passive: {
      name: 'Passive super charge', col: 'damage', row: 5, gx: 3.5, gy: 4,
      max: 2, cost: 2, desc: 'Charges +1% super/s',
      req: [{ id: 'supercharge', lvl: 2 }], per: { passiveRate: 1 },
    },
    firerate: {
      name: 'Firerate', col: 'damage', row: 6, gx: 2.5, gy: 5,
      max: 1, cost: 1, desc: '- 0.1s fire cooldown',
      req: [{ id: 'regenstr', lvl: 1 }, { id: 'passive', lvl: 2 }], per: { fireS: 0.1 },
    },
  };

  var COLS = ['health', 'speed', 'damage'];
  var COL_TITLES = { health: 'SURVIVAL PATH', speed: 'MOBILITY PATH', damage: 'FIREPOWER PATH' };
  /* Level that finally UNLOCKS the third upgrade tier on the 🌳 radio. */
  var TABS = [
    /* ---- tree opens with the window itself (a level-0 tank has no tech
       points, so the tree is browsable but not buyable until you fight);
       the other radios keep the spec's level gates ---- */
    { id: 'tree', label: 'UPGRADE TREE', unlock: 0 },
    { id: 'super', label: 'SUPER', unlock: 5 },
    { id: 'gadgets', label: 'GADGETS', unlock: 10 },
    { id: 'gears', label: 'GEARS', unlock: 15 },
    { id: 'comingsoon', label: 'COMING SOON', unlock: 20 },
    { id: 'styles', label: 'STYLES', unlock: 25 },
  ];

  /* ------------------------------------------------- persistence */
  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
    } catch (e) { return {}; }
  }

  function saveState(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {}
    /* Mirror the currencies into the settings store so the profile screen,
       the auth cloud sync and any future top-bar chip all read one ball. */
    try {
      if (window.Menu && Menu.settings) {
        Menu.settings.tpUp = s.up || 0;
        Menu.settings.tpGup = s.gup || 0;
        if (typeof saveSettings === 'function') saveSettings(Menu.settings);
      }
    } catch (e) {}
  }

  function blank() { return { xp: 0, level: 0, tech: 0, nodes: {} }; }

  function tankState(tankId) {
    var s = loadState();
    s.tanks = s.tanks || {};
    if (!s.tanks[tankId]) s.tanks[tankId] = blank();
    if (typeof s.up !== 'number') s.up = 0;
    if (typeof s.gup !== 'number') s.gup = 0;
    return s;
  }

  /* ------------------------------------------------------- economy */
  function xpNeeded(level) {
    return Math.round(250 + 75 * level);          /* 250 + 75·L per spec */
  }

  function levelUpPrice(level) {
    return {
      cash: 100 + 50 * level,
      up: 25 + 25 * level,
    };
  }

  function xpProgress(tankId) {
    var t = tankState(tankId);
    var st = t.tanks[tankId];
    var need = xpNeeded(st.level);
    var bank = st.xp;
    return {
      level: st.level,
      tech: st.tech,
      bank: bank,
      need: need,
      pct: Math.max(0, Math.min(100, bank / need * 100)),
      price: levelUpPrice(st.level),
      canLevel: st.level < KNOBS.MAX_LEVEL &&
        bank >= need &&
        (t.up || 0) >= levelUpPrice(st.level).up &&
        (window.Menu && Menu.settings ? (Menu.settings.cash || 0) : 0) >= levelUpPrice(st.level).cash,
      maxed: st.level >= KNOBS.MAX_LEVEL,
      currencies: { up: t.up || 0, gup: t.gup || 0 },
    };
  }

  function buyLevel(tankId) {
    var t = tankState(tankId);
    var st = t.tanks[tankId];
    if (st.level >= KNOBS.MAX_LEVEL) return { ok: false, why: 'Max level' };
    var need = xpNeeded(st.level);
    if (st.xp < need) return { ok: false, why: 'Not enough tank XP' };
    var price = levelUpPrice(st.level);
    if ((t.up || 0) < price.up) return { ok: false, why: 'Not enough upgrade points' };
    var cash = window.Menu && Menu.settings ? (Menu.settings.cash || 0) : 0;
    if (cash < price.cash) return { ok: false, why: 'Not enough cash' };

    st.xp -= need;                 /* bank carries the surplus */
    st.level += 1;
    st.tech += 1;                  /* +1 tech point per level, per spec */
    t.up -= price.up;
    if (window.Menu && Menu.settings) Menu.settings.cash = cash - price.cash;
    saveState(t);
    if (window.Menu && Menu.toast) Menu.toast('Level ' + st.level + ' — +1 tech point');
    return { ok: true, level: st.level, tech: st.tech };
  }

  /* ------------------------------------------------- tree helpers */
  function nodeBought(tankId, id) {
    var t = tankState(tankId);
    var n = t.tanks[tankId].nodes[id];
    return n || 0;
  }

  function reqSatisfied(tankId, node) {
    if (!node.req || !node.req.length) return { ok: true };
    for (var i = 0; i < node.req.length; i++) {
      var r = node.req[i];
      var got = nodeBought(tankId, r.id) >= r.lvl;
      if (node.orMode && got) return { ok: true };
      if (!node.orMode && !got) {
        return { ok: false, text: TREE[r.id].name + ' ×' + r.lvl };
      }
    }
    return node.orMode
      ? { ok: false, text: node.req.map(function (r) { return TREE[r.id].name + ' ×' + r.lvl; }).join(' OR ') }
      : { ok: true };
  }

  function nodeState(tankId, id) {
    var node = TREE[id];
    var t = tankState(tankId);
    var st = t.tanks[tankId];
    var bought = st.nodes[id] || 0;
    var req = reqSatisfied(tankId, node);
    return {
      id: id, node: node, bought: bought, max: node.max,
      tech: st.tech,
      maxed: bought >= node.max,
      reqOk: req.ok, reqText: req.text || '',
      affordable: st.tech >= node.cost,
      canBuy: bought < node.max && req.ok && st.tech >= node.cost,
      reserved: !!node.reserved,
    };
  }

  function buyNode(tankId, id) {
    var ns = nodeState(tankId, id);
    if (ns.maxed) return { ok: false, why: 'Already maxed' };
    if (!ns.reqOk) return { ok: false, why: 'Requires ' + ns.reqText };
    if (!ns.affordable) return { ok: false, why: 'Not enough tech points' };
    var t = tankState(tankId);
    var st = t.tanks[tankId];
    st.tech -= ns.node.cost;
    st.nodes[id] = (st.nodes[id] || 0) + 1;
    saveState(t);
    if (window.Menu && Menu.toast) Menu.toast(ns.node.name + ' → level ' + st.nodes[id]);
    return { ok: true, newLevel: st.nodes[id], techLeft: st.tech };
  }

  /* --------------------------------------------- merged battle stats --
     One source of truth for every system that wants upgraded numbers:
     the 3D window stats table, tank.js spawn overrides, the projection
     ricochet pass.  Base tank stats in `base`, totals in `up`. */
  function tankStats(tankId) {
    var t = tankState(tankId);
    var st = t.tanks[tankId];
    var n = {};
    Object.keys(TREE).forEach(function (id) { n[id] = st.nodes[id] || 0; });

    var hpBonus = n.health * KNOBS.MAX_HP_BONUS;
    var dmgBonus = n.damage * KNOBS.MAX_DMG_BONUS;
    var speedBonus = n.speed * KNOBS.SPD_BONUS;
    var reverseKmh = n.reverse * KNOBS.REVERSE_BONUS;
    var ricoBonus = n.ricoshet * KNOBS.RICO_BONUS;
    var turnMult = 1 + KNOBS.TURN_MULT * n.turning;
    var turretMult = 1 + KNOBS.TURRET_MULT * (n.towerturn + n.towerturn2);
    var penPct = Math.min(KNOBS.PEN_CAP_PRC, n.pen);
    var superCoolS = n.supercool * KNOBS.SUPER_CUT;
    var chargeMult = 1 + KNOBS.CHARGE_MULT * n.supercharge;
    var passiveRate = KNOBS.PASSIVE_RATE * n.passive;   /* fraction of cd/s */
    var fireCdS = n.firerate * KNOBS.FIRE_CUT;
    /* Field repairs: unlocked by the first level, each level after it starts
       repairing 2.5s sooner; Regen strength adds to the heal rate. */
    var regenDelayS = n.regen > 0 ? KNOBS.REGEN_DELAY - 2.5 * (n.regen - 1) : 0;
    var regenPctS = n.regen > 0 ? KNOBS.REGEN_BASE_PCT + 3 * n.regenstr : 0;

    return {
      levels: n, hpBonus: hpBonus, dmgBonus: dmgBonus, speedBonus: speedBonus,
      reverseKmh: reverseKmh, ricoBonus: ricoBonus,
      turnMult: turnMult, turretMult: turretMult,
      penPct: penPct, superCoolS: superCoolS,
      chargeMult: chargeMult, passiveRate: passiveRate,
      fireCdS: fireCdS,
      regenDelayS: regenDelayS, regenPctS: regenPctS,
      armorPct: n.armor * KNOBS.ARMOR_PCT,
      lastStandPct: n.laststand * KNOBS.LASTSTAND_PCT,
      scavengePct: n.scavenger * KNOBS.SCAVENGER_PCT,
      overdriveS: n.overdrive * KNOBS.OVERDRIVE_S,
      critPct: n.critical * KNOBS.CRIT_PCT,
      lifestealPct: n.lifesteal * KNOBS.LIFESTEAL_PCT,
      execPct: n.executioner * KNOBS.EXEC_PCT,
      shellVelMult: 1 + n.gadgetcool * KNOBS.SHELL_VEL_PCT / 100,
      anyBought: Object.keys(n).some(function (k) { return n[k] > 0; }),
    };
  }

  /* REFUND: every node this tank bought is removed and the tech points spent
     on them come back, so the tree can be rebuilt a different way. Levels
     (and the upgrade points / cash paid for them) are kept. */
  function refundTree(tankId) {
    var t = tankState(tankId);
    var st = t.tanks[tankId];
    var back = 0;
    Object.keys(st.nodes || {}).forEach(function (id) {
      var node = TREE[id];
      back += (st.nodes[id] || 0) * (node ? node.cost : 0);
    });
    if (!back) return { ok: false, why: 'Nothing to refund' };
    st.nodes = {};
    st.tech += back;
    saveState(t);
    if (window.Menu && Menu.toast) Menu.toast('Refunded ' + back + ' tech points');
    return { ok: true, refunded: back, tech: st.tech };
  }

  /* Clone a tank definition with every bought upgrade baked in. Called
     from tank.js when the tank spawns, so the battle uses the real numbers.
     Reserved stats (gadgets/regen) ride along as future mechanics. */
  function defWithUpgrades(def) {
    if (!def || !def.id) return def;
    var s = tankStats(def.id);
    var vanilla = true;
    Object.keys(s.levels).forEach(function (k) { if (s.levels[k] > 0) vanilla = false; });
    if (vanilla) return def;   /* untouched tanks keep a shared def — zero risk */

    var d = Object.assign({}, def);
    d.hp = def.hp + s.hpBonus;
    d.damage = def.damage + s.dmgBonus;
    d.speed = def.speed + s.speedBonus;
    d.turn = (def.turn || 1.8) * s.turnMult;
    d.turretTurn = (def.turretTurn || 2.4) * s.turretMult;
    if (def.armor) d.armor = {
      front: def.armor.front + s.ricoBonus,
      sides: def.armor.sides + s.ricoBonus,
      back: def.armor.back + s.ricoBonus,
    };
    if (def.magSize) d.magReload = Math.max(KNOBS.MAG_RELOAD_FLOOR, (def.magReload || 3) - s.fireCdS);
    else d.reload = Math.max(KNOBS.RELOAD_FLOOR, (def.reload || 1) - s.fireCdS);
    if (def.shellSpeed && s.shellVelMult !== 1) d.shellSpeed = def.shellSpeed * s.shellVelMult;
    /* The rest ride on the tank instance (super cd, passive charge,
       penetration), because they read engine CONFIG times at spawn. */
    return d;
  }

  /* -------------------------------------------- battle XP book-keeping --
     Called once per battle end with the whole local tank stat sheet. */
  var lastAward = null;

  function recordBattle(o) {
    o = o || {};
    var tankId = o.tankId || (window.Menu && Menu.settings ? Menu.settings.selectedTank : null);
    if (!tankId) return null;
    var t = tankState(tankId);
    var st = t.tanks[tankId];
    var kills = o.kills || 0;
    var damage = Math.round(o.damage || 0);
    var heals = Math.round(o.heals || 0);
    var minutes = Math.max(0, Math.floor(o.minutes || 0));
    var won = !!o.won;

    var xp = damage * 1 + kills * KNOBS.XP_KILL + heals * KNOBS.XP_HEAL
      + minutes * KNOBS.XP_PER_MIN + KNOBS.XP_PARTICIPATE;
    st.xp += xp;

    /* UPGRADE POINTS ARE NOT PAID FOR FIGHTING ANY MORE. They come only from
       boxes (and the store's BANK trade). What a WIN pays is a box -- six per
       12-hour window, see grantWinBox() in config.js. */
    var gup = won ? KNOBS.GUP_PER_WIN : 0;
    t.gup = (t.gup || 0) + gup;
    saveState(t);

    var box = null;
    if (won && typeof grantWinBox === 'function') {
      try { box = grantWinBox(); } catch (e) { box = null; }
    }

    var leveled = st.xp >= xpNeeded(st.level) && st.level < KNOBS.MAX_LEVEL;
    lastAward = { tankId: tankId, xp: xp, up: 0, gup: gup, box: box, level: st.level, leveled: leveled, won: won };
    return lastAward;
  }

  function getLastAward() { return lastAward; }

  /* Upgrade points arrive from exactly two places: an opened box and the
     store's BANK trade. Both go through here. */
  function addUp(n) {
    n = Math.max(0, Math.round(n || 0));
    if (!n) return 0;
    var t = loadState();
    t.up = (t.up || 0) + n;
    saveState(t);
    return t.up;
  }

  function getUp() { return loadState().up || 0; }

  /* ------------------------------------------------ UpgradeTree shim --
     tank.js draws glow bands by ribbon count; game.js calls recordBattle
     with {won, kills, carry}.  Ribbons now key off tank levels so the
     old visual milestones keep firing on the new economy. */
  var RIBBON_LEVELS = [10, 18, 25];

  function getRibbons(tankId) {
    var st = tankState(tankId).tanks[tankId];
    var lvl = st ? (st.level || 0) : 0;
    var n = 0;
    RIBBON_LEVELS.forEach(function (l) { if (lvl >= l) n++; });
    return n;
  }

  window.UpgradeTree = {
    getXP: function (tankId) { return tankState(tankId).tanks[tankId].xp; },
    getRibbons: getRibbons,
    recordBattle: recordBattle,
    /* legacy fields the removed 10k-XP system exposed */
    getTotalXP: function () { return 0; },
    getMilestones: function () { return []; },
    showMenu: function () {},
    destroyMenu: function () {},
  };

  return {
    KNOBS: KNOBS, TREE: TREE, COLS: COLS, COL_TITLES: COL_TITLES, TABS: TABS,
    tankState: tankState,
    xpNeeded: xpNeeded, levelUpPrice: levelUpPrice, xpProgress: xpProgress,
    buyLevel: buyLevel,
    nodeState: nodeState, nodeBought: nodeBought, buyNode: buyNode, refundTree: refundTree,
    tankStats: tankStats, defWithUpgrades: defWithUpgrades,
    recordBattle: recordBattle, getLastAward: getLastAward,
    addUp: addUp, getUp: getUp,
    getRibbons: getRibbons,
    LS_KEY: LS_KEY,
  };
})();
