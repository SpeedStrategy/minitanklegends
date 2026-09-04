/* ============================================================
   config.js — game balance + world constants + tank roster
   ============================================================ */

const TROPHIES = [];

const CONFIG = {
  // Nakama (Heroic Cloud / self-hosted)
  NAKAMA: {
    HOST:     'localhost',     // change to your Heroic Cloud deployment URL when live
    PORT:     7350,
    USE_SSL:  false,
    SERVER_KEY: 'defaultkey',  // your Nakama server key
  },

  // PeerJS — STUN + free TURN relay so P2P works behind strict NAT
  PEER_ICE: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  ],

  // Persistent clan registry backend (Cloudflare Worker + KV, always online)
  CLAN_API_URL: 'https://clan-registry-api.nojus-t.workers.dev',

  // World
  WORLD_SIZE:      450,   // 3x bigger open battlefield
  GRID_DIVISIONS:  60,    // ground shader grid lines
  TANK_Y:          1.2,   // all tanks drive at this Y (flat, like the reference)

  // Camera (over-the-shoulder / angled top-down follow, see camera.js)
  CAM_DIST_MIN:    12,
  CAM_DIST_MAX:    80,
  CAM_DIST:        22,    // default
  CAM_HEIGHT:      33,
  CAM_PITCH:       0.95,  // downward tilt factor
  CAM_LERP:        0.14,
  CAM_ZOOM_STEP:   2.5,
  CAM_ROTATE_SPEED: 2.0,  // radians per second for keyboard camera orbit
  CAM_SWIPE_SENSITIVITY: 0.008, // radians per pixel for swipe camera rotate

  // Drift / handbrake
  DRIFT_MIN_KMH:   14,   // need at least this speed to drift (km/h)
  DRIFT_MIN_SPEED_FRAC: 0.6, // ...AND at least 60% of this tank's own top speed
  DRIFT_TURN_BOOST:3.0,   // body turns this many times faster while drifting
  DRIFT_FRICTION:  0.72,  // velocity retained per second while drifting (higher = slides more)
  U_TO_KMH:        3.6 * 0.6,

  // Combat
  SHELL_SPEED:     90,
  SHELL_LIFE:      3.0,
  FLAME_RANGE:     18,
  FLAME_DPS:       0,

  // Trajectory line (aim assist)
  AIM_LINE_OPACITY: 0.5,
  AIM_LINE_COLOR:   '#ffffff',

  // View range circle (spotting)
  VIEW_RANGE_OPACITY: 0.25,
  VIEW_RANGE_COLOR:   '#ffffff',
  VIEW_RANGE_WIDTH:   0.5,   // 0 = narrow ring, 1 = fat ring

  // Camouflage
  BUSH_HIDE_RADIUS:   3.2,   // a tank within this distance of a bush is hidden
  TREE_HIDE_RADIUS:   4.0,   // tree canopy gives partial camo (less effective)

  // Models
  MODEL_DIR:   'mini_tank_legends_models/',
  MODEL_EXT:   '.gltf',
  // Bump when any tank model file changes. Appended as ?v= to every
  // model request so browsers bypass the 7-day Cache-Control on
  // mini_tank_legends_models/*.
  MODEL_VER:   5,

  // Supers
  SUPER_COOLDOWN: 60,   // seconds between super uses

  // Networking
  PEER_PREFIX:     'tankparty-v1-',
};

/* ---------- GAMEMODES ---------- */
const GAMEMODES = {
  // Gladiator: 10-player free-for-all on one map.
  // The map is a grid of chunks. Random chunks on the edge of the safe area
  // get flagged ORANGE (countdown), then turn RED (danger, redDps HP/s) after
  // chunkOrange seconds. Repeat chunk by chunk until the safe area collapses.
  gladiator: {
    id:'gladiator', name:'Gladiator', maxTanks:10, botCount:9,
    spawnSubType:'gladiator', boxSubType:'gladiatorbox',
    zone:{
      graceTime:60,          // seconds before the zone starts eating chunks
      chunkOrange:90,        // orange warning -> red transition time per chunk
      waveTime:60,           // every N seconds a wave of 5 chunks appears
      pickTime:19.5,         // fallback single-chunk pick interval (unused with waves)
      chunk:12,              // chunk size (scaled to world in _initGladiator)
      minHalf:8,             // legacy: kept for compatibility
      finalHalf:0,           // legacy: kept for compatibility
      stageTime:60,          // legacy: kept for compatibility
    },
    power:{ kill:20, box:5, airdrop:40 },
    airdrop:{ firstDelay:45, interval:40, countdown:30, holdTime:10 },
    redDps:10,
  },
};

/* ---------- TANK ROSTER ---------- */
const TANKS = {
  coolbuddy: {
    id:'coolbuddy', name:'Cool Buddy', tier:1, collection:1,
    color:0x8a8f98, turretColor:0xb9bfc9,
    body:{ w:3.0, h:1.0, l:4.4 },
    turret:{ w:1.8, h:0.8, l:2.4 },
    barrelLen:1.6, barrelR:0.16,
    model:'coolbuddy', modelScale:12.75,
    modelFlipY:true, muzzleZOff:0.15,
    fireAnim:'gun firing',
    ejectShell:true,
    hp:200, speed:22, turn:1.8,
    turretTurn:2.4,
    damage:34, reload:1.6, shellSpeed:90, shellRange:40,
    accel:18, shellType:'shell',
    mass:30, viewRange:105,
    armor:{front:10, sides:30, back:10},
    desc:'Balanced all-rounder.',
    friction: 0.88,
    superType:'airstrike',
    airstrikeBombs:3, airstrikeDelay:3, airstrikeRadius:4, airstrikeDamage:60,
  },

  helix: {
    id:'helix', name:'Helix', tier:2, collection:2,
    color:0xb5482a, turretColor:0xd86a3a,
    body:{ w:3.2, h:1.1, l:4.6 },
    turret:{ w:2.0, h:0.9, l:2.4 },
    barrelLen:1.2, barrelR:0.22,
    hp:220, speed:21, turn:1.7,
    turretTurn:2.6,
    damage:10, reload:0.10, shellSpeed:42, shellRange:20,
    accel:18, shellType:'flame',
    mass:34, viewRange:78,
    model:'helix', modelScale:1.0,
    fireConeHalfAngle:0.12,
    armor:{front:30, sides:30, back:30},
    desc:'Flamethrower. Devastating up close.',
    friction: 0.85,
    superType:'oil',
    oilFill:4, oilBurn:1, oilDamage:4, oilTick:0.25,
  },

  striker: {
    id:'striker', name:'Striker', tier:2, collection:2,
    color:0x3a6ea5, turretColor:0x5a93cf,
    body:{ w:2.8, h:0.95, l:4.2 },
    turret:{ w:1.7, h:0.75, l:2.6 },
    barrelLen:2.2, barrelR:0.13,
    hp:140, speed:23, turn:1.9,
    turretTurn:2.8,
    damage:30, reload:1.4, shellSpeed:140, shellRange:50,
    accel:20, shellType:'shell',
    mass:28, viewRange:135,
    model:'striker', modelScale:1.0,
    armor:{front:30, sides:30, back:30},
    desc:'Glass cannon. Fast, long-range shells.',
    friction: 0.90,
    superType:'bush',
    bushMax:3,
  },

  ghost: {
    id:'ghost', name:'Ghost', tier:3, collection:3,
    color:0x4a4f55, turretColor:0x6c7278,
    body:{ w:2.3, h:0.85, l:3.6 },
    turret:{ w:1.4, h:0.7, l:1.9 },
    barrelLen:1.1, barrelR:0.11,
    hp:120, speed:34, turn:2.6,
    turretTurn:3.2,
    damage:14, reload:0.45, shellSpeed:95, shellRange:35,
    accel:30, shellType:'shell',
    mass:18, viewRange:110,
    model:'ghost', modelScale:0.3, modelYaw:-90, modelAutoFlip:false,
    playAnims:false, outline:false,
    armor:{front:30, sides:30, back:30},
    desc:'Tiny, fast, hit-and-run.',
    friction: 0.82,
    superType:'cloak',
    cloakWindup:3, cloakMax:10,
  },

  dummy: {
    id:'dummy', name:'Dummy', tier:0, collection:0,
    color:0x8a8f98, turretColor:0xb9bfc9,
    body:{ w:3.0, h:1.0, l:4.4 },
    turret:{ w:1.8, h:0.8, l:2.4 },
    barrelLen:1.6, barrelR:0.16,
    hp:200, speed:0, turn:0,
    turretTurn:0,
    damage:0, reload:999, shellSpeed:0, shellRange:0,
    accel:0, shellType:'shell',
    mass:999, viewRange:0,
    model:'helix', modelScale:1.0,
    armor:{front:10, sides:30, back:10},
    desc:'Target dummy. Respawns on death.',
    friction: 1.0,
  },

  tankdisplay: {
    id:'tankdisplay', name:'Tank Display', tier:0, collection:0,
    color:0x6a8a3a, turretColor:0x8aaa5a,
    body:{ w:2.5, h:1.8, l:2.0 },
    turret:{ w:1.2, h:0.6, l:1.2 },
    barrelLen:0.8, barrelR:0.1,
    hp:99999, speed:0, turn:0,
    turretTurn:0,
    damage:0, reload:999, shellSpeed:0, shellRange:0,
    accel:0, shellType:'shell',
    mass:999, viewRange:0,
    model:'coolbuddy', modelScale:7.5, modelFlipY:true,
    armor:{front:999, sides:999, back:999},
    desc:'Display tank.',
    friction: 1.0,
  },

  sturmratte: {
    id:'sturmratte', name:'Sturmratte', tier:3, collection:3,
    color:0x5a5648, turretColor:0x7d7a67,
    body:{ w:4.0, h:1.4, l:5.8 },
    turret:{ w:2.6, h:1.1, l:3.2 },
    barrelLen:2.6, barrelR:0.24,
    hp:440, speed:13, turn:1.0,
    turretTurn:1.4,
    damage:42, reload:4.2, shellSpeed:80, shellRange:40,
    accel:10, shellType:'shell',
    mass:60, viewRange:95,
    model:'sturmratte', modelScale:2.0,
    armor:{front:30, sides:30, back:30},
    desc:'Juggernaut. Massive shells, very slow.',
    friction: 0.92,
    superType:'panzers',
    panzerDelay:8,
  },

  rapid: {
    id:'rapid', name:'Rapid', tier:1, collection:1,
    color:0x3a9a4a, turretColor:0x55b860,
    body:{ w:2.8, h:0.95, l:4.0 },
    turret:{ w:1.6, h:0.75, l:2.0 },
    barrelLen:1.4, barrelR:0.12,
    hp:160, speed:24, turn:2.0,
    turretTurn:2.6,
    damage:14, reload:0.30, shellSpeed:100, shellRange:42,
    accel:20, shellType:'shell',
    mass:26, viewRange:110,
    model:'coolbuddy', modelScale:8.4, modelFlipY:true,
    magSize:3, magReload:2.6,
    armor:{front:10, sides:20, back:10},
    desc:'Shell magazine. Sprays 3 quick shells, then reloads.',
    friction: 0.88,
  },

  blitz: {
    id:'blitz', name:'Blitz', tier:2, collection:2,
    color:0xc98a2e, turretColor:0xe0a84a,
    body:{ w:3.0, h:1.0, l:4.4 },
    turret:{ w:1.8, h:0.85, l:2.3 },
    barrelLen:2.0, barrelR:0.15,
    hp:180, speed:21, turn:1.7,
    turretTurn:2.8,
    damage:24, reload:0.26, shellSpeed:140, shellRange:52,
    accel:18, shellType:'shell',
    mass:32, viewRange:135,
    model:'striker', modelScale:1.05,
    magSize:3, magReload:3.2,
    armor:{front:20, sides:25, back:15},
    desc:'Shell magazine. Burst cannon with long reach.',
    friction: 0.90,
  },

  vulkan: {
    id:'vulkan', name:'Vulkan', tier:3, collection:3,
    color:0xb83a3a, turretColor:0xd85a4a,
    body:{ w:3.6, h:1.25, l:5.2 },
    turret:{ w:2.4, h:1.0, l:2.8 },
    barrelLen:2.2, barrelR:0.2,
    hp:320, speed:15, turn:1.1,
    turretTurn:2.0,
    damage:30, reload:0.22, shellSpeed:90, shellRange:44,
    accel:11, shellType:'shell',
    mass:48, viewRange:100,
    model:'sturmratte', modelScale:1.4,
    magSize:5, magReload:4.5,
    armor:{front:30, sides:30, back:30},
    desc:'Shell magazine. Heavy 5-round rotary burst.',
    friction: 0.92,
  },

  panzer: {
    id:'panzer', name:'Panzer', tier:3, collection:0,
    color:0x6a6e72, turretColor:0x8a9096,
    body:{ w:2.0, h:0.85, l:3.0 },
    turret:{ w:1.2, h:0.65, l:1.6 },
    barrelLen:1.0, barrelR:0.11,
    hp:60, speed:28, turn:2.2,
    turretTurn:3.0,
    damage:7, reload:0.8, shellSpeed:95, shellRange:32,
    accel:24, shellType:'shell',
    mass:14, viewRange:90,
    model:'ghost', modelScale:0.25,
    armor:{front:10, sides:20, back:10},
    desc:'Sturmratte escort panzer.',
    friction: 0.85,
  },
};

const TANK_ORDER = ['coolbuddy','rapid','helix','striker','blitz','ghost','vulkan','sturmratte','tankdisplay'];
const U_TO_KMH = CONFIG.U_TO_KMH;

/* World palette */
const COLORS = {
  grass1:0x4a6a2a, grass2:0x5a8a30,
  path:0x8b7050, pathDark:0x7a6040,
  rock:0x6a6e72, rockDark:0x4a4e52,
  bush:0x3a7a38, bush2:0x4a9a48, bushBig:0x2a5a2a,
  treeTrunk:0x5a4030, treeLeaf:0x3a7a34, treeLeaf2:0x4a8a40,
  water1:0x1a6a9a, water2:0x2a8aba,
  fog:0x2a2a2a,
};

const DEFAULT_BINDS = {
  forward:  { key:'KeyW',  label:'Go Forward' },
  backward: { key:'KeyS',  label:'Go Backward' },
  left:     { key:'KeyA',  label:'Turn Left' },
  right:    { key:'KeyD',  label:'Turn Right' },
  fire:     { key:'LMB',   label:'Fire' },
  handbrake:{ key:'Space', label:'Handbrake (Drift)' },
  zoomIn:   { key:'WheelUp',   label:'Zoom In' },
  zoomOut:  { key:'WheelDown', label:'Zoom Out' },
  camLeft:  { key:'ArrowLeft',  label:'Camera Left' },
  camRight: { key:'ArrowRight', label:'Camera Right' },
  minimap:  { key:'KeyM',       label:'Toggle Map' },
  super:    { key:'KeyF',       label:'Super Ability' },
};

function loadSettings(){
  const defaults = () => Object.fromEntries(Object.keys(DEFAULT_BINDS).map(k=>[k,DEFAULT_BINDS[k].key]));
  try{
    const s = JSON.parse(localStorage.getItem('tankparty_settings')||'{}');
    // One-time migration: unlock the newest shell-magazine tanks for existing players
    if(!s.mtl_mag_unlocked){
      s.unlockedTanks = Array.from(new Set([...(s.unlockedTanks||[]), 'rapid', 'blitz', 'vulkan']));
      s.mtl_mag_unlocked = true;
      localStorage.setItem('tankparty_settings', JSON.stringify(s));
    }
    return {
      binds: Object.assign(defaults(), s.binds||{}),
      selectedTank: s.selectedTank || 'coolbuddy',
      playerName: s.playerName || ('Player'+Math.floor(Math.random()*9000+1000)),
      playerClan: s.playerClan || '',
      // Cash is the legacy 'coins' key (one-time migration); a fresh 'coins'
      // key now holds the third currency, Coins.
      cash: typeof s.cash === 'number' ? s.cash : (typeof s.coins === 'number' ? s.coins : 0),
      coins: typeof s.cash === 'number' ? (typeof s.coins === 'number' ? s.coins : 0) : 0,
      gems: typeof s.gems === 'number' ? s.gems : 0,
      aimLineOpacity: (s.aimLineOpacity!=null? s.aimLineOpacity : CONFIG.AIM_LINE_OPACITY),
      aimLineColor:   s.aimLineColor || CONFIG.AIM_LINE_COLOR,
      aimLineDesign:  s.aimLineDesign || 'professional',
      ricochetIndicator: s.ricochetIndicator !== false,
      viewRangeOpacity: (s.viewRangeOpacity!=null? s.viewRangeOpacity : CONFIG.VIEW_RANGE_OPACITY),
      viewRangeColor:   s.viewRangeColor || CONFIG.VIEW_RANGE_COLOR,
      viewRangeWidth:   (s.viewRangeWidth!=null? s.viewRangeWidth : CONFIG.VIEW_RANGE_WIDTH),
      graphicsQuality:  s.graphicsQuality || 'default',
      camRotation:      s.camRotation || 0,
      camMode:          s.camMode || 'arrows',
      pinchZoom:        s.pinchZoom !== false,
      unlockedTanks:    s.unlockedTanks || ['coolbuddy'],
      allUnlocked:      s.allUnlocked || false,
      clanWeeklyXP:     typeof s.clanWeeklyXP === 'number' ? s.clanWeeklyXP : 0,
      clanWeekKey:      s.clanWeekKey || 0,
      clanWeeklyRewarded: s.clanWeeklyRewarded || false,
      clanWeekWins:     s.clanWeekWins || 0,
      clanWeekWinsBonus: s.clanWeekWinsBonus || false,
      clanWeekLoginXP:  s.clanWeekLoginXP || 0,
      clanLastLoginDay: s.clanLastLoginDay || 0,
      tlPlus:           s.tlPlus || false,
      screenShake:      (typeof s.screenShake === 'number' ? s.screenShake : 100),
      muzzleFx:         s.muzzleFx !== false,
      showFps:          !!s.showFps,
      invertCamRot:     !!s.invertCamRot,
      cameraMode:       s.cameraMode || 'dynamic',
      cameraMouseRotate: !!s.cameraMouseRotate,
    };
  }catch(e){
    return {binds:defaults(), selectedTank:'coolbuddy', playerName:'Player'+Math.floor(Math.random()*9000+1000), playerClan:'', cash:0, coins:0, gems:0,
            aimLineOpacity:CONFIG.AIM_LINE_OPACITY, aimLineColor:CONFIG.AIM_LINE_COLOR, aimLineDesign:'default',
            viewRangeOpacity:CONFIG.VIEW_RANGE_OPACITY, viewRangeColor:CONFIG.VIEW_RANGE_COLOR,
            viewRangeWidth:CONFIG.VIEW_RANGE_WIDTH, graphicsQuality:'default', camRotation:0, camMode:'arrows', pinchZoom:true, ricochetIndicator:true,
            unlockedTanks:['coolbuddy'], allUnlocked:false, clanWeeklyXP:0, clanWeekKey:0, clanWeeklyRewarded:false,
            clanWeekWins:0, clanWeekWinsBonus:false, clanWeekLoginXP:0, clanLastLoginDay:0, tlPlus:false,
            screenShake:100, muzzleFx:true, showFps:false, invertCamRot:false, cameraMode:'dynamic', cameraMouseRotate:false};
  }
}
function saveSettings(s){
  localStorage.setItem('tankparty_settings', JSON.stringify(s));
  if(window.Auth && window.Auth.onSettingsSaved) window.Auth.onSettingsSaved(s);
}
function resetSettings(){
  localStorage.removeItem('tankparty_settings');
  return loadSettings();
}

function loadCustomMap(){
  try{ return JSON.parse(localStorage.getItem('tankparty_custommap')||'null'); }catch(e){ return null; }
}
function saveCustomMap(map){ localStorage.setItem('tankparty_custommap', JSON.stringify(map)); }
function hasCustomMap(){ return !!localStorage.getItem('tankparty_custommap'); }

const MAP_UNLOCK_CODE = 'TANKMASTER';
function isMapUnlocked(){ return localStorage.getItem('tankparty_mapunlocked')==='1'; }
function setMapUnlocked(v){ localStorage.setItem('tankparty_mapunlocked', v?'1':'0'); }

/* Main map (replaces procedural default) */
function saveMainMap(mapData){ localStorage.setItem('tankparty_mainmap', JSON.stringify(mapData)); }
function loadMainMap(){ try{ return JSON.parse(localStorage.getItem('tankparty_mainmap')||'null'); }catch(e){ return null; } }
function hasMainMap(){ return !!localStorage.getItem('tankparty_mainmap'); }
function clearMainMap(){ localStorage.removeItem('tankparty_mainmap'); }

/* ========== Clan XP System ========== */
var CLAN_XP_CAP = 10000;
var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function getWeekKey(){ return Math.floor(Date.now() / WEEK_MS); }

var CLAN_GLAD_XP = {1:250, 2:150, 3:75};      // single-player gladiator placement XP
var CLAN_LOGIN_DAILY = 100;                   // daily login XP
var CLAN_LOGIN_WEEK_CAP = 700;                // max login XP per member per week
var CLAN_TLPLUS_DAILY = 300;                  // future TL+ subscription: login XP per day
var CLAN_WIN_BONUS_XP = 2000;                 // 10x 1st place in gladiator within a week
var CLAN_WIN_BONUS_COUNT = 10;

function clanCodeOf(){
  try{
    const c = JSON.parse(localStorage.getItem('tankparty_clan') || 'null');
    return (c && c.code) ? String(c.code) : '';
  }catch(e){ return ''; }
}
function isInClan(){ return !!clanCodeOf(); }

/* Award XP to the local member (capped locally, reseeds the week's counters). */
function addClanXP(n){
  const s = Menu.settings;
  if(!s || !isInClan()) return;
  const wk = getWeekKey();
  if(s.clanWeekKey !== wk){
    s.clanWeeklyXP = 0;
    s.clanWeekKey = wk;
    s.clanWeeklyRewarded = false;
    s.clanWeekWins = 0;
    s.clanWeekWinsBonus = false;
    s.clanWeekLoginXP = 0;
  }
  s.clanWeeklyXP = Math.min(CLAN_XP_CAP, (s.clanWeeklyXP || 0) + Math.max(0, n | 0));
  saveSettings(s);
  clanXPPost(n);
}

/* Fire-and-forget push of XP into the clan-total ledger (cloud worker). */
function clanXPPost(add){
  try{
    if(!add || !window.Auth || !Auth.token || !Auth.loggedIn()) return;
    fetch(CONFIG.CLAN_API_URL + '/clanxp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: Auth.token, code: clanCodeOf(), add: add | 0, week: getWeekKey() })
    }).catch(()=>{});
  }catch(_){}
}

/* Ask the cloud how much XP the whole clan collected in `week`. */
function clanXPWeekReport(week, cb){
  cb = cb || function(){};
  try{
    if(!isInClan() || !window.Auth || !Auth.token) return cb(null);
    fetch(CONFIG.CLAN_API_URL + '/clanxp?code=' + encodeURIComponent(clanCodeOf()) + '&week=' + (week || 0))
      .then(r => r.json())
      .then(d => cb(d && d.total >= CLAN_XP_CAP ? d : null))
      .catch(() => cb(null));
  }catch(_){ cb(null); }
}

/* One-time cloud claim flag: true only the first time this account claims week's box. */
function clanXPClaimWeek(week, cb){
  cb = cb || function(){};
  try{
    if(!isInClan() || !window.Auth || !Auth.token) return cb(false);
    fetch(CONFIG.CLAN_API_URL + '/clanxp/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: Auth.token, code: clanCodeOf(), week: week })
    }).then(r => r.json()).then(d => cb(!!(d && d.claimed))).catch(() => cb(false));
  }catch(_){ cb(false); }
}

/* Week rolled over: if the clan's total last week hit the cap, every member
   (this account) may claim one box. Called once per rollover via menu/game. */
function checkClanWeeklyBox(oldWeek){
  if(!oldWeek || !isInClan() || !window.Auth || !Auth.token) return;
  clanXPWeekReport(oldWeek, rep => {
    if(!rep) return;
    clanXPClaimWeek(oldWeek, claimed => {
      if(!claimed) return;
      const s = Menu.settings;
      addClanItem('box', { source:'weekly_xp', week: oldWeek });
      s.clanWeeklyRewarded = true;
      saveSettings(s);
      if(Menu.toast) Menu.toast('\u{1F4E6} Clan weekly XP complete — box added to your storage!');
    });
  });
}

function loadClanStorage(){
  try{ return JSON.parse(localStorage.getItem('tankparty_storage')||'[]'); }catch(e){ return []; }
}
function saveClanStorage(items){
  localStorage.setItem('tankparty_storage', JSON.stringify(items));
}
function addClanItem(type, meta){
  var items = loadClanStorage();
  items.push({ type:type, meta:meta||{}, acquired:Date.now(), week:getWeekKey() });
  saveClanStorage(items);
  return items;
}
function removeClanItem(index){
  var items = loadClanStorage();
  if(index >= 0 && index < items.length) items.splice(index, 1);
  saveClanStorage(items);
  return items;
}