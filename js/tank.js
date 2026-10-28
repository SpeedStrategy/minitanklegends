// Shortest signed angle diff from b to a, in (-PI, PI]
function _angDiff(a, b){
  let d = (a - b) % (Math.PI * 2);
  if(d > Math.PI) d -= Math.PI * 2;
  if(d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* ---- momentum lean tuning (see Tank._updateLean) ---- */
const LEAN_PITCH = 0.122;   /* 7.0 degrees — nose up / nose down          */
const LEAN_ROLL  = 0.087;   /* 5.0 degrees — the hull rolling in a corner  */
const LEAN_STIFF = 110;     /* stands in for gravity pulling the hull level */
const LEAN_DAMP  = 10;      /* lets it overshoot once, then settle          */

/* ---- outline widths ----
   OUTLINE_TANK is deliberately WIDER than the old baked hull (0.055). The
   push now happens in the vertex shader, so a bigger number is a genuinely
   wider outline rather than a rebuild — and the tanks are the thing the eye
   has to find first in a fight, so they get the heavier line.
   OUTLINE_MAP is much thinner: the map is context, not a character, and a
   fat outline on every wall turns a fight into a wireframe. */
const OUTLINE_TANK = 0.085;
const OUTLINE_MAP  = 0.028;

/* WHICH CARTOON HEALTH BAR THE GAME DRAWS.
   1 SOLID   2 CHUNKY   3 FINE   4 GLOSS   5 BOLD

   See js/hpbar-styles.js for what each one is. Change this one number to switch
   the whole game's nameplates; the style preview page next to the game renders
   all five with this same code so the choice can be made by looking rather than
   by guessing.

   Currently 3 (FINE), which is what the game already had minus the per-block
   white specular streak. Nothing else about the previous look has changed. */
const HPBAR_STYLE = 3;

/* THE EQUIPPED AVATAR, AS AN IMAGE.

   The nameplate frame used to draw a trophy emoji for anybody who owned any
   trophy at all, so everyone in a match wore the same face no matter what they
   had earned. It draws the trophy the player actually equipped instead, from
   the same helper the menus read, so the picture on the nameplate and the
   picture in the profile card can never be two different trophies.

   Remote tanks keep the emoji: what somebody else equipped is not sent over the
   wire, and guessing at it from a trophy count would be worse than honest. */
const _avatarIconCache = {};
function getAvatarIcon(){
  if(typeof getEquippedTrophy !== 'function') return null;
  let t = null;
  try{ t = getEquippedTrophy(); }catch(e){ return null; }
  if(!t || !t.icon) return null;
  if(_avatarIconCache[t.id]) return _avatarIconCache[t.id];
  const img = new Image();
  img.src = t.icon;
  /* Arriving after the frame was first painted is the normal case — the image is
     fetched on first use — so the plate is redrawn the moment it lands. */
  img.onload = () => { try{ refreshAvatarIcons(); }catch(e){} };
  img.onerror = () => {};
  _avatarIconCache[t.id] = img;
  return img;
}
window.getAvatarIcon = getAvatarIcon;

function refreshAvatarIcons(){
  const g = window.__game || window.Game;
  try{
    if(g && g.localTank && g.localTank._drawHp) g.localTank._drawHp();
  }catch(e){}
}
window.refreshAvatarIcons = refreshAvatarIcons;
class Tank {
  constructor(def, opts={}){
    /* PROGRESSION 2.0: the bought upgrade tree bakes into the def the moment
       the tank spawns, so hp/damage/speeds/arms really change in battle.
       Tanks with no progress get their shared def untouched (bots included).
       `upStats` carries the numbers that are read per-frame instead of per-
       spawn: reverse km/h bonus, super cooldown cut, the passive charge
       rate and the penetration % the projectile ricochet pass uses. */
    /* Only the LOCAL player's tank wears the tree. It used to apply to every
       tank of the same type, so upgrading Cool Buddy upgraded every bot Cool
       Buddy too. The tree is saved on this machine and belongs to this player. */
    const upStats = (window.Progression && def && def.id && opts.isLocal) ? window.Progression.tankStats(def.id) : null;
    if (window.Progression && opts.isLocal) def = window.Progression.defWithUpgrades(def);
    this.upStats = upStats && upStats.anyBought ? upStats : null;
    this.def = def;
    this.id   = opts.id   || ('tank_'+Math.random().toString(36).slice(2,8));
    this.name = opts.name || 'Tank';
    this.isLocal = !!opts.isLocal;
    this.isBot   = !!opts.isBot;
    this.color   = opts.color != null ? opts.color : def.color;
    this.ownerPeer = opts.ownerPeer || null;

    this.x = opts.x || 0;
    this.z = opts.z || 0;
    this.heading = opts.heading || 0;
    this.turretAngle = opts.turretAngle || 0;
    this.speed = 0;
    this.vx = 0; this.vz = 0;
    this.drifting = false;

    this.trailSegments = [];
    this._trailTimer = 0;

    this.maxHp = def.hp; this.hp = this.maxHp;
    this.mass  = def.mass || 30;
    this.viewRange = def.viewRange || 70;
    this.alive = true; this.respawnAt = 0;
    this.damageDealt = 0; this.kills = 0;
    /* World of Tanks assists: damage I dealt to a tank that a TEAMMATE finished
       off. Accumulated in _payAssists() when the victim dies, because it needs
       both facts together and only the death has both. */
    this.assists = 0;
    /* Who has hit me this life, and how much. Cleared on every death. */
    this._damagedBy = null;
    this.reloadLeft = 0;
    this.mag = def.magSize || 1;
    this.magReloadLeft = 0;
    this._burstRemaining = 0;
    this._burstTimer = 0;
    this._doubleMode = 'single';
    this._shotgunTilt = 0;
    this._shotgunTiltDecay = 4;
    /* ---- momentum lean state (see _updateLean) ---- */
    this._leanP = 0; this._leanR = 0;          // current lean, radians
    this._leanPV = 0; this._leanRV = 0;        // lean speed (the spring's velocity)
    this._leanVX = 0; this._leanVZ = 0;        // previous world velocity
    this._leanPX = 0; this._leanPZ = 0;        // previous position
    this._leanToken = 0;                      // last frame the lean was stepped on

    // Super ability state
    this.superCdLeft = 0;
    /* Super cool levels knock whole seconds off the cooldown; floor keeps
       the ability from becoming spammable by a maxed tree. */
    this.superCdTotal = Math.max(
      (window.Progression && window.Progression.KNOBS.SUPER_CD_FLOOR) || 8,
      ((CONFIG && CONFIG.SUPER_COOLDOWN) || 60) - (upStats ? upStats.superCoolS : 0)
    );
    this.superState = null;   // targeting|strike|windup|cloaked|panzer_drop|oil_fill|oil_burn
    this.superTimer = 0;
    this.superTarget = null;
    this.myBushes = [];
    this.allyId = null;
    this._cloakedMats = [];

    this.heat = 0;
    this.overheated = false;

    // Gladiator power: 1 power = +1% damage, +1% max HP, +1% size
    this.power = 0;
    this.hitScale = 1;

    this.camoState = null;
    this.camoFactor = 1;
    /* Cover state. coverOverlap is 0..1 and authoritative -- the host computes it
       and ships it, so a client never runs its own overlap test and never
       disagrees with the bots that are shooting at it. coverRevealed is the
       countdown on having shaken the foliage. */
    this.coverOverlap = 0;
    this.coverRevealed = 0;
    /* Whether the model is currently switched off for camouflage. Tracked
       separately from camoFactor so _applyCamoVisual only touches visibility
       on the frames it actually flips, rather than every frame for every tank. */
    this._camoHidden = false;

    this.dying = false;
    this.deathT = 0;
    this.removeAt = -1;
    this._uiScale = 1.0;

    const _edOv = (window.TANK_EDITOR_OVERRIDES && window.TANK_EDITOR_OVERRIDES[def.id]) || null;
    this._edOv = _edOv;
this._modelYaw = (def && def.modelYaw != null) ? def.modelYaw * Math.PI / 180 : 0;
    this._modelOff = new THREE.Vector3();
    /* FULL MODEL ORIENTATION, SOLVED FROM ITS FRONT AND UP AXES.

       `_modelYaw` alone can only spin a model about Y, which is enough for a
       tank authored along +Z and hopeless for one authored along +X: rotating
       90 degrees brings the length axis onto the game's forward, but leaves
       the model's own up pointing along -X, so the tank drives into the ground
       on its side. That is the whole of "many tank models drive forwards on
       their sides" — it is not a physics bug, it is a rotation that was never
       expressible, and every such def had to be hand-patched with a yaw that
       happened to look right from one camera angle.

       So the orientation is stored as WHICH AUTHORED AXIS IS FRONT and WHICH
       IS UP, and the rotation is solved from that pair. See solveModelQuat. */
    this._modelQuat = Tank.solveModelQuat(
      (def && def.modelFront) || null,
      (def && def.modelUp) || null
    );
    /* FREE ROTATION, ON TOP OF THE SOLVED ORIENTATION.

       modelFront/modelUp answer "which way is this model facing", which is a
       question with six answers and fixes the model to a pose where two of its
       own axes line up with the world's. That is enough to make a tank drive
       the right way and is still not enough to set a model up with, because a
       model is very often authored a few degrees off — a hull that sits at 4
       degrees of roll because the artist modelled it that way, a turret whose
       mantlet is 6 degrees off square. Before this there was no way to correct
       that at all: modelYaw spins about Y and nothing else exists, so a model
       that was right about facing and still visibly crooked had to be
       re-authored.

       Composed ON TOP of the solved pair rather than instead of it, so the two
       stay independent: front/up says which way it drives, and this says how
       it sits. Order matters and is euler-then-correction — see _applyModelQuat.
       Degrees, matching modelYaw, and all three default to zero so a def that
       does not mention it behaves exactly as before. */
    this._modelEuler = { x:0, y:0, z:0 };
    const _mr = def && def.modelRotate;
    if(_mr){
      if(typeof _mr.x === 'number') this._modelEuler.x = _mr.x;
      if(typeof _mr.y === 'number') this._modelEuler.y = _mr.y;
      if(typeof _mr.z === 'number') this._modelEuler.z = _mr.z;
    }
    /* The solved orientation subsumes the yaw: applying both would spin the
       model twice. When there is no declared front/up, `_modelQuat` is null and
       `_modelYaw` is used alone, exactly as before. */
    if(this._modelQuat) this._modelYaw = 0;
    if(_edOv && _edOv.model){
      const _m = _edOv.model;
      const _q = Tank.solveModelQuat(_m.front || null, _m.up || null);
      if(_q){ this._modelQuat = _q; this._modelYaw = 0; }
      else if(typeof _m.yaw === 'number'){
        this._modelQuat = null;
        this._modelYaw = _m.yaw * Math.PI / 180;
      }
      if(_m.rotate){
        const r = _m.rotate;
        if(typeof r.x === 'number') this._modelEuler.x = r.x;
        if(typeof r.y === 'number') this._modelEuler.y = r.y;
        if(typeof r.z === 'number') this._modelEuler.z = r.z;
      }
    }
    const GLOBAL_SCALE = Tank.GLOBAL_SCALE;
    this.colHalfW = def.body.w * 0.55 * GLOBAL_SCALE;
    this.colHalfL = def.body.l * 0.55 * GLOBAL_SCALE;
    this.colHalfH = (def.body.h || 1.0) * 0.5 * GLOBAL_SCALE;
    if(_edOv && _edOv.body){
      const _b = _edOv.body;
      this.colHalfW = Math.max(0.1, _b.w || def.body.w) * 0.55 * GLOBAL_SCALE;
      this.colHalfL = Math.max(0.1, _b.l || def.body.l) * 0.55 * GLOBAL_SCALE;
      this.colHalfH = Math.max(0.1, _b.h || def.body.h || 1.0) * 0.5 * GLOBAL_SCALE;
    }
    /* THE TREADS, resolved once here so nothing downstream has to deal with a
       missing block or a null. An editor override wins over the tank's own
       `tracks`, exactly as it wins over `body` above. */
    this.tracks = Tank.resolveTracks(def, _edOv);
    this._trackWheels = [];
    this._trackGroup  = null;
    this._trackSpin   = 0;

    this._physBody = null;
    this._physCollider = null;
    this._physWorld = opts.physicsWorld || null;
    this._allowFall = !!opts.allowFall;
    this._startY = (opts.startY != null) ? opts.startY : null;
    if(this._allowFall && this._startY != null) this.y = this._startY;
    this._createPhysBody();

    this._inWater = false;

    this._tmpQuat = new THREE.Quaternion();
    this._tmpQuat2 = new THREE.Quaternion();
    this._tmpEuler = new THREE.Euler();
    this._tmpVec3 = new THREE.Vector3();
    this._tmpLinvel = {x:0, y:0, z:0};
    this._tmpAngvel = {x:0, y:0, z:0};
    this._lastFriction = -1;

    // Model-driven gun recoil (populated by _attachNamedModel when the model
    // authors its own gun node around the muzzle, e.g. TL_ark's "Cylinder").
    this._recoilNode = null;
    this._recoilHome = null;
    this._recoilKick = 0;
    this._recoilT = -1;

    // Model-driven gun ELEVATION, used by the Mortar. `_gunNode` is the authored
    // arm the barrel hangs off (Cube.003 in TL_mortar.glb); rotating it about its
    // local Z lifts the muzzle, because the barrel runs along its local +X.
    // `gunElevTarget` is written by Game._mortarAim in degrees and eased toward by
    // _updateGunAssembly, so a mouse flick cannot snap the barrel.
    this._gunNode = null;
    this._gunHomeRotZ = 0;
    /* How far the gun arm's own geometry reaches along its barrel axis, measured
       once in _loadModel while the model's parts are still parented as authored.
       null means "not measurable", which the artillery barrel reconstruction
       treats as "the barrel is missing" and fills. See the note at the capture
       site for why it cannot be measured later. */
    this._armFrontLocalX = null;
    this._gunElev = 0;         // degrees, current
    this.gunElevTarget = 0;    // degrees, desired

    this._buildCubeMesh();
    if(Models && this.def.model && Models.hasModel(this.def.model)){
      this._loadModel();
      /* The model's own treads arrive with the model, and the loader's opening
         sweep removes the placeholder body the procedural tracks were built on.
         So the question of which gear this tank ends up with can only be
         answered once the model has finished — hence this, chained onto the same
         readiness promise the rest of the spawn path already waits on.

         For a tank with no `tracks.replace` this is a no-op: it scans nothing,
         hides nothing, and leaves the model exactly as it was. */
      Promise.resolve(this._modelReady).catch(()=>null).then(() => {
        try { this._applyTrackGearPolicy(); } catch(e){ console.warn('[tank] track gear policy:', e); }
        try { this._fitHitboxToModel(); } catch(e){ console.warn('[tank] hitbox fit:', e); }
      });
    } else {
      try { this._fitHitboxToModel(); } catch(e){}
    }

    // Sprays placed in the tank menu are stamped onto the real tank once the
    // model — or the cube fallback — is in place.
    if(window.TankSprays){
      const _ready = (this._modelReady && typeof this._modelReady.then === 'function') ? this._modelReady : Promise.resolve();
      _ready.catch(()=>null).then(()=>{ if(window.TankSprays) TankSprays.apply(this); });
    }

    /* STYLES (cosmetics): one seamless texture mapped over the whole model,
       applied AFTER the model replaced the placeholder — applyToModel skips
       outlines/sprays/helpers, so what ends up coloured is exactly the hull
       and turret the player sees. Chained on the same readiness promise the
       sprays use, so the style never lands on the box build that the model
       sweep then deletes. Safe no-op when nothing is equipped. */
    if(window.TankStyles){
      const _readyS = (this._modelReady && typeof this._modelReady.then === 'function') ? this._modelReady : Promise.resolve();
      _readyS.catch(()=>null).then(()=>{ if(window.TankStyles) TankStyles.apply(this); });
    }
  }

  _createPhysBody(){
    if(!this._physWorld || typeof RAPIER === 'undefined') return;
    try {
      var initY = this._allowFall ? (this._startY != null ? this._startY : 50) : 6.0;
      var desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(this.x, initY, this.z)
        .setCcdEnabled(true)
        .setLinearDamping(this._allowFall ? 0.3 : 0.8)
        .setAngularDamping(this._allowFall ? 2.0 : 2.0);
      this._physBody = this._physWorld.createRigidBody(desc);
      var col = RAPIER.ColliderDesc.cuboid(this.colHalfW, this.colHalfH, this.colHalfL)
        .setDensity(this.mass / (this.colHalfW * 2 * this.colHalfH * 2 * this.colHalfL * 2))
        .setRestitution(0.15)
        .setFriction(0.7);
      this._physCollider = this._physWorld.createCollider(col, this._physBody);
      if(this._physCollider && typeof this._physCollider.setActiveEvents === 'function'){
        this._physCollider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      }
      this._physCollider.userData = {type:'tank', tank:this};
    } catch(e){ console.warn('Tank phys body FAILED:', e); this._physBody = null; }
  }

  _applyEditorOverrides(){
    // Tank Editor (Editor123) overrides: reapplied after the model finishes
    // building so the hitbox, turret pivot, turret position and firing point
    // match the saved values.
    const ov = this._edOv;
    if(!ov) return;
    /* THE TREADS, when the editor has changed them.

       The geometry has to be rebuilt rather than nudged, because a wheel count
       or a tread width changes how many objects exist. Cleared and rebuilt in
       place so the old meshes and their outlines go with it — leaking a dozen
       cylinders per edit is exactly the sort of thing that turns a tank
       un-deletable from the menu after a while. */
    if(ov.tracks){
      const before = JSON.stringify(this.tracks);
      this.tracks = Tank.resolveTracks(this.def, ov);
      if(JSON.stringify(this.tracks) !== before){
        /* Goes through the policy, not straight to the builder, because turning
           `replace` on has to HIDE the model's own gear as well as draw the new
           one. Calling _buildTracks directly left the baked-in wheels visible
           underneath — two sets of wheels on one tank. */
        try {
          this._applyTrackGearPolicy();
          this._shadowDirty = true;
        } catch(e){ /* a rebuild failure must not take the tank with it */ }
      }
    }
    if(ov.body && this.bodyMesh && this.bodyMesh.geometry && this.bodyMesh.geometry.parameters){
      const g = this.bodyMesh.geometry.parameters;
      const s = ov.body;
      this.bodyMesh.scale.set(
        (s.w && g.width) ? Math.max(0.05, s.w / g.width) : 1,
        (s.h && g.height) ? Math.max(0.05, s.h / g.height) : 1,
        (s.l && g.depth) ? Math.max(0.05, s.l / g.depth) : 1
      );
    }
    if(ov.pivot && this._modelTurretPivot){
      this._modelTurretPivot.position.set(ov.pivot.x || 0, ov.pivot.y || 0, ov.pivot.z || 0);
    }
    if(ov.turret && this._turretHome){
      this._turretHome.set(ov.turret.x || 0, ov.turret.y || 0, ov.turret.z || 0);
    }
    // Re-home the turret mesh so a moved pivot only changes the ROTATION
    // point and a moved turret marker only changes where the turret sits
    // on the hull (never let the two drag each other).
    this._applyTurretPlacement();
    if(ov.casing && this._casingOffset){
      this._casingOffset.set(ov.casing.x || 0, ov.casing.y || 0, ov.casing.z || 0);
    }
    if(ov.shell && this.barrelEnd){
      this.barrelEnd.position.set(ov.shell.x || 0, ov.shell.y || 0, ov.shell.z || 0);
    }
    if(ov.model && this._syncTransform){
      const defYaw = (this.def && this.def.modelYaw != null) ? this.def.modelYaw : 0;
      /* Prefer the declared front/up pair; fall back to the raw yaw only when
         the override carries no usable pair, so an override saved by an older
         editor build keeps working. */
      const q = Tank.solveModelQuat(ov.model.front || null, ov.model.up || null);
      if(q){ this._modelQuat = q; this._modelYaw = 0; }
      else {
        this._modelQuat = null;
        this._modelYaw = (typeof ov.model.yaw === 'number') ? ov.model.yaw * Math.PI / 180 : defYaw * Math.PI / 180;
      }
      if(ov.model.rotate){
        const r = ov.model.rotate;
        this._modelEuler.x = typeof r.x === 'number' ? r.x : 0;
        this._modelEuler.y = typeof r.y === 'number' ? r.y : 0;
        this._modelEuler.z = typeof r.z === 'number' ? r.z : 0;
      }
      this._applyModelQuat();
      if(!this._modelOff) this._modelOff = new THREE.Vector3();
      this._modelOff.set(ov.model.x || 0, ov.model.y || 0, ov.model.z || 0);
      this._syncTransform();
    }
  }

  /* turretG lives inside turretPivot, so its world position would follow the
     pivot's position. Keep the turret mesh planted at _turretHome (its mount
     point, in turretParts space) and let the pivot handle rotation only:
     turretG.local = home - pivot. */
  _applyTurretPlacement(){
    if(!this._turretG || !this._modelTurretPivot) return;
    const O = this._turretHome || new THREE.Vector3(0, 0, 0);
    const P = this._modelTurretPivot.position;
    this._turretG.position.set(O.x - P.x, O.y - P.y, O.z - P.z);
    this._turretG.updateMatrixWorld(true);
  }

  /* Gun ribbon system — glowing emissive bands on the barrel (WoT style) */
  _applyGunRibbons(){
    // Remove old ribbons
    if(this._ribbonBands){
      this._ribbonBands.forEach(function(b){ b.parent.remove(b); b.geometry.dispose(); b.material.dispose(); });
      this._ribbonBands = null;
    }
    if(!window.UpgradeTree || !this.barrel) return;
    var count = UpgradeTree.getRibbons(this.def.id);
    if(count < 1) return;
    var bl = this.def.barrelLen, br = this.def.barrelR;
    var bands = [];
    for(var i = 0; i < count; i++){
      // Position bands along barrel: 30%, 55%, 80% from base
      var pcts = [0.30, 0.55, 0.80];
      var zOff = -bl/2 + bl * pcts[i];
      var bandGeo = new THREE.TorusGeometry(br + 0.02, 0.018, 8, 24);
      var bandMat = Toon.mat({
        color: 0xffffff,
        emissive: 0xff8800,
        emissiveIntensity: 1.5,
        transparent: true,
        opacity: 0.92
      });
      var band = new THREE.Mesh(bandGeo, bandMat);
      band.rotation.x = Math.PI/2;
      band.position.set(0, this.def.turret.h * 0.4, this.def.turret.l/2 + bl/2 + zOff);
      band.renderOrder = 999;
      this.turretGroup.add(band);
      bands.push(band);
    }
    this._ribbonBands = bands;
    this._ribbonTime = 0;
  }

  _updateRibbons(dt){
    if(!this._ribbonBands || this._ribbonBands.length < 1) return;
    this._ribbonTime = (this._ribbonTime || 0) + dt;
    var pulse = 0.7 + Math.sin(this._ribbonTime * 3) * 0.3;
    for(var i = 0; i < this._ribbonBands.length; i++){
      this._ribbonBands[i].material.emissiveIntensity = 1.2 + pulse * 0.6;
      this._ribbonBands[i].material.opacity = 0.85 + pulse * 0.15;
    }
  }

  /* Create an AnimationMixer for the model's GLB clips and loop the
     requested animation (default: the first clip, e.g. Cool Buddy's
     "gun firing" fire effect). Tracks resolve by node name against
     this.root, so they keep working after the named hull/turret groups
     are re-parented into bodyParts/turretParts. */
  _setupAnims(grp){
    if(this._animMixer){
      try{ this._animMixer.stopAllAction(); }catch(e){}
      this._animMixer = null;
    }
    if(this._edOv && this._edOv.model && this._edOv.model.anim === false) return;
    if(this.def && this.def.playAnims === false) return;
    const clips = (grp && grp.userData && grp.userData.anims) || null;
    if(!clips || !clips.length) return;
    const wanted = [];
    const want = (this.def && this.def.fireAnim) || null;
    if(want){
      const lw = String(want).toLowerCase();
      for(let i = 0; i < clips.length; i++){
        if(clips[i] && clips[i].name && String(clips[i].name).toLowerCase() === lw) wanted.push(clips[i]);
      }
    }
    if(!wanted.length){
      // No specific clip requested: play every clip. A model's firing
      // animation is often split across several tracks (one per barrel part),
      // so all of them must run together for the recoil to look right.
      for(const c of clips){ if(c) wanted.push(c); }
    }
    if(!wanted.length) return;
    try{
      const mixer = new THREE.AnimationMixer(this.root);
      for(const clip of wanted){
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = true;
        action.play();
      }
      this._animMixer = mixer;
    }catch(e){ console.warn('tank anim:', e); this._animMixer = null; }
  }

  _tankMat(color){
    const c = new THREE.Color(color);
    c.lerp(new THREE.Color(0xffffff), 0.08);
    return Toon.mat({color:c, flatShading:false});
  }

  _buildCubeMesh(){
    this.bodyGroup = new THREE.Group();
    const b = this.def.body;
    const SCALE = 2.0;
    this.bodyMat = this._tankMat(this.color);
    this.bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(b.w * SCALE, b.h * SCALE, b.l * SCALE), this.bodyMat);
    this.bodyMesh.position.y = b.h * SCALE / 2 + 0.45 * SCALE;
    this.bodyMesh.castShadow = true;
    this.bodyMesh.receiveShadow = true;
    this.bodyGroup.add(this.bodyMesh);

    /* THE TREADS. Was two boxes built from constants — identical on every tank in
       the game — now built from the tank's own resolved `tracks` block. See
       Tank.resolveTracks and _buildTracks for what is configurable. */
    this._buildTracks(this.bodyGroup, SCALE);

    this.turretGroup = new THREE.Group();
    this.turretGroup.position.y = b.h * SCALE * 0.55;
    const t = this.def.turret;
    this.turretMat = this._tankMat(this.def.turretColor);
    this.turretMesh = new THREE.Mesh(new THREE.BoxGeometry(t.w * SCALE, t.h * SCALE, t.l * SCALE), this.turretMat);
    this.turretMesh.position.y = t.h * SCALE / 2;
    this.turretMesh.castShadow = true;
    this.turretMesh.receiveShadow = true;
    this.turretGroup.add(this.turretMesh);

    this.barrelMat = Toon.mat({color:0x353540});
    const barrelMat = this.barrelMat;
    const bl = this.def.barrelLen * SCALE, br = this.def.barrelR * SCALE;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(br, br, bl, 10), barrelMat);
    barrel.rotation.x = Math.PI/2;
    barrel.position.set(0, t.h * SCALE * 0.4, t.l * SCALE / 2 + bl / 2);
    barrel.castShadow = true;
    barrel.receiveShadow = true;
    this.turretGroup.add(barrel);
    this._addOutline(barrel, this.turretGroup);
    this.barrelEnd = new THREE.Object3D();
    this.barrelEnd.position.set(0, t.h * SCALE * 0.4, t.l * SCALE / 2 + bl + 0.2 * SCALE);
    this.turretGroup.add(this.barrelEnd);

    this._addOutline(this.bodyMesh, this.bodyGroup);
    this._addOutline(this.turretMesh, this.turretGroup);

    this.root = new THREE.Group();
    this.root.add(this.bodyGroup);
    this.root.add(this.turretGroup);
    /* THE MODEL'S OWN ORIENTATION, ON A GROUP OF ITS OWN.

       It cannot live on bodyGroup. _syncTransform writes bodyGroup's rotation
       as a YXZ euler and then keeps MUTATING its x and z — the drift lean, the
       shotgun tilt, the momentum lean — by lerping them toward zero. Those are
       Euler components of the whole tank transform, so folding a general
       rotation into that euler meant the drift lean quietly ate it: a
       front:+X / up:-Z model measured 0.31 rad off within a second and was
       still decaying, because the correction had been decomposed into angles
       the lean was then free to damp away.

       On its own group underneath bodyGroup and turretGroup the correction is
       simply not in the euler's path, so the lean code behaves exactly as it
       always has. It is also the right ORDER: the heading turn happens on
       bodyGroup, outside this, so the tank steers and the corrected model goes
       round with it. Putting the correction above bodyGroup instead would
       apply it in world space and leave the model pointing the same way while
       the tank turned.

       Created unconditionally with an identity quaternion, so for every tank
       that declares no front/up — which is all of them today — this is an
       invisible empty group and nothing downstream changes. */
    this._ensureOrientGroups();
    this._addOverlays(t.h * SCALE);
    this._syncTransform();
    this._applyEditorOverrides();
    this._applyGunRibbons();
  }

  /* THE SIX AUTHORED AXES, as unit vectors. A def names two of them — the one
     that points out of the tank's FRONT and the one that points out of its
     TOP — and the rotation between the model's frame and the game's is solved
     from that pair. Spelling them as '+X'/'-X' rather than as numbers is
     because a def is read by people: `modelFront:'+X'` says what the model does,
     where `modelAxis:[1,0,0]` says what the maths is. */
  static AXES(){
    if(!Tank.__axes){
      Tank.__axes = {
        '+X': new THREE.Vector3( 1, 0, 0), '-X': new THREE.Vector3(-1, 0, 0),
        '+Y': new THREE.Vector3( 0, 1, 0), '-Y': new THREE.Vector3( 0,-1, 0),
        '+Z': new THREE.Vector3( 0, 0, 1), '-Z': new THREE.Vector3( 0, 0,-1),
      };
    }
    return Tank.__axes;
  }

  /* The no-correction quaternion, shared. Not a field because the orientation
     groups must not all point at one mutable object. */
  static get _IDENT(){
    if(!Tank.__ident) Tank.__ident = new THREE.Quaternion();
    return Tank.__ident;
  }

  /* THE MODEL'S FRONT AND UP, SAID AS AXES, SOLVED AS A ROTATION.

     Returns null when the pair is unusable — either axis missing, or the two
     parallel (a tank cannot face along its own up), which is left to the
     caller's existing yaw path rather than silently producing a degenerate
     matrix.

     The construction: build an orthonormal basis in the MODEL's frame from the
     declared front and up, build the game's basis (right +X, up +Y, forward
     +Z), and take the rotation that carries one onto the other,
     R = A . B^T. Both bases are orthonormal so the inverse is the transpose,
     and det(R) = 1 for every valid pair — checked for all 24 of them rather
     than assumed, because a mirror here would show up as a tank driving
     backwards with its treads on the ceiling, and a negative determinant is
     exactly how that happens. */
  /* ================================================================ HIT BOX */

  /* The one scale between authored body numbers and world units. It was a local
     `const` inside the constructor, which meant the track gear policy — a
     method, not the constructor — had no way to ask how big the running gear
     should be drawn and every path to it dead-ended on a ReferenceError. */
  static GLOBAL_SCALE = 2.0;

  /* ONE FOOTPRINT, USED BY PHYSICS AND BY EVERYTHING THAT HITS YOU.

     This is the fix for a disagreement that had been in the game from the
     start. The Rapier collider is built from colHalfW/colHalfL — an oriented
     box, shrunk to 0.55 of the declared body so driving feels forgiving — and
     every hit test used to be a CIRCLE of `Math.max(body.w, body.l)/2`. Those
     are not the same shape and they are not the same size:

       coolbuddy, body 8.332 x 10.017
         physics half-width   8.332 * 0.55 = 4.58
         physics half-length 10.017 * 0.55 = 5.51
         hit radius  max(w,l)/2      = 5.01

     So a shot landing half a metre outside the tank's side counted as a hit,
     while a shot inside the front of the tank did not. Nobody had noticed
     because a circle roughly the size of the tank still "feels" right until
     you stand still and measure where the line of fire actually passes.

     Both now come from here, so the two can never drift apart again: the
     collider, and every projectile, blast, proximity fuse and water test.

     THE SHAPE IS AN ORIENTED BOX, not a circle and not a world-aligned box. A
     tank is 10 units long and 8 wide, so a circle has to be the long axis to
     cover it and is therefore a unit wider than the hull on each side. An OBB
     is the hull, exactly. The rotation is the tank's own heading, so a tank
     turned across your line of fire presents its narrow side and a tank facing
     you presents its full length — which is what a player expects and what a
     circle can never do.

     `pad` grows the box for the thing doing the testing: a shell passes its own
     radius, so a fast round travelling 3 units in a frame cannot tunnel through
     the gap between two positions. */
  hitTest2D(px, pz, pad){
    const s = this.hitScale || 1;
    const hw = this.colHalfW * s + (pad || 0);
    const hl = this.colHalfL * s + (pad || 0);
    const dx = px - this.x, dz = pz - this.z;
    /* Fast reject against the bounding CIRCLE first. It is only ever used to say
       "definitely not a hit" — never to say "yes" — so the two shapes agreeing
       exactly is not required here, and it keeps the common case (a shell
       nowhere near any tank) down to four multiplies. */
    if(dx*dx + dz*dz > (hw + hl) * (hw + hl)) return false;
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    /* Local axes. The tank's nose is +Z, which the game has always defined as
       (sin h, cos h) — see the look-ahead maths in Game._update — and the width
       axis is its perpendicular. The sign of the width axis does not matter
       because both tests take an absolute value. */
    const lz = dx * sh + dz * ch - (this.colOffZ || 0) * s;   /* along the length */
    const lx = dx * ch - dz * sh - (this.colOffX || 0) * s;   /* across the width */
    return Math.abs(lx) <= hw && Math.abs(lz) <= hl;
  }

  /* Ground distance from a point to the edge of the same footprint, 0 inside.
     Blasts measure from here, so a shell landing on the nose of a long tank
     counts as landing ON it rather than half a hull length away. */
  distTo2D(px, pz){
    const s = this.hitScale || 1;
    const hw = this.colHalfW * s, hl = this.colHalfL * s;
    const dx = px - this.x, dz = pz - this.z;
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    const lz = dx * sh + dz * ch - (this.colOffZ || 0) * s;
    const lx = dx * ch - dz * sh - (this.colOffX || 0) * s;
    return Math.hypot(Math.max(0, Math.abs(lx) - hw), Math.max(0, Math.abs(lz) - hl));
  }

  /* ================================================================ TRACKS */

  /* BUILD THE RUNNING GEAR.

     Replaces a fixed pair of boxes. Everything here is driven by the resolved
     `tracks` block, so a tank with no `tracks` key still gets exactly what it
     had before — the same slab, derived from its own body — and every tank that
     does have one gets its own tread width, wheel count and wheel size.

     WHAT IS DRAWN, in order back to front so the sort behaves:

       the BAND     a box the length and height of the tread run, inset so the
                    wheels sit inside it rather than in front of it
       the LUGS     `treadScale` copies of a raised cleat across the band, which
                    is what makes it read as a tread rather than as a kerb
       the WHEELS   road wheels between the idler and the sprocket
       the ENDS     idler at the front, sprocket at the rear, both bigger than
                    the road wheels because on every real tank they are

     Wheels are kept in `this._trackWheels` with their own axis so _updateTracks
     can spin them from how far the tank has driven. Every one is a cylinder
     rotated onto the tank's width axis, which is X — a wheel has to lie flat
     across the hull, not stand up in it. */
  _buildTracks(parent, SCALE){
    const T = this.tracks;
    this._trackWheels = [];
    this._trackGroup = null;
    if(!T || !T.on || !parent) return;

    const g = new THREE.Group();
    const treadMat = Toon.mat({color:T.color});
    const rimMat   = Toon.mat({color:T.rim});

    const bandH = T.height * SCALE;
    const bandW = T.width  * SCALE;
    const bandL = T.length * SCALE;
    const off   = T.offset  * SCALE;
    const yc    = bandH * 0.5;

    for(let side = -1; side <= 1; side += 2){
      const band = new THREE.Mesh(new THREE.BoxGeometry(bandW, bandH, bandL), treadMat);
      band.position.set(side * off, yc, 0);
      band.castShadow = true; band.receiveShadow = true;
      g.add(band);
      this._addOutline(band, g);

      /* LUGS. One raised cleat every `1 / treadScale` units of length, so the
         count scales with the tread rather than being a fixed number — a long
         hull gets more cleats, which is both what looks right and what it is. */
      if(T.treadScale > 0.01 && T.type !== 'solid'){
        const pitch = Math.max(0.18, 0.55 / T.treadScale) * SCALE;
        const n = Math.max(2, Math.min(40, Math.round(bandL / pitch)));
        const lugMat = Toon.mat({color:T.color});
        const lg = new THREE.BoxGeometry(bandW * 1.16, bandH * 0.30, pitch * 0.42);
        for(let k = 0; k < n; k++){
          const lug = new THREE.Mesh(lg, lugMat);
          lug.position.set(side * off, yc, -bandL * 0.5 + (k + 0.5) * (bandL / n));
          lug.castShadow = true;
          g.add(lug);
        }
      }

      /* ROAD WHEELS, evenly spaced between the two end wheels. */
      if(T.type === 'wheels' || T.type === 'spoked'){
        const wr = T.wheelR * SCALE;
        const inner = bandL * 0.5 - (T.idlerR + T.sprocketR) * SCALE * 0.5;
        const n = T.wheels;
        for(let k = 0; k < n; k++){
          const f = (n === 1) ? 0.5 : (k / (n - 1));
          const z = -bandL * 0.5 + T.idlerR * SCALE * 0.5
                  + inner * f;
          this._addWheel(g, rimMat, treadMat, side * off, yc, z, wr, T.hubR * SCALE, T.type === 'spoked');
        }
      }

      /* IDLER (front, +Z) and SPROCKET (rear, -Z). */
      const mk = (z, r, isSprocket) => {
        const rr = r * SCALE;
        const w = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, bandW * (isSprocket ? 1.06 : 0.98), 12), rimMat);
        w.rotation.z = Math.PI / 2;   /* lay it flat across the hull */
        w.position.set(side * off, yc, z);
        w.castShadow = true; w.receiveShadow = true;
        g.add(w);
        this._trackWheels.push(w);
        this._addOutline(w, g);
        /* A sprocket gets teeth: eight small blocks around the rim. This is the
           single cheapest thing that makes a tank read as tracked rather than as
           a tank on rollers, and it costs eight boxes. */
        if(isSprocket && T.type === 'sprocket'){
          const tooth = new THREE.BoxGeometry(bandW * 0.5, rr * 0.30, rr * 0.30);
          const tm = Toon.mat({color:T.color});
          for(let i = 0; i < 8; i++){
            const a = (i / 8) * Math.PI * 2;
            const tb = new THREE.Mesh(tooth, tm);
            tb.position.set(side * off, yc + Math.sin(a) * rr * 1.02, z + Math.cos(a) * rr * 1.02);
            tb.rotation.x = -a;
            g.add(tb);
          }
        }
      };
      mk( bandL * 0.5 - T.idlerR    * SCALE * 0.5, T.idlerR,    false);
      mk(-bandL * 0.5 + T.sprocketR * SCALE * 0.5, T.sprocketR, true );

      /* A half-track wears a skirt over the front wheels. One box, and it is
         the whole silhouette of the type. */
      if(T.type === 'halftrack'){
        const skirt = new THREE.Mesh(new THREE.BoxGeometry(bandW * 2.1, bandH * 0.55, bandL * 0.44), rimMat);
        skirt.position.set(0, yc + bandH * 0.62, bandL * 0.22);
        skirt.castShadow = true;
        g.add(skirt);
        this._addOutline(skirt, g);
      }
    }

    parent.add(g);
    this._trackGroup = g;
  }

  /* One road wheel: a rim, a hub, and a record so it can be spun. */
  _addWheel(parent, rimMat, hubMat, x, y, z, r, hubR, thin){
    const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, (thin ? r * 0.42 : r * 0.55), thin ? 10 : 12), rimMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, y, z);
    w.castShadow = true; w.receiveShadow = true;
    parent.add(w);
    this._trackWheels.push(w);
    this._addOutline(w, parent);
    if(hubR > 0.02){
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR, (thin ? r * 0.46 : r * 0.62), 8), hubMat);
      hub.rotation.z = Math.PI / 2;
      hub.position.copy(w.position);
      parent.add(hub);
      this._trackWheels.push(hub);
    }
  }

  /* SPIN THE GEAR FROM HOW FAR THE TANK HAS ACTUALLY MOVED.

     Rotation is distance / radius rather than speed / radius, integrated — so
     the wheels turn the correct amount however the frame rate behaves, and a
     tank that spins on the spot turns them the right way too. Both are
     properties of the same accumulator, which is why there is one line here and
     not two. */
  _updateTracks(dt){
    const W = this._trackWheels;
    if(!W || !W.length || !this.tracks || !this.tracks.spin) return;
    const T = this.tracks;
    const r = Math.max(0.05, (T.wheelR + T.sprocketR + T.idlerR) / 3);
    const d = (Math.abs(this.vx) + Math.abs(this.vz)) * dt;
    if(d <= 0) return;
    this._trackSpin = (this._trackSpin || 0) + (d / r);
    /* Right-hand wheels turn the other way. */
    const sign = this._trackSpinSign || (this._trackSpinSign = 1);
    for(let i = 0; i < W.length; i++){
      W[i].rotation.x = (i % 2 ? -sign : sign) * this._trackSpin;
    }
  }

  /* ================================================================ TRACKS */

  /* THE RUNNING GEAR, AS DATA.

     Until now a tank's treads were either whatever happened to be modelled
     into its GLB or — for a tank with no model at all — two identical boxes
     built from a constant, so every tank in the game had exactly the same
     tread, the same width, the same height and no wheels at all. The body box
     scaled and nothing else did, which is why the fallback tanks all look like
     the same pair of skis.

     `tracks` is a proper block, in the same spirit as `body` and `turret`:
     authored in config.js, overridable per tank from the editor, and merged
     over these defaults so a tank with no `tracks` key at all keeps working
     and keeps looking the way it does now.

     The defaults are DERIVED FROM THE BODY rather than hard-coded, which is the
     whole point — a wider tank gets wider treads without anyone writing a
     number for it. `null` means "work it out", and the resolution happens here
     once at construction rather than at draw time. */
  static TRACK_DEFAULTS = {
    on:       true,
    /* 'solid'   a plain slab, what every tank had before
       'wheels'  slab + road wheels + a sprocket and an idler (the default)
       'sprocket' heavier sprockets, chunkier hubs, no road wheels
       'spoked'  thin slab with small road wheels and an open look
       'halftrack' wide front skirt and a single solid rear block
       'none'    no treads at all — for a wheel-less or floaty hull */
    type:     'wheels',
    /* Tread slab. All three default to null and are derived from the body. */
    width:    null,   /* across the hull  */
    height:   null,   /* vertical thickness of the visible band */
    length:   null,   /* fore-aft, front idler to rear sprocket */
    offset:   null,   /* hull centre to the middle of the tread */
    /* Road wheels. */
    wheels:   5,
    wheelR:   null,
    hubR:     0.34,   /* as a fraction of wheelR */
    /* Sprocket (rear) and idler (front). */
    sprocketR: null,
    idlerR:    null,
    /* Appearance. */
    color:    0x282830,
    rim:      0x3c3c46,
    treadScale: 1,
    spin:     true,
    /* `replace` is the answer to a question the kit otherwise cannot answer.

       Every tank in the roster ships a GLB, and every GLB has its own treads
       modelled into it. So the procedural kit above has nowhere to go on a real
       tank: the loader clears the placeholder body the tracks were built on,
       and the panel would move sliders that change nothing. This opts the tank
       in — the model's running gear is found by node name, hidden, and the
       procedural gear is drawn in its place.

       It defaults to FALSE so no existing tank changes appearance at all. */
    replace:  false,
  };

  /* THE RUNNING GEAR INSIDE A GLB.

     This is the "entities" question, answered. There was no node-name lookup
     for treads anywhere in the game — a model's wheels were geometry nobody
     could reach. These are the names an exported model is expected to use.

     Matched as substrings of the name with every non-alphanumeric character
     removed, so `Road_Wheel`, `road wheel`, `road-wheel` and `RoadWheel` are
     one name rather than four. Substring rather than equality on purpose: a
     model that exports twelve wheels names them `wheel_0`..`wheel_11`, and an
     equality test would find none of them.

     Kept as bare substrings so they cannot match inside a longer word by
     accident in the common cases; `tread`, `track`, `caterpillar`, `belt`,
     `wheel`, `roadwheel`, `roller`, `sprocket`, `idler`, `drivewheel`. */
  static GEAR_NAMES = [
    'track', 'tread', 'caterpillar', 'belt',
    'wheel', 'roadwheel', 'roller', 'sprocket', 'idler', 'drivewheel',
  ];

  static findModelGear(root){
    const out = [];
    if(!root || typeof root.traverse !== 'function') return out;
    const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
    root.traverse(function(o){
      if(!o || !o.name) return;
      const n = norm(o.name);
      if(!n) return;
      for(let i = 0; i < Tank.GEAR_NAMES.length; i++){
        if(n.indexOf(Tank.GEAR_NAMES[i]) >= 0){ out.push(o); return; }
      }
    });
    return out;
  }

  /* DECIDE WHAT THE TANK'S GEAR IS.

     Three sources of running gear can want to exist at once: the placeholder
     cube (no model), the model's own baked-in treads, and the procedural kit.
     This is the one place that arbitrates, so the answer cannot depend on which
     loader branch happened to run.

       no model          procedural, always. There is nothing else to show.
       model, gear found keep the model's, unless `replace`.
       model, no gear    procedural only if `replace` was asked for — a model
                         that ships no treads is assumed to be deliberate.

     Called after the model finishes loading and again whenever the editor
     changes the tracks block. */
  _applyTrackGearPolicy(){
    const T = this.tracks;
    if(!T) return;
    const hasModel = !!this.def.model;

    if(T.replace && hasModel){
      /* Scanned lazily and cached: the traverse is cheap but pointless for the
         sixteen tanks that will never ask for it, and a false positive on a
         node name should never be able to affect a tank that did not opt in. */
      if(!this._gearScanned){
        this._gearScanned = true;
        this._modelGear = Tank.findModelGear(this.root);
      }
      const gear = this._modelGear || [];
      this.gearCount = gear.length;
      for(let i = 0; i < gear.length; i++) gear[i].visible = false;
    }

    const already = !!this._trackGroup;
    const want = T.on && (!hasModel || !!T.replace);
    if(already === want) return;

    if(already && this._trackGroup){
      if(this._trackGroup.parent) this._trackGroup.parent.remove(this._trackGroup);
      this._clearGroup(this._trackGroup);
      this._trackGroup = null;
      this._trackWheels = [];
    }
    if(want && this.bodyGroup) this._buildTracks(this.bodyGroup, Tank.GLOBAL_SCALE);
  }

  /* Merge a tank's `tracks` over the defaults and resolve every null against
     the body box, so the rest of the file only ever reads finished numbers. */
  static resolveTracks(def, override){
    const T = Tank.TRACK_DEFAULTS;
    const body = (def && def.body) || { w:3, h:1, l:4.4 };
    const src  = (override && override.tracks) || (def && def.tracks) || {};
    const num  = (v, d) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : d;
    const hw   = body.w || 3;
    const hl   = body.l || 4.4;
    const hh   = body.h || 1;

    const o = {};
    for(const k in T) o[k] = (src[k] !== undefined) ? src[k] : T[k];

    /* Derived sizes. The tread is deliberately a fraction of the hull's own
       dimensions: `width` scales with the hull so a heavy tank does not get
       pin-thin skis, and `height` is tied to the hull's height because on every
       real tank the visible band of tread is about that. */
    o.width      = num(src.width,     hw * 0.16);
    o.height     = num(src.height,    hh * 0.50);
    o.length     = num(src.length,    hl * 1.06);
    o.offset     = (typeof src.offset === 'number' && isFinite(src.offset))
                    ? Math.max(0, src.offset) : (hw * 0.5 + o.width * 0.5);
    o.wheelR     = num(src.wheelR,     Math.min(o.height * 0.72, o.length * 0.13));
    o.sprocketR  = num(src.sprocketR,  o.wheelR * 1.12);
    o.idlerR     = num(src.idlerR,     o.wheelR * 0.94);
    o.hubR       = num(src.hubR,       o.wheelR * 0.40);
    o.wheels     = Math.max(0, Math.min(24, Math.round(num(src.wheels, 5))));
    o.treadScale = num(src.treadScale, 1);
    o.halfR      = o.length * 0.5;

    if(o.type === 'none') o.on = false;
    if(o.type === 'spoked'){ o.width *= 0.78; o.hubR *= 0.66; }
    if(o.type === 'sprocket'){ o.width *= 1.14; o.height *= 1.12; }
    if(o.type === 'halftrack') o.width *= 1.10;
    return o;
  }

  /* ============================================================ MODEL ORIENT */

  /* Solve the model's orientation from a named FRONT and UP axis. See the note
     above the method for why it is a basis solve rather than an euler. */
  static solveModelQuat(frontKey, upKey){
    const A = Tank.AXES();
    const f = A[frontKey], u = A[upKey];
    if(!f || !u) return null;
    if(f.dot(u) !== 0) return null;           /* parallel: not a basis */

    const GAME_R = A['+X'], GAME_U = A['+Y'], GAME_F = A['+Z'];
    /* Model-space right = up x front, which keeps the basis right-handed in
       the same sense as the game's (there, +X = +Y x +Z). */
    const srcR = new THREE.Vector3().crossVectors(u, f);

    const mGame = new THREE.Matrix4().makeBasis(GAME_R, GAME_U, GAME_F);
    const mSrc  = new THREE.Matrix4().makeBasis(srcR, u, f);
    const m = new THREE.Matrix4().multiplyMatrices(mGame, mSrc.clone().transpose());
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  /* Make sure the two orientation groups exist and are parented.

     Called from BOTH the cube build and the model loader, and it has to be
     idempotent because of what sits between them: _loadModel() opens with
     _clearGroup(this.bodyGroup), which removes every child that is not an
     overlay — and that sweep takes the orientation groups with it. They were
     created once in _buildCubeMesh, so by the time the model was attached the
     groups existed but were no longer under the hull, and the model was
     parented into a detached group: it loaded, it measured, and it rendered
     nothing at all. Rebuilding them here is what puts the model back. */
  _ensureOrientGroups(){
    if(!this._bodyOrient){
      this._bodyOrient = new THREE.Group();
      this._bodyOrient.name = 'bodyOrient';
      this.bodyGroup.add(this._bodyOrient);
    } else if(this._bodyOrient.parent !== this.bodyGroup){
      this.bodyGroup.add(this._bodyOrient);
    }
    if(!this._turretOrient){
      this._turretOrient = new THREE.Group();
      this._turretOrient.name = 'turretOrient';
      this.turretGroup.add(this._turretOrient);
    } else if(this._turretOrient.parent !== this.turretGroup){
      this.turretGroup.add(this._turretOrient);
    }
    this._applyModelQuat();
  }

  /* Push `_modelQuat` out to the two orientation groups.

     Separate from the constructor because the Tank Editor changes the
     orientation LIVE, long after the model has finished loading and the parts
     are already parented — so this has to be re-callable without rebuilding
     anything. Cheap: two quaternion copies. */
  _applyModelQuat(){
    const q = this._modelQuat || Tank._IDENT;
    /* ORDER: the free rotation is applied FIRST (in the game's frame) and the
       axis correction second, so world = euler * correction * authored.

       The other order would spin the correction itself — turn the model about Y
       and then "correct" it back — which produces a model that faces the
       declared way no matter how it is turned. The two have to be independent,
       and this is the only composition where they are. */
    const e = this._modelEuler;
    let out = q;
    if(e && (e.x || e.y || e.z)){
      const eq = this._tmpQuat.setFromEuler(this._tmpEuler.set(e.x, e.y, e.z, 'YXZ'));
      out = eq.multiply(q);
    }
    if(this._bodyOrient) this._bodyOrient.quaternion.copy(out);
    if(this._turretOrient) this._turretOrient.quaternion.copy(out);
  }

  /* World AABB of a subtree. Unlike THREE.Box3.setFromObject() it can skip
     nodes marked invisible: a model's authored "hitbox" helper stays in the
     tree (still findable by name, still carrying its authored transform) but
     must not drag the box the model is centred against. */
  static boxOf(root, skipHidden){
    const box = new THREE.Box3().makeEmpty();
    const v = new THREE.Vector3();
    const walk = (o) => {
      if(skipHidden && o.visible === false) return;
      const g = o.geometry;
      if(g){
        if(!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox;
        if(bb){
          o.updateWorldMatrix(true, false);
          const m = o.matrixWorld;
          for(let i = 0; i < 8; i++){
            v.set((i & 1) ? bb.max.x : bb.min.x,
                  (i & 2) ? bb.max.y : bb.min.y,
                  (i & 4) ? bb.max.z : bb.min.z);
            v.applyMatrix4(m);
            box.expandByPoint(v);
          }
        }
      }
      const kids = o.children;
      for(let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(root);
    return box;
  }

  /* ============================================================================
   DYNAMIC OUTLINES

   The outline is an inverted hull: the mesh is drawn a second time, pushed
   out along its normals, with back-faces only, in black. What changed is
   WHERE the push happens.

   It used to be baked into a CLONE of the geometry, on the CPU, once — which
   is why the outline could never change: its width was frozen into the
   vertices at load time. Widening it meant rebuilding every tank.

   Now the geometry is SHARED and the push happens in the vertex shader, so the
   width is just a live uniform. That is what "dynamic" buys:
     * one geometry instead of two — 0.67MB of duplicate vertices gone
     * the width can change at any time, per object, per frame
     * nothing to rebuild when it does

   All the outline materials compile to the SAME program; only the uniform
   differs, so this costs uniform buffers and no extra shader compiles.
   ============================================================================ */
  static outlineThickness(mat, value){
    if(!mat) return;
    if(mat.userData && mat.userData.uThickness){ mat.userData.uThickness.value = value; return; }
    if(mat.uniforms && mat.uniforms.uThickness){ mat.uniforms.uThickness.value = value; }
  }

  /* ============================================================================
     SHARED OUTLINE MATERIALS

     An earlier version built a brand new ShaderMaterial for every hull. With
     outlines on the whole map that was 41 separate materials, each with its own
     uniform block to upload and its own state change on the way to the GPU --
     for a shader that is identical everywhere.

     Materials are now pooled and shared, keyed by the ROUNDED thickness, so
     every hull drawn at the same width uses one material. Rounding matters: the
     width is adjusted at runtime for camera zoom, and keying on the exact float
     would miss the cache every frame and allocate a new material every frame.

     BackSide + a vertex push along the normal is the whole technique: only the
     back faces of the inflated hull are drawn, so what survives is the rim that
     pokes out past the real surface. One material, one program, N meshes.
     ============================================================================ */
  static _outlineMaterial(thickness){
    /* ONE material for the entire game.

       Keying the pool on the authored thickness was always wrong: the width is
       not a property of the outline, it is a property of the CAMERA this frame.
       _applyOutlineScale rewrites uThickness every frame from camDist alone, so
       a material built for one tank's authored width is immediately overwritten
       with a width chosen for another. */
    const pool = Tank._outlinePool || (Tank._outlinePool = new Map());
    const hit = pool.get('shared');
    if(hit) return hit;

    /* Seeded with the real world width. The value here only matters for the
       frames before the first _applyOutlineScale call. */
    const t = thickness != null ? thickness : OUTLINE_TANK;

    /* ==================================================================
       WHY THE PUSH HAPPENS IN VIEW SPACE, NOT LOCAL SPACE
       ==================================================================
       The old shader did:

           vec3 pushed = position + normal * uThickness;
           gl_Position = projectionMatrix * modelViewMatrix * vec4(pushed, 1.0);

       `position` and `normal` are in the MESH'S OWN space, so uThickness was
       measured in whatever units that model was authored in. The tank models
       are authored at wildly different scales and then scaled up by the loader
       -- coolbuddy is scaled 25.5x, striker 0.7x -- so one shared local-space
       number produced a 2.17-unit shell on one tank and 0.06 units on the next.
       A shell that fat swallows the model; one that thin vanishes.

       That is what the whole `compensateOutlineScale` + `isOutlineBaked` +
       world-space-baking apparatus existed to paper over: cancel the parent's
       scale on the child so a local number would happen to come out right. It
       only ever ran from Tank._addOutline, so the EIGHT other places that call
       createOutlineMesh directly -- menu.js x4, garage.js x2, tank-menu.js x2,
       and every map outline in game.js -- got no compensation at all and were
       simply broken. That is the "tank outlines are broken" report: correct in
       battle, wrong in the garage, the tank-select screen and the main-menu
       preview, and wrong by a different amount on every model.

       The fix is to stop measuring the width in model space at all. Transform
       the position to VIEW space first, offset it along the view-space normal,
       and the width is now in world units for every model regardless of how it
       was authored or scaled:

           vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
           mvPos.xyz += normalize(normalMatrix * normal) * uThickness;

       normalMatrix is the inverse-transpose of modelView's upper 3x3, which is
       exactly the transform that keeps a normal perpendicular under non-uniform
       scale. One line, no per-mesh compensation, no baking, and the eight call
       sites that were broken are fixed by construction rather than by
       remembering to call something.

       ONE THING THIS DOES NOT DO ON ITS OWN, and which is easy to miss:
       moving the push to view space fixes the WIDTH but says nothing about
       WHERE the hull is drawn. The hull still has to sit on the surface it
       outlines, and compensateOutlineScale was quietly moving it off that
       surface -- see there for the measurements. A view-space push on a hull
       that is not coincident with its mesh is a correct-width outline in the
       wrong place, which is no outline at all.

       This is deliberately a WORLD-space width rather than a pixel-constant
       one, because the game's existing _applyOutlineScale already scales the
       width with camera distance (thicker when zoomed out). A world-space shell
       composes with that; a pixel-space one would fight it.
       ================================================================== */
    const GLSL_VERT = [
      'uniform float uThickness;',
      'void main(){',
      '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
      '  vec3 nView = normalize(normalMatrix * normal);',
      '  mvPos.xyz += nView * uThickness;',
      '  gl_Position = projectionMatrix * mvPos;',
      '}'
    ].join('\n');

    const FRAG = [
      'precision mediump float;',
      'void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }'
    ].join('\n');

    let mat = null;

    /* ---- WebGPU / TSL twin ----
       Same maths, expressed as nodes. The one structural difference: a
       NodeMaterial's `positionNode` is assigned into positionLocal, i.e. it
       wants a LOCAL position, so the view-space result has to go out through
       `vertexNode`, which is the clip-space output. Writing a view-space value
       into positionNode is the classic TSL outline bug -- it compiles, and the
       outline ends up somewhere else entirely. */
    if((typeof window !== 'undefined') && window.WebGPU && window.TSL){
      try {
        const T = window.TSL, W = window.WebGPU;
        const uT = T.uniform(t);
        const mvPos    = T.modelViewMatrix.mul(T.vec4(T.positionGeometry, 1.0));
        const nView    = T.normalize(T.modelNormalMatrix.mul(T.normalGeometry));
        const offset   = T.vec4(nView.mul(uT), 0.0);
        const clipPos  = T.cameraProjectionMatrix.mul(mvPos.add(offset));

        const nm = new W.MeshBasicNodeMaterial({ side: THREE.BackSide, toneMapped: false });
        nm.vertexNode = clipPos;
        nm.colorNode  = T.vec4(0, 0, 0, 1);
        mat = nm;
        mat.userData.uThickness = uT;
        mat.userData.isTSL = true;
      } catch(e){
        /* Any TSL surprise must not cost the player their outlines: fall
           through to the GLSL material, which every backend can run. */
        console.warn('[outline] TSL material failed, using GLSL fallback:', e);
        mat = null;
      }
    }

    /* ---- WebGL fallback ---- */
    if(!mat){
      mat = new THREE.ShaderMaterial({
        uniforms: { uThickness: { value: t } },
        vertexShader: GLSL_VERT,
        fragmentShader: FRAG,
        side: THREE.BackSide,
        toneMapped: false,
      });
      mat.userData.uThickness = mat.uniforms.uThickness;
    }

    /* Tells Tank.dispose()'s killTree() to leave this alone.

       That helper disposes every material it finds on a dying tank, skipping
       anything flagged sharedWithCache. An outline is a CHILD of its mesh, so
       it is on that tree. With a per-tank outline material that was merely
       untidy; with ONE material shared by every tank in the match it is fatal
       -- the first tank to explode would dispose the outline material out from
       under the other nine, and every surviving tank would lose its outline for
       the rest of the round. */
    mat.userData.sharedWithCache = true;
    pool.set('shared', mat);
    return mat;
  }

  static createOutlineMesh(mesh, thickness){
    const t = thickness != null ? thickness : 0.04;
    if(!mesh.geometry) return null;
    /* The source mesh may have no normals; the hull needs them. Computed onto
       the SHARED geometry rather than a clone, so both draw the same thing. */
    if(!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();

    /* Pooled, not allocated: see Tank._outlineMaterial. */
    const mat = Tank._outlineMaterial(t);

    /* SHARED geometry — this is the whole point. */
    const outline = new THREE.Mesh(mesh.geometry, mat);
    outline.position.copy(mesh.position);
    outline.rotation.copy(mesh.rotation);
    outline.scale.copy(mesh.scale);
    outline.renderOrder = -1;
    outline.castShadow = false;
    outline.receiveShadow = false;
    outline.frustumCulled = mesh.frustumCulled !== false;
    outline.userData.isOutline = true;
    /* Record whether this outline's width is baked into its geometry.

       _batchPartGroup merges outline meshes together and bakes their
       transforms into the vertex data (isOutlineBaked). A BAKED outline ends up
       in the part group's own space, where the scale is 1. An UNBAKED one is
       still parented to its mesh and inherits whatever scale that mesh carries.

       Those two are NOT interchangeable, and treating them the same is what
       made only SOME tanks wrong: the ones with enough meshes to be batched
       looked right, and every tank that stayed unbatched was broken. */
    outline.userData.isOutlineBaked = false;
    return outline;
  }

  /* ---------------------------------------------------------------------------
     OUTLINE SCALE COMPENSATION -- GENUINELY A NO-OP NOW, AND IT HAS TO BE

     This used to be load-bearing. The outline shader pushed vertices along the
     normal in LOCAL space, so the width was measured in whatever units the model
     was authored in, and this cancelled the parent's scale on the child to make
     one shared number land correctly.

     The shader now expands in VIEW space (see Tank._outlineMaterial), so the
     push is a fixed number of WORLD units on every model whatever its authored
     scale. The compensation went with it -- and this function kept running
     anyway, which is the bug.

     WHY IT WAS STILL BREAKING THE OUTLINES

     The docstring above this one claimed "carrying a redundant transform cannot
     change how the hull looks". That is false, and measurably so. The hull is a
     CHILD of the mesh it outlines, so writing 1/worldScale onto it made the
     hull's own world scale land on 1 -- while the tank it is supposed to hug
     renders at that modelScale. The two no longer coincide, so the hull is not
     a shell around the tank at all: it is a separate lump of geometry somewhere
     inside it.

     Measured in a live 14-tank battle, hull size as a fraction of the surface it
     outlines (1.0 = correct, the shell is drawn by the shader and does not
     change the geometry):

         coolbuddy   srcWorldScale 25.5   ->  0.039   a 0.4%-sized speck
         shotgun     srcWorldScale 23.0   ->  0.043   same
         helix       srcWorldScale 9.70   ->  0.245   a quarter size
         helix       srcWorldScale 3.81   ->  0.262   a quarter size
         striker     srcWorldScale 0.70   ->  0.71-1.0 accidentally near 1

     0.039 is 1/25.6: the ratio IS the reciprocal of the world scale, which is
     the signature of exactly this line. Cool Buddy -- the most common tank in
     the game -- had an outline 96% smaller than the tank, buried inside it and
     invisible. And the ratio is only accidentally right when a model's world
     scale is near 1, which is why exactly one model looked fine and the rest
     did not.

     It also breaks the BATCHED path, more quietly. _batchPartGroup lifts an
     outline out of its source mesh with its matrix folded into the vertices, so
     the 1/S shrink is baked into the vertex data and can never be undone
     afterwards. With the compensation gone, that fold becomes an identity and
     the merged hull lands exactly where its source mesh was -- which is what
     makes the whole thing correct for batched and unbatched models at once,
     rather than correct for one and wrong for the other.

     So: identity scale, and the isOutlineBaked flag left to the batching code
     that branches on it.
     --------------------------------------------------------------------------- */
  static compensateOutlineScale(outline, mesh){
    /* Identity. The hull shares its source mesh's geometry and is parented to
       it, so scale 1 is what makes the two surfaces coincide exactly. */
    outline.scale.set(1, 1, 1);
    outline.userData.scaleCompensated = true;
    return outline;
  }

  _wantsOutline(){
    if(this._edOv && this._edOv.model && this._edOv.model.outline === false) return false;
    if(this.def && this.def.outline === false) return false;
    return true;
  }

  _addOutline(mesh, group, thickness){
    // Parent the outline INTO the mesh itself (identity local transform) so it
    // inherits the mesh's own rotation — turret-pivot meshes rotate with the
    // turretAngle, and the outline must follow instead of staying fixed as a
    // group sibling.
    if(!this._wantsOutline()) return;
    const outline = Tank.createOutlineMesh(mesh, thickness);
    /* Remembered on the tank so the per-frame width update walks a flat array
       instead of traversing the whole model every frame. */
    if(outline) (this._outlineList || (this._outlineList = [])).push(outline);
    outline.position.set(0, 0, 0);
    outline.rotation.set(0, 0, 0);
    /* Identity here would make the outline inherit the mesh's whole authored
       scale, which is what blew the hull up on models that were not batched.
       See Tank.compensateOutlineScale. */
    Tank.compensateOutlineScale(outline, mesh);
    mesh.add(outline);
  }

  /* Authored models that ship animation clips keep their node tree intact:
     the clips address parts by node NAME, and batching deletes those nodes. */
  _canBatchModel(grp){
    const clips = (grp && grp.userData && grp.userData.anims) || null;
    if(!clips || !clips.length) return true;
    // Clips that never play can't be broken by removing their targets.
    if(this._edOv && this._edOv.model && this._edOv.model.anim === false) return true;
    if(this.def && this.def.playAnims === false) return true;
    return false;
  }

  /* Every node on the way up from a marker (muzzle / shell port / turret
     root) plus the markers themselves: batching must never detach those, the
     game reads world positions off them every shot. */
  static _protectedSet(nodes){
    const prot = new Set();
    (nodes || []).forEach(n => {
      let p = n;
      while(p){ prot.add(p); p = p.parent; }
    });
    return prot;
  }

  static _batchSig(m){
    const mat = m.material, geo = m.geometry;
    return [
      mat.type,
      mat.color ? mat.color.getHexString() : '-',
      mat.transparent ? 1 : 0, mat.opacity,
      mat.side, mat.alphaTest,
      mat.depthTest ? 1 : 0, mat.depthWrite ? 1 : 0,
      mat.blending, mat.polygonOffset ? 1 : 0,
      mat.map ? mat.map.uuid : '-',
      mat.normalMap ? mat.normalMap.uuid : '-',
      mat.alphaMap ? mat.alphaMap.uuid : '-',
      mat.emissiveMap ? mat.emissiveMap.uuid : '-',
      mat.emissive ? mat.emissive.getHexString() : '-',
      mat.flatShading ? 1 : 0, mat.wireframe ? 1 : 0,
      geo.attributes.normal ? 1 : 0, geo.attributes.uv ? 1 : 0,
      m.castShadow ? 1 : 0, m.receiveShadow ? 1 : 0,
      m.renderOrder,
      (m.userData && m.userData.isOutline) ? 1 : 0
    ].join('|');
  }

  static _batchGeoOk(g){
    if(!g || !g.attributes || !g.attributes.position) return false;
    if(g.attributes.position.itemSize !== 3) return false;
    if(g.morphAttributes && Object.keys(g.morphAttributes).length) return false;
    if(g.groups && g.groups.length > 1) return false;
    const allowed = {position:1, normal:1, uv:1};
    const keys = Object.keys(g.attributes);
    for(let i = 0; i < keys.length; i++) if(!allowed[keys[i]]) return false;
    if(g.attributes.normal && g.attributes.normal.itemSize !== 3) return false;
    if(g.attributes.uv && g.attributes.uv.itemSize !== 2) return false;
    return true;
  }

  /* ---------------------------------------------------------------
     Static batching.

     An authored GLB can ship 50-110 separate meshes (plus one outline
     mesh per part), and each one costs a draw call. This bakes every
     mesh's own transform into its vertices and concatenates the
     triangles per material, so the *same* triangles reach the GPU in
     one call instead of fifty: same geometry, same material, same
     world position — only fewer draw calls.

     Rules that keep it safe:
       * a mesh is only merged with siblings under the SAME parent, and
         the merged mesh is added to that parent, so every animated
         group (turret pivot, gun recoil) keeps working;
       * a mesh that still owns a named marker, or that would take one
         with it, is left alone;
       * outlines hang inside their source mesh — when that source is
         merged away the outline is lifted to the source's parent with
         its matrix baked in, so it survives and merges too. Because
         its transform is now baked, it opts out of the zoom-driven
         outline scaling (which would otherwise scale the whole model
         about its origin instead of about each part).
     Returns the number of draw calls removed from this group.
     --------------------------------------------------------------- */
  _batchPartGroup(root, protectedSet){
    if(!root) return 0;
    const prot = protectedSet || new Set();
    root.updateWorldMatrix(true, true);

    const inSet = new Set();
    const outlines = [];
    const collected = [];
    root.traverse(o => {
      if(!o.isMesh || o.visible === false) return;
      if(o.isSkinnedMesh || o.isInstancedMesh) return;
      if(!o.material || Array.isArray(o.material)) return;
      if(!Tank._batchGeoOk(o.geometry)) return;
      if(prot.has(o)) return;
      let a = o.parent;                       // invisible helper subtrees never render
      while(a && a !== root){ if(a.visible === false) return; a = a.parent; }
      inSet.add(o);
      collected.push(o);
      if(o.userData && o.userData.isOutline) outlines.push(o);
    });
    const outlineSet = new Set(outlines);
    if(collected.length < 4) return 0;

    // A source may only disappear when everything it drags along is an
    // outline hanging directly off it (those get lifted below). Anything
    // else nested inside it — another part, a marker — would vanish too.
    const sources = collected.filter(m => {
      if(outlineSet.has(m)) return false;
      let ok = true;
      m.traverse(c => {
        if(!ok || c === m || !c.isMesh) return;
        if(!outlineSet.has(c) || c.parent !== m) ok = false;
      });
      return ok;
    });
    if(sources.length < 2) return 0;

    const srcBuckets = new Map();
    for(const m of sources){
      const key = (m.parent ? m.parent.uuid : '-') + '|' + Tank._batchSig(m);
      let b = srcBuckets.get(key);
      if(!b){ b = {target:m.parent, list:[]}; srcBuckets.set(key, b); }
      b.list.push(m);
    }
    let active = [];
    srcBuckets.forEach(b => { if(b.list.length >= 2) active.push(b); });
    if(!active.length) return 0;

    // Never merge into a target that is itself on the way out.
    for(let pass = 0; pass < 4; pass++){
      const doomed = new Set();
      for(const b of active) for(const m of b.list) doomed.add(m);
      const next = active.filter(b => {
        let p = b.target;
        while(p && p !== root){ if(doomed.has(p)) return false; p = p.parent; }
        return true;
      });
      if(next.length === active.length) break;
      active = next;
    }
    const goneSrc = new Set();
    for(const b of active) for(const m of b.list) goneSrc.add(m);

    // Outlines whose source is about to be merged away move up to the
    // source's parent instead (matrix baked in), where they become siblings
    // and can be merged as one silhouette mesh.
    const liftBuckets = new Map();
    for(const m of outlines){
      const p = m.parent;
      if(!p || !goneSrc.has(p)) continue;
      const target = p.parent;
      if(!target) continue;
      const key = target.uuid + '|' + Tank._batchSig(m);
      let b = liftBuckets.get(key);
      if(!b){ b = {target, list:[]}; liftBuckets.set(key, b); }
      b.list.push(m);
    }

    let removed = 0;
    const bakeInto = (buckets, transformBaked) => {
      buckets.forEach(b => {
        if(!b.target || !b.list.length) return;
        b.target.updateWorldMatrix(true, false);
        const inv = new THREE.Matrix4().copy(b.target.matrixWorld).invert();
        const tmp = new THREE.Matrix4();
        const parts = [];
        let count = 0;
        for(const m of b.list){
          tmp.multiplyMatrices(inv, m.matrixWorld);
          let g = m.geometry.clone();
          g.applyMatrix4(tmp);
          if(g.index){ const flat = g.toNonIndexed(); g.dispose(); g = flat; }
          parts.push(g);
          count += g.attributes.position.count;
        }
        if(!count){ parts.forEach(g => g.dispose()); return; }
        const withN = !!parts[0].attributes.normal;
        const withUv = !!parts[0].attributes.uv;
        const pos = new Float32Array(count * 3);
        const nrm = withN ? new Float32Array(count * 3) : null;
        const uvs = withUv ? new Float32Array(count * 2) : null;
        let at = 0;
        for(const g of parts){
          const n = g.attributes.position.count;
          pos.set(g.attributes.position.array, at * 3);
          if(nrm) nrm.set(g.attributes.normal.array, at * 3);
          if(uvs) uvs.set(g.attributes.uv.array, at * 2);
          at += n;
        }
        parts.forEach(g => g.dispose());
        const merged = new THREE.BufferGeometry();
        merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        if(nrm) merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        if(uvs) merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        merged.computeBoundingBox();
        merged.computeBoundingSphere();
        const first = b.list[0];
        const mesh = new THREE.Mesh(merged, first.material);
        mesh.name = first.name || '';
        mesh.castShadow = first.castShadow;
        mesh.receiveShadow = first.receiveShadow;
        mesh.renderOrder = first.renderOrder;
        mesh.visible = true;
        if(first.userData && first.userData.isOutline){
          mesh.userData.isOutline = true;
          /* transformBaked is true only for the LIFTED outlines -- the ones
             whose source mesh was merged away, so this vertex data already has
             their transform (and the scale compensation that went with it)
             folded in. That lands them in the part group's own space, where the
             scale is 1 and the shared uniform is already correct, so
             _applyOutlineScale must leave them completely alone.

             The non-lifted path never sees an outline at all: `sources` filters
             them out, so every outline arrives through liftBuckets. */
          if(transformBaked) mesh.userData.isOutlineBaked = true;
        }
        b.target.add(mesh);
        for(const m of b.list){ if(m.parent) m.parent.remove(m); }
        removed += b.list.length - 1;
      });
    };
    bakeInto(active, false);
    bakeInto(liftBuckets, true);
    return removed;
  }

  /* ============================================================================
     LOAD THE MODEL AND RIG IT.

     The scale bake that used to live here moved into Models._clone — see the
     note at the top of this method.
     ============================================================================ */
  _loadModel(){
    if(!this.def.model){ this._modelReady = Promise.resolve(); return; } // cube model unless explicitly requested
    this._modelReady = Models.load(this.def.model).then(grp=>{
      if(!grp) return;
      this._clearGroup(this.bodyGroup);
      this._clearGroup(this.turretGroup);
      /* Immediately after the sweep, because that sweep removes them. */
      this._ensureOrientGroups();
      const scale = (this.def.modelScale || 1.0) * 2.0;
      grp.scale.setScalar(scale);
      /* NOT HERE. The non-uniform-scale bake used to run at this point, per tank.

         It cannot. This `grp` is a clone that SHARES its geometry buffers with
         the model's cached master scene, so baking here mutated the master, and
         every tank built afterwards — and every re-selection of the same tank,
         which is exactly what the pre-battle tank-select panel does — inherited
         the damage and baked it again. The Mortar lost a third of its height
         across three selections (turret 3.08 -> 2.15 -> 2.12) and a completely
         fresh load came back with geometry already flattened to 0.439.

         Models._clone() now bakes the original once, before any clone is handed
         out, so the fix is exactly-once by construction and every tank gets a
         faithful copy. See bakeNodeScales in models.js. */

      // --- Named-group rig: the model carries "hull" / "turret" /
      //     "gun" / "shell" groups so parts are found by name ---
      const norm = (s) => String(s).toLowerCase().replace(/[\s_]/g, '');
      const findNamed = (root, name) => {
        const t = norm(name);
        let out = null;
        root.traverse(o => { if(!out && o.name && norm(o.name) === t) out = o; });
        return out;
      };
      // --- Model-authored collision box: a node named "hitbox" (TL_ark ships
      //     one) describes the tank's collision volume. It stays in the tree —
      //     same name, same authored transform — but is flagged invisible so
      //     it never renders, never gets tinted or an outline, and (via
      //     Tank.boxOf) never drags the box the model is centred against.
      const hitG = findNamed(grp, 'hitbox');
      if(hitG){
        hitG.visible = false;
        if(hitG.isMesh){ hitG.castShadow = false; hitG.receiveShadow = false; }
      }
      const hullG = findNamed(grp, 'hull');
      const turretG = findNamed(grp, 'turret');
      const shellG = findNamed(grp, 'shell') || findNamed(grp, 'shell_ejection') || findNamed(grp, 'gun');
      if(hullG && turretG && hullG !== turretG){
        this._attachNamedModel(grp, hullG, turretG, shellG, scale);
        return;
      }

      /* --- Declared rig: a def may NAME its own hull / turret / gun parts.
         This has to be consulted before any of the guessing below, because the
         guessing is only ever a guess.

         The fallback for a model with no "hull"/"turret" nodes of its own is to
         split its meshes by ALTITUDE — everything above 40% of the model's height
         is turret, the rest is hull. That is a reasonable default for a tank whose
         turret is a lump on top, and it is simply wrong for one that is not.

         TL_mortar_fix is the second case: its turret ring ("Cylinder") is a
         low, wide piece with the gun assembly ("Cube003") parented inside it, and
         its hull is TWO separate roots ("Cylinder010" and "Cube007") that overlap
         in height with the turret. Splitting by height tore the model apart: hull
         pieces ended up in the turret group, the turret ring did not follow its own
         gun, and the gun swung independently of the turret it is bolted to.

         The rig is declared in the def, so the model file itself does not have to
         be re-exported, and every part is assigned by the node the author gave it
         rather than by where it happens to sit.

         GUN IS OPTIONAL AND INHERITED BY DEFAULT: if the def names no gun, the gun
         is taken as the turret's own child that carries the `firing` muzzle, which
         is the shape TL_ark and this Mortar already have. */
      const rig = this.def.rig;
      if(rig && rig.turret && (rig.hull || rig.hullRest)){
        const rigFind = (name) => {
          const t = norm(name);
          let hit = null;
          grp.traverse(o => { if(!hit && o.name && norm(o.name) === t) hit = o; });
          return hit;
        };
        /* The turret may be named as a LIST as well as a single node.

           A flat model has no turret node at all — Predator exports 49 sibling
           roots and its whole upper deck (turret body, mantlet, barrel, sight)
           is seven separate roots at the same level. There is no single node to
           point at, so the deck can only be assembled by naming its parts and
           wrapping them, exactly as the multi-node hull is wrapped below.

           Wrapping preserves each part's world transform, so the assembled
           turret is in precisely the position the author exported and rotates as
           one piece about its own centre. */
        const turretNames = Array.isArray(rig.turret) ? rig.turret : [rig.turret];
        const turretParts = turretNames.map(rigFind).filter(Boolean);
        let turretNode = turretParts[0] || null;
        if(turretParts.length > 1){
          const tw = new THREE.Group();
          tw.name = 'turretAssembly';
          grp.updateMatrixWorld(true);
          turretParts.forEach(p => tw.attach(p));
          turretNode = tw;
        }
        let hullNodes = (Array.isArray(rig.hull) ? rig.hull : (rig.hull ? [rig.hull] : []))
          .map(rigFind).filter(Boolean);

        /* hullRest: "everything that is not the turret or the gun".
           Naming every hull part is only realistic for a model with two or three
           roots. The Grom exports EIGHTEEN: a body, twelve road wheels in two
           rows, four skirt plates and a stowage box. Listing them is possible and
           is the wrong answer twice over — it is a wall of node names that goes
           stale the moment the model is re-exported, and it misses anything new.

           So a def can instead say "the hull is all the rest", and this walks
           the scene roots taking everything that is not the turret, not inside
           it, and not the gun. That is the same thing the author meant, survives
           a re-export, and cannot silently drop a part the way a hand-written
           list does.

           Roots with no name and no mesh are dropped rather than swept in: they
           are GLTFLoader bookkeeping, not visible geometry. */
        if(rig.hullRest){
          const insideTurret = (o) => {
            let p = o;
            while(p){ if(p === turretNode) return true; p = p.parent; }
            return false;
          };
          const gunRef = rig.gun ? rigFind(rig.gun) : null;
          grp.updateMatrixWorld(true);
          grp.children.forEach(c => {
            if(c === turretNode || insideTurret(c)) return;
            if(gunRef && (c === gunRef || (function(){
              let p = c; while(p){ if(p === gunRef) return true; p = p.parent; } return false;
            })())) return;
            const visible = c.isMesh || c.children.some(k => k.isMesh);
            if(!c.name && !visible) return;
            hullNodes.push(c);
          });
        }

        if(turretNode && hullNodes.length){
          /* One node, because _attachNamedModel rigs a single hull. Wrapping the
             author's separate roots in a group preserves each one's world transform
             (attach() reparents without moving anything), so the model comes out
             looking exactly as authored -- only its parenting changes. */
          let hullNode = hullNodes[0];
          if(hullNodes.length > 1){
            const wrapper = new THREE.Group();
            wrapper.name = 'hullAssembly';
            grp.updateMatrixWorld(true);
            hullNodes.forEach(h => wrapper.attach(h));
            hullNode = wrapper;
          }
          /* The gun, if the def names one, else the muzzle's own parent. Both are
             captured while `grp` is intact: the rig below reparents these nodes out
             of it, and a lookup afterwards would find nothing. */
          const gunNode = (rig.gun ? rigFind(rig.gun)
            : (findNamed(turretNode, 'firing') || findNamed(turretNode, 'muzzle') || {}).parent) || null;
          const firingPre = findNamed(turretNode, 'firing') || findNamed(turretNode, 'muzzle');
          this._attachNamedModel(grp, hullNode, turretNode, shellG, scale, firingPre, gunNode);
          return;
        }
      }

      // --- Two-root rig: some models ship as exactly two scene roots where
      //     one root carries the "firing" marker — hull root + turret/gun
      //     root (TL_ark exports "Cube" and "Cube.019" this way). Rig them as
      //     a hull/turret pair instead of shredding the mesh list: the
      //     authored hierarchy then survives, so the turret keeps its real
      //     pivot and the gun node can recoil.
      {
        const roots = grp.children.slice();
        if(!hullG && !turretG && roots.length === 2){
          const withFiring = roots.filter(r => findNamed(r, 'firing') || findNamed(r, 'muzzle'));
          if(withFiring.length === 1){
            const turretRoot = withFiring[0];
            const hullRoot = (roots[0] === turretRoot) ? roots[1] : roots[0];
            // Capture the muzzle while grp is still intact: _attachNamedModel
            // re-parents both roots out of grp, so a lookup after the fact
            // would find nothing.
            const firingPre = findNamed(turretRoot, 'firing') || findNamed(turretRoot, 'muzzle');
            this._attachNamedModel(grp, hullRoot, turretRoot, shellG, scale, firingPre);
            return;
          }
        }
      }

      // --- Named-empty rig: models like ghost.glb carry "firing" (muzzle),
      //     "shell_ejection" (casing port) and "attachment" (cosmetic, unused)
      //     empties instead of hull/turret groups. The model is used as
      //     authored (front = +Z); the Tank Editor can fix the facing via a
      //     saved modelYaw override. Wire muzzle + shell markers below.
      const firingG = findNamed(grp, 'firing');
      const ejectG = findNamed(grp, 'shell_ejection') || findNamed(grp, 'shell');

      /* ============================================================================
         MEASURE THE GUN ARM BEFORE ANYTHING IS REPARENTED.

         Done HERE, on the line that finds the `firing` empty, because this is the
         last point at which the model still has the hierarchy its author gave it.

         Further down, the loader splits every mesh into bodyParts or turretParts by
         height and then optionally batches them. Both DESTROY the structure this
         question is about: after the split, the gun arm (`firing`'s parent) is a
         bare transform with no mesh children at all, and traversing it for its own
         extent returns nothing. That is not a cosmetic detail — the artillery
         barrel reconstruction downstream decides whether the model needs a tube
         built for it by asking exactly this, and an unmeasurable arm answers "no
         tube", so a model that ships its own barrel gets a second one glued over
         the top of it. Measured on TL_mortar_fix: arm front 5.51, muzzle 5.477,
         so the barrel is the author's own and nothing should be added.

         The value is stored on the tank for that later decision to read. */
      this._armFrontLocalX = (() => {
        const arm = (firingG && firingG.parent && firingG.parent !== grp) ? firingG.parent : null;
        if(!arm) return null;
        grp.updateMatrixWorld(true);
        const armInv = new THREE.Matrix4().copy(arm.matrixWorld).invert();
        const corner = new THREE.Vector3();
        let front = -Infinity;
        arm.traverse(o => {
          if(!o.isMesh || !o.geometry) return;
          if(!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          const b = o.geometry.boundingBox;
          for(let i = 0; i < 8; i++){
            corner.set(i & 1 ? b.max.x : b.min.x,
                       i & 2 ? b.max.y : b.min.y,
                       i & 4 ? b.max.z : b.min.z);
            /* world -> arm-local, so this reads along the arm's OWN barrel axis
               however the model happens to be posed */
            corner.applyMatrix4(o.matrixWorld).applyMatrix4(armInv);
            if(corner.x > front) front = corner.x;
          }
        });
        return (front === -Infinity) ? null : front;
      })();
      // The model is authored with its front/barrel facing +Z. Do not rotate
      // the whole model here: authors can fix the facing from the Tank
      // Editor's "Model front" mode (saved as a modelYaw override).
      // Center the model on its x/z bounds so the tank pivot sits at the
      // geometric center (the game steers about its origin), and rest the
      // lowest point on the ground plane.
      {
        const gb = Tank.boxOf(grp, true);
        const gc = gb.getCenter(new THREE.Vector3());
        grp.position.x -= gc.x;
        grp.position.z -= gc.z;
        grp.position.y -= gb.min.y;
        grp.updateMatrixWorld(true);
      }

      let minY = Infinity, maxY = -Infinity;
      const meshes = [];
      grp.traverse(o => { if(o.isMesh && o.visible !== false){ meshes.push(o); const b=Tank.boxOf(o, true); minY=Math.min(minY,b.min.y); maxY=Math.max(maxY,b.max.y); } });
      const midY = minY + (maxY - minY) * 0.4;

      const bodyParts = new THREE.Group();
      const turretParts = new THREE.Group();
      const tmp = new THREE.Vector3();
      const yOff = this.def.body.h + 0.45;

      /* ============================================================================
         KEEP PAINT, OR TINT?

         A def sets `keepModelPaint: true` when its model is already painted and
         must be rendered as authored. Without it, EVERY material on the named-
         empty rig is recoloured to the tank's `this.color` — textures
         included.

         That is right for a model that is essentially a blank shell to be
         painted (helix.glb: one grey base and a texture, and a def palette of
         rust oranges). It is wrong for a model that arrives finished, because
         the paint job you get is the PLAYER'S colour: `this.color` is
         `opts.color ?? def.color`, and `opts.color` is the colour the match
         server handed this player. A pre-painted green tank therefore came out
         whatever colour the player's nameplate happened to be — the Mortar
         looked blue because the local player was issued a blue.

         So this is not a bug in the colour, it is a tint applied to something
         that should never have been tinted. `keepModelPaint` keeps the
         material's own base colour, its map and its normal map, and only
         converts the shader class so it still toon-shades with everything else.
         ============================================================================ */
      const keepPaint = this.def.keepModelPaint === true;
      const applyMatColor = (m, col) => {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const converted = mats.map(mat => {
          if(mat.isMeshToonMaterial) return mat;
          const opts = {
            /* As painted, or as the tank's colour. */
            color: keepPaint ? (mat.color ? mat.color.clone() : new THREE.Color(0xffffff))
                             : new THREE.Color(col),
          };
          if(mat.map){
            opts.map = mat.map;
            opts.alphaTest = mat.alphaTest || 0.5;
            // `mat.transparent || true` is ALWAYS true, so every textured tank
            // part was forced into the transparent queue (sorted, no reliable
            // depth) and could drop out of view, leaving only the outline —
            // which is a separate opaque mesh. Honour the source value instead.
            opts.transparent = !!mat.transparent;
            opts.opacity = mat.opacity !== undefined ? mat.opacity : 1;
            opts.side = THREE.DoubleSide;
            /* WebP maps arrive with no colour space set, and an sRGB image read
               as linear comes out washed and cold — which reads as "the model
               is the wrong colour" rather than "the texture is mistagged". GLTF
               Loader does not set it for EXT_texture_webp. */
            if(opts.map.colorSpace == null || opts.map.colorSpace === THREE.NoColorSpace){
              if(opts.map.isTexture) opts.map.colorSpace = THREE.SRGBColorSpace;
            }
          }
          if(mat.normalMap) opts.normalMap = mat.normalMap;
          if(mat.emissive && keepPaint && mat.emissiveIntensity != null){
            opts.emissive = mat.emissive.clone();
            opts.emissiveIntensity = mat.emissiveIntensity;
          }
          return Toon.mat(opts);
        });
        m.material = Array.isArray(m.material) ? converted : converted[0];
      };

      meshes.forEach(m => {
        m.getWorldPosition(tmp);
        m.castShadow = true;
        m.receiveShadow = true;
        if(tmp.y > midY){
          applyMatColor(m, this.def.turretColor);
          turretParts.attach(m);
          m.position.y -= yOff;
        } else {
          applyMatColor(m, this.color);
          bodyParts.attach(m);
        }
      });

      const outlineT = 0.04 / scale;
      // Collect meshes first, then add outlines afterwards: a traverse that
      // adds a child INTO a visited mesh would descend into the fresh outline
      // and recurse forever, so never add outlines during a live traversal.
      let srcMeshes = [];
      bodyParts.traverse(o => { if(o.isMesh) srcMeshes.push(o); });
      srcMeshes.forEach(m => this._addOutline(m, m.parent, outlineT));
      srcMeshes = [];
      turretParts.traverse(o => { if(o.isMesh) srcMeshes.push(o); });
      srcMeshes.forEach(m => this._addOutline(m, m.parent, outlineT));

      // Same triangles, same materials, same pixels — just far fewer draw calls.
      if(this._canBatchModel(grp)){
        const prot = Tank._protectedSet([firingG, ejectG]);
        this._batchPartGroup(bodyParts, prot);
        this._batchPartGroup(turretParts, prot);
      }

      this._bodyOrient.add(bodyParts);
      this._turretOrient.add(turretParts);
      const t = this.def.turret;
      this.barrelEnd = new THREE.Object3D();
      this.barrelEnd.position.set(0, t.h*0.6, t.l + this.def.barrelLen);
      this.turretGroup.add(this.barrelEnd);

      // Named-empty markers: place the muzzle at the "firing" empty and the
      // casing port at "shell_ejection" so they ride the turret rotation.
      this.root.updateMatrixWorld(true);
      if(firingG){
        grp.updateMatrixWorld(true);
        const wp = new THREE.Vector3();
        firingG.getWorldPosition(wp);
        this.barrelEnd.position.copy(this.turretGroup.worldToLocal(wp));
        /* ============================================================================
           POINT THE MUZZLE ALONG THE BARREL WHEN THE MODEL SAYS SO.

           Tank.muzzle() takes "forward" to be the muzzle node's own +Z, which is
           only true of a model authored barrel-along-+Z. TL_mortar.glb is
           authored barrel-along-+X (like TL_ark), so without a correction the
           shell leaves ninety degrees to one side of the gun it came out of,
           while the model on screen looks like it aimed dead ahead.

           _attachNamedModel has corrected this since TL_ark by reading the
           direction off the gun assembly's own offset inside the turret. This
           branch never got it, and a blanket "rotate toward the muzzle offset"
           was tried and REVERTED: helix.glb also has its firing empty far out
           along +X, but its hull is built facing +Z, so rotating the muzzle there
           turned the Inferno's flame ninety degrees off while everything else
           about the tank stayed put. Geometry alone cannot tell the two cases
           apart, so the tank def has to say which one it is — `muzzleAxis:'x'`.

           Cost of an unset flag is nil: a model authored +Z gets atan2(0, +z) = 0
           and no rotation at all.
           ============================================================================ */
        if(this.def.muzzleAxis === 'x'){
          const ax = this.barrelEnd.position.x;
          const az = this.barrelEnd.position.z;
          /* The hub is the turret pivot, which in this branch is the origin of
             turretGroup's local space (turretParts is added at the origin). */
          if(ax * ax + az * az > 1e-8) this.barrelEnd.rotation.y = Math.atan2(ax, az);
        }
      }
      /* ============================================================================
         THE GUN ASSEMBLY: RECOIL AND RANGE-DRIVEN ELEVATION.

         TL_mortar.glb authors its barrel as a real articulated arm rather than a
         lump welded to the turret:

             Cylinder (turret ring)
               -> Cube.003 (the arm, barrel runs along its local +X)
                    -> Cylinder.005 (the barrel)
                    -> "firing"   (the muzzle marker)

         so the arm is a hinged part that can be raised. Two animations ride on it.

         RECOIL is the one the Ark already has (see _attachNamedModel): the arm
         snaps back along the barrel axis and eases into battery. It is set up
         identically here so the firing animation reads the same on both tanks
         instead of the Mortar quietly having none.

         ELEVATION is artillery-specific: a gun that stays flat while a shell
         describes a fifty metre arc over a wall looks broken, so the arm tilts up
         with the shot distance, capped at 32 degrees.

         BOTH ARE GATED on shellType. The named-empty rig is shared by every model
         without hull/turret groups, and arming it unconditionally would give the
         Ghost a recoiling, aim-dependent barrel it was never authored to have.
         ============================================================================ */
      /* THIS RIG IS FOR MODELS THAT DECLARE THEIR PARTS (def.rig). It hands hull,
           turret and gun to the named-group rig, which knows how to keep a turret
           on its own pivot, protect the gun from batching and mount the muzzle on
           it. Reaching the elevation here instead — as this branch used to — would
           only ever see ONE gun-shaped child and would silently take the wrong node
           for any model whose turret carries more than one part. */
      if(this.def.rig && this.def.rig.hull && this.def.rig.turret){
        this._attachNamedModel(grp, hullG, turretG, shellG, scale, firingG, ejectG);
        return;
      }

      if(this.def.shellType === 'mortar' && firingG && firingG.parent && firingG.parent !== grp){
        const gun = firingG.parent;
        this._gunNode = gun;
        this._gunHomeRotZ = gun.rotation.z;
        this._recoilNode = gun;
        this._recoilHome = gun.position.clone();
        /* Local +X is the barrel direction on this model, so a NEGATIVE X offset
           pushes the arm backwards down the barrel. Same sign and rough magnitude
           as the Ark, which is what makes the two look like the same mechanic. */
        this._recoilKick = -0.4;
        this._recoilT = -1;

        /* MOVE THE MUZZLE ONTO THE ARM.

           barrelEnd is where the shell appears and where the aim line starts. It
           was parented to turretGroup, which does NOT move when the arm tilts, so
           raising the barrel would have left the shell spawning in mid air a good
           three metres behind and below the visible muzzle at full elevation.

           Reparenting rather than recomputing each frame means it inherits both
           animations for free: it rides the elevation because it is now a child of
           the hinge, and it rides the recoil for the same reason. The world
           transform is captured and restored around the reparent so nothing moves
           on the frame this runs — the muzzle is already correct here. */
        this.root.updateMatrixWorld(true);
        const wPos = this.barrelEnd.getWorldPosition(new THREE.Vector3());
        const wQuat = this.barrelEnd.getWorldQuaternion(new THREE.Quaternion());
        gun.add(this.barrelEnd);
        this.root.updateMatrixWorld(true);
        this.barrelEnd.position.copy(gun.worldToLocal(wPos.clone()));
        this.barrelEnd.quaternion.copy(
          gun.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(wQuat));
        this.root.updateMatrixWorld(true);

        /* GIVE THE GUN A BARREL TO FIRE FROM.

           Measured on this model: the arm's geometry stops at local X = 1.9 while
           `firing` — and with it the shell, the aim line and the muzzle — sits at
           X = 5.48, and NO mesh anywhere on the tank comes within 0.4 units of
           that point (the nearest thing is the hull, 0.86 away). The shell was
           therefore leaving from empty air 3.6 units ahead of anything visible.
           On a weapon whose whole identity is a tube lobbing shells, a gun that
           just stops, with the shot coming out of nothing, is exactly what reads
           as "the gun is not stucked to his turret".

           The tube runs from just inside the arm's front face (0.2 in, so the
           join can never open a seam when the arm kicks back) out to exactly the
           muzzle, so the spawn point lands on visible metal. Parenting it to the
           arm gives it elevation and recoil for free — the same reason barrelEnd
           was reparented above — so barrel and muzzle cannot drift apart.

           The `>` guard makes this a no-op on any model whose barrel already
           reaches its own muzzle, so it stays safe to leave in place. */
        /* RE-READ the arm's front face, captured during _loadModel while the
           hierarchy still described the author (see _armFrontLocalX there).
           Measuring it HERE, after the height-split and the batching, finds an
           arm with no mesh children left and reports -Infinity, which would make
           the guard below always true. */
        const armFront = (typeof this._armFrontLocalX === 'number')
          ? this._armFrontLocalX
          : (() => {
              /* Fallback for a model that never went through that path: measure
                 it now, from whatever is still parented to the arm. */
              gun.updateMatrixWorld(true);
              const inv = new THREE.Matrix4().copy(gun.matrixWorld).invert();
              const c = new THREE.Vector3();
              let mx = -Infinity;
              gun.traverse(o => {
                if(!o.isMesh || !o.geometry) return;
                if(!o.geometry.boundingBox) o.geometry.computeBoundingBox();
                const bb = o.geometry.boundingBox;
                for(let i = 0; i < 8; i++){
                  c.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
                  c.applyMatrix4(o.matrixWorld).applyMatrix4(inv);
                  if(c.x > mx) mx = c.x;
                }
              });
              return (mx === -Infinity) ? null : mx;
            })();

        const muzz = this.barrelEnd.position;
        /* ONLY RECONSTRUCT A BARREL THAT IS ACTUALLY MISSING.

           This exists to rebuild the tube on TL_mortar, whose barrel was a
           separate mesh (Cylinder.005) parented to the gun arm; the loader's
           rigging drops any mesh whose parent is itself a mesh, so the barrel
           never reached the scene and the gun read as a stub.

           TL_mortar_fix ships the barrel AS A SECOND PRIMITIVE OF THE ARM ITSELF
           (Cube008_1, running out to the `firing` empty), and the arm's measured
           front is therefore at or past the muzzle — so this adds nothing and the
           model keeps its authored tube. `armFront === null` means the arm could
           not be measured at all, and reconstructing is the safer answer there.

           Deliberately a MEASUREMENT and not a model-name check: the condition
           describes the shape ("the arm does not reach its own muzzle"), so a
           future model either satisfies it or does not, with nobody having to
           remember to edit this. */
        if(armFront === null || muzz.x > armFront + 0.1){
          const back = armFront - 0.2;
          const len = muzz.x - back;
          /* RADIUS 0.60 IS THE AUTHOR'S, NOT A CHOICE.

             TL_mortar DID ship a barrel — Cylinder005, parented to this very
             arm — but the rigging drops any mesh whose parent is itself a mesh,
             so it never reached the scene: it is absent from the whole model at
             runtime while its sibling `firing`, an Object3D, survives. That is
             the whole reason the gun read as an unfinished stub.

             Only reached when that barrel is genuinely absent (see the guard
             above); the current model needs none of this.

             Reconstructing it instead of inventing it: its authored geometry is
             radius 1.185 with node scale.x 0.501, so 1.185 * 0.501 = 0.594 in
             this frame — and it starts exactly where the arm's box ends, the way
             the arm above measures it. 0.60 reproduces the authored tube to
             within six thousandths of a unit, which is why it also lands neatly
             inside the arm's 2.25 x 2.0 cross-section where the join is made. */
          const geo = new THREE.CylinderGeometry(0.60, 0.60, len, 32, 1, false);
          geo.rotateZ(-Math.PI / 2);      /* cylinder's own +Y becomes the arm's +X */
          geo.translate(back + len / 2, muzz.y, muzz.z);

          /* Fill clones the arm's own material: a flat MeshToonMaterial with no
             texture map, so a straight clone matches the paint exactly instead of
             inventing UVs for geometry the author never unwrapped. The rim clones
             the model's inverted-hull outline (BackSide, black, pushed along the
             normals by uThickness) so the barrel gets the same black edge as
             everything drawn around it. */
          let fill = null, rim = null;
          gun.traverse(o => {
            if(!o.isMesh || !o.material) return;
            if(!fill && o.material.type === 'MeshToonMaterial') fill = o.material;
            else if(!rim && o.material.type === 'ShaderMaterial') rim = o.material;
          });

          const body = new THREE.Mesh(geo, fill ? fill.clone()
                                       : new THREE.MeshToonMaterial({color: 0x233b1c}));
          body.name = 'mortarBarrel';
          gun.add(body);

          if(rim){
            const edge = new THREE.Mesh(geo, rim.clone());
            edge.name = 'mortarBarrelOutline';
            gun.add(edge);
          }
        }
      }
      if(ejectG){
        grp.updateMatrixWorld(true);
        const wp2 = new THREE.Vector3();
        ejectG.getWorldPosition(wp2);
        this._shellNode = new THREE.Object3D();
        this._shellNode.position.copy(this.turretGroup.worldToLocal(wp2));
        this.turretGroup.add(this._shellNode);
        this._casingOffset = this._shellNode.position.clone();
      }
      this._addOverlays(t.h);
      this._syncTransform();
      this._applyEditorOverrides();
      this._setupAnims(grp);
    });
  }

  /* Attach a model that ships its own hull/turret groups, or one whose def
     declares which node plays which part (see the `rig` handling in _loadModel).

     `firingPre` is the muzzle marker and `gunPre` the gun node, both captured
     while `grp` was still intact — the roots get re-parented out of `grp` below,
     so a lookup afterwards finds nothing. */
  _attachNamedModel(grp, hullG, turretG, shellG, scale, firingPre, gunPre){
    grp.updateMatrixWorld(true);
    // Center the model on its own bounds: x/z centered so the tank
    // pivot sits at the model center, y resting on the ground plane
    // (Tank.boxOf ignores the invisible "hitbox" helper so it can't skew
    // the centre the model is shifted to).
    const bb = Tank.boxOf(grp, true);
    const c = bb.getCenter(new THREE.Vector3());
    grp.position.set(grp.position.x - c.x, grp.position.y - bb.min.y, grp.position.z - c.z);
    // The game aims turrets along +Z. The coolbuddy model is authored with
    // the whole tank's front/back sides swapped relative to the game AND the
    // barrel is baked into the turret mesh itself, so for def.modelFlipY we
    // bake a 180° Y-flip into the hull and turret MESH GEOMETRIES (each about
    // its own center, so pivots stay put) — the barrel/mantlet and the hull
    // front then face the game's +Z forward while the turret rotation still
    // works. Other models keep the auto whole-model flip.
    let flippedTurret = false;
    if(this.def.modelFlipY && turretG && hullG){
      const bakeFlip = (g) => {
        // Models.load returns a clone that SHARES geometry with the cached
        // scene (three.js clone() clones the object tree but not buffers), so
        // never mutate that shared geometry in place: cloning it here makes
        // every rebuild of the same tank flip its own copy exactly once.
        if(!g.geometry || !g.geometry.attributes) return;
        g.geometry = g.geometry.clone();
        const a = g.geometry.attributes.position;
        const box = new THREE.Box3();
        const v = new THREE.Vector3();
        for(let i=0;i<a.count;i++){
          v.fromBufferAttribute(a, i);
          box.expandByPoint(v);
        }
        const ctr = box.getCenter(new THREE.Vector3());
        g.geometry.translate(-ctr.x, -ctr.y, -ctr.z)
          .rotateY(Math.PI)
          .translate(ctr.x, ctr.y, ctr.z);
      };
      bakeFlip(turretG);
      bakeFlip(hullG);
      // Marker empties (gun muzzle / shell port) ride inside the turret
      // pivot: flip them with a 180° group so they sit at the flipped
      // barrel tip and shell port positions.
      const flipT = new THREE.Group();
      flipT.rotation.y = Math.PI;
      turretG.children.slice().forEach(ch => flipT.add(ch));
      turretG.add(flipT);
      flippedTurret = true;
    } else if(shellG && this.def.modelAutoFlip !== false){
      grp.updateMatrixWorld(true);
      const p = new THREE.Vector3();
      shellG.getWorldPosition(p);
      if(p.z < 0) grp.rotation.y = Math.PI;
    }
    grp.updateMatrixWorld(true);

    const bodyParts = new THREE.Group();
    const turretParts = new THREE.Group();
    // Recolor only untextured materials: textured models keep the
    // authored paint job; clone so hull/turret colors never conflict
    const addRim = (m) => {
      return m;
    };
    const tint = (g, col) => g.traverse(o => {
      if(!o.isMesh) return;
      if(o.visible === false) return;   // authored helper volumes (hitbox)
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const colored = mats.map(m => {
        let c;
        if(!m.map){
          c = Toon.mat({color: new THREE.Color(col)});
        } else {
          c = m.clone();
          c.alphaTest = Math.max(c.alphaTest || 0, 0.5);
          if(!c.isMeshToonMaterial){
            const tc = Toon.mat({color: c.color, map: c.map, alphaTest: c.alphaTest, transparent: c.transparent, opacity: c.opacity});
            c = tc;
          }
        }
        return addRim(c);
      });
      o.material = Array.isArray(o.material) ? colored : colored[0];
    });
    tint(hullG, this.color);
    tint(turretG, this.def.turretColor);
    bodyParts.attach(hullG);
    turretParts.attach(turretG);
    // Outlines are inflated in authored units, but the model is scaled
    // ~9x in world units: shrink the inflation so the rim stays thin
    const outlineT = 0.04 / (scale || 1);
    let srcMeshes = [];
    bodyParts.traverse(o => { if(o.isMesh && o.visible !== false) srcMeshes.push(o); });
    srcMeshes.forEach(m => this._addOutline(m, m.parent, outlineT));
    srcMeshes = [];
    turretParts.traverse(o => { if(o.isMesh && o.visible !== false) srcMeshes.push(o); });
    srcMeshes.forEach(m => this._addOutline(m, m.parent, outlineT));

    // Same triangles, same materials, same pixels — just far fewer draw calls.
    //
    // THE GUN MUST BE IN THE PROTECTED SET. Batching merges a group's meshes into
    // one draw call, and the gun node is a hinge: recoil slides it along its own X
    // and artillery elevation rotates it about its own Z. A merged gun cannot do
    // either, so the merge would have to drop it — and a dropped gun node leaves
    // the barrel and the muzzle frozen at the bind pose while the turret turns.
    if(this._canBatchModel(grp)){
      const prot = Tank._protectedSet([shellG, firingPre, hullG, turretG, gunPre]);
      this._batchPartGroup(bodyParts, prot);
      this._batchPartGroup(turretParts, prot);
    }

    this._bodyOrient.add(bodyParts);
    this._turretOrient.add(turretParts);

    // Give every named model a dedicated pivot at the turret's geometric
    // center so the turret+outline swing around the turret's own center bolt
    // by default. The Tank Editor can move it (rotation-only; the turret
    // mesh stays planted at its mount point).
    this.root.updateMatrixWorld(true);
    // Mount point of the turret (where it sits on the hull, at 0°). Kept in
    // turretParts space: the pivot below can then move freely and change the
    // ROTATION point without dragging the turret mesh along.
    const homeV = new THREE.Vector3();
    turretG.getWorldPosition(homeV);
    this._turretHome = turretParts.worldToLocal(homeV);
    this._turretG = turretG;
    const pivotBox = new THREE.Box3().setFromObject(turretG);
    const pivotC = pivotBox.getCenter(new THREE.Vector3());
    const turretPivotLocal = turretParts.worldToLocal(pivotC);
    const turretPivot = new THREE.Group();
    turretPivot.position.copy(turretPivotLocal);
    turretParts.add(turretPivot);
    turretPivot.updateMatrixWorld(true);
    turretPivot.attach(turretG);
    // Keep the turret mesh at its authored home (attach already sets
    // turretG.local = home - pivot).
    this._applyTurretPlacement();

    // The turret group rotates about this dedicated front pivot node
    this._modelTurretPivot = turretPivot;
    // Shell-casing eject node (marked in the model: "shell")
    this._shellNode = shellG || null;
    // Cache the casing port's offset relative to the turret at bind pose so
    // casing eject never rides a firing/casing animation keyframed on that
    // node (Cool Buddy's "gun firing" clip scatters/rotates it).
    this.root.updateMatrixWorld(true);
    this._casingOffset = null;
    if(this._shellNode){
      const wpv = new THREE.Vector3();
      this._shellNode.getWorldPosition(wpv);
      this._casingOffset = this.turretGroup.worldToLocal(wpv);
    }
    // Muzzle spawn point (the FIRING point). Prefer an explicit "firing" /
    // "muzzle" empty if the model has one, else auto-derive it just past the
    // front-most extent of the turret (which contains the baked barrel).
    this.barrelEnd = new THREE.Object3D();
    const t = this.def.turret;
    const findNamedL = (root, name) => {
      const s = String(name).toLowerCase();
      let out = null;
      root.traverse(o => { if(!out && o.name && String(o.name).toLowerCase() === s) out = o; });
      return out;
    };
    const firingG = firingPre || findNamedL(grp, 'firing') || findNamedL(grp, 'muzzle');
    if(firingG){
      grp.updateMatrixWorld(true);
      const wp = new THREE.Vector3();
      firingG.getWorldPosition(wp);
      this.barrelEnd.position.copy(turretG.worldToLocal(wp));
    } else if(shellG && flippedTurret){
      // Muzzle just past the front-most extent of the (now flipped) turret
      // so shells spawn right at the barrel tip. Computed on the turret's
      // own bounds so it works at any modelScale without hardcoding.
      const bb = new THREE.Box3().setFromObject(turretG);
      const off = (this.def.muzzleZOff != null ? this.def.muzzleZOff : 0.6);
      const muzzle = new THREE.Vector3(
        (bb.min.x + bb.max.x) / 2,
        (bb.min.y + bb.max.y) / 2,
        bb.max.z + off
      );
      const inv = new THREE.Matrix4().copy(turretG.matrixWorld).invert();
      muzzle.applyMatrix4(inv);
      this.barrelEnd.position.copy(muzzle);
    } else {
      this.barrelEnd.position.set(0, t.h*0.6, t.l + this.def.barrelLen);
    }
    turretG.add(this.barrelEnd);
    // --- Gun recoil: the muzzle's parent is the authored gun assembly —
    //     TL_ark's "Cylinder" node, which holds the two barrel meshes plus
    //     the "firing" empty. Kick it back along its own X the instant the
    //     tank fires, then ease it home so the barrel returns to battery.
    this._recoilNode = null;
    this._recoilHome = null;
    this._recoilKick = 0;
    this._recoilT = -1;

    /* WHICH NODE IS THE GUN?
       A def may name it (def.rig.gun). Otherwise it is whatever the muzzle marker
       hangs off, which is how TL_ark and TL_mortar_fix are both built. */
    let gunG = gunPre || null;
    if(!gunG && firingG && firingG.parent && firingG.parent !== turretG) gunG = firingG.parent;

    if(gunG && gunG !== turretG){
      /* The gun must actually be INSIDE the turret for turret rotation to carry
         it. If it is not, something is wrong with the rig, and arming it anyway
         would give a gun that turns without its turret or a turret that turns
         without its gun. Refuse rather than half-work. */
      let anc = gunG, ridesTurret = false;
      while(anc){ if(anc === turretG){ ridesTurret = true; break; } anc = anc.parent; }
      if(ridesTurret){
        this._recoilNode = gunG;
        this._recoilHome = gunG.position.clone();
        this._recoilKick = -0.4;

        /* ARTILLERY ELEVATION rides on the same node.
           Game._mortarAim writes gunElevTarget in degrees and _updateGunAssembly
           eases the gun toward it, so the barrel visibly lifts as the shot
           lengthens. Without this the gun stays flat while a shell describes a
           fifty metre arc over a wall, which reads as broken.

           The hinge is the gun's LOCAL Z, the axis perpendicular to a barrel that
           runs along local +X, so a positive Z rotation lifts the muzzle. The
           authored home rotation is captured and used as the base value, because
           this model authors the arm at 90 degrees already. */
        if(this.def.shellType === 'mortar'){
          this._gunNode = gunG;
          this._gunHomeRotZ = gunG.rotation.z;
        }

        /* MOVE THE MUZZLE ONTO THE GUN.
           barrelEnd is a child of turretG, which does NOT move when the gun
           elevates — so a lifted barrel would leave the shell spawning in open
           air behind and below the visible muzzle. Reparenting puts it inside the
           hinge, where it inherits elevation and recoil for free and therefore
           cannot drift away from the barrel it belongs to.

           The world transform is captured and written back around the reparent so
           nothing visibly moves on the frame this runs. */
        this.root.updateMatrixWorld(true);
        const wPos  = this.barrelEnd.getWorldPosition(new THREE.Vector3());
        const wQuat = this.barrelEnd.getWorldQuaternion(new THREE.Quaternion());
        gunG.add(this.barrelEnd);
        this.root.updateMatrixWorld(true);
        this.barrelEnd.position.copy(gunG.worldToLocal(wPos.clone()));
        this.barrelEnd.quaternion.copy(
          gunG.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(wQuat));

        /* The barrel runs along the gun axis (model +X, not the +Z the game reads
           as forward), so yaw the muzzle onto that axis or shells leave 90° off
           the visible barrel. Measured in the gun's own frame, which is where the
           barrel actually points. */
        this.root.updateMatrixWorld(true);
        const gunLocal = this.barrelEnd.parent.worldToLocal(
          this.barrelEnd.getWorldPosition(new THREE.Vector3()));
        const ax = this.barrelEnd.position.x - gunLocal.x;
        const az = this.barrelEnd.position.z - gunLocal.z;
        if(ax * ax + az * az > 1e-8) this.barrelEnd.rotation.y = Math.atan2(ax, az);
      }
    }
    this._addOverlays(t.h);
    this._syncTransform();
    this._applyEditorOverrides();
    this._setupAnims(grp);
  }

  /* Called by Game.spawnShot() the instant a shell leaves the barrel: the
     gun node snaps straight to full recoil, then _updateRecoil eases it back
     so the barrel slides into battery instead of teleporting. */
  onFired(){
    if(!this._recoilNode || !this._recoilHome) return;
    this._recoilT = 0;
    this._recoilNode.position.x = this._recoilHome.x + this._recoilKick;
  }

  /* Slide the recoiling gun node back to its authored position. */
  _updateRecoil(dt){
    if(!this._recoilNode || !(this._recoilT >= 0)) return;
    this._recoilT += dt;
    const dur = 0.4;                    // seconds back into battery
    const u = Math.min(1, this._recoilT / dur);
    const e = 1 - (1 - u) * (1 - u);    // ease-out: leaves fast, settles slow
    this._recoilNode.position.x = this._recoilHome.x + this._recoilKick * (1 - e);
    if(u >= 1){
      this._recoilNode.position.x = this._recoilHome.x;
      this._recoilT = -1;
    }
  }

  /* Swing the Mortar's gun arm toward the elevation the aim asks for.

     Game._mortarAim writes `gunElevTarget` in degrees; this eases toward it and
     applies the result about the arm's local Z, the axis perpendicular to the
     barrel (the barrel runs along local +X, so a positive Z rotation lifts it).

     The easing is exponential rather than a fixed per-frame step, so it is
     frame-rate independent, and it is deliberately brisk: the player drags the
     mouse and the gun answers within about a tenth of a second without ever
     snapping far enough to read as a glitch. Artillery that lurches is worse
     than artillery that does nothing, because the player is judging where the
     shell will land while looking at the barrel.

     The 32 degree ceiling is enforced HERE rather than only at the source, so a
     value arriving from anywhere, including a bot or a network snapshot, still
     ends up within the model's authored range of motion. Rotating a hinged arm
     past the angle its creator left it at is how a barrel ends up poking
     through a turret ring. */
  _updateGunAssembly(dt){
    if(!this._gunNode) return;
    const MAX_DEG = 32;
    const want = Math.max(-MAX_DEG, Math.min(MAX_DEG, this.gunElevTarget || 0));
    /* time constant 0.10s: within 5% of the target in about a third of a second */
    const k = 1 - Math.exp(-Math.max(0, dt) / 0.10);
    this._gunElev += (want - this._gunElev) * k;
    if(Math.abs(want - this._gunElev) < 0.01) this._gunElev = want;
    this._gunNode.rotation.z = this._gunHomeRotZ + this._gunElev * Math.PI / 180;
  }
  /* World position the ejected shell-casing flies out from. Uses the cached
     bind-pose offset so the firing/casing animation can't skew it. */
  casingPos(){
    this.root.updateMatrixWorld(true);
    if(this._casingOffset){
      const tmp = new THREE.Vector3().copy(this._casingOffset);
      return this.turretGroup.localToWorld(tmp);
    }
    if(this._shellNode){
      const p = new THREE.Vector3();
      this._shellNode.getWorldPosition(p);
      return p;
    }
    // No casing port on this model: eject from the muzzle instead
    const m = this.muzzle();
    return m.pos;
  }

  _clearGroup(g){
    for(let i=g.children.length-1;i>=0;i--){
      const c = g.children[i];
      if(c.userData && c.userData.isOverlay) continue;
      g.remove(c);
    }
  }

  _addOverlays(turretH){
    if(this._overlayGroup && this.hpSprite && this.hpSprite.parent === this._overlayGroup) return;
    this._baseTurretH = turretH;
    this._overlayGroup = new THREE.Group();
    this.hpSprite = this._makeHpSprite();
    this.hpSprite.userData.isOverlay = true;
    this.hpSprite.renderOrder = 999;
    this.hpSprite.position.y = turretH + 4.2;
    this._overlayGroup.add(this.hpSprite);

    this._drownBar = this._makeDrownBar();
    this._drownBar.userData.isOverlay = true;
    this._drownBar.renderOrder = 999;
    this._drownBar.position.y = turretH + 1.5;
    this._overlayGroup.add(this._drownBar);
    this.root.add(this._overlayGroup);
    this._applyPowerScale();
  }

  /* ---- tread marks ---------------------------------------------------- */
  /* Marks kept per tank. The interval floor is 0.1s and a mark lives 2s, so
     48 is already more than a tank can lay down; the old cap of 200 was five
     times what the trail ever needed. */
  static get TRAIL_MAX(){ return 48; }
  /* ONE material for every tread mark in the game. */
  static _trailMat(){
    if(!Tank.__trailMat){
      Tank.__trailMat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1,
        depthWrite: false, toneMapped: false, fog: false,
      });
    }
    return Tank.__trailMat;
  }

  _makeHpSprite(){
    // The plate is authored in logical 360 x 100 units and stamped onto a
    // devicePixelRatio-scaled backing bitmap, so the nickname stays sharp on
    // hi-DPI screens instead of being an upscaled 360px canvas.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this._hpDpr = dpr;
    const c = document.createElement('canvas');
    c.width = Math.round(360 * dpr); c.height = Math.round(100 * dpr);
    this._hpCanvas = c; this._hpCtx = c.getContext('2d');
    // Stagger phase for the redraw rate limit in _stepHpBar: every tank in a
    // cluster would otherwise come due on the very same frame.
    const idn = parseInt(String(this.id || '0').replace(/[^0-9]/g, ''), 10) || 0;
    this._hpPhase = idn % 5;
    this._hpAcc = -(this._hpPhase * 0.01);
    const tex = new THREE.CanvasTexture(c);
    // The canvas is authored in sRGB, so decode it on sample. Without this the
    // sRGB output pass re-encodes already-encoded values and the HUD washes out.
    tex.colorSpace = THREE.SRGBColorSpace;
    this._hpTex = tex;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map:tex, depthTest:false, transparent:true, depthWrite:false,
      // HUD overlay: it is UI, not lit scenery. Let the authored colours through
      // instead of ACES tone mapping (desaturates them toward white) and scene
      // fog (fades them into the light sky colour at range).
      toneMapped:false, fog:false
    }));
    spr.renderOrder = 999;
    const aspect = c.width / c.height;
    const baseH = 1.3;
    this._hpAspect = aspect;
    spr.scale.set(aspect * baseH, baseH, 1);
    this._drawHp();
    return spr;
  }
  _drawHp(){
    const c=this._hpCanvas, g=this._hpCtx;
    if(!c||!g) return;
    const W = 360, H = 100;
    const dpr = this._hpDpr || 1;
    const rr = (x,y,w,h,r)=>{ if(g.roundRect) g.roundRect(x,y,w,h,r); else g.rect(x,y,w,h); };

    // Everything below is authored in logical 360x100 units; the DPR transform
    // scales it onto the hi-DPI backing bitmap.
    g.setTransform(dpr,0,0,dpr,0,0);
    g.clearRect(0,0,W,H);

    const TROPHY = '\u{1F3C6}';                       // 🏆
    let name = this.name || '';
    let trophy = '';
    if(name.indexOf(TROPHY) === 0){
      // The platoon path prefixes the trophy onto the name it sends, so pull it
      // out here instead of printing it twice.
      trophy = TROPHY;
      name = name.slice(TROPHY.length).replace(/^\s+/, '');
    } else {
      try{
        const ms = (window.Menu && Menu.settings) || {};
        if(this.isLocal && (ms.trophyCount || 0) > 0) trophy = TROPHY;
      }catch(e){}
    }

    const pct = Math.max(0, Math.min(1, this.hp / this.maxHp));

    // HOST TAG. The host of a multiplayer match gets the small "HOST" pill on the
    // nameplate, so everyone in the battle can see who is running the simulation.
    // It is drawn in the nameplate canvas so it scales with the bar and sits next to
    // the name, not as 3D geometry and not as a HUD element. It shows on relay-only
    // matches too, because the host is still the host even when the fast path is off.
    let isHost = false;
    try {
      if(typeof Net !== 'undefined' && Net.isHostOfMatch && Net.isHostOfMatch()){
        const me = (typeof Net !== 'undefined' && Net.playerId) ? Net.playerId : null;
        if(me && this.id === 'remote-' + me) isHost = true;
      }
    } catch(e) { /* Net may not be wired yet; treat as not host */ }
    // `_hpStepped` is false until _stepHpBar runs: on a plate that is never
    // animated (menu previews) we must snap straight to the live value rather
    // than hold a stale one forever.
    if(this._hpDisp === undefined || !this._hpStepped){
      this._hpDisp = pct; this._hpGhost = pct; this._hpFlash = 0;
    }
    const fill  = Math.max(0, Math.min(1, this._hpDisp));
    const ghost = Math.max(0, Math.min(1, this._hpGhost));
    const flash = Math.max(0, Math.min(1, this._hpFlash || 0));

    let hpCol = '#ff3b3b';
    let teamCol = '#ff3b3b';
    /* isAlly gates the reload line, so it is computed once here alongside the
       colour rather than re-deriving the same three conditions further down. */
    let isAlly = false;
    try {
      const lt = window._game && window._game.localTank;
      if(lt){
        const sameTeam = lt.team && this.team && lt.team === this.team;
        const allied = lt.allyId && lt.allyId === this.id;
        if(this === lt || sameTeam || allied){
          hpCol = '#3bbeff';
          teamCol = '#3bbeff';
          isAlly = true;
        }
      }
    } catch(e){}

    /* NOTE: there used to be a local shade(hex, f) helper here, lightening and
       darkening the team colour for the cel-shaded bands. It moved into
       js/hpbar-styles.js along with the bar itself, so all five styles shade
       identically instead of each re-deriving it. */

    // ---- layout (logical units) ----
    // The frame's OUTSIDE edge (stroke is 4 wide, so it straddles the path by
    // 2px) is what the eye lines up: path top 12 -> outer row 10 == the
    // nickname's stroke top row, and path bottom 88 -> outer row 89 == the
    // health bar plate's last row. Frame top and name top are both 12 on
    // purpose.
    const avatarX = 10, avatarY = 12, avatarSize = 76;   // 12 .. 88
    // Nickname grows to the RIGHT and DOWN only: its stroke top stays on row
    // 10 (flush with the frame's top) while the larger glyphs push toward the
    // health bar, killing the empty band that used to sit between them.
    const nameY = 12, nameFont = 38;
    const barX = avatarX + avatarSize + 14;              // 100
    /* HEALTH BAR MOVED UP, AND THE RELOAD LINE GIVEN THE SPACE IT FREED.

       Was barY 65 / barH 22, whose plate ran rows 62..90 -- flush with the
       bottom of the avatar frame, so there was nothing below it to put anything
       in. It now runs 52..76 and the reload line takes 76..90.

       The numbers come from measured text metrics, not guesswork. The nickname
       is drawn with textBaseline 'top' at row 12 in a bold 38px face, and its
       lowest possible ink is row 50 (a name with descenders; an all-caps name
       stops at 39). So row 52 leaves two rows of clearance under the worst
       possible name while using all of the space that was going spare.

       barH drops 22 -> 18 so the two bars split the 50..90 band roughly evenly.
       That is a real change to the health bar's thickness, not only its
       position, and it is the one thing here that was not purely a move. */
    const barY = 55, barH = 18;                          // plate 52 .. 76
    const barW = W - barX - 12;                          // 248

    /* THE RELOAD LINE. Same left and right edges as the health bar, thinner,
       and its bottom edge flush with the bottom of the avatar frame at row 90.
       14 rows of plate, 10 of fill, against the health bar's 18 and 14 -- so it
       reads as narrower from above and below while its sides line up. */
    const rlY = barY - 3 + barH + 6;                     // 76, straight under it
    const rlH = 14;                                      // plate 76 .. 90

    // One shared "sticker" outline colour for frame, name and bar - a solid
    // near-black navy is what makes a cartoon UI read as drawn rather than lit.
    const OUT = '#14141d';

    // ---- trophy / avatar frame: spans nickname-top to health-bar-bottom ----
    g.fillStyle = '#a9a9a9';                             // CSS darkgray
    g.beginPath();
    rr(avatarX, avatarY, avatarSize, avatarSize, 12);
    g.fill();
    g.strokeStyle = OUT;
    g.lineWidth = 4;
    g.beginPath();
    rr(avatarX, avatarY, avatarSize, avatarSize, 12);
    g.stroke();

    const cx = avatarX + avatarSize / 2, cy = avatarY + avatarSize / 2;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.strokeStyle = OUT;
    g.fillStyle = '#fff';
    /* THE LOCAL PLAYER'S OWN AVATAR, AS A PICTURE.

       The frame used to hold a trophy emoji for anybody who owned any trophy at
       all, so equipping one changed nothing in a match. It draws the icon the
       player has equipped instead, from the same helper the menus read, so the
       nameplate and the profile card can never show two different trophies.

       Only the local tank gets this: another player's avatar is not sent over the
       wire, so remote tanks keep the emoji below rather than guessing. */
    let icon = null;
    if(this.isLocal && typeof getAvatarIcon === 'function') icon = getAvatarIcon();
    if(icon && icon.complete && icon.naturalWidth > 0){
      const pad = 10, s = avatarSize - pad * 2;
      g.drawImage(icon, avatarX + pad, avatarY + pad, s, s);
    } else if(trophy){
      g.font = '46px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      g.lineWidth = 5;
      g.strokeText(trophy, cx, cy);
      g.fillText(trophy, cx, cy);
    } else {
      // No trophy selected -> placeholder glyph.
      g.font = 'bold 52px "Nunito", "Segoe UI", sans-serif';
      g.lineWidth = 7;
      g.strokeText('x', cx, cy + 2);
      g.fillText('x', cx, cy + 2);
    }

    // ---- nickname ----
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.font = 'bold ' + nameFont + 'px "Nunito", "Segoe UI", sans-serif';
    g.fillStyle = '#fff';
    g.strokeStyle = OUT;
    g.lineWidth = 4;
    g.strokeText(name, barX, nameY, barW);
    g.fillText(name, barX, nameY, barW);

    // HOST pill: small and readable, top-right of the nameplate.
    if(isHost){
      const pillText = 'HOST';
      g.font = 'bold 22px "Nunito", "Segoe UI", sans-serif';
      const tw = g.measureText(pillText).width;
      const padX = 10, padY = 7;
      const pw = tw + padX * 2 + 4, ph = 24 + padY * 2;
      const px = W - pw - 10, py = 10;
      g.save();
      g.translate(px + pw / 2, py + ph / 2);
      g.rotate(-Math.PI / 4);
      g.translate(-pw / 2, -ph / 2);
      g.fillStyle = '#ffd23f';
      g.beginPath();
      if(g.roundRect){
        g.roundRect(0, 0, pw, ph, 6);
      } else {
        g.rect(0, 0, pw, ph);
      }
      g.fill();
      g.strokeStyle = '#14141d';
      g.lineWidth = 3;
      if(g.roundRect){
        g.roundRect(0, 0, pw, ph, 6);
      } else {
        g.rect(0, 0, pw, ph);
      }
      g.stroke();
      g.fillStyle = '#1a1a1a';
      g.font = 'bold 22px "Nunito", "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(pillText, pw / 2, ph / 2 + 1);
      g.restore();
    }

    // ---- health bar + reload line ----
    // Both bars are drawn by js/hpbar-styles.js, which is plain canvas2d with
    // no game dependencies. That file is also what the style preview page
    // loads, so the five options it offers are drawn by exactly this code.
    const pX = barX - 3, pY = barY - 3, pW = barW + 6, pH = barH + 6;

    if(typeof HPBarStyles !== 'undefined'){
      HPBarStyles.draw(g, {
        x: pX, y: pY, w: pW, h: pH,
        fill: fill, ghost: ghost, flash: flash,
        hpCol: hpCol, outline: OUT,
        pulse: this._hpPulse || 0,
        style: HPBAR_STYLE
      });
    } else {
      /* The module failed to load. Rather than draw no bar at all, fall back to
         the single most conservative shape: one solid fill inside the plate. */
      g.save();
      g.beginPath(); rr(pX + 4, pY + 4, pW - 8, pH - 8, (pH - 8) / 2); g.clip();
      g.fillStyle = OUT; g.fillRect(pX + 4, pY + 4, pW - 8, pH - 8);
      g.fillStyle = hpCol; g.fillRect(pX + 4, pY + 4, (pW - 8) * fill, pH - 8);
      g.restore();
      g.strokeStyle = OUT; g.lineWidth = 4;
      g.beginPath(); rr(pX + 2, pY + 2, pW - 4, pH - 4, pH / 2 - 2); g.stroke();
    }

    // ---- reload line: you and your team only ----
    // Drawn after the health bar so a shell that lands mid-reload cannot paint
    // over it. Enemies get no reload line at all -- this is the plate telling
    // YOU about YOUR side's guns, not a readout of the enemy's.
    if(isAlly){
      const info = (typeof this.reloadInfo === 'function') ? this.reloadInfo() : null;
      const total = info && info.total > 0 ? info.total : 0;
      const left = info ? Math.max(0, info.left) : 0;
      const active = !!(info && info.active && total > 0);
      /* The eased value from _stepHpBar when it exists, so the line glides rather
         than stepping once per repaint. Recomputed raw on the first frame and on
         any plate that is never stepped (a menu preview), so this is never
         undefined. */
      /* IT STAYS FULL WHEN THE GUN IS LOADED. This line is a "gun ready" light,
         not a countdown: it fills as the tank reloads and then REMAINS full until
         it fires again, at which point it empties and starts refilling. Reading
         it the other way round -- empty whenever the gun is loaded -- made the
         steady state look identical to "just took a shell", which is the one
         state you most want to be able to tell apart at a glance.

         Magazine tanks are covered by the same rule for the right reason: firing
         a single round does not set reloadLeft, only running the magazine dry
         does, so mid-magazine the gun really is loaded and the line really is
         full. It only drains on the magazine reload. */
      const rRaw = active ? Math.max(0, Math.min(1, 1 - left / total)) : 1;
      const rPct = (this._rlDisp === undefined) ? rRaw : this._rlDisp;

      const rX = pX, rY = rlY, rW = pW;
      const rPx = rX + 2.5, rPy = rY + 2.5, rPw = rW - 5, rPh = rlH - 5;
      /* rr() here is the local helper declared at the top of _drawHp, whose
         signature is (x, y, w, h, r) and which closes over g itself. Passing g
         as a first argument -- the signature HPBarStyles uses internally --
         throws inside roundRect, which aborts _drawHp before the texture is
         flagged for upload: the canvas then looks correct when read back
         directly but the plate on screen never updates. */
      g.save();
      g.beginPath(); rr(rPx, rPy, rPw, rPh, rPh / 2); g.clip();
      // track: a warmer, darker brown than the health bar's navy, so the two
      // bars never read as one component
      g.fillStyle = '#33220f'; g.fillRect(rPx, rPy, rPw, rPh);
      g.fillStyle = '#241705'; g.fillRect(rPx, rPy + rPh * 0.6, rPw, rPh * 0.4);
      if(rPct > 0.002){
        const w = rPw * rPct;
        g.fillStyle = '#c2660a'; g.fillRect(rPx, rPy, w, rPh);
        g.fillStyle = '#f0a03c'; g.fillRect(rPx, rPy, w, rPh * 0.44);
        g.fillStyle = '#8f4706'; g.fillRect(rPx, rPy + rPh * 0.82, w, rPh * 0.18);
      }
      g.restore();
      g.strokeStyle = OUT; g.lineWidth = 3;
      g.beginPath(); rr(rPx - 1, rPy - 1, rPw + 2, rPh + 2, (rPh + 2) / 2); g.stroke();
    }

    if(this._hpTex) this._hpTex.needsUpdate = true;
  }

  // Per-frame health-bar animation: smooth fill, lagging "lost health" ghost,
  // white hit flash and a low-HP pulse. Only redraws while something moves.
  _stepHpBar(now){
    if(!this._hpCanvas) return;
    this._hpStepped = true;
    if(!this._hpLast){ this._hpLast = now; return; }
    let dt = (now - this._hpLast) / 1000;
    this._hpLast = now;
    if(!(dt > 0)) return;
    if(dt > 0.1) dt = 0.1;
    if(!this.hpSprite || !this.hpSprite.visible) return;

    const target = Math.max(0, Math.min(1, this.hp / this.maxHp));
    if(this._hpDisp === undefined){ this._hpDisp = target; this._hpGhost = target; this._hpFlash = 0; }

    let dirty = false;
    // Fire the hit flash once per damage event (compare against the previous
    // target, not the animating value, or it would stay lit the whole time the
    // bar is draining).
    if(this._hpPrevTarget === undefined) this._hpPrevTarget = target;
    if(target < this._hpPrevTarget - 0.0015){ this._hpFlash = 1; dirty = true; }
    this._hpPrevTarget = target;

    const d0 = this._hpDisp, g0 = this._hpGhost;
    this._hpDisp  = d0 + (target - d0) * Math.min(1, dt * 14);
    this._hpGhost = g0 + (target - g0) * Math.min(1, dt * 3.2);
    if(Math.abs(this._hpDisp - target) < 0.002) this._hpDisp = target;
    if(Math.abs(this._hpGhost - target) < 0.002) this._hpGhost = target;
    if(this._hpDisp !== d0 || this._hpGhost !== g0) dirty = true;

    if(this._hpFlash > 0){ this._hpFlash = Math.max(0, this._hpFlash - dt * 3.4); dirty = true; }

    if(this._hpDisp > 0 && this._hpDisp <= 0.25){
      this._hpPulse = (this._hpPulse || 0) + dt * 7;
      dirty = true;
    }

    /* THE RELOAD LINE HAS TO COUNT DOWN SMOOTHLY TOO, so it has to mark the
       plate dirty while it is running or it would only repaint on the next
       damage event -- which for a tank that is not being shot at means the line
       would sit frozen at whatever it was when the last shot was fired.

       Eased toward the true value rather than snapped, for the same reason the
       health fill is: a hard step every frame reads as a stutter. The 20Hz cap
       below still applies, so a reloading tank costs exactly what a draining
       health bar costs and no more. */
    let ally = false;
    try {
      const lt = window._game && window._game.localTank;
      if(lt) ally = (this === lt) ||
                    (lt.team && this.team && lt.team === this.team) ||
                    (lt.allyId && lt.allyId === this.id);
    } catch(e){}
    if(ally){
      const info = (typeof this.reloadInfo === 'function') ? this.reloadInfo() : null;
      const total = info && info.total > 0 ? info.total : 0;
      /* 1 when the gun is loaded, so the line fills as it reloads and STAYS full
         afterwards. See the matching note in _drawHp. */
      const targetR = (info && info.active && total > 0)
        ? Math.max(0, Math.min(1, 1 - Math.max(0, info.left) / total))
        : 1;
      if(this._rlDisp === undefined) this._rlDisp = targetR;
      const r0 = this._rlDisp;
      this._rlDisp = r0 + (targetR - r0) * Math.min(1, dt * 12);
      if(Math.abs(this._rlDisp - targetR) < 0.003) this._rlDisp = targetR;
      if(this._rlDisp !== r0) dirty = true;
    }

    if(dirty){
      /* Every redraw repaints a 360x100 canvas AND re-uploads that canvas to
         the GPU. In a firefight twenty tanks drain at once and that turned
         into ~7 uploads every single frame — the single biggest cost of a
         busy battle (measured: it was 45% of the whole frame). A health bar
         reads perfectly well at 20 redraws a second instead of 60, and each
         tank starts on a different phase so they never bunch up. */
      this._hpAcc = (this._hpAcc === undefined ? -(this._hpPhase * 0.01) : this._hpAcc) + dt;
      if(this._hpAcc >= 0.05){ this._hpAcc = 0; this._drawHp(); }
    }
  }

  _makeDrownBar(){
    const c = document.createElement('canvas'); c.width=256; c.height=16;
    this._dbCtx = c.getContext('2d');
    this._dbTex = new THREE.CanvasTexture(c);
    this._dbTex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({map:this._dbTex, depthTest:false, transparent:true, toneMapped:false, fog:false}));
    spr.scale.set(3.4, 0.21, 1);
    spr.userData.isOverlay = true;
    spr.visible = false;
    return spr;
  }
  _drawDrownBar(pct){
    const g = this._dbCtx;
    g.clearRect(0,0,256,16);
    g.fillStyle='rgba(0,0,0,0.6)'; g.fillRect(8,0,240,14);
    g.fillStyle='#44aaff'; g.fillRect(11,2,234*Math.min(1,pct),10);
    this._dbTex.needsUpdate = true;
  }

  _makeNameTag(text){
    const c = document.createElement('canvas'); c.width=256; c.height=64;
    const g = c.getContext('2d');
    g.fillStyle='rgba(0,0,0,0.5)'; g.fillRect(0,18,256,30);
    g.font='bold 22px Segoe UI'; g.fillStyle='#fff'; g.textAlign='center'; g.textBaseline='middle';
    g.fillText(text, 128, 33);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({map:tex, depthTest:false, transparent:true, toneMapped:false, fog:false}));
    spr.scale.set(3.2, 0.8, 1);
    return spr;
  }

  attach(scene){ this.scene = scene; scene.add(this.root); }
  detach(){
    this.clearTrails();
    /* `_showcase` tanks are never in a scene: the results screen parents them to
       a turntable group instead, so there is nothing to unhook here. Without
       this guard detach() would try to remove root from a scene it was never
       added to, do nothing, and leave dispose() freeing objects the graph still
       references. */
    if(this.scene){ this.scene.remove(this.root); this.scene=null; }
    this._removePhysBody();
  }

  /* ------------------------------------------------------------------------
     FREE EVERYTHING THIS TANK OWNED.

     detach() only unhooks the tank from the scene graph. That is enough to make
     it stop drawing, but the GPU objects it allocated stay alive for the life
     of the page: three.js keeps a strong reference to every geometry, material
     and texture it has ever seen, and only drops them when dispose() is called.

     Each tank allocates several of its own — a nameplate canvas texture, a
     damage bar texture, a view-range ring, a strike ring, a reload ring, plus
     a clone of every model material used to tint it. Ten tanks per match, and
     that is ten sets of GPU allocations per match, forever. Four matches in,
     the profiler showed 4,710 geometries loaded against 626 actually in the
     scene: roughly 4,000 objects belonging to tanks that died several rounds
     ago. On a browser tab that is a slow slide into the renderer running out
     of memory, which is exactly the kind of failure that looks like "the game
     got worse the longer I play".

     Model GEOMETRY is deliberately not disposed. Geometries come from
     Models._cache and are shared by every tank of that class -- disposing one
     tank's geometry would blank the next tank's hull. Only geometry this tank
     built for itself is freed. Textures created by the texture budget are
     likewise shared with the cached original, so they are left alone; the
     per-tank canvases below are not shared with anything.
     ------------------------------------------------------------------------ */
  dispose(){
    // Detach first, so nothing is being drawn while this runs.
    try { this.detach(); } catch(e){}

    const seenGeo = new Set();
    const kill = (o) => {
      if(!o) return;
      const geo = o.geometry;
      if(!geo || seenGeo.has(geo)) return;
      seenGeo.add(geo);
      /* Model geometry belongs to Models._cache and is shared by every tank of
         this class. Freeing it empties the GPU buffers under all of them and
         three.js re-uploads the whole model on the next match -- so a session
         becomes a slow series of re-downloads. Only geometry this tank built
         for itself is disposed here. */
      try {
        if(typeof Models !== 'undefined' && Models.isCachedGeometry
           && Models.isCachedGeometry(geo)) return;
        geo.dispose();
      } catch(e){}
    };
    const killTree = (root) => {
      if(!root || !root.traverse) return;
      root.traverse(o => {
        kill(o);
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for(const m of mats){
          if(!m) continue;
          /* A material shared with the cached original must survive too, or the
             next tank to spawn gets a disposed material and renders black. */
          try {
            if(m.userData && m.userData.sharedWithCache) continue;
            m.dispose();
          } catch(e){}
        }
      });
    };

    /* The model's own materials are per-tank CLONES (tint() clones them to apply
       the tank colour), so they are safe to dispose -- unlike the geometry they
       point at, which is why killTree skips geometry shared with the cache. */
    killTree(this.root);

    // Owned rings and overlays.
    for(const k of ['viewCircle','_strikeRing','_reloadBoostRing']){
      if(this[k]){ kill(this[k]);
        if(this[k].material){ try { this[k].material.dispose(); } catch(e){} }
        this[k] = null;
      }
    }

    /* The nameplate and damage bar are per-tank CanvasTextures. These are the
       big ones: the nameplate is authored at devicePixelRatio scale, so on a
       hi-DPI screen it is a genuine multi-megabyte bitmap, times every tank in
       the match. */
    for(const k of ['_hpTex','_dbTex','_hpCanvas']){
      if(this[k]){ try { if(this[k].dispose) this[k].dispose(); } catch(e){} this[k] = null; }
    }
    if(this.hpSprite){ this.hpSprite.material = null; this.hpSprite = null; }
    if(this._dbSprite){ this._dbSprite.material = null; this._dbSprite = null; }
    if(this._drownBar){ this._drownBar.material = null; this._drownBar = null; }

    // Outline hulls hold pooled materials shared with every other tank.
    this._outlineList = null;
    if(this.brain){ this.brain = null; }
    this.root = null;
    this._disposed = true;
  }

  _removePhysBody(){
    if(this._physBody && this._physWorld){
      try { this._physWorld.removeRigidBody(this._physBody); } catch(e){}
      this._physBody = null;
    }
  }

  /* HITBOX = THE MODEL YOU SEE.

     The collider used to come from def.body (or the editor override) x 0.55 x
     GLOBAL_SCALE. The editor overrides are already in world units, so they came
     out doubled -- Cool Buddy's box was 18 x 22 around an 8 x 10 hull, which is
     the invisible thing that shoved other tanks away -- and the box only rose
     1-3 units above the hull centre while the guns fire from 4-8 units up, so
     shells sailed over it and only the 2D fallback ever registered a hit.

     Measured once the model has loaded: the HULL's footprint (bodyGroup, in its
     own frame, so the heading does not matter) for width and length, and from
     the hull's underside up to the TURRET's top for height. The barrel is left
     out of the footprint on purpose -- it swings with the turret, and a box
     that grew whenever the gun pointed sideways would be a new invisible wall.
     The collider is offset to the measured centre, since models are rarely
     authored around their body origin. hitTest2D reads the same numbers. */
  _fitHitboxToModel(){
    if(this._disposed || !this.bodyGroup || !this.root) return;
    const box = new THREE.Box3(), tmp = new THREE.Box3(), m = new THREE.Matrix4();
    this.root.updateMatrixWorld(true);
    /* Each part is measured in its OWN group's frame, so the tank's tilt while
       it settles from the spawn drop and the visual's lag behind the heading
       while it turns cannot skew the numbers. */
    const measure = (group, into) => {
      const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
      group.traverse(o => {
        if(!o.isMesh || !o.geometry || o.isSprite) return;
        for(let p = o; p && p !== group; p = p.parent){ if(!p.visible) return; }
        if(!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        if(!o.geometry.boundingBox || o.geometry.boundingBox.isEmpty()) return;
        tmp.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld));
        into.union(tmp);
      });
    };
    const tBox = new THREE.Box3();
    measure(this.bodyGroup, box);
    if(this.turretGroup) measure(this.turretGroup, tBox);
    if(box.isEmpty()) return;
    /* bodyGroup's frame is the physics frame turned by the model's yaw fix
       (Striker is authored sideways, Demolisher and Burst backwards). Those
       fixes are quarter turns, so the difference is rounded to one -- the few
       degrees the visual lags behind a turning hull drop out -- and the box is
       turned into the physics frame, where the collider lives. */
    const bq = new THREE.Quaternion();
    this.bodyGroup.getWorldQuaternion(bq);
    const bYaw = new THREE.Euler().setFromQuaternion(bq, 'YXZ').y;
    const quarter = Math.round(Math.atan2(Math.sin(bYaw - (this.heading || 0)), Math.cos(bYaw - (this.heading || 0))) / (Math.PI / 2));
    if(quarter) box.applyMatrix4(m.makeRotationY(quarter * Math.PI / 2));
    const topY = tBox.isEmpty() ? box.max.y : Math.max(box.max.y, tBox.max.y);
    const hw = (box.max.x - box.min.x) / 2, hl = (box.max.z - box.min.z) / 2;
    const hh = (topY - box.min.y) / 2;
    /* A model that measured as nonsense (a stray giant helper mesh, an empty
       placeholder) keeps the old box rather than becoming a 100-unit wall. */
    if(!(hw > 0.3 && hl > 0.3 && hh > 0.2) || hw > 20 || hl > 20 || hh > 15) return;
    this.colHalfW = hw; this.colHalfL = hl; this.colHalfH = hh;
    this.colOffX = (box.max.x + box.min.x) / 2;
    this.colOffY = (topY + box.min.y) / 2;
    this.colOffZ = (box.max.z + box.min.z) / 2;
    if(this._physBody && this._physWorld && typeof RAPIER !== 'undefined'){
      try {
        if(this._physCollider) this._physWorld.removeCollider(this._physCollider, true);
        const col = RAPIER.ColliderDesc.cuboid(hw, hh, hl)
          .setTranslation(this.colOffX, this.colOffY, this.colOffZ)
          .setDensity(this.mass / (hw * 2 * hh * 2 * hl * 2))
          .setRestitution(0.15)
          .setFriction(0.7);
        this._physCollider = this._physWorld.createCollider(col, this._physBody);
        if(typeof this._physCollider.setActiveEvents === 'function'){
          this._physCollider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        }
        this._physCollider.userData = {type:'tank', tank:this};
        this._lastFriction = -1;
      } catch(e){ console.warn('[tank] hitbox refit failed:', e); }
    }
  }

  makeViewRangeCircle(){
    const w = this.def;
    const viewRange = (w.viewRange || 70) * 2;
    const wf = Menu && Menu.settings ? Menu.settings.viewRangeWidth : 0.5;
    const innerR = viewRange * (1 - wf * 0.4);
    const geo = new THREE.RingGeometry(Math.max(0.1, innerR), viewRange, 64);
    geo.rotateX(-Math.PI/2);
    const mat = new THREE.MeshBasicMaterial({color:0xffffff, transparent:true, opacity:0.25, side:THREE.DoubleSide, depthWrite:false});
    this.viewCircle = new THREE.Mesh(geo, mat);
    this.viewCircle.position.y = 0.2;
    this.root.add(this.viewCircle);
    return this.viewCircle;
  }

  refreshViewRangeWidth(){
    if(!this.viewCircle) return;
    const wf = Menu && Menu.settings ? Menu.settings.viewRangeWidth : 0.5;
    const viewRange = (this.def.viewRange || 70) * 2;
    const innerR = viewRange * (1 - wf * 0.4);
    this.viewCircle.geometry.dispose();
    this.viewCircle.geometry = new THREE.RingGeometry(Math.max(0.1, innerR), viewRange, 64);
    this.viewCircle.geometry.rotateX(-Math.PI/2);
  }

  setViewRangeStyle(opacity, color){
    if(!this.viewCircle) return;
    this.viewCircle.material.opacity = opacity;
    this.viewCircle.material.color.set(color);
  }

  setInput(input){ this._input = input; }

  _readPhysicsState(){
    if(!this._physBody) return;
    try {
      var p = this._physBody.translation();
      this.x = p.x;
      this.z = p.z;
      if(this._allowFall) this.y = p.y;
      var vel = this._physBody.linvel();
      this.vx = vel.x;
      this.vz = vel.z;
      this._vy = vel.y;
      var q = this._physBody.rotation();
      this.heading = Math.atan2(2*(q.w*q.y + q.x*q.z), 1 - 2*(q.y*q.y + q.z*q.z));
      const fwdX = Math.sin(this.heading);
      const fwdZ = Math.cos(this.heading);
      this.speed = vel.x * fwdX + vel.z * fwdZ;
    } catch(e){}
  }

  _updateSlopePhysics(dt){
    if(!this._allowFall || !this._physBody || !this._physWorld) return;
  }

  update(dt, world, game){
    /* The frame's own delta, published for _updateLean. Timing the lean off a
       wall clock instead made it wrong whenever the browser throttled a frame
       or the tab was hidden — the hull would then barely move at all. */
    this._frameDt = dt;
    this._frameToken = (this._frameToken || 0) + 1;
    if(this._animMixer) this._animMixer.update(dt);
    this._updateTrails(dt, game);
    this._updateRibbons(dt);
    this._updateTracks(dt);
    /* The hit flash, ticked here so it decays in wall-clock time like every
       other per-tank effect. Driven from update() rather than from the VFX
       layer so it keeps working with particles switched off -- the low graphics
       option still needs to show that a shot connected. */
    this._updateFlash(dt);
    if(this.dying){
      this._updateDeath(dt, game);
      return;
    }
    if(!this.alive) return;

    if(this.netDriven){
      // Position/heading come from host snapshots (interpolated every frame);
      // skip local movement integration so snapshots don't fight the sim.
      this._netSmoothTick();
      /* A net-driven tank does NOT run its own overlap test.

         The host already computed cover and shipped camoFactor in the snapshot
         (see snapshot()/applySnapshot()), and applySnapshot has just written it.
         Recomputing here would let the client's own view of the foliage override
         the host's, which is precisely the "two clients, two worlds" bug the
         shared snapshot exists to prevent -- the local player would see a tank
         it cannot shoot at, or miss one it can.

         So only the HOST-authored tank works out its own cover; everyone else
         is told. */
      if(this.isLocal){
        this._updateCover(world, dt);
      } else {
        this.coverOverlap = (this.camoFactor <= 0) ? 1 : 0;
      }
      this._applyCamoVisual();
      this._syncTransform();
      return;
    }

    if(this._physBody){
      this._readPhysicsState();
    }

    const d = this.def;
    const inp = this._input || {};

    this._tickFieldRepairs(dt);
    this._updateCover(world, dt);
    this._applyCamoVisual();

    this.drifting = false;
    const hasTurn = !!inp.turn && Math.abs(inp.turn) > 0.001;
    const kmh = Math.abs(this.speed) * CONFIG.U_TO_KMH;
    // Drift needs genuine momentum: pass the hard speed floor AND a fraction
    // of this tank's own top speed, so heavy/slow tanks must be near their
    // max before traction breaks.
    const driftCap = d.speed * (1 - Math.min(0.35, (this.mass-18)/120));
    const hasMomentum = Math.abs(this.speed) >= driftCap * (CONFIG.DRIFT_MIN_SPEED_FRAC != null ? CONFIG.DRIFT_MIN_SPEED_FRAC : 0.6);
    if(inp.handbrake && kmh >= CONFIG.DRIFT_MIN_KMH && hasMomentum && hasTurn){
      this.drifting = true;
    }

    const effThrottle = this.drifting ? 0 : (inp.throttle||0);
    const speedCap = d.speed * (1 - Math.min(0.35, (this.mass-18)/120))
      /* Overdrive (upgrade tree): +30% top speed for a few seconds after a kill. */
      * ((this._overdriveUntil && performance.now() < this._overdriveUntil) ? 1.3 : 1);
    /* ONE REVERSE FACTOR, READ INSTEAD OF WRITTEN.

       The old code carried a literal 0.5 in two places, and the two were not
       even the same decision. This line set the TARGET — the speed the throttle
       is asking for — and the clamp sixteen lines below capped the RESULT at
       `speedCap * 0.5` regardless of what the throttle asked for. So the target
       said "reverse at half" and the clamp said "never faster than half", and
       changing one of them changed nothing for the live physics path. They are
       now one constant, read from the same place, so the number a designer
       edits in config.js is the number both the physics body and the fallback
       integrator actually use. */
    const REVERSE_FRAC = 1 / ((CONFIG && CONFIG.REVERSE_SPEED_PENALTY) || 1.5)
      /* Reverse speed upgrades add whole km/h on top of the fraction: converted
         to a cap fraction here so the physics change scales with the tank. */
      + (this.upStats && this.upStats.reverseKmh
          ? this.upStats.reverseKmh / Math.max(6, (this.def && this.def.speed) || 22)
          : 0);
    const target = effThrottle * speedCap * (effThrottle < 0 ? REVERSE_FRAC : 1);

    if(this._physBody){
      const fwdX = Math.sin(this.heading);
      const fwdZ = Math.cos(this.heading);
      var speedDeficit = target - this.speed;
      speedDeficit = Math.max(-speedCap * 2, Math.min(speedCap * 2, speedDeficit));
      const reversing = target < 0 && this.speed > 0;
      var slopeMul = this._allowFall ? 2.5 : 1.0;
      const accel = d.accel * slopeMul * (reversing ? 3 : 1);
      const maxDelta = accel * dt;
      var clampedDeficit = Math.max(-maxDelta, Math.min(maxDelta, speedDeficit));
      var desiredSpeed = this.speed + clampedDeficit;
      desiredSpeed = Math.max(-speedCap * REVERSE_FRAC, Math.min(speedCap, desiredSpeed));
      const curVel = this._physBody.linvel();
      const newVelX = fwdX * desiredSpeed;
      const newVelZ = fwdZ * desiredSpeed;
      /* IMPACT PHYSICS: the drive's own velocity, then whatever a shell or a
         blast shoved in earlier in the frame. Added AFTER this loop's write —
         the whole reason pushImpact routes through _extVX/_extVZ instead of
         setting the body's linvel directly, where the next frame would erase
         it. The hop is the blast's one-shot vertical pop and is consumed here:
         after this write it is spent. */
      const _extX = this._extVX || 0, _extZ = this._extVZ || 0;
      this._tmpLinvel.x = newVelX + _extX;
      this._tmpLinvel.y = curVel.y + (this._hopOnce || 0);
      this._tmpLinvel.z = newVelZ + _extZ;

      if(this._allowFall){
        const pitchAngle = this._tmpEuler ? this._tmpEuler.x : 0;
        const isOnGround = this._airborneTimer != null ? this._airborneTimer < 0.05 : true;
        if(isOnGround && Math.abs(pitchAngle) > 0.03 && Math.abs(effThrottle||0) > 0.1){
          const slopeAssist = (effThrottle > 0 ? 1 : -1) * Math.sin(pitchAngle) * 12;
          this._tmpLinvel.x += fwdX * slopeAssist * dt;
          this._tmpLinvel.z += fwdZ * slopeAssist * dt;
        }
      }

      this._physBody.setLinvel(this._tmpLinvel, true);
      /* The shove was spent into the body above; decay the residual so the
         slide dies on its own schedule instead of being erased by the next
         frame's drive write. exp(-rate·t) is frame-rate independent, and below
         the noise floor it is zeroed outright so the buffer never holds a
         permanent half-unit nudge. */
      this._hopOnce = 0;
      if(_extX || _extZ){
        const dcy = Math.exp(-(((CONFIG && CONFIG.IMPULSE_EXT_DECAY) != null) ? CONFIG.IMPULSE_EXT_DECAY : 3.5) * dt);
        this._extVX = Math.abs(_extX * dcy) < 0.02 ? 0 : _extX * dcy;
        this._extVZ = Math.abs(_extZ * dcy) < 0.02 ? 0 : _extZ * dcy;
      }
      const turnRate = this.drifting ? d.turn * CONFIG.DRIFT_TURN_BOOST : d.turn;
      /* TURNING UNDER LOAD -- a wide arc at speed, with a floor.

         The velocity vector is rewritten to lie along `heading` every frame,
         so the tank's ability to change direction is entirely a question of how
         fast `heading` rotates. At the full turn rate a tank pivots in place
         whether it is parked or at full throttle, which is why nothing about the
         handling feels like it has weight.

         Grip falls off linearly with speed and is then clamped, so the hull
         still turns at 0 km/h, turns noticeably wider the faster it goes, and
         never drops below TURN_SPEED_MIN_GRIP -- a tank at full speed is harder
         to turn, not impossible to turn.

         Drift is exempt: the handbrake is the player asking for rotation
         directly, and it already has its own boost and its own low velocity
         retention. Applying a speed penalty on top of that would make the
         handbrake weaker the faster you were going, which is backwards. */
      const _spdFrac = speedCap > 0.001 ? Math.min(1, Math.abs(this.speed) / speedCap) : 0;
      const _grip = Math.max(
        (CONFIG && CONFIG.TURN_SPEED_MIN_GRIP) != null ? CONFIG.TURN_SPEED_MIN_GRIP : 0.35,
        1 - ((CONFIG && CONFIG.TURN_SPEED_PENALTY) || 0) * _spdFrac);
      const effectiveTurn = turnRate * (this.drifting ? 1 : _grip);
      const targetAngVel = hasTurn ? inp.turn * effectiveTurn : 0;
      const curAng = this._physBody.angvel();
      /* IMPACT PHYSICS: a hit is not just a slide — the shell's sideways
         component whips the nose. Arrives as _extWobble from pushImpact,
         decays below and is zeroed once it is under the noise floor. */
      this._tmpAngvel.x = curAng.x;
      this._tmpAngvel.y = targetAngVel + (this._extWobble || 0);
      this._tmpAngvel.z = curAng.z;
      this._physBody.setAngvel(this._tmpAngvel, true);
      if(this._extWobble){
        const wdcy = Math.exp(-(((CONFIG && CONFIG.IMPULSE_WOBBLE_DECAY) != null) ? CONFIG.IMPULSE_WOBBLE_DECAY : 5.0) * dt);
        this._extWobble = Math.abs(this._extWobble * wdcy) < 0.01 ? 0 : this._extWobble * wdcy;
      }

      if(this._allowFall){
        const throttle = effThrottle || 0;
        const curVelY = curVel.y;
        const horizSpeed = Math.hypot(curVel.x, curVel.z);
        const speedFrac = Math.min(1, Math.abs(this.speed) / Math.max(1, speedCap * 0.3));

        if(!this._airborneTimer) this._airborneTimer = 0;
        const falling = curVelY < -2.5;
        const rising = curVelY > 2.5;
        if(falling || rising) this._airborneTimer += dt;
        else this._airborneTimer = Math.max(0, this._airborneTimer - dt * 4);

        const grounded = this._airborneTimer < 0.05;

        if(!grounded){
          const extraDown = Math.min(18, Math.abs(curVelY) * 1.5 + 6);
          /* Falling runs at twice the speed WITHOUT touching world gravity.
             Gravity is what plants the tanks — turning it up would change how
             they drive — so the extra pull is added here instead. The engine
             still applies its own gravity during the step (g·dt), so we
             pre-apply g + 2·extraDown: the tank ends up with exactly twice the
             usual downward change each step, and no more once it is settled. */
          const g = Math.abs((this._physWorld && this._physWorld.gravity && this._physWorld.gravity.y) || -12);
          this._tmpLinvel.y = curVel.y - (g + extraDown * 2) * dt;
          this._physBody.setLinvel(this._tmpLinvel, true);
        }

        if(!grounded && this._airborneTimer > 0.3 && Math.abs(curVelY) < 8){
          const pitchTorque = -throttle * 1.2 * Math.min(1, horizSpeed / Math.max(1, speedCap));
          this._tmpAngvel.x = curAng.x + pitchTorque * dt;
          this._tmpAngvel.x = Math.max(-Math.PI*0.18, Math.min(Math.PI*0.18, this._tmpAngvel.x));
          this._tmpAngvel.z = curAng.z * Math.max(0, 1 - 2.5 * dt);
        } else {
          const accelKick = (grounded && Math.abs(throttle) > 0.5 && speedFrac < 0.4)
            ? throttle * (1 - speedFrac) * 0.6 : 0;
          this._tmpAngvel.x = curAng.x * Math.max(0, 1 - 10 * dt) + accelKick * dt;
          this._tmpAngvel.z = curAng.z * Math.max(0, 1 - 10 * dt);
        }
        this._physBody.setAngvel(this._tmpAngvel, true);
      }
      this._keepUpright(dt);
      var desiredFriction;
      if(this._allowFall){
        desiredFriction = 0.3;
      } else if(this.drifting){
        desiredFriction = 0.05;
      } else {
        desiredFriction = d.friction || 0.8;
      }
      if(this._lastFriction !== desiredFriction){
        this._physCollider.setFriction(desiredFriction);
        this._lastFriction = desiredFriction;
      }
    } else {
      if(this.speed < target){
        this.speed = Math.min(target, this.speed + d.accel * dt);
      } else if(this.speed > target){
        const noThrottle = Math.abs(effThrottle) < 0.08;
        // Flip into reverse instantly: reversing against forward motion
        // brakes hard so the tank swings backwards right away instead of
        // coasting to a stop and only then accelerating in reverse.
        const reversing = target < 0 && this.speed > 0;
        const brakeMul = reversing ? 10.0 : ((noThrottle && !this.drifting) ? 5.0 : 1.4);
        this.speed = Math.max(target, this.speed - d.accel * dt * brakeMul);
      }

      if(this.drifting){
        this.heading += inp.turn * d.turn * CONFIG.DRIFT_TURN_BOOST * dt;
      } else if(hasTurn){
        /* Same speed-dependent grip as the physics path above, so a tank driven
           without a rigid body handles identically to one that has one. Falling
           back to a different turning model because physics was unavailable is
           exactly the kind of thing that makes a bug unreproducible. */
        const _sf = speedCap > 0.001 ? Math.min(1, Math.abs(this.speed) / speedCap) : 0;
        const _gr = Math.max(
          (CONFIG && CONFIG.TURN_SPEED_MIN_GRIP) != null ? CONFIG.TURN_SPEED_MIN_GRIP : 0.35,
          1 - ((CONFIG && CONFIG.TURN_SPEED_PENALTY) || 0) * _sf);
        this.heading += inp.turn * d.turn * _gr * dt;
      }
      /* IMPACT PHYSICS, fallback path: pushImpact wrote the shove straight into
         vx/vz there (they are the velocity state here), but the yaw twitch
         still needs an integrator — same decay schedule as the body path, so
         the no-body drift mirrors the rigid-body one and the two cannot drift
         apart into different handling by accident. */
      if(this._extWobble){
        this.heading += this._extWobble * dt;
        const wdcy = Math.exp(-(((CONFIG && CONFIG.IMPULSE_WOBBLE_DECAY) != null) ? CONFIG.IMPULSE_WOBBLE_DECAY : 5.0) * dt);
        this._extWobble = Math.abs(this._extWobble * wdcy) < 0.01 ? 0 : this._extWobble * wdcy;
      }

      const fx = Math.sin(this.heading) * this.speed;
      const fz = Math.cos(this.heading) * this.speed;
      const alignRate = this.drifting ? 2 : 40;
      this.vx += (fx - this.vx) * Math.min(1, alignRate * dt);
      this.vz += (fz - this.vz) * Math.min(1, alignRate * dt);
      const frictionPerSec = this.drifting ? 0.65 : 0.25;
      this.vx *= Math.pow(frictionPerSec, dt);
      this.vz *= Math.pow(frictionPerSec, dt);
      const noThrottle = Math.abs(inp.throttle||0) < 0.08;
      if(noThrottle){
        this.vx *= Math.pow(0.001, dt);
        this.vz *= Math.pow(0.001, dt);
        if(Math.hypot(this.vx, this.vz) < 0.02){
          this.vx = 0; this.vz = 0; this.speed = 0;
        }
      }
      var nx = this.x + this.vx * dt;
      var nz = this.z + this.vz * dt;
      const inWater = !!(world && world.lakeAt(nx, nz));
      if(inWater){
        this.speed *= 0.5; this.vx *= 0.5; this.vz *= 0.5;
      }
      this._inWater = inWater;
      const r = Math.max(this.colHalfW, this.colHalfL);
      if(!world.collides(nx, this.z, r)) this.x = nx;
      else { this.speed *= 0.5; this.vx *= 0.4; }
      if(!world.collides(this.x, nz, r)) this.z = nz;
      else { this.speed *= 0.5; this.vz *= 0.4; }
      const lim = world.half - 3;
      this.x = Math.max(-lim, Math.min(lim, this.x));
      this.z = Math.max(-lim, Math.min(lim, this.z));
    }

    if(game) this._ramCheck(game);

    if(this._allowFall) this._updateSlopePhysics(dt);

    // Smoke from tracks when drifting (fancy only)
    if(this.drifting && game && game.isFancy){
      this._driftSmokeTimer = (this._driftSmokeTimer || 0) + dt;
      if(this._driftSmokeTimer >= 0.08){
        this._driftSmokeTimer = 0;
        const bw = this.def.body.w / 2 + 0.3, bl = this.def.body.l / 2;
        const perpX = Math.cos(this.heading), perpZ = -Math.sin(this.heading);
        for(let side=-1; side<=1; side+=2){
          const sx = this.x + perpX * bw * side + (Math.random() - 0.5) * 0.3;
          const sz = this.z + perpZ * bw * side + (Math.random() - 0.5) * 0.3;
          game.spawnExhaust(sx, 0.08, sz, this.heading + Math.PI * 0.5 * side, 20);
        }
      }
    }

    if(inp.turretWorldAngle != null){
      let diff = ((inp.turretWorldAngle - this.turretAngle) % (Math.PI*2) + Math.PI*3) % (Math.PI*2) - Math.PI;
      const maxStep = d.turretTurn * dt;
      diff = Math.max(-maxStep, Math.min(maxStep, diff));
      this.turretAngle += diff;
    }

    if(this.reloadLeft > 0) this.reloadLeft -= dt;

    if(this.superCdLeft > 0){
      /* Super charge rate recovers the meter FASTER (×1.10 per level) and the
         passive charge adds whole percent-of-total per second, so the bar
         crawls up by itself even while you sit behind cover. */
      const sp = this.upStats;
      let drain = dt * (sp ? sp.chargeMult : 1);
      if (sp && sp.passiveRate > 0) drain += dt * sp.passiveRate * this.superCdTotal;
      this.superCdLeft -= drain;
    }

    if(this.magReloadLeft > 0){
      this.magReloadLeft -= dt;
      if(this.magReloadLeft <= 0){
        this.magReloadLeft = 0;
        this.mag = d.magSize || 1;
        this.reloadLeft = 0;
      }
    }

    if(d.doubleBarrel && game && game.input && game.input.keys && game.input.keys['KeyG'] && !this._gPrev){
      this._doubleMode = this._doubleMode === 'single' ? 'double' : 'single';
      if(this.isLocal && typeof Menu !== 'undefined' && Menu.toast){
        Menu.toast('Mode: ' + (this._doubleMode === 'double' ? 'DOUBLE' : 'SINGLE'));
      }
    }
    this._gPrev = game && game.input && game.input.keys && game.input.keys['KeyG'];

    if(this.superState === 'windup'){
      this.superTimer -= dt;
      if(this.superTimer <= 0){
        this.superState = 'cloaked';
        this.superTimer = d.cloakMax || 10;
        this._applyCloakVisual(true);
      }
    } else if(this.superState === 'cloaked'){
      this.superTimer -= dt;
      if(this.superTimer <= 0){
        this.superTimer = 0;
        this.endCloak();
      }
    }

    if(d.shellType === 'flame'){
      const heatMult = d.overheatMult || 1;
      const overheatThreshold = 750;
      if(inp.fire && !this.overheated){
        this.heat += (1000 / 7.5) * heatMult * dt;
        if(this.heat >= overheatThreshold){
          this.heat = overheatThreshold;
          this.overheated = true;
        }
      } else if(this.overheated){
        this.heat -= 125 * dt;
        if(this.heat <= 0){ this.heat = 0; this.overheated = false; }
      } else {
        this.heat -= 500 * dt;
        if(this.heat <= 0){ this.heat = 0; }
      }
      if(this.barrelMat){
        const t = this.heat / overheatThreshold;
        const r = 0x16 + Math.round(t * 0xe9);
        const g = 0x2e - Math.round(t * 0x2e);
        const b = 0x2e - Math.round(t * 0x2e);
        this.barrelMat.color.setRGB(r/255, g/255, b/255);
        this.barrelMat.emissive.setRGB(t * 0.8, t * 0.15, 0);
        this.barrelMat.emissiveIntensity = t * 0.5;
      }
    }

    this._updateRecoil(dt);
    this._updateGunAssembly(dt);
    this._syncTransform();

    /* ============================================================================
       ARTILLERY CANNOT SHOOT INSIDE ITS OWN MINIMUM RANGE

       This is the World of Tanks artillery rule and it is the entire reason the
       Mortar has to fight like an artillery piece: you cannot point the barrel
       at something twelve metres away and hit it, however well aimed. The
       minimum range is larger than the splash radius, which also makes it
       geometrically impossible to land a shell on your own hull.

       The refusal lives HERE rather than in Game.spawnShot, and that placement
       is the whole point: by the time spawnShot runs, the reload timer has
       already been set on the line above. A shell turned down there would still
       have cost the tank its ten seconds, which would make a bot in a scrum
       sit useless for a full reload every time it thought it had a shot.

       Solved without the real muzzle position — the gate only reads `blocked`,
       which depends only on how far the cursor is, and the muzzle is a full
       world-matrix update away.
       ============================================================================ */
    this._artilleryBlocked = false;
    if(d.shellType === 'mortar' && game && game._mortarAim){
      const aim = game._mortarAim(this);
      if(aim && aim.blocked){
        this._artilleryBlocked = true;
        /* Once per press, not once per frame the button happens to be held. */
        if(inp.fire && !this._artilleryRefused){
          this._artilleryRefused = true;
          if(this.isLocal && typeof Menu !== 'undefined' && Menu.toast){
            Menu.toast('\u26A0 Too close \u2014 ' + Math.round(aim.minRange) + 'm minimum range');
          }
        }
      }
    }
    if(!inp.fire) this._artilleryRefused = false;

    if(this._burstRemaining > 0){
      this._burstTimer -= dt;
      if(this._burstTimer <= 0){
        this._burstTimer = d.burstDelay || 0.007;
        this._burstRemaining--;
        if(d.ejectShell && this._shellNode && game) game.ejectShell(this);
        if(game) game.spawnShot(this);
        if(this._burstRemaining <= 0){
          this.reloadLeft = d.reload;
          if(d.magSize){
            this.mag--;
            if(this.mag <= 0) this.magReloadLeft = d.magReload || d.reload;
          }
        }
      }
    } else if(inp.fire && !this._artilleryBlocked && this.reloadLeft <= 0 && this.magReloadLeft <= 0 && !this.overheated && (this.mag > 0 || !d.magSize)){
      if(this.superState === 'cloaked') this.endCloak();
      if(d.burstCount && d.burstCount > 1){
        this._burstRemaining = d.burstCount - 1;
        this._burstTimer = d.burstDelay || 0.007;
        if(d.ejectShell && this._shellNode && game) game.ejectShell(this);
        if(game) game.spawnShot(this);
      } else if(d.doubleBarrel && this._doubleMode === 'double'){
        this.reloadLeft = d.reload;
        if(d.magSize){
          this.mag -= 2;
          if(this.mag <= 0) this.magReloadLeft = d.magReload || d.reload;
        }
        if(d.ejectShell && this._shellNode && game) game.ejectShell(this);
        if(game) game.spawnShot(this);
        if(game) game.spawnShot(this);
      } else {
        this.reloadLeft = d.reload;
        if(d.magSize){
          this.mag--;
          if(this.mag <= 0) this.magReloadLeft = d.magReload || d.reload;
        }
        if(d.ejectShell && this._shellNode && game) game.ejectShell(this);
        if(game) game.spawnShot(this);
      }
    }
  }

  reloadInfo(){
    const d = this.def;
    if(this.magReloadLeft > 0) return { active:true, total:d.magReload||d.reload, left:Math.max(0,this.magReloadLeft), mag:0, magSize:d.magSize||0 };
    if(this.reloadLeft > 0 || d.magSize) return { active:this.reloadLeft > 0, total:d.reload, left:Math.max(0,this.reloadLeft), mag:this.mag, magSize:d.magSize||0 };
    return { active:false, total:d.reload, left:0, mag:1, magSize:0 };
  }

  /* ---------- Super abilities ---------- */

  hasSuper(){ return !!this.def.superType; }

  activateSuper(){
    /* 'done' is a finished super, not a running one. Nothing ever cleared it,
       so a super could be used ONCE per match and never again. */
    if(!this.hasSuper() || this.superCdLeft > 0 || (this.superState && this.superState !== 'done')) return false;
    const t = this.def.superType;
    if(t === 'airstrike'){
      this.superState = 'targeting';
      this.superTarget = null;
    } else if(t === 'cloak'){
      this.superState = 'windup';
      this.superTimer = this.def.cloakWindup || 3;
      this.superCdLeft = this.superCdTotal;
    } else if(t === 'bush'){
      this.superState = 'done';
      this.superCdLeft = this.superCdTotal;
      if(this._onBushSuper) this._onBushSuper();
    } else if(t === 'panzers'){
      this.superState = 'panzer_drop';
      this.superTimer = this.def.panzerDelay || 8;
      this.superCdLeft = this.superCdTotal;
    } else if(t === 'oil'){
      this.superState = 'oil_fill';
      this.superTimer = this.def.oilFill || 4;
      this.superCdLeft = this.superCdTotal;
    } else if(t === 'molotov'){
      this.superState = 'targeting';
      this.superTarget = null;
    } else if(t === 'landfield'){
      this.superState = 'targeting';
      this.superTarget = null;
    } else if(t === 'reload_boost'){
      this.superState = 'reload_boosting';
      this.superTimer = this.def.superDuration || 8;
      this.superCdLeft = this.superCdTotal;
    } else {
      this.superState = 'done';
      this.superCdLeft = this.superCdTotal;
    }
    return true;
  }

  cancelSuper(){
    if(this.superState === 'targeting'){
      this.superState = 'done';
      this.superTarget = null;
    }
  }

  endCloak(){
    if(this.superState !== 'cloaked') return;
    this.superState = 'done';
    this._applyCloakVisual(false);
  }

  superInfo(){
    return {
      type: this.def.superType || null,
      ready: this.superCdLeft <= 0,
      cdLeft: Math.max(0, this.superCdLeft),
      cdTotal: this.superCdTotal,
      state: this.superState,
      timer: Math.max(0, this.superTimer),
      cd: Math.max(0, this.superCdLeft),
    };
  }

  _applyCloakVisual(on){
    if(on) this._cloakedMats = [];
    const mats = this._cloakedMats;
    if(on && this.root && mats.length === 0){
      this.root.traverse(o => {
        if(o.isMesh && o.material && !o.userData.isOutline){
          mats.push(o.material);
        }
      });
    }
    mats.forEach(m => {
      if(Array.isArray(m)) return;
      m.transparent = !!on;
      m.opacity = on ? 0.25 : 1;
      m.depthWrite = !on;
    });
  }

  /* THE VISUAL HALF OF CAMOUFLAGE, AND WHAT IT DELIBERATELY DOES NOT TOUCH.

     camoFactor is already computed every frame and already means the right
     thing: 0 once at least half the footprint is under foliage, rising back
     toward 1 as the tank eases out. What was missing is that NOTHING ACTED ON
     IT — the model stayed fully drawn, so a tank deep in a bush was still
     plainly visible and only the bots believed it was hidden.

     So the two visual pieces are driven from it:

       * the model, hidden outright at camoFactor 0 (body and turret, so no
         part of it is left hanging in the air);
       * the nametag and health bar, faded with the same factor, so they fade
         out on the same curve rather than blinking.

     WHAT THIS DOES NOT TOUCH, ON PURPOSE:

       * the physics body, the collider, `alive`, the hitbox tests and the
         network snapshot. A hidden tank is still a solid tank that still
         blocks shots and still takes damage — you are blind, not invulnerable.
         That is the whole point of the feature, and it is why this is a
         visibility flag rather than a state change. Making it non-solid would
         turn every bush into a phase-through tunnel and quietly break the
         bots' line-of-fire, which is the one thing they use camoFactor for.

     Only ever called when camoFactor actually changes, so the traverse is not
     per frame per tank; the visibility flags themselves are idempotent. */
  _applyCamoVisual(){
    const op = this.camoFactor;
    const hidden = op <= 0;

    if(this.hpSprite){
      /* The nametag and bar are one canvas, so one fade covers both. Kept at a
         low floor rather than zero while only partly hidden, matching the
         partial-cover ramp the bots read. */
      this.hpSprite.material.opacity = op;
    }

    if(hidden !== this._camoHidden){
      this._camoHidden = hidden;
      const body = this.bodyGroup, turret = this.turretGroup;
      if(body) body.visible = !hidden;
      if(turret) turret.visible = !hidden;
      /* The nametag goes with it, hard, so nothing is left hovering over an
         empty patch of foliage to give the position away. */
      if(this.hpSprite) this.hpSprite.visible = !hidden;
    }
  }

  /* ============================================================================
     COVER, AND HOW IT GETS BROKEN

     One method for both the local and the net-driven path. Those two each used
     to carry their own copy of the hidingIn/camoFactor pair, which is how the
     two end up disagreeing -- a client is told it is hidden while the host
     thinks it is not, and the bot shooting it reasons about a different world
     than the one the player is looking at.

       coverOverlap  0..1, how much of the footprint is under foliage.
       camoFactor    0 when hidden, rising to 1 as cover is lost. This is what
                     the bots read and what the minimap already reads.
       camoState     'bush' / 'tree' / 'cloak' / null, for the HUD.

     camoFactor is deliberately not binary. A tank at 40% cover is neither
     hidden nor in the open, and pretending otherwise is what gave the old code
     a flat 0.3 for every possible amount of cover.

     SHAKING, AND WHY IT IS THE POINT

     Cover that cannot be broken is a place to stop, not a thing to drive
     through, so driving or firing while under foliage gives you away for
     COVER_REVEAL_TIME after you stop. This is the same event the tree-shake
     animation already plays when a tank rolls into a tree (the FOLIAGE block in
     Game._update) -- the reveal is that shake finally meaning something rather
     than a second unrelated rule stacked on top of it.

     The threshold is COVER_SHAKE_SPEED rather than zero so easing to a stop and
     firing does not betray you: you have to be genuinely rolling. */
  _updateCover(world, dt){
    if(!world){
      this.coverOverlap = 0;
      this.camoFactor = (this.superState === 'cloaked') ? 0 : 1;
      this.camoState = this.superState === 'cloaked' ? 'cloak' : null;
      return;
    }

    /* The footprint sampled is the COLLIDER, not the visual model. On some tanks
       the model is far larger than the hitbox (helix is 27.76 wide against a
       3.52 collider), and a tank that is only VISUALLY behind a tree has not
       actually put its body in it. */
    this.coverOverlap = world.coverOverlap(this, this.colHalfW, this.colHalfL);

    /* Cloak outranks cover: a cloaked Ghost is invisible whether or not it is
       also under a tree, and the HUD should say so. */
    if(this.superState === 'cloaked'){
      this.camoState = 'cloak';
      this.camoFactor = 0;
      this.coverRevealed = 0;
      return;
    }

    const HIDDEN = CONFIG.COVER_HIDE_FRACTION;
    const kind = this._coverKindOf(world);

    if(this.coverOverlap >= HIDDEN){
      const speed = Math.abs(this.speed || 0);
      const rolling = speed > CONFIG.COVER_SHAKE_SPEED ||
                      Math.hypot(this.vx || 0, this.vz || 0) > CONFIG.COVER_SHAKE_SPEED;
      /* FIRING GIVES YOU AWAY — AND THE COMPARISON IS A SUBTLE ONE.

         reloadLeft counts DOWN from def.reload to 0 (see the tick above), and 0
         means "loaded and ready". So "just fired" is reloadLeft NEAR def.reload,
         not below it. The original test read

             reloadLeft < def.reload - 0.001

         which is true for essentially the whole countdown — including the idle
         state where reloadLeft is 0 and the tank has not fired at all, since
         0 < def.reload for every tank with a reload time. So every stationary
         tank was treated as permanently mid-shot: coverRevealed was re-armed
         every single frame, the countdown below it never got to run, and
         camoFactor was pinned at its partial-cover floor of 0.25 instead of 0.

         That is why a tank sitting perfectly still in the middle of a bush was
         still drawn. Not a subtle half-hidden state — the hiding never happened
         at all, and it would never have happened for as long as the tank sat
         still, which is the one thing it has to do to stay hidden. */
      const firing = (this.def.reload != null) &&
                     (this.reloadLeft || 0) > (this.def.reload - CONFIG.COVER_FIRE_WINDOW);
      if(rolling || firing){
        /* Shake it, and it stays shaken for a moment after you stop -- otherwise
           the reveal flickers on and off with every wheel-speed wobble. */
        this.coverRevealed = CONFIG.COVER_REVEAL_TIME;
      } else if(this.coverRevealed > 0){
        this.coverRevealed = Math.max(0, this.coverRevealed - (dt || 0));
      }

      const hidden = this.coverRevealed <= 0;
      /* Partial cover climbs back toward 1 as the overlap falls off, so a tank
         easing out of a tree gets progressively easier to see. */
      const partial = 1 - (this.coverOverlap - HIDDEN) / Math.max(0.0001, 1 - HIDDEN);
      this.camoFactor = hidden ? 0 : Math.max(0.25, Math.min(1, partial));
      this.camoState = hidden ? null : kind;
    } else {
      this.coverRevealed = 0;
      this.camoFactor = 1;
      /* Report the cover a tank still has, so the bot AI and the HUD can tell
         "in the open" from "nearly hidden" -- the difference between a fair
         shot and a silly one. */
      this.camoState = this.coverOverlap > 0.05 ? kind : null;
    }
  }

  /* Which kind of plant is doing the hiding, for the HUD's wording. A tree is
     partial cover and a bush is full cover, so the label has to be right. */
  _coverKindOf(world){
    const pines = world._glbPines || [];
    const r = CONFIG.TREE_HIDE_RADIUS;
    const rr = r * r;
    for(let i = 0; i < pines.length; i++){
      const dx = this.x - pines[i].x, dz = this.z - pines[i].z;
      if(dx*dx + dz*dz <= rr) return 'tree';
    }
    return 'bush';
  }

  _ramCheck(game){
    /* Ram damage is DISABLED by design. The physics and the fallback collision
       code that used to live under this return was unreachable dead code —
       Firefox reported it every session as an "unreachable code after return
       statement" warning — so it is gone rather than kept on life support.
       Turn ramming back on by writing the new rules in front of the return. */
    this._unstack(game);
    return;
  }

  /* A TANK THAT GOES OVER COMES BACK ONTO ITS TRACKS.

     The hull is a free rigid body: a steep slope, a shove from another tank or
     a blast could roll it, and nothing ever rolled it back. On The Hill more
     than half of every match's tanks ended up on their backs, spinning in
     place (the steering still turns them about the world's vertical), where
     they could neither drive nor be expected to -- which is what looked like
     bots "unable to climb". Two layers:
       * past ~35 degrees of tilt a restoring spin pulls the hull upright, so
         ordinary slopes are untouched but a tip-over is caught early;
       * a hull that is on its side or back for 0.4 s is set back upright on
         the spot, heading kept. */
  _keepUpright(dt){
    const b = this._physBody;
    if(!b || this.netDriven || this.dying) return;
    let q;
    try { q = b.rotation(); } catch(e){ return; }
    const ux = 2 * (q.x * q.y - q.w * q.z);
    const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
    const uz = 2 * (q.y * q.z + q.w * q.x);
    if(uy > 0.82){ this._flipT = 0; return; }
    if(uy < 0.3){
      this._flipT = (this._flipT || 0) + dt;
      if(this._flipT < 0.4) return;
      this._flipT = 0;
      const half = this.heading * 0.5;
      const p = b.translation();
      b.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
      b.setTranslation({ x: p.x, y: p.y + 1.5, z: p.z }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      const lv = b.linvel();
      b.setLinvel({ x: lv.x * 0.3, y: 0, z: lv.z * 0.3 }, true);
      return;
    }
    /* Restoring spin about (up x worldUp) = (-uz, 0, ux), stronger the further
       over the hull is; existing roll/pitch spin is damped so it cannot fight it. */
    const k = 7 * (1 - uy);
    const av = b.angvel();
    b.setAngvel({ x: av.x * 0.6 - uz * k, y: av.y, z: av.z * 0.6 + ux * k }, true);
  }

  /* ANTI-STACKING. Tank colliders are plain boxes with real friction, so two
     hulls shoving nose to nose let one ride up onto the other's deck and park
     there — floating turrets, shells passing under the "hitbox", a tank that
     cannot drive because its tracks touch nothing. When this hull's centre is
     over another hull and clearly above it, slide it off sideways and down.
     Runs after the drive loop wrote its velocity, so it wins this step. */
  _unstack(game){
    if(!this._physBody || !this.alive || this.dying || !game || !game.tanks) return;
    let p, lv;
    try { p = this._physBody.translation(); lv = this._physBody.linvel(); } catch(e){ return; }
    /* Only a hull that is RESTING. Tanks drop in from spawn height in tight
       clusters; treating a falling tank above a neighbour as stacked shoved it
       sideways for the whole fall and threw most of the field off the map. */
    if(Math.abs(lv.y) > 1.5) return;
    const myH = this.colHalfH || 0.5;
    const myR = Math.max(this.colHalfW || 0, this.colHalfL || 0);
    for(const o of game.tanks){
      if(!o || o === this || !o.alive || o.dying || !o._physBody) continue;
      let op;
      try { op = o._physBody.translation(); } catch(e){ continue; }
      const oH = o.colHalfH || 0.5;
      const dy = p.y - op.y;
      // On top of it: clearly higher, and close enough vertically to be touching.
      if(dy < myH + oH * 0.6 || dy > myH + oH + 0.8) continue;
      const dx = p.x - op.x, dz = p.z - op.z;
      const d = Math.hypot(dx, dz);
      if(d >= myR + Math.max(o.colHalfW || 0, o.colHalfL || 0)) continue;
      const nx = d > 1e-3 ? dx / d : Math.cos(this.heading);
      const nz = d > 1e-3 ? dz / d : -Math.sin(this.heading);
      this._physBody.setLinvel({ x: lv.x + nx * 4, y: Math.min(lv.y, -2), z: lv.z + nz * 4 }, true);
      return;
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     IMPACT PHYSICS — the one place external forces get into the tank.

     THE PROBLEM THIS SOLVES
     update() rewrites the rigid body's linvel along `heading` every frame
     (newVelX = fwdX * desiredSpeed). A one-off knockback applied straight to
     the body is erased the next frame — which is why the shotgun knockback
     also has to nudge position by hand. So shell hits and explosions were
     pure U.I.: damage numbers with no mass behind them.

     pushImpact feeds an EXTERNAL velocity (_extVX/_extVZ), which is the one
     term the drive loop ADDS after its own write rather than overwrites, so
     a shove slides the hull until the decay scheduled in update() eats it.
     It also hands in a yaw twitch (_extWobble), added into the angular
     velocity the same way, so a hit visibly WHIPS the nose instead of only
     sliding it.

     Everything is gated on the actual body: a tank without a rigid body has
     no physics step to contradict, so the push goes straight into vx/vz.

     (dx, dz) is the push direction — shell travel direction, or radially
     OUTWARD from a blast centre. (dv) is the desired velocity change for an
     average 30t tank, already tuned by the caller from shell damage.
     opts.hop adds a one-shot upward kick for the next drive step (blasts pop
     the hull). Dead, dying and net-driven tanks are skipped: a net-driven
     hull takes its position from host snapshots, and applying an impulse to
     it would fight the snapshot every frame on both sides. */
  pushImpact(dx, dz, dv, opts){
    if(this.dying || !this.alive || this.netDriven) return;
    if(!isFinite(dv) || !dv) return;
    const len = Math.hypot(dx, dz);
    if(!(len > 1e-6)) return;
    const C = (typeof CONFIG !== 'undefined' && CONFIG) || {};
    /* Mass attenuation. 30t is the scale the callers tuned against; a 14t
       scout takes 2.1x and a 58t artillery 0.52x of the same hit. Max() floors
       the divisor so a freak 1t editor tank cannot multiply itself to orbit. */
    let v = dv * (30 / Math.max(12, this.mass || 30));
    v = Math.max(-(C.IMPULSE_DV_MAX || 4), Math.min(C.IMPULSE_DV_MAX || 4, v));
    const nx = dx / len, nz = dz / len;
    if(this._physBody){
      this._extVX = (this._extVX || 0) + nx * v;
      this._extVZ = (this._extVZ || 0) + nz * v;
      if(C.IMPULSE_WOBBLE){
        /* Which way the nose whips: the yaw cross product of forward and the
           shove. A hit on the left plate swings the hull one way, on the right
           plate the other — the sign falls out of the cross product. */
        const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
        this._extWobble = (this._extWobble || 0)
          + (fwdX * nz - fwdZ * nx) * v * (C.IMPULSE_WOBBLE || 0.25);
      }
      if(opts && opts.hop) this._hopOnce = Math.min(2.5, (this._hopOnce || 0) + opts.hop);
    } else {
      /* No body: the fallback integrator's vx/vz ARE the tank's velocity
         state (damped every frame by its own friction term), so a one-shot
         add is the correct shape there. */
      this.vx = (this.vx || 0) + nx * v;
      this.vz = (this.vz || 0) + nz * v;
    }
  }

  /** Scale sprites and outlines based on distance from camera */
  updateDistanceScaling(cameraPos, camDist){
    this._stepHpBar(performance.now());
    const dx = this.x - cameraPos.x;
    const dz = this.z - cameraPos.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    const target = Math.min(4.0, Math.max(0.6, 0.15 + dist * 0.035));
    this._uiScale += (target - this._uiScale) * 0.15;
    const s = this._uiScale;
    if(this.hpSprite){
      // Hold the plate's world HEIGHT at the original 4.5 x (360/110) = 1.375
      // units and derive width from the new 360x100 aspect, so the nickname
      // keeps its on-screen size even though it is now drawn larger in the
      // canvas. Fixed width would have shrunk the whole plate vertically.
      const h = 1.375 * s;
      this.hpSprite.scale.set(h * (this._hpAspect || (360/100)), h, 1);
    }
    if(this._drownBar) this._drownBar.scale.set(3.4 * s, 0.21 * s, 1);
    // Outline scales with zoom level only (camDist), not per-tank distance
    if(camDist){
      const outlineS = Math.min(1.8, Math.max(1.0, 0.4 + camDist * 0.01));
      const outlineScale = 1 + (outlineS - 1) * 0.2;
      this._applyOutlineScale(outlineScale);
    }
  }
  _applyOutlineScale(scale){
    /* Flat list, no traversal. The previous version walked bodyGroup and
       turretGroup every frame for every tank — with 10 tanks in a match that
       was 20 full subtree walks per frame, purely to find 2 hulls. The list is
       built once in _addOutline and never changes afterwards. */
    const list = this._outlineList;
    const target = OUTLINE_TANK * scale;

    /* Set the shared width FIRST, before any bail-out.

       There is exactly one outline material for the whole game, and not every
       outline is reachable from this tank's _outlineList: _batchPartGroup merges
       a tank's outlines into a single world-space mesh that it never registers.
       Returning early when the list is empty therefore left those merged
       outlines holding whatever width the material was constructed with --
       0.04 / modelScale, i.e. 0.0016 world units for Cool Buddy, which is
       invisible. Writing the uniform up front means a tank with no list
       entries, and a merged outline nobody tracks, still render at the right
       width.

       Cheap: one property write on one shared object per tank per frame. */
    Tank.outlineThickness(Tank._outlineMaterial(OUTLINE_TANK), target);

    if(!list || !list.length) return;
    /* Compacting pass.

       The list is built by _addOutline during model load, BEFORE the model is
       batched. Batching merges those source meshes into one and removes the
       originals — taking their outlines with them, because each outline was a
       CHILD of its own mesh. Those hulls are gone from the scene but were still
       sitting in the list: one tank measured 61 entries for 4 live outlines.
       Walking that every frame is 57 wasted property writes, and it grows with
       every extra source mesh a model has.

       An entry with no parent is detached and can never come back, so drop it
       and compact in place. Amortised O(1): the list is only rewritten when
       something was actually stale. */
    let live = 0;
    for(let i=0; i < list.length; i++){
      const o = list[i];
      if(!o.parent) continue;
      list[live++] = o;

      /* A BAKED outline had its transform folded into the vertices by
         _batchPartGroup, so it sits in world units with an identity local
         transform. Rescaling it would slide the hull off the surface, and the
         zoom width is already correct for it. Leave it completely alone --
         this is what previously made batched tanks (the ones with enough
         meshes to merge) look right while every other tank looked wrong. */
      if(o.userData && o.userData.isOutlineBaked){
        continue;
      }

      /* Position, rotation AND scale all stay identity so the hull sits exactly
         on its mesh. An earlier version left the scale holding 1/worldScale,
         on the theory that the hull had to cancel its parent's scale; with the
         view-space shader that made every hull shrink to world scale 1, so a
         tank rendered at scale 25 had an outline 25x too small to see. See
         Tank.compensateOutlineScale. */
      o.position.set(0, 0, 0);
      o.rotation.set(0, 0, 0);
      o.scale.set(1, 1, 1);
      /* No uniform write here any more: every outline shares the one material,
         and its width was set once at the top of this function. Writing it per
         outline was both redundant and, while the pool was keyed wrongly, the
         thing that let one tank's width overwrite another's. */
    }
    if(live !== list.length) list.length = live;
  }
  /* ============================================================================
   MOMENTUM LEAN
   A tank cannot change direction without its weight shifting. Barrel first at
   speed and then hit reverse, and the momentum carries the hull onwards: the
   rear squats, the nose lifts. The further you were going and the harder the
   change, the further it tips. In a corner the weight moves onto the outside
   track and the hull rolls out of the turn.

   This is a real spring on the hull, not a "is reversing" flag:

     * the DRIVE is the body's own acceleration — so the tilt falls out of the
       momentum rather than out of which key is held, and it scales with how
       fast you were going and how sharply you changed;
     * the SPRING stands in for GRAVITY pulling the hull back level. With no
       restoring force the tank would just flop over and stay there;
     * the DAMPER lets it overshoot once and settle, which is what gives it the
       weight of something sitting on springs instead of a motorised gimbal.

   PITCH (nose up / nose down) carries most of it, because pitch is the axis
   the tank actually squats on and it does not lift a track off the ground;
   ROLL is kept a little smaller for the same reason.
   ============================================================================ */
  _updateLean(){
    /* Step once per FRAME, using the game's own delta. _syncTransform is
       called several times per frame, and stepping the spring on each of those
       over-integrates it into a permanent lean. */
    const token = this._frameToken;
    if(!token || token === this._leanToken) return;
    this._leanToken = token;
    let dt = this._frameDt;
    if(!(dt > 0.001) || dt > 0.25) dt = 1/60;   /* a stalled frame: assume normal */

    /* --- world velocity, and therefore the acceleration of the body --- */
    let vx = this._leanVX, vz = this._leanVZ;
    if(this._physBody){
      try { const v = this._physBody.linvel(); vx = v.x; vz = v.z; } catch(e){}
    } else {
      vx = (this.x - this._leanPX) / dt;
      vz = (this.z - this._leanPZ) / dt;
    }
    this._leanPX = this.x; this._leanPZ = this.z;
    let ax = (vx - this._leanVX) / dt;
    let az = (vz - this._leanVZ) / dt;
    this._leanVX = vx; this._leanVZ = vz;

    /* A respawn, a teleport or a collision impulse can hand us an absurd
       velocity jump. Clamp it: the hull may be thrown about, never inverted.
       The limit has to be well above anything real driving produces —
       measured over 900 frames of bot driving, ordinary driving sits at
       18-43 and the hardest events reach 90 — or a genuine hard reversal gets
       clipped down and barely registers. */
    const A_MAX = 150;
    if(ax >  A_MAX) ax =  A_MAX; if(ax < -A_MAX) ax = -A_MAX;
    if(az >  A_MAX) az =  A_MAX; if(az < -A_MAX) az = -A_MAX;

    /* --- into the tank's own axes: forward, and to its right --- */
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const rx = Math.cos(this.heading), rz = -Math.sin(this.heading);
    const aF = ax * fx + az * fz;      /* + = speeding up forwards      */
    const aR = ax * rx + az * rz;      /* + = being pushed to its right */

    /* A_FAST is the acceleration that would tip the hull the full distance.
       Measured, ordinary driving here produces 18-43 u/s^2, so 45 puts a
       brisk acceleration at roughly 5-6 degrees and leaves a hard reversal to
       peg the hull at its 7 degree stop. */
    const A_FAST = 45;
    let tP = -(aF / A_FAST) * LEAN_PITCH;   /* throttle -> nose down, brake/reverse -> nose up */
    let tR =  (aR / A_FAST) * LEAN_ROLL;    /* cornering -> the hull rolls out of the turn   */

    tP = Math.max(-LEAN_PITCH, Math.min(LEAN_PITCH, tP));
    tR = Math.max(-LEAN_ROLL,  Math.min(LEAN_ROLL,  tR));

    /* --- spring + damper, integrated explicitly --- */
    this._leanPV += ((tP - this._leanP) * LEAN_STIFF - this._leanPV * LEAN_DAMP) * dt;
    this._leanRV += ((tR - this._leanR) * LEAN_STIFF - this._leanRV * LEAN_DAMP) * dt;
    this._leanP += this._leanPV * dt;
    this._leanR += this._leanRV * dt;

    /* Hard stops, so the overshoot can never push past level the wrong way. */
    if(this._leanP >  LEAN_PITCH){ this._leanP =  LEAN_PITCH; this._leanPV = 0; }
    if(this._leanP < -LEAN_PITCH){ this._leanP = -LEAN_PITCH; this._leanPV = 0; }
    if(this._leanR >  LEAN_ROLL ){ this._leanR =  LEAN_ROLL ; this._leanRV = 0; }
    if(this._leanR < -LEAN_ROLL ){ this._leanR = -LEAN_ROLL ; this._leanRV = 0; }
  }

  /* ============================================================================
     MOVE THIS TANK'S PHYSICS BODY TO AN AUTHORITATIVE POSITION

     Needed for networked clients. _syncTransform() reads x/z/heading back OUT of
     the rigid body, so writing this.x / this.z and then calling _syncTransform()
     does nothing at all -- the body overwrites them on the very next line. That
     is why a client could receive perfectly good snapshots, run the whole
     reconciliation block, and never move: the correction was applied to fields
     that are not the source of truth.

     On a client the HOST is authoritative, so the body has to be the thing that
     moves. Writing the body's translation makes the next _syncTransform() report
     the new position, which is exactly what the renderer and the HUD read. */
  snapToPosition(x, z, heading){
    this.x = x;
    this.z = z;
    if(typeof heading === 'number' && isFinite(heading)) this.heading = heading;

    /* NET-DRIVEN TANKS DO NOT TOUCH THE PHYSICS WORLD.

       This is the single biggest per-frame cost on a client. snapToPosition is
       called for every remote tank on every frame — 13 tanks at 60 Hz is 780
       calls a second — and each one did a Rapier translation() read, a
       setTranslation(..., WAKE) WRITE, then _syncTransform() read the body back
       and decomposed a quaternion into Euler angles. The measured cost was the
       whole difference between the host at 59 fps and the client at 36.

       None of it is needed. A net-driven tank is not simulated on this client:
       the host decides where it is, this client only draws it, and nothing here
       resolves collisions against it because hits are resolved on the host too.
       So the position is written straight into the transform.

       The body is left where it was rather than teleported, so if the tank is
       ever promoted to a simulated one it starts from somewhere sane. */
    if(this.netDriven){
      /* No body write: nothing on this client simulates a remote tank, and hits
         are resolved on the host, so there is nothing for the physics world to
         react to. _syncTransform() reads the body too, but it skips that for
         net-driven tanks as well, so this costs no Rapier calls at all. */
      this._syncTransform();
      return;
    }

    /* A SIMULATED tank is placed through its physics body. _syncTransform()
       reads x/z/heading back OUT of the body, so writing this.x/this.z and
       syncing alone would be overridden on the very next line — the body is
       the source of truth for anything that is simulated. */
    if(this._physBody){
      try {
        const cur = this._physBody.translation();
        /* false = do not wake the island. The body is being placed by hand, so
           waking everything that touches it costs a great deal for nothing. */
        this._physBody.setTranslation({ x: x, y: cur.y, z: z }, false);
      } catch(e){}
    }
    this._syncTransform();
  }

  /* Aim-pitch writer for the LOCAL PLAYER. Fires on every game.js tick where
     it owns _aimPitch. Turret and hull steer with YawGroup and Body, so a
     dedicated PitchGroup for the barrel elevation cannot be unwound by them.
     _applyAimPitch is safe to call at any frequency; it no-ops when the pitch
     is already applied. */
  _applyAimPitch(pitch){
    const g = (this._pitchGroup && this._pitchGroup.parent === this.turretGroup)
      ? this._pitchGroup : this._makePitchGroup();
    if(!g) return;
    g.rotation.x = -(pitch || 0);
  }

  /* Construct-once PitchGroup that wraps the barrel (never turret yaw, never
     hull). Called from _applyAimPitch on demand; no cost once built. */
  _makePitchGroup(){
    if(this._pitchGroup) return this._pitchGroup;
    if(!this.barrelEnd || !this.turretGroup) return null;
    const g = new THREE.Group();
    const be = this.barrelEnd;
    this.turretGroup.add(g);
    this.turretGroup.remove(be);
    g.add(be);
    this._pitchGroup = g;
    /* Keep barrelEnd's world transform identical through the re-parent, so
       muzzle(), the aim line and the spawned shell all keep reading the
       same spot they read before the group existed. */
    this.root.updateMatrixWorld(true);
    return g;
  }

  _syncTransform(){
    this._updateLean();
    /* A net-driven tank has no business being read out of the physics world: its
       position came from the host and nothing here simulates it. Reading it back
       would both cost a Rapier call per tank per frame AND overwrite the
       interpolated value with the body's stale one — which is the bug this
       function's own comment describes. The height is cached instead, so a tank
       on uneven ground keeps its level. */
    const live = this._physBody && !this.netDriven;
    if(live){
      try {
        var p = this._physBody.translation();
        this.x = p.x;
        this.z = p.z;
        this._visualY = p.y;
        var q = this._physBody.rotation();
        this.heading = Math.atan2(2*(q.w*q.y + q.x*q.z), 1 - 2*(q.y*q.y + q.z*q.z));
      } catch(e){}
    } else if(this._physBody && this._visualY == null){
      try { this._visualY = this._physBody.translation().y; } catch(e){}
    }
    /* ALTITUDE SOURCES: a simulated tank's height is read out of its body above.
       A net-driven ghost owns the interpolated snapshot height, and an
       input-driven kinematic tank on the HOST owns the height its owner's client
       reported with the forwarded input. Without the extra case a remote player's
       tank root was pinned to y=0 and looked buried inside any hill it drove up
       (the "I'm on the hill / he's inside the hill" report). */
    const rootY = (this._allowFall || this._peerReportY != null) ? (this._visualY || 0) : 0;
    this.root.position.set(this.x, rootY, this.z);
    const myaw = this._modelYaw || 0;
    const mo = this._modelOff || (this._modelOff = new THREE.Vector3());
    var tiltX = 0, tiltZ = 0;
    if(this._physBody && this._allowFall && live){
      try {
        var q2 = this._physBody.rotation();
        this._tmpQuat.set(q2.x, q2.y, q2.z, q2.w);
        this._tmpEuler.setFromQuaternion(this._tmpQuat, 'YXZ');
        tiltX = this._tmpEuler.x;
        tiltZ = this._tmpEuler.z;
      } catch(e){}
    }
    this.bodyGroup.rotation.set(tiltX, this.heading + myaw, tiltZ, 'YXZ');
    this.bodyGroup.position.set(mo.x, mo.y, mo.z);
    if(!this._physBody || !this._allowFall){
      if(this.drifting){
        this.bodyGroup.rotation.z = THREE.MathUtils.lerp(this.bodyGroup.rotation.z, -0.18, 0.25);
        this.bodyGroup.rotation.x = THREE.MathUtils.lerp(this.bodyGroup.rotation.x, 0.06, 0.25);
      } else {
        this.bodyGroup.rotation.z = THREE.MathUtils.lerp(this.bodyGroup.rotation.z, 0, 0.2);
        this.bodyGroup.rotation.x = THREE.MathUtils.lerp(this.bodyGroup.rotation.x, 0, 0.2);
      }
    }
    if(this._shotgunTilt && !this._physBody){
      this.bodyGroup.rotation.x -= this._shotgunTilt;
      this._shotgunTilt *= Math.max(0, 1 - this._shotgunTiltDecay * 0.016);
      if(Math.abs(this._shotgunTilt) < 0.01) this._shotgunTilt = 0;
    }
    /* Momentum lean goes on LAST, so it composes with the drift lean and the
       knockback tilt instead of being overwritten by them. */
    this.bodyGroup.rotation.x += this._leanP;
    this.bodyGroup.rotation.z += this._leanR;
    if(this._modelTurretPivot){
      this.turretGroup.position.set(mo.x, mo.y, mo.z);
      this._modelTurretPivot.rotation.y = this.turretAngle;
    } else {
      const hullTop = (this.def.body && this.def.body.h) ? this.def.body.h * 2.0 : 2.0;
      const turretH = (this.def.turret && this.def.turret.h) ? this.def.turret.h * 2.0 : 1.7;
      this.turretGroup.position.set(mo.x, hullTop - turretH / 2 + mo.y, mo.z);
    }
    if(this._allowFall && this._physBody){
      try {
        var qH = this._physBody.rotation();
        this._tmpQuat.set(qH.x, qH.y, qH.z, qH.w);
        this._tmpEuler.setFromQuaternion(this._tmpQuat, 'YXZ');
        var hullHeading = this._tmpEuler.y;
        var worldTurretAngle = this._modelTurretPivot ? myaw : (this.turretAngle + myaw);
        var localAngle = worldTurretAngle - hullHeading;
        this._tmpVec3.set(0, 1, 0);
        this._tmpQuat2.setFromAxisAngle(this._tmpVec3, localAngle);
        this._tmpQuat.multiply(this._tmpQuat2);
        this.turretGroup.quaternion.copy(this._tmpQuat);
        if(this._modelTurretPivot){
          this._modelTurretPivot.rotation.y = this.turretAngle;
        }
      } catch(e){}
    } else if(this._modelTurretPivot){
      this.turretGroup.rotation.set(0, myaw, 0, 'YXZ');
      this._modelTurretPivot.rotation.y = this.turretAngle;
    } else {
      this.turretGroup.rotation.set(0, this.turretAngle + myaw, 0, 'YXZ');
    }
    /* AIM PITCH: the barrel's own elevation group rides on TOP of whatever
       the yaw wrote here, so writing turretGroup.rotation every frame cannot
       unwind it. _applyAimPitch sets _pitchGroup.rotation.x directly and does
       not go through _syncTransform, so the two never fight. */
    if(this._pitchGroup) this._pitchGroup.rotation.x = -(this._aimPitch || 0);
  }

  /* TREAD MARKS — one batched mesh per tank.

     This used to drop a separate Mesh (with its own material) for every mark,
     up to 200 of them per tank. With twenty tanks driving that is 4000 extra
     TRANSPARENT draw calls and 4000 materials in a fight — measured, and it
     was the single largest cost in the battle. Now every mark a tank has ever
     left lives in ONE pre-allocated buffer as a flat quad, with the fade in
     the vertex colour, so a tank's whole trail is one draw call and one
     material no matter how long it has been driving. */
  _updateTrails(dt, game){
    const scene = game ? game.scene : null;
    if(!scene) { this.clearTrails(); return; }

    if(this.alive && !this.dying){
      const speed = Math.hypot(this.vx, this.vz);
      if(speed >= 0.5){
        this._trailTimer += dt;
        // 0.1s is the floor, so a mark is laid at most 10x a second per side;
        // 2s of life therefore never needs more than ~40 of them.
        const interval = Math.max(0.1, 1.2 / speed);
        if(this._trailTimer >= interval){
          this._trailTimer = 0;
          const b = this.def.body;
          const off = b.w/2 + 0.05;
          const back = -b.l/2;
          const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
          for(let s = -1; s <= 1; s += 2){
            this.trailSegments.push({
              x: this.x + s * off * ch + back * sh,
              z: this.z - s * off * sh + back * ch,
              a: this.heading, life: 2, maxLife: 2
            });
          }
          while(this.trailSegments.length > Tank.TRAIL_MAX) this.trailSegments.shift();
        }
      }
    }

    let w = 0;
    for(let i = 0; i < this.trailSegments.length; i++){
      const s = this.trailSegments[i];
      s.life -= dt;
      if(s.life > 0) this.trailSegments[w++] = s;
    }
    this.trailSegments.length = w;

    this._syncTrailMesh(scene);
  }

  /* Rebuild the whole trail into the pre-allocated buffer. At most 48 quads,
     so this is ~200 floats a frame — cheaper than the material bookkeeping the
     old version did 200 times over. */
  _syncTrailMesh(scene){
    const n = Math.min(this.trailSegments.length, Tank.TRAIL_MAX);
    if(!n){ if(this._trailMesh){ this._trailMesh.visible = false; } return; }
    if(!this._trailMesh){
      const max = Tank.TRAIL_MAX;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 4 * 3), 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(max * 4 * 4), 4));
      const idx = new Uint16Array(max * 6);
      for(let i = 0; i < max; i++){
        const v = i * 4, k = i * 6;
        idx[k] = v; idx[k+1] = v+1; idx[k+2] = v+2;
        idx[k+3] = v; idx[k+4] = v+2; idx[k+5] = v+3;
      }
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.setDrawRange(0, 0);
      const mesh = new THREE.Mesh(geo, Tank._trailMat());
      mesh.frustumCulled = false;
      mesh.renderOrder = -1;
      scene.add(mesh);
      this._trailMesh = mesh;
    }
    const mesh = this._trailMesh;
    const pos = mesh.geometry.attributes.position.array;
    const col = mesh.geometry.attributes.color.array;
    const HW = 0.175, HL = 0.25;          // half of the old 0.35 x 0.50 mark
    for(let i = 0; i < n; i++){
      const s = this.trailSegments[i];
      const ch = Math.cos(s.a), sh = Math.sin(s.a);
      const fx = ch * HL, fz = -sh * HL;    // along the heading
      const rx = sh * HW, rz = ch * HW;     // across it
      const v = i * 4 * 3;
      pos[v]     = s.x - rx - fx; pos[v+1] = 0.01; pos[v+2] = s.z - rz - fz;
      pos[v+3]   = s.x + rx - fx; pos[v+4] = 0.01; pos[v+5] = s.z + rz - fz;
      pos[v+6]   = s.x + rx + fx; pos[v+7] = 0.01; pos[v+8] = s.z + rz + fz;
      pos[v+9]   = s.x - rx + fx; pos[v+10]= 0.01; pos[v+11]= s.z - rz + fz;
      const a = Math.max(0, s.life / s.maxLife) * 0.45;
      const c = i * 4 * 4;
      for(let k = 0; k < 4; k++){
        col[c + k*4] = 0.10; col[c + k*4 + 1] = 0.10; col[c + k*4 + 2] = 0.10; col[c + k*4 + 3] = a;
      }
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.attributes.color.needsUpdate = true;
    mesh.geometry.setDrawRange(0, n * 6);
    mesh.visible = true;
  }

  clearTrails(){
    this.trailSegments = [];
    if(this._trailMesh){
      if(this._trailMesh.parent) this._trailMesh.parent.remove(this._trailMesh);
      this._trailMesh.geometry.dispose();
      this._trailMesh = null;
    }
  }

  /* White hit flash.

     WHY IT DRIVES THE COLOUR AND NOT THE EMISSIVE. `emissive` is additive, so
     turning it up on a toon material washes the tank toward the light rather
     than toward white, and at low emissive intensity it does almost nothing --
     the exact flash you would most want (a fast, small hit) is the one it
     cannot produce. Writing the base colour white is unconditional.

     WHY THE COLOURS ARE CACHED ON THE TANK. This runs on every hit, and a hit
     rate of several per second across eleven tanks is enough for "collect the
     colours each time" to show up as a GC pause in a fight. So they are walked
     once and kept, and a flash that arrives while another is running just
     extends the timer rather than re-walking the tree.

     The original colours are restored EXACTLY, including whatever tint the tank
     was already carrying, because those tints are owned by other systems: the
     spawn shield, and the bush-hide fade. Restoring "white" instead of the
     saved colour would leave a tank stuck white for the rest of the match. */
  flash(dur){
    if(!this.root || this._noFlash) return;
    const d = dur || 0.2;
    /* Already flashing: restart the clock, do not rebuild the cache. */
    if(this._flashUntil !== undefined && this._flashUntil > 0 && this._flashMat){
      this._flashT = Math.max(this._flashT || 0, d);
      return;
    }
    if(!this._flashMat){
      this._flashMat = [];
      this.root.traverse(o => {
        if(o.isMesh && o.material && o.material.color) this._flashMat.push(o.material);
      });
    }
    if(!this._flashMat.length) return;
    for(const m of this._flashMat){
      m.userData = m.userData || {};
      if(m.userData._preFlash === undefined) m.userData._preFlash = m.color.getHex();
      m.color.setHex(0xffffff);
    }
    this._flashT = d;
    this._flashUntil = d;
  }

  _updateFlash(dt){
    if(!this._flashUntil || this._flashUntil <= 0 || !this._flashMat) return;
    this._flashUntil -= dt;
    if(this._flashUntil > 0) return;
    this._flashUntil = 0;
    for(const m of this._flashMat){
      if(m.userData && m.userData._preFlash !== undefined){
        m.color.setHex(m.userData._preFlash);
      }
    }
  }

  /* Heal up to max HP and redraw the bar. Used by the tree's repair perks. */
  healBy(n){
    if(!this.alive || this.dying || !(n > 0)) return;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + n);
    if(this.hp !== before) this._drawHp();
  }

  /* Field repairs (upgrade tree): after regenDelayS without taking damage the
     hull repairs regenPctS % of its max HP every second. */
  _tickFieldRepairs(dt){
    const us = this.upStats;
    if(!us || !us.regenPctS || this.hp >= this.maxHp) return;
    if(performance.now() - (this._lastHurtAt || 0) < us.regenDelayS * 1000) return;
    this.healBy(this.maxHp * us.regenPctS / 100 * dt);
  }

  takeDamage(amount, fromTank, game, accumulate){
    if(!this.alive || this.dying) return;
    if(this._spawnInvuln && this._spawnInvuln > 0) return;
    /* THE HIT FLASH -- a white pop for 0.2s, driven from the damage event
       itself rather than from the VFX layer.

       A hit that only costs hit points reads as the game not registering it.
       The flash is the feedback that says "that landed, and it landed HERE",
       and it belongs on the tank rather than in a sprite burst at the impact
       point: a burst reads as the shell arriving, a flash reads as the hull
       being hit, and at fighting range that is the difference between seeing
       your shot connect and seeing a sprite.

       0.2s, not longer. Tanks are small on screen at range and a longer flash
       starts to look like paint falling off. Colours are saved per tank and
       restored to exactly what they were, so a tank that was ALREADY tinted
       (spawn shield, hiding in a bush) comes back tinted rather than white. */
    this.flash(0.2);
    /* Flagged so a bot re-decides THIS frame instead of finishing its throttle
       phase: being shot at has to be reacted to at once, not up to four
       frames later. */
    this._hurtThisFrame = true;
    /* UPGRADE-TREE PERKS (upgrade-tree.js), shooter's first, then this hull's
       armour. Only the local player's tank carries upStats. */
    const atk = (fromTank && fromTank !== this) ? fromTank.upStats : null;
    if(atk){
      if(atk.lastStandPct && fromTank.hp < fromTank.maxHp * 0.35) amount *= 1 + atk.lastStandPct / 100;
      if(atk.execPct && this.hp < this.maxHp * 0.30) amount *= 1 + atk.execPct / 100;
      if(atk.critPct && Math.random() * 100 < atk.critPct) amount *= 1.75;
    }
    if(this.upStats && this.upStats.armorPct) amount *= 1 - this.upStats.armorPct / 100;
    this._lastHurtAt = performance.now();
    this.hp -= amount;
    if(atk && atk.lifestealPct && fromTank.alive) fromTank.healBy(amount * atk.lifestealPct / 100);
    if(fromTank && fromTank !== this){
      fromTank.damageDealt += amount;
      /* REMEMBER WHO HIT ME, so an assist can be paid out when I die.

         This is the World of Tanks definition: an assist is awarded to everyone
         who damaged me EXCEPT the player who finished me off. It cannot be
         worked out from damage and kills afterwards — the two numbers share no
         information about who did what to whom — so the pair has to be recorded
         at the moment the shell lands.

         Stored as a Map of tank -> total damage rather than a plain list,
         because one player can land five shells and must still count as ONE
         assist, not five. */
      if(!this._damagedBy) this._damagedBy = new Map();
      this._damagedBy.set(fromTank, (this._damagedBy.get(fromTank) || 0) + amount);
    }
    if(this.superState === 'cloaked') this.endCloak();
    this._triggerDamageFlash();
    if(accumulate && game){
      game._accumFlameDamage(this, amount);
    } else if(game && game.spawnDamageLabel){
      game.spawnDamageLabel(this.x, this.def.turret.h + this.def.body.h + 3.6, this.z, amount);
    }
    /* THE HIT SOUNDS. Not attached to the shell (that one already has the
       muzzle pop and the impact burst on its own path); the hull has its own
       voice:
         a damage thud - sub thud + metal crunch, louder and deeper the more
         the hit costs - silenced for bits of chip damage that are below what
         an ear will even notice.
       Distance rule as everywhere else: full volume near the local tank,
       fading out, silent across the map (the audio budget is per-event, and
       a faraway brawl must not spend it). */
    if(window.Audio && Audio.armorHit && game && this.hp > 0 && amount >= 2){
      try {
        const lt = game.localTank;
        const d = lt ? Math.hypot(lt.x - this.x, lt.z - this.z) : -1;
        const frac = Math.min(1, amount / Math.max(20, (this.maxHp || 200) * 0.35));
        const v = d < 0 ? 0.45 : (1 - d / 80);
        if(v > 0.03) Audio.armorHit(v, frac);
        else if(d < 160) Audio.armorHit(0.03, frac);
      } catch(e){}
    }
    if(this.hp <= 0){
      this.hp = 0; this.alive = false;
      if(fromTank && fromTank !== this){
        fromTank.kills++;
        const ks = fromTank.upStats;
        if(ks && fromTank.alive){
          if(ks.scavengePct) fromTank.healBy(fromTank.maxHp * ks.scavengePct / 100);
          if(ks.overdriveS) fromTank._overdriveUntil = performance.now() + ks.overdriveS * 1000;
        }
      }
      this._payAssists(fromTank);
      this._startDeath(game, fromTank);
    }
    this._drawHp();
  }

  /* ASSISTS PAID OUT ON DEATH.

     Everyone who damaged this tank gets one, except the player who killed it —
     a kill is a kill, and the World of Tanks rules do not pay both for the same
     death. Allies are excluded too: in a team game, shooting your own team does
     not earn you credit for their kills.

     `assists` is the count shown on the results screen and in the leaderboard.
     It is deliberately not carried in the network snapshot yet: the scoreboard
     that ships with this reads it locally, and the host owns the only copy of
     every tank's real totals anyway. */
  _payAssists(killer){
    const map = this._damagedBy;
    this._damagedBy = null;
    if(!map || !map.size) return;

    /* An assist is only a thing in a TEAM game, and the test is "did someone on
       MY side finish it".

       Skipping that test was a real bug, and an appealing one: with no check on
       the killer's side, damaging an enemy and then watching an ENEMY get the
       kill paid out as an assist. Measured, that was happening — and it is worse
       than a cosmetic miscount, because in a real battle most of the tanks you
       damage are finished off by the other team. Every one of those deaths would
       have been credited to you.

       So both halves are required: the killer must be on the same side as the
       damager, and that side must be the victim's enemy. The first is what makes
       it an assist rather than a kill; the second is what keeps friendly fire out.

       The early return for "nobody has a side" — free roam, sandbox, anything not
       side-versus-side — is belt and braces rather than the thing doing the work.
       In those modes every team is undefined, so `tank.team === this.team` below
       is already true and the friendly-fire guard stops everything on its own.
       It is kept because it states the rule instead of inferring it from a
       coincidence, and because the moment one mode DOES set a team on the victim
       but not the damager, relying on undefined === undefined is how assists
       start appearing in a mode that has no teams. */
    if(!(this.team && killer && killer.team)) return;

    for(const [tank, dmg] of map){
      if(!tank || tank === this) continue;
      if(dmg <= 0) continue;
      if(killer === tank) continue;            /* a kill is not also an assist */
      if(killer.team !== tank.team) continue;  /* their enemy finished it */
      if(tank.team === this.team) continue;    /* friendly fire */
      tank.assists = (tank.assists || 0) + 1;
    }
  }

  _triggerDamageFlash(){
    // A burst of hits re-fires this every few ms. Keep the originals captured by
    // the FIRST hit of the burst, otherwise the second hit saves the already
    // flashing colour as "original" and it never comes back off.
    const restarting = !!this._flashTid;
    if(this._flashTid){ clearTimeout(this._flashTid); this._flashTid = null; }
    const root = this.bodyGroup || this.root;
    const meshes = [];
    root.traverse(o => { if(o.isMesh) meshes.push(o); });
    const turretRoot = this.turretGroup;
    if(turretRoot){ turretRoot.traverse(o => { if(o.isMesh) meshes.push(o); }); }
    const originals = (restarting && this._flashOriginals) ? this._flashOriginals : new Map();
    this._flashOriginals = originals;
    const flashEmissive = new THREE.Color(0xff0000);
    const flashIntensity = 0.6;
    meshes.forEach(m => {
      if(!m.material) return;
      // Outlines are MeshBasicMaterial silhouettes — they must stay black anyway.
      if(m.userData && m.userData.isOutline) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach(mat => {
        // Only materials that actually own an `emissive` colour may carry one.
        // MeshBasicMaterial has no emissive uniform, so inventing the property
        // makes three.js throw inside refreshMaterialUniforms on every later
        // frame — renderer.render() then aborts and the world stops drawing.
        if(!mat.emissive || !mat.emissive.isColor) return;
        if(!originals.has(mat)){
          originals.set(mat, {
            emissive: mat.emissive.clone(),
            intensity: mat.emissiveIntensity || 0
          });
        }
        mat.emissive = flashEmissive;
        mat.emissiveIntensity = flashIntensity;
      });
    });
    const restore = () => {
      originals.forEach((orig, mat) => {
        mat.emissive = orig.emissive;
        mat.emissiveIntensity = orig.intensity;
      });
      this._flashOriginals = null;
    };
    this._flashTid = setTimeout(() => {
      restore();
      this._flashTid = null;
    }, 20);
  }
  heal(amount){ this.hp = Math.min(this.maxHp, this.hp + amount); this._drawHp(); }

  /* ---------- Gladiator power ---------- */
  powerMult(){ return 1 + (this.power || 0) / 100; }

  applyPower(n, game){
    if(!n || !this.alive) return;
    const oldMax = this.maxHp;
    this.power = (this.power || 0) + n;
    this.maxHp = Math.round(this.def.hp * this.powerMult());
    this.hp = Math.min(this.maxHp, this.hp + Math.max(0, this.maxHp - oldMax));
    this.hitScale = this.powerMult();
    this._applyPowerScale();
    this._drawHp();
    if(game && game.onPowerGained) game.onPowerGained(this, n);
  }

  setPowerFromSnapshot(pw){
    if(pw == null || pw === this.power) return;
    const oldMax = this.maxHp;
    this.power = pw;
    this.maxHp = Math.round(this.def.hp * this.powerMult());
    if(this.alive && !this.dying) this.hp = Math.min(this.maxHp, this.hp + Math.max(0, this.maxHp - oldMax));
    this.hitScale = this.powerMult();
    this._applyPowerScale();
    this._drawHp();
  }

  _applyPowerScale(){
    if(!this.root) return;
    const s = this.hitScale || 1;
    this.root.scale.set(s, s, s);
    if(this._overlayGroup){
      const inv = 1 / s;
      this._overlayGroup.scale.set(inv, inv, inv);
      if(this.hpSprite && this._baseTurretH != null){
        this.hpSprite.position.y = this._baseTurretH * s + 4.2 * s;
      }
      if(this._drownBar && this._baseTurretH != null){
        this._drownBar.position.y = this._baseTurretH * s + 1.5 * s;
      }
    }
  }

  _startDeath(game, killer){
    this.dying = true; this.deathT = 0;
    this.removeAt = (game? game.time : 0) + 48;
    if(this._physBody){
      try { this._physBody.setEnabled(false); } catch(e){}
    }

    if(this.hpSprite) this.hpSprite.visible = false;
    if(this.viewCircle) this.viewCircle.visible = false;

    this._turretVel = new THREE.Vector3(
      (Math.random()-0.5)*4, 14 + Math.random()*4, (Math.random()-0.5)*4);
    this._turretSpin = new THREE.Vector3((Math.random()-0.5)*4,(Math.random()-0.5)*6,(Math.random()-0.5)*4);
    // Fancy graphics: launch the turret harder so its fly-off is dramatic
    if(game && game.isFancy){
      this._turretVel.y += 6;
      this._turretVel.x *= 1.8;
      this._turretVel.z *= 1.8;
      this._turretSpin.x *= 2;
      this._turretSpin.z *= 2;
    }

    // Snapshot the pre-death material colours BEFORE they are charred, so a
    // respawn (Capture the Circle brings tanks back mid-match) can paint them
    // back instead of staying burnt black for the rest of the match.
    this._deathColorBackup = [];
    const _snapDeathMat = (m) => {
      if(!m) return;
      if(Array.isArray(m)){ m.forEach(_snapDeathMat); return; }
      if(!m.color || this._deathColorBackup.some(e => e.m === m)) return;
      // The damage flash already replaced `emissive` with the flash colour and
      // scheduled a restore — prefer the true original it captured.
      const fo = this._flashOriginals ? this._flashOriginals.get(m) : null;
      this._deathColorBackup.push({
        m,
        color: m.color.clone(),
        emissive: fo ? fo.emissive.clone() : ((m.emissive && m.emissive.isColor) ? m.emissive.clone() : null),
        ei: fo ? fo.intensity : ((typeof m.emissiveIntensity === 'number') ? m.emissiveIntensity : null),
      });
    };
    _snapDeathMat(this.bodyMat);
    _snapDeathMat(this.turretMat);
    if(this.bodyMesh) _snapDeathMat(this.bodyMesh.material);
    if(this.turretMesh) _snapDeathMat(this.turretMesh.material);

    if(this.bodyMat){ this.bodyMat.color.setHex(0x141414); if(this.bodyMat.emissive){ this.bodyMat.emissive=new THREE.Color(0x3a1500); this.bodyMat.emissiveIntensity=0.6; } }
    if(this.turretMat){ this.turretMat.color.setHex(0x1a1a1a); if(this.turretMat.emissive){ this.turretMat.emissive=new THREE.Color(0x2a1000); this.turretMat.emissiveIntensity=0.5; } }
    // `emissive` only exists on lit materials (toon/phong/standard). On a
    // MeshBasicMaterial it is not part of the shader's uniforms, and three.js
    // throws on it for the rest of the session — which aborts renderer.render().
    if(this.bodyMesh && this.bodyMesh.material !== this.bodyMat){
      this.bodyMesh.material.color.setHex(0x141414);
      if(this.bodyMesh.material.emissive){
        this.bodyMesh.material.emissive = new THREE.Color(0x3a1500);
        this.bodyMesh.material.emissiveIntensity = 0.6;
      }
    }
    if(this.turretMesh && this.turretMesh.material !== this.turretMat){
      this.turretMesh.material.color.setHex(0x1a1a1a);
      if(this.turretMesh.material.emissive){
        this.turretMesh.material.emissive = new THREE.Color(0x2a1000);
        this.turretMesh.material.emissiveIntensity = 0.5;
      }
    }

    this._firePts = (!window.particleClouds || (game && game._noParticles)) ? null : this._makeFireParticles();
    if(this._firePts){
      this._firePts.position.y = 0;
      this.root.add(this._firePts);
    }

    this._star = this._makeStarDecal();
    this._star.position.set(0, 0.25, 0);
    this.root.add(this._star);

    if(game && game._spawnVideoFire) game._spawnVideoFire(this);
    if(game && game._spawnVideoExplosion) game._spawnVideoExplosion(this.x, 0.5, this.z);

    if(game) game.onTankKilled(this, killer);
  }

  _makeFireParticles(){
    const g = new THREE.Group();
    const tex = VFX.getTex('flame');
    const starR = 3.2;
    for(let i=0;i<30;i++){
      const mat = new THREE.SpriteMaterial({map:tex, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, depthWrite:false, depthTest:true});
      const s = new THREE.Sprite(mat);
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * starR;
      s.position.set(Math.cos(angle)*r, 0.5+Math.random()*0.6, Math.sin(angle)*r);
      const sz = 0.6+Math.random()*0.9;
      s.scale.set(sz, sz*1.5, 1);
      s.userData.phase = Math.random()*6.28;
      s.userData.baseY = s.position.y;
      s.userData.baseScale = sz;
      g.add(s);
    }
    return g;
  }

  _makeStarDecal(){
    const shape = new THREE.Shape();
    const spikes=8, outer=13.6, inner=4.8;
    for(let i=0;i<spikes*2;i++){
      const r = (i%2===0)?outer:inner;
      const a = (i/(spikes*2))*Math.PI*2;
      const px=Math.cos(a)*r, py=Math.sin(a)*r;
      if(i===0) shape.moveTo(px,py); else shape.lineTo(px,py);
    }
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI/2);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color:0x000000, transparent:true, opacity:1.0, depthWrite:false}));
  }

  _updateDeath(dt, game){
    this.deathT += dt;

    if(this._turretVel){
      this.turretGroup.position.x += this._turretVel.x*dt;
      this.turretGroup.position.y += this._turretVel.y*dt;
      this.turretGroup.position.z += this._turretVel.z*dt;
      this._turretVel.y -= 22*dt;
      this.turretGroup.rotation.x += this._turretSpin.x*dt;
      this.turretGroup.rotation.z += this._turretSpin.z*dt;
      const baseY = this._modelTurretPivot ? 0 : this.def.body.h+0.45;
      if(this.turretGroup.position.y <= baseY && this._turretVel.y<0){
        this.turretGroup.position.y = baseY;
        this._turretVel.y *= -0.3;
        this._turretVel.x *= 0.5; this._turretVel.z *= 0.5;
        if(Math.abs(this._turretVel.y)<1){ this._turretVel=null; }
      }
    }

    if(this._firePts){
      this._firePts.children.forEach((p,i)=>{
        p.position.y = p.userData.baseY + Math.sin(game.time*6+p.userData.phase)*0.04;
        const sc = p.userData.baseScale * (1+Math.sin(game.time*8+p.userData.phase)*0.2);
        p.scale.set(sc, sc * 1.3, 1);
      });
    }

    if(this.deathT > 3){
      const sink = (this.deathT-3);
      this.root.position.y = -sink*1.2;
      if(this._firePts){ this._firePts.children.forEach(p=>{ p.material.opacity=Math.max(0, 0.9 - this.deathT/45); }); }
    }

    if(this._star){
      this._star.material.opacity = Math.max(0, 1.0 - this.deathT / 45);
    }

    if(this.deathT > 4 && game && this.isLocal && !this._notifiedDeath){
      this._notifiedDeath = true;
      game.onLocalDeath();
    }
    if(this.deathT > 48){
      this.root.visible = false;
    }
  }

  /* Bring this tank back to life. `at` optionally pins it to a fixed spawn
     ({x, z, heading}) — Capture the Circle sends everyone back to the exact
     point they started from instead of a random spot on the map. */
  respawn(world, game, at){
    const sp = at || world.randomSpawn();
    this.x = sp.x; this.z = sp.z;
    this.heading = (sp.heading != null) ? sp.heading : Math.random()*Math.PI*2;
    this.turretAngle = this.heading;
    this.hp = this.maxHp; this.alive = true;
    this.dying = false; this.deathT = 0;
    this.removeAt = -1;
    this._notifiedDeath = false;
    this.speed = 0; this.vx = 0; this.vz = 0; this.reloadLeft = 0;
    this.heat = 0; this.overheated = false;
    /* Coming back into the fight must not inherit the blast that killed you.
       A big kill kick lasts about a second, and without this the camera was
       still juddering for two seconds AFTER the respawn — which reads as the
       controls being broken, not as a shockwave. */
    if(game && this.isLocal && game._shake > 0) game._shake = 0;
    // The wreck's tumbling turret must not keep flying once we're back
    this._turretVel = null; this._turretSpin = null;
    // Paint the charred body/turret back to their pre-death colours
    if(this._deathColorBackup){
      for(const e of this._deathColorBackup){
        if(e.color && e.m.color) e.m.color.copy(e.color);
        if(e.emissive && e.m.emissive && e.m.emissive.isColor) e.m.emissive.copy(e.emissive);
        if(e.ei != null && typeof e.m.emissiveIntensity === 'number') e.m.emissiveIntensity = e.ei;
        e.m.needsUpdate = true;
      }
      this._deathColorBackup = null;
    }
    // Strip the wreck dressing: fire plume + scorch star decal
    if(this._firePts){
      this.root.remove(this._firePts);
      this._firePts.children.forEach(p => { if(p.material) p.material.dispose(); });
      this._firePts = null;
    }
    if(this._star){
      this.root.remove(this._star);
      if(this._star.geometry) this._star.geometry.dispose();
      if(this._star.material) this._star.material.dispose();
      this._star = null;
    }
    if(this.barrelMat){
      this.barrelMat.color.setHex(0x2a2a2e);
      this.barrelMat.emissive = new THREE.Color(0,0,0);
      this.barrelMat.emissiveIntensity = 0;
    }
    this.root.visible = true;
    const respawnY = this._allowFall ? (this._startY != null ? this._startY : 50) : 0;
    this.root.position.set(this.x, respawnY, this.z);
    if(this.hpSprite) this.hpSprite.visible = true;
    /* THE VIEW CIRCLE COMES BACK ONLY FOR THE LOCAL TANK.

       This used to be an unconditional `visible = true`, which quietly undid
       the hide that Game._finalizeTank applies at spawn:

           if(!t.isLocal) t.viewCircle.visible = false;

       So every remote tank started the match with no view-range circle -- and
       grew one the first time it respawned. Capture the Circle respawns every
       tank every round, TDM respawns bots on a timer, and the dummy respawns
       2s after dying, so "you can see a tank's view range once it has
       respawned" was not an edge case: it was every tank, always, shortly after
       the match started.

       It is also worse than cosmetic, because it hands the opponent the single
       most useful piece of information in the game. The circle is drawn at the
       tank's own viewRange -- 135 for Vortex, 110 for Double -- and a circle
       showing exactly how far someone can see and no further is a scouting tool
       for their turret arc, not a decoration. The local tank keeps it: that one
       is information the player already has, and it is drawn on top of their
       own hull where nobody else is looking.

       The condition is isLocal, matching _finalizeTank exactly, so spawn and
       respawn cannot disagree about who owns the circle. */
    if(this.viewCircle) this.viewCircle.visible = !!this.isLocal;
    if(this._drownBar) this._drownBar.visible = false;
    this._drowning = false;
    this._drownTimer = 0;
    this._drawHp();
    if(this._physBody){
      try {
        this._physBody.setEnabled(true);
        var physY = this._allowFall ? (this._startY != null ? this._startY : 50) : 0.9;
        this._physBody.setTranslation({x: this.x, y: physY, z: this.z}, true);
        this._physBody.setLinvel({x: 0, y: 0, z: 0}, true);
        this._physBody.setAngvel({x: 0, y: 0, z: 0}, true);
        // Stand it back up facing the spawn heading — without this a tank that
        // died flipped over comes back lying on its roof.
        const half = this.heading * 0.5;
        this._physBody.setRotation({x: 0, y: Math.sin(half), z: 0, w: Math.cos(half)}, true);
      } catch(e){}
    }
    this._syncTransform();
  }

  _updateHpBar(){ this._drawHp(); }

  muzzle(){
    this.root.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    this.barrelEnd.getWorldPosition(p);
    const fwd = new THREE.Vector3(0, 0, 1);
    fwd.applyQuaternion(this.barrelEnd.getWorldQuaternion(new THREE.Quaternion()));
    if(fwd.lengthSq() < 0.001){
      fwd.set(Math.sin(this.turretAngle), 0, Math.cos(this.turretAngle));
    } else {
      fwd.normalize();
    }
    return {pos:p, dir:fwd};
  }

  getWorldVelocity(){
    if(this._physBody){
      try {
        const v = this._physBody.linvel();
        return {x: v.x, z: v.z};
      } catch(e){}
    }
    return {x: this.vx, z: this.vz};
  }

  snapshot(){
    return {
      id:this.id, x:this.x, z:this.z, h:this.heading, t:this.turretAngle,
      /* THE TANK'S ALTITUDE, host-authoritative.

         Without it the observing client kept the height a net-driven tank had at
         SPAWN — _visualY was sampled once from the physics body and then cached
         forever, and nothing in the snapshot ever updated it. A player who drove
         up a hill was buried in that hill in everyone else's view while looking
         perfectly placed on their own screen (their own tank is physics-driven,
         so it rode the terrain locally).

         Only placed when the map has falling/gravity at all; on flat maps the
         client renders y=0 regardless. null, not 0, so the client can tell
         "no altitude sent" from "altitude 0". */
      /* For tanks the HOST drives kinematically from forwarded input (roster /
         party remote humans: no physics body, allowFall false) the altitude
         arrives with the input itself — the owner's own physics run is the only
         authority for it. Without this fallback the snapshot ships y=null and
         every observer draws that tank at y=0, i.e. buried inside the hill it
         is standing on. */
      y: this._allowFall ? (this.y || 0)
         : (typeof this._peerReportY === 'number' && isFinite(this._peerReportY)) ? this._peerReportY : null,
      sp:this.speed, hp:this.hp, alive:this.alive, dying:this.dying,
      dd:this.damageDealt, k:this.kills, as:this.assists||0, tank:this.def.id, name:this.name, col:this.color,
      cam:this.camoFactor, ally:this.allyId, pw:this.power, pl:this.placement||0, gt:this._gladHoldTime||0,
      /* TEAM, because a client cannot know it otherwise.

         The host decides sides — it picked the spawn point, and the spawn
         point's side is the team. Nothing about a snapshot position implies a
         team, so without this every tank a client learns about arrives with
         team undefined. That is not cosmetic: bot.js asks `me.team === t.team`
         to decide ally from enemy, the capture circle counts `t.team === 'blue'`
         to count who is inside, and the kill feed sorts on it. An undefined team
         made your friend read as a stranger on your screen even while you were
         both looking at the same tank.

         It is also the piece that makes the spawn-side mechanic legible: the
         side you spawned on arrives with your tank, in the same message. */
      team: this.team || null,
    };
  }
  applySnapshot(s){
    this.x=s.x; this.z=s.z; this.heading=s.h; this.turretAngle=s.t;
    this.speed=s.sp; this.hp=s.hp; this.alive=s.alive;
    this.damageDealt=s.dd; this.kills=s.k; if(s.as!=null) this.assists=s.as;
    /* Only ever set, never cleared: a snapshot from a mode with no teams at all
       (sandbox, free roam) leaves it alone rather than wiping a real value. */
    if(s.team) this.team = s.team;
    if(s.cam != null) this.camoFactor = s.cam;
    if(s.ally != null) this.allyId = s.ally;
    if(s.pl != null) this.placement = s.pl;
    if(s.pw != null) this.setPowerFromSnapshot(s.pw);
    if(s.gt != null) this._gladHoldTime = s.gt;
    this.root.visible=this.alive; this._syncTransform(); this._drawHp();
  }
  /* Network-driven tanks: movement follows interpolated host snapshots, drawn
     from a SAMPLE BUFFER at a fixed render delay (see applyNetSnapshot). */
  beginNetDriven(){
    this.netDriven = true;
    this._netBuf = null;
    this._netIntMs = 100;
  }
  applyNetSnapshot(s){
    const wasAlive = this.alive;
    // Causal state applies instantly; only movement is interpolated.
    this.hp = s.hp;
    this.alive = !!s.alive;
    this.dying = !!s.dying;
    this.damageDealt = s.dd;
    this.kills = s.k;
    if(s.as != null) this.assists = s.as;
    /* Same reasoning as applySnapshot: the host owns the sides, and this is how
       a client learns which one a tank it has never seen before is on. Without
       it, bot.js's ally test (`me.team === t.team`) and the capture circle's
       headcount both read undefined, so a teammate looks like an enemy. */
    if(s.team && this.team !== s.team){
      this.team = s.team;
      this._spawnHeading = (s.team === 'blue') ? 0 : Math.PI;
    }
    if(s.cam != null) this.camoFactor = s.cam;
    if(s.ally != null) this.allyId = s.ally;
    if(s.pl != null) this.placement = s.pl;
    if(s.pw != null) this.setPowerFromSnapshot(s.pw);
    if(s.gt != null) this._gladHoldTime = s.gt;
    this.root.visible = this.alive;
    this._drawHp();

    /* SNAPSHOT BUFFER INTERPOLATION.

       Every arriving sample is stored with its arrival time and (once its
       successor lands) the velocity of the interval it opens. The tank is
       DRAWN at `now - renderDelay` — a fixed step behind the newest sample —
       so between two stored samples the position is always a straight
       wall-clock lerp and nothing re-anchors.

       The old scheme re-lerped from the rendered spot toward the newest sample
       over a fixed 150 ms window on every arrival (~83 ms apart), so each
       window was cut short at a third of its span: the tank settled into a
       steady ~150 ms straggling distance, froze whenever a snapshot was late,
       then extrapolated and snapped. The render delay consumes the jitter
       instead: one late packet is invisible, a gap is a short coast on the
       measured velocity, and only a genuine teleport snaps. */
    const sy = (typeof s.y === 'number' && isFinite(s.y)) ? s.y : null;
    const now = performance.now();
    const buf = this._netBuf;
    const last = (buf && buf.length) ? buf[buf.length - 1] : null;
    /* Teleport check against the last STORED sample, not the rendered spot, so
       our own coasting can never look like a teleport. */
    const bigJump = last ? Math.hypot(s.x - last.x, s.z - last.z) > 4.5 : false;
    const stateFlip = wasAlive !== this.alive || !this.alive;
    if(!last || bigJump || stateFlip){
      /* First snapshot / teleport / respawn: seed the buffer and draw there. */
      this._netBuf = [{ at:now, x:s.x, z:s.z, h:s.h, t:s.t, y:sy, sp:null, vx:0, vz:0 }];
      this._netIntMs = 100;
      this.turretAngle = s.t;
      if(sy != null){ this._visualY = sy; if(this._allowFall) this.y = sy; }
      this.snapToPosition(s.x, s.z, s.h);
      return;
    }

    /* Velocity of the interval that STARTED at `last`, from the displacement
       between the last two samples, clamped against the reported speed so one
       late packet cannot double it. */
    const gapMs = Math.min(400, Math.max(20, now - last.at));
    this._netIntMs = this._netIntMs * 0.7 + gapMs * 0.3;
    const dt = gapMs / 1000;
    let vx = (s.x - last.x) / dt;
    let vz = (s.z - last.z) / dt;
    const sp = (typeof s.sp === 'number' && isFinite(s.sp)) ? s.sp : null;
    const vmax = sp != null ? sp * 1.75 + 10 : 70;
    const vmag = Math.hypot(vx, vz);
    if(vmag > vmax){ const f = vmax / vmag; vx *= f; vz *= f; }
    last.vx = vx; last.vz = vz; last.sp = sp;

    this._netBuf.push({ at:now, x:s.x, z:s.z, h:s.h, t:s.t, y:sy, sp, vx:0, vz:0 });
    if(this._netBuf.length > 24) this._netBuf.splice(0, this._netBuf.length - 24);
  }
  _netSmoothTick(){
    const buf = this._netBuf;
    if(!buf || !buf.length) return;
    /* The render delay: a little more than one snapshot interval keeps the
       render clock inside the two samples that bracket it for most arrivals,
       while the coasting below absorbs what remains. Measured end-to-end
       before tuning: ~180 ms of network plus this buffer — so buffer size has
       been the bigger half of the "remote players feel late" report. The old
       2.2x + 40 spent 223 ms at 12 Hz and 150 ms at 20 Hz just holding the
       two samples; at 1.45x the same cover costs 165 / 117 ms, with a dead
       band (1.45 * interval minus the next arrival's age) as the slack any
       single late packet is allowed to eat before coasting on measured
       velocity. Floors and ceiling stay near the old ones: a direct link
       never renders into the unsent future, and a starved relay never draws
       unbounded old truth. */
    const delay = Math.max(85, Math.min(240, this._netIntMs * 1.45 + 45));
    const rt = performance.now() - delay;
    const last = buf[buf.length - 1];
    let tx, tz, th, tt, ty;
    if(rt >= last.at){
      /* PAST THE LAST SAMPLE — coast on its measured velocity for at most
         0.25 s, then hold. One dropped packet rides through invisibly. */
      const over = Math.min((rt - last.at) / 1000, 0.25);
      tx = last.x + last.vx * over;
      tz = last.z + last.vz * over;
      th = last.h; tt = last.t; ty = last.y;
    } else {
      /* The sample pair bracketing the render time. Buffers are short, so one
         backward scan beats an index. */
      let a = buf[0], b = buf[1] || buf[0];
      for(let i = buf.length - 2; i >= 0; i--){
        if(buf[i].at <= rt){ a = buf[i]; b = buf[i + 1]; break; }
      }
      const span = (b.at - a.at) || 1;
      const k = Math.min(1, Math.max(0, (rt - a.at) / span));
      tx = a.x + (b.x - a.x) * k;
      tz = a.z + (b.z - a.z) * k;
      th = a.h + _angDiff(b.h, a.h) * k;
      tt = a.t + _angDiff(b.t, a.t) * k;
      ty = (a.y != null && b.y != null) ? (a.y + (b.y - a.y) * k)
         : (b.y != null ? b.y : a.y);
    }
    if(ty != null && isFinite(ty)){
      this._visualY = ty;
      if(this._allowFall) this.y = ty;
    }
    this.turretAngle = tt;
    /* WRITE THROUGH snapToPosition, not this.x: _syncTransform() reads x/z back
       out of the rigid body (for a simulated tank), so the interpolated value
       would be overwritten on the next line. For net-driven tanks it skips the
       physics world entirely and writes straight into the transform. */
    this.snapToPosition(tx, tz, th);
  }
}
