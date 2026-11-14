/* ============================================================
   tutorial.js — the Testgrounds lesson.

   WHAT THIS IS. A guided first-run course on a private range:
   five steps (welcome, drive, targets, dummy tanks, the live bot),
   each with a camera shot, a line of narration that types itself out
   at the bottom of the screen, an objective, a tip once the objective
   is met, and a SKIP THIS TIP button that jumps that part.

   WHY IT IS ITS OWN FILE. startTutorial() in game.js owns the ARENA
   (which GLB, which tanks, which targets); this file owns the LESSON
   (what is said, where the camera looks, what counts as done). The
   split means a lesson can be rewritten without touching the mode and
   the range can be changed without rewriting the plot.

   EVERYTHING HERE IS SKIPPABLE, AND SKIPPING IS NOT A FAILURE. A
   skipped step advances; SKIP TUTORIAL ends the course and leaves the
   player on the range in free practice, with no reward and no penalty.
   Only finishing all five pays the starter pack (1,000 gold, 2,000
   cash, Woodland Camo), and it pays once.

   PERSISTENCE. Three settings keys (whitelisted in config.js):
     tutorialPromptSeen  the first-join offer was shown and answered
     tutorialDone        the course was finished
     tutorialStarterPack the one-time reward was actually paid
   The range itself stays reachable from TRAINING in the main menu
   forever — "you can come back and just test a tank".
   ============================================================ */
window.Tutorial = (function(){
'use strict';

/* ---------------------------------------------------------------- steps */

/* The welcome beat is a step with no objective: it exists so the camera can
   fly in and the first two sentences can land before anything is asked of
   the player. Every step after it maps to exactly one thing the player can
   actually do, in the order a battle asks for it: look, drive, aim, shoot,
   then the three things that can be shot. `total` is only the number the
   progress bar counts to; the objective text says it in words. */
var STEPS = [
  { id:'welcome', kicker:'BRIEFING', title:'WELCOME TO THE TESTGROUNDS', objective:null },
  { id:'aim',     kicker:'STEP 1',  title:'AIM',         objective:'Swing your aim 60° around the tank.', total:60,
    tip:'TIP — the camera and the gun are two different things. The aim goes where you point it, even while the hull drives the other way.' },
  { id:'drive',   kicker:'STEP 2',  title:'ROLL OUT',    objective:'Drive 25 m from where you started.', total:25,
    tip:'TIP — A and D turn the tracks, and S is a brake before it is reverse. Tap S to stop cleanly instead of rolling past your mark.' },
  { id:'gun',     kicker:'STEP 3',  title:'FIRE',        objective:'Fire one shell.', total:1,
    tip:'TIP — the circle under the crosshair is your reload. Every round is a decision: a miss costs the same time as a hit.' },
  { id:'targets', kicker:'STEP 4',  title:'RANGE CHECK', objective:'Hit 3 different targets.', total:3,
    tip:'TIP — a target has no health and never falls. A shell that lands is worth as much as a kill here: use the boards to learn a gun\'s drop and reload.' },
  { id:'dummies', kicker:'STEP 5',  title:'DUMMY DRILL', objective:'Destroy 2 dummy tanks.', total:2,
    tip:'TIP — a dummy comes back one second after it dies. Keep the gun loaded and you can chain kills on the same spot all day.' },
  { id:'bot',     kicker:'STEP 6',  title:'LIVE FIRE',   objective:'Destroy the bot inside its yellow square.', total:1,
    tip:'TIP — the bot cannot leave its square and cannot shoot outside it. Step out to reload, step back in when your gun is ready.' },
];

/* ---------------------------------------------------------------- state */

var S = {
  built:false,
  active:false,
  freeplay:false,
  game:null,
  stepIdx:-1,
  step:null,
  phase:'idle',          /* intro | play | outro | done */
  lines:[], li:0,
  phrase:'', typed:'', typeAcc:0, typing:false, lineWait:false, lineHold:0,
  count:0,
  done:false,
  targetHits:{},
  killed:0,
  startPos:null,
  /* Travel counter for the aim step. It ACCUMULATES: the step counts how far
     the turret has moved in total, not where it ended up, so dragging the aim
     one way and back still counts as a swing. A before/after reading would
     also be fooled by the camera mode that recentres the hull every frame. */
  aimTurned:0,
  aimLast:null,
  shots:0,
  lastReload:0,
  lastMag:0,
  advanceAt:0,
  shot:null,
  lastLook:null,
  zoneMesh:null,
  zoneFill:null,
  tipMode:false,
  promptTimer:null,
  promptShown:false,
  beatT:0,
};

var el = {};
var isMobile = function(){
  return document.body && document.body.classList.contains('is-mobile');
};

function $(id){ return document.getElementById(id); }

/* Audio.click() is used on every control here, but a lesson control must still
   work on a page where audio failed to come up. */
function click(){ try { if(window.Audio) Audio.click(); } catch(e){} }

/* ---------------------------------------------------------------- DOM */

function buildUI(){
  if(S.built) return;
  S.built = true;

  var layer = document.createElement('div');
  layer.id = 'tut-layer';
  layer.className = 'tut-layer hidden';
  layer.innerHTML =
    '<div class="tut-lb tut-lb-top"></div>' +
    '<div class="tut-lb tut-lb-bottom"></div>' +
    '<div class="tut-topbar">' +
      '<span class="tut-stepno" id="tut-stepno">STEP 1 / 7</span>' +
      '<span class="tut-topbar-btns">' +
        /* ALWAYS AVAILABLE, not just while an objective is on screen. A player
           who is stuck halfway through a narration block used to have no way
           past it but SKIP TUTORIAL, which threw away the whole course. */
        '<button type="button" class="tut-skipstep" id="tut-skipstep-top">SKIP THIS PART</button>' +
        '<button type="button" class="tut-skipall" id="tut-skipall">SKIP TUTORIAL</button>' +
      '</span>' +
    '</div>' +
    /* The camera's own voice: a small stage direction while a shot moves. */
    '<div class="tut-beat hidden" id="tut-beat"></div>' +
    '<div class="tut-objective hidden" id="tut-objective">' +
      '<div class="tut-obj-kicker" id="tut-obj-kicker">OBJECTIVE</div>' +
      '<div class="tut-obj-title" id="tut-obj-title"></div>' +
      '<div class="tut-obj-line" id="tut-obj-line"></div>' +
      '<div class="tut-obj-bar"><i id="tut-obj-fill"></i></div>' +
      '<div class="tut-obj-progress" id="tut-obj-progress"></div>' +
      '<button type="button" class="tut-skipstep" id="tut-skipstep">SKIP THIS PART</button>' +
    '</div>' +
    '<div class="tut-subtitle hidden" id="tut-subtitle">' +
      '<div class="tut-sub-speaker" id="tut-sub-speaker">INSTRUCTOR</div>' +
      '<div class="tut-sub-text" id="tut-sub-text"></div>' +
      '<div class="tut-sub-hint" id="tut-sub-hint">CLICK OR SPACE TO CONTINUE</div>' +
    '</div>' +
    '<div class="tut-dots" id="tut-dots"></div>';
  document.body.appendChild(layer);

  var intro = document.createElement('div');
  intro.id = 'tut-intro';
  intro.className = 'tut-modal hidden';
  intro.innerHTML =
    '<div class="tut-card">' +
      '<div class="tut-kicker">NEW COMMANDER</div>' +
      '<h2 class="tut-title">START WITH THE BASICS?</h2>' +
      '<p class="tut-copy">The Testgrounds is a private range: six targets, three dummy tanks and one live bot that drives and shoots back. No clock, no score, nothing saved against you.</p>' +
      '<p class="tut-copy tut-copy-dim">Not now? You can finish the tutorial later from <b>TRAINING</b> in the main menu — the range stays open forever, for testing any tank you own.</p>' +
      '<div class="tut-pack">' +
        '<span class="tut-pack-label">FINISH IT AND KEEP</span>' +
        '<span class="tut-pack-item"><img src="assets/currency/gold.webp" alt="">1,000 gold</span>' +
        '<span class="tut-pack-item"><img src="assets/currency/cash.webp" alt="">2,000 cash</span>' +
        '<span class="tut-pack-item tut-pack-camo"><span class="tut-pack-dot"></span>Woodland Camo</span>' +
      '</div>' +
      '<div class="tut-actions">' +
        '<button type="button" class="tut-btn tut-btn-primary" id="tut-intro-start">COMPLETE TUTORIAL</button>' +
        '<button type="button" class="tut-btn" id="tut-intro-skip">SKIP IT</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(intro);

  var reward = document.createElement('div');
  reward.id = 'tut-reward';
  reward.className = 'tut-modal hidden';
  reward.innerHTML =
    '<div class="tut-card tut-card-reward">' +
      '<div class="tut-kicker">TUTORIAL COMPLETE</div>' +
      '<h2 class="tut-title">TRAINING PASSED</h2>' +
      '<p class="tut-copy">That is everything you need for a first battle. The range stays open — come back any time from <b>TRAINING</b>.</p>' +
      '<div class="tut-pack tut-pack-reward">' +
        '<span class="tut-pack-label">STARTER PACK</span>' +
        '<span class="tut-pack-item"><img src="assets/currency/gold.webp" alt="">+1,000 gold</span>' +
        '<span class="tut-pack-item"><img src="assets/currency/cash.webp" alt="">+2,000 cash</span>' +
        '<span class="tut-pack-item tut-pack-camo"><span class="tut-pack-dot"></span>Woodland Camo</span>' +
      '</div>' +
      '<div class="tut-actions">' +
        '<button type="button" class="tut-btn tut-btn-primary" id="tut-reward-stay">STAY AND TEST</button>' +
        '<button type="button" class="tut-btn" id="tut-reward-back">BACK TO GARAGE</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(reward);

  el.layer      = layer;
  el.stepno     = $('tut-stepno');
  el.skipAll    = $('tut-skipall');
  el.skipTop    = $('tut-skipstep-top');
  el.beat       = $('tut-beat');
  el.objective  = $('tut-objective');
  el.objKicker  = $('tut-obj-kicker');
  el.objTitle   = $('tut-obj-title');
  el.objLine    = $('tut-obj-line');
  el.objFill    = $('tut-obj-fill');
  el.objProg    = $('tut-obj-progress');
  el.skipStep   = $('tut-skipstep');
  el.subtitle   = $('tut-subtitle');
  el.speaker    = $('tut-sub-speaker');
  el.subText    = $('tut-sub-text');
  el.subHint    = $('tut-sub-hint');
  el.dots       = $('tut-dots');
  el.intro      = intro;
  el.reward     = reward;

  /* The camera turns the patch card on the reward shelf; the store's own art
     builder is used so the camo shown here is the same picture sold there. */
  try {
    if(window.TankStyles && TankStyles.artMarkup){
      var camo = reward.querySelector('.tut-pack-camo');
      if(camo) camo.insertAdjacentHTML('beforeend', TankStyles.artMarkup('woodland_camo', {className:'tut-pack-art'}));
    }
  } catch(e){}

  el.skipAll.onclick = function(){ click(); skipAll(); };
  el.skipStep.onclick = function(){ click(); skipStep(); };
  el.skipTop.onclick = function(){ click(); skipStep(); };
  el.subtitle.onclick = function(){ click(); advanceLine(); };
  $('tut-intro-start').onclick = function(){
    click(); markPromptSeen(); hideModal(el.intro); startTraining(true);
  };
  $('tut-intro-skip').onclick = function(){
    click(); markPromptSeen(); hideModal(el.intro);
    if(window.Menu && Menu.toast) Menu.toast('Tutorial skipped — start it any time from Training');
  };
  $('tut-reward-stay').onclick = function(){
    click(); hideModal(el.reward);
    if(window.Menu && Menu.toast) Menu.toast('The range is yours — drive, shoot, test any tank');
  };
  $('tut-reward-back').onclick = function(){
    click(); hideModal(el.reward);
    if(S.game) S.game.leaveToMenu();
  };

  /* Clicking the dimmed backdrop of the offer counts as "later". */
  intro.addEventListener('click', function(e){
    if(e.target !== intro) return;
    click(); markPromptSeen(); hideModal(intro);
  });

  window.addEventListener('keydown', function(e){
    if(!S.active) return;
    if(e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter'){
      /* Space is also the fire key in a battle, so it only advances text while
         a line is on screen — never during play, where it belongs to the gun. */
      if(!el.subtitle.classList.contains('hidden')){
        e.preventDefault();
        advanceLine();
      }
    }
  });

  renderDots();
}

function hideModal(m){ if(m) m.classList.add('hidden'); }
function showModal(m){ if(m) m.classList.remove('hidden'); }

function renderDots(){
  if(!el.dots) return;
  var html = '';
  for(var i=0;i<STEPS.length;i++){
    html += '<i data-i="' + i + '"></i>';
  }
  el.dots.innerHTML = html;
  syncDots();
}
function syncDots(){
  if(!el.dots) return;
  var kids = el.dots.children;
  for(var i=0;i<kids.length;i++){
    kids[i].className = (i < S.stepIdx ? 'done' : i === S.stepIdx ? 'on' : '');
  }
}

/* ---------------------------------------------------------------- save */

function readSettings(){
  try { return (typeof loadSettings === 'function') ? loadSettings() : {}; }
  catch(e){ return {}; }
}
function writeSettings(s){
  try { if(typeof saveSettings === 'function') saveSettings(s); } catch(e){}
}
function markPromptSeen(){
  var s = readSettings();
  if(s.tutorialPromptSeen) return;
  s.tutorialPromptSeen = true;
  writeSettings(s);
}
function isDone(){
  var s = readSettings();
  return !!s.tutorialDone;
}

/* THE STARTER PACK IS PAID EXACTLY ONCE, EVER.

   tutorialStarterPack is a separate flag from tutorialDone on purpose: a save
   from a build that finished the lesson but crashed before the wallet write
   would otherwise be able to claim twice, and a replayed lesson (which is
   allowed) must never pay again. */
function grantStarterPack(){
  var s = readSettings();
  if(s.tutorialStarterPack){ s.tutorialDone = true; writeSettings(s); return false; }
  s.gold = (s.gold || 0) + 1000;
  s.cash = (s.cash || 0) + 2000;
  s.tutorialStarterPack = true;
  s.tutorialDone = true;
  writeSettings(s);
  try { if(window.TankStyles && TankStyles.addOwnedStyle) TankStyles.addOwnedStyle('woodland_camo'); } catch(e){}
  try { if(window.Menu && Menu._updateCurrencies) Menu._updateCurrencies(); } catch(e){}
  try { if(window.Auth && Auth.onSettingsSaved) Auth.onSettingsSaved(s); } catch(e){}
  return true;
}

/* ---------------------------------------------------------------- offer */

/* Shown once, after the login chooser has handed the player to the menu.
   Never over the gate (it would be a third choice on a screen that only
   offers two), never over a battle, and never again once answered. */
function maybePrompt(){
  if(S.promptShown) return;
  if(isDone()) return;
  var s = readSettings();
  if(s.tutorialPromptSeen) return;

  var html = document.documentElement;
  var gate = $('login-gate');
  var main = $('menu-main');
  var g = gameRef();
  var ready = !html.classList.contains('auth-locked')
    && !(gate && !gate.hidden)
    && !!g && !g.running
    && !(main && main.classList.contains('hidden'));

  /* The gate can unlock before the menu has finished its first paint, so a
     single check would miss the moment. Retried on a short timer instead of
     being tied to any one menu function -- this has to work for a guest, an
     account, and a player whose chooser was skipped as "already decided". */
  if(!ready){
    S.promptTries = (S.promptTries || 0) + 1;
    if(S.promptTries > 40) return;
    clearTimeout(S.promptTimer);
    S.promptTimer = setTimeout(maybePrompt, 1200);
    return;
  }
  if(S.promptTimer){ clearTimeout(S.promptTimer); S.promptTimer = null; }

  buildUI();
  S.promptShown = true;
  showModal(el.intro);
}

/* ---------------------------------------------------------------- start */

/* THE GAME INSTANCE IS NOT ALWAYS `window.game`.

   The boot code names its instance `window._game` and only aliases it to the
   courtesy name `window.game` in the dev console block, so on a plain page
   load the tutorial's own lookup found nothing and every "start training"
   button answered "the game is still loading" forever. The instance is
   whichever alias booted: resolve them in that order. */
function gameRef(){
  return window.game || window._game || window.__game || null;
}

function startTraining(withTutorial){
  buildUI();
  markPromptSeen();
  hideModal(el.intro);
  hideModal(el.reward);
  var g = gameRef();
  if(!g){
    if(window.Menu && Menu.toast) Menu.toast('The game is still loading');
    return;
  }
  if(g.running){
    try { g.leaveToMenu(); } catch(e){}
  }
  /* One frame after leaving, so leaveToMenu's teardown has run and the map
     loader is not fighting a live arena. */
  setTimeout(function(){
    try { g.startTutorial({ tutorial: withTutorial !== false }); }
    catch(e){ console.warn('[tutorial] start failed', e); }
  }, 80);
}

/* ---------------------------------------------------------------- begin */

function begin(game, opts){
  buildUI();
  S.game = game;
  S.active = true;
  S.freeplay = !(opts && opts.tutorial);
  S.zoneMesh = null; S.zoneFill = null;
  /* A lesson that was left half-finished must not keep driving objectives in
     free practice: the range runs the same tick for both. */
  S.step = null;
  S.stepIdx = -1;
  S.phase = 'idle';
  S.done = true;
  S.advanceAt = 0;
  S.botKilled = false;

  hookBot(game);
  buildZone(game);

  if(S.freeplay){
    el.layer.classList.add('hidden');
    if(window.Menu && Menu.toast) Menu.toast('Testgrounds — free practice. Escape for the menu');
    return;
  }

  el.layer.classList.remove('hidden');
  S.stepIdx = -1;
  S.targetHits = {};
  nextStep();
}

/* The bot's orders are enforced here rather than inside bot.js: bot.js is the
   generic AI and should not learn about the tutorial. Two rules,
   both from the map's own cube:
     * it cannot drive out of the box (position is clamped, and while it is
       outside it steers back in),
     * it cannot fire at a player who is outside the box. */
function hookBot(game){
  var st = game._tutState;
  if(!st || !st.bot || !st.bot.tank) return;
  var bot = st.bot.tank;
  var brain = bot.brain;
  if(!brain || brain._tutWrapped) return;
  brain._tutWrapped = true;
  var orig = brain.decide.bind(brain);
  brain.decide = function(g){
    var plan = orig(g);
    var z = g._tutState && g._tutState.zone;
    if(!z) return plan;
    var outside = (bot.x < z.minX || bot.x > z.maxX || bot.z < z.minZ || bot.z > z.maxZ);
    if(g._tutPlayerInZone === false) plan.fire = false;
    if(outside){
      var h = Math.atan2(z.cx - bot.x, z.cz - bot.z);
      var d = ((h - bot.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      plan.turn = Math.max(-1, Math.min(1, d * 1.6));
      plan.throttle = 1;
      plan.fire = false;
    }
    return plan;
  };
}

/* A visible, walkable square. The authored cube is hidden — it is a bounds
   helper, not scenery — so the range draws the boundary itself, in the same
   yellow the game uses for "this is an objective". */
function buildZone(game){
  var st = game._tutState;
  var z = st && st.zone;
  if(!z || !window.THREE) return;
  try {
    var y = (z.y || 0) + 0.5;
    var pts = [
      new THREE.Vector3(z.minX, y, z.minZ),
      new THREE.Vector3(z.maxX, y, z.minZ),
      new THREE.Vector3(z.maxX, y, z.maxZ),
      new THREE.Vector3(z.minX, y, z.maxZ),
    ];
    var geo = new THREE.BufferGeometry().setFromPoints(pts);
    var line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
      color: 0xffd24a, transparent: true, opacity: 0.9, depthWrite: false,
    }));
    line.renderOrder = 4;
    line.userData.noXray = true; line.userData.isOverlay = true;
    game.scene.add(line);
    S.zoneMesh = line;

    var w = z.maxX - z.minX, d = z.maxZ - z.minZ;
    var fill = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({
        color: 0xffd24a, transparent: true, opacity: 0.055,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(z.cx, y - 0.05, z.cz);
    fill.renderOrder = 2;
    fill.userData.noXray = true; fill.userData.isOverlay = true;
    game.scene.add(fill);
    S.zoneFill = fill;
  } catch(e){ console.warn('[tutorial] zone draw failed', e); }
}

function nextStep(){
  S.stepIdx++;
  if(S.stepIdx >= STEPS.length){ finishTutorial(); return; }
  enterStep(S.stepIdx);
}

function enterStep(i){
  S.step = STEPS[i];
  S.phase = 'intro';
  S.count = 0;
  S.done = false;
  S.killed = 0;
  S.botKilled = false;
  S.tipMode = false;
  S.advanceAt = 0;
  el.beat.classList.add('hidden');
  el.objective.classList.add('hidden');
  el.objective.classList.remove('done');
  el.stepno.textContent = 'STEP ' + (i + 1) + ' / ' + STEPS.length;
  syncDots();

  /* Distance is measured from where the drive step began, not from where the
     previous step asked the tank to stand. The camera and gun steps work the
     same way: they remember the pose the step opened with and count the swing
     from there, so a player who was already looking sideways still has to
     move the camera themselves. */
  if(S.step.id === 'drive' && S.game && S.game.localTank){
    S.startPos = { x: S.game.localTank.x, z: S.game.localTank.z };
  }
  if(S.step.id === 'aim' && S.game && S.game.localTank){
    S.aimTurned = 0;
    S.aimLast = S.game.localTank.turretAngle || 0;
  }
  if(S.step.id === 'gun' && S.game && S.game.localTank){
    S.shots = 0;
    S.lastReload = S.game.localTank.reloadLeft || 0;
    S.lastMag = S.game.localTank.magReloadLeft || 0;
  }
  if(S.step.id === 'targets'){ S.targetHits = {}; }

  S.lines = LINES[S.step.id] || [];
  S.li = 0;
  showLine(S.lines[0]);
}

/* ---------------------------------------------------------------- lines */

var LINES = {
  welcome: [
    { beat:'CAMERA SWEEPS OVER THE TESTGROUNDS',
      cam:{ kind:'overview', dur:2.6 },
      text:'Welcome to the Testgrounds — a private range that never counts against you. No clock, no score, no defeat.' },
    { text:'Your tank is real and the gun is real. Everything here exists so you can learn what they do.' },
    { cam:{ kind:'tank', dur:1.6 },
      text:'You can come back to this map any time from TRAINING in the main menu — it stays open forever.' },
    { text:'Let us start with the controls.' },
  ],
  aim: [
    { beat:'CAMERA RISES OFF YOUR TANK',
      cam:{ kind:'tank', dur:1.4 },
      text: isMobile()
        ? 'Before the tracks: the gun. Push the right stick across and the turret follows your aim.'
        : 'Before the tracks: the gun. Move the mouse across and the turret follows your aim — the hull does not turn with it.' },
    { text:'Aim is not where the tank points. You can be driving one way and shooting another, and that is how most duels are won.' },
    { text:'Swing the aim 60° and watch the barrel travel. The hull stays exactly where it is.' },
  ],
  drive: [
    { text: isMobile()
        ? 'The left stick drives the hull and turns the tracks. The right stick aims the gun. The camera stays behind you.'
        : 'W and S push the tracks, A and D turn the hull. The gun follows your aim, not the hull — that is what lets you shoot while you turn.' },
    { text: isMobile()
        ? 'Get a feel for it: push the stick and drive forward. Then drag the right stick to sweep the gun around.'
        : 'Get a feel for it: drive forward, turn on the spot, then swing the turret without moving the hull.' },
    { text:'Ride out — 25 metres from where you are standing. The objective is on the left.' },
  ],
  gun: [
    { beat:'CAMERA DROPS TO THE GUN',
      cam:{ kind:'tank', dur:1.3 },
      text:'The gun fires where the barrel points, and the barrel points where you aim.' },
    { text: isMobile()
        ? 'Tap the fire button with a shell loaded. The gun kicks, then the reload ring refills.'
        : 'Left click fires with a shell loaded. The gun kicks, then the reload ring under the crosshair refills.' },
    { text:'Fire one shell. Nothing on this range can be hurt by a miss.' },
  ],
  targets: [
    { beat:'CAMERA FLIES TO THE TARGETS',
      cam:{ kind:'subject', subject:'targets', dur:2.4 },
      text:'Those are targets. They only exist on this range — you will never see one in a battle.' },
    { text:'They are not tanks: no hull, no health bar, no driver. A board that has been hit a hundred times still stands there.' },
    { text:'That is exactly what makes them good for checking a gun. Range, spread, reload — all of it is measurable on a board that never falls.' },
    { beat:'CAMERA RETURNS TO YOUR TANK',
      cam:{ kind:'tank', dur:1.8 },
      text:'Put a shell into three different targets.' },
  ],
  dummies: [
    { beat:'CAMERA FINDS THE DUMMY TANKS',
      cam:{ kind:'subject', subject:'dummy', dur:2.4 },
      text:'These are dummy tanks. Real hulls, real hitboxes, no driver.' },
    { text:'They take damage exactly like a tank you will meet in a battle — and one second after one is destroyed, it comes back in this same spot.' },
    { text:'That makes them the honest test for a loadout: same armour, same weak spots, infinite attempts.' },
    { beat:'CAMERA RETURNS TO YOUR TANK',
      cam:{ kind:'tank', dur:1.8 },
      text:'Destroy two of them. Aim for the hull side and the rear — a dummy does not angle its armour for you.' },
  ],
  bot: [
    { beat:'CAMERA FINDS THE LIVE BOT',
      cam:{ kind:'subject', subject:'bot', dur:2.6 },
      text:'That one is not a dummy. It is a live bot: it drives, it aims, and it shoots back.' },
    { text:'The yellow square is its orders. It cannot leave the square, and it will not fire at anything outside it — step out and it has to wait for you.' },
    { beat:'CAMERA RETURNS TO YOUR TANK',
      cam:{ kind:'tank', dur:1.8 },
      text:'Destroy it. It is a Cool Buddy: quick, and it likes to work around your side.' },
  ],
};

function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showLine(l){
  if(!l){ finishIntro(); return; }
  S.phrase = l.text || '';
  S.typed = '';
  S.typeAcc = 0;
  S.typing = true;
  S.lineWait = false;
  S.lineHold = 0;
  el.subtitle.classList.remove('hidden');
  el.subText.innerHTML = '';
  el.speaker.textContent = l.speaker || 'INSTRUCTOR';
  el.subtitle.classList.toggle('tip', !!l.speaker);
  el.subHint.textContent = isMobile() ? 'TAP TO CONTINUE' : 'CLICK OR SPACE TO CONTINUE';
  if(l.beat) showBeat(l.beat);
  if(l.cam) startShot(lineCam(l.cam));
}

function lineCam(c){
  if(!c) return null;
  if(c.kind === 'tank'){
    var g = S.game;
    return { to: followPose(g), dur: c.dur || 1.6, release: true };
  }
  if(c.kind === 'overview'){
    var box = overviewBox();
    return {
      to: { p: new THREE.Vector3(box.cx + 6, box.y + 86, box.cz + 96), l: new THREE.Vector3(box.cx, box.y + 2, box.cz) },
      dur: c.dur || 2.6,
    };
  }
  if(c.kind === 'subject'){
    var g2 = S.game;
    var subj = subjectPoint(g2, c.subject);
    if(!subj) return { to: followPose(g2), dur: c.dur || 1.6, release: true };
    var t = g2.localTank;
    var dx = subj.x - (t ? t.x : 0), dz = subj.z - (t ? t.z : 0);
    var len = Math.hypot(dx, dz) || 1;
    var side = c.subject === 'bot' ? 1 : -1;
    var ox = (-dz / len) * 26 * side, oz = (dx / len) * 26 * side;
    return {
      to: {
        p: new THREE.Vector3(subj.x + ox + (dx / len) * 10, subj.y + 20, subj.z + oz + (dz / len) * 10),
        l: new THREE.Vector3(subj.x, subj.y + 2.5, subj.z),
      },
      dur: c.dur || 2.2,
    };
  }
  return null;
}

function subjectPoint(g, kind){
  var st = g && g._tutState;
  if(!st) return null;
  if(kind === 'bot' && st.bot && st.bot.tank){
    return { x: st.bot.tank.x, y: 0, z: st.bot.tank.z };
  }
  if(kind === 'dummy' && st.dummies && st.dummies.length){
    var d = st.dummies[0];
    var tank = d.tank;
    return { x: tank ? tank.x : d.x, y: 0, z: tank ? tank.z : d.z };
  }
  if(kind === 'targets' && st.targets && st.targets.length){
    var sx = 0, sz = 0;
    for(var i=0;i<st.targets.length;i++){ sx += st.targets[i].x; sz += st.targets[i].z; }
    return { x: sx / st.targets.length, y: 0, z: sz / st.targets.length };
  }
  return null;
}

function overviewBox(){
  var g = S.game;
  var half = (g && g.world && g.world.half) || 110;
  return { cx: 0, cz: 0, y: 0, half: half };
}

function showBeat(text, dur){
  el.beat.textContent = text;
  el.beat.classList.remove('hidden');
  S.beatT = dur || 2.4;
}

/* ---------------------------------------------------------------- text tick */

function tickText(dt){
  if(el.subtitle.classList.contains('hidden')) return;
  if(S.typing){
    S.typeAcc += dt * 42;
    var n = Math.floor(S.typeAcc);
    if(n >= S.phrase.length){
      S.typed = S.phrase;
      S.typing = false;
      S.lineWait = true;
      S.lineHold = 0;
    } else {
      S.typed = S.phrase.slice(0, n);
    }
    el.subText.innerHTML = esc(S.typed) + (S.typing ? '<span class="tut-caret"></span>' : '');
  } else if(S.lineWait){
    S.lineHold += dt;
    var lim = (S.phase === 'outro') ? 7.5 : 6.5;
    if(S.lineHold >= lim) advanceLine();
  }
}

function advanceLine(){
  if(S.phase === 'outro' && S.tipMode){
    hideSubtitle();
    nextStep();
    return;
  }
  if(S.typing){
    /* First press finishes the sentence, second moves on — the same rule every
       dialogue box worth using has. */
    S.typed = S.phrase;
    S.typing = false;
    S.lineWait = true;
    S.lineHold = 0;
    el.subText.innerHTML = esc(S.typed);
    return;
  }
  S.li++;
  if(S.li < S.lines.length) showLine(S.lines[S.li]);
  else finishIntro();
}

function finishIntro(){
  hideSubtitle();
  el.beat.classList.add('hidden');
  S.phase = 'play';
  if(!S.step || !S.step.objective){
    completeStep();
    return;
  }
  /* If the last line left the camera on a subject, bring it home now; the
     objective is driven, so the player needs their own tank back. */
  if(S.shot && !S.shot.released){
    startShot({ to: followPose(S.game), dur: 1.1, release: true });
  }
  el.objective.classList.remove('hidden');
  updateObjective(0);
}

function hideSubtitle(){
  el.subtitle.classList.add('hidden');
  el.subText.innerHTML = '';
}

/* ---------------------------------------------------------------- objective */

/* Signed difference between two angles, in radians, folded into -PI..PI. */
function angleDelta(a, b){
  return ((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

function updateObjective(){
  if(!S.step || !S.step.objective) return;
  var line = S.step.objective;
  var prog = '';
  var frac = 0;
  if(S.step.id === 'drive' && S.game && S.game.localTank && S.startPos){
    var t = S.game.localTank;
    var d = Math.hypot(t.x - S.startPos.x, t.z - S.startPos.z);
    S.count = Math.max(S.count, Math.min(S.step.total, d));
    prog = Math.round(S.count) + ' / ' + S.step.total + ' m';
    frac = S.count / S.step.total;
    if(d >= S.step.total && !S.done) completeStep();
  } else if(S.step.id === 'aim'){
    S.count = Math.min(S.step.total, S.aimTurned || 0);
    prog = Math.round(S.count) + '° / ' + S.step.total + '°';
    frac = S.count / S.step.total;
    if(S.count >= S.step.total && !S.done) completeStep();
  } else if(S.step.id === 'gun'){
    S.count = Math.min(S.step.total, S.shots || 0);
    prog = (S.shots > 0 ? '1' : '0') + ' / 1 shell';
    frac = S.count / S.step.total;
    if(S.shots > 0 && !S.done) completeStep();
  } else if(S.step.id === 'targets'){
    prog = S.count + ' / ' + S.step.total + ' targets';
    frac = S.count / S.step.total;
    if(S.count >= S.step.total && !S.done) completeStep();
  } else if(S.step.id === 'dummies'){
    prog = S.killed + ' / ' + S.step.total + ' dummies';
    frac = S.killed / S.step.total;
    if(S.killed >= S.step.total && !S.done) completeStep();
  } else if(S.step.id === 'bot'){
    var dead = S.botKilled ? 1 : 0;
    prog = dead ? 'DESTROYED' : 'HUNTING';
    frac = dead;
  }

  el.objKicker.textContent = (S.step.kicker || 'OBJECTIVE') + ' — ' + (S.stepIdx + 1) + ' / ' + STEPS.length;
  el.objTitle.textContent = S.step.title;
  el.objLine.textContent = line;
  el.objProg.textContent = prog;
  el.objFill.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
}

function completeStep(){
  if(S.done || !S.step) return;
  S.done = true;
  S.phase = 'outro';
  el.objective.classList.add('done');
  el.objFill.style.width = '100%';
  el.objProg.textContent = 'DONE';
  if(S.step.tip){
    S.tipMode = true;
    S.lines = [{ speaker:'TIP', text:S.step.tip }];
    S.li = 0;
    showLine(S.lines[0]);
    S.advanceAt = (S.game.time || 0) + 9;
  } else {
    S.advanceAt = (S.game.time || 0) + 1.2;
  }
}

/* SKIP THIS PART means the NEXT part, from wherever the player is: mid
   narration, mid objective, or reading the tip after a kill. It used to only
   fast-forward the narration and leave the objective running, which made the
   button look broken on exactly the step a player wanted out of. */
function skipStep(){
  if(!S.step) return;
  S.done = true;
  S.phase = 'outro';
  S.tipMode = false;
  el.objective.classList.add('done');
  el.objProg.textContent = 'SKIPPED';
  hideSubtitle();
  el.beat.classList.add('hidden');
  S.advanceAt = 0;
  nextStep();
}

function skipAll(){
  if(!S.active) return;
  S.active = false;
  S.advanceAt = 0;
  hideSubtitle();
  el.beat.classList.add('hidden');
  el.objective.classList.add('hidden');
  el.layer.classList.add('hidden');
  releaseCam();
  S.phase = 'done';
  if(S.game && S.game._tutState) S.game._tutState._tutorialSkipped = true;
  if(window.Menu && Menu.toast) Menu.toast('Tutorial skipped — the range is yours. Start it again from Training.');
}

function finishTutorial(){
  S.active = false;
  S.phase = 'done';
  hideSubtitle();
  el.beat.classList.add('hidden');
  el.objective.classList.add('hidden');
  el.layer.classList.add('hidden');
  releaseCam();
  var paid = grantStarterPack();
  buildUI();
  showModal(el.reward);
  if(!paid){
    /* Replaying a finished course: the shelf above the buttons would be a lie
       if it claimed a second payout. */
    var pack = el.reward.querySelector('.tut-pack-reward');
    if(pack){
      pack.querySelector('.tut-pack-label').textContent = 'YOU ALREADY KEEP';
    }
  }
}

/* ---------------------------------------------------------------- camera */

function followPose(g){
  var t = g && g.localTank;
  if(!t) return { p: new THREE.Vector3(0, 24, 34), l: new THREE.Vector3(0, 1, 0) };
  var angle = g.camAngle;
  var tankY = t._physBody ? t._physBody.translation().y : 0;
  var camDist = g.camDist || 30;
  var hOff = g._getCamHOffset ? g._getCamHOffset(camDist) : 0;
  return {
    p: new THREE.Vector3(
      t.x + Math.sin(angle) * (camDist + hOff),
      tankY + (g._getCameraHeight ? g._getCameraHeight(camDist) : 18),
      t.z + Math.cos(angle) * (camDist + hOff)),
    l: new THREE.Vector3(t.x, tankY + 2.2, t.z),
  };
}

function startShot(opts){
  var g = S.game;
  if(!opts || !g || !g.camera) return;
  var fromP = g.camera.position.clone();
  var fromL = S.lastLook ? S.lastLook.clone() : new THREE.Vector3(0, 0, 0);
  S.shot = {
    fromP: fromP,
    fromL: fromL,
    toP: opts.to.p.clone(),
    toL: opts.to.l.clone(),
    t: 0,
    dur: Math.max(0.15, opts.dur || 1.8),
    release: !!opts.release,
    released: false,
  };
  g._tutorialCam = true;
  el.layer.classList.add('tut-cine');
}

function releaseCam(){
  S.shot = null;
  if(el.layer) el.layer.classList.remove('tut-cine');
  if(S.game) S.game._tutorialCam = false;
}

function cameraTick(dt){
  var sh = S.shot;
  if(!sh || !S.game) return;
  sh.t += dt;
  var k = Math.min(1, sh.t / sh.dur);
  var e = k * k * (3 - 2 * k);
  S.game.camera.position.lerpVectors(sh.fromP, sh.toP, e);
  var look = S.lastLook || new THREE.Vector3();
  if(!S.lastLook) S.lastLook = look;
  look.lerpVectors(sh.fromL, sh.toL, e);
  S.game.camera.lookAt(look.x, look.y, look.z);
  if(k >= 1){
    if(sh.release){
      sh.released = true;
      S.shot = null;
      S.game._tutorialCam = false;
      if(el.layer) el.layer.classList.remove('tut-cine');
    } else {
      /* Hold the pose: fromP/fromL are moved onto the target so further frames
         keep the camera there instead of snapping back. */
      sh.fromP = sh.toP.clone();
      sh.fromL = sh.toL.clone();
      sh.t = sh.dur;
    }
  }
}

/* ---------------------------------------------------------------- gameplay */

function tick(dt, game){
  if(!S.active || !game) return;
  S.game = game;

  tickText(dt);

  if(S.beatT > 0){
    S.beatT -= dt;
    if(S.beatT <= 0) el.beat.classList.add('hidden');
  }

  if(S.zoneFill){
    S.zoneFill.material.opacity = 0.045 + 0.02 * Math.abs(Math.sin((game.time || 0) * 1.2));
  }

  tickRespawns(game);
  tickTargets(game);
  tickTargetFx(dt);
  tickBot(game);
  tickGunStep(game);

  if(S.phase === 'play' || S.phase === 'outro') updateObjective();

  if(S.advanceAt && (game.time || 0) >= S.advanceAt){
    S.advanceAt = 0;
    hideSubtitle();
    nextStep();
  }
}

/* DID THE PLAYER ACTUALLY FIRE?

   A shot is detected by the reload clock, not by hooking the gun: every tank
   type moves reloadLeft (or magReloadLeft for magazine guns) to its full value
   on the frame it fires, so a RISE beyond a couple of tenths of a second is a
   round leaving the barrel and nothing else. Reading the tank keeps this file
   out of the weapon code, which the tutorial should not have an opinion about. */
function tickGunStep(g){
  var t = g && g.localTank;
  if(!t) return;
  var rl = t.reloadLeft || 0, ml = t.magReloadLeft || 0;
  if(rl > (S.lastReload || 0) + 0.15 || ml > (S.lastMag || 0) + 0.15){
    S.shots = (S.shots || 0) + 1;
  }
  S.lastReload = rl;
  S.lastMag = ml;

  /* Aim travel, accumulated: an aim dragged one way and back still moved the
     gun, and the step is about the movement, not the final heading. */
  if(S.active && S.step && S.step.id === 'aim' && !S.done){
    var ta = t.turretAngle || 0;
    if(S.aimLast == null){ S.aimLast = ta; }
    else {
      var td = Math.abs(angleDelta(ta, S.aimLast));
      if(td > 0.002 && td < 1.2) S.aimTurned = (S.aimTurned || 0) + td * 180 / Math.PI;
      S.aimLast = ta;
    }
  }
}

function tickRespawns(g){
  var st = g._tutState;
  if(!st) return;
  var now = g.time || 0;
  if(st.dummies){
    for(var i=0;i<st.dummies.length;i++){
      var e = st.dummies[i];
      if(e.respawnAt && now >= e.respawnAt){
        e.respawnAt = 0;
        g._tutDisposeTank(e.tank);
        e.tank = g._tutSpawnDummy(e.tankId, e.x, e.z, e.ry);
      }
    }
  }
  var b = st.bot;
  if(b && b.respawnAt && now >= b.respawnAt){
    b.respawnAt = 0;
    g._tutDisposeTank(b.tank);
    b.tank = g._tutSpawnBot(b.x, b.z, b.ry, st.zone);
    hookBot(g);
    if(S.step && S.step.id === 'bot' && !S.done){
      if(window.Menu && Menu.toast) Menu.toast('The bot is back — try it again');
    }
  }
}

/* Hits on the boards.

   Targets are map meshes, not entities, so nothing in the damage pipeline knows
   about them. A shell is counted when it passes inside the board's hit sphere;
   each shell can only count once per board, which is what stops a single round
   from ticking the objective three times. */
function tickTargets(g){
  var st = g._tutState;
  var list = st && st.targets;
  if(!list || !list.length) return;
  var projs = g.projectiles || [];
  for(var i=0;i<projs.length;i++){
    var p = projs[i];
    if(!p || p.dead) continue;
    if(!p._tutHits) p._tutHits = {};
    var px = p.x, py = p.y || 0, pz = p.z;
    for(var j=0;j<list.length;j++){
      var t = list[j];
      if(p._tutHits[j]) continue;
      var dx = px - t.x, dz = pz - t.z, dy = py - t.y;
      if(dx * dx + dz * dz <= t.r * t.r && Math.abs(dy) < 14){
        p._tutHits[j] = 1;
        onTargetHit(g, t, j);
      }
    }
  }
}

function onTargetHit(g, t, idx){
  t.flash = 1;
  try {
    if(window.CartoonFX) CartoonFX.sparks(g.scene, t.x, t.y + 2.4, t.z, 0, 0, { count: 12 });
  } catch(e){}
  try { if(window.Audio && Audio.armorHit) Audio.armorHit(0.5, 0.35); } catch(e){}
  try { if(g.spawnDamageLabel) g.spawnDamageLabel(t.x, t.y + 2.8, t.z, 10); } catch(e){}

  if(S.active && S.step && S.step.id === 'targets' && !S.done && !S.targetHits[idx]){
    S.targetHits[idx] = 1;
    S.count++;
    updateObjective();
  }
}

function tickTargetFx(dt){
  var g = S.game;
  var list = g && g._tutState && g._tutState.targets;
  if(!list) return;
  for(var i=0;i<list.length;i++){
    var t = list[i];
    if(!t.flash) continue;
    t.flash = Math.max(0, t.flash - dt * 2.4);
    var k = 1 + Math.sin(t.flash * Math.PI) * 0.16;
    try { t.mesh.scale.set(t.baseScale.x * k, t.baseScale.y * k, t.baseScale.z * k); } catch(e){}
    if(t.flash === 0 && t.mesh && t.baseScale){
      t.mesh.scale.copy(t.baseScale);
    }
  }
}

/* The bot cannot leave its square. BotBrain's own steering is trusted inside
   the box; this is the wall it cannot argue with. */
function tickBot(g){
  var st = g._tutState;
  var z = st && st.zone;
  var b = st && st.bot && st.bot.tank;
  var lt = g.localTank;
  g._tutPlayerInZone = !!(lt && z &&
    lt.x >= z.minX && lt.x <= z.maxX && lt.z >= z.minZ && lt.z <= z.maxZ);
  if(!b || !z || !b.alive) return;
  var x = Math.min(z.maxX, Math.max(z.minX, b.x));
  var zz = Math.min(z.maxZ, Math.max(z.minZ, b.z));
  if(x !== b.x || zz !== b.z){
    b.x = x; b.z = zz;
    if(b._physBody){
      try { b._physBody.setTranslation({ x: x, y: b._physBody.translation().y, z: zz }, true); } catch(e){}
    }
  }
}

/* Called by the game's kill handler, which returns before victory/results for
   the whole duration of the tutorial. */
function onTankKilled(g, tank, byTank){
  if(!tank) return;

  if(tank.isTutorialDummy){
    var st = g._tutState;
    if(st && st.dummies){
      for(var i=0;i<st.dummies.length;i++){
        if(st.dummies[i].tank === tank){ st.dummies[i].respawnAt = (g.time || 0) + 1.0; break; }
      }
    }
    if(S.active && S.step && S.step.id === 'dummies' && !S.done && byTank === g.localTank){
      S.killed++;
      updateObjective();
      if(window.Menu && Menu.toast) Menu.toast('Dummy down — it will be back in one second');
    }
    return;
  }

  if(tank.isTutorialBot){
    var stb = g._tutState;
    if(stb && stb.bot) stb.bot.respawnAt = (g.time || 0) + 6.0;
    if(S.active && S.step && S.step.id === 'bot'){
      S.botKilled = true;
      if(!S.done) completeStep();
    }
  }
}

/* ---------------------------------------------------------------- lifecycle */

/* Leave the range with no reward and no penalty. The mode stays "tutorial" so
   the victory guard in game.js keeps the range a range; the lesson simply
   stops. */
function shutdown(){
  if(!S.built) return;
  S.active = false;
  S.advanceAt = 0;
  hideSubtitle();
  if(el.beat) el.beat.classList.add('hidden');
  if(el.objective) el.objective.classList.add('hidden');
  if(el.layer) el.layer.classList.add('hidden');
  if(S.zoneMesh && S.game && S.game.scene){
    try { S.game.scene.remove(S.zoneMesh); S.zoneMesh.geometry.dispose(); S.zoneMesh.material.dispose(); } catch(e){}
  }
  if(S.zoneFill && S.game && S.game.scene){
    try { S.game.scene.remove(S.zoneFill); S.zoneFill.geometry.dispose(); S.zoneFill.material.dispose(); } catch(e){}
  }
  S.zoneMesh = null; S.zoneFill = null;
  releaseCam();
}

/* WHEN TO OFFER THE COURSE.

   The gate unlocking is the honest moment: the player has just been handed the
   menu, so an offer cannot interrupt a choice they are still making. The
   timers underneath it are backstops for a page with no gate (an embedded
   build, a returning player whose chooser was skipped before this file was
   parsed). maybePrompt() itself is idempotent and retries while the menu is
   still settling, so calling it more than once is free. */
try {
  window.addEventListener('mtl:gate-unlocked', function(){ setTimeout(maybePrompt, 220); });
  if(document.readyState === 'complete') setTimeout(maybePrompt, 900);
  else window.addEventListener('load', function(){ setTimeout(maybePrompt, 900); });
  setTimeout(maybePrompt, 4000);
} catch(e){}

return {
  begin: begin,
  tick: tick,
  cameraTick: cameraTick,
  onTankKilled: onTankKilled,
  maybePrompt: maybePrompt,
  startTraining: startTraining,
  shutdown: shutdown,
  isDone: isDone,
  step: function(){ return S.step ? S.step.id : null; },
  debug: S,
};
})();
