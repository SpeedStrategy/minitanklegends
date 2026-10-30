/* ============================================================
   tank-menu.js — Fullscreen tank detail menu
   3D viewer fills screen, UI overlays on top.
   Night lighting, grid floor, bold fonts, icons.
   ============================================================ */

window.TankMenu = (function(){

  var MECHANICS = {
    flamethrower: {
      name:'Flamethrower', icon:'🔥',
      desc:'Short-range continuous fire stream. Ignores armor and deals damage over time. Devastating in close quarters but useless at range.'
    },
    magazine: {
      name:'Magazine', icon:'🔁',
      desc:'Fires a burst of shells in quick succession, then reloads the full magazine. Timing your bursts is key.'
    },
    railgun: {
      name:'Railgun', icon:'⚡',
      desc:'Charged electromagnetic shot that pierces through armor and enemies. Slow fire rate but devastating penetration.'
    },
    healShells: {
      name:'Heal Shells', icon:'💚',
      desc:'Specialized rounds that repair allied tanks on impact. Support your team by keeping them in the fight.'
    },
    doubleBarrel: {
      name:'Double Barrel', icon:'🎯',
      desc:'Twin cannons fire alternating shots. Higher sustained damage output but requires careful aim to align both barrels.'
    },
    autocannon: {
      name:'Autocannon', icon:'💥',
      desc:'Rapid-fire rotary cannon. Shreds light targets with sheer volume of fire but struggles against heavy armor.'
    },
    heatMagazine: {
      name:'HEAT Magazine', icon:'💣',
      desc:'Explosive anti-tank rounds in a magazine. Each shell deals massive burst damage but magazine reload is punishing.'
    }
  };

  var TANK_MECHANICS = {
    coolbuddy: [],
    demolisher:['landmines'],
    predator:  ['burst','reload_boost'],
    grom:      ['splash_shells'],
    helix:     ['flamethrower'],
    striker:   ['railgun'],
    double:    ['doubleBarrel','landfield'],
    burst:     ['shotgun','knockback'],
    ghost:     ['autocannon'],
    sturmratte:['doubleBarrel','railgun']
  };

  var STAT_ICONS = {
    hp:'❤️', damage:'⚔️', speed:'💨', reload:'⏱️', magazine:'🔁',
    mass:'⚖️', viewRange:'👁️', shellSpeed:'🚀', armor:'🛡️'
  };

  /* Spray system data keys */
  const SPRAY_SETTINGS_KEY = 'tankparty_sprays';

  function loadSpraysData(){
    try{
      return JSON.parse(localStorage.getItem(SPRAY_SETTINGS_KEY) || '{}');
    }catch(e){ return {}; }
  }
  function saveSpraysData(data){
    localStorage.setItem(SPRAY_SETTINGS_KEY, JSON.stringify(data));
  }
  function getOwnedSprays(){
    var owned = (loadSpraysData().owned || []).slice();
    // The store keeps its own copy in tankparty_settings; merge it in so a
    // spray bought in the store shows up here (and vice-versa).
    try{
      if(typeof window.getOwnedSprays === 'function'){
        (window.getOwnedSprays() || []).forEach(function(id){
          if(!owned.includes(id)) owned.push(id);
        });
      }
    }catch(e){}
    return owned;
  }
  function addOwnedSpray(sprayId){
    var data = loadSpraysData();
    if(!data.owned) data.owned = [];
    if(!data.owned.includes(sprayId)) data.owned.push(sprayId);
    saveSpraysData(data);
    try{
      if(typeof window.addOwnedSpray === 'function') window.addOwnedSpray(sprayId);
    }catch(e){}
  }
  function getEquippedSprays(){
    return loadSpraysData().equipped || {};
  }
  /* Which tank (if any) is currently wearing this spray. */
  function getSprayOwner(sprayId){
    var eq = getEquippedSprays();
    var ids = Object.keys(eq);
    for(var i = 0; i < ids.length; i++){
      if(eq[ids[i]] === sprayId) return ids[i];
    }
    return null;
  }
  function setEquippedSpray(tankId, sprayId){
    var data = loadSpraysData();
    if(!data.equipped) data.equipped = {};
    if(sprayId){
      /* A spray lives on exactly one tank. If another tank is wearing it,
         leave that tank alone and don't take it here. */
      var owner = getSprayOwner(sprayId);
      if(owner && owner !== tankId) return;
      data.equipped[tankId] = sprayId;
    }else{
      delete data.equipped[tankId];
    }
    saveSpraysData(data);
  }
  function getEquippedSprayForTank(tankId){
    var equipped = getEquippedSprays();
    var id = equipped[tankId] || null;
    /* A spray only counts as equipped while you actually own it — you get
       sprays from the store, never for showing up. */
    if(id && getOwnedSprays().indexOf(id) === -1) return null;
    return id;
  }
  function getSprayPlacements(){
    return loadSpraysData().placements || {};
  }
  function setSprayPlacement(tankId, placement){
    var data = loadSpraysData();
    if(!data.placements) data.placements = {};
    if(placement){
      data.placements[tankId] = placement;
    }else{
      delete data.placements[tankId];
    }
    saveSpraysData(data);
  }
  function getSprayPlacement(tankId){
    var placements = getSprayPlacements();
    return placements[tankId] || null;
  }

  var _currentTank = null;
  var _scene = null, _camera = null, _renderer = null, _tankGroup = null;
  var _previewTank = null;   /* the real Tank the viewer is showing */
  var _viewerHost = null;
  var _tankReady = false;   /* tank geometry finished building (model loads async) */
  var _usingModel = false;  /* preview shows the real GLB instead of the box build */
  var _gunBox = null;       /* root-space box covering the gun */
  var _viewerToken = 0;     /* bumped by destroy() so a late model load bails out */
  var _loopId = null;
  var _dragging = false, _lastX = 0, _rotY = 0, _velX = 0;
  var _autoRotate = true, _autoTimer = null;
  var _zoom = 0; /* 0 = default, 1 = zoomed in (closer) */
  var _zoomTarget = 0;

  /* Spray placement state */
  var _placeMode = false;
  var _selectedSpray = null;
  var _sprayMarker = null;
  var _raycaster = new THREE.Raycaster();
  var _mouse = new THREE.Vector2();

  /* ============================================================
     PROGRESSION 2.x UI — the XP bar + level buy in the tank window,
     and the FULLSCREEN RESEARCH SCREEN opened by the UPGRADE button:
     dark-gray blueprint grid, fading top/bottom ribbons, horizontal
     card chains joined with arrows, small black outlines everywhere,
     white/gray base colors with amber reserved for buttons and
     special numbers. Per-tank state lives in window.Progression.
     ============================================================ */

  /* one source of truth for the XP/level block html */
  function xpBlockHtml(tankId){
    var prog = window.Progression ? Progression.xpProgress(tankId) : null;
    if(!prog) return '<div class="tm-xp-block" id="tm-xp-block"><div class="tm-xp-text">progression unavailable</div></div>';
    var why = '';
    if(!prog.canLevel && !prog.maxed){
      why = prog.bank < prog.need ? 'Need ' + (prog.need - prog.bank) + ' more XP from battles'
        : ((window.Menu && Menu.settings && Menu.settings.cash < prog.price.cash) ? 'Not enough cash'
        : 'Not enough upgrade points');
    }
    return '<div class="tm-xp-block' + (prog.canLevel ? ' ready' : '') + '" id="tm-xp-block">' +
      '<div class="tm-xp-head">' +
        '<span class="tm-lv-badge" id="tm-lv-badge">' + (prog.maxed ? 'MAX' : 'LV ' + prog.level) + '</span>' +
        '<span class="tm-cur-chip" title="Upgrade points"><img src="assets/rewards/upgradepoints.webp" alt=""><b id="tm-cur-up">' + fmtInt(prog.currencies.up) + '</b></span>' +
        '<span class="tm-cur-chip tm-gold" title="Golden upgrade points"><img src="assets/rewards/goldupgradepoints.webp" alt=""><b id="tm-cur-gup">' + fmtInt(prog.currencies.gup) + '</b></span>' +
      '</div>' +
      '<div class="tm-xp-track" title="' + prog.bank + ' / ' + prog.need + ' XP">' +
        '<div class="tm-xp-fill" id="tm-xp-fill" style="width:' + prog.pct.toFixed(1) + '%"><span class="tm-xp-text" id="tm-xp-text">' + prog.pct.toFixed(0) + '%</span></div>' +
      '</div>' +
      '<div class="tm-xp-foot" id="tm-xp-foot">' +
        '<span class="tm-xp-req" id="tm-xp-req">' + fmtInt(prog.bank) + ' / ' + fmtInt(prog.need) + ' XP</span>' +
        (prog.maxed
          ? '<span class="tm-xp-cost"><img src="assets/currency/cash.webp" alt=""> max level reached</span>'
          : '<span class="tm-xp-cost" title="Cost of the next level">' +
              '<img src="assets/currency/cash.webp" alt=""> ' + fmtInt(prog.price.cash) +
              '  <img src="assets/rewards/upgradepoints.webp" alt=""> ' + fmtInt(prog.price.up) + '</span>' +
            '<button class="tm-lvlup-btn' + (prog.canLevel ? ' ready' : '') + '" id="tm-lvlup" data-why="' + esc(why) + '"' + (prog.canLevel ? '' : ' disabled') + '>BUY LEVEL</button>') +
      '</div>' +
    '</div>';
  }

  function fmtInt(n){ return (window.Menu && Menu.fmtNum) ? Menu.fmtNum(n) : String(n|0); }
  function esc(v){ return String(v).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  /* --------------------------------- merged battle stat rows --
     The data behind the fresh stats panel: label + base + bought
     total + unit for every stat the progression can raise. */
  function statsRows(tankId){
    var def = TANKS[tankId];
    var st = window.Progression ? window.Progression.tankStats(tankId) : {};
    var L = st.levels || {};
    var rows = [];
    var add = function(group, label, baseVal, upVal, unit){
      rows.push({ g: group, label: label, base: baseVal, up: upVal, unit: unit || '' });
    };
    add('FIRING', 'Damage', def.damage, def.damage + st.dmgBonus);
    if(def.magSize){
      add('FIRING', 'Magazine', def.magSize, def.magSize);
      add('FIRING', 'Mag reload', def.magReload, Math.max((window.Progression && window.Progression.KNOBS.MAG_RELOAD_FLOOR) || 0.3, def.magReload - st.fireCdS), 's');
    } else {
      add('FIRING', 'Reload', def.reload, Math.max((window.Progression && window.Progression.KNOBS.RELOAD_FLOOR) || 0.05, def.reload - st.fireCdS), 's');
    }
    add('FIRING', 'Shell speed', def.shellSpeed, Math.round(def.shellSpeed * (st.shellVelMult || 1) * 10) / 10);
    add('FIRING', 'Range', def.shellRange, def.shellRange, 'm');
    add('MOBILITY', 'Speed', def.speed, def.speed + st.speedBonus, 'km/h');
    var revFrac = (CONFIG && CONFIG.REVERSE_SPEED_PENALTY) ? 1 / CONFIG.REVERSE_SPEED_PENALTY : 0.6667;
    var revBase = Math.round(def.speed * revFrac * 10) / 10;
    var revUp = Math.round((def.speed + st.speedBonus) * (revFrac + st.reverseKmh / Math.max(6, def.speed)) * 10) / 10;
    add('MOBILITY', 'Reverse speed', revBase, revUp, 'km/h');
    add('MOBILITY', 'Hull turn', def.turn, (def.turn * st.turnMult), '°/s');
    add('MOBILITY', 'Turret turn', def.turretTurn, def.turretTurn * st.turretMult, '°/s');
    add('MOBILITY', 'Acceleration', def.accel, def.accel);
    add('SURVIVABILITY', 'HP', def.hp, def.hp + st.hpBonus);
    add('SURVIVABILITY', 'View range', def.viewRange, def.viewRange, 'm');
    if(def.armor){
      add('SURVIVABILITY', 'Ricochet front', def.armor.front, def.armor.front + st.ricoBonus, '°');
      add('SURVIVABILITY', 'Ricochet side', def.armor.sides, def.armor.sides + st.ricoBonus, '°');
      add('SURVIVABILITY', 'Ricochet back', def.armor.back, def.armor.back + st.ricoBonus, '°');
    }
    var baseCD = (CONFIG && CONFIG.SUPER_COOLDOWN) || 60;
    var chargeDmg = (CONFIG && CONFIG.SUPER_CHARGE_DAMAGE) || 300;
    add('SYSTEMS', 'Super charge', chargeDmg, Math.round(chargeDmg * Math.max((window.Progression && Progression.KNOBS.SUPER_CD_FLOOR) || 8, baseCD - st.superCoolS) / baseCD), ' dmg');
    add('SYSTEMS', 'Super charge rate', 1, st.chargeMult, '×');
    add('SYSTEMS', 'Passive super charge', 0, Math.round(st.passiveRate * 1000) / 10, '% of bar /s');
    add('SYSTEMS', 'Penetration', 0, st.penPct, '% (vs ricochet angle)');
    /* Combat perks: only listed once bought, so a fresh tank's panel stays short. */
    if(st.regenPctS) add('PERKS', 'Field repairs', 0, st.regenPctS, '% HP/s after ' + st.regenDelayS + 's');
    if(st.armorPct) add('PERKS', 'Damage taken', 0, -st.armorPct, '%');
    if(st.lastStandPct) add('PERKS', 'Last stand', 0, st.lastStandPct, '% dmg <35% HP');
    if(st.scavengePct) add('PERKS', 'Scavenger', 0, st.scavengePct, '% HP per kill');
    if(st.overdriveS) add('PERKS', 'Overdrive', 0, st.overdriveS, 's +30% speed per kill');
    if(st.critPct) add('PERKS', 'Weak spot', 0, st.critPct, '% x1.75 hits');
    if(st.lifestealPct) add('PERKS', 'Leech rounds', 0, st.lifestealPct, '% of damage healed');
    if(st.execPct) add('PERKS', 'Executioner', 0, st.execPct, '% dmg vs <30% HP');
    return rows;
  }

  /* ------------------------------------------------- fresh stats table --
     The right-side stats panel now reads the MERGED (bought) numbers:
     research shows up directly in the garage, e.g. "max speed 24 km/h +3".
     Same class names as before, so the old CSS keeps working. */
  var STAT_TIPS = {
    'Damage': 'Damage dealt per shot to enemy tanks. Tree: +3 per Damage level.',
    'Magazine': 'Number of shells fired before reloading the full magazine.',
    'Mag reload': 'Time to reload the whole magazine. Tree: −0.1s per Firerate.',
    'Reload': 'Time between shots. Faster reload = more sustained damage. Tree: −0.1s per Firerate.',
    'Shell speed': 'Velocity of fired shells. Higher = easier to hit moving targets.',
    'Range': 'Maximum distance shells travel before disappearing.',
    'Max speed': 'Maximum forward movement speed. Tree: +3 km/h per Speed level.',
    'Reverse speed': 'Speed while driving backwards. Tree: +3 km/h per Reverse level.',
    'Hull turn': 'How fast the tank body rotates. Tree: +10% per Turning level.',
    'Turret turn': 'How fast the turret tracks targets. Tree: +5% per Turret turning level.',
    'Acceleration': 'How quickly the tank reaches top speed. Higher = snappier handling.',
    'Mass': 'Tank weight. Heavier = harder to push, more stable but slower.',
    'HP': 'Hit points — how much damage you can take before destruction. Tree: +7 per Health level.',
    'View range': 'How far you can spot enemies. Higher = earlier detection.',
    'Ricochet front': 'Ricochet angle vs frontal hits — arriving shells wider than this bounce off. Tree: +4° per Ricochet armor level.',
    'Ricochet side': 'Ricochet angle vs side hits. Tree: +4° per Ricochet armor level.',
    'Ricochet back': 'Ricochet angle vs rear hits. Tree: +4° per Ricochet armor level.',
    'Super cooldown': 'Seconds between super abilities. Tree Super cool: −1s per level (floor 8s).',
    'Super charge rate': 'How fast the super bar fills. Tree Super charge: ×1.10 per level.',
    'Passive super charge': 'The super bar fills on its own once Passive charge is researched.',
    'Penetration': 'Your shells shrink the enemy ricochet window when they hit.',
    'Gadget cooldown': 'HOLD: unused yet — the gadget mechanic arrives in a later update.',
    'Regen wait': 'HOLD: unused yet — the regen mechanic arrives in a later update.',
    'Regen strength': 'HOLD: unused yet — the regen mechanic arrives in a later update.',
  };

  function statsPanelHtml(tankId){
    if(!window.Progression) return '';
    var rows = statsRows(tankId);
    var order = ['FIRING', 'MOBILITY', 'SURVIVABILITY', 'SYSTEMS', 'PERKS'];
    var icons = { 'FIRING': '🎯', 'MOBILITY': '💨', 'SURVIVABILITY': '🛡️', 'SYSTEMS': '⚡', 'PERKS': '🧪' };
    var html = '<div class="tm-panel tm-stats-panel tm-fresh">';
    order.forEach(function(g){
      var got = rows.filter(function(r){
        return r.g === g && !(r.base === 0 && r.up === 0);
      });
      if(g === 'SYSTEMS'){
        got = got.filter(function(r){ return !(r.label === 'Super charge rate' && Math.abs(r.up - 1) < 0.001); });
      }
      if(!got.length) return;
      html += '<div class="tm-stats-section">' +
        '<div class="tm-section-title"><span class="tm-section-icon">' + icons[g] + '</span> ' + g + '</div>';
      got.forEach(function(r){
        var label = r.label === 'Speed' ? 'Max speed' : r.label;
        var upV = Math.round(r.up * 100) / 100;
        var delta = '';
        if(typeof r.base === 'number' && Math.abs(r.up - r.base) > 0.001){
          var d = Math.round((r.up - r.base) * 100) / 100;
          delta = '<span class="tm-stat-delta">' + (d > 0 ? '+' : '−') + Math.abs(d) + '</span>';
        }
        html += '<div class="tm-stat-row">' +
          '<span class="tm-stat-label">' + label + '</span>' +
          '<span class="tm-stat-val">' + upV + (r.unit ? '<i class="tm-stat-unit">' + r.unit + '</i>' : '') + delta + '</span>' +
          '<div class="tm-tooltip">' + (STAT_TIPS[label] || STAT_TIPS[r.label] || '') + '</div></div>';
      });
      html += '</div>';
    });
    return html + '</div>';
  }

  /* ------------------------------------------- FULLSCREEN RESEARCH SCREEN --
     Opens from the UPGRADE button: blueprint grid, three horizontal
     upgrade paths joined with arrows, ribbons fading at both ends. */

  var SUPER_UNLOCK_LVL = 5;   /* was the SUPER radio tab gate */
  var SUPER_NAMES = { big_shells: 'Big shells', mine_dash: 'Mine dash', airstrike: 'Airstrike', molotov: 'Molotov', bush: 'Camouflage bush', cloak: 'Cloak', panzers: 'Panzer drop', reload_boost: 'Rapid reload', landfield: 'Minefield' };

  function superChipHtml(tankId){
    var prog = window.Progression.xpProgress(tankId);
    if(prog.level < SUPER_UNLOCK_LVL){
      return '<div class="tr-super locked" title="Earn XP, buy tank levels — the super table lives here from level 5">⚡ SUPER — UNLOCKS AT TANK LEVEL 5</div>';
    }
    var def = TANKS[tankId];
    var st = Progression.tankStats(tankId);
    var baseCD = (CONFIG && CONFIG.SUPER_COOLDOWN) || 60;
    var effCd = Math.max(Progression.KNOBS.SUPER_CD_FLOOR, baseCD - st.superCoolS);
    var name = (typeof SUPER_INFO !== 'undefined' && SUPER_INFO[def.superType] && SUPER_INFO[def.superType].name) || SUPER_NAMES[def.superType] || 'Super';
    return '<div class="tr-super open" title="Live in battle right now">' +
      '⚡ ' + name.toUpperCase() + ' · charged by <b>' + Math.round(((CONFIG && CONFIG.SUPER_CHARGE_DAMAGE) || 300) * effCd / baseCD) + '</b> damage' +
      (st.chargeMult > 1 ? ' · ×' + st.chargeMult.toFixed(2) + ' charge' : '') +
      '</div>';
  }

  function trNodeHtml(st){
    var node = st.node;
    var cls = 'tp-node' +
      (st.maxed ? ' maxed' : '') +
      (st.canBuy ? ' canbuy' : '') +
      (!st.reqOk ? ' locked' : '') +
      (st.bought > 0 ? ' owned' : '') +
      (st.reserved ? ' reserved' : '');
    var reqHtml = (st.reqOk || !st.reqText) ? '' : '<span class="tp-req">🔒 ' + esc(st.reqText) + '</span>';
    var resHtml = st.reserved ? '<span class="tp-res">HOLD: UNUSED YET</span>' : '';
    return '<div class="' + cls + '" data-node="' + st.id + '">' +
      (st.maxed ? '<span class="tp-corner" aria-hidden="true">MAX</span>' : '') +
      '<div class="tp-node-head"><span class="tp-node-name">' + node.name + '</span>' +
        '<span class="tp-node-lvl">' + st.bought + '/' + st.max + '</span></div>' +
      '<div class="tp-node-desc">' + node.desc + '</div>' +
      '<div class="tp-node-foot">' + reqHtml + resHtml +
        (st.maxed ? '' : '<button class="tp-buy" data-node="' + st.id + '"' + (st.canBuy ? '' : ' disabled') + '>BUY · ' + node.cost + ' ⚙</button>') +
      '</div>' +
    '</div>';
  }

  /* THE TREE AS A GRAPH. Each node carries a grid slot (gx lane, gy tier) in
     upgrade-tree.js; cards are placed on that grid and the requirement links
     are drawn underneath as curves, so a fork reads as one card feeding two
     and a merge as two feeding one. Links are measured from the real cards
     after they are in the DOM (drawTreeLinks), so a taller card can never
     leave a line pointing at empty space. */
  var TG = { LANE: 196, TIER: 214, CARD: 176, PADX: 16, PADY: 38 };

  function treeGraphHtml(tankId){
    var T = Progression.TREE, maxX = 0, maxY = 0, cards = '';
    Object.keys(T).forEach(function(id){
      var n = T[id];
      if(n.gx == null) return;
      maxX = Math.max(maxX, n.gx); maxY = Math.max(maxY, n.gy);
      var st = Progression.nodeState(tankId, id);
      var merge = (n.req && n.req.length > 1)
        ? '<span class="tr-merge">' + (n.orMode ? 'ANY PATH' : 'BOTH PATHS') + '</span>' : '';
      cards += '<div class="tr-slot" style="left:' + (TG.PADX + n.gx * TG.LANE) + 'px;top:' + (TG.PADY + n.gy * TG.TIER) + 'px">' +
        merge + trNodeHtml(st) + '</div>';
    });
    var tags = '';
    Progression.COLS.forEach(function(col){
      var root = Object.keys(T).filter(function(id){ return T[id].col === col && T[id].gy === 0; })[0];
      if(!root) return;
      tags += '<div class="tr-lane-tag" style="left:' + (TG.PADX + T[root].gx * TG.LANE) + 'px">' + Progression.COL_TITLES[col] + '</div>';
    });
    var w = TG.PADX * 2 + maxX * TG.LANE + TG.CARD;
    var h = TG.PADY + maxY * TG.TIER + TG.TIER;
    return '<div class="tr-graph" style="width:' + w + 'px;height:' + h + 'px">' +
      '<svg class="tr-links" width="' + w + '" height="' + h + '" aria-hidden="true"></svg>' +
      tags + cards + '</div>';
  }

  function drawTreeLinks(scr, tankId){
    var graph = scr.querySelector('.tr-graph');
    var svg = graph && graph.querySelector('.tr-links');
    if(!svg) return;
    var T = Progression.TREE, out = '';
    var box = function(id){
      var el = graph.querySelector('.tp-node[data-node="' + id + '"]');
      var slot = el && el.parentNode;
      if(!el || !slot) return null;
      return { x: slot.offsetLeft + el.offsetLeft + el.offsetWidth / 2,
               top: slot.offsetTop + el.offsetTop,
               bottom: slot.offsetTop + el.offsetTop + el.offsetHeight };
    };
    Object.keys(T).forEach(function(id){
      var n = T[id];
      (n.req || []).forEach(function(r){
        var a = box(r.id), b = box(id);
        if(!a || !b) return;
        var on = Progression.nodeBought(tankId, r.id) >= r.lvl;
        var y1 = a.bottom + 2, y2 = b.top - 4, dy = Math.max(24, (y2 - y1) * 0.5);
        out += '<path class="tr-link' + (on ? ' on' : '') + '" d="M' + a.x + ' ' + y1 +
          ' C' + a.x + ' ' + (y1 + dy) + ' ' + b.x + ' ' + (y2 - dy) + ' ' + b.x + ' ' + y2 + '"/>';
        out += '<circle class="tr-link-end' + (on ? ' on' : '') + '" cx="' + b.x + '" cy="' + y2 + '" r="4"/>';
      });
    });
    svg.innerHTML = out;
  }

  /* Tech points currently spent in this tank's tree (what REFUND gives back). */
  function refundableTech(tankId){
    var T = Progression.TREE, n = 0;
    Object.keys(T).forEach(function(id){ n += Progression.nodeBought(tankId, id) * T[id].cost; });
    return n;
  }

  function researchHtml(tankId){
    var def = TANKS[tankId];
    var prog = Progression.xpProgress(tankId);
    var rows = treeGraphHtml(tankId);
    return '<div class="tm-research" id="tm-research">' +
      '<div class="tr-ribbon" aria-hidden="true"></div><div class="tr-ribbon soft" aria-hidden="true"></div>' +
      '<div class="tr-head">' +
        '<button class="tr-back" id="tr-back">◀ BACK</button>' +
        '<div class="tr-titlewrap">' +
          '<div class="tr-title">UPGRADE RESEARCH</div>' +
          '<div class="tr-sub">' + (def ? def.name.toUpperCase() : '') + ' · PER-TANK PROGRESSION</div>' +
        '</div>' +
        '<div class="tr-meta">' +
          '<div class="tr-chips">' +
            '<span class="tr-chip">TANK LEVEL<b>' + prog.level + '</b></span>' +
            '<span class="tr-chip" title="One per bought level — spends on tree nodes">TECH PTS<b>' + prog.tech + '</b></span>' +
            '<button class="tr-back tr-refund" id="tr-refund" title="Remove every bought upgrade on this tank and get all its tech points back"' +
              (refundableTech(tankId) ? '' : ' disabled') + '>↺ REFUND ' + refundableTech(tankId) + ' ⚙</button>' +
            '<span class="tr-chip" title="Upgrade points — from boxes and the store BANK"><img src="assets/rewards/upgradepoints.webp" alt="">UP<b>' + fmtInt(prog.currencies.up) + '</b></span>' +
            '<span class="tr-chip" title="Golden upgrade points — one per battle win"><img src="assets/rewards/goldupgradepoints.webp" alt="">GUP<b>' + fmtInt(prog.currencies.gup) + '</b></span>' +
          '</div>' +
          superChipHtml(tankId) +
        '</div>' +
      '</div>' +
      '<div class="tr-rows">' + rows + '</div>' +
      '<div class="tr-foot">' +
        '<span>1 DMG = 1 XP</span><span>KILL = 250 XP</span><span>HEAL = 2 XP</span>' +
        '<span>MINUTE = ' + (Progression.KNOBS.XP_PER_MIN || 25) + ' XP</span>' +
        '<span class="tf-amber">LEVEL UP = +1 TECH POINT</span>' +
      '</div>' +
      '<div class="tr-ribbon soft" aria-hidden="true"></div><div class="tr-ribbon" aria-hidden="true"></div>' +
    '</div>';
  }

  function openResearch(tankId){
    if(!window.Progression) return;
    var wrap = document.getElementById('menu-tank');
    if(!wrap) return;
    var old = document.getElementById('tm-research');
    var keepScroll = 0;
    if(old){ keepScroll = old.querySelector('.tr-rows').scrollTop; old.remove(); }
    wrap.insertAdjacentHTML('beforeend', researchHtml(tankId));
    var scr = document.getElementById('tm-research');
    drawTreeLinks(scr, tankId);
    /* reveal twice-guarded: rAF animates when the tab is visible, the
       timeout guarantees the screen opens even in a background tab */
    var reveal = function(){
      if(scr.classList.contains('open')) return;
      scr.classList.add('open');
      drawTreeLinks(scr, tankId);
      var rowsEl = scr.querySelector('.tr-rows');
      if(rowsEl && keepScroll) rowsEl.scrollTop = keepScroll;
    };
    requestAnimationFrame(reveal);
    setTimeout(reveal, 60);
    var back = document.getElementById('tr-back');
    if(back) back.onclick = closeResearch;
    /* REFUND asks twice: the first tap arms it for 3 s, the second refunds. */
    var refund = document.getElementById('tr-refund');
    if(refund) refund.onclick = function(){
      if(!refund.classList.contains('armed')){
        refund.classList.add('armed');
        refund.textContent = 'TAP AGAIN TO REFUND';
        setTimeout(function(){
          if(!refund.isConnected || !refund.classList.contains('armed')) return;
          refund.classList.remove('armed');
          refund.textContent = '↺ REFUND ' + refundableTech(tankId) + ' ⚙';
        }, 3000);
        return;
      }
      refund.classList.remove('armed');
      var r = Progression.refundTree(tankId);
      if(r.ok){ openResearch(tankId); refreshTankProgUI(tankId); refreshStatsPanel(tankId); }
      else if(window.Menu) Menu.toast(r.why || 'Nothing to refund');
    };
    scr.querySelectorAll('.tp-buy').forEach(function(btn){
      btn.onclick = function(){
        var r = Progression.buyNode(tankId, btn.dataset.node);
        if(r.ok){ openResearch(tankId); refreshTankProgUI(tankId); refreshStatsPanel(tankId); }
        else if(window.Menu) Menu.toast(r.why || 'Cannot buy');
      };
    });
  }

  function closeResearch(){
    var scr = document.getElementById('tm-research');
    if(!scr) return;
    scr.classList.remove('open');
    scr.classList.add('closing');
    setTimeout(function(){ if(scr.parentNode) scr.parentNode.removeChild(scr); }, 260);
  }

  /* buy a tank level from the xp card (and refresh everything that shows tech) */
  function doLevelUp(tankId){
    var r = Progression.buyLevel(tankId);
    if(r.ok){
      refreshTankProgUI(tankId);
      if(document.getElementById('tm-research')) openResearch(tankId);
    }
    else if(window.Menu) Menu.toast(r.why || 'Cannot level up');
  }

  /* The garage stats panel behind the research screen, redrawn after a buy or
     a refund so it never shows the tree as it was before. */
  function refreshStatsPanel(tankId){
    var old = document.querySelector('#menu-tank .tm-stats-panel');
    if(old) old.outerHTML = statsPanelHtml(tankId);
  }

  function refreshTankProgUI(tankId){
    var block = document.querySelector('.tm-xp-col');
    if(!block) return;
    block.innerHTML = xpBlockHtml(tankId);
    var lvl = document.getElementById('tm-lvlup');
    if(lvl) lvl.onclick = function(){ doLevelUp(tankId); };
  }

  function getMechanics(tankId){
    var list = (TANK_MECHANICS[tankId] || []).map(function(k){ return MECHANICS[k]; }).filter(Boolean);
    var sup = TANKS[tankId] && typeof SUPER_INFO !== 'undefined' && SUPER_INFO[TANKS[tankId].superType];
    if(sup) list.unshift({ name:'Super: ' + sup.name, icon:sup.icon, desc:sup.desc });
    return list;
  }

  function show(tankId){
    var def = TANKS[tankId];
    if(!def) return;
    _currentTank = tankId;

    var wrap = document.getElementById('menu-tank');
    if(!wrap) return;

    var mechanics = getMechanics(tankId);
    var mechHtml = '';
    if(mechanics.length){
      mechHtml = '<div class="tm-mechanic-cards">';
      mechanics.forEach(function(m){
        mechHtml += '<div class="tm-mech-card">' +
          '<div class="tm-mech-head"><span class="tm-mech-icon">' + m.icon + '</span><span class="tm-mech-name">' + m.name + '</span></div>' +
          '<div class="tm-mech-desc">' + m.desc + '</div>' +
        '</div>';
      });
      mechHtml += '</div>';
    } else {
      mechHtml = '<div class="tm-mech-card tm-mech-empty">' +
        '<div class="tm-mech-head"><span class="tm-mech-icon">⚙️</span><span class="tm-mech-name">Standard</span></div>' +
        '<div class="tm-mech-desc">Standard firing system.</div></div>';
    }

    wrap.innerHTML =
      /* 3D viewer fills entire screen */
      '<div class="tm-viewer" id="tm-viewer">' +
        '<div class="tm-viewer-loading" id="tm-viewer-loading">Loading...</div>' +
      '</div>' +

      /* UI overlay — top left: back + name */
      '<div class="tm-overlay-top-left">' +
        '<div class="tm-back" id="tm-back" tabindex="0" role="button">' +
          '<span class="tm-icon">◀</span> BACK' +
        '</div>' +
        '<h2 class="tm-tank-name">' + def.name + '</h2>' +
        '<p class="tm-tank-desc">' + (def.desc || '') + '</p>' +
      '</div>' +

      /* UI overlay — right panel */
      '<div class="tm-overlay-right">' +

        /* Mechanic card */
        '<div class="tm-panel tm-mech-panel">' +
          '<div class="tm-panel-header"><span class="tm-icon">🔧</span> MECHANICS</div>' +
          mechHtml +
        '</div>' +

        /* Stats — the fresh merged table (units + amber deltas) */
        statsPanelHtml(tankId) +

      '</div>' +

      /* UI overlay — bottom: progression columns + cosmetics */
      '<div class="tm-overlay-bottom">' +
        '<div class="tm-bottom-actions">' +
          '<div class="tm-left-col">' +
            '<button class="tm-btn tm-btn-upgrade" id="tm-upgrade"><span class="tm-icon">⬆</span> UPGRADE</button>' +
            '<button class="tm-btn tm-btn-select" id="tm-select"><span class="tm-icon">✔</span> SELECT TANK</button>' +
          '</div>' +
          '<div class="tm-xp-col" id="tm-xp-col">' +
            xpBlockHtml(tankId) +
          '</div>' +
        '</div>' +
        '<div class="tm-cosmetics-bar">' +
          /* Action buttons live ABOVE the tab row so they never sit under the
             panel content — see renderSprayActions(). */
          '<div class="tm-spray-actions" id="tm-spray-actions"></div>' +
          '<div class="tm-cosmo-tabs">' +
            '<button class="tm-cosmo-tab active" data-cosmo="sprays"><span class="tm-icon">🏷️</span> Sprays</button>' +
            '<button class="tm-cosmo-tab" data-cosmo="paint"><span class="tm-icon">🎨</span> Paint</button>' +
            '<button class="tm-cosmo-tab" data-cosmo="style"><span class="tm-icon">✨</span> Style</button>' +
          '</div>' +
          '<div class="tm-cosmo-body" id="tm-cosmo-body"><div class="tm-cosmo-placeholder">Coming soon</div></div>' +
        '</div>' +
      '</div>';

    /* Wire events */
    document.getElementById('tm-back').onclick = function(){
      destroy();
      if(window.Menu) Menu.show('menu-collections');
    };
    document.getElementById('tm-select').onclick = function(){
      if(window.Menu){
        Menu.settings.selectedTank = tankId;
        if(window.saveSettings) saveSettings(Menu.settings);
        destroy();
        Menu.show('menu-main');
        Menu.toast('Selected: ' + def.name);
      }
    };
    document.getElementById('tm-upgrade').onclick = function(){
      openResearch(tankId);
    };
    var lvlBtn = document.getElementById('tm-lvlup');
    if(lvlBtn) lvlBtn.onclick = function(){ doLevelUp(tankId); };

    wrap.querySelectorAll('.tm-cosmo-tab').forEach(function(tab){
      tab.onclick = function(){
        wrap.querySelectorAll('.tm-cosmo-tab').forEach(function(t){ t.classList.remove('active'); });
        tab.classList.add('active');
        var body = document.getElementById('tm-cosmo-body');
        var cosmoType = tab.dataset.cosmo;
        var actionBar = document.getElementById('tm-spray-actions');
        if(cosmoType === 'sprays'){
          renderSpraysTab(body);
        }else if(cosmoType === 'style'){
          /* The stamp buttons belong to the Sprays tab only. */
          if(actionBar) actionBar.innerHTML = '';
          renderStylesTab(body);
        }else{
          /* The stamp buttons belong to the Sprays tab only. */
          if(actionBar) actionBar.innerHTML = '';
          if(body) body.innerHTML = '<div class="tm-cosmo-placeholder">' +
            'Paint customization coming soon</div>';
        }
      };
    });

    /* Initial tab render (sprays is active by default) */
    var activeTab = wrap.querySelector('.tm-cosmo-tab.active');
    if(activeTab && activeTab.dataset.cosmo === 'sprays'){
      var body = document.getElementById('tm-cosmo-body');
      renderSpraysTab(body);
    }

    /* Build the viewer straight away. Waiting for a frame meant the preview
       never appeared while the tab was in the background (rAF doesn't run). */
    initViewer(def);
    loadSprayTextures();
  }

  /* ============================================================
     STYLES — one texture mapped over the whole tank
     ============================================================ */

  function renderStylesTab(body){
    if(!body) return;
    var tankId = _currentTank;
    if(!window.TankStyles){
      body.innerHTML = '<div class="tm-cosmo-placeholder">Styles unavailable</div>';
      return;
    }
    TankStyles.setPreviewTank(tankId);

    var equipped = TankStyles.equippedForTank(tankId);
    var defs = TankStyles.DEFS;
    var list = TankStyles.LIST;

    var html = '<div class="tm-styles-container">';
    html += '<div class="tm-sprays-section">';
    html += '<div class="tm-sprays-section-title">🎨 Tank Styles</div>';
    html += '<div class="tm-style-hint">One paint texture over the whole tank. A style lives on one tank at a time — the store sells all three.</div>';
    html += '<div class="tm-styles-grid">';

    var shown = 0;
    list.forEach(function(key){
      var def = defs[key];
      if(!def) return;
      var owned = TankStyles.ownsStyle(key);
      var isEquipped = equipped === key;
      var owner = TankStyles.ownerOfStyle(key);
      var wornElsewhere = owner && owner !== tankId;
      shown++;

      html += '<div class="tm-style-card' + (owned ? ' owned' : '') + (isEquipped ? ' equipped' : '') + '">';
      html += '<div class="tm-style-preview" style="background-image:url(' + def.texture + ')"></div>';
      html += '<div class="tm-style-info">';
      html += '<span class="tm-style-name">' + def.name + '</span>';
      html += '<span class="tm-style-desc">' + def.desc + '</span>';
      if(isEquipped){
        html += '<button class="tm-style-btn tm-style-unequip" data-style="' + key + '">↩ Remove Style</button>';
      }else if(owned && !wornElsewhere){
        html += '<button class="tm-style-btn tm-style-equip" data-style="' + key + '">✨ Equip</button>';
      }else if(owned && wornElsewhere){
        html += '<span class="tm-style-note">🔄 On another tank</span>';
      }else{
        html += '<span class="tm-style-note">🛍️ Buy in the store — ' + def.price + ' gold</span>';
      }
      html += '</div></div>';
    });

    if(!shown){
      html += '<div class="tm-spray-placeholder">No styles yet.</div>';
    }
    html += '</div></div></div>';
    body.innerHTML = html;

    body.querySelectorAll('.tm-style-equip').forEach(function(btn){
      btn.onclick = function(){
        var ok = TankStyles.equipStyle(tankId, btn.dataset.style);
        if(ok){
          applyStyleToPreview();
          renderStylesTab(body);
          if(window.Menu) Menu.toast('✨ Style equipped');
        }
      };
    });
    body.querySelectorAll('.tm-style-unequip').forEach(function(btn){
      btn.onclick = function(){
        TankStyles.equipStyle(tankId, null);
        removeStyleFromPreview();
        renderStylesTab(body);
        if(window.Menu) Menu.toast('Style removed');
      };
    });
  }

  /* Paint / strip the style on whatever preview is currently in the viewer
     (GLB model or the box fallback). */
  function _previewRoot(){
    return _tankGroup;
  }
  function applyStyleToPreview(){
    if(!window.TankStyles || !_tankGroup) return;
    TankStyles.applyToPreview(_tankGroup, _currentTank);
  }
  function removeStyleFromPreview(){
    if(!window.TankStyles || !_tankGroup) return;
    TankStyles.removeFromModel(_tankGroup);
  }

  /* ============================================================
     SPRAY SYSTEM — click-to-place decals on the tank
     ============================================================ */
  const SPRAY_DEFS = {
    first_spray: { name: 'First Spray', icon: '🏷️', texture: 'assets/sprays/first_spray.webp', free: true },
  };

  /* Three little lamps showing how many of the three stamps are used. */
  function stampPips(count){
    var html = ' <span class="tm-spray-pips">';
    for(var i = 0; i < 3; i++) html += '<i class="' + (i < count ? 'on' : '') + '"></i>';
    return html + '</span>';
  }

  function renderSpraysTab(body){
    if(!body) return;    var tankId = _currentTank;
    var owned = getOwnedSprays();
    var equipped = getEquippedSprayForTank(tankId);
    var placement = readPlacement(tankId);

    var html = '<div class="tm-sprays-container">';
    
    /* Owned sprays list */
    html += '<div class="tm-sprays-section">';
    html += '<div class="tm-sprays-section-title"><span class="tm-ico">🎨</span>Your Sprays</div>';
    html += '<div class="tm-sprays-grid">';
    
    var shownCount = 0;
    var wornElsewhere = 0;
    Object.keys(SPRAY_DEFS).forEach(function(key){
      var def = SPRAY_DEFS[key];
      /* Sprays are not handed out: until you have claimed it in the store it
         simply isn't part of your list. */
      if(owned.indexOf(key) === -1) return;
      var isEquipped = equipped === key;
      /* If another tank is wearing this spray, don't offer it here at all. */
      var owner = getSprayOwner(key);
      if(owner && owner !== tankId){ wornElsewhere++; return; }
      shownCount++;

      html += '<div class="tm-spray-card owned' + (isEquipped ? ' equipped' : '') + '" data-spray="' + key + '">';
      html += '<div class="tm-spray-preview" style="background-image:url(' + def.texture + ')"></div>';
      html += '<div class="tm-spray-info">';
      html += '<span class="tm-spray-name">🏷️ ' + def.name + '</span>';
      if(isEquipped){
        html += '<span class="tm-spray-equipped">✅ Already Equipped</span>';
      }else{
        html += '<button class="tm-spray-btn tm-spray-equip" data-spray="' + key + '">✨ Equip</button>';
      }
      html += '</div>';
      html += '</div>';
    });

    if(shownCount === 0){
      html += wornElsewhere
        ? '<div class="tm-spray-placeholder">🔄 Your spray is on another tank — take it off there first.</div>'
        : '<div class="tm-spray-empty">' +
            '<div class="tm-spray-placeholder">🛍️ No sprays yet — grab the free First Spray in the store.</div>' +
            '<button class="tm-spray-btn tm-spray-store" id="tm-spray-store">🛒 Open Store</button>' +
          '</div>';
    }

    html += '</div></div>';

    /* Placement info — the buttons themselves live above the tab row,
       rendered by renderSprayActions(). */
    html += '<div class="tm-sprays-section">';
    html += '<div class="tm-sprays-section-title"><span class="tm-ico">📌</span>Placement</div>';
    if(!equipped){
      html += '<div class="tm-spray-placeholder">' +
        (wornElsewhere
          ? '⚠️ This spray is already on another tank.'
          : '👆 Equip a spray first, then click the tank to place it (max 3 stamps)') +
        '</div>';
    }else if(!_tankReady){
      html += '<div class="tm-spray-placeholder">⏳ Loading tank...</div>';
    }else{
      var stampCount = placement ? (placement.stamps ? placement.stamps.length : 0) : 0;
      html += '<div class="tm-spray-placement-info">';
      html += '<span>🏷️ Stamps: ' + stampCount + '/3' + stampPips(stampCount) + '</span>';
      html += '<span class="tm-spray-hint">👆 Tap the tank to stamp it — 🖱️ drag to turn it</span>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
    
    body.innerHTML = html;
    renderSprayActions();
    
    /* Wire events — sprays themselves are only ever claimed in the store, so
       there is no in-tab "get" button any more. */
    body.querySelectorAll('.tm-spray-equip').forEach(function(btn){
      btn.onclick = function(){
        var sprayId = btn.dataset.spray;
        setEquippedSpray(tankId, sprayId);
        renderSpraysTab(body);
      };
    });
    var placeBtn = document.getElementById('tm-spray-place');
    if(placeBtn){
      placeBtn.onclick = function(){ enterPlaceMode(); };
    }
    var clearBtn = document.getElementById('tm-spray-clear');
    if(clearBtn){
      clearBtn.onclick = function(){ clearSprayPlacement(); };
    }
    var unequipBtn = document.getElementById('tm-spray-unequip');
    if(unequipBtn){
      unequipBtn.onclick = function(){
        exitPlaceMode();
        clearSprayPlacement();               /* drop the stamps on this tank */
        setEquippedSpray(tankId, null);      /* and take the spray off it */
        renderSpraysTab(document.getElementById('tm-cosmo-body'));
      };
    }
    var storeBtn = document.getElementById('tm-spray-store');
    if(storeBtn){
      storeBtn.onclick = function(){
        if(window.Menu && Menu.show) Menu.show('menu-store');
      };
    }
  }

  /* The Place Stamp / Clear All / Take Spray Off buttons sit in their own row
     ABOVE the SPRAYS / PAINT / STYLE tabs, so they stay reachable no matter
     how tall the panel content gets. */
  function renderSprayActions(){
    var bar = document.getElementById('tm-spray-actions');
    if(!bar) return;
    var tankId = _currentTank;
    var equipped = getEquippedSprayForTank(tankId);
    var placement = readPlacement(tankId);
    var stampCount = (placement && placement.stamps) ? placement.stamps.length : 0;

    if(!equipped || !_tankReady){
      bar.innerHTML = '';
      bar.classList.remove('active');
      return;
    }

    var html = '<span class="tm-spray-actions-label">🏷️ Stamps: ' + stampCount + '/3' + stampPips(stampCount) + '</span>';
    if(stampCount < 3){
      html += '<button class="tm-spray-btn tm-spray-place" id="tm-spray-place">🖌️ Place Stamp</button>';
    }else{
      html += '<span class="tm-spray-max">🛑 Maximum 3 stamps reached</span>';
    }
    if(stampCount > 0){
      html += '<button class="tm-spray-btn tm-spray-clear" id="tm-spray-clear">🧹 Clear All</button>';
    }
    html += '<button class="tm-spray-btn tm-spray-remove" id="tm-spray-unequip">↩️ Take Spray Off</button>';
    bar.innerHTML = html;
    bar.classList.add('active');
  }

  function enterPlaceMode(){
    if(!_tankReady) return;
    _placeMode = true;
    _selectedSpray = getEquippedSprayForTank(_currentTank);
    if(window.Menu) Menu.toast('🖌️ Click on the tank to place spray stamp (max 3)');
    if(_sprayMarker) { _scene.remove(_sprayMarker); _sprayMarker = null; }
  }

  function exitPlaceMode(){
    _placeMode = false;
    _selectedSpray = null;
    if(_sprayMarker) { _scene.remove(_sprayMarker); _sprayMarker = null; }
  }

  /* ---------------------------------------------------------------
     LEGACY PLACEMENTS.

     A stamp written before the shared frame was measured against the
     menu's own hand-built preview tank, and that frame no longer exists —
     there is nothing left to convert it into. Keeping the paint is not
     possible and guessing would put it somewhere arbitrary, so those
     records are moved to a backup key (never deleted outright) and asked
     to be placed again. New records carry `v`, the frame they were
     authored in, and are replayed exactly.
     --------------------------------------------------------------- */
  var LEGACY_PLACEMENTS_KEY = 'tankparty_sprays_legacy_placements';

  function isCurrentPlacement(p){
    return !!(p && p.v === TankSprays.PLACEMENT_V);
  }

  function retireLegacyPlacement(tankId, p){
    try{
      var old = {};
      try{ old = JSON.parse(localStorage.getItem(LEGACY_PLACEMENTS_KEY) || '{}'); }catch(e){ old = {}; }
      old[tankId] = p;
      localStorage.setItem(LEGACY_PLACEMENTS_KEY, JSON.stringify(old));
    }catch(e){}
    setSprayPlacement(tankId, null);
    if(window.Menu && Menu.toast){
      Menu.toast('Sprays on this tank were placed in an older frame — place them again');
    }
  }

  /* Read the placement for a tank, retiring it if it belongs to a frame that
     is gone. Every read goes through here, so the migration happens once and
     only on the screen where it can be explained. */
  function readPlacement(tankId){
    var p = getSprayPlacement(tankId);
    if(!p || isCurrentPlacement(p)) return p;
    retireLegacyPlacement(tankId, p);
    return null;
  }

  function clearSprayPlacement(){
    setSprayPlacement(_currentTank, null);
    if(_tankGroup){
      /* The decals are parented to the part they landed on, not to the
         turntable group, so clearing means finding them rather than sweeping
         one level of children. */
      var doomed = [];
      _tankGroup.traverse(function(o){
        if(o.userData && o.userData.isSpray) doomed.push(o);
      });
      doomed.forEach(function(o){
        if(o.parent) o.parent.remove(o);
        /* Geometry is built per stamp and this is its only owner. The
           material is shared with every other tank wearing this spray — and
           is flagged sharedWithCache so a dying tank cannot take it away
           either — so it deliberately outlives these meshes. */
        if(o.geometry) o.geometry.dispose();
      });
    }
    var body = document.getElementById('tm-cosmo-body');
    renderSpraysTab(body);
  }

  function placeSprayAt(hit){
    if(!_selectedSpray || !_previewTank) return;
    var sprayDef = SPRAY_DEFS[_selectedSpray];
    if(!sprayDef) return;

    var mesh = hit.object;
    if(!hit.face || !TankSprays.isPaintable(mesh)) return;

    var norm = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
    var quatW = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), norm);

    /* The tap lands in world space; the stamp is SAVED in the tank root's own
       space, which is the space the battle replays it in. The turntable spins
       a group above the root, so its angle drops out of the record and the
       stamp comes back on the same panel at any turntable angle. */
    var f = TankSprays.toRootFrame(_previewTank, hit.point.clone(), quatW);

    addStampRecord({
      texture: sprayDef.texture,
      pos:  f.pos.toArray(),
      quat: [f.quat.x, f.quat.y, f.quat.z, f.quat.w],
      size: [TankSprays.SPRAY_SIZE, TankSprays.SPRAY_SIZE, TankSprays.SPRAY_DEPTH]
    });
  }

  function newPlacement(){
    return { v: TankSprays.PLACEMENT_V, stamps: [] };
  }

  /* Build the stamp, save it, and draw it — all through the one projection
     the battle uses, on a tank built by the same code. `rec` is already in
     root space. */
  function addStampRecord(rec){
    if(!_previewTank) return;
    var placement = readPlacement(_currentTank) || newPlacement();
    if(placement.stamps.length >= 3) return;   /* hard cap, enforced once, here */

    var parts = TankSprays.project(_previewTank, rec);
    if(!parts.length) return; /* nothing solid under the projector — no ghost record */

    placement.stamps.push({
      texture: rec.texture, pos: rec.pos, quat: rec.quat, size: rec.size
    });
    setSprayPlacement(_currentTank, placement);

    TankSprays.texture(rec.texture).then(function(tex){
      if(tex) TankSprays.addDecals(_previewTank, parts, tex);
      renderSpraysTab(document.getElementById('tm-cosmo-body'));
    });
  }

  /* Re-project every saved stamp onto the freshly built tank. */
  function restoreStamps(){
    /* Paint only comes back with the spray itself: if it is not equipped on
       this tank any more (or you no longer own it), the tank stays clean. */
    if(!getEquippedSprayForTank(_currentTank)) return;
    var placement = readPlacement(_currentTank);
    if(!placement || !placement.stamps || !placement.stamps.length) return;
    if(!_previewTank) return;

    var keep = [];
    var dropped = false;
    placement.stamps.forEach(function(rec){
      var parts = TankSprays.project(_previewTank, rec);
      /* Don't let a stamp that no longer shows take up one of the three
         slots. If NOTHING projected we leave the records alone — a tank that
         was still building must never cost you paint you already placed. */
      if(!parts.length){ dropped = true; return; }
      keep.push(rec);
      TankSprays.texture(rec.texture).then(function(tex){
        if(tex) TankSprays.addDecals(_previewTank, parts, tex);
      });
    });
    if(dropped && keep.length){
      placement.stamps = keep;
      setSprayPlacement(_currentTank, placement);
    }
  }

  /* Warm the one shared texture cache for every spray in the catalogue, so
     the match does not pay to load what this menu already looked at. */
  function loadSprayTextures(){
    Object.keys(SPRAY_DEFS).forEach(function(key){
      TankSprays.texture(SPRAY_DEFS[key].texture);
    });
  }

  /* --- 3D Viewer (fullscreen, night lighting, grid floor) --- */
  function initViewer(def){
    var host = document.getElementById('tm-viewer');
    var loading = document.getElementById('tm-viewer-loading');
    if(!host) return;
    /* Tear down any previous viewer first — otherwise every reopen leaked a
       WebGL context and a second animation loop. */
    destroy();
    _viewerHost = host;

    var W = window.innerWidth;
    var H = window.innerHeight;

    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0x0a0c10);
    _scene.fog = new THREE.FogExp2(0x0a0c10, 0.04);

    _camera = new THREE.PerspectiveCamera(36, W/H, 0.1, 100);
    _camera.position.set(12, 5, 12);
    _camera.lookAt(0, 0.8, 0);

    try{
      _renderer = new THREE.WebGLRenderer({antialias:true, alpha:false, preserveDrawingBuffer:true});
    }catch(e){
      console.warn('TankMenu WebGL failed:', e);
      if(loading) loading.style.display = 'none';
      return;
    }
    _renderer.setSize(W, H);
    _renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    _renderer.shadowMap.enabled = true;
    _renderer.shadowMap.type = THREE.PCFShadowMap;
    _renderer.toneMapping = THREE.ACESFilmicToneMapping;
    _renderer.toneMappingExposure = 1.0;
    _renderer.autoClear = true;
    _renderer.autoClearColor = true;
    _renderer.setClearAlpha(1.0);
    host.innerHTML = '';
    host.appendChild(_renderer.domElement);

    /* Night lighting — no directional sun, soft ambient fill */
    var hemi = new THREE.HemisphereLight(0x4466aa, 0x222233, 0.6);
    _scene.add(hemi);
    var amb = new THREE.AmbientLight(0x334466, 0.8);
    _scene.add(amb);

    /* Subtle point lights around the tank for clear visibility */
    var pLight1 = new THREE.PointLight(0x6688cc, 1.2, 20);
    pLight1.position.set(4, 6, 4);
    _scene.add(pLight1);
    var pLight2 = new THREE.PointLight(0x4466aa, 0.8, 18);
    pLight2.position.set(-4, 5, -3);
    _scene.add(pLight2);
    var pLight3 = new THREE.PointLight(0x5577bb, 0.5, 15);
    pLight3.position.set(0, 3, 5);
    _scene.add(pLight3);

    /* Rim light from below-behind for dramatic edge */
    var rim = new THREE.PointLight(0x3344ff, 0.4, 12);
    rim.position.set(0, -1, -4);
    _scene.add(rim);

    /* Grid floor */
    var gridHelper = new THREE.GridHelper(30, 30, 0x223344, 0x182030);
    gridHelper.position.y = -0.01;
    _scene.add(gridHelper);

    /* Inner glow ring on ground */
    var ringGeo = new THREE.RingGeometry(1.5, 4, 64);
    ringGeo.rotateX(-Math.PI/2);
    var ringMat = new THREE.MeshBasicMaterial({
      color: 0x223355, transparent: true, opacity: 0.15, side: THREE.DoubleSide
    });
    var ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.01;
    _scene.add(ring);

    /* --- Overhead lamp -------------------------------------------------
       A fixture hanging above the tank, the pool of light it throws on the
       floor, and the cone of light falling from it. */
    function radialGlowTexture(){
      var c = document.createElement('canvas');
      c.width = c.height = 128;
      var g = c.getContext('2d');
      var grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(255,240,214,1)');
      grad.addColorStop(0.45, 'rgba(255,230,184,0.5)');
      grad.addColorStop(1, 'rgba(255,224,168,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      var t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }

    var lampY = 13;
    var lampAngle = 0.40;                       /* half-angle of the beam */

    /* The light itself, pointing straight down. */
    var lamp = new THREE.SpotLight(0xffeed2, 2.6, 0, lampAngle, 0.55, 0);
    lamp.position.set(0, lampY, 0);
    lamp.target.position.set(0, 0, 0);
    _scene.add(lamp);
    _scene.add(lamp.target);

    /* The fixture and its bulb. */
    var fixture = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.95, 0.5, 24),
      new THREE.MeshBasicMaterial({ color: 0x191c22, fog: false }));
    fixture.position.set(0, lampY + 0.25, 0);
    _scene.add(fixture);
    var bulb = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 24),
      new THREE.MeshBasicMaterial({ color: 0xffe7b8, fog: false,
        transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
    bulb.rotation.x = Math.PI / 2;              /* face downwards */
    bulb.position.set(0, lampY, 0);
    _scene.add(bulb);

    /* The beam: an open cone from the bulb down to the floor, barely there. */
    var coneH = lampY;
    var coneR = Math.tan(lampAngle) * lampY;
    var coneGeo = new THREE.ConeGeometry(coneR, coneH, 48, 1, true);
    coneGeo.translate(0, -coneH / 2, 0);        /* apex at the bulb, mouth on the floor */
    var beam = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
      color: 0xffe3ac, transparent: true, opacity: 0.10,
      side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false
    }));
    beam.position.set(0, lampY, 0);
    _scene.add(beam);

    /* The light area on the ground — a soft warm patch under the tank. */
    var pool = new THREE.Mesh(
      new THREE.CircleGeometry(coneR * 1.25, 48),
      new THREE.MeshBasicMaterial({
        map: radialGlowTexture(), transparent: true, opacity: 0.45,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.02;
    _scene.add(pool);

    /* ---------------------------------------------------------------
       THE PREVIEW IS A REAL TANK.

       This used to load the GLB here and install it by hand. That built a
       LOOKALIKE, and the lookalike was not the same tank:

         * the solved model quaternion went on the model group, while battle
           puts it on _bodyOrient/_turretOrient, nested inside bodyGroup and
           turretGroup;
         * battle SPLITS the model into hull and turret and puts each in its
           own hierarchy, so the turret sits somewhere the flat preview never
           put it;
         * battle centres the model BEFORE it rotates it, this centred it
           after — a different position by the length of the centring offset;
         * battle applies modelRotate, modelFlipY, modelAutoFlip and every
           Tank Editor override (position, rotation, tracks). None of that was
           read here.

       Six ways for the surface under a spray to be somewhere else, and the
       bounding-box remap that used to paper over it could not undo any of
       them. That is the whole of "my sprays move about in battle".

       So the menu stops guessing and builds the tank the way the battle does:
       `new Tank(...)`, the same call js/tank-editor.js makes, with no physics
       world. The preview IS the battle tank, and a stamp saved in its root
       space needs no translation at all — the turntable spins a group ABOVE
       the root, so its angle drops out of the record by itself.
       --------------------------------------------------------------- */
    _tankGroup = new THREE.Group();
    _tankReady = false;
    _usingModel = false;
    _gunBox = null;
    _previewTank = null;
    _scene.add(_tankGroup);

    /* Tank only reaches for a model once Models says the file exists, and the
       catalogue is filled by a probe. On a cold load nobody has probed yet, so
       without this the preview would quietly fall back to the box build and
       show a different tank from the one you drive.

       Only when the catalogue is missing: probe() REPLACES _available wholesale
       rather than merging into it, so re-probing here would throw away the
       game's own results for every other tank.

       The token is captured now, so a menu that was closed while the probe was
       in flight builds nothing at all. */
    var entryToken = _viewerToken;
    var probed = (!def.model || typeof Models === 'undefined' || !Models.probe || Models._available)
      ? Promise.resolve(null)
      : Models.probe([def.model]).catch(function(){ return null; });
    probed.then(function(){
      if(entryToken !== _viewerToken) return;
      buildPreviewTank(def, loading);
    });

    function finishTank(loading){
      _tankReady = true;
      _tankGroup.position.y = 0.15;   /* same float above the grid as before */
      frameCamera();
      computeGunZone();
      restoreStamps();
      /* Style (cosmetics tab): whatever just landed gets the equipped style
         painted on, then the tab re-renders so a "Loading tank..." state
         refreshes into the real controls. */
      if(window.TankStyles){
        TankStyles.setPreviewTank(_currentTank);
        TankStyles.applyToPreview(_tankGroup, _currentTank).then(function(){
          var st = document.querySelector('#menu-tank .tm-cosmo-tab.active');
          if(st && st.dataset.cosmo === 'style'){
            renderStylesTab(document.getElementById('tm-cosmo-body'));
          }
        });
      }
      if(loading) loading.style.display = 'none';
      /* The tab body was rendered before the tank existed — refresh it so the
         "Loading tank..." placeholder becomes the actual place/clear controls. */
      var activeTab = document.querySelector('#menu-tank .tm-cosmo-tab.active');
      if(activeTab && activeTab.dataset.cosmo === 'sprays'){
        renderSpraysTab(document.getElementById('tm-cosmo-body'));
      }
    }

    function buildPreviewTank(def, loading){
      var token = _viewerToken;
      var t = null;
      try{
        /* A COPY of the def, so nothing here can write back into the live
           config object the game itself reads. Tank only ever reads from its
           def, so a shallow copy is enough. */
        var previewDef = Object.assign({}, def);
        /* A preview that keeps playing its firing clip is a preview you
           cannot aim a stamp at, and the rest pose is the one battle sprays
           are authored against. */
        previewDef.playAnims = false;
        t = new Tank(previewDef, { physicsWorld: null });
      }catch(err){
        console.warn('Menu tank build failed:', err);
        t = null;
      }
      if(!t || !t.root){ if(loading) loading.style.display = 'none'; return; }

      _previewTank = t;
      /* Nameplate, drown bar and view rings are battle HUD, not the tank. */
      if(t._overlayGroup) t._overlayGroup.visible = false;
      t.root.position.set(0, 0, 0);
      _tankGroup.add(t.root);
      _usingModel = !!(t.def && t.def.model && typeof Models !== 'undefined' && Models.hasModel(t.def.model));

      /* Tank builds its box fallback synchronously and swaps in the GLB when
         the model resolves, so the whole preview is only correct — and only
         worth framing or stamping — once that promise is done. */
      var ready = (t._modelReady && typeof t._modelReady.then === 'function')
        ? t._modelReady : Promise.resolve();
      ready.catch(function(){ return null; }).then(function(){
        if(token !== _viewerToken){          /* the menu was closed meanwhile */
          try{ t.dispose(); }catch(e){}
          return;
        }
        finishTank(loading);
      });
    }

    _rotY = 0;
    _velX = 0;
    _autoRotate = true;

    /* Drag events */
    host.addEventListener('mousedown', onDragStart);
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    host.addEventListener('touchstart', onTouchStart, {passive:false});
    window.addEventListener('touchmove', onTouchMove, {passive:false});
    window.addEventListener('touchend', onDragEnd);
    /* Click for spray placement */
    host.addEventListener('click', onClick);
    /* Zoom events */
    host.addEventListener('wheel', onWheel, {passive:false});
    host.addEventListener('touchstart', onPinchStart, {passive:false});
    window.addEventListener('touchmove', onPinchMove, {passive:false});

    animate();

    /* Resize handler */
    window.addEventListener('resize', onResize);
  }

  function onResize(){
    if(!_renderer || !_camera) return;
    var w = window.innerWidth, h = window.innerHeight;
    _camera.aspect = w/h;
    _camera.updateProjectionMatrix();
    _renderer.setSize(w, h);
  }

  function onDragStart(e){ _dragging = true; _autoRotate = false; _lastX = e.clientX; _velX = 0; }
  function onTouchStart(e){ if(e.touches.length===1){ e.preventDefault(); _dragging=true; _autoRotate=false; _lastX=e.touches[0].clientX; _velX=0; } }
  function onDragMove(e){ if(!_dragging) return; var dx=e.clientX-_lastX; _rotY+=dx*0.008; _velX=dx*0.008; _lastX=e.clientX; }
  function onTouchMove(e){ if(!_dragging||e.touches.length!==1) return; e.preventDefault(); var dx=e.touches[0].clientX-_lastX; _rotY+=dx*0.008; _velX=dx*0.008; _lastX=e.touches[0].clientX; }
  function onDragEnd(){ _dragging=false; clearTimeout(_autoTimer); _autoTimer=setTimeout(function(){ _autoRotate=true; },2500); }

  var _clickThreshold = 5; // pixels
  var _dragStartX = 0, _dragStartY = 0;
  var _noSprayToastAt = 0;

  function onDragStart(e){ 
    _dragging = true; 
    _autoRotate = false; 
    _lastX = e.clientX; 
    _velX = 0; 
    _dragStartX = e.clientX;
    _dragStartY = e.clientY;
  }
  function onTouchStart(e){ 
    if(e.touches.length===1){ 
      e.preventDefault(); 
      _dragging=true; 
      _autoRotate=false; 
      _lastX=e.touches[0].clientX; 
      _velX=0; 
      _dragStartX = e.touches[0].clientX;
      _dragStartY = e.touches[0].clientY;
    } 
  }

  function onClick(e){
    if(!_placeMode || !_selectedSpray || !_previewTank) return;
    // Check if this was a click (not a drag)
    var dx = e.clientX - _dragStartX;
    var dy = e.clientY - _dragStartY;
    if(Math.hypot(dx, dy) > _clickThreshold) return;
    
    e.preventDefault();
    
    var host = _viewerHost || document.getElementById('tm-viewer');
    if(!host) return;
    var rect = host.getBoundingClientRect();
    _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    
    _raycaster.setFromCamera(_mouse, _camera);
    /* The turntable only updates matrices inside the render loop; make sure
       they are current before raycasting (the loop may not have run yet). */
    _camera.updateMatrixWorld(true);
    if(_tankGroup) _tankGroup.updateMatrixWorld(true);
    var intersects = _raycaster.intersectObject(_tankGroup, true);
    for(var i = 0; i < intersects.length; i++){
      var hit = intersects[i];
      var obj = hit.object;
      if(!obj || !obj.geometry || obj.visible === false) continue;
      var u = obj.userData || {};
      if(!obj.isMesh || obj.visible === false) continue;
      if(!obj.geometry || !obj.geometry.getAttribute('position')) continue;
      if(u.isOutline || u.isSpray || u.noSpray) continue;   /* shells and old stamps aren't targets */
      /* Say why nothing happened rather than silently dropping the tap. A click
         on a named gun part, or on the front of the turret where every barrel
         sits, is refused here AND refused by the same projection in battle, so
         the two can never disagree about where a stamp may go. */
      if(TankSprays.isGunMesh(obj) || inGunZone(hit.point)){ toastGun(); return; }
      placeSprayAt(hit);
      break;
    }
  }

  /* Say why nothing happened instead of silently ignoring the tap. */
  function toastGun(){
    var now = Date.now();
    if(now - _noSprayToastAt <= 1500) return;
    _noSprayToastAt = now;
    if(window.Menu && Menu.toast) Menu.toast('Sprays can’t be put on the gun');
  }

  /* Zoom: wheel */
  function onWheel(e){
    e.preventDefault();
    _zoomTarget += e.deltaY > 0 ? -0.15 : 0.15;
    _zoomTarget = Math.max(0, Math.min(1, _zoomTarget));
  }

  /* Zoom: pinch */
  var _pinching = false, _pinchDist = 0;
  function onPinchStart(e){
    if(e.touches.length === 2){
      e.preventDefault();
      _pinching = true;
      _pinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }
  function onPinchMove(e){
    if(!_pinching || e.touches.length !== 2) return;
    e.preventDefault();
    var d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    var delta = (d - _pinchDist) * 0.005;
    _zoomTarget += delta;
    _zoomTarget = Math.max(0, Math.min(1, _zoomTarget));
    _pinchDist = d;
  }

  /* Camera positions: default vs zoomed in. Both are recomputed by
     frameCamera() once the preview tank is known — the box build and a real
     GLB are wildly different sizes. */
  var _camFar  = { x:12, y:5, z:12 };
  var _camNear = { x:7, y:3.2, z:7 };
  var _lookY = 0.8;

  /* Fit the camera to whatever the preview tank turned out to be. Tank.boxOf
     skips invisible nodes, so the hidden nameplate and drown bar cannot drag
     the framing, and it walks geometry bounding boxes rather than
     re-measuring every mesh — which is all the old setFromObject over the
     whole group was doing. */
  function frameCamera(){
    if(!_tankGroup || !_previewTank) return;
    var box = Tank.boxOf(_tankGroup, true);
    if(box.isEmpty()) return;
    var r = box.getBoundingSphere(new THREE.Sphere()).radius;
    if(!isFinite(r) || r <= 0) return;
    var halfFov = (36 * Math.PI / 180) / 2;
    var d = Math.max(17.26, r / Math.tan(halfFov) * 0.85);
    _camFar  = { x: d * 0.695, y: d * 0.290, z: d * 0.695 };
    _camNear = { x: d * 0.404, y: d * 0.185, z: d * 0.404 };
    if(_usingModel){
      var c = box.getCenter(new THREE.Vector3());
      _lookY = Math.max(0.8, c.y * 0.9);
    }else{
      _lookY = 0.8;
    }
  }

  /* THE GUN ZONE, derived from the same bounds the battle measures.

     On a real model the barrel is baked into the turret mesh, so there is no
     part to flag and no node to ask: the rule is a box — the front third of
     the tank, the central strip, above the hull. Both sides now build it from
     the tank's own paintable bounds through the same function, so a spot the
     menu refuses to stamp is exactly a spot the battle refuses to paint. */
  function computeGunZone(){
    _gunBox = null;
    if(!_previewTank) return;
    var b = TankSprays.localBox(_previewTank);
    if(!b || b.isEmpty()) return;
    _gunBox = TankSprays.gunBox(b);      /* already in root space */
  }
  function inGunZone(worldPoint){
    if(!_gunBox || !_previewTank) return false;
    var p = _previewTank.root.worldToLocal(worldPoint.clone());
    return _gunBox.containsPoint(p);
  }

  function animate(){
    _loopId = requestAnimationFrame(animate);
    if(!_renderer||!_scene||!_camera) return;
    if(_autoRotate){ _rotY += 0.003; }
    else { _rotY += _velX; _velX *= 0.93; if(Math.abs(_velX)<0.00005) _velX=0; }
    if(_tankGroup) _tankGroup.rotation.y = _rotY;

    /* Smooth zoom interpolation */
    _zoom += (_zoomTarget - _zoom) * 0.08;
    var cx = _camFar.x + (_camNear.x - _camFar.x) * _zoom;
    var cy = _camFar.y + (_camNear.y - _camFar.y) * _zoom;
    var cz = _camFar.z + (_camNear.z - _camFar.z) * _zoom;
    _camera.position.set(cx, cy, cz);
    _camera.lookAt(0, _lookY, 0);

    _renderer.render(_scene, _camera);
  }

  function destroy(){
    _viewerToken++;              /* any model still loading now bails out */
    _tankReady = false;
    _usingModel = false;
    _gunBox = null;
    /* FREE THE PREVIEW TANK.
       It is a whole Tank: nameplate canvas, drown-bar canvas, per-tank
       material clones and any geometry batching built. Dropping the group
       and walking away left all of it on the GPU, once per tank opened, for
       the life of the page. Tank.dispose() frees exactly what this tank
       owns and skips the shared model geometry, the shared outline material
       and the shared spray materials — which are all flagged for it. */
    if(_previewTank){
      try{ _previewTank.dispose(); }catch(e){}
      _previewTank = null;
    }
    if(_loopId){ cancelAnimationFrame(_loopId); _loopId=null; }
    if(_renderer){ _renderer.dispose(); _renderer=null; }
    _scene=null; _camera=null; _tankGroup=null;
    _dragging=false; _autoRotate=true; _zoom=0; _zoomTarget=0;
    window.removeEventListener('resize', onResize);
    var host = document.getElementById('tm-viewer');
    if(host){
      host.removeEventListener('mousedown',onDragStart);
      host.removeEventListener('touchstart',onTouchStart);
      host.removeEventListener('touchmove',onTouchMove);
      host.removeEventListener('wheel',onWheel);
      host.removeEventListener('touchstart',onPinchStart);
      host.removeEventListener('click',onClick);
    }
    window.removeEventListener('mousemove',onDragMove);
    window.removeEventListener('mouseup',onDragEnd);
    window.removeEventListener('touchend',onDragEnd);
    window.removeEventListener('touchmove',onPinchMove);
  }

  return { show:show, destroy:destroy, getMechanics:getMechanics, MECHANICS:MECHANICS, TANK_MECHANICS:TANK_MECHANICS };
})();
