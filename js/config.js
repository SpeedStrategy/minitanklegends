/* ============================================================
   config.js — game balance + world constants + tank roster
   ============================================================ */

/* THE TROPHY ROSTER.

   Every trophy that exists in the game, whether or not the player owns it. The
   profile screen draws ALL of them and darkens the ones you have not earned, so
   this list is the catalogue rather than the player's collection — that is the
   whole point of showing a locked trophy at all.

   The player's own collection lives in `settings.trophyOwnedIds`, which holds
   ids from THIS list. Nothing here reads a count.

   FIELDS
     id     stable key, stored in trophyOwnedIds. Never change one without
            migrating the saved ids, or every player silently loses the trophy.
     name   shown under the icon.
     icon   square image path. Square, because the grid cells are square and a
            non-square icon letterboxes inside them.
     hint   the tooltip line. Optional.

   Order here is the order unowned trophies appear in; the profile screen sorts
   owned ones to the top on its own. */
const TROPHIES = [
  {
    id:   'beta-tester',
    name: 'Beta Tester',
    icon: 'assets/trophies/beta-tester.webp',
    hint: 'Played before the game was finished.',
  },
  { id:'rookie',    name:'Rookie',    icon:'assets/trophies/rookie.webp',    hint:'Your first win. Everyone starts somewhere.', threshold:0 },
  { id:'scout',     name:'Scout',     icon:'assets/trophies/scout.webp',     hint:'10 wins. You know the ropes now.', threshold:10 },
  { id:'gunner',    name:'Gunner',    icon:'assets/trophies/gunner.webp',    hint:'25 wins. A reliable shot.', threshold:25 },
  { id:'sergeant',  name:'Sergeant',  icon:'assets/trophies/sergeant.webp',  hint:'100 wins. Leading from the front.', threshold:100 },
  { id:'enforcer',  name:'Enforcer',  icon:'assets/trophies/enforcer.webp',  hint:'250 wins. No mercy.', threshold:250 },
  { id:'commander', name:'Commander', icon:'assets/trophies/Commander.webp', hint:'500 wins. The field is yours.', threshold:500 },
  { id:'vanguard',  name:'Vanguard',  icon:'assets/trophies/Vanguard.webp',  hint:'1,000 wins. First in, last out.', threshold:1000 },
  { id:'general',   name:'General',   icon:'assets/trophies/General.webp',   hint:'5,000 wins. A legend in the making.', threshold:5000 },
  { id:'master',    name:'Master',    icon:'assets/trophies/Master.webp',    hint:'10,000 wins. Untouchable.', threshold:10000 },
  { id:'legend',    name:'Legend',    icon:'assets/trophies/Legend.webp',    hint:'20,000 wins. Immortal.', threshold:20000 },
];

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
  //
  // `nojus-t` is the ACCOUNT subdomain, not the Worker name -- every Worker on
  // the account shares it, and it is unrelated to this game's own address.
  //
  // IT IS THE ONE PIECE OF STATE IN THIS FILE THAT NOTHING CAN DERIVE. There is
  // no same-origin trick for it: the clan registry is a separate Worker, so
  // when the game is served from *.pages.dev (or anywhere else) the only way to
  // reach it is by spelling the host out. That is why it is named once, here,
  // and auth.js/payments.js must not carry their own copies -- they read this.
  //
  // Changing it has two failure modes, and the second is the nasty one:
  //   * changing it here and not on the account breaks login, silently, because
  //     the game still loads and plays and only register/login fail;
  //   * changing the account and not changing it here breaks it the same way.
  // So: if either moves, move BOTH, then check with
  //   curl -s https://<this host> -o /dev/null -w '%{http_code}'
  CLAN_API_URL: 'https://clan-registry-api.nojus-t.workers.dev',

  // TDM Matchmaking backend (Cloudflare Worker + KV)
  //
  // Same-origin wherever the game is served by the thing that also runs the
  // lobby, which is the local Node server and the single-origin Worker.
  //
  // The pages.dev deployment is the exception and it is NOT cosmetic.
  // map-voting.js POSTs /api/match/vote and GETs /api/match/status against this
  // URL over plain fetch, and Pages has no /api/* at all -- it answers an
  // unknown path with index.html and a 200. So the vote POST would receive the
  // whole game as its "JSON" response and map voting would silently fail in a
  // live match while looking fine on the Worker. The lobby is a Durable Object
  // and only the Worker can host it, so that is where these calls belong.
  MATCHMAKING_URL: (
    location.protocol.indexOf('http') === 0 && !/(^|\.)pages\.dev$/i.test(location.host)
      ? location.origin
      : (location.protocol.indexOf('http') === 0
          ? 'https://tanklg.nojus-t.workers.dev'
          : 'http://localhost:18123')
  ),

  // World
  WORLD_SIZE:      450,   // 3x bigger open battlefield
  GRID_DIVISIONS:  60,    // ground shader grid lines
  TANK_Y:          1.2,   // all tanks drive at this Y (flat, like the reference)

  // Camera (over-the-shoulder / angled top-down follow, see camera.js)
  CAM_DIST_MIN:    12,
  CAM_DIST_MAX:    160,
  CAM_DIST:        80,    // default
  CAM_HEIGHT:      33,
  CAM_PITCH:       0.95,  // downward tilt factor
  CAM_LERP:        0.14,
  CAM_ZOOM_STEP:   2.5,
  CAM_ROTATE_SPEED: 2.0,  // radians per second for keyboard camera orbit
  CAM_SWIPE_SENSITIVITY: 0.008, // radians per pixel for swipe camera rotate

  // Tanki Online Dynamic camera
  CAM_MOUSE_SENS: 0.003,        // radians per pixel of mouse movement
  CAM_CHASE_LERP_FAST: 0.04,    // lerp when moving fast (more lag)
  CAM_CHASE_LERP_STOP: 0.15,    // lerp when stopped (catch up fast)
  CAM_TOPDOWN_ANGLE: 35,        // degrees - threshold for top-down mode

  /* BRAWL-STYLE CAMERA: 6 zoom steps, one layout.

     The camera never rotates: it is parked behind the tank at the start of
     the match (looking toward the arena centre), follows the tank's position
     only, and the mouse cursor is the aim. The wheel steps between these six
     distances; every stop is the same angled top-down view, so zooming never
     flips the controls the way the old third-person/strategic pair did.
     dist is the horizontal offset; height = dist * tan(pitchDeg). Stop 2 is
     the default. Six entries are kept because the saved cameraStage and the
     clamps in game.js assume indices 0..5. */
  CAMERA_STOPS: [
    { mode:'strategic', dist:22, pitchDeg:60 },   // 0 — close
    { mode:'strategic', dist:30, pitchDeg:60 },   // 1
    { mode:'strategic', dist:38, pitchDeg:60 },   // 2 — default
    { mode:'strategic', dist:48, pitchDeg:60 },   // 3
    { mode:'strategic', dist:60, pitchDeg:60 },   // 4
    { mode:'strategic', dist:75, pitchDeg:60 },   // 5 — widest
  ],

  /* The only camera view: top-down like Brawl Stars. Degrees above the
     horizon; 90 would be straight down (lookAt breaks there). */
  TOPDOWN_PITCH_DEG: 85,

  /* Six selectable top-down angles. The viewing DISTANCE stays the same for
     all of them (viewDist is one length, tilted); only the pitch changes.
     Index 0..5, and 40 is index 0 because it is the default -- a lower, more
     horizontal view that shows the field ahead instead of the tank's roof.
     Adding an entry here also means widening the camPitchIdx allow-list in
     loadSettings below, or the choice is dropped on the next save. */
  CAM_PITCH_OPTIONS: [40, 45, 50, 60, 80, 85],

  /* How far up or down a shell can leave a level gun. The gun model never tilts. */
  SHOT_PITCH_DEG: 8,

  // Mode 1 crosshair pitch: mouse-Y moves the CROSSHAIR, not the camera.
  AIM_PITCH_UP_DEG:   18,      // how far the aim can rise above horizontal
  AIM_PITCH_DOWN_DEG: 8,       // how far it can dig below horizontal
  AIM_PITCH_SENS:     0.0022,  // radians of pitch per pixel of mouse-Y
  AIM_PITCH_CURSOR_PX: 120,    // screen px the crosshair rides per full UP pitch

  // Shells fly this far, whatever the tank def says ("remove the range limits")
  // 500m firing distance - shell deleted when it flies off the map
  SHELL_MAX_RANGE: 500,

  // Drift / handbrake
  DRIFT_MIN_KMH:   14,   // need at least this speed to drift (km/h)
  DRIFT_MIN_SPEED_FRAC: 0.6, // ...AND at least 60% of this tank's own top speed
  DRIFT_TURN_BOOST:3.0,   // body turns this many times faster while drifting
  DRIFT_FRICTION:  0.72,  // velocity retained per second while drifting (higher = slides more)
  /* TURNING UNDER LOAD.

     A tank turning at full speed should carve a wide arc, not pivot on the
     spot. Every tank here has its velocity forced to point exactly along
     `heading` (tank.js writes linvel = forward * desiredSpeed every frame), so
     without this the hull spins instantly under throttle and the turn radius is
     identical at 0 km/h and at top speed. That is the single biggest difference
     from a physics-driven tank game, where momentum carries you through the
     corner and you have to plan the line.

     TURN_SPEED_PENALTY is how much of the turn rate is LOST at top speed: 0.55
     leaves 45%, so the arc opens up as momentum says it should.

     TURN_SPEED_MIN_GRIP is the limit, and it matters more than the penalty.
     Without a floor a heavy tank at speed would barely respond to steering,
     which is the classic way a "realistic" model becomes an unusable one. 0.35
     means a tank always keeps at least a third of its turn rate however fast it
     is going, so it can always be turned around and can never be trapped in a
     circle it cannot leave. */
  TURN_SPEED_PENALTY:  0.55,
  TURN_SPEED_MIN_GRIP: 0.35,
  U_TO_KMH:        3.6 * 0.6,

  /* REVERSE SPEED.

     Written as the PENALTY, not the fraction, because that is the number a
     designer actually reasons about: reversing costs you a 1.5x speed penalty,
     so you go two-thirds as fast backwards. The fraction 1/1.5 = 0.6667 is what
     the code consumes.

     It was 2.0, which is a factor of 0.5 — and it lived in TWO places, one of
     which was a clamp the throttle never reached. So the live physics path and
     the no-physics fallback could not be changed together and had never agreed
     about what "reverse" means. One value, both sites. */
  REVERSE_SPEED_PENALTY: 1.5,

  /* IMPACT PHYSICS -- hits shove, blasts push, guns push back.

     The drive code rewrites a tank's linvel along `heading` every frame, so a
     one-off setLinvel knockback survives exactly one frame (that is why the
     shotgun needed to nudge position instead). Tank.pushImpact feeds an
     EXTERNAL velocity that the drive loop adds AFTER its own write and that
     decays on its own -- a shove slides the hull for ~0.3s and is then gone,
     without touching aim, ranges, top speed or any trajectory the player
     was shown.

     Weight matters: the shove is scaled by 30/tank mass, so a 14t scout gets
     thrown and a 58t artillery barely nods. IMPULSE_DV_MAX caps any single
     shove (velocity units). IMPULSE_WOBBLE turns the same hit into a yaw
     twitch -- the hull visibly whips toward the shove instead of sliding
     only. RECOIL_DELTA_V is the shooter's own push-back on firing a standard
     shell (the mortar fires heavier, so it gets a multiplier in code). Zero
     any value here to switch that piece of the behaviour off.                  */
  IMPULSE_DV_MAX:       4.0,   // hardest single shove, velocity units
  IMPULSE_EXT_DECAY:    3.5,   // shoved velocity: e^(-3.5t) ≈ 0.3s of slide
  IMPULSE_WOBBLE:       0.25,  // radians/s of yaw twitch per velocity unit
  IMPULSE_WOBBLE_DECAY: 5.0,   // the twitch settles faster than the slide
  IMPULSE_SHELL_HIT:    0.072, // dv per damage point on a direct hit (34dmg ≈ 2.4)
  IMPULSE_RICO_FRAC:    0.30,  // ...this fraction of it on a ricochet
  IMPULSE_PELLET_FRAC:  0.30,  // ...and per shotgun pellet (ten land, tiny each)
  IMPULSE_BLAST:        0.055, // dv per splash point at the blast centre, linear falloff
  IMPULSE_BLAST_HOP:    1.1,   // small vertical pop at the centre (physics tanks only)
  RECOIL_DELTA_V:       0.55,  // (legacy, unused: see SHOT_RECOIL)

  /* THE GUN PUSHES ITS OWN TANK BACK (Tank.applyShotRecoil).
     Velocity units per shot, before the tank's own recoilResist divides it.
     Burst kicks hardest, Grom a step below, everything else well under Grom.
     In the air the shove is multiplied by AIR_MULT and is not worn away by
     the tracks, so a mid-air shot really throws the tank. */
  SHOT_RECOIL: {
    base: 1.5,
    byTank: { burst: 8.5, grom: 6.0, mortar: 2.4, double: 1.1, demolisher: 2.0, predator: 1.8 },
    AIR_MULT: 2,        // airborne shots shove this many times harder
    MAX_SPEED: 45,      // no chain of shots can push a tank faster than this
    MAX_LIFT: 6,        // most upward speed a downward shot may give
    ROCK: 0.05,         // hull rock per unit of shove
  },

  /* ONE ENGINE PER TANK (Tank._engine). Multipliers on the numbers a tank's
     mass, accel and turn already give it; anything not listed stays 1.
     power/brake/coast/sideGrip/turnAccel/turnBrake/airControl/airDrag/
     tilt (soft suspension = more) /suspDamp/stability/slopeLoss/recoilResist. */
  TANK_ENGINES: {
    ghost:      { power: 1.25, brake: 1.2, coast: 0.8, sideGrip: 0.75, turnAccel: 1.3, airControl: 1.5, tilt: 1.3, stability: 0.8, slopeLoss: 0.8, recoilResist: 0.8 },
    burst:      { power: 1.15, coast: 0.85, sideGrip: 0.85, turnAccel: 1.15, airControl: 1.2, tilt: 1.15, stability: 0.9, recoilResist: 0.75 },
    hellfire:   { power: 1.1, sideGrip: 0.9, turnAccel: 1.1, airControl: 1.1, tilt: 1.1 },
    grom:       { power: 0.95, brake: 1.05, sideGrip: 1.05, tilt: 0.95, suspDamp: 1.1, recoilResist: 0.9 },
    demolisher: { power: 0.9, brake: 0.9, coast: 1.1, sideGrip: 1.15, turnAccel: 0.9, airControl: 0.7, stability: 1.15, recoilResist: 1.2 },
    predator:   { power: 1.0, brake: 1.15, sideGrip: 1.2, turnAccel: 1.05, suspDamp: 1.2, stability: 1.1 },
    helix:      { power: 0.95, brake: 1.0, sideGrip: 1.1, turnBrake: 1.15, stability: 1.1, slopeLoss: 0.9 },
    striker:    { power: 1.05, brake: 1.1, sideGrip: 1.0, turnAccel: 0.95, tilt: 0.9, suspDamp: 1.15 },
    striker2:   { power: 1.0, coast: 1.15, sideGrip: 1.1, turnAccel: 0.9, stability: 1.2 },
    bradley:    { power: 0.9, brake: 0.95, coast: 1.2, sideGrip: 1.25, turnAccel: 0.85, airControl: 0.6, tilt: 0.85, stability: 1.25, slopeLoss: 0.85, recoilResist: 1.2 },
    double:     { power: 0.8, brake: 0.85, coast: 1.25, sideGrip: 1.35, turnAccel: 0.75, turnBrake: 0.85, airControl: 0.4, tilt: 0.7, suspDamp: 1.3, stability: 1.4, slopeLoss: 0.8, recoilResist: 1.5 },
    mortar:     { power: 0.85, brake: 0.9, sideGrip: 1.2, turnAccel: 0.8, airControl: 0.5, tilt: 0.8, stability: 1.3, recoilResist: 1.3 },
    sturmratte: { power: 1.1, brake: 1.1, sideGrip: 0.95, turnAccel: 1.1, airControl: 1.1, slopeLoss: 0.85 },
  },

  // Combat
  SHELL_SPEED:     90,
  SHELL_LIFE:      3.0,
  FLAME_RANGE:     18,
  FLAME_DPS:       0,

  // Trajectory line (aim assist). 0.30 by default: white, narrow, 30% opacity
  // — the strategic flight-path look the player asked for. Still adjustable
  // from Settings → Aim line.
  AIM_LINE_OPACITY: 0.30,
  AIM_LINE_COLOR:   '#ffffff',

  // View range circle (spotting)
  VIEW_RANGE_OPACITY: 0.25,
  VIEW_RANGE_COLOR:   '#ffffff',
  VIEW_RANGE_WIDTH:   0.5,   // 0 = narrow ring, 1 = fat ring

  // Camouflage
  BUSH_HIDE_RADIUS:   3.2,   // a tank within this distance of a bush is hidden
  TREE_HIDE_RADIUS:   4.0,   // tree canopy gives partial camo (less effective)

  /* ============================================================================
     COVER IN TWO PHASES

     Phase 1 -- TOUCHING cover. The moment any part of the hull is under foliage
     the tank fades to BUSH_PHASE1_OPACITY: it loses 80% of its opacity, so you
     can still see where it is, but it stops reading as a silhouette against
     the leaves. The nametag fades with it.

     Phase 2 -- FULLY HIDDEN. Reached only after BUSH_PHASE2_TIME of not
     breaking any of three rules:

       1. stay in cover for the whole time (2.0s),
       2. do not fire (a shot shakes the leaves and gives you away),
       3. do not drive faster than BUSH_PHASE2_MAX_KMH inside the cover.

     Break any of them and the tank drops straight back to phase 1, and the
     clock starts again -- so a tank that fires and then sits still is visible
     for another two seconds, which is what makes breaking cover cost something.

     BUSH_BODY_LINK is what makes a ROW of bushes behave as one bush. Two
     bushes whose discs are within this many units of each other belong to the
     same body, so hiding in one and creeping to its neighbour keeps phase 2:
     the tank never left the shrubbery, it just moved inside it. Crossing open
     ground to an unconnected bush starts the two seconds over. */
  BUSH_PHASE1_OPACITY:  0.2,   // 80% of the tank's opacity is lost
  BUSH_PHASE2_TIME:     2.0,   // seconds of stillness before full invisibility
  BUSH_PHASE2_MAX_KMH:  5,     // faster than this inside cover and you stay at phase 1
  BUSH_BODY_LINK:       2.5,   // gap between bush discs that still counts as ONE bush
  BUSH_BODY_GRACE:      1.5,   // seconds the progress survives between linked bushes

  /* COVER BY OVERLAP, not by distance-to-centre.

     A tank is hidden once at least COVER_HIDE_FRACTION of its footprint is
     under foliage. The centre test that hidingIn()/camoFactor() use cannot
     express this: it calls a tank hidden while it is mostly poking out past a
     small bush, and exposed while a big tank is almost swallowed by a large
     tree. See World.coverOverlap(). */
  COVER_HIDE_FRACTION: 0.5,   // 50% of the footprint covered == hidden
  /* Samples per axis across the footprint. 5x5 quantises the result to
     multiples of 4%, far finer than the 50% threshold needs, and 25 point
     tests per tank is nothing beside the physics step. */
  COVER_SAMPLES: 5,
  /* How far from the tank's centre a footprint sample may sit and still count
     as covered. Deliberately separate from the plants' own hide radii, so a
     small tank is coverable by a big tree and a big tank by a small bush. */
  COVER_SAMPLE_REACH: 1.6,

  /* Cover is only worth anything if it can be broken, so moving or firing while
     under foliage shakes it and gives you away. This is how long the reveal
     lasts after you stop: long enough that a bot which lost you has to go
     looking again, short enough that sitting still after a shot is not a
     permanent tell. */
  COVER_REVEAL_TIME: 2.0,
  /* How close to the START of the reload a shot still counts as "just fired",
     and therefore shakes cover. reloadLeft counts down from COVER of the gun,
     so this is a window at the top of the countdown: 0.35s covers the muzzle
     flash and the recoil a viewer would actually notice, without punishing a
     tank for the rest of a long reload. Read in the same units as
     COVER_REVEAL_TIME; see Tank._updateCover for why this comparison has to be
     `>` and not `<`. */
  COVER_FIRE_WINDOW: 0.35,
  /* Speed at which a tank counts as shaking the foliage. Below this you are
     creeping through cover without giving yourself away. */
  COVER_SHAKE_SPEED: 1.2,

  // Models
  MODEL_DIR:   'mini_tank_legends_models/',
  MODEL_EXT:   '.gltf',
  // Bump when any tank model file changes. Appended as ?v= to every
  // model request so browsers bypass the 7-day Cache-Control on
  // mini_tank_legends_models/*.
  /* 9: the .glb files under mini_tank_legends_models/ were replaced on
     2026-11-09 without a bump, so every browser that had seen v=8 kept drawing
     the old meshes for up to the 7-day cache window -- which reads exactly like
     "the model is right in Blender and wrong in the game". */
  MODEL_VER:   9,

  // Supers
  /* Supers charge by DEALING DAMAGE: this much fills the bar on a tank with the
     default meter. superCdLeft still holds the meter, counted down by damage. */
  SUPER_CHARGE_DAMAGE: 300,
  /* Fog of war (js/fog.js): how far a tank clears it = viewRange x this. */
  FOG_OF_WAR: true,
  FOG_VIEW_SCALE: 0.875,
  /* Pre-battle: seconds to choose a tank, then the animated VS card. */
  PICK_TIME: 15,
  VS_TIME: 3.5,
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

  teamDeathmatch: {
    id:'teamDeathmatch', name:'Team Deathmatch', maxTanks:11, botCount:10,
    teamSize: 5,
    glbUrl:'assets/maps/TL_map_ruins.glb',
    glbScale: 50,
    /* Knockout: three rounds, first to two, one life a round, two minutes a
       round. Kept here as well as in game.js because the map vote and the
       mode cards read this block. */
    roundsToWin: 2,
    maxRounds: 3,
    roundTime: 120,
  },

  captureTheCircle: {
    id:'captureTheCircle', name:'Capture the Circle', maxTanks:11, botCount:10,
    teamSize: 5,
    glbUrl:'assets/maps/TL_map_ruins.glb',
    glbScale: 50,
    /* Seconds to fill the circle uncontested.

       The owner asked for 2x faster matches and named this one specifically,
       so it is the only number that changed. Tank speed, turn rate, respawn and
       the spawn shield are all untouched, and because those live on the tank
       definitions rather than in this block, they were never at risk of moving
       with it.

       Halving it also halves the match: the circle only ever fills at the same
       rate, so a win that took 100 seconds now takes 50 and a 100-second
       stalemate resolves in 50 too. Two tanks inside still capture at double
       rate — capture-circle.js scales by `blueIn >= 2 ? speed * 2 : speed` — so
       a contested circle is proportionally faster in both versions and the
       relationship between them is unchanged. */
    captureTime: 25,
    circleRadius: 12,
    respawnTime: 5,        // seconds dead before you come back at YOUR spawn point
    spawnShield: 3,        // invulnerability after that respawn (fixed spawn = campable)
  },

  /* BASE DEFEND — the map's `base` entity, made destructible.

     The whole mode hangs off one idea: a map declares where each team's base
     stands by naming a node, and this mode gives that node hit points. First
     team to take the enemy's base to zero wins.

     UNLIMITED RESPAWNS are the point, not a convenience. Killing every tank on
     the field wins you nothing here, so a wipe has to be recoverable — which is
     exactly how Capture the Circle already behaves, and the reason its starter
     is the one this mode was cloned from.

     A map with no `base` entity still loads: BaseDefend places a pair at the
     spawn clusters instead. See base-defend.js. */
  baseDefend: {
    id:'baseDefend', name:'Base Defend', maxTanks:11, botCount:10,
    teamSize: 5,
    glbUrl:'assets/maps/TL_paperland.glb',
    glbScale: 130,
    /* Paperland's world boundary, stated here for the same reason Core's is
       stated in map-voting.js: it is what _fitWorldToMap derives for this map
       with its 500 floor removed — 308 / 2 x 1.08 = 166.3, so 167.

       It matters here because Base Defend no longer takes its map from the vote
       (see Game.startBaseDefend), so this file is the ONLY place paperland is
       described, and _fitWorldToMap is called with `voted` — an ARENA map, not
       this one. Without a number of its own, paperland's boundary was being set
       from whatever arena happened to win the vote: at a floored 500 on a
       308-unit map the void kill fires ~190 units off the edge of the ground and
       the minimap draws half the arena. */
    worldHalf: 167,
    baseHp: 1000,          // hit points on ONE base
    baseSize: 16,          // edge length of the base cube, in world units
    respawnTime: 5,        // unlimited respawns, at your own spawn point
    spawnShield: 3,
  },

  /* STEAL THE FLAG — classic capture-the-flag on two team bases.

     The mode hangs off a map's `flag` entities — the same vocabulary Capture
     the Circle already reads. Kaukaz ships TWO of them, one standing in each
     team's base, and this mode makes each one a team's flag: touch the enemy
     flag to take it, run it home to your own one.

     A point is only SCORED while your own flag stands at home — if it has been
     stolen there is no exchange to make, which is what keeps a team from
     winning while theirs is out in the field.

     UNLIMITED respawns like the Circle and Base Defend — a flag that wins the
     match for whoever happens to be alive would turn 5 minutes of work into
     one ambush, and the tank who dies with a flag drops it where they fell:
     a TEAMMATE picking a dropped flag up keeps it, an ENEMY touching it sends
     it straight back to its own base.

     First team to 5 points wins. 5 minutes otherwise: higher score wins, a tie
     buys a 1-minute overtime in which every tank runs 1.25% faster and the
     FIRST point ends the match instantly. Nobody scores in overtime: draw. */
  stealFlag: {
    id:'stealFlag', name:'Steal the Flag', maxTanks:11, botCount:10,
    teamSize: 5,
    glbUrl:'assets/maps/kaukaz.glb',
    glbScale: 120,
    /* Kaukaz's own boundary (see the same field being described in
       map-voting.js): the model's bounds derive ~640 because the terrain
       extends well toward +Z, but every ACTION — spawns, both flags — lives
       inside ~440, so the arena is declared there rather than letting the
       boundary push players two map-widths out into empty terrain. */
    worldHalf: 470,
    pointsToWin: 5,        // first to five flags exchanged
    timeLimit: 300,        // 5 minutes; then upper score wins
    overtimeTime: 60,      // a tie buys this many seconds
    overtimeSpeedMult: 1.0125,  // +1.25% tank speed to every tank in overtime
    pickupRadius: 5,       // touch distance, flag take / take-down / return
    captureRadius: 9,      // how close to your own base the exchange happens
    respawnTime: 5,        // unlimited respawns, at your own spawn point
    spawnShield: 3,
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
     damage:34, reload:1, shellSpeed:180, shellRange:65,
     accel:18, shellType:'shell',
     mass:30, viewRange:105,
     armor:{front:10, sides:30, back:10},
     desc:'Balanced all-rounder with a 3-bomb airstrike. Tip: fight mid-range, use cover, and drop the airstrike on clustered enemies.',
     friction: 0.88,
     superType:'airstrike',
     airstrikeBombs:3, airstrikeDelay:3, airstrikeRadius:15, airstrikeDamage:70,
   },

  helix: {
    id:'helix', name:'Inferno', tier:2, collection:2,
    color:0xb5482a, turretColor:0xd86a3a,
    body:{ w:3.2, h:1.1, l:4.6 },
    turret:{ w:2.0, h:0.9, l:2.4 },
    barrelLen:1.2, barrelR:0.22,
    hp:220, speed:21, turn:1.7,
    turretTurn:2.6,
    damage:18, reload:0.10, shellSpeed:84, shellRange:40,
    accel:18, shellType:'flame',
    mass:34, viewRange:78,
    /* helix.glb (TL/fixed tanks/final). Re-measured, because this is a DIFFERENT
       model from the one the old numbers described: authored 12.87 along X and
       4.90 tall, where the old file was small enough that scale 1.0 worked. At
       scale 1.0 the new hull would be 25.7 live units — two and a half times
       Cool Buddy's 10.5 yardstick — so 0.408 (10.5 / (12.87 x 2)) is the only
       value that puts it in the same lineup. The muzzle `firing` sits at +X, so
       -90 turns the barrel down +Z like every other tank here. */
    /* Hull is authored long-axis along +X and the gun points the same way, so
       -90 is the correction that puts both on the game's +Z. This was 180,
       which left the hull broadside-on while the fallback muzzle pointed
       forward — a tank driving sideways and firing from a point that was not
       its barrel. */
    model:'helix', modelScale:0.408, modelYaw:-90,
    fireConeHalfAngle:0.18,
    armor:{front:30, sides:30, back:30},
    desc:'Flamethrower that melts tanks at point-blank and overheats 25% faster. Tip: close the gap behind cover, burn the target, then back off before overheat.',
    friction: 0.85,
    superType:'molotov',
    molotovRadius:24, molotovDuration:10, molotovDamage:16, molotovTick:0.3,
    overheatMult:1.25,
  },

  striker: {
    id:'striker', name:'Ark', tier:2, collection:2,
    color:0x3a6ea5, turretColor:0x5a93cf,
    body:{ w:3.685, h:2.153, l:6.288 },
    /* w/h/l are the turret's box dimensions the engine reads; x/y/z are the
       Tank Editor's measured turret mount point. Both live in one object —
       x/y/z on their own would leave w/h/l undefined and take the damage
       numbers and gun ribbons to NaN. */
    turret:{ w:1.7, h:0.75, l:2.6 },
    /* No measured pivot / firePoint / casingPoint any more. Those numbers were
       taken against TL_ark_fi; ark.glb is a different hull, and stale editor
       numbers do not fail loudly — they silently move the turret ring and the
       muzzle somewhere the new mesh is not. The loader measures both from the
       model itself when they are absent. */
    barrelLen:2.2, barrelR:0.13,
    hp:140, speed:23, turn:1.9,
    turretTurn:2.8,
    damage:30, reload:1.4, shellSpeed:280, shellRange:65,
    accel:20, shellType:'shell',
    mass:28, viewRange:135,
    // ark.glb (TL/fixed tanks/final) — authored hull root, turret root, a
    // "firing" muzzle empty, a recoiling "gun" and a "shell" casing port.
    // Built lengthwise along +Z with the muzzle at -Z, so it needs a half turn:
    // at yaw 0 the barrel reads [0,0,-1] and the tank would shoot backwards.
    // Scale: authored 10.04 long, and live length is authored x modelScale x 2
    // (Tank doubles the scale at load), so 0.523 lands it on the 10.5-unit
    // yardstick every other hull is measured against. Measured with
    // tools/glb-measure.cjs, not guessed.
    model:'ark', modelScale:0.7845, modelYaw:180,
    rig:{ hull:['Cube.015'], turret:'Cube.019', gun:'gun' },
    /* 140 HP and the longest barrel in the game: it dies to anything that sees
       it first, so a bot driving one goes and hides in foliage on its own side
       when it has no shot worth taking. Read by BotBrain._wantsCover(). */
    seeksCover:true,
    armor:{front:30, sides:30, back:30},
    desc:'Glass cannon with fast, long-range shells. Tip: stay at max range, never trade shots up close, and use the Giant Bush super to ambush.',
    friction: 0.90,
    superType:'bush',
    bushMax:3, bushScale:4,
  },

  ghost: {
    id:'ghost', name:'Ghost', tier:3, collection:3,
    color:0x4a4f55, turretColor:0x6c7278,
    body:{ w:2.3, h:0.85, l:3.6 },
    turret:{ w:1.4, h:0.7, l:1.9 },
    barrelLen:1.1, barrelR:0.11,
    hp:120, speed:34, turn:2.6,
    turretTurn:3.2,
    damage:14, reload:0.45, shellSpeed:190, shellRange:65,
    accel:30, shellType:'shell',
    mass:18, viewRange:110,
    /* ghost.glb (TL/fixed tanks/final): 6.83 long on Z, muzzle `firing` at +Z,
       so no yaw correction — the old -90 was correcting a model that is no
       longer loaded. 0.768 = 10.5 / (6.83 x 2). */
    model:'ghost', modelScale:0.768, modelAutoFlip:false,
    /* `outline:false` used to be set here, and it made Ghost the only tank in the
       game with no silhouette. That was invisible while outlines were broken
       everywhere anyway; now that every other tank has a working hull, Ghost is
       the one tank that reads as flat and unfinished next to them -- which is
       what "almost invisible" looked like in a battle. Its cloak already handles
       the see-through-when-stealthy brief, so it does not need to give up its
       outline as well. */
    playAnims:false,
    armor:{front:30, sides:30, back:30},
    desc:'Tiny and the fastest tank in the game; cloaks to ambush. Tip: flank, take one shot, cloak and relocate before the enemy turns.',
    friction: 0.82,
    superType:'cloak',
    cloakWindup:0.3, cloakMax:8, cloakSpeedMult:1.4, cloakFirstShotMult:2.5,
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
    /* Same helix.glb the Inferno drives, so it needs the same measured numbers
       (0.408 / -90): at the old 1.0 this target dummy was a 25-unit slab. */
    model:'helix', modelScale:0.408, modelYaw:-90,
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
    body:{ w:8.303, h:2.671, l:5.8 },
    /* w/h/l are the turret's box dimensions the engine reads; x/y/z are the
       Tank Editor's measured turret mount point. Both live in one object —
       x/y/z on their own would leave w/h/l undefined and take the damage
       numbers and gun ribbons to NaN. */
    turret:{ w:2.6, h:1.1, l:3.2, x:0.785, y:3.921, z:0.009 },
    /* The point the hull turns about, in turret-parts space. */
    pivot:{ x:0.823, y:3.271, z:0 },
    /* Where the shell leaves the barrel, and where the spent casing drops. */
    firePoint:{ x:0, y:0.66, z:5.8 },
    casingPoint:{ x:3.559, y:3.573, z:0.001 },
    barrelLen:2.6, barrelR:0.24,
    hp:440, speed:13, turn:1.0,
    turretTurn:1.4,
    damage:42, reload:4.2, shellSpeed:160, shellRange:65,
    accel:10, shellType:'shell',
    mass:60, viewRange:95,
    /* Sturmratte is a wide multi-turret hull, the biggest of these models, which
       is why it needs a smallish scale.

       The GLB's own node transforms give ~16-17 across; the loader's box3
       measurement now reads 17.47 x 7.06 x 9.89, which is why the earlier 16.27
       figure and the 0.32 that was derived from it are both gone. At 0.30 the
       tank is 5.2 across in game units.

       The lesson from the original comment is kept, because it is the reason this
       number is small and deliberate: this was once 0.34, then "corrected" to
       0.12 from a measurement taken through a bug — the loader reported 43.78
       because six nodes shared one geometry and were rescaling each other.
       Deriving a scale from a measurement made by the code under test is how a
       wrong number becomes load-bearing. Re-measure after changing the model. */
    model:'TL_tashenratte_fixed', modelScale:0.45,
    /* WHICH WAY THIS MODEL IS AUTHORED.

       Tank Editor exported this as `modelFront:'-X', modelUp:'+X'`. That pair is
       WRONG and was not pasted in: -X and +X are the same axis, and
       Tank.solveModelQuat returns null for a parallel pair precisely because a
       tank cannot face along its own up. The null then falls back to a plain
       modelYaw of 0, so the model gets NO rotation at all and the tank drives
       across the map on its side — the exact failure the front/up pair exists to
       prevent. The editor's own UI says so on screen ("FRONT and UP cannot be
       the same axis"), but buildSetupJSON echoes whatever is in those two
       pickers without checking, so a bad pair still exports.

       Up is +Y, confirmed from the file: the GLB measures 17.47 x 7.06 x 9.89, so
       X is the length axis (front) and Y is the height axis (up). With
       front -X / up +Y the solved rotation puts model X onto the game's -Z and
       leaves model Y pointing up, which is the pose the tank is authored in.

       modelYaw stays absent on purpose: solveModelQuat already subsumes the yaw,
       and keeping both would spin the model twice. */
    modelFront:'-X', modelUp:'+Y',
    /* The editor's measured offset, x/y/z. NOTE: `_modelOffset` is the name the
       Tank Editor PRINTS for your reference — the game does not read that key.
       The value that actually moves the model is the `model:{x,y,z}` pair in the
       editor override (TANK_EDITOR_OVERRIDES, per-tank, in localStorage), which
       Tank._applyModelOverride reads into _modelOff. Saving it here would look
       like it worked and do nothing. */
    _modelOffset: { x:-0.77, y:0.858, z:0 },
    armor:{front:30, sides:30, back:30},
    desc:'Juggernaut with the most HP and massive shells. Tip: push the front line, anchor choke points, and let escorts cover your flanks.',
    friction: 0.92,
    superType:'panzers',
    panzerDelay:1.2, panzerCount:3, panzerLife:25, panzerHp:120,
  },

  rapid: {
    id:'rapid', name:'Rapid', tier:1, collection:1, removed:true,
    color:0x3a9a4a, turretColor:0x55b860,
    body:{ w:2.8, h:0.95, l:4.0 },
    turret:{ w:1.6, h:0.75, l:2.0 },
    barrelLen:1.4, barrelR:0.12,
    hp:160, speed:24, turn:2.0,
    turretTurn:2.6,
    damage:14, reload:0.30, shellSpeed:200, shellRange:65,
    accel:20, shellType:'shell',
    mass:26, viewRange:110,
    model:'coolbuddy', modelScale:8.4, modelFlipY:true,
    magSize:3, magReload:2.6,
    armor:{front:10, sides:20, back:10},
    desc:'3-shell magazine that unloads fast. Tip: dump all three into one target, then use cover during the reload.',
    friction: 0.88,
  },

  vulkan: {
    id:'vulkan', name:'Vulkan', tier:3, collection:3, removed:true,
    color:0xb83a3a, turretColor:0xd85a4a,
    body:{ w:3.6, h:1.25, l:5.2 },
    turret:{ w:2.4, h:1.0, l:2.8 },
    barrelLen:2.2, barrelR:0.2,
    hp:320, speed:15, turn:1.1,
    turretTurn:2.0,
    damage:30, reload:0.22, shellSpeed:180, shellRange:65,
    accel:11, shellType:'shell',
    mass:48, viewRange:100,
    model:'sturmratte', modelScale:2.1,
    magSize:5, magReload:4.5,
    armor:{front:30, sides:30, back:30},
    desc:'Heavy 5-shell rotary burst. Tip: commit to one target and keep firing; reposition only after the magazine empties.',
    friction: 0.92,
  },

  panzer: {
    id:'panzer', name:'Panzer', tier:3, collection:0, removed:true,
    color:0x6a6e72, turretColor:0x8a9096,
    body:{ w:2.0, h:0.85, l:3.0 },
    turret:{ w:1.2, h:0.65, l:1.6 },
    barrelLen:1.0, barrelR:0.11,
    hp:60, speed:28, turn:2.2,
    turretTurn:3.0,
    damage:7, reload:0.8, shellSpeed:190, shellRange:65,
    accel:24, shellType:'shell',
    mass:14, viewRange:90,
    /* ghost.glb (TL/fixed tanks/final) is 6.83 long, so the escort panzer's
       0.25 was sizing it against the OLD ghost and left it 3.4 units — a toy
       next to the tank it escorts. 0.384 is 8/ (6.83 x 2): deliberately just
       under a full tank, since it is an escort. */
    model:'ghost', modelScale:0.384,
    armor:{front:10, sides:20, back:10},
    desc:'Escort panzer for the Sturmratte. Tip: screen for the big tank and draw fire away from it.',
    friction: 0.85,
  },

  /* ============================================================================
   DEMOLISHER — was "Vortex". Same tank, renamed, and now with a real model.

   The old Vortex borrowed the Inferno's model, which is why it looked like a
   flame tank that threw mines. It has its own model (TL_demolisher.glb) and its
   own landmine (assets/TL_landmine.glb).

   THE MINE NOW FLIES. It used to appear already on the ground, which read as a
   mine being placed rather than thrown — and it meant a mine could land on top
   of a tank already inside its blast radius with no way to react. It is launched
   on a shallow arc with a fixed flight time and only arms when it touches down;
   see projectile.js (ShellType 'vortex_mine') for the arc.
   ========================================================================== */
  demolisher: {
    id:'demolisher', name:'Demolisher', tier:1, collection:1,
    color:0x7a4aaa, turretColor:0x9a6acc,
    body:{ w:3.2, h:1.05, l:4.6 },
    turret:{ w:1.8, h:0.85, l:2.4 },
    barrelLen:1.2, barrelR:0.16,
    hp:240, speed:22, turn:1.8,
    turretTurn:2.4,
    damage:0, reload:3.0, shellSpeed:0, shellRange:0,
    accel:18, shellType:'vortex_mine', mineMaxRange:10,
    /* How the mine is thrown: a shallow arc over `mineFlight` seconds rather
       than appearing. Slow enough to be dodgeable, which is the entire point of
       a thrown mine over a dropped one. */
    mineFlight:0.85, mineArc:1.7,
    mass:32, viewRange:105,
    /* Hull and launcher are authored long-axis along +X, so -90 is the
       correction that puts the tube on the game's +Z. The previous 180 left the
       hull broadside-on and the tube pointing -X. */
    model:'demolisher', modelScale:0.843, modelYaw:-90,
    /* RIGGED BY NAME, and the names are the RUNTIME ones. GLTFLoader strips the
       dots from glTF node names on the way in, so "Cube.001" arrives as
       "Cube001" — declaring the dotted spelling silently finds nothing and falls
       through to the altitude split, which is exactly the failure this rig exists
       to prevent. Read the names off the loaded scene, not off the file.

       This model ships a proper `turret` group already, holding `gun` and
       `firing`, so the declaration is short. The hull is everything else: the
       body is `Cylinder010`, and `Cylinder001` is a small parented sub-assembly
       that travels with it. Listing all three is what makes the hull one node
       the loader can rotate about. */
    rig:{ hull:['Cylinder010','Cylinder001'], turret:'turret', gun:'gun' },
    mineDamage:65, mineRadius:4.5, mineFuse:30, mineProximity:3.0,
    armor:{front:15, sides:25, back:15},
    desc:'No gun; throws landmines up to 10m ahead. Tip: seed mines across choke points and retreat paths, not at the enemy directly.',
    friction: 0.88,
    superType:'mine_dash', dashTime:1.3, dashSpeedMult:3, dashMineEvery:0.14,
  },

  /* ============================================================================
     GROM — collection 1, slot 5.

     NOT THE MORTAR, and that is the whole design. Grom fires SPLASH shells: it
     is a direct-fire gun that happens to burst, not a lobbed artillery piece.

     The consequences are deliberate and all of them matter:

       splash 5.0        a third smaller than the Mortar's 7.5, so it is a
                         close-range burst weapon and NOT a long-range one
       splashMinRange 0  no dead zone at all. The Mortar's 22m minimum is what
                         makes it artillery; without it Grom can shoot its own
                         feet, which is correct for a tank with a normal gun
       shellType 'shell' a real, fast, direct-fire shell. It travels flat and
                         fast — not lobbed, not solved as an arc
       armor 0/0/0       NO ARMOUR, per the brief. It is paper: every hit
                         anywhere hurts, and ricochets off it freely
       hp 150 / speed 22 the "mid hp, mid mobility" the brief asked for —
                         between the Durable Rapid and the armoured line
     ========================================================================== */
  grom: {
    id:'grom', name:'Grom', tier:1, collection:1,
    color:0x4a6a4a, turretColor:0x5f7f5f,
    body:{ w:3.1, h:1.05, l:4.5 },
    turret:{ w:1.9, h:0.85, l:2.5 },
    barrelLen:1.9, barrelR:0.15,
    hp:150, speed:22, turn:1.7,
    turretTurn:2.2,
    /* The splash is the weapon. Damage is 0 on a direct hit: this is a burst
       shell, so the number that matters is splashDamage, not damage. */
    damage:0, reload:1.9, shellSpeed:150, shellRange:48,
    splashDamage:26, splashMinDamage:5, splashRadius:5.0,
    accel:16, shellType:'shell',
    /* The shell is a different object and it SPINS. See projectile.js — a
       tumbling HE shell is read very differently from a clean tracer, and it is
       the clearest possible "this one bursts" tell at a glance. */
    shellModel:'TL_bullet_f', shellSpin:6.0,
    mass:30, viewRange:95,
    /* HULL AND BARREL ARE BOTH LONG-AXIS ALONG X, with the barrel pointing
       -X. Yaw +90 therefore puts the hull nose and the muzzle on the game's
       +Z. The old "no yaw" note was measured through the fallback barrel end,
       which pointed +Z no matter where the real barrel was — the hull itself
       was sideways. */
    model:'tl_GROM_FIX', modelScale:0.45, modelYaw:90, muzzleAxis:'x',
    /* Named groups, because the launcher is nested INSIDE the turret rather than
       being a child of the hull — an altitude split would scatter it. */
    /* Runtime names — the GLB's "Cube"/"Cube.001" arrive as "Cube"/"Cube001".

       This one genuinely needs declaring. Its hull is a single `Cube` and its
       turret is `Cube001`, which already parents the launcher `Cylinder`, the
       `firing` muzzle and the eject port — but the LAUNCHER IS NESTED INSIDE THE
       TURRET and sits LOW, below much of the hull's own height. The altitude
       split would put barrel parts in the body and leave the turret half empty,
       so the gun would swing without the turret and the turret would rotate
       without its gun.

       IT NEEDS `hullRest`, NOT A LIST. This model exports EIGHTEEN roots: the
       body `Cube`, twelve road wheels in two rows, four skirt plates and a
       stowage box. The first attempt here named `hull:['Cube']`, which resolved
       fine and the turret turned fine — and was still completely wrong, because
       it captured the body alone and left the other seventeen roots where they
       were. It rendered as a bare lump: no wheels, no skirts, no visible gun.

       Naming seventeen nodes would fix it today and break silently on the next
       export, so `hullRest` is the honest statement: the hull is everything that
       is not the turret or the gun.

       Runtime names again (GLTFLoader strips the dots): "Cube.001" -> "Cube001". */
    rig:{ hullRest:true, turret:'Cube001', gun:'Cylinder' },
    armor:{front:0, sides:0, back:0},
    desc:'Splash shells with zero armour. Tip: fire at the ground next to targets to splash; never duel head-on.',
    friction: 0.9,
    superType:'big_shells', bigShellCount:3, bigShellRadiusMult:3, bigShellDamageMult:1.6,
  },

  /* ============================================================================
     BURST — the fastest thing in the game with a real punch.

     A spread gun: it throws a fan of glowing pellets and leans entirely on
     damage-per-second rather than per shot, which is why its range is short
     (~20m) and its reload quick. Sitting in collection 2 where the Shotgun used
     to be, because it replaces it mechanically.

     TWO SHELLS, ONE GEAR. The magazine holds two shells (magSize) and the GEAR
     — a switch button sitting before the super slot — chooses whether the
     trigger spends one or both of them:

        SINGLE  one shell, one fan, one shove backwards.
        SALVO   both shells in the same frame, twice the fan and TWICE the
                kick. With one shell loaded it falls back to a single shot,
                so the mode never wastes the trigger.

     The gear is a mode, not a reload: it costs a one-second cooldown and
     nothing else, so it can be flipped mid-duel.
     ========================================================================== */
  burst: {
    id:'burst', name:'Burst', tier:1, collection:2,
    color:0xc8a028, turretColor:0xe0c040,
    body:{ w:3.0, h:1.0, l:4.2 },
    turret:{ w:1.8, h:0.8, l:2.4 },
    barrelLen:1.4, barrelR:0.15,
    /* 30 km/h: faster than everything except the Ghost (34). */
    hp:140, speed:30, turn:2.3,
    turretTurn:2.9,
    /* 0.7s between shells, 2.6s for a dry magazine. Total cycle for the pair is
       3.3s either way, so SINGLE and SALVO land the same damage per second and
       the choice is about burst (pun intended) versus control. */
    damage:9, reload:0.7, shellSpeed:130, shellRange:20,
    magSize:2, magReload:2.6,
    /* THE KICK. Firing throws the hull backwards: knockbackForce is metres per
       second of reverse velocity and knockbackTilt is how hard the nose lifts.
       A salvo fires two shells, so it applies this twice — 2x the shove, which
       is the cost of the doubled damage. */
    knockbackForce:5.5, knockbackTilt:0.34,
    /* The gear switch. `modes` is cycled in order; `cd` is seconds between
       flips; labels are what the button and the toast print. */
    gear:{ modes:['single','salvo'], default:'single', cd:1,
           labels:{ single:'SINGLE', salvo:'SALVO' },
           desc:{ single:'one shell per trigger', salvo:'both shells at once, double kick' } },
    accel:26, shellType:'shotgun',
    /* Ten pellets per shot. Individually feeble, collectively a DPS weapon —
       and the triangle aim line exists to show the player the width of the fan,
       because a shotgun that looks like a rifle is a broken shotgun. */
    pellets:10, pelletSpread:0.16, pelletSpeedJitter:26,
    pelletGlow:0xffd24a,
    mass:26, viewRange:88,
    /* modelYaw 180, measured off the barrel rather than guessed. This model is
       exported nose-toward -Z, so at yaw 0 the muzzle reads [0,0,-1] — a tank
       that shoots backwards — and 180 puts it at [0,0,1]. Every other tank here
       reads [0,0,1] at yaw 0, which is what makes the comparison meaningful.

       Scale is derived, not chosen: Tank doubles modelScale at load, so live
       length is authored x modelScale x 2. Burst is authored 6.01 across, and at
       1.05 that put it at 12.6 — 20% longer than Cool Buddy (10.5), the yardstick
       every tank is measured against. 0.874 lands it on 10.5. */
    model:'burst', modelScale:0.848, modelYaw:180,
    /* Runtime names again — the GLB's "Cube.003"/"Cube.004" arrive dotless.
       `Cube003` is the body (two children of its own); `Cube004` is the turret
       and already holds `gun`, `firing`, the shell ports and the muzzle, so this
       model needs almost no help beyond saying which node is which. */
    rig:{ hull:['Cube003'], turret:'Cube004', gun:'gun' },
    armor:{front:11, sides:18, back:11},
    desc:'30 km/h, a ten-pellet spread and a two-shell magazine. GEAR fires one shell or dumps both (double kick). Tip: get inside 20m, aim centre mass, and keep firing.',
    friction: 0.88,
    superType:'nova', novaPellets:32, novaDamage:70, novaRadius:16,
  },

  predator: {
    id:'predator', name:'Predator', tier:1, collection:1,
    color:0x8a3a3a, turretColor:0xaa5a4a,
    body:{ w:3.0, h:1.0, l:4.4 },
    turret:{ w:1.8, h:0.8, l:2.4 },
    barrelLen:1.8, barrelR:0.14,
    hp:200, speed:20, turn:1.6,
    turretTurn:2.2,
    damage:7, reload:3.5, shellSpeed:180, shellRange:65,
    accel:15, shellType:'shell',
    mass:32, viewRange:105,
    /* Its own model now, not Cool Buddy's. This one is built flat — every part
       is a sibling root with no turret node to find — so the loader's altitude
       split is the correct rig for it rather than a fallback: the turret parts
       all sit well above the hull and there is nothing to disambiguate. */
    /* NO modelYaw. Predator's muzzle reads [0,0,1] at yaw 0 — the -90 that was here
       turned it onto its side, barrel across the tank. Scale 0.30 was authored 12.27
       long, landing at 7.4 live — 30% shorter than Cool Buddy and visibly stunted.
       0.428 puts it on the same 10.5 as everything else. */
    model:'predator', modelScale:0.799, modelYaw:180,
    /* predator.glb (TL/fixed tanks/final) ships its own `hull` and `turret`
       nodes, so the loader's named rig takes it apart correctly on its own. The
       long list of flat sibling roots that used to live here described the OLD
       paintover model and would match nothing in this file. */
    fireAnim:'gun firing',
    ejectShell:true,
    /* FIVE SHOTS, HALF A SECOND APART. The old value was 0.011s, which fired
       the whole burst as one frame — five shells leaving simultaneously reads
       as one odd shot, not as a burst. At 0.5s the burst is legible and the
       target has to actually move between rounds. */
    burstCount:5, burstDelay:0.5,
    /* 1.3x smaller shell: 1 / 1.3 = 0.769. */
    shellScale:0.769,
    armor:{front:10, sides:30, back:10},
    desc:'5-round burst, half a second between rounds. Tip: lead targets, fire the burst into their path, and reposition during the long reload.',
    friction: 0.88,
    superType:'hunt', huntTime:7, huntSpeedMult:1.35, huntReloadMult:3,
  },

  double: {
    id:'double', name:'Double', tier:1, collection:2,
    color:0x6a6a8a, turretColor:0x8a8aaa,
    body:{ w:3.0, h:1.0, l:4.4 },
    turret:{ w:2.0, h:0.85, l:2.4 },
    barrelLen:1.8, barrelR:0.13,
    hp:240, speed:13.2, turn:1.08,
    turretTurn:2.0,
    damage:34, reload:2.0, shellSpeed:200, shellRange:65,
    accel:12, shellType:'shell',
    mass:38, viewRange:100,
    model:'coolbuddy', modelScale:12.75, modelFlipY:true, muzzleZOff:0.15,
    fireAnim:'gun firing',
    ejectShell:true,
    magSize:2, magReload:2.5,
    doubleBarrel:true, doubleBonus:1.1,
    armor:{front:20, sides:35, back:20},
    desc:'Heavy double-barrel tank; toggle single/double fire for +10% combined damage. Tip: use double fire on slow targets, single for sustained fire.',
    friction: 0.82,
    superType:'twin_salvo', salvoShots:14, salvoEvery:0.09,
  },


  /* ==========================================================================
     MORTAR — ARTILLERY.

     Built deliberately as the worst tank in the game at everything a tank is
     normally judged on, and given one enormous thing it can do that nothing
     else can. Every offensive and handling number below is at or near the
     bottom of the roster; the splash radius is at the top of it.

     The two rules that make it feel like World of Tanks artillery:

       artilleryMinRange (22) > splashRadius (15)
         You physically cannot range it short enough to hit something close, so
         it has to fight at a distance like a real artillery piece instead of
         turning into a worse shotgun. It also means a shell can never land on
         its own hull — see Shell._detonate for why that is worth having.

       artilleryFlight
         The shell's flight time is FIXED and its velocity is solved backwards
         from the aim point, so the arc drawn on the aim line is the arc that
         flies. Every other shell in the game fires "wherever the barrel
         points".

     TL_mortar_fix.glb: authored barrel-down along +X with a "firing" muzzle
     empty under the gun arm, so modelYaw -90 puts the barrel on the game's +Z
     and the loader finds the muzzle with no help.

     THIS REPLACES TL_mortar.glb, which was replaced because it was visibly
     broken in three separate ways:
       * a cylinder stuck out of the front of the HULL, below the turret, and it
         was not the gun -- it was authored geometry on the hull mesh itself;
       * the turret carried a rusted diamond-plate steel texture while the hull
         was flat green, so the same tank read as two different machines;
       * the gun barrel was a SEPARATE mesh (Cylinder.005) parented to the gun
         arm, and the loader's own rigging rule drops any mesh whose parent is
         also a mesh -- so the barrel was MISSING from the battle and present
         only in the menu preview.
     The replacement has the barrel as a second primitive of the gun arm, a
     clean hull front, and green paint on both hull and turret.

     IT IS NOT Draco-compressed, which the original was. Instead it was
     repackaged: the two 2048x2048 PNG texture maps were converted to 1024x1024
     WebP, and the third map (MRA — a packed AO/roughness/metalness texture)
     was DELETED outright, because nothing in the game samples it: no code path
     copies metallicRoughnessMap onto the toon material and MeshToonMaterial has
     no such uniform. That took the file from 14.9 MB to 391 KB.
     ========================================================================== */
  mortar: {
    id:'mortar', name:'Mortar', tier:3, collection:3,
    /* These two are the model's OWN colours, read off the GLB's
       baseColorFactor values and converted from linear to sRGB:
         Material.001  (0.141, 0.270, 0.094) -> 0x698e57  hull
         Material.003  (0.138, 0.230, 0.110) -> 0x69855f  turret
       They are here so the garage, the HP bar and the stat tiles show the green
       the tank is actually painted, and so that any residual tint lands on
       green rather than on something arbitrary. */
    color:0x698e57, turretColor:0x69855f,
    /* The model arrives FINISHED — painted green, with wood-plank and metal-grid
       textures already on it. `keepModelPaint` stops the loader tinting it.

       Without this the tank takes the tint of `this.color`, which is the
       PLAYER's colour from the match server, not the def's — so the Mortar came
       out blue for a blue player and lavender for a lavender one. That is the
       whole of the "it should be green" bug; the def colour was never the
       problem. See applyMatColor in Tank._loadModel. */
    keepModelPaint: true,
    body:{ w:3.6, h:1.3, l:5.4 },
    turret:{ w:2.4, h:1.1, l:2.8 },
    barrelLen:3.0, barrelR:0.26,
    /* Everything below is bad on purpose. See the note above. */
    /* CUT 2.5x ON REQUEST: 90 -> 36.

       Lowest HP in the game by a wide margin -- it used to be 90 with Panzer at
       60 for second; now Panzer is the frailest thing in the game and the
       Mortar is 40% below it. "Everything below is bad on purpose" is doing a
       lot of work in this entry and this is the sharpest end of it.

       SAFE TO CHANGE IN ONE PLACE. maxHp is assigned straight from def.hp
       (tank.js:46) and every consumer either reads def.hp or the hp/maxHp
       RATIO, so nothing needed touching alongside it:

         health bar / damage flash   hp / maxHp            (ratio, fine)
         HP readout                  "36 / 36"            (follows)
         repair pickups              25% / full of maxHp  (items.js:194)
         power-ups                   maxHp * powerMult()  (tank.js:3295)
         bot self-preservation       hp / maxHp            (bot.js:118)
         garage stat tiles           def.hp               (menu.js, tank-menu.js)

       There is no floor on hp anywhere, so 36 is taken at face value.

       WHAT 36 ACTUALLY MEANS IN A FIGHT, because it is now small enough that
       the number of hits matters more than the tank:

         1 shell   Sturmratte (42 dmg)
         2 shells  Coolbuddy, Double (34), Striker, Vulkan (30), Helix (18)
         3 shells  Ghost, Rapid (14)
         6 shells  Panzer, Burst, Predator

       So it is a two-shot tank against most of the roster, and a single burst
       from a Sturmratte deletes it outright. The 10 second reload is what makes
       that survivable: a shell that costs you the match has to be worth
       landing, which is the trade this whole entry is built on. It also means
       the spawn shield (3s) and cover-seeking behaviour below matter more than
       they used to -- there is no room to trade a shot at all.

       PAIRED WITH THE 3x SPLASH ABOVE, the two changes together swing its trade
       efficiency 7.5x: 38 damage per 100hp of tank before, 283 after. It is now
       a glass cannon rather than a slow heavy. That is a big swing for one
       tank, and it is the reason to playtest it before shipping rather than
       assume 3x and 2.5x are independent. */
    hp: 100,
    speed: 13.5,
    /* turn / turretTurn are authored at HALF the finished number: the handling
       pass below multiplies both by 2 for every tank. 0.45 -> 0.9 rad/s is
       still a third of Double's, which is the sluggish hull this roster had. */
    turn: 0.45,
    turretTurn: 0.60,
    damage: 0,                               /* no direct hit at all — blast only */
    /* TRIPLED from 34 / 7 on request: 102 / 21.

       BOTH NUMBERS MOVE, and that is the whole point. The blast is a linear ramp
       between them — _detonate works out minD + (maxD - minD) * (1 - d/R) — so
       raising only splashDamage would triple the centre and leave the rim at 7,
       and the average would land near 2.4x rather than 3x. Scaling both makes
       every point on the ramp exactly three times what it was:

           d = 0     34.0 -> 102.0    3.00x
           d = 3     23.8 ->  71.4    3.00x
           d = 7.5    7.0 ->  21.0    3.00x

       Nothing reduces splash on the way in: Tank.takeDamage subtracts the amount
       as it arrives, so def.armor never applies to blast — it only ever mattered
       for direct hits. These two numbers therefore ARE the weapon, and there is
       no second place to change them. The 34 / 7 hardcoded on the networked
       dummy shell in game.js is deliberately stale and harmless: that shell is
       built _networked and detonates vfxOnly, because the host owns damage.

       WHAT IT DOES TO THE ROSTER. This was the lowest damage-per-second tank in
       the game by a wide margin — 3.4, against Coolbuddy's 34 and Double's 17.
       That is roughly what a 90 HP, 10-second-reload, worst-armour artillery
       piece with no direct hit is supposed to look like. At 102 it is 10.2:
       level with Sturmratte and Panzer, and still a long way behind everything
       that shoots faster than it.

       The one consequence worth knowing before playing it: blast is neither
       reduced by armour nor able to miss, so a centre hit is now 102 against a
       120 HP Ghost or a 200 HP Coolbuddy — two shells each, where it used to
       take six. It is a real one-shot threat on light targets. The 10 second
       reload is what pays for that. */
    splashDamage: 115,                       /* ...but it lands on a whole group */
    splashMinDamage: 24,
    /* HALVED from 15 on request: 7.5 is still the widest splash on the roster —
       the next widest thing in the game is a 4m airstrike bomb — but it is now a
       tight, precise circle rather than a field that swallows a convoy. It also
       widens the gap to artilleryMinRange (22m), so the shell cannot land on top
       of its own hull with even more room to spare. */
    splashRadius: 7.5,
    reload: 5,
    shellSpeed: 150,
    shellRange: 115,                         /* the longest reach on the roster */
    artilleryFlight: 1.9,                     /* seconds of flight, every shot */
    artilleryGravity: 34,                     /* MORTAR_GRAVITY in projectile.js */
    artilleryMinRange: 22,
    accel: 7.5,
    shellType:'mortar',
    mass: 58, viewRange: 80,                 /* cannot see far, cannot turn fast */
    model:'TL_mortar_fix', modelScale:0.62, modelYaw:-90,
    /* ============================================================================
       WHICH NODE PLAYS WHICH PART.

       The loader's fallback for a model with no "hull"/"turret" nodes of its own
       is to split its meshes by ALTITUDE: everything above 40% of the model's
       height becomes turret, everything below becomes hull. That default is wrong
       for this model, and visibly so.

       This tank is not built as a lump on a base. Its turret is a low, wide ring
       whose top sits barely above the hull's, and it carries the whole gun
       assembly as a child. Its hull, meanwhile, is TWO separate roots that overlap
       the turret in height. So the altitude split tore the tank apart: hull pieces
       landed in the turret group, the turret ring stopped following its own gun,
       and the gun swung independently of the turret it is bolted to.

       Declaring the rig here assigns each part by the node the author gave it:

         Cylinder010 + Cube007  the hull — both roots, which together are the body
         Cylinder                the turret — and the gun below rides inside it, so
                                turret rotation carries the gun automatically
         Cube003                 the gun — the hinged arm, local +X is the barrel,
                                local Z is the elevation hinge

       The muzzle `firing` empty is parented to Cube003 in the file, so naming the
       gun is the only extra information needed; the loader finds the muzzle inside
       the turret on its own.

       `gun` is optional everywhere it is read. A def that omits it gets the turret's
       own muzzle-carrying child, which is exactly TL_ark's arrangement.
       ============================================================================ */
    rig:{
      hull:  ['Cylinder010', 'Cube007'],
      turret:'Cylinder',
      gun:   'Cube003',
    },
    /* The model's barrel is authored along +X, not the +Z the game aims down,
       so the loader has to be told which axis the muzzle points on. Without it
       the shell leaves the tank sideways — see the note in Tank._loadModel. */
    muzzleAxis:'x',
    armor:{front:12, sides:20, back:8},      /* paper: it ricochets off things */
    desc:'Artillery that arcs over cover and splashes a whole group. Tip: stay behind cover, lob shells over obstacles, and never let enemies close to 22m.',
    friction: 0.93,
    /* 90 HP, no direct hit and a ten second reload is not a tank that can trade
       shots, so a bot driving one goes and hides in foliage on its own side
       when it has no shot worth taking. Read by BotBrain._wantsCover(). */
    seeksCover:true,
    /* The one thing that makes a ten second reload bearable, and the obvious
       pick for it: the shell IS the weapon, so cutting the reload cuts the
       rate of fire on that weapon. */
    superType:'barrage', airstrikeBombs:7, airstrikeDelay:1.2, airstrikeRadius:9, airstrikeDamage:40, airstrikeSpread:14, airstrikeStagger:70,
  },

  /* ============================================================================
     THE THREE TANKS THAT USED TO BE "COMING SOON" SIGNS.

     Collections 2 and 3 always carried three placeholder slots — Hellfire,
     Bradley and Striker — drawn as locked tiles with a planned name. Their
     models now exist (TL/fixed tanks/final), so the signposts are real tanks:
     the roster, the Collections screen and the research path all read this
     table, so those slots became rewards with nothing else to edit.

     SCALES AND YAWS ARE MEASURED, not guessed — tools/glb-measure.cjs prints
     both numbers for each file, and the rule is the same one every other tank
     here follows: authored long axis x modelScale x 2 = 10.5 live units, and
     the `firing` empty decides the yaw (a muzzle on +X needs -90, one on +Z
     needs nothing).

     IDS. `striker` is, and has to stay, the id of ARK — it is what saved
     profiles and bot rosters store. So the new Striker takes `striker2`; the id
     is internal, and every player-facing string is the display name.
     ========================================================================== */

  /* HELLFIRE — collection 2, slot 1. Small, quick, hits harder than it looks.
     Authored 3.27 long on Z with its muzzle on +Z, so no yaw correction and a
     1.605 scale (10.5 / (3.27 x 2)). Its `Cube` root carries the gun, the
     muzzle and the shell port, and there is no `hull` node at all — hence
     hullRest rather than a name list. */
  hellfire: {
    id:'hellfire', name:'Hellfire', tier:1, collection:2,
    color:0x38241c, turretColor:0xb4451f,
    body:{ w:2.2, h:0.9, l:3.4 },
    turret:{ w:1.3, h:0.7, l:1.9 },
    barrelLen:1.5, barrelR:0.12,
    hp:170, speed:26, turn:2.1,
    turretTurn:3.0,
    damage:24, reload:0.95, shellSpeed:210, shellRange:60,
    accel:24, shellType:'shell',
    mass:22, viewRange:112,
    model:'hellfire', modelScale:1.605,
    rig:{ hullRest:true, turret:'Cube', gun:'gun' },
    fireAnim:'gun firing',
    ejectShell:true,
    armor:{front:14, sides:24, back:10},
    desc:'Fast light tank with a quick gun and thin hull. Tip: flank and harass, never hold ground; use speed to disengage.',
    friction: 0.87,
    superType:'hunt', huntTime:6, huntSpeedMult:1.4, huntReloadMult:2.6,
  },

  /* BRADLEY — collection 2, slot 5. The autocannon: low damage per shell,
     very short reload, so it wins by never stopping. Ships its own `hull` and
     `turret` nodes, and the muzzle is on +X, hence -90. */
  bradley: {
    id:'bradley', name:'Bradley', tier:1, collection:2,
    color:0x4a5240, turretColor:0x6a7458,
    body:{ w:2.8, h:1.2, l:5.0 },
    turret:{ w:1.6, h:0.8, l:2.0 },
    barrelLen:1.6, barrelR:0.11,
    hp:230, speed:19, turn:1.7,
    turretTurn:2.7,
    damage:12, reload:0.32, shellSpeed:185, shellRange:58,
    accel:16, shellType:'shell',
    mass:34, viewRange:108,
    model:'bradley', modelScale:0.837, modelYaw:-90,
    fireAnim:'gun firing',
    ejectShell:true,
    armor:{front:18, sides:28, back:12},
    desc:'Autocannon with tiny shells and almost no reload. Tip: hold the trigger on one target; the constant fire stops them healing or repositioning.',
    friction: 0.88,
    superType:'panzers',
  },

  /* STRIKER — collection 3, slot 4. The heavy: one slow, heavy shell that
     really hurts. Muzzle on +X so -90; authored 10.29 long, 0.510 scale. Its
     turret node is `turret.001`, which GLTFLoader sanitises to `turret001` —
     declared here so the rig is exact rather than left to the altitude split. */
  striker2: {
    id:'striker2', name:'Striker', tier:2, collection:3,
    color:0x2c3a2e, turretColor:0x4a5c48,
    body:{ w:3.2, h:1.1, l:5.2 },
    turret:{ w:1.9, h:0.9, l:2.6 },
    barrelLen:2.4, barrelR:0.16,
    hp:200, speed:20, turn:1.6,
    turretTurn:2.1,
    damage:0, reload:2.3, shellSpeed:240, shellRange:70,
    splashDamage:52, splashMinDamage:12, splashRadius:4.0,
    magSize:3, magReload:5.0,
    accel:15, shellType:'shell',
    mass:38, viewRange:118,
    model:'striker', modelScale:0.510, modelYaw:-90,
    rig:{ hull:'hull', turret:'turret001', gun:'gun' },
    fireAnim:'gun firing',
    ejectShell:true,
    armor:{front:24, sides:30, back:14},
    desc:'Heavy sniper with a 3-shell magazine and splash shells. Tip: hold high ground, fire all three into a cluster, then reload behind cover.',
    friction: 0.9,
    superType:'big_shells', bigShellCount:2, bigShellRadiusMult:2.4, bigShellDamageMult:1.8,
  },
};

/* ── Handling pass ────────────────────────────────────────────────────
   Every tank's top speed, hull turn rate, turret turn rate and
   acceleration are doubled, in ONE place instead of by hand on thirteen
   stat blocks. Doing it here keeps the physics, the bots and the stat
   readouts in the garage all looking at the same numbers.
   Tweak these four numbers to retune the whole game.                    */
/* speed/accel sit at 1 so tanks drive at half the pace of the doubled pass —
   turn/turretTurn stay at 2, rotation is deliberately left alone. Acceleration
   is scaled with top speed, so a tank reaches its (lower) top speed in the
   same amount of time as before: everything about driving is simply half. */
const TANK_HANDLING_MULT = { speed: 1, turn: 2, turretTurn: 2, accel: 1 };
for(const _hid in TANKS){
  const _ht = TANKS[_hid];
  if(!_ht) continue;
  for(const _hk in TANK_HANDLING_MULT){
    if(typeof _ht[_hk] === 'number') _ht[_hk] *= TANK_HANDLING_MULT[_hk];
  }
}

/* What each super is called and does: the tank screen and the pick screen read this. */
const SUPER_INFO = {
  airstrike:  { name:'Airstrike',    icon:'\u2708',     color:0xffc040, desc:'Pick a spot: three huge bombs land there, each about three tanks wide.' },
  molotov:    { name:'Firestorm',    icon:'\u{1F525}',  color:0xff6a20, desc:'Sets a huge area on fire for 10 seconds. Big damage to anything inside.' },
  bush:       { name:'Giant Bush',   icon:'\u{1F33F}',  color:0x55cc55, desc:'Grows a giant bush around you to hide in.' },
  cloak:      { name:'Phantom',      icon:'\u{1F47B}',  color:0x99ddff, desc:'Almost instantly invisible and 40% faster for 8 seconds. Your first shot out of it deals 2.5x damage.' },
  panzers:    { name:'Panzer Squad', icon:'\u{1F6E1}',  color:0x88ccff, desc:'Three escort panzers drop in beside you and fight for 25 seconds.' },
  big_shells: { name:'Heavy Rounds', icon:'\u{1F4A5}',  color:0xff5533, desc:'Your next 3 shots burst three times as wide and hit harder.' },
  mine_dash:  { name:'Mine Dash',    icon:'\u{1F4A3}',  color:0xffe040, desc:'Dash forward at triple speed, leaving a trail of landmines.' },
  hunt:       { name:'Hunter Mode',  icon:'\u26A1',     color:0xffa030, desc:'For 7 seconds: reload three times faster and drive 35% faster.' },
  nova:       { name:'Nova Blast',   icon:'\u{1F4A2}',  color:0xffee66, desc:'A blast all around you that hurts and throws back nearby tanks, plus a ring of pellets.' },
  twin_salvo: { name:'Twin Salvo',   icon:'\u{1F680}',  color:0x66ccff, desc:'Both barrels unload 14 extra shells in about a second.' },
  barrage:    { name:'Barrage',      icon:'\u2604',     color:0xff8844, desc:'Pick a spot anywhere in range: seven shells rain down across it.' },
};

const TANK_ORDER = ['coolbuddy','demolisher','predator','grom','helix','striker','double','burst','ghost','sturmratte','mortar','hellfire','bradley','striker2','tankdisplay'];
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
  /* The gear switch (Burst: SINGLE / SALVO). Kept on G because that is the key
     the double-barrel tanks already used for their own mode toggle. */
  gear:     { key:'KeyG',       label:'Gear / Fire Mode' },
  freezeTurret: { key:'RMB',   label:'Freeze Turret (Hold)' },
};

/* THE ONE PLACE A GUEST NAME IS INVENTED.

   It used to be written out inline in the two fallbacks below, which meant that
   asking for a fresh guest name from anywhere else had to duplicate the format
   or leave the player with no name at all — and auth.js ends up needing exactly
   that when somebody logs out, because their stored name is their ACCOUNT's
   name and it must not survive into the session where they are nobody.

   One generator, one format, and the shape auth.js recognises as "generated"
   (/^Player\d{4}$/) stays true of everything this file produces. */
function generatePlayerName(){
  return 'Player' + Math.floor(Math.random()*9000+1000);
}
window.generatePlayerName = generatePlayerName;

function loadSettings(){
  ensureStarterBoxes();
  const defaults = () => Object.fromEntries(Object.keys(DEFAULT_BINDS).map(k=>[k,DEFAULT_BINDS[k].key]));
  try{
    const s = JSON.parse(localStorage.getItem('tankparty_settings')||'{}');
    // One-time migration: unlock the newest shell-magazine tanks for existing players
    if(!s.mtl_mag_unlocked){
      s.unlockedTanks = Array.from(new Set([...(s.unlockedTanks||[]), 'demolisher', 'predator', 'double', 'burst', 'grom']));
      s.mtl_mag_unlocked = true;
      localStorage.setItem('tankparty_settings', JSON.stringify(s));
    }
    /* One-time migration: the Mortar.
       A tank that is in the roster but not in unlockedTanks is greyed out in
       the collections menu and cannot be selected, so adding it to TANKS is only
       half the job — this is the other half, and it is what makes it playable
       for people whose settings were saved before it existed. Guarded by its
       own flag for the same reason as the one above: it must run once, and it
       must not clobber an unlock the player has since earned. */
    if(!s.mtl_mortar_unlocked){
      s.unlockedTanks = Array.from(new Set([...(s.unlockedTanks||[]), 'mortar']));
      s.mtl_mortar_unlocked = true;
      localStorage.setItem('tankparty_settings', JSON.stringify(s));
    }
    return {
      binds: Object.assign(defaults(), s.binds||{}),
      selectedTank: s.selectedTank || 'coolbuddy',
      playerName: s.playerName || generatePlayerName(),
      playerClan: s.playerClan || '',
      // Cash is the legacy 'coins' key (one-time migration); a fresh 'coins'
      // key now holds the third currency, Coins.
      cash: typeof s.cash === 'number' ? s.cash : (typeof s.coins === 'number' ? s.coins : 0),
      coins: typeof s.cash === 'number' ? (typeof s.coins === 'number' ? s.coins : 0) : 0,
      /* GOLD, not "gems".

         The third currency has always been called Gold on screen — menu.js labels
         it Gold and it draws assets/currency/gold.png — but the saved field was
         named `gems`, so the code and the UI disagreed about what the thing was
         called. This renames the field to match the name players actually see.

         The one-time migration below moves an existing balance across, so nobody
         loses gold by updating. */
      gold: typeof s.gold === 'number' ? s.gold
          : (typeof s.gems === 'number' ? s.gems : 0),
      aimLineOpacity: (s.aimLineOpacity!=null? s.aimLineOpacity : CONFIG.AIM_LINE_OPACITY),
      aimLineColor:   s.aimLineColor || CONFIG.AIM_LINE_COLOR,
      aimLineDesign:  s.aimLineDesign || 'professional',
      aimLineStyle:   (['fade','breakup','taper','dots','zigzag','wedge','pulse'].includes(s.aimLineStyle)) ? s.aimLineStyle : 'fade',
      ricochetIndicator: s.ricochetIndicator !== false,
      /* See-through the occluded part of a tank, in white stripes.
         `xrayStyle` is allow-listed rather than passed through: it is baked
         into the material as a compile-time branch, so a stale or hand-edited
         value has to land on a real style rather than on a shader branch that
         does not exist. */
      xrayEnabled: s.xrayEnabled !== false,
      xrayStyle:   (['stripes','scanlines','hatch','dots','solid','pulse'].includes(s.xrayStyle)) ? s.xrayStyle : 'stripes',
      xrayOpacity: (s.xrayOpacity != null ? s.xrayOpacity : 0.22),
      xrayColor:   s.xrayColor || '#ffffff',
      xrayScope:   (['all','enemies'].indexOf(s.xrayScope) >= 0) ? s.xrayScope : 'all',
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
      cameraSensitivity: (typeof s.cameraSensitivity === 'number' ? s.cameraSensitivity : 100),
      /* Two-mode camera + its remembered scroll stop. false opts the player
         back into the classic continuous zoom. cameraStage survives restarts
         so the view you left at is the view you come back to. */
      camTwoMode:       s.camTwoMode !== false,
      cameraStage:      (typeof s.cameraStage === 'number' && s.cameraStage >= 0 && s.cameraStage <= 5) ? s.cameraStage : 2,
      camPitchIdx:     (typeof s.camPitchIdx === 'number' && s.camPitchIdx >= 0 && s.camPitchIdx <= 5) ? s.camPitchIdx : 0,
      /* What the wheel does. 'distance' (the shipped behaviour) steps the six
         CAMERA_STOPS above; 'angle' keeps one distance and steps the pitch
         through CAM_PITCH_OPTIONS instead, so a zoom tilts the view rather
         than pulling the camera back. */
      zoomMode:        (s.zoomMode === 'angle') ? 'angle' : 'distance',
      // Which renderer to build: 'auto' (WebGPU when the device has it, WebGL 2
      // otherwise), 'webgpu' (force WebGPU) or 'webgl2' (stay on WebGL 2).
      rendererBackend: ['auto','webgpu','webgl2'].indexOf(s.rendererBackend) >= 0 ? s.rendererBackend : 'auto',
      // Sprays: which ones you own, and which single one is currently on a tank.
      ownedSprays:  Array.isArray(s.ownedSprays) ? s.ownedSprays.slice() : [],
      equippedSpray: s.equippedSpray || null,
      /* Trophies: which ones you have earned, and which one is your avatar.

         These have to be listed HERE, in the whitelist. loadSettings rebuilds the
         settings object from this literal, so a key that is not named below does
         not survive the round trip: it is silently dropped the moment
         loadSettings() returns, and every trophy you earned vanishes on reload
         with no error to explain it. Both fields are also repeated in the catch
         fallback below, so a corrupt save loses nothing. */
      trophyOwnedIds:   Array.isArray(s.trophyOwnedIds) ? s.trophyOwnedIds.filter(id => typeof id === 'string') : [],
      equippedTrophyId: (typeof s.equippedTrophyId === 'string' && s.equippedTrophyId) ? s.equippedTrophyId : null,
      /* THE TESTGROUNDS (js/tutorial.js). Three flags, and all three are
         whitelisted for the usual reason: this literal IS the settings object
         after a round trip, so a key missing here is dropped the next time
         anything saves -- which would re-offer the tutorial on every launch,
         or re-pay the starter pack. */
      tutorialDone:        !!s.tutorialDone,
      tutorialPromptSeen:  !!s.tutorialPromptSeen,
      tutorialStarterPack: !!s.tutorialStarterPack,
      /* The running win count behind the trophy ladder. Whitelisted alongside
         the owned ids above: a key missing from this literal is dropped by
         every loadSettings() round trip, and the roadmap would show 0 wins
         forever after the first rebuild. */
      trophyCount:      typeof s.trophyCount === 'number' ? s.trophyCount : 0,
      /* Win-box window, camera migration flag and camera view. Missing from
         this list they were dropped by every round trip: reloading the page
         reset the 6-boxes-per-12-hours limit and re-ran the camera reset. */
      winBoxes:         (s.winBoxes && typeof s.winBoxes.start === 'number') ? { start: s.winBoxes.start, earned: s.winBoxes.earned || 0 } : null,
      brawlCamV1:       !!s.brawlCamV1,
      camDefaultsV2:    !!s.camDefaultsV2,
      camFollowHull:    !!s.camFollowHull,
      /* TANK RESEARCH (research.js): the XP wallet, which path steps have been
         claimed, and which half of a two-tank step was chosen.

         Whitelisted for the same reason as the trophy fields above — this
         literal IS the saved settings object, so a key missing from it is
         silently dropped on every round trip. Without these three lines the
         research path would forget every unlocked tank the first time anything
         else saved settings, which is instantly. */
      researchXP:      (typeof s.researchXP === 'number' && isFinite(s.researchXP)) ? Math.max(0, s.researchXP) : 0,
      researchClaimed: (s.researchClaimed && typeof s.researchClaimed === 'object' && !Array.isArray(s.researchClaimed)) ? s.researchClaimed : {},
      researchChoice:  (s.researchChoice && typeof s.researchChoice === 'object' && !Array.isArray(s.researchChoice)) ? s.researchChoice : {},
    };
  }catch(e){
    return {binds:defaults(), selectedTank:'coolbuddy', playerName:generatePlayerName(), playerClan:'', cash:0, coins:0, gold:0,
            aimLineOpacity:CONFIG.AIM_LINE_OPACITY, aimLineColor:CONFIG.AIM_LINE_COLOR, aimLineDesign:'default', aimLineStyle:'fade',
            viewRangeOpacity:CONFIG.VIEW_RANGE_OPACITY, viewRangeColor:CONFIG.VIEW_RANGE_COLOR,
            viewRangeWidth:CONFIG.VIEW_RANGE_WIDTH, graphicsQuality:'default', camRotation:0, camMode:'arrows', pinchZoom:true, ricochetIndicator:true,
            xrayEnabled:true, xrayStyle:'stripes', xrayOpacity:0.22, xrayColor:'#ffffff', xrayScope:'all',
            unlockedTanks:['coolbuddy'], allUnlocked:false, clanWeeklyXP:0, clanWeekKey:0, clanWeeklyRewarded:false,
            clanWeekWins:0, clanWeekWinsBonus:false, clanWeekLoginXP:0, clanLastLoginDay:0, tlPlus:false,
            screenShake:100, muzzleFx:true, showFps:false, invertCamRot:false, cameraMode:'dynamic', cameraMouseRotate:false, cameraSensitivity:100,
            camTwoMode:true, cameraStage:2, camPitchIdx:0, zoomMode:'distance',
            researchXP:0, researchClaimed:{}, researchChoice:{},
            trophyOwnedIds:[], equippedTrophyId:null, trophyCount:0, winBoxes:null, brawlCamV1:false, camFollowHull:false};
  }
}
function saveSettings(s){
  localStorage.setItem('tankparty_settings', JSON.stringify(s));
  if(window.Auth && window.Auth.onSettingsSaved) window.Auth.onSettingsSaved(s);
}

function addOwnedSpray(sprayId){
  const s = loadSettings();
  if(!s.ownedSprays) s.ownedSprays = [];
  if(!s.ownedSprays.includes(sprayId)){
    s.ownedSprays.push(sprayId);
    saveSettings(s);
  }
}
window.addOwnedSpray = addOwnedSpray;

function getOwnedSprays(){
  const s = loadSettings();
  return s.ownedSprays || [];
}
window.getOwnedSprays = getOwnedSprays;

function getEquippedSpray(){
  const s = loadSettings();
  return s.equippedSpray || null;
}
window.getEquippedSpray = getEquippedSpray;

function setEquippedSpray(sprayId){
  const s = loadSettings();
  if(s.ownedSprays && s.ownedSprays.includes(sprayId)){
    s.equippedSpray = sprayId;
    saveSettings(s);
    return true;
  }
  return false;
}
window.setEquippedSpray = setEquippedSpray;

/* ---------- TROPHIES / AVATAR ----------

   The catalogue is every trophy that exists (TROPHIES, top of this file). The
   player owns a subset of it and wears exactly one of those. These are the only
   functions that read or write either half of that, so "owned" and "equipped"
   cannot drift apart between the two screens that draw them. */

function getTrophyCatalog(){
  return (typeof TROPHIES !== 'undefined' && Array.isArray(TROPHIES)) ? TROPHIES : [];
}
window.getTrophyCatalog = getTrophyCatalog;

function getTrophy(id){
  return getTrophyCatalog().filter(t => t.id === id)[0] || null;
}
window.getTrophy = getTrophy;

function ownedTrophyIds(){
  const s = loadSettings();
  return Array.isArray(s.trophyOwnedIds) ? s.trophyOwnedIds.slice() : [];
}
window.ownedTrophyIds = ownedTrophyIds;

/* The id the player has chosen, or null when they have chosen nothing.

   It is checked against the owned list on the way out: a trophy that was in the
   catalogue when they equipped it and has since been removed would otherwise
   stay "equipped" forever with nothing to draw. */
function getEquippedTrophyId(){
  const s = loadSettings();
  const id = s.equippedTrophyId || null;
  if(!id) return null;
  const owned = Array.isArray(s.trophyOwnedIds) ? s.trophyOwnedIds : [];
  return owned.indexOf(id) >= 0 ? id : null;
}
window.getEquippedTrophyId = getEquippedTrophyId;

/* The trophy the menus draw in the avatar slot.

   Falls back to the first OWNED trophy rather than to the first in the
   catalogue, so a locked trophy is never shown as though it were yours, and so
   a player who has earned something is never left with an empty slot just
   because they have not clicked Equip yet. */
function getEquippedTrophy(){
  const id = getEquippedTrophyId();
  if(id) return getTrophy(id);
  const owned = new Set(ownedTrophyIds());
  return getTrophyCatalog().filter(t => owned.has(t.id))[0] || null;
}
window.getEquippedTrophy = getEquippedTrophy;

/* Equip, or unequip with no argument. Refuses a trophy the player does not own —
   that check is the whole reason this is a function and not a direct write to
   localStorage from the menu. */
function setEquippedTrophy(id){
  const s = loadSettings();
  s.trophyOwnedIds = Array.isArray(s.trophyOwnedIds) ? s.trophyOwnedIds : [];
  if(id && s.trophyOwnedIds.indexOf(id) < 0) return false;
  s.equippedTrophyId = id || null;
  saveSettings(s);
  return true;
}
window.setEquippedTrophy = setEquippedTrophy;

/* Award a trophy, and auto-equip it if this is the first one earned so the
   avatar is never sitting empty after an unlock. */
function awardTrophy(id){
  const s = loadSettings();
  s.trophyOwnedIds = Array.isArray(s.trophyOwnedIds) ? s.trophyOwnedIds : [];
  if(!id || s.trophyOwnedIds.indexOf(id) >= 0) return false;
  s.trophyOwnedIds.push(id);
  if(!s.equippedTrophyId) s.equippedTrophyId = id;
  saveSettings(s);
  return true;
}
window.awardTrophy = awardTrophy;
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
/* WIN BOXES — the only steady source of upgrade points.

   Every win drops one box into Storage, up to WIN_BOX_LIMIT per window. The
   window opens on the first win after the last one expired and lasts
   WIN_BOX_WINDOW_MS, so "6 boxes, resets after 12 hours" is literal: six
   wins fill it, and twelve hours after it opened it is empty again. */
const WIN_BOX_LIMIT = 6;
const WIN_BOX_WINDOW_MS = 12 * 60 * 60 * 1000;

function winBoxStatus(){
  const s = (typeof Menu !== 'undefined' && Menu.settings) || {};
  const now = Date.now();
  let w = s.winBoxes;
  if(!w || !w.start || now - w.start >= WIN_BOX_WINDOW_MS) w = { start: 0, earned: 0 };
  return {
    earned: w.earned || 0,
    limit: WIN_BOX_LIMIT,
    resetsAt: w.start ? w.start + WIN_BOX_WINDOW_MS : 0,
  };
}

function grantWinBox(){
  const s = (typeof Menu !== 'undefined' && Menu.settings) || null;
  if(!s) return null;
  const now = Date.now();
  let w = s.winBoxes;
  if(!w || !w.start || now - w.start >= WIN_BOX_WINDOW_MS) w = { start: now, earned: 0 };
  if(w.earned >= WIN_BOX_LIMIT){
    return { granted: false, earned: w.earned, limit: WIN_BOX_LIMIT, resetsAt: w.start + WIN_BOX_WINDOW_MS };
  }
  w.earned += 1;
  s.winBoxes = w;
  /* AUTOCOLLECTED: the box opens itself, its reward is yours on the results
     screen. Nothing to go and open in Storage. */
  let reward = null;
  try { reward = Menu._collectBoxReward(); } catch(e){ addClanItem('box', { source: 'win' }); }
  if(typeof saveSettings === 'function') saveSettings(s);
  return { granted: true, earned: w.earned, limit: WIN_BOX_LIMIT, resetsAt: w.start + WIN_BOX_WINDOW_MS, reward: reward };
}

function removeClanItem(index){
  var items = loadClanStorage();
  if(index >= 0 && index < items.length) items.splice(index, 1);
  saveClanStorage(items);
  return items;
}

/* THE "ALREADY GIVEN" FLAG LIVES IN ITS OWN KEY. It used to be a field of
   the settings object, and any save of a settings object that lacked it (the
   loaded copy did not carry it) wiped it -- so every loadSettings() call handed
   out ten more starter boxes. With upgrade points in boxes that was an
   unlimited upgrade-point tap. The old field is still honoured once. */
function ensureStarterBoxes(){
  try{
    if(localStorage.getItem('tankparty_starter_boxes') === '1') return;
    var s = JSON.parse(localStorage.getItem('tankparty_settings')||'{}');
    if(s.starterBoxesGiven || loadClanStorage().length){
      localStorage.setItem('tankparty_starter_boxes', '1');
      return;
    }
    var items = loadClanStorage();
    for(var i = 0; i < 10; i++){
      items.push({ type:'box', meta:{ source:'starter' }, acquired:Date.now(), week:getWeekKey() });
    }
    saveClanStorage(items);
    localStorage.setItem('tankparty_starter_boxes', '1');
  }catch(e){}
}
