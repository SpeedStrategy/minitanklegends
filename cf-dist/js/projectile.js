/* ============================================================
   projectile.js — Shells + Helix flamethrower particles
   - Shell: travels, blocked by walls; flies OVER lakes (per spec)
   - Flame: short-lived particles, DPS at close range
   ============================================================ */

let _nextProjId = 1;

/* How long a shell is drawn, in world units, measured on the BULLET.

   CUT 4x ON REQUEST: 4.0 -> 1.0. The authored bullet is 2.51 long, so this is a
   uniform scale of 0.398 -- and it applies to the tracer planes too, which is
   the point of doing it with one factor. At SHELL_LENGTH 4.0 the assembly came
   out as a 4.0-long bullet with a 21.5-long streak behind it, five tank-lengths
   of tracer on a 4.4-long tank. At 1.0 that becomes a 1.0-long bullet with a
   5.4-long streak, which reads at distance without swamping the tank it came
   from.

   The authored width:length ratio (0.796) is preserved exactly. An earlier
   version scaled X and Z by a quarter of the Y factor to force the bullet
   slender, which did not fix anything -- it just stopped the shell looking like
   the model, and this constant is the only dial that should exist. */
const SHELL_LENGTH = 1.0;
/* THE TRACER PLANES ARE AUTHORED IN THE MODEL AND ARE NOT REBUILT HERE.
   See _adoptModel, which lifts them straight out of assets/TL_bullet.glb. An
   earlier version of this file generated its own pair of crossed quads because
   the model's planes were being discarded -- that was wrong, and the planes were
   in the file the whole time. */

/* ── THE MORTAR GETS ITS OWN SHELL ──────────────────────────────────────────
   assets/artilery_shell.glb, not assets/TL_bullet.glb.

   The Mortar is the only weapon on the roster that loes a shell rather than
   firing one, and until now it threw the same pale-yellow rifle bullet every
   other tank throws. At a distance, over a 1.9 second arc, that reads as a
   rifle round sailing over the rooftops: the shape says "this is a shell that
   will hit something" and the size says "this is a tracer". The two disagree,
   and the artillery is the one place in the game where the player has to trust
   the thing in the air to tell them where the shell is going.

   MORTAR_SHELL_LENGTH is the same idea as SHELL_LENGTH and nothing more: the
   finished body length in world units, measured on the BODY, with the tracer
   planes scaled by the identical factor so the two stay one object.

       2.4 is roughly 2.4x the rifle bullet and lands at about 0.53 of a world
       unit across, against the 0.7 collider the constructor gives an artillery
       shell. The round is drawn a little inside its own hitbox on purpose --
       a shell rendered exactly to its collider looks like a floating
       hemisphere at this scale. It is also about half a tank's length, so it
       stays readable on the arc without becoming the thing you are watching
       instead of the tank you are driving.

   The authored proportions are preserved exactly, as with the bullet: this is
   the only dial, and there is deliberately no cross-section squash. */
const MORTAR_SHELL_LENGTH = 2.4;

/* ── ARTILLERY ─────────────────────────────────────────────────────────────
   A lobbed shell, in the World of Tanks sense: it flies a BALLISTIC ARC, lands
   on a SPOT rather than on a target, and damages everything near that spot. It
   cannot hit anything inside its own minimum range, so the way to fight with
   one is to keep your distance and arc over cover — which is exactly why the
   tank that carries it is slow, thinly armoured and traverses like a shipping
   container.

   WHY THE SHELL FLIES A PRE-SOLVED VELOCITY INSTEAD OF dir * shellSpeed
   Every other shell in the game is "point at it, go". An artillery shell has
   to ARRIVE somewhere specific, so its velocity is solved backwards from the
   aim point: given a horizontal distance, a flight time and a gravity, both
   the launch speed and the launch angle are fixed. That velocity travels in
   the def as _launchVel and is what actually flies.

   The consequence, and the reason this is worth doing this way: because the
   flight is a closed-form parabola and is NOT simulated frame by frame, the
   arc the aim line draws and the arc the shell flies are the same curve. A
   shell integrated under gravity would drift off the drawn line by enough to
   miss a cluster it visibly touched, and artillery you cannot aim is just a
   tank that throws rocks.

   Gravity is therefore integrated by hand in Shell.update() and the shell gets
   NO physics body. That also buys the artillery behaviour for free: the shell
   passes over walls and scenery instead of being stopped dead by them, which
   is the entire reason to lob something in the first place. */
const MORTAR_GRAVITY = 34;      // world units / s^2

/* Solve the launch velocity that carries a shell `dist` units horizontally and
   `dropY` below the muzzle after `flight` seconds. (flatX, flatZ) is the unit
   GROUND direction to travel in. Returns a velocity in units/second, not a
   direction — divide out the length if that is what you want. */
function artilleryVelocity(flatX, flatZ, dist, flight, gravity, dropY){
  const T = Math.max(0.05, flight);
  const g = gravity || MORTAR_GRAVITY;
  const hx = dist / T;                                   /* horizontal speed  */
  const hy = (dropY + 0.5 * g * T * T) / T;             /* vertical speed    */
  return new THREE.Vector3(flatX * hx, hy, flatZ * hx);
}
/* Exposed because game.js solves the same arc to draw it on the aim line, and
   two independent copies of this parabola would eventually disagree by a
   metre — which is the difference between a direct hit and a near miss. */
if(typeof window !== 'undefined') window.artilleryVelocity = artilleryVelocity;

/* ── Shell orientation ─────────────────────────────────────────────────────
   The bullet is now a real 3D model (assets/TL_bullet.glb) instead of a
   textured quad, so it is aimed rather than laid flat.

   THE MODEL'S NOSE IS AT +Y, NOT -Y. Measured off the geometry rather than
   assumed, because getting this backwards flies every shell base-first and the
   tracer planes end up in front of the bullet:

       y = +1.000   radius 0.071   the pointed nose
       y = +0.764   radius 0.728   the body
       y = +0.196   radius 1.000   the casing
       y = -1.511   radius 1.000   the base rim

   An earlier version of this comment claimed the tip was at -1.51 and the flat
   base at +1 -- the reverse -- and _shNose was set to (0,-1,0) to match. Both
   were wrong, and the shells flew backwards. A radius profile is the only
   reliable way to tell a bullet's nose from its base; the Y extents alone do
   not say which end is which.

   So +Y is mapped onto the travel direction. The tracer planes need no
   correction at all: they are authored from y = -0.99 back to y = -14.5, which
   is already behind the bullet's base, so they are attached at the origin and
   left exactly where the artist put them.

   setFromUnitVectors is used rather than an Euler triple because the shell can
   fly at any pitch (a raised barrel, a ricochet upward). Composing yaw and lay
   quaternions, as the old quad did, only ever produced a horizontal shell and
   silently ignored dir.y. */
const _shFwd  = new THREE.Vector3();
const _shNose = new THREE.Vector3(0, 1, 0);
/* The orientation itself, split out of orientShellModel so the instanced
   batches can produce the IDENTICAL quaternion without standing a throwaway
   object up per shell per frame. There is exactly one +Y-is-the-nose rule in
   this file and it lives here; a second implementation in the batch rebuild
   would be free to drift away from it the moment someone tuned the fallback
   axis, and a shell that quietly stops pointing at where it is going is the
   kind of bug nobody reports, they just stop trusting the model. */
function orientShellQuat(out, dir){
  _shFwd.set(dir.x, dir.y, dir.z);
  if(_shFwd.lengthSq() < 1e-8) _shFwd.set(0, 0, 1);
  _shFwd.normalize();
  return out.setFromUnitVectors(_shNose, _shFwd);
}
function orientShellModel(mesh, dir){
  orientShellQuat(mesh.quaternion, dir);
}

class Shell {
  /* Every shell currently in flight, and now the second job it was already
     halfway doing: it is the list updateInstances walks to write the instanced
     draw batches, so a shell is in the world exactly when it is in this set and
     attached. Nothing keeps a parallel array in step with it, because a parallel
     array is one more thing that can disagree about whether a shell is alive.

     The bullet model arrives asynchronously, so shells that were built against
     the placeholder capsule need to be found and upgraded when it lands -- see
     _adoptModel. A plain array would do, but add/delete happens on every shot
     and this is on the firing path. */
  static _live = new Set();
  /* Bullets must not collide with each other.

     Every shell is a real Rapier body so it can hit walls and tanks, and two
     dynamic bodies meeting each other BOUNCE — so two bullets crossing fired
     at each other used to ricochet off one another mid-air, which is not how
     a tank game is supposed to behave.

     Rapier's interaction groups are one 32-bit number: the high half says
     which group this collider IS, the low half says which groups it may
     touch. Membership 0x0002 with filter 0xFFFD therefore still meets walls,
     tanks, boxes and debris (they are all in the default 0xFFFF group) while
     the shell group explicitly filters ITSELF out, so no shell ever touches
     another shell. */
  static get COLLISION_GROUPS(){ return 0x0002FFFD; }

  constructor(owner, pos, dir, def, physicsWorld, inheritVel){
    this.id = 'p' + (_nextProjId++);
    this.owner = owner;
    this.x = pos.x; this.y = pos.y; this.z = pos.z;
    this.dir = dir.clone().normalize();
    /* `inheritVel` is accepted and then deliberately NOT applied. It is the tank's
       whole world velocity, and adding it to the shell's own is what made bullets
       fly sideways whenever the player strafed. Kept in the signature so every
       call site reads the same; see the long note where _inheritX is set. */
    const iv = inheritVel || {x:0, z:0};
    void iv;

    /* ARTILLERY. See the note above artilleryVelocity(): a lobbed shell is
       handed a solved velocity rather than a direction plus a speed, because
       arriving somewhere specific is the whole point of it. */
    this._isMortar = def.shellType === 'mortar';
    if(this._isMortar){
      this._vel = (def._launchVel || new THREE.Vector3(dir.x, dir.y, dir.z)).clone();
      this.speed = this._vel.length();
      this._baseSpeed = this.speed;
      /* No tank momentum. The arc is a closed form solved from the muzzle, and
         inheriting the hull's velocity would slide the shell off the point the
         player was shown and aimed at. */
      this._inheritX = 0; this._inheritZ = 0;
      /* Flight time is the def's, NOT shellRange/speed: the distance covered is
         chosen by the player's aim, not by a stat, so deriving life from the
         range would cut the shell off in mid-air on a long shot. The extra
         slack means the ground test below is what ends the flight, not the
         clock — the shell is never removed still in the air. */
      this.life = (def.artilleryFlight || 1.9) + 0.4;
      this.maxLife = this.life;
      /* Blast only. A mortar's "direct hit" is its splash — that is the
         trade the whole design rests on, so there is no separate impact
         number stacked on top of it. */
      this.damage = 0;
      const pm = owner && owner.powerMult ? owner.powerMult() : 1;
      this.splashDamage   = Math.round((def.splashDamage   || 0) * pm);
      this.splashMinDamage = Math.round((def.splashMinDamage|| 0) * pm);
      this.splashRadius   = def.splashRadius || 12;
      this.gravity        = def.artilleryGravity || MORTAR_GRAVITY;
      this._detonated     = false;
    } else {
    /* `shellSpeed` in config.js is authored high (it was doubled when the
       ranges were retuned), so the shell that actually flies is a fraction
       of it. 2.25 = the original 1.5x cut, applied again on request —
       the live speed is now 180/2.25 = 80 for a normal tank, which is a
       shade under the 90 the game shipped with, and 1.5x slower than the
       120 the player was seeing. */
      const SPEED_DIV = 2.25;
      this.speed = def.shellSpeed / SPEED_DIV;
      this._baseSpeed = def.shellSpeed / SPEED_DIV;
      /* NO HULL MOMENTUM. The shell leaves the barrel at exactly `speed` along
         exactly `dir` — it goes where the barrel points, every time.

         It used to be given the tank's whole world velocity and added on top of
         the shell's own. `getWorldVelocity()` returns the rigid body's full
         linvel, which includes every lateral component — strafing, sliding on a
         slope, being knocked about by another tank — and none of it is removed
         again:

           * on the physics path, _initPhysBody baked `dir*speed + inherit` into
             the body's linvel, where it stayed for the whole flight with no drag
             to bleed it off. The shell therefore travelled in a PERMANENTLY
             altered direction, and the aim line the player was looking at was
             simply not where the shell went. Fire forward while strafing left
             and the shell flew forward AND left, off the target, forever.

           * on the fallback path (no Rapier body) the same numbers were added
             for a single frame and then zeroed, which is a different bug
             producing the same symptom: the shell took one sideways step at the
             muzzle and then flew straight from that offset point. A visible
             kink at the barrel.

         Two paths, two different behaviours, one shared complaint — and both are
         "the bullet does not go where I am aiming".

         Inheritance is also wrong against the shell's own range. `life` is
         derived from shellRange at a fixed speed (see below), so any inherited
         velocity makes the shell carry past the range the tank advertises and
         then expire in mid-air, having silently stopped short of where the
         crosshair promised a hit.

         The mortar already worked this way — it is handed a solved velocity and
         told to forget the hull's — and it is why artillery hits what you point
         it at. Direct fire now behaves the same way.

         `iv` is deliberately discarded: the constructor signature and every call
         site stay exactly as they were, and the value simply no longer gets to
         bend the trajectory.

         The two fields are set to 0 rather than left unset, because BOTH
         integrators below read them — `_initPhysBody` and the no-body fallback
         — and `dir.x * speed + undefined` is NaN, which would put the shell at
         NaN coordinates on its first frame and silently delete it. */
      this._inheritX = 0; this._inheritZ = 0;
      this.damage = Math.round((def.damage||34) * (owner && owner.powerMult ? owner.powerMult() : 1));
      /* EVERY shell carries its blast numbers, not just the artillery ones.

         These were assigned only inside the `isMortar` branch above, so any
         other tank declaring `splashDamage` got a projectile with
         `splashDamage === undefined` — and the impact guards that read it
         (`> 0`) are false for undefined, so a direct-fire burst shell would
         quietly deal point damage and no blast at all. Grom is exactly that
         tank: splash 5, damage 26, and no blast whatsoever.

         Defaults are 0 rather than the mortar's fallbacks, because a shell with
         no splash on its def must still be able to reach _detonate (the wall
         and ground tests) without suddenly exploding with a 12m radius. */
      const pm2 = owner && owner.powerMult ? owner.powerMult() : 1;
      this.splashDamage    = Math.round((def.splashDamage    || 0) * pm2);
      this.splashMinDamage = Math.round((def.splashMinDamage || 0) * pm2);
      this.splashRadius    = def.splashRadius || 0;
      this._detonated      = false;
      // The shell flies at `speed` (= shellSpeed/2.25), so life has to be worked
      // out from the speed it really moves at — otherwise it died after
      // shellRange/1.5 metres and fell a third short of what the aim line draws.
      // Horizontal factor keeps the XZ travel equal to shellRange even on a
      // slightly raised barrel.
      const _hz = Math.hypot(this.dir.x, this.dir.z) || 1;
      /* RANGE LIMITS GONE ("almost"). Every direct shell now flies up to
         SHELL_MAX_RANGE metres (~500), whatever its tank def used to say —
         the old per-tank range kept players stuck at the map's own walls
         while the aim line promised further. The shell still ends by
         hitting something, expiring, or leaving the map — see the
         off-map cull in update(). Speed 0 is a def bug, not a shell; give
         it a sane short life rather than dividing-infinity. */
      const _maxR = (typeof CONFIG !== 'undefined' && CONFIG.SHELL_MAX_RANGE) || 500;
      this.life = this.speed > 0.5 ? (_maxR / Math.max(1e-3, this.speed * _hz)) : 0.4;
      this.maxLife = this.life;
    }
    this.dead = false;
    this.type = 'shell';
    this.radius = this._isMortar ? 0.7 : 0.4;   /* a shell big enough to lob is
                                                  also a shell worth a fatter
                                                  hitbox when it lands on top
                                                  of somebody. */
    /* Read the pellet flag from the def, because by the time a caller could set
       this._isShotgunPellet directly the mesh would already be built. The old
       code set it after construction, which meant the pellet sphere was never
       actually used — every pellet quietly got the full-size shell quad. Taking
       it from the def is what makes the flag mean anything. */
    this._isShotgunPellet = !!def._isShotgunPellet;
    /* A TUMBLING SPLASH ROUND. `shellSpin` (rad/s) is read here, in the
       constructor, for the same reason the pellet flag is: the mesh is built in
       _build and the spin is applied from the first update, so a value set after
       construction would miss every frame the player actually sees.

       Grom's is a different object from the standard tracer — a squat HE round
       that tumbles end over end the whole way down. A clean tracer reads as a
       rifle shot; a spinning one reads as "this is the shell that bursts", which
       is the entire tell the tank needs at 40 metres. */
    this._spin = (def.shellSpin || 0);
    this._spinAngle = 0;
    /* Captured here rather than read from `def` in _build, which does not have
       the def in scope — it is handed no arguments at all. */
    this._shellScale = (def.shellScale || 1);
    this._physBody = null;
    this._physWorld = this._isMortar ? null : (physicsWorld || null);
    this._hitByPhysics = false;
    this._initPhysBody();
    this._build();
  }

  _initPhysBody(){
    if(!this._physWorld || typeof RAPIER === 'undefined') return;
    try {
      var desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(this.x, this.y, this.z)
        .setGravityScale(0)
        .setCcdEnabled(true);
      this._physBody = this._physWorld.createRigidBody(desc);
      var col = this._physWorld.createCollider(
        RAPIER.ColliderDesc.ball(this.radius).setCollisionGroups(Shell.COLLISION_GROUPS),
        this._physBody
      );
      if(col && typeof col.setActiveEvents === 'function'){
        col.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      }
      col.userData = {type:'shell', shell:this};
      /* Straight down the barrel. The `_inherit*` terms are still written so the
         shape of the integrator is unchanged and stays readable next to the
         fallback below, but both are 0 by construction — the constructor
         refuses to bend the shell's direction. See the note there: Rapier holds
         this velocity for the entire flight with no drag, so anything added here
         is a PERMANENT change of heading, which is what made shells drift
         sideways whenever the tank was moving sideways. */
      var vx = this.dir.x * this.speed + this._inheritX;
      var vy = this.dir.y * this.speed;
      var vz = this.dir.z * this.speed + this._inheritZ;
      this._physBody.setLinvel({x: vx, y: vy, z: vz}, true);
    } catch(e){ this._physBody = null; }
  }

  /* ============================================================================
     THE SHELL IS NOW A MODEL, NOT A SPRITE

     It used to be a 6.0 x 2.0 textured quad (assets/TL_bullet.png) with a
     canvas-baked glow halo painted around it. Both are gone: the bullet is
     assets/TL_bullet.glb, a real shell mesh, and the trace that used to be
     streaked behind it is gone with it.

     THE MORTAR IS THE ONE EXCEPTION, and it is not really an exception: it is
      a second weapon with its own round. See MORTAR_SHELL_LENGTH for why, and
      _adoptArtModel for the file.

      THE MODEL IS A BULLET AND TWO TRACER PLANES, AND BOTH ARE DRAWN
     ------------------------------------------------------------
     The file used to ship here as three separate meshes:

         Cylinder      the shell itself -- keep
         trace         a flat quad, the tracer streak -- DROP
         trace.001     a second copy of the same quad -- DROP

     An intermediate version dropped both trace quads outright, so a shell drew
     as a bare bullet with nothing behind it.

     assets/TL_bullet.glb (TL_bullet_f) is ONE glTF mesh carrying TWO primitives,
     which GLTFLoader hands back as two THREE.Mesh objects:

         Cylinder001_1   the bullet  34 verts, 44 triangles, pale yellow #ffef72,
                         2.51 long on Y -- nose at +1.0, base rim at -1.5
         Cylinder001_2   the tracer   8 verts,  4 triangles, white, 13.51 long,
                         and those 4 triangles ARE the two crossed flat quads:
                         four vertices on the plane z = -0.054 and four on x = 0

     So the two planes are still in the file -- they were only ever renamed. That
     is why matching on the name "trace" stopped working: a Blender re-export
     renames the nodes, which is exactly what happened here. _adoptModel picks the
     bullet by triangle count instead (44 against 4) and treats everything else as
     tracer, which survives a rename, a reorder, or a re-export.

     THE 15.5 IN THE LOADER COMMENT BELOW IS NOT THE BULLET. It is the Y extent of
     the whole file, bullet plus planes. The bullet on its own is 2.51 long, and
     that is the number SHELL_LENGTH is measured against.

     WHY THE LOAD IS ASYNCHRONOUS AND WHY THAT IS HANDLED

     A GLB cannot be read synchronously, but shells are constructed
     synchronously from inside the firing code, so something has to exist the
     instant a tank pulls the trigger. So:

       * a plain capsule stands in immediately, so a shell is NEVER invisible;
       * when the real model arrives, every live shell has its geometry and
         material swapped in place -- _live is the set that makes that possible.

     The alternative (queue shells until the model loads) was rejected: it
     delays the first shot of a match by the length of the download, and a
     shell that appears late has visibly left the barrel after the shot.

     ONE GEOMETRY AND ONE MATERIAL FOR THE WHOLE MATCH, still. The model's
     meshes and materials are shared, not cloned per shell -- see _loadModel,
     which takes the first mesh's geometry and material and keeps them for
     every shell in the match, exactly as the old shared quad was. */
  static _initShared(){
    /* The tail default has to be set BEFORE the early return below, and that
       ordering was a real bug once already. The guard returns as soon as the
       shared bullet geometry and material are both set -- and _adoptModel sets
       them WITHOUT going through this function, because it runs from the GLB's
       load callback. So on a page where the model finished loading before the
       first shot, the guard was already satisfied and everything after it was
       skipped. Anything _initShared owns has to be established above that guard.

       THE GUARD IS NOW OVER BOTH SETS, because there are two sets. It could not
       simply become two early returns: whichever one fired first would skip the
       other's initialisation forever on exactly the page this bug was about, a
       page where the models arrived before the first shot. So it stays one
       guard, and each half below owns its own sub-guard.

       The tracer itself is NOT built here: it comes out of the model in
       _adoptModel, because it is drawn from the file rather than generated. */
    if(!Shell._bulletTailY) Shell._bulletTailY = 1.37;

    if(Shell._sharedGeo && Shell._sharedMat && Shell._artGeo && Shell._artMat) return;
    /* The bullet half, unchanged. */
    if(Shell._sharedGeo && Shell._sharedMat) { /* already adopted */ } else {
    if(!Shell._bulletGeo){
      /* Fallback while the model is in flight: a capsule about the right size
         and along the right axis, so orientation and scale are already correct
         and the swap is invisible. */
      const g = new THREE.CapsuleGeometry(0.42, 1.9, 4, 10);
      Shell._bulletGeo = g;
      Shell._bulletMat = new THREE.MeshBasicMaterial({ color: 0xffd24a });
    }
    Shell._sharedGeo = Shell._bulletGeo;
    Shell._sharedMat = Shell._bulletMat;
    Shell._ensureModel();
    }
    /* THE ARTILLERY HALF, identical in shape. Its placeholder is a capsule too,
       sized to MORTAR_SHELL_LENGTH rather than SHELL_LENGTH, because a shell
       that arrives as a rifle bullet and then becomes an artillery shell is a
       visible pop -- the swap is meant to be invisible, and matching the real
       model's footprint is what makes it so.

       0.26 radius + 1.88 body = 2.40 overall, which is MORTAR_SHELL_LENGTH. */
    if(Shell._artGeo && Shell._artMat) { /* already adopted */ } else {
      if(!Shell._artBody){
        Shell._artBody = new THREE.CapsuleGeometry(0.26, 1.88, 6, 12);
        Shell._artBodyMat = new THREE.MeshBasicMaterial({ color: 0xd8452c });
      }
      Shell._artGeo = Shell._artBody;
      Shell._artMat = Shell._artBodyMat;
      Shell._ensureArtModel();
    }
  }

  /* Which set of shared geometry/materials a given shell draws with. Every shell
     in the game is one of exactly two families -- the rifle bullet and the
     artillery round -- and this is the only place that decision is written down.

     A SHELL'S FAMILY IS FIXED AT BIRTH and can never change. `_isMortar` is read
     off the def in the constructor, before _build runs and before anything can
     flip it, and that is what makes this safe to call at any point in a shell's
     life rather than at _build only: _addTracer runs again from _adoptModel when
     a late-arriving model has to be handed to a shell already in flight, and by
     then the mesh exists but the choice cannot have changed. */
  static _kit(isMortar){
    return isMortar
      ? { geo: Shell._artGeo, mat: Shell._artMat, traceGeo: Shell._artTraceGeo, traceMat: Shell._artTraceMat }
      : { geo: Shell._sharedGeo, mat: Shell._sharedMat, traceGeo: Shell._traceGeo, traceMat: Shell._traceMat };
  }

  /* ============================================================================
     ONE DRAW CALL PER FAMILY, NOT ONE PER SHELL

     Nothing about a shell is per-shell except its transform. The geometry is one
     shared BufferGeometry object for every shell that draws it and so is the
     material -- they have been shared for the whole life of this file -- and
     _kit above is what guarantees there are only ever two such pairs. An
     InstancedMesh is exactly a transform per copy, so a shell's position, nose
     direction and scale go into a matrix attribute and the GPU reads the whole
     lot in one draw.

     Fifty shells in the air is fifty draw calls and fifty objects for the
     renderer to matrix, frustum-test, sort and check state on every frame, plus
     a second fifty for the tracer planes. It becomes two draw calls and two
     objects. The matrix rewrite itself is unavoidable -- a shell in flight
     moves, so its transform is stale the instant it is written -- but it now
     lands in one Float32Array the driver uploads once, instead of N uniform
     uploads behind N state changes.

     WHAT A SHELL STILL OWNS: a transform, and nothing else.

     `this.mesh` is a plain Object3D that is never added to any scene. That is
     deliberate and it is not laziness. game.js drives a networked shell's
     transform through this.mesh -- it writes mesh.position and calls
     mesh.lookAt on it -- and a reimplementation of those writes inside the
     rebuild would have to be kept in step with a call site in another file for
     as long as both of them exist. An Object3D is the smallest object that
     keeps mesh.position, mesh.quaternion, mesh.scale, mesh.rotateY and
     mesh.lookAt behaving exactly as they did, it is not in the graph so it
     costs no traversal and no draw call, and the batch reads the very same
     three components three.js would have composed for a real Mesh. What the
     batch puts on screen is therefore what used to be put on screen.

     SLOT COUNTS, and why they are not a limit anyone will hit.

         rifle      160    Ten tanks, and a shotgun tank throws ten pellets
                           (config.js, `pellets:10`), so a full team firing in
                           the same frame is a hundred shells in the air at
                           once. 160 leaves room for reload overlap and for
                           ricochets, which re-fly a shell at reduced life
                           rather than ending it.
         artillery   48    Only the Mortar lobs, a team is five, and its reload
                           is longer than the shell's whole flight, so the real
                           ceiling is a handful.
         casings     24    game.js already caps concurrent casings at 18.

     A slot is sixteen floats, so a rifle batch is 10 KB of matrix buffer and an
     artillery batch 3 KB, and `count` is set to the number of live shells every
     frame, so an empty slot costs address space and nothing else. A shell that
     cannot get a slot is not drawn that frame. That is the whole of the
     over-capacity behaviour, and it is the same one LandmineManager has always
     had with its 30 slots -- an over-capacity frame drops drawing, not state:
     the shell still flies, still collides and still detonates, it just is not on
     screen.

     THE MISSING-CALL-SITE HAZARD IS REAL AND IT IS NOT GUARDED AGAINST HERE.
     updateInstances is the only thing that writes the matrix buffer, and if
     nothing calls it the shells freeze where they were last written. It has to
     be called once per frame from the projectile tick in game.js; see the note
     on updateInstances for exactly where. */
  static _RIFLE_SLOTS = 160;
  static _ARTILLERY_SLOTS = 48;

  /* Called once each time a bullet / artillery GLB is ADOPTED -- i.e. at the
     moment the placeholder capsule is replaced by the material the shells will
     really be drawn with for the rest of the match.

     game.js hangs a shader pre-compile off this, and the ORDER is the entire
     point. _initShared() puts a MeshBasicMaterial capsule in place so a shell
     can be built synchronously before its file has landed, and warming THAT
     material compiles the wrong program: the real bullet is a
     MeshStandardMaterial and compiles its own. Warming before the file arrives
     measures as 447ms on the first shot; warming after it, the same volley
     peaks at 49ms. Nine programs, all of them created at adoption time.

     Set by game.js, called with no arguments, must not throw. Left unset, the
     only cost is the first-shot stall this exists to remove. */
  static onModelsAdopted = null;
  /* { scene, rifle:{body,trace}, art:{body,trace} } -- built on first attach,
     because that is the first moment a scene is known. */
  static _batches = null;
  /* The one scratch the rebuild path needs. A Matrix4 per shell per frame is
     160 x 64 bytes of garbage at 60fps, 600 KB/s of churn for numbers that are
     overwritten before anything reads them. No Vector3 or Quaternion sits beside
     it on purpose: compose() only READS the three it is handed, so the shell's
     own components go straight in rather than through a copy. */
  static _instMat = new THREE.Matrix4();

  static _mkBatch(geo, mat, slots){
    const im = new THREE.InstancedMesh(geo, mat, slots);
    /* DynamicDrawUsage: the buffer is rewritten every frame, and STATIC_DRAW
       tells the driver the contents will not change -- which on some drivers is
       the difference between an upload and a buffer the driver has quietly
       stopped expecting to re-read. */
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /* frustumCulled OFF. An InstancedMesh's bounding sphere is computed from
       whichever instances existed when it was computed, and setMatrixAt does not
       refresh it -- so a sphere baked around the first shell ever fired culls
       every shell fired after it, visibly, as rounds vanishing mid-arc the
       instant they leave the neighbourhood of that first one. Recomputing it
       every frame would mean re-reading sixteen floats per instance per frame
       to protect a scene that holds a few dozen shells. */
    im.frustumCulled = false;
    im.castShadow = false;
    im.receiveShadow = false;
    im.count = 0;
    return im;
  }

  /* Point one family's batches at whatever the shared sets currently are, and
     create the tracer batch the first time the planes exist.

     THE TRACER BATCH IS CREATED LATE rather than up front against a null
     geometry. Both placeholders have no tracer until their file lands, and a
     shell fired in the first moments of a match has to draw as a bare bullet
     with no streak -- exactly as it did before instancing, and exactly as
     _addTracer's own guard has always allowed. */
  static _syncBatch(slot, isMortar, scene){
    const kit = Shell._kit(isMortar);
    const max = isMortar ? Shell._ARTILLERY_SLOTS : Shell._RIFLE_SLOTS;
    if(!slot.body){
      /* No shared geometry yet cannot happen for a shell -- _build ran
         _initShared first -- but the guard is free, and it is the difference
         between a missing model and a thrown TypeError on the firing path. */
      if(!kit.geo || !kit.mat) return;
      slot.body = Shell._mkBatch(kit.geo, kit.mat, max);
      scene.add(slot.body);
    } else {
      /* Re-pointed on every sync, not only when the identity has changed. This
         is the one place that knows _adoptModel may have replaced the shared set
         underneath a live batch, and a batch left pointing at a geometry that
         has since been disposed draws nothing at all. */
      slot.body.geometry = kit.geo;
      slot.body.material  = kit.mat;
    }
    if(!kit.traceGeo) return;
    if(!slot.trace){
      slot.trace = Shell._mkBatch(kit.traceGeo, kit.traceMat, max);
      scene.add(slot.trace);
    } else {
      slot.trace.geometry = kit.traceGeo;
      slot.trace.material  = kit.traceMat;
    }
  }

  /* Everything that can change what a batch is POINTING AT comes through here:
     the first attach, a scene swap, and a GLB landing. Called from _ensureBatches
     on every attach -- which is a handful of reference assignments once the
     batches exist -- and once from each adopt function.

     Nothing else re-syncs, and nothing else needs to. attach() and detach()
     change WHO is in the buffer, and the buffer is rebuilt from Shell._live
     from scratch every frame, so there is nothing about membership to
     invalidate. That is also why neither of them sets a dirty flag: a flag that
     updateInstances consulted would either gate the matrix rewrite, which cannot
     be skipped because a shell in flight has moved, or gate the re-sync, which
     those two functions have no reason to ask for. */
  static _syncBatches(){
    const B = Shell._batches;
    if(!B || !B.scene) return;
    Shell._syncBatch(B.rifle, false, B.scene);
    Shell._syncBatch(B.art,   true,  B.scene);
  }

  /* Make sure the batches exist in the scene a shell is being attached to.
     LandmineManager does this for the same reason: the game builds exactly one
     THREE.Scene for the lifetime of the page (game.js constructs it once, in the
     Game constructor, and _resetArena never replaces it), so the batches are
     made once and kept. The swap branch is here anyway, because a batch left
     parented to a dead scene is invisible in a way that is very hard to read off
     a screenshot -- and it has to MOVE the batches, not just forget the old
     scene, or the shells go on being written into a buffer nothing is drawing
     from. */
  static _ensureBatches(scene){
    if(!scene || !scene.add) return null;
    if(!Shell._batches){
      Shell._batches = { scene:null, rifle:{body:null,trace:null}, art:{body:null,trace:null} };
    }
    const B = Shell._batches;
    if(B.scene !== scene){
      for(const slot of [B.rifle, B.art]){
        for(const key of ['body','trace']){
          /* add() re-parents: Object3D.add calls removeFromParent() on whatever
             it is given, so this moves the batch rather than duplicating it. */
          if(slot[key]) scene.add(slot[key]);
        }
      }
      B.scene = scene;
    }
    /* Idempotent, so it is safe on every attach rather than only the first: four
       reference assignments once the batches exist, and it is what CREATES the
       tracer batch the moment a GLB lands. */
    Shell._syncBatches();
    return B;
  }

  /* Rewrite both families' instance matrices from the live shells and set each
     batch's count to the number it actually got.

     ONE CALL PER FRAME, FROM game.js, AFTER the projectile loop has ticked AND
     swept. The position is not a style preference. The sweep is what calls
     detach() on the shells that died this frame, and detach() is what takes them
     out of Shell._live -- so a call made before the sweep would rebuild the
     buffer from a set that still contains corpses, and every shot down would
     leave its round hanging in the air for one frame.

     NOTHING IN THIS FILE CALLS IT, and it could not be made to. three.js
     uploads the instanceMatrix buffer from WebGLObjects.update(), which runs
     during projectObject() -- that is, BEFORE Object3D.onBeforeRender. A rebuild
     hooked to onBeforeRender would therefore write matrices the driver had
     already finished reading for this frame and would appear one frame late,
     every frame, forever. At the live speed of a direct-fire shell, 80 units a
     second, that is 1.3 units of lag per frame at 60fps: a visible smear
     trailing every round and a ricochet that visibly leaves the hull after the
     shell that caused it. So the call is explicit, and it goes in game.js:

         Shell.updateInstances();

     immediately after the dead-projectile sweep, alongside the LandmineManager
     update that already sits there doing the identical job for the mines.

     WHY ShellCasing.updateInstances() IS CALLED FROM HERE. Both batches are
     rebuilt out of the same per-frame tick -- game.js updates projectiles and
     then casings, a few lines apart -- and the frame loop is the last place in
     this codebase that should be carrying two nearly identical calls whose
     omission is completely silent. One call, one place to forget. */
  static updateInstances(){
    const B = Shell._batches;
    if(B){
      const rifle = B.rifle, art = B.art;
      const m = Shell._instMat;
      let nR = 0, nRT = 0, nA = 0, nAT = 0;
      for(const sh of Shell._live){
        /* A shell that was constructed but never attached is in the live set and
           must not be drawn: before instancing it simply was not in the scene.
           Construct-then-attach happens inside one frame everywhere in game.js,
           so this is a guard, not a hot path. */
        if(!sh.mesh || !sh._inScene) continue;
        /* compose() is what Object3D.updateMatrix does internally, which is what
           the renderer used to do with this shell's own Mesh -- same position,
           same quaternion (written by orientShellModel, or by game.js's lookAt
           on a shell the host is driving), same _baseScale. */
        m.compose(sh.mesh.position, sh.mesh.quaternion, sh.mesh.scale);
        if(sh._isMortar){
          if(art.body && nA < Shell._ARTILLERY_SLOTS) art.body.setMatrixAt(nA++, m);
          /* THE TRACER MATRIX IS THE SHELL MATRIX. In the old code the planes
             were a CHILD of the shell mesh with an identity local transform, so
             their world matrix was the shell's world matrix; a pellet's 0.34
             scale scaled them too, because they inherited it. Composing the
             same matrix into the tracer batch reproduces that exactly. */
          if(sh._tracerOn && art.trace && nAT < Shell._ARTILLERY_SLOTS) art.trace.setMatrixAt(nAT++, m);
        } else {
          if(rifle.body && nR < Shell._RIFLE_SLOTS) rifle.body.setMatrixAt(nR++, m);
          if(sh._tracerOn && rifle.trace && nRT < Shell._RIFLE_SLOTS) rifle.trace.setMatrixAt(nRT++, m);
        }
      }
      if(rifle.body){ rifle.body.count = nR; rifle.body.instanceMatrix.needsUpdate = true; }
      if(rifle.trace){ rifle.trace.count = nRT; rifle.trace.instanceMatrix.needsUpdate = true; }
      if(art.body){ art.body.count = nA; art.body.instanceMatrix.needsUpdate = true; }
      if(art.trace){ art.trace.count = nAT; art.trace.instanceMatrix.needsUpdate = true; }
    }
    /* OUTSIDE THE GUARD, DELIBERATELY. A batch that does not exist yet means no
       shell has ever been attached, and a shell that has never been attached has
       no casings either -- but a casing batch is created by _build rather than
       by attach, so it is the one thing here that can exist before the shell
       batches do. Short-circuiting here would leave it frozen for a frame. */
    ShellCasing.updateInstances();
  }

  /* Kick the GLB off exactly once. Safe to call from every shell. */
  static _ensureModel(){
    Shell._ensureModelFor('assets/TL_bullet.glb?v=3', '_modelLoading', '_modelLoaded', '_adoptModel');
  }

  /* The artillery round, same contract as _ensureModel. Separate method so the
     two loads cannot collide on a shared "loading" flag. */
  static _ensureArtModel(){
    Shell._ensureModelFor('assets/artilery_shell.glb?v=1', '_artLoading', '_artLoaded', '_adoptArtModel');
  }

  /* Shared loader plumbing: one in-flight request per key set, exactly once, and
     a failure leaves whatever placeholder is already in place rather than
     blanking the shells. `_build` has to run synchronously from the firing code,
     so the placeholder has to exist before this returns -- which is why a
     missing GLTFLoader is not fatal here, only a missing shell. */
  static _ensureModelFor(url, loadingKey, loadedKey, adopt){
    if(Shell[loadingKey] || Shell[loadedKey]) return;
    Shell[loadingKey] = true;
    let loader = null;
    try { loader = (typeof Models !== 'undefined') ? Models.loader() : null; } catch(e){}
    if(!loader || typeof THREE.GLTFLoader === 'undefined'){
      try { loader = new THREE.GLTFLoader(); } catch(e){ loader = null; }
    }
    if(!loader){ Shell[loadingKey] = false; return; }   /* stay on the capsule */
    try {
      /* Versioned, because the file keeps its name across edits and a browser
         that has already loaded the old bytes keeps them for the session --
         replacing a .glb in place cannot break that. Bump the number when the
         model changes. (v3 = TL_bullet_f: one mesh, two primitives -- a bullet
         and two crossed tracer planes, both drawn. The bullet is 2.51 long on
         Y; the 15.5 older comments quoted was the whole file, planes included.
         See the note above.)

         The url is a parameter rather than a literal because the artillery
         round needs the same version-busting treatment for the same reason --
         replacing a .glb in place cannot break a browser that has already read
         the old bytes -- and duplicating the loader to get it was not worth a
         second copy of the error handling. */
      loader.load(url, (gltf) => {
        Shell[loadingKey] = false;
        Shell[loadedKey] = true;
        Shell[adopt](gltf);
      }, undefined, (err) => {
        Shell[loadingKey] = false;
        console.warn('[Shell] ' + url + ' failed, keeping the placeholder', err);
      });
    } catch(e){
      Shell[loadingKey] = false;
      console.warn('[Shell] ' + url + ' could not be requested', e);
    }
  }

  /* Pull the bullet AND its tracer planes out of the loaded file, then hand both
     to every shell that is already flying. */
  static _adoptModel(gltf){
    const root = gltf && gltf.scene;
    if(!root) return;

    /* THE FILE IS A BULLET AND TWO TRACER PLANES. BOTH ARE USED.

       Measured off assets/TL_bullet.glb (TL_bullet_f), one mesh with two
       primitives, which GLTFLoader hands back as two THREE.Mesh objects:

         Cylinder001_1   the bullet      34 verts, 44 triangles, pale yellow
                                          2.51 long on Y, nose at +1.0, base
                                          rim at -1.5
         Cylinder001_2   the tracer       8 verts,  4 triangles, white,
                                          13.51 long on Y -- and those 4
                                          triangles are exactly two crossed
                                          flat quads: four vertices on the plane
                                          z = -0.054 and four on x = 0

       NEITHER IS NAMED "trace" ANY MORE, which is the whole bug this replaces.
       An earlier version of this function took "the first mesh that is not a
       trace" and threw the rest away, so the planes were silently discarded --
       and then a later version generated replacement planes from scratch,
       having wrongly concluded from the vertex count that the second primitive
       was a cone. It never was. The authored planes were in the file throughout.

       SO THE BULLET IS PICKED BY TRIANGLE COUNT, NOT BY NAME OR BY ORDER. A
       solid bullet body always has more triangles than a pair of flat quads (44
       against 4 here), and that holds however the file is re-exported or
       reordered. Everything that is not the bullet is the tracer.

       Matching on the name "trace" was never going to keep working, because a
       Blender re-export renames the nodes -- that is precisely what happened
       between the version that shipped trace / trace.001 and this one. */
    const all = [];
    root.traverse((o) => { if(o.isMesh && o.geometry) all.push(o); });
    if(!all.length){
      console.warn('[Shell] bullet model had no usable mesh; keeping the capsule');
      return;
    }
    const triCount = (o) => {
      const g = o.geometry;
      return (g.index ? g.index.count : g.attributes.position.count) / 3;
    };
    let mesh = all[0];
    for(const o of all) if(triCount(o) > triCount(mesh)) mesh = o;
    const tracerMeshes = all.filter((o) => o !== mesh);

    const geo = mesh.geometry;
    /* ONE UNIFORM SCALE FOR THE WHOLE FILE.

       SHELL_LENGTH is the finished bullet length in world units, whatever the
       model is authored at, so the factor is derived from the bullet and then
       applied to the bullet AND the planes together. The two must move together:
       they were drawn as one object, and scaling them independently is what
       produced a bullet that stopped resembling the model at all.

       NO CROSS-SECTION SQUASH. An earlier version scaled X and Z by a quarter of
       the Y factor to force the bullet slender. That was not a fix, it was the
       model being redrawn: the shell stopped looking like the thing in the file,
       which is the one thing this code is supposed to guarantee. The bullet is
       authored 2.51 long and 2.0 across, so at SHELL_LENGTH it comes out wider
       than it is long. That is the model's own proportion and it is preserved;
       if the size is wrong, SHELL_LENGTH is the dial, not the aspect ratio.

       Uniform scaling also keeps the normals correct for free -- one factor on
       every axis needs no normal-matrix correction.

       VISUAL ONLY. This cannot change what a shell hits. The collider is a
       separate physics sphere built from the constructor's radius 0.4, well
       before this runs -- see the note in _build. */
    geo.computeBoundingBox();
    const len = geo.boundingBox.max.y - geo.boundingBox.min.y;
    const k = len > 1e-4 ? (SHELL_LENGTH / len) : 1;
    if(k !== 1) geo.scale(k, k, k);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    /* Where the bullet's tail ended up, so the tracer can be seated behind it.
       The geometry is scaled about the origin, so this is the scaled max.y and
       not the authored one. */
    Shell._bulletTailY = geo.boundingBox.max.y;

    /* Take the model's own materials -- they are authored, and reusing them is
       what makes the shell look like the model rather than a coloured capsule.
       Shared, never cloned per shell. */
    const mat = Shell._pickSolidMat(mesh, Shell._bulletMat);

    /* The planes keep their own authored material, texture and all. They are
       flat quads, and the file already marks them doubleSided, so a plane seen
       from behind does not vanish.

       NOT MADE OPAQUE. pickMat forces transparent = false, which is right for the
       bullet (a solid shell must not be a sprite) and completely wrong for the
       planes: their material is alphaMode BLEND with a 100x40 WebP named "trace"
       that fades the streak out along its length. Forcing opaque discards the
       alpha channel, so the fade stops working and the plane draws as a solid
       rectangle. They are explicitly exempted below. */
    let tracerGeo = null, tracerMat = null;
    if(tracerMeshes.length){
      const parts = [];
      for(const t of tracerMeshes){
        const g = t.geometry;
        if(k !== 1) g.scale(k, k, k);
        g.computeBoundingBox();
        g.computeBoundingSphere();
        /* pickMat, then undo the two things it forces that a textured,
           alpha-blended tracer must keep: the fade and the transparency. */
        const m = Shell._pickSolidMat(t, mat);
        m.transparent = true;
        m.depthWrite = false;   /* a blended plane must not occlude the shell */
        parts.push({ geo: g, material: m });
      }
      /* SEVERAL PLANES, ONE DRAW: merge so a shell costs the tracer one extra
         draw call however many planes the model has.

         EVERY ATTRIBUTE IS CARRIED OVER, and that is the fix for the planes
         rendering solid black. The first version of this built the merged
         geometry from the position attribute alone and recomputed normals --
         which silently dropped the UVs, so the "trace" texture had nothing to
         sample and every fragment fetched the same edge texel. A tracer built
         that way cannot show its texture no matter what the material says.
         Position, normal AND uv are all copied, and the authored normals are
         kept rather than recomputed, because a flat quad's own normals are what
         the artist shaded it against. See _mergeParts, which does exactly this
         and is also what the artillery round's body is merged with. */
      const merged = Shell._mergeParts(parts);
      tracerGeo = merged;
      tracerMat = parts[0].material;
    }

    /* Release the placeholder capsule only once nothing references it. */
    const oldGeo = Shell._sharedGeo;
    const oldMat = Shell._sharedMat;
    const oldTraceGeo = Shell._traceGeo;
    Shell._bulletGeo = geo;
    Shell._bulletMat = mat;
    Shell._sharedGeo = geo;
    Shell._sharedMat = mat;
    Shell._traceGeo = tracerGeo;
    Shell._traceMat = tracerMat;

    /* NOTHING PER-SHELL HAS TO BE HANDED ANYTHING NOW. The shared geometry and
       material WERE the shell's mesh geometry and material, so every shell in
       flight had to be walked and rewritten; now they are the batch's, and the
       batch is repointed in one assignment apiece. That is the whole reason the
       per-shell fixup below is cheaper than it looks, and the reason it can be:
       a shell holds a transform and a flag, and neither of those is invalidated
       by the model underneath it changing.

       ARTILLERY IS STILL EXPLICITLY EXCLUDED, and it still has to be. The batch
       is family-keyed so the BODY cannot be swapped by mistake, but the tracer
       flag below is per-shell, and an unguarded loop would give every shell in
       the air -- including a mortar shell in the middle of its arc -- the
       bullet file's tracer planes the instant TL_bullet.glb lands. `_isMortar`
       is read in the constructor before _build, so it is already settled here,
       and it can never change afterwards. */
    Shell._syncBatches();
    for(const sh of Shell._live){
      if(!sh.mesh || sh._isMortar) continue;
      /* The planes themselves, not the body. A shell fired before the file
         landed was built against the capsule and has _tracerOn false, and this
         is the frame it grows its streak; one already carrying one just keeps
         the flag it had. */
      sh._addTracer();
    }
    /* Safe now -- nothing can still be pointing at the placeholder. */
    if(oldGeo && oldGeo !== geo && oldGeo.dispose) { try { oldGeo.dispose(); } catch(e){} }
    /* Ditto for the previous tracer, once no shell references it. */
    if(oldTraceGeo && oldTraceGeo !== tracerGeo && oldTraceGeo.dispose){ try { oldTraceGeo.dispose(); } catch(e){} }
    /* Last, so it sees the ADOPTED material rather than the capsule it replaced.
       See the note on onModelsAdopted: warming the wrong one compiles the wrong
       program and the first shot still stalls. */
    try { if(Shell.onModelsAdopted) Shell.onModelsAdopted(); } catch(e){}
  }

  /* ============================================================================
     THE ARTILLERY ROUND -- assets/artilery_shell.glb

     A SEPARATE FILE, AND SEPARATE SHARED STATE, on purpose. The Mortar is the
     only tank that lobs anything, so this model is downloaded by every match
     whether or not a Mortar is ever fired -- which is the whole reason the
     bullet's load is asynchronous in the first place. Keeping the two sets
     apart means a match with no artillery never pays for the round, and a match
     with artillery cannot have its round swapped out by the rifle bullet
     finishing its download first.
   ========================================================================== */

  /* Bake the file's node transforms into the geometry and split body from
     tracer. The bullet path does neither, and cannot: TL_bullet.glb is a single
     node at the origin with its tracer planes already in world space, while this
     file is three nodes that carry a rotation, a scale and a translation, and a
     shell whose axis is not +Y flies sideways.

     MEASURED OFF assets/artilery_shell.glb, three nodes, five primitives:

       Cylinder    186 triangles over THREE primitives, one mesh
                     Material.002  125 tris  orange-red, the whole body
                     Material.003   13 tris  grey, a band around the middle
                     Material.004   48 tris  darker red, the body proper
       trace         2 tris   one flat quad
       trace.001     2 tris   the same quad, crossed

     THREE THINGS THIS FILE NEEDS THAT THE BULLET DOES NOT.

     ONE -- THE NODE TRANSFORMS ARE BAKED, not ignored. The bullet path reads
     o.geometry raw, which is only safe because that file's single node happens
     to sit at the origin with no rotation. Here the Cylinder node carries a -90
     degree Z rotation, a non-uniform scale of (0.84, 1.91, 0.84) and the two
     trace nodes carry a 90 degree X rotation plus a translation of 5.62 along X.
     Read raw, the body is a 2.0-long tube lying across the flight axis and both
     tracer planes sit on top of each other at the origin. applyMatrix4 folds
     each node's own transform -- and its normal matrix, so the lighting stays
     correct -- into a clone, leaving the original alone.

     TWO -- THE WHOLE FILE IS ROTATED ONTO +Y, which is the axis
     orientShellModel maps onto the direction of travel. After baking, the shell
     flies along -X: the nose is the tapered end (radius 0.41, at the node's
     -Y) and the tracer planes sit BEHIND it, spanning X 1.46 to 9.78 while the
     body only reaches X 1.91. That is the definition of the tracer being
     astern, and it is what says which end is the nose without guessing -- the
     radius profile alone is ambiguous here, because the flat base is as wide as
     the body and only the slight 0.89 taper at the other end gives it away.

     A quarter turn about Z, -PI/2, maps -X onto +Y exactly. After it the body
     spans Y -1.91 to 1.91 with the nose at +1.91, and the tracer planes span Y
     -9.78 to -1.46 -- trailing astern, still crossed, and now spanning both X
     and Z exactly as the bullet's do. Nothing downstream has to know any of
     this happened: orientShellModel, _addTracer and the artillery flight loop
     all work on the same +Y-forward convention the bullet already uses.

     THREE -- THE BODY IS THREE PRIMITIVES, SO IT MERGES. The bullet is a single
     primitive and can be drawn as one mesh; this body cannot, and keeping it as
     three would mean three draw calls and three materials per shell. They are
     merged into one geometry by _mergeParts -- same helper the tracer merge uses,
     so the attribute rules below are not a second opinion -- and drawn with one
     material.

     THE MERGE IS A MULTI-COLOUR ONE, so the body goes to VERTEX COLOURS rather
     than keeping its three materials. The shell is painted orange-red with a
     grey band, and one material cannot express that; vertex colour can, exactly.
     Each primitive's baseColorFactor is written into the colour attribute, which
     is how three.js itself draws a multi-material glTF node. ONE material for
     the whole body is the point, not a compromise: three.js would otherwise
     draw one group per primitive anyway, so merging plus vertex colours is fewer
     draw calls AND more correct than leaving the mesh alone.

     The colour is taken RAW, in linear space, which is what GLTFLoader hands
     THREE.Color and what the renderer expects from a colour attribute. It is not
     converted to sRGB the way def.color in config.js is, because that conversion
     exists only to get a hex literal into the right space -- here the value has
     not been through a hex at all, and converting it would wash the shell out.

     THE GRADIENT MAP IS SHARED, NOT BUILT HERE. toon.js caches one map for the
     whole game and hands it to every model it builds; this asks for the same one
     so the shell is lit by the same ramp as the tank firing it, rather than
     three.js's default toon ramp which bands differently from everything around
     it. */
  static _adoptArtModel(gltf){
    const root = gltf && gltf.scene;
    if(!root) return;

    /* Baking is relative to the scene root, not to world space: the glTF may
       arrive inside a group the game has already transformed, and the shell's
       axis has to be measured in the file's own frame. */
    root.updateMatrixWorld(true);
    const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();

    const bodyParts = [];
    const tracerParts = [];
    root.traverse((o) => {
      if(!o.isMesh || !o.geometry) return;
      const g = o.geometry.clone();
      /* Fold in the node transform, then swing the flight axis onto +Y. Order
         matters: the node's own transform is applied first because that is what
         the author saved, and the quarter turn is applied to the result because
         it is this code's own convention change, not the file's. */
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, o.matrixWorld));
      g.rotateZ(-Math.PI / 2);
      const tri = (g.index ? g.index.count : g.attributes.position.count) / 3;
      /* A pair of flat quads is 2 triangles. Anything heavier than that is the
         body -- the same reasoning the bullet uses to find its bullet, and for
         the same reason: matching on the name "trace" does not survive a
         re-export. The part carries the key `material` because _pickSolidMat
         reads a glTF object's own `material` field, so both helpers can be
         handed the same part without one of them being reshaped first. */
      const part = { geo: g, material: o.material };
      if(tri > 2) bodyParts.push(part); else tracerParts.push(part);
    });

    if(!bodyParts.length){
      console.warn('[Shell] artillery model had no usable body; keeping the placeholder');
      return;
    }

    /* ONE UNIFORM SCALE FOR THE WHOLE FILE, derived from the body -- the same
       rule the bullet follows, and for the same reason: the shell and its
       tracer planes were drawn as one object and scaling them independently is
       what stops a shell looking like the thing in the file.

       Measured after baking and the quarter turn, the body is 3.81 long on Y and
       1.68 across, so at MORTAR_SHELL_LENGTH 2.4 that is a factor of 0.63. The
       authored width:length is preserved exactly; there is no cross-section
       squash, for the same reason there is none on the bullet.

       NO ASPECT FIX. A shell is supposed to be slender -- 1.68 across and 3.81
       long is a 0.44 ratio, which is a shell. If the size is wrong,
       MORTAR_SHELL_LENGTH is the dial and the ratio is not available. */
    const geo = Shell._mergeParts(bodyParts);
    geo.computeBoundingBox();
    const len = geo.boundingBox.max.y - geo.boundingBox.min.y;
    const k = len > 1e-4 ? (MORTAR_SHELL_LENGTH / len) : 1;
    if(k !== 1) geo.scale(k, k, k);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    /* The body takes its SHADING from the file and its COLOUR from the vertices.
       MeshToonMaterial is what the game's own models use (see toon.js) and it is
       the right read on a stylised red-painted shell lit by the same sun as the
       tank firing it; the file's own MeshStandardMaterial would light it by a
       different set of rules than everything around it.

       SIDEDNESS IS TAKEN FROM THE FILE rather than assumed. Every material here
       is doubleSided, which for a closed solid costs nothing but means the
       inside of the shell is drawn too -- and the body has real interior
       geometry, the two ends of a tube seen through the open one. Copying it
       means a re-export that drops doubleSided still renders correctly. */
    let gradientMap = null;
    if(typeof Toon !== 'undefined' && Toon.getGradientMap){
      try { gradientMap = Toon.getGradientMap(); } catch(e){ gradientMap = null; }
    }
    const srcMat = (bodyParts[0].material && !Array.isArray(bodyParts[0].material)) ? bodyParts[0].material : null;
    const mat = new THREE.MeshToonMaterial({
      color: 0xffffff,
      vertexColors: true,
      gradientMap: gradientMap,
      side: (srcMat && typeof srcMat.side === 'number') ? srcMat.side : THREE.DoubleSide,
    });
    /* A toon material has no roughness and no lighting term below the ramp, so a
       shell with a black emissive renders as a flat silhouette of itself rather
       than a lit solid. The file carries no emissive at all, so a small flat lift
       is used instead: enough that the shaded side is visibly red rather than
       black, not so much that it stops reading as shaded. */
    mat.emissive.setRGB(0.18, 0.05, 0.04);

    /* The tracer planes are handled exactly as the bullet's are: authored
       material and texture kept, made transparent and depth-write-off so the
       alpha fade survives and the streak cannot occlude its own shell. */
    let tracerGeo = null, tracerMat = null;
    if(tracerParts.length){
      const parts = [];
      for(const p of tracerParts){
        const g = p.geo;
        if(k !== 1) g.scale(k, k, k);
        g.computeBoundingBox();
        g.computeBoundingSphere();
        const m = Shell._pickSolidMat(p, mat);
        m.transparent = true;
        m.depthWrite = false;
        parts.push({ geo: g, material: m });
      }
      tracerGeo = Shell._mergeParts(parts);
      tracerMat = parts[0].material;
    }

    const oldGeo = Shell._artGeo;
    const oldTraceGeo = Shell._artTraceGeo;
    Shell._artGeo = geo;
    Shell._artMat = mat;
    Shell._artTraceGeo = tracerGeo;
    Shell._artTraceMat = tracerMat;

    /* Same two lines as the bullet's adopt, for the same two reasons: the batch
       is repointed in one go rather than once per shell in flight, and the walk
       that remains is only there to grow a tracer flag on shells fired before
       this file landed. */
    Shell._syncBatches();
    for(const sh of Shell._live){
      if(!sh.mesh || !sh._isMortar) continue;
      sh._addTracer();
    }
    if(oldGeo && oldGeo !== geo && oldGeo.dispose){ try { oldGeo.dispose(); } catch(e){} }
    if(oldTraceGeo && oldTraceGeo !== tracerGeo && oldTraceGeo.dispose){ try { oldTraceGeo.dispose(); } catch(e){} }
    try { if(Shell.onModelsAdopted) Shell.onModelsAdopted(); } catch(e){}
  }

  /* A model's own material, forced to draw as a solid object.

     Shells used to draw with depthTest OFF so a tracer was never hidden behind
     scenery. That was a workaround for a flat sprite and it made the bullet show
     through walls, so a solid model is drawn normally: it can be occluded, which
     is correct and is most of what selling it as a real object buys.

     Shared by both model paths. The tracer planes are the documented exception
     to this -- see _adoptModel. */
  static _pickSolidMat(o, fallback){
    let m = o.material;
    if(Array.isArray(m)) m = m[0];
    if(!m) m = fallback;
    if(m.depthTest === false || m.transparent){
      m.depthTest = true;
      m.transparent = false;
      m.needsUpdate = true;
    }
    return m;
  }

  /* Concatenate several geometries into one, preserving every attribute that
     matters, and fold a material's base colour into a vertex colour attribute
     when one is supplied.

     COPIED VERBATIM PER VERTEX, never recomputed. Position, normal and uv are
     all carried over: dropping the uv is what made an earlier tracer render
     solid black, because the "trace" texture had nothing to sample and every
     fragment fetched the same edge texel. The authored normals are kept rather
     than recomputed, because a flat quad's own normals are what the artist
     shaded it against.

     A part's material contributes its colour ONLY to the colour attribute -- the
     material itself is not used, because the point of merging is that one
     material draws the result. Parts without a material colour get white, which
     is the identity for a vertex-coloured material, so a single untextured part
     merging with textured ones does not turn black.

     A part that ALREADY has a colour attribute keeps it and its material colour
     is ignored: baked vertex colours are the more specific statement, and
     overwriting them with a flat factor is how vertex-coloured models lose their
     paint. */
  static _mergeParts(parts){
    const merged = new THREE.BufferGeometry();
    const acc = { position: [], normal: [], uv: [], color: [] };
    const idx = [];
    let v = 0;
    for(const part of parts){
      const g = part.geo;
      const m = part.material;
      const bc = (m && m.color && typeof m.color.r === 'number') ? m.color : null;
      const own = g.attributes && g.attributes.color;
      for(const name of ['position', 'normal', 'uv']){
        const at = g.attributes[name];
        if(!at) continue;
        const dst = acc[name];
        for(let i = 0; i < at.array.length; i++) dst.push(at.array[i]);
      }
      const n = g.attributes.position.count;
      if(bc || own){
        for(let i = 0; i < n; i++){
          if(own) acc.color.push(own.getX(i), own.getY(i), own.getZ(i));
          else if(bc) acc.color.push(bc.r, bc.g, bc.b);
          else acc.color.push(1, 1, 1);
        }
      }
      const ix = g.index ? g.index.array : null;
      if(ix) for(let i = 0; i < ix.length; i++) idx.push(ix[i] + v);
      else for(let i = 0; i < n; i++) idx.push(v + i);
      v += n;
    }
    merged.setAttribute('position', new THREE.Float32BufferAttribute(acc.position, 3));
    if(acc.normal.length) merged.setAttribute('normal', new THREE.Float32BufferAttribute(acc.normal, 3));
    if(acc.uv.length) merged.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
    if(acc.color.length) merged.setAttribute('color', new THREE.Float32BufferAttribute(acc.color, 3));
    merged.setIndex(idx);
    if(!acc.normal.length) merged.computeVertexNormals();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }
  _build(){
    Shell._initShared();
    /* A TRANSFORM, NOT A MESH. The Object3D carries the three numbers the batch
       composes into an instance matrix and nothing else: no geometry, no
       material, no parent, no entry in the scene graph. It is still called
       `mesh` because game.js reaches through it, and because every write below
       -- orientShellModel, rotateY, scale.setScalar, lookAt on a networked
       shell -- means exactly what it meant when this was a real Mesh and still
       lands in exactly the place it used to. See the batch note above. */
    this.mesh = new THREE.Object3D();
    if(this._isShotgunPellet){
      /* SHOTGUN PELLETS ARE THE SAME SHELL, SMALLER.

         They were once meant to be 3D spheres — a 4x4 sphere in flat yellow —
         but that branch never ran (see the constructor note about the pellet
         flag), so pellets quietly drew as full-size shells. Now the pellet flag
         is read from the def, so it finally takes effect, and the pellet is the
         shell model scaled down on the MESH.

         Deliberately not a second geometry: the model's geometry and material
         are shared by every shell in the match and a mesh transform is
         per-instance and free, so a smaller pellet costs exactly what the
         full-size one costs.

         THE HITBOX IS DELIBERATELY NOT TOUCHED. An older branch set
         radius = 0.15 here, but that line never ran either, and the collider is
         built earlier from the constructor's 0.4 — so pellets have always hit
         with a 0.4 sphere and the physics body agrees with that. Letting 0.15
         take effect now, as a side effect of fixing the flag, would quietly
         quarter the shotgun's hit area without anyone asking for it. The shell
         gets smaller; what it hits does not. */
      this._baseScale = 0.34;
      this.mesh.scale.setScalar(this._baseScale);
      orientShellModel(this.mesh, this.dir);
    } else if(this._isMortar){
      /* THE MORTAR DRAWS ITS OWN ROUND, at full size.

         A mortar shell is not a smaller bullet and is emphatically not a
         rescaled one -- the whole read of an artillery piece is that it throws
         something heavy. It is drawn from the artillery batch at full size, sized
         by MORTAR_SHELL_LENGTH at load time, and the pellet branch above never
         sees it: no def sets both shellType 'mortar' and _isShotgunPellet, and
         the check is an `else if` rather than a second `if` so that stays true
         even if one did.

         The shell is still oriented the same way -- orientShellModel maps +Y onto
         the direction of travel, and _adoptArtModel rotated the file onto +Y
         precisely so this call needs no knowledge of the round.

         Scale is left at 1 rather than written, exactly as it was: an explicit
         setScalar(1) here would be the same number and one more thing to keep in
         step with _baseScale. */
      this._baseScale = 1;
      orientShellModel(this.mesh, this.dir);
    } else {
      /* `shellScale` shrinks the round for a tank whose gun chambers something
         smaller. Predator wants 1.3x smaller, declared as 0.769 = 1/1.3 so the
         def can state the relationship rather than the reciprocal.

         This was a dead config key: the value sat in the def and nothing read
         it, so Predator fired the same shell as everything else despite having a
         gun model built around a smaller round. It scales the MESH only — the
         collider is built from the constructor's radius, so the shot is visually
         smaller without quietly becoming harder to hit. */
      this._baseScale = this._shellScale;
      this.mesh.scale.setScalar(this._baseScale);
      orientShellModel(this.mesh, this.dir);
    }
    /* No renderOrder override any more. The sprite was drawn last with
       depthTest off so it was never hidden; a solid shell belongs in the normal
       queue and is allowed to be occluded by the world. The shadow flags went
       with it -- they are on the batch now, set once in _mkBatch, because a flag
       on a transform nobody renders is a flag that reads as if it means
       something. */
    this.mesh.position.set(this.x, this.y, this.z);
    /* Whether this shell is in a scene at all. updateInstances reads it so a
       shell that was constructed but never attached -- which the old code got
       for free from never being scene.add()ed -- stays undrawn. */
    this._inScene = false;
    /* The model's own tracer planes. False until _addTracer says otherwise,
       which it does not do at all until the GLB lands -- so the two are stated
       together rather than left as an undefined that happens to be falsy. */
    this._tracerOn = false;
    this._addTracer();
    /* Registered so the right model can be swapped into this shell if it is
       still flying when its GLB finishes loading. */
    Shell._live.add(this);
  }

  /* Decide whether this shell draws the model's tracer planes. Split out of
     _build because it also has to run from _adoptModel, where a shell already in
     flight has to be given the planes that arrived with the file.

     WHAT IT DOES NOW IS SET ONE BOOLEAN. The planes used to be a child Mesh
     parented to the shell, so "does this shell have a streak" was answered by
     whether an object existed; now it is answered by whether a row is written
     into the family's tracer batch, and the row is written from this flag by
     updateInstances. Nothing else about the shell changes.

     WHY IT IS STILL A SEPARATE CALL AND NOT A LINE IN _build: the file lands
     after the first shot, and the shell that was fired before it landed is
     already in the air with no streak. That is not a defect to be tidied away --
     it is what _addTracer has always been for -- and the adopt functions still
     call this, on every live shell of the right family, on the frame the model
     arrives.

     THE PLANES COME FROM THE FILE, not from here -- see the note in _adoptModel.

     ATTACHED AT THE ORIGIN, NOT SEATED BEHIND THE TAIL. They are authored from
     y = -0.99 back to y = -14.5, which is already behind the bullet's base rim
     at y = -1.51, so the artist placed them correctly and the only thing that
     has to happen is the one uniform scale. An earlier version added a seating
     offset computed from the bullet's bounding box, which pushed the planes
     1.59 units further along the flight axis and put them in FRONT of the shell.
     Instancing needs nothing here either way: the tracer batch is handed the
     shell's own composed matrix, so there is no local transform left to get
     wrong.

     WHICH SET OF PLANES DEPENDS ON WHICH ROUND THIS IS. The bullet draws
     Shell._traceGeo; the mortar draws Shell._artTraceGeo. Both are read fresh
     here rather than cached on the instance, because this also runs from the
     adopt functions, where the whole point is that the shared set has just
     changed underneath a shell that is already flying.

     NO TRACER, NO PROBLEM. Both placeholders have a null tracer set until their
     file lands, so a shell fired in the first moments of a match simply has no
     streak yet -- and the corresponding adopt function calls this again to hand
     it one. The tracer batch does not exist yet either, which is the same thing
     said about the geometry rather than the shell. */
  _addTracer(){
    const kit = Shell._kit(this._isMortar);
    if(!kit.traceGeo || !this.mesh) return;
    this._tracerOn = true;
  }

  /* Ricochet check when hitting a tank. Returns true if shell ricochets. */
  _tryRicochet(t, game){
    const fwdX = Math.sin(t.heading);
    const fwdZ = Math.cos(t.heading);

    const fromX = this.x - t.x;
    const fromZ = this.z - t.z;
    const fromLen = Math.hypot(fromX, fromZ);
    if(fromLen < 0.01) return false;
    const fromDirX = fromX / fromLen;
    const fromDirZ = fromZ / fromLen;
    const facingDot = fromDirX * fwdX + fromDirZ * fwdZ;

    let armorVal;
    let nx, nz;

    if(facingDot > 0.5){
      armorVal = t.def.armor.front;
      nx = fwdX; nz = fwdZ;
    } else if(facingDot < -0.5){
      armorVal = t.def.armor.back;
      nx = -fwdX; nz = -fwdZ;
    } else {
      armorVal = t.def.armor.sides;
      const sideX = Math.cos(t.heading);
      const sideZ = -Math.sin(t.heading);
      const sideDot = fromDirX * sideX + fromDirZ * sideZ;
      if(sideDot > 0){ nx = sideX; nz = sideZ; }
      else{ nx = -sideX; nz = -sideZ; }
    }

    /* PROGRESSION 2.0 — Penetration. Armor here is the ricochet angle in
       degrees, so the shooter's pen level shrinks the TARGET's angle: the
       plate that used to throw the shell off now takes it head-on. */
    const penPts = this.owner && this.owner.upStats ? (this.owner.upStats.penPct || 0) : 0;
    if (penPts > 0) armorVal *= (1 - Math.min(60, penPts) / 100);

    // Angle between shell travel direction and armor surface (0 = grazing, 90 = perpendicular)
    const dotNorm = Math.abs(this.dir.x * nx + this.dir.z * nz);
    const angleFromSurface = 90 - Math.acos(Math.min(1, dotNorm)) * 180 / Math.PI;

      if(angleFromSurface < armorVal){
        if(typeof Menu !== 'undefined' && Menu.toast) Menu.toast('Ricochet!');
        /* IMPACT PHYSICS: even a bounce loads the plate. The shove runs along
           the armour normal (the direction the incoming shot was pressing the
           plate), at a fraction of a direct hit — ricochets skid off, they do
           not fully transfer their momentum. Applied from the whole shell's
           damage; folders may add more later, ricocheting shells only ever
           end in this block once per round. */
        if(t.pushImpact){
          t.pushImpact(nx, nz, this.damage * ((CONFIG && CONFIG.IMPULSE_RICO_FRAC) || 0.30));
        }
        const reflectDot = this.dir.x * nx + this.dir.z * nz;
        this.dir.x -= 2 * reflectDot * nx;
        this.dir.z -= 2 * reflectDot * nz;
        this.dir.normalize();

        this.life /= 1.5;

        // Label at ricochet point
        const tankRad = Math.max(t.def.body.w, t.def.body.l)/2;
        const impactX = t.x + fromDirX * tankRad;
        const impactZ = t.z + fromDirZ * tankRad;
        game.spawnRicoLabel(impactX, impactZ);

        // Place shell at impact point on tank perimeter, then offset in reflected dir
        this.x = impactX + this.dir.x * 0.8;
        this.z = impactZ + this.dir.z * 0.8;
        this.mesh.position.set(this.x, this.y, this.z);
        orientShellModel(this.mesh, this.dir);
        game.spawnExplosion(this.x, 1.0, this.z, 0xffeeaa, 3, 'burn');

        /* BOUNCE STREAKS: glowing lines that leave along the REFLECTED path
           — the streak direction itself tells the player "this shot is now
           travelling that way". The spawn point is the impact point on the
           plate: this.x/this.z were already moved 0.8 down the reflected
           line above, so stepping 0.8 back along the same line lands on the
           hull contact point. */
        if(typeof SparkLines !== 'undefined' && game.scene){
          SparkLines.spawn(game.scene, this.x - this.dir.x * 0.8, this.y || 1.2, this.z - this.dir.z * 0.8, this.dir.x, this.dir.z);
        }
        /* A RICOCHET IS STILL A HIT: the hull takes the 0.2s white pop even
           though the shell walked off it, or a grazing bounce gives zero
           feedback for a very dramatic sound event. */
        t.flash && t.flash(0.2);

        // Stylized bounce sparks: bright flash kicked along the reflected path
        if(game && game.spawnBurst){
          game.spawnBurst(this.x, 1.25, this.z, {
            count: 16, tex: 'flare',
            speed: 13, size: 0.55, life: 0.5, rise: 2.6, gravity: 18,
            biasX: this.dir.x, biasZ: this.dir.z, spread: 0.6,
          });
          game.spawnBurst(this.x, 1.15, this.z, {
            count: 7, tex: 'smoke',
            speed: 3.2, size: 0.7, life: 0.6, rise: 1.6, gravity: 4,
            blend: 'normal', biasX: this.dir.x, biasZ: this.dir.z, spread: 1.0,
          });
          if(game.localTank && game.localTank.alive){
            const d = Math.hypot(game.localTank.x - this.x, game.localTank.z - this.z);
            if(d < 20) game.addShake(0.45 * (1 - d / 20));
          }
        }

        /* No trail to restart here any more. The ricochet used to end the streak
           and start a new one at the deflection point so the bend was visible;
           with the trace removed there is nothing left to bend. */
        return true;
      }
    return false;
  }

  /* THE SCENE IS NOT GIVEN THIS SHELL. There is nothing of this shell's to give
     it: the Object3D is a transform and the geometry and material belong to the
     batch. What attach does instead is make sure the batches exist in this scene
     -- the first attach of a match is what creates them -- and put the shell on
     the list the rebuild walks.

     It stays a method with a scene argument, and it stays the only place a shell
     learns what scene it is in, because that is the shape game.js, the host
     snapshot handler and the arena reset all already call it in. */
  attach(scene){
    Shell._ensureBatches(scene);
    this.scene = scene;
    this._inScene = true;
  }
  detach(){
    this._removePhysBody();
    this.scene = null;
    this._inScene = false;
    /* Leave the live set, or the adopt functions would later go on swapping
       geometry onto a shell that has already been removed from the scene, and
       the set would grow by one entry for every shot for the whole session. */
    Shell._live.delete(this);
    /* AND NO REBUILD HAPPENS HERE, which is the point. The obvious thing to do
       on a shell's death is go and fix the batch, and it is the wrong thing: a
       shotgun blast kills ten pellets in the same frame and a mortar burst
       kills everything in flight, so tidying up per death would make the cost
       of clearing the dead proportional to how many there were rather than to
       how many are left. Leaving the live set IS the whole update -- the next
       rebuild cannot reach a shell that is no longer in it, and count drops to
       however many survived, so a round that was shot down does not hang in the
       air for a frame.

       That does depend on the rebuild being called every frame, which is the
       call site in game.js this file cannot make for itself. It is stated here
       rather than only on updateInstances because detach() is the method whose
       silence would be mistaken for a leak.

       AND NOTHING IS DISPOSED. This used to compare the shell's own geometry
       against the shared pair and dispose whatever did not match, guarded by
       _kit because getting that wrong disposed the artillery round the first
       time a mortar shell was cleaned up. The guard is gone because the thing it
       guarded is gone: a shell has no geometry of its own any more, so there is
       nothing here that a shell could be the last owner of.

       That is not a licence to dispose anything else in its place. The batch's
       geometry and material are shared by every shell in the match and are
       retired exactly once, by _adoptModel and _adoptArtModel, when the next
       file replaces them -- which is the only moment at which anything here may
       legitimately free a GL buffer. */
  }
  _removePhysBody(){
    if(this._physBody && this._physWorld){
      try { this._physWorld.removeRigidBody(this._physBody); } catch(e){}
      this._physBody = null;
    }
  }

  update(dt, world, game){
    if(this.dead) return;
    this.life -= dt;

    // Network-controlled: don't move, position set by host snapshots
    if(this._networked){ if(this.life <= 0) this.dead = true; return; }

    /* ARTILLERY runs its own integrator, so it has to come before the generic
       "life ran out, quietly vanish" branch below: an artillery shell whose
       timer expires still BURSTS, where every other shell just ceasing to
       exist is the correct ending. */
    if(this._isMortar){ this._updateArtillery(dt, world, game); return; }

    /* OFF-MAP SELF-DELETE. A shell that sails past the arena edge just
       ceases to exist — no burst at the border, no damage to anything out
       there, it is simply gone. Also covers the trivially "500 m" range:
       nothing survives beyond the world the player can reach. */
    if(world && world.half && (Math.abs(this.x) > world.half + 20 || Math.abs(this.z) > world.half + 20)){
      this.dead = true;
      return;
    }

    if(this.life <= 0){ this.dead = true; return; }

    // Use Rapier body position if available, otherwise manual movement
    if(this._physBody){
      var t = this._physBody.translation();
      this.x = t.x; this.y = t.y; this.z = t.z;
      // Kill if below world
      if(this.y < -10){ this.dead = true; return; }
      // Defensive wall check (fallback if Rapier collision event missed)
      if(world.collidesWallsOnly(this.x, this.z, this.radius)){
        this.dead = true;
        game.spawnExplosion(this.x, 1.0, this.z, 0xffaa33, 6, 'wall');
        game.spawnBurst && game.spawnBurst(this.x, 1.0, this.z, {count: 3, tex: 'dust', speed: 3.5, size: 0.9, life: 0.4, rise: 1.2, gravity: 5, blend: 'normal', fade: 0.7});
        /* IMPACT PHYSICS: wall debris on the fallback path too — identical to
           the Rapier collision handler in game.js, so a shell never hits
           differently for looking flatter depending on which integrator ran. */
        game.spawnBurst && game.spawnBurst(this.x, 0.9, this.z, {count: 6, tex: 'shard', color: 0x9a9a9a, speed: 7, size: 0.32, life: 0.55, rise: 2.4, gravity: 16, blend: 'normal', spin: 7});
        return;
      }
    } else {
      /* The fallback integrator, used only when no Rapier body exists. Same
         straight-line flight as the physics path above; both `_inherit*` terms
         are 0 by construction. The zeroing line is kept deliberately: it makes
         the invariant local — a reader of THIS branch does not have to scroll up
         to the constructor to know the trajectory cannot bend. */
      const vx = this.dir.x * this.speed + this._inheritX;
      const vy = this.dir.y * this.speed;
      const vz = this.dir.z * this.speed + this._inheritZ;
      this._inheritX = 0; this._inheritZ = 0;
      const nx = this.x + vx * dt;
      const ny = this.y + vy * dt;
      const nz = this.z + vz * dt;
      if(world.collidesWallsOnly(nx, nz, this.radius)){
        this.dead = true;
        game.spawnExplosion(this.x, 1.0, this.z, 0xffaa33, 6, 'wall');
        game.spawnBurst && game.spawnBurst(this.x, 1.0, this.z, {count: 3, tex: 'dust', speed: 3.5, size: 0.9, life: 0.4, rise: 1.2, gravity: 5, blend: 'normal', fade: 0.7});
        /* FALLBACK wall debris, same as the branch above. */
        game.spawnBurst && game.spawnBurst(this.x, 0.9, this.z, {count: 6, tex: 'shard', color: 0x9a9a9a, speed: 7, size: 0.32, life: 0.55, rise: 2.4, gravity: 16, blend: 'normal', spin: 7});
        return;
      }
      this.x = nx; this.y = ny; this.z = nz;
    }

    // world border
    if(Math.abs(this.x) > world.half || Math.abs(this.z) > world.half){ this.dead = true; return; }
    this.mesh.position.set(this.x, this.y, this.z);
    if(this.dir){
      orientShellModel(this.mesh, this.dir);
    }
    /* TUMBLE. Applied on top of the travel orientation, about the mesh's own
       long axis, so the round stays nose-first down the line of flight while
       spinning about it — which is what a shell in a rifled barrel does, and is
       also the only way to spin something without it appearing to fly sideways.
       `this._spin` is radians per second, taken off the def at construction. */
    if(this._spin > 0 && this.mesh){
      this._spinAngle += this._spin * dt;
      if(this._spinAngle > Math.PI * 2) this._spinAngle -= Math.PI * 2;
      this.mesh.rotateY(this._spin * dt);
    }

    // Gladiator destructible blue boxes
    if(game && game._gladBoxHit && game.glad && game._gladBoxHit(this)){ this.dead = true; return; }

    /* Base Defend bases.

       Written as a direct call to the module rather than through a
       game._baseDefendHit wrapper, which the Gladiator hook has and this does
       not. The wrapper exists there because the blue boxes are game state
       (game._gladBoxes) that happens to be full of meshes; the bases live
       inside BaseDefend along with their own hit test, their HP, their panels
       and their HUD, and a one-line forwarder would only give a second name for
       the same function.

       Checked BEFORE the tank loop below, and the order is not arbitrary: a
       shell that has already reached the base must not go on to damage a tank
       standing behind it. It is also checked after the gladiator hook, which is
       harmless — the two modes are mutually exclusive, and a null BaseDefend
       state means this returns false immediately. */
    if(typeof BaseDefend !== 'undefined' && BaseDefend.getState() && BaseDefend.hitByShell(this)){
      this.dead = true;
      return;
    }

    // Tank hit fallback (skip if already handled by Rapier collision events)
    for(const t of game.tanks){
      if(!t.alive || this.dead || this._hitByPhysics) continue;
      if(t === this.owner && this.life > this.maxLife - 0.15) continue;
      if(this.owner.allyId && (t.id === this.owner.allyId || t.allyId === this.owner.id)) continue;
      if(this.owner.team && t.team && this.owner.team === t.team) continue;
      /* THE HIT TEST IS THE TANK'S PHYSICS FOOTPRINT, not a circle round it.

         This used to be `Math.max(body.w, body.l)/2` — a circle sized to the
         tank's LONG axis, which is therefore about half a unit wider than the
         hull on each side, while the Rapier collider the tank actually drives
         around with is a box shrunk to 0.55 of the body. Two shapes, two sizes,
         and a gap between them you could get shot through while standing in
         clear space. Tank.hitTest2D is now the single source for both. */
      if(t.hitTest2D(this.x, this.z, this.radius)){
        const armor = t.def.armor;
        if(armor && !this._isShotgunPellet && this._tryRicochet(t, game)){ continue; }
        /* A splash round bursts on the tank rather than drawing only from it —
           see the identical guard in Game._onShellHitTank, which is the path
           Rapier collisions actually take. Both exist because either one can be
           the first to notice the hit, and a shell that dealt point damage on
           one route and blast on the other would detonate differently depending
           on which fired first. */
        if(this.splashDamage > 0 && !this._isShotgunPellet && !this._isMortar){
          this._detonate(game);
          return;
        }
        t.takeDamage(this.damage, this.owner, game);
        /* IMPACT PHYSICS, fallback path — same shove the Rapier path applies
           in Game._onShellHitTank, so hits cannot feel different depending on
           whether physics came up. Shotgun pellets take a fraction each: ten
           of them land, and ten full shoves would fling the target. */
        if(t.pushImpact){
          const ifrac = this._isShotgunPellet
            ? (CONFIG && CONFIG.IMPULSE_PELLET_FRAC) || 0.30
            : ((CONFIG && CONFIG.IMPULSE_SHELL_HIT) || 0.072);
          t.pushImpact(this.dir.x, this.dir.z, this.damage * ifrac);
        }
        if(this.owner === game.localTank) game.spawnHitMarker();
        game.spawnExplosion(this.x, 1.2, this.z, 0xff6a2a, 3, 'boom');
        if(game._spawnVideoExplosion) game._spawnVideoExplosion(this.x, 1.2, this.z);
        /* GLOWING-LINE STREAKS from the exact impact point, kicked away from
           the struck hull. Same effect the Rapier path plays via
           game._impactSparks(); this fallback path must match it or hits
           would look different depending on whether physics was up. */
        if(typeof SparkLines !== 'undefined' && game.scene){
          let ox = this.x - t.x, oz = this.z - t.z;
          const ol = Math.hypot(ox, oz);
          if(ol > 1e-4){ ox /= ol; oz /= ol; }
          else { const a2 = Math.random()*Math.PI*2; ox = Math.cos(a2); oz = Math.sin(a2); }
          SparkLines.spawn(game.scene, this.x, 1.2, this.z, ox, oz);
        }
        // Impact sparks + a puff of smoke so a landed hit feels meaty
        if(game && game.spawnBurst){
          game.spawnBurst(this.x, 1.2, this.z, {
            count: 12, tex: 'flare', speed: 10, size: 0.5, life: 0.42, rise: 3.2, gravity: 16,
          });
          game.spawnBurst(this.x, 1.2, this.z, {
            count: 6, tex: 'smoke', speed: 2.6, size: 0.9, life: 0.5, rise: 2, gravity: 4, blend: 'normal',
          });
          if(game.localTank && game.localTank.alive){
            const d = Math.hypot(game.localTank.x - this.x, game.localTank.z - this.z);
            if(d < 22) game.addShake(0.5 * (1 - d / 22));
          }
        }
        this.dead = true;
        return;
      }
    }
  }

  /* ============================================================================
     ARTILLERY FLIGHT

     INTEGRATED AT A FIXED STEP, NOT PER FRAME.

     The parabola is closed-form (see artilleryVelocity) but the SHELL is not:
     it has to be tested against the ground and against tanks on the way down,
     and testing once per rendered frame would make both the flight and the
     impact depend on frame rate — a shell that lands on a cluster at 144fps
     and a metre wide of it at 30fps. Substepping keeps the impact point fixed
     regardless of what the machine is managing.

     NO PHYSICS BODY, AND THAT IS THE POINT. Walls, buildings and scenery do
     not stop a lobbed shell: it goes over them. That is not a limitation worked
     around, it is the weapon — every other tank in the game is stopped by the
     first wall in front of it, and this one is not. */
  _updateArtillery(dt, world, game){
    const STEP = 1/120;
    let remaining = Math.min(dt, 0.1);      /* a long frame cannot teleport the
                                               shell across the map */
    while(remaining > 0){
      const h = Math.min(STEP, remaining);
      remaining -= h;
      this._vel.y -= this.gravity * h;
      const nx = this.x + this._vel.x * h;
      const ny = this.y + this._vel.y * h;
      const nz = this.z + this._vel.z * h;

      /* DID THAT STEP CROSS TERRAIN?

         This is the test the artillery path did not have. It used to look for
         `y <= 0.35`, a hardcoded world plane that only happens to be the floor
         on a map authored around the origin -- on every other map the shell
         flew down through the ground and burst underneath it. And it never
         tested walls at all, so artillery passed through buildings that
         direct-fire shells bounce off.

         The sub-step is already there for the arc, so the segment is known; it
         just was not being asked whether anything was in the way. */
      if(game && game._shellSegmentHit){
        const hit = game._shellSegmentHit(this.x, this.y, this.z, nx, ny, nz);
        if(hit){
          this.x = hit.x; this.y = hit.y; this.z = hit.z;
          this._detonate(game);
          return;
        }
      }

      this.x = nx; this.y = ny; this.z = nz;
      /* The shell nose follows the VELOCITY, not the launch direction, so it
         pitches over and starts falling backwards on the way down exactly as a
         real shell does. Orienting it once at launch left it climbing for the
         whole flight. */
      this.dir.set(this._vel.x, this._vel.y, this._vel.z);
      if(this.dir.lengthSq() < 1e-8) this.dir.set(0, 0, 1); else this.dir.normalize();
      if(this.mesh){
        this.mesh.position.set(this.x, this.y, this.z);
        orientShellModel(this.mesh, this.dir);
        /* Same tumble as the direct-fire path: re-orienting the mesh each frame
           resets its rotation, so the spin has to be reapplied after it or a
           Grom shell launched on an arc would fly rigid and only start
           tumbling if it somehow skipped the reorientation. */
        if(this._spin > 0){
          /* `h` is the STEP, not the remaining life. `remaining` is a countdown
             and using it would make the tumble accelerate as the shell ran out
             of fuel, which is not a thing shells do. */
          this._spinAngle += this._spin * h;
          if(this._spinAngle > Math.PI * 2) this._spinAngle -= Math.PI * 2;
          this.mesh.rotateY(this._spin * h);
        }
      }

      /* GROUND. Now a LAST RESORT rather than the test.

         It bursts 0.35 above the plane rather than at it, so the blast lands ON
         the surface instead of half-buried in it. But this plane is the world
         origin, not the map's floor: maps are GLB models sitting wherever their
         author put them, so on most maps the raycast above has already burst
         the shell on the real terrain long before this can fire.

         It stays because a map with no colliders at all -- or a shell fired
         outside every one of them -- must still land somewhere instead of
         falling forever. */
      if(this.y <= 0.35){ this.y = 0.35; this._detonate(game); return; }

      /* A TANK IN THE WAY — but only once the shell is descending and low
         enough to actually be at one. A shell still thirty units up sails over
         the whole formation, which is precisely how artillery is supposed to
         behave and the reason the arc is worth the trouble. The owner is
         excluded: clipping yourself on the way out is not a mechanic, and the
         shell spawns at the muzzle, which is inside your own footprint. */
      if(game && game.tanks && this._vel.y < 0){
        for(const t of game.tanks){
          if(!t.alive || t === this.owner) continue;
          const topY = (t.def.body.h + t.def.turret.h) * 0.9;
          if(this.y > topY + 0.6) continue;
          /* Same footprint as every other hit test. See the note in the direct
             fire path — this one used to be the same mismatched circle. */
          if(t.hitTest2D(this.x, this.z, this.radius)){ this._detonate(game); return; }
        }
      }
    }
    /* The net. The ground test above should always win first; this exists so a
       shell fired out of the arena bounds bursts somewhere sensible instead of
       being silently deleted in mid-air with no explosion and no blast. */
    if(this.life <= 0) this._detonate(game);
  }

  /* ============================================================================
     THE BLAST

     vfxOnly is for a CLIENT replaying a detonation it was told about rather
     than one it simulated: the host owns artillery damage (as it owns all
     damage), so the client plays the bang and leaves the hit points alone.

     NO SELF-DAMAGE, AND NOT BY ACCIDENT. artilleryMinRange is deliberately kept
     larger than splashRadius, which makes it geometrically impossible for a
     mortar shell to land close enough to its own hull to hurt it: you cannot
     range it short enough. World of Tanks lets artillery kill itself; here that
     would only ever be a reload wasted, and the minimum range already forces
     the tank to back away and fight like an artillery piece.

     Team-mates are spared, same as every other weapon in the game — there is no
     friendly fire anywhere else and splash should not quietly introduce it. */
  _detonate(game, vfxOnly){
    if(this._detonated) return;
    this._detonated = true;
    this.dead = true;

    const R = this.splashRadius;
    const maxD = this.splashDamage;
    const minD = this.splashMinDamage;

    if(!vfxOnly && game && maxD > 0){
      for(const t of (game.tanks || [])){
        if(!t.alive || t === this.owner) continue;
        if(this.owner && this.owner.team && t.team && this.owner.team === t.team) continue;
        const d = Math.hypot(t.x - this.x, t.z - this.z);
        if(d > R) continue;
        /* LINEAR ramp from maxD at the centre to minD at the rim, then zero
           outside. Linear is the teachable one: after a couple of shells a
           player can say "I am near the edge, I take about a third", which an
           inverse-square or exponential falloff never lets anybody learn. */
        const f = 1 - (d / R);
        /* IMPACT PHYSICS: an explosion is a pressure wave, so every tank in
           the radius gets shoved RADIALLY OUTWARD from the impact point, not
           just damaged. The shove rides the same linear falloff as the
           damage; the hurt tank at the centre also takes a small vertical pop
           — the hop is spent by the next drive step (see pushImpact). Applied
           BEFORE the damage call, because takeDamage can end the tank here,
           and pushImpact refuses dead/dying hulls. */
        if(t.pushImpact){
          const bd = Math.max(1e-6, d);
          if(bd > 0.1) t.pushImpact((t.x - this.x) / bd, (t.z - this.z) / bd,
                                    maxD * f * ((CONFIG && CONFIG.IMPULSE_BLAST) || 0.055),
                                    {hop: f * ((CONFIG && CONFIG.IMPULSE_BLAST_HOP) || 1.1)});
          else t.pushImpact(this.dir.x, this.dir.z,
                            maxD * f * ((CONFIG && CONFIG.IMPULSE_BLAST) || 0.055),
                            {hop: f * ((CONFIG && CONFIG.IMPULSE_BLAST_HOP) || 1.1)});
        }
        t.takeDamage(minD + (maxD - minD) * f, this.owner, game);
      }
      /* Base Defend bases take blast too, and by the same argument as the boxes
         below: a mortar that lands on the objective should be worth more than
         one that lands beside it. The bases carry their own no-friendly-fire
         rule, so the owner's team is filtered inside splashAt rather than here
         — one place to keep it, rather than a check each new damage source has
         to remember to copy. */
      if(typeof BaseDefend !== 'undefined' && BaseDefend.getState()){
        BaseDefend.splashAt(this.x, this.z, R, maxD, minD, this.owner);
      }

      /* Gladiator blue boxes take blast as well — a shell that lands on the
         crate is worth as much as one that lands on the tank behind it. */
      if(game._gladBoxes){
        for(const b of game._gladBoxes){
          if(!b.alive) continue;
          const d = Math.hypot(b.x - this.x, b.z - this.z);
          if(d > R) continue;
          const f = 1 - (d / R);
          b.hp -= (minD + (maxD - minD) * f) * 2;
          if(b.hp <= 0){
            game._gladKillBox(b);
            if(this.owner === game.localTank && typeof Menu !== 'undefined' && Menu.toast)
              Menu.toast('\u26A1 Blue box destroyed! +5 power dropped');
          }
        }
      }
    }

    if(!game) return;

    /* THE ARTILLERY BLAST, sized to the damage.
       MortarBlast takes the splash radius verbatim, so the fireball's silhouette
       and its ground shockwave both land exactly on the circle the player aimed
       inside a second and a half earlier. It runs for EVERY shell, not only the
       player's own — the old call below handed `vfxOnly` detonations the same
       small puff, which meant a remote artillery shell landing next to you
       announced itself with a quarter of the area it was about to take. */
    if(typeof MortarBlast !== 'undefined' && game.scene){
      MortarBlast.spawn(game.scene, this.x, R * 0.42, this.z, R);
    }

    /* Blast scale is derived from the splash radius, not fixed, so a tank with a
       wider bomb gets a wider bang instead of the same bang on a bigger circle. */
    const big = Math.max(3, Math.round(R / 3));
    game.spawnExplosion(this.x, 0.9, this.z, 0xff8a2a, big, 'boom');
    if(game.spawnBurst){
      game.spawnBurst(this.x, 0.8, this.z, {count:26, tex:'flare', speed:16, size:0.60, life:0.55, rise:2.6, gravity:14, blend:'add'});
      game.spawnBurst(this.x, 0.7, this.z, {count:14, tex:'smoke', speed:4.2, size:1.5,  life:1.10, rise:2.4, gravity:2.5, blend:'normal'});
      game.spawnBurst(this.x, 0.5, this.z, {count:12, tex:'dust',  speed:9.0, size:1.3, life:0.70, rise:1.2, gravity:7.0, blend:'normal', fade:0.7});
    }
    /* Camera shake, scaled by how close the blast was. Deliberately NOT gated on
       vfxOnly: a remote player's artillery going off in the next tile over
       should still knock the camera about, because being unable to see or feel
       the hit is most of what makes artillery miserable from the receiving
       end. */
    if(game.localTank && game.localTank.alive && game.addShake){
      const d = Math.hypot(game.localTank.x - this.x, game.localTank.z - this.z);
      const reach = R * 3.2;
      if(d < reach) game.addShake(0.85 * (1 - d / reach));
    }
  }
}

/* Flamethrower cone (Inferno) — visual triangle cone + distance-based damage. */
class FlameCone {
  constructor(owner, pos, dir, def){
    this.id = 'p' + (_nextProjId++);
    this.owner = owner;
    this.def = def;
    this.x = pos.x; this.y = pos.y; this.z = pos.z;
    this.dir = dir.clone().normalize();
    this.range = def.shellRange || 25;
    this.damage = Math.round((def.damage||18) * (owner && owner.powerMult ? owner.powerMult() : 1));
    this.life = 0.22;
    this.maxLife = 0.22;
    this.dead = false;
    this.type = 'flame';
    this.group = new THREE.Group();
    this.group.position.set(this.x, this.y, this.z);
    this._buildVisual();
  }

  _buildVisual(){
    const range = this.range;
    const tanHalf = (this.def && this.def.fireConeHalfAngle) || 0.18;
    const halfW = range * Math.tan(tanHalf);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(-halfW, range);
    shape.lineTo(halfW, range);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff6600,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this._coneMesh = new THREE.Mesh(geo, mat);
    this._coneMesh.position.set(0, 0.3, 0);
    this.group.add(this._coneMesh);
  }

  attach(scene){ scene.add(this.group); this.scene=scene; }
  detach(){
    if(this.scene){ this.scene.remove(this.group); this.scene=null; }
    if(this._coneMesh){
      this._coneMesh.geometry.dispose();
      this._coneMesh.material.dispose();
    }
  }

  _damageAtDist(dist){
    const falloff = 1 - (dist / this.range);
    return this.damage * Math.max(0.2, falloff);
  }

  update(dt, world, game){
    this.life -= dt;
    if(this.life <= 0){ this.dead = true; return; }

    if(this._networked){ return; }

    let coneBlocked = false;
    if(world){
      const steps = Math.ceil(this.range / 6);
      for(let s=1; s<=steps; s++){
        const frac = s / steps;
        const cx = this.x + this.dir.x * this.range * frac;
        const cz = this.z + this.dir.z * this.range * frac;
        const r = this.range * (this.def && this.def.fireConeHalfAngle || 0.18) * frac + 0.4;
        if(world.collidesWallsOnly(cx, cz, r)){ coneBlocked = true; break; }
      }
    }

    const tanHalf = this.def && this.def.fireConeHalfAngle || 0.18;
    for(const t of game.tanks){
      if(!t.alive || t === this.owner) continue;
      if(this.owner.allyId && (t.id === this.owner.allyId || t.allyId === this.owner.id)) continue;
      if(this.owner.team && t.team && this.owner.team === t.team) continue;
      const dx = t.x - this.x, dz = t.z - this.z;
      const dist = Math.hypot(dx, dz);
      if(dist > this.range) continue;
      const along = dx * this.dir.x + dz * this.dir.z;
      if(along <= 0) continue;
      const perp = Math.sqrt(Math.max(0, dist*dist - along*along));
      const maxPerp = along * tanHalf + 0.6;
      if(perp > maxPerp) continue;
      if(coneBlocked) continue;
      t.takeDamage(this._damageAtDist(dist) * dt * 10, this.owner, game, true);
    }

    if(game && game._gladBoxes){
      for(const b of game._gladBoxes){
        if(!b.alive) continue;
        const bdx = b.x - this.x, bdz = b.z - this.z;
        const bdist = Math.hypot(bdx, bdz);
        if(bdist > this.range) continue;
        const balong = bdx * this.dir.x + bdz * this.dir.z;
        if(balong <= 0) continue;
        const bperp = Math.sqrt(Math.max(0, bdist * bdist - balong * balong));
        if(bperp > balong * tanHalf + 0.6) continue;
        if(coneBlocked) continue;
        b.hp -= this._damageAtDist(bdist) * dt * 10;
        if(b.hp <= 0){
          game._gladKillBox(b);
          if(this.owner === game.localTank) Menu.toast('\u26A1 Blue box destroyed! +5 power dropped');
        }
      }
    }

    if(this._coneMesh){
      const lifeRatio = this.life / this.maxLife;
      const growPhase = Math.min(1, (1 - lifeRatio) * 5);
      this._coneMesh.material.opacity = 0.45 * growPhase * lifeRatio;
      const s = 0.3 + 0.7 * growPhase;
      this._coneMesh.scale.set(s, 1, s);
    }

    if(this.life <= 0) this.dead = true;
  }
}

/* Visual-only explosion: layered, soft-stylized puff. Mixes a soft 8-ray
   starburst flash, shockwave ring, organic fire blobs, star sparks, debris
   shards, fluffy smoke clouds, embers and dust — so no single round "yellow
   ball" dominates. `style` picks a preset (boom/barrel/wall/small/box/drop). */
const EXPLOSION_STYLES = {
  boom:   { life:0.6,  flash:2.4, ring:true,  fire:0.5, embers:3, smoke:0.7, dust:0 },
  barrel: { life:0.65, flash:2.6, ring:true,  fire:0.8, embers:5, smoke:0.85,dust:0 },
  wall:   { life:0.45, flash:1.2, ring:false, fire:0,   embers:0, smoke:0,   dust:6 },
  small:  { life:0.4,  flash:1.0, ring:false, fire:0,   embers:0, smoke:0,   dust:4 },
  box:    { life:0.5,  flash:1.6, ring:true,  fire:0,   embers:1, smoke:0.35,dust:0 },
  drop:   { life:0.5,  flash:1.8, ring:true,  fire:0,   embers:2, smoke:0.6, dust:0 },
  burn:   { life:0.35, flash:0.8, ring:false, fire:0,   embers:3, smoke:0,   dust:2 },
  lrg:    { life:0.9,  flash:2.8, ring:true,  fire:1.1, embers:5, smoke:1.0, dust:0, smokeCol:1.4 },
};
class Explosion {
  constructor(x,y,z,color,count,style){
    this.x=x;this.y=y;this.z=z;this.dead=false;
    this.group=new THREE.Group(); this.group.position.set(x,y,z);
    this.parts=[];
    const tint = new THREE.Color(color || 0xffaa33);
    const white = new THREE.Color(0xffffff);
    const n = Math.max(2, count|0 || 6);
    const st = EXPLOSION_STYLES[style] || EXPLOSION_STYLES.boom;
    const K = Math.min(1.45, 0.68 + n*0.05);
    this.maxLife = this.life = st.life;

    /* THE BLAST HAS A DIRECTION. A real ground burst never pushes out equally
       in every horizontal direction — it leans one way, pushes the fire
       harder along that lean, and the wobble inside it is what makes the
       silhouette visibly change while it lives. Picked once per explosion:
       average reads as a circle, single reads as a spike. */
    const axisA = Math.random() * Math.PI * 2;
    const axisX = Math.cos(axisA), axisZ = Math.sin(axisA);
    this._axisX = axisX; this._axisZ = axisZ;

    // 0) Soft starburst flash — the bright "pop", gently whitened
    if(st.flash > 0){
      const flashTint = tint.clone().lerp(white, 0.5);
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('starsoft'), color:flashTint, transparent:true, opacity:1, blending:THREE.AdditiveBlending, depthWrite:false}));
      const fs = (4.6 * K) * (st.flash / 2.4);
      flash.scale.set(fs, fs, 1);
      flash.userData = {type:'flash', base:fs};
      this.group.add(flash); this.parts.push(flash);
    }

    // 1) Expanding shockwave ring hugs the ground
    if(st.ring){
      const ring = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('ring'), color:tint, transparent:true, opacity:0.8, blending:THREE.AdditiveBlending, depthWrite:false}));
      ring.scale.set(0.8,0.8,1);
      ring.position.y = 0.02;
      ring.userData = {type:'ring'};
      this.group.add(ring); this.parts.push(ring);
    }

    // 2) Organic fire blobs — CLUMPED LOBES, OFF-AXIS, SQUASHED LENS.
    const fireN = Math.max(0, Math.round(st.fire * n));
    /* The fire is born in 2-3 CLUMPS, each with its own centre and its own
       wobble, instead of one lobe apiece spread evenly around a ring. An
       even ring is the exact reason every explosion looked like a drawn
       cartoon ball: a circle of same-size blobs is a circle. Clumps are how
       real blast structure forms — a few big lobes, ragged gaps between
       them, quiet corners the fire never reached. */
    const clumpN = fireN > 5 ? 3 : 2;
    const clumps = [];
    for(let c=0;c<clumpN;c++){
      const ca = Math.random()*Math.PI*2;
      const cr = 0.08 + Math.random()*0.30;
      clumps.push({x: Math.cos(ca)*cr, y: Math.random()*0.30, z: Math.sin(ca)*cr, ph: Math.random()*Math.PI*2});
    }
    for(let i=0;i<fireN;i++){
      const cl = clumps[i % clumpN];
      const spd = 1.0 + Math.random()*1.4;
      const sc = (1.0 + Math.random()*0.7) * K;
      /* A FEW BIG ONES AMONG SMALLER ONES.

         Every blob was the same size within 30%, so the fireball's outline was a
         near-perfect circle and the eye read it as a drawn ball. Real blast
         structure is lumpy: a handful of large lobes and a scatter of smaller
         ones, and the irregularity is most of what makes it look like fire
         rather than a sphere.

         Squaring the random biases toward the small end, so the big lobes stay
         rare enough to read as lobes instead of the new normal case. */
      const r = Math.pow(Math.random(), 2);
      const sc2 = sc * (0.45 + r * 1.15);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('blobfire'), color:tint, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, depthWrite:false}));
      /* Born inside its clump, jittered — not on a shared ring. */
      sp.position.set(cl.x + (Math.random()-0.5)*0.22, cl.y + Math.random()*0.20, cl.z + (Math.random()-0.5)*0.22);
      sp.scale.set(sc2, sc2, 1);
      /* Velocity = a random ejection direction BLENDED WITH the blast axis,
         so the burst visibly leans one way while its lobes still fight
         each other. The blend is half-and-half, never a full lean. */
      const a = Math.random()*Math.PI*2;
      sp.userData = {
        type:'fire',
        v:new THREE.Vector3(Math.cos(a)*spd + axisX*spd*0.5, 1.6 + Math.random(), Math.sin(a)*spd + axisZ*spd*0.5),
        base:sc2,
        wp: cl.ph + i * 1.13,            /* wobble phase */
        wa: Math.random()*Math.PI*2,     /* wobble direction */
        wf: 2.2 + Math.random()*2.6      /* wobble frequency */
      };
      this.group.add(sp); this.parts.push(sp);
    }

    // 3) Star sparks racing outward (fast, gravity, spinning)
    for(let i=0;i<n;i++){
      const a = Math.random()*Math.PI*2;
      const spd = 3.5 + Math.random()*7;
      const base = (0.34 + Math.random()*0.3) * K;
      const u = {type:'spark', v:new THREE.Vector3(Math.cos(a)*spd + axisX*spd*0.22, 1.2 + Math.random()*1.6, Math.sin(a)*spd + axisZ*spd*0.22), g:11+Math.random()*5, spin:8+Math.random()*14, base};
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('spark'), color:white, transparent:true, opacity:0.95, blending:THREE.AdditiveBlending, depthWrite:false}));
      sp.position.set((Math.random()-0.5)*0.4, Math.random()*0.4, (Math.random()-0.5)*0.4);
      sp.rotation.z = Math.random()*Math.PI*2;
      sp.scale.set(base, base, 1);
      sp.userData = u;
      this.group.add(sp); this.parts.push(sp);
    }

    // 4) Debris shards: chunky triangles / hex plates, spinning, heavy fall
    const shardN = Math.max(1, Math.ceil(n/2));
    for(let i=0;i<shardN;i++){
      const a = Math.random()*Math.PI*2;
      const spd = 2 + Math.random()*4;
      const base = (0.55 + Math.random()*0.4) * K;
      const u = {type:'shard', v:new THREE.Vector3(Math.cos(a)*spd, 1+Math.random()*2, Math.sin(a)*spd), g:6+Math.random()*3, spin:(Math.random()<0.5?-1:1)*(3+Math.random()*6), base};
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex(i%2===0?'shard':'hex'), color:tint, transparent:true, opacity:0.9, depthWrite:false}));
      sp.position.set((Math.random()-0.5)*0.5, Math.random()*0.5, (Math.random()-0.5)*0.5);
      sp.rotation.z = Math.random()*Math.PI*2;
      sp.scale.set(base, base, 1);
      sp.userData = u;
      this.group.add(sp); this.parts.push(sp);
    }

    // 5) Fluffy smoke clouds (normal blend, slow rise, grow large)
    const smokeN = Math.max(1, Math.round(st.smoke * n));
    for(let i=0;i<smokeN;i++){
      const a = Math.random()*Math.PI*2;
      const spd = 0.3 + Math.random()*0.8;
      const sc = (0.9 + Math.random()*0.9) * K;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('cloud'), transparent:true, opacity:0.55, depthWrite:false}));
      sp.position.set(Math.cos(a)*0.2, Math.random()*0.3, Math.sin(a)*0.2);
      sp.scale.set(sc,sc,1);
      sp.userData = {type:'smoke', v:new THREE.Vector3(Math.cos(a)*spd, 0.6+Math.random()*0.6, Math.sin(a)*spd), base:sc};
      this.group.add(sp); this.parts.push(sp);
    }

    // 6) Dust kick (normal blend, fast outward drift, fades fast)
    const dustN = st.dust || 0;
    for(let i=0;i<dustN;i++){
      const a = Math.random()*Math.PI*2;
      const spd = 1.6 + Math.random()*2.2;
      const sc = (0.7 + Math.random()*0.6) * K;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('dust'), transparent:true, opacity:0.45, depthWrite:false}));
      sp.position.set(Math.cos(a)*0.15, Math.random()*0.25, Math.sin(a)*0.15);
      sp.scale.set(sc,sc,1);
      sp.userData = {type:'dust', v:new THREE.Vector3(Math.cos(a)*spd, 0.4+Math.random()*0.4, Math.sin(a)*spd), base:sc};
      this.group.add(sp); this.parts.push(sp);
    }

    // 7) Embers floating up (additive, small, glowing)
    const embN = st.embers || 0;
    for(let i=0;i<embN;i++){
      const a = Math.random()*Math.PI*2;
      const sc = (0.16 + Math.random()*0.14) * K;
      const u = {type:'ember', v:new THREE.Vector3(Math.cos(a)*0.6, 2.0+Math.random()*1.2, Math.sin(a)*0.6), base:sc};
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('ember'), transparent:true, opacity:0.8, blending:THREE.AdditiveBlending, depthWrite:false}));
      sp.position.set((Math.random()-0.5)*0.3, Math.random()*0.3, (Math.random()-0.5)*0.3);
      sp.scale.set(sc,sc,1);
      sp.userData = u;
      this.group.add(sp); this.parts.push(sp);
    }

    // 8) THE UPWARD JET — a thin bright column that shoots up the middle
    /* A ground blast's most recognisable shape is not its fireball, it is the
       JET: the push of gas straight up from the blast point, bright and thin
       and gone almost immediately. One sprite, cheap beyond argument, doing
       more for "that looks like an explosion" than the rest of the burst
       combined. Fires only on styles that have fire (booms with no fire stay
       dust-only). */
    if(st.fire > 0){
      const jet = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('flame'), color:tint, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, depthWrite:false}));
      jet.position.set(axisX*0.12, 0.30, axisZ*0.12);
      jet.scale.set(0.42*K, 0.95*K, 1);
      jet.userData = {
        type:'jet',
        v:new THREE.Vector3(axisX*0.5, 6.2 + Math.random()*2.4, axisZ*0.5),
        base:0.95*K,
        fLife: 0.36,   /* lives well under the blast's own life */
        t: 0
      };
      this.group.add(jet); this.parts.push(jet);
    }
  }
  attach(scene){ scene.add(this.group); this.scene=scene; }
  detach(){
    if(this.scene){ this.scene.remove(this.group); this.scene=null; }
    this.parts.forEach(p => { if(p.material) p.material.dispose(); });
    this.parts = [];
  }
  update(dt){
    this.life-=dt;
    const lifeK = Math.max(0, this.life/this.maxLife); // 1 -> 0
    const k = 1 - lifeK;                                // 0 -> 1
    this.parts.forEach(p=>{
      const u = p.userData;
      switch(u.type){
        case 'flash':
          p.scale.setScalar(u.base * (lifeK*0.5 + 0.5));
          p.material.opacity = lifeK;
          break;
        case 'ring':
          p.scale.setScalar(0.8 + k*k*7.5);
          p.material.opacity = Math.max(0, 0.85*(1-k*k));
          break;
        case 'fire':
          /* DRAG, AND A FIREBALL THAT GOES WIDER THAN IT IS TALL.

             This moved at constant velocity and grew linearly, which is why the
             silhouette read as a cartoon puff rather than a blast. Real fire
             does neither.

             It expands hard for the first fraction of a second and is then
             braked hard by the air it is pushing, so the outline is a fast
             bulge that settles -- not a balloon inflating at one rate forever.

             And it spreads WIDER THAN IT CLIMBS. A blast at ground level cannot
             push air down into the ground, so it goes sideways much faster than
             it goes up, and the classic fireball is a squashed lens rather than
             a ball. Scaling Y by less than X is that shape, and it is pure
             geometry -- nothing to do with textures.

             FRONT-LOADED. The old growth was linear in k, so half the visual
             expansion happened in half the blast's life — the burst kept
             inflating steadily instead of BANGING out. min(1, k*2.2) puts most
             of the expansion into the first ~45% of the life, and what is left
             is drift and fade. That early surge is most of the "physical"
             reading: the silhouette arrives, then settles.

             TURBULENCE. Each lobe carries a slow wobble — a small sideways
             push with its own phase, direction and frequency — plus a ~9%
             scale flutter. The silhouette visibly SHIMMERS while it lives
             instead of growing like a balloon, which is what separates
             burning gas from an inflating ball.

             The flattening eases in rather than being baked in at spawn, so the
             fireball is genuinely spherical for the first few frames (the part
             that is brightest and fastest) and settles into the lens as it
             dies. */
          p.position.addScaledVector(u.v, dt);
          u.v.multiplyScalar(Math.max(0, 1 - 2.6 * dt));   // drag
          u.v.y -= 3 * dt;
          const wob = Math.sin(k * u.wf * 6.283 + u.wp) * 0.5 * dt;
          p.position.x += wob * Math.cos(u.wa);
          p.position.z += wob * Math.sin(u.wa);
          const fs = u.base * (1 + Math.min(1, k * 2.2) * 1.4);
          const flat = 1 - 0.42 * Math.min(1, k * 1.6);
          const jac = 1 + 0.09 * Math.sin(k * 22 + u.wp * 3);
          p.scale.set(fs * jac, fs * flat * jac, 1);
          p.material.opacity = Math.max(0, 0.9 * (1 - k * k));
          break;
        case 'spark':
          p.position.addScaledVector(u.v, dt);
          u.v.y -= u.g*dt;
          p.rotation.z += u.spin*dt;
          p.scale.set(Math.max(0.1, u.base*(1 - k*k*0.6)), Math.max(0.1, u.base*(1 - k*k*0.6)), 1);
          p.material.opacity = Math.max(0, 0.95*lifeK);
          break;
        case 'shard':
          p.position.addScaledVector(u.v, dt);
          u.v.y -= u.g*dt;
          p.rotation.z += u.spin*dt;
          p.scale.setScalar(u.base*(1+k*0.8));
          p.material.opacity = Math.max(0, 0.9*lifeK);
          break;
        case 'smoke':
          p.position.addScaledVector(u.v, dt);
          u.v.y += 0.5*dt;
          p.scale.setScalar(u.base*(1+k*1.6));
          p.material.opacity = Math.max(0, 0.55*lifeK);
          break;
        case 'dust':
          p.position.addScaledVector(u.v, dt);
          u.v.y -= 2*dt;
          p.scale.setScalar(u.base*(1+k*1.3));
          p.material.opacity = Math.max(0, 0.45*lifeK);
          break;
        case 'ember':
          p.position.addScaledVector(u.v, dt);
          u.v.y += (1.4 - 1.5*dt);
          p.scale.setScalar(Math.max(0.05, u.base*(1 - k*0.6)));
          p.material.opacity = Math.max(0, 0.8*lifeK);
          break;
        case 'jet':
          /* THE COLUMN. Rises on drag (the gas decelerates as it climbs),
             stays THIN — it stretches in height while its width grows only
             half as fast — and dies on a hard quadratic, because a jet does
             not fade politely, it stops existing. The whole thing is over
             before the rest of the blast has even finished expanding,
             exactly the beat a real one keeps. */
          u.t += dt;
          p.position.addScaledVector(u.v, dt);
          u.v.multiplyScalar(Math.max(0, 1 - 1.8 * dt));
          { 
            const jk = Math.min(1, u.t / u.fLife);        /* 0..1 over its life */
            const jh = u.base * (1 + jk * 1.1);           /* height */
            p.scale.set(jh * 0.42, jh, 1);                /* thin, climbing */
            p.material.opacity = Math.max(0, (1 - jk * jk) * 0.85);
          }
          break;
      }
    });
    if(this.life<=0) this.dead=true;
  }
}

/* ============================================================
   LandmineManager — shared instanced mesh pool for all mines.
   One CylinderGeometry body + one RingGeometry glow, updated
   per-mine. Much cheaper than individual meshes.
   ============================================================ */
var LandmineManager = {
  _bodyGeo: null, _bodyMat: null, _glowGeo: null, _glowMat: null,
  _bodyInst: null, _glowInst: null,
  _maxSlots: 30,
  _mines: [],
  _scene: null,

  init(scene){
    if(this._bodyInst) return;
    this._scene = scene;
    this._bodyGeo = new THREE.CylinderGeometry(0.42, 0.52, 0.16, 8);
    this._bodyMat = Toon.mat({color:0x555555});
    this._glowGeo = new THREE.RingGeometry(0.4, 0.72, 12);
    this._glowMat = new THREE.MeshBasicMaterial({color:0xff2200, transparent:true, opacity:0.5, side:THREE.DoubleSide, depthWrite:false});
    this._bodyInst = new THREE.InstancedMesh(this._bodyGeo, this._bodyMat, this._maxSlots);
    this._bodyInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._bodyInst.frustumCulled = false;
    this._bodyInst.count = 0;
    this._glowInst = new THREE.InstancedMesh(this._glowGeo, this._glowMat, this._maxSlots);
    this._glowInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._glowInst.frustumCulled = false;
    this._glowInst.count = 0;
    scene.add(this._bodyInst);
    scene.add(this._glowInst);
  },

  add(mine){
    this._mines.push(mine);
    this._syncCount();
  },

  remove(mine){
    var idx = this._mines.indexOf(mine);
    if(idx >= 0){
      var last = this._mines.length - 1;
      if(idx !== last){ this._mines[idx] = this._mines[last]; }
      this._mines.pop();
      this._syncCount();
    }
  },

  _syncCount(){
    var n = this._mines.length;
    if(this._bodyInst) this._bodyInst.count = n;
    if(this._glowInst) this._glowInst.count = n;
  },

  update(time){
    var n = this._mines.length;
    if(!n || !this._bodyInst) return;
    var _m4 = this._m4 || (this._m4 = new THREE.Matrix4());
    var _q = this._q || (this._q = new THREE.Quaternion());
    var _s = this._s || (this._s = new THREE.Vector3(1,1,1));
    for(var i = 0; i < n; i++){
      var m = this._mines[i];
      _m4.identity();
      _m4.makeRotationX(-Math.PI/2);
      _m4.setPosition(m.x, m.y, m.z);
      this._bodyInst.setMatrixAt(i, _m4);
      var blink = 0.25 + 0.55 * Math.abs(Math.sin(time * 4 + i * 1.7));
      _m4.identity();
      _m4.makeRotationX(-Math.PI/2);
      _m4.setPosition(m.x, m.y + 0.03, m.z);
      this._glowInst.setMatrixAt(i, _m4);
      this._glowInst.setColorAt(i, this._tmpCol || (this._tmpCol = new THREE.Color()));
      this._tmpCol.setRGB(1, 0.13 + blink * 0.3, 0);
    }
    this._bodyInst.instanceMatrix.needsUpdate = true;
    this._glowInst.instanceMatrix.needsUpdate = true;
    if(this._glowInst.instanceColor) this._glowInst.instanceColor.needsUpdate = true;
  },

  clear(){
    this._mines.length = 0;
    this._syncCount();
  }
};

/* ============================================================
   Landmine — Vortex's ground mine. Static (no physics body),
   detonates on proximity or after fuse. Managed by LandmineManager.
   ============================================================ */
class Landmine {
  constructor(owner, pos, def){
    this.id = 'p' + (_nextProjId++);
    this.owner = owner;
    /* THE THROW, NOT THE DROP.

       This used to be a mine that simply APPEARED ten metres in front of the
       tank: no flight, no arc, nothing between the barrel and the ground. It
       read as a glitch — the gun fired and a mine was already lying there.

       So the mine now leaves the muzzle and flies. `mineFlight` is how long it
       is in the air (seconds) and `mineArc` how high it goes at the top of that
       flight, in metres. It is a shallow, slow lob: fixed flight time, so the
       range is the aim rather than a power setting, and a modest arc, so it
       drops onto the spot instead of sailing over the far side.

       Nothing about it is armed until it touches down. The proximity test and
       the fuse both stay off for the whole flight, so a mine cannot detonate
       against the tank that threw it — the muzzle is inside its own owner's
       footprint, and an armed-from-the-hand mine would be a self-kill every
       single shot. */
    this._flight = (def.mineFlight || 0);
    this._arc = (def.mineArc || 0);
    this._flightT = 0;
    this._landed = this._flight <= 0;

    /* Where it was thrown FROM, and where it is going. Computed once, in the
       constructor, from the caller's muzzle — doing it per frame would let the
       tank drive off and drag the mine's landing spot with it. */
    const from = (def && def._mineFrom) || null;
    if(this._flight > 0 && from){
      /* Launch point and landing point are both fixed HERE. The landing spot is
         computed once from the tank's heading at the moment of firing, so a
         driving tank cannot drag its own mine's target around behind it. */
      this._x0 = from.x; this._z0 = from.z; this._y0 = Math.max(0.18, from.y != null ? from.y : 0.18);
      this._x1 = pos.x; this._z1 = pos.z;
      this.x = from.x; this.z = from.z; this.y = this._y0;
    } else {
      this._x0 = this._x1 = null;
      this.x = pos.x; this.y = 0.18; this.z = pos.z;
    }

    this.damage = def.mineDamage || 65;
    this.proximity = def.mineProximity || 3.0;
    this.fuse = def.mineFuse || 30;
    this.life = this.fuse;
    this.dead = false;
    this.type = 'mine';
    this.scene = null;
    this._landed = this._flight <= 0;
    /* The fuse starts counting on touchdown, not on release. */
    this._armed = this._landed;
  }

  /* Height of the lob at fraction f (0..1) of the flight. A parabola through
     both endpoints: zero at the muzzle, zero at the ground, `mineArc` at the
     top. sin() rather than a quadratic because a quadratic spends most of its
     time near the ground and the mine would skitter along the deck instead of
     visibly flying. */
  _flightY(f){
    return Math.sin(Math.PI * f) * this._arc;
  }

  attach(scene){
    this.scene = scene;
    LandmineManager.init(scene);
    LandmineManager.add(this);
  }
  detach(){
    LandmineManager.remove(this);
    this.scene = null;
  }

  update(dt, world, game){
    if(this.dead) return;

    /* IN FLIGHT. Nothing here can detonate: not the fuse, not a tank driving
       underneath it. The mine is a thrown object until it lands, and a client
       renders the throw without ever arming it. */
    if(!this._landed){
      this._flightT += dt;
      const f = Math.min(1, this._flightT / this._flight);
      /* Linear across the ground, so it lands exactly where it was aimed and the
         arc only controls HOW it gets there. Interpolating toward a stored
         endpoint rather than the current position matters: using `this.x` as
         both the start and the end of the lerp would make the mine converge on
         itself and never travel. */
      this.x = this._x0 + (this._x1 - this._x0) * f;
      this.z = this._z0 + (this._z1 - this._z0) * f;
      this.y = 0.18 + this._flightY(f);
      if(f >= 1){
        this._landed = true;
        this._armed = true;
        this.y = 0.18;
      }
      return;
    }

    this.life -= dt;
    if(this.life <= 0){ this._detonate(game); return; }

    /* A MINE ON A CLIENT IS A PICTURE OF A MINE, NOT A MINE.

       The host owns damage in this game. A mine rebuilt on a client from the
       host's snapshot (see Game._applyHostState) is flagged _networked, and it
       must never detonate here: it would deal damage the host never authorised,
       and it would go off the moment any local tank walked near it — including
       the player's own, which is not what the host simulated. The host tells
       this client what happened by simply stopping to send it, and the snapshot
       handler removes it. */
    if(this._networked) return;

    for(var i = 0; i < game.tanks.length; i++){
      var t = game.tanks[i];
      if(!t.alive || t === this.owner) continue;
      if(this.owner.allyId && (t.id === this.owner.allyId || t.allyId === this.owner.id)) continue;
      /* A proximity fuse is measured against the same footprint as a direct hit,
       so a shell does not burst early just because it passed beside the tank on
       the long axis and early-narrow on the short one. */
      if(t.hitTest2D(this.x, this.z, this.proximity)){
        this._detonate(game);
        return;
      }
    }
  }

  _detonate(game){
    if(this.dead) return;
    /* Same rule as update(): a networked mine is the host's to detonate. This
       guard is here as well because _detonate() is called from the fuse above
       and, on a client, that is the only path that would reach it. */
    if(this._networked){ this.dead = true; this.detach(); return; }
    this.dead = true;
    var hx = this.x, hz = this.z;
    var dmg = this.damage;
    if(game){
      game.spawnExplosion(hx, 1.5, hz, 0xff6a2a, 10, 'boom');
      if(game.spawnBurst){
        game.spawnBurst(hx, 1.0, hz, {count:14, tex:'flare', speed:12, size:0.55, life:0.45, rise:3, gravity:16});
        game.spawnBurst(hx, 0.8, hz, {count:8, tex:'smoke', speed:3, size:1.0, life:0.6, rise:2, gravity:4, blend:'normal'});
      }
      for(var i = 0; i < game.tanks.length; i++){
        var t = game.tanks[i];
        if(!t.alive || t === this.owner) continue;
      if(this.owner.allyId && (t.id === this.owner.allyId || t.allyId === this.owner.id)) continue;
      if(this.owner.team && t.team && this.owner.team === t.team) continue;
        var dx = t.x - hx, dz = t.z - hz;
        var dist = Math.sqrt(dx*dx + dz*dz);
        if(dist < 5.5){
          var falloff = 1 - dist / 5.5;
          t.takeDamage(Math.round(dmg * falloff), this.owner, game);
        }
      }
      if(game.localTank && game.localTank.alive){
        var d = Math.hypot(game.localTank.x - hx, game.localTank.z - hz);
        if(d < 22) game.addShake(0.6 * (1 - d / 22));
      }
    }
  }
}

/* ============================================================
   ShellCasing — yellow metallic fired-case that pops out of the
   tank's "shell" port, launched with a real Rapier rigidbody, then
   the tank fires the actual projectile ~1s later.
   ============================================================ */
class ShellCasing {
  constructor(pos, vel, physicsWorld){
    this.x = pos.x; this.y = pos.y; this.z = pos.z;
    this.life = 5; this.maxLife = 5; this.dead = false;
    this._physWorld = physicsWorld || null;
    this._physBody = null;
    // Manual-ballistic fallback (no physics world / Rapier missing)
    this._fallVX = vel.x || 0; this._fallVY = vel.y || 0; this._fallVZ = vel.z || 0;
    this._initPhysBody(vel);
    this._build();
  }

  _initPhysBody(vel){
    if(!this._physWorld || typeof RAPIER === 'undefined') return;
    try {
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(this.x, this.y, this.z)
        .setCcdEnabled(true)
        .setLinearDamping(0.3)
        .setAngularDamping(1.0);
      this._physBody = this._physWorld.createRigidBody(desc);
      const col = RAPIER.ColliderDesc.cylinder(0.09, 0.07)
        .setDensity(3)
        .setRestitution(0.25)
        .setFriction(0.7);
      this._physWorld.createCollider(col, this._physBody);
      this._physBody.setLinvel({x: vel.x || 0, y: vel.y || 0, z: vel.z || 0}, true);
      this._physBody.setAngvel({x:(Math.random()-0.5)*18, y:(Math.random()-0.5)*10, z:(Math.random()-0.5)*18}, true);
    } catch(e){ this._physBody = null; }
  }

  static _initShared(){
    if(!ShellCasing._sharedGeo) ShellCasing._sharedGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.18, 8);
    if(!ShellCasing._sharedMat) ShellCasing._sharedMat = Toon.mat({color:0xe8b02a, emissive:0x6a4a00, emissiveIntensity:0.5});
  }

  /* ============================================================================
     THE CASING IS INSTANCED ON THE SAME TERMS AS THE SHELL

     A casing is one shared 8-sided cylinder with a Rapier rigid body throwing it
     across the deck, and game.js already caps concurrent casings at 18. Eighteen
     draw calls for eighteen brass tubes is the same mistake the shells were
     making, one class down: the geometry is shared and the only per-casing thing
     is the transform Rapier hands back, which is exactly what an instance matrix
     is for. One batch, 24 slots, one draw call for all of them.

     IT IS ITS OWN BATCH rather than another family inside Shell's, because it
     shares nothing with either round -- different geometry, different material,
     different scale semantics -- and the one thing both classes do share is the
     scratch matrix and the once-per-frame call, which is why
     Shell.updateInstances() drives this one too.
  ========================================================================== */
  static _SLOTS = 24;
  static _batch = null;
  static _live = new Set();

  _build(){
    ShellCasing._initShared();
    if(!ShellCasing._batch){
      const im = new THREE.InstancedMesh(ShellCasing._sharedGeo, ShellCasing._sharedMat, ShellCasing._SLOTS);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      /* Same reason as the shell batches: the instances are wherever Rapier
         bounced them, and a bounding sphere baked at creation describes none of
         them. */
      im.frustumCulled = false;
      /* The one shadow caster in this file. The casing mesh used to say
         castShadow = true; that flag is a property of the drawn object, and the
         drawn object is now the batch. A thrown brass tube glinting in the sun
         for its five seconds of life is the whole point of the effect. */
      im.castShadow = true;
      im.receiveShadow = false;
      im.count = 0;
      ShellCasing._batch = im;
    }
    this.mesh = new THREE.Object3D();
    this.mesh.position.set(this.x, this.y, this.z);
    this._inScene = false;
    ShellCasing._live.add(this);
  }

  /* See Shell.attach: the batch goes in the scene, the casing goes on the list.
     add() re-parents, so a casing attaching to a second scene takes the batch
     with it rather than leaving it behind in the first. */
  attach(scene){
    const im = ShellCasing._batch;
    if(im && im.parent !== scene) scene.add(im);
    this.scene = scene;
    this._inScene = true;
  }
  detach(){
    this._removePhysBody();
    /* Same as the shells: there is no per-casing geometry to take out of the
       scene, and nothing is disposed. The dispose() that used to sit here was
       guarded by `geometry !== _sharedGeo` against a mesh that was constructed
       from _sharedGeo and never replaced, so it had nothing to do. */
    this.scene = null;
    this._inScene = false;
    ShellCasing._live.delete(this);
  }

  /* Called from Shell.updateInstances(), not from the frame loop directly --
     see the note there on why the two go out as one call. */
  static updateInstances(){
    const im = ShellCasing._batch;
    if(!im) return;
    /* Shell's scratch, deliberately. A second Matrix4 here would be a second
       64-byte object that exists for the sake of not sharing, and the two
       rebuilds are called from the same place and can never overlap. */
    const m = Shell._instMat;
    let n = 0;
    for(const c of ShellCasing._live){
      if(n >= ShellCasing._SLOTS) break;
      if(!c.mesh || !c._inScene) continue;
      /* The rotation is Rapier's, the scale is the shrink-out in update(), and
         both were written onto this object's own components before instancing
         and are written onto them now, so compose() sees the same three numbers
         the old Mesh would have been given. */
      m.compose(c.mesh.position, c.mesh.quaternion, c.mesh.scale);
      im.setMatrixAt(n++, m);
    }
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
  }
  _removePhysBody(){
    if(this._physBody && this._physWorld){
      try { this._physWorld.removeRigidBody(this._physBody); } catch(e){}
      this._physBody = null;
    }
  }

  update(dt, world, game){
    if(this.dead) return;
    this.life -= dt;
    if(this.life <= 0){ this.dead = true; return; }

    if(this._physBody){
      try {
        const t = this._physBody.translation();
        this.x = t.x; this.y = t.y; this.z = t.z;
        const q = this._physBody.rotation();
        this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      } catch(e){}
    } else {
      this._fallVY -= 18 * dt;
      this.x += this._fallVX * dt;
      this.y += this._fallVY * dt;
      this.z += this._fallVZ * dt;
      if(this.y <= 0.12 && this._fallVY < 0){
        this.y = 0.12;
        this._fallVY *= -0.3;
        this._fallVX *= 0.5; this._fallVZ *= 0.5;
        if(Math.abs(this._fallVY) < 0.8) this._fallVY = 0;
      }
    }
    this.mesh.position.set(this.x, this.y, this.z);
    // Shrink out during the last moments (keep shared material untouched)
    /* Shrink away over the last 0.4s of life, RELATIVE TO THIS SHELL'S OWN SIZE.

       This used to be a bare setScalar(life / 0.4), which was correct only
       because every shell was full size. A shotgun pellet is built at 0.34, so
       that line would have overwritten its scale on the frame it died and popped
       the pellet up to full size as it faded — a flash of a big shell exactly
       when it should be shrinking out of sight. Scaling by the base keeps the
       fade identical for a normal shell (base 1) and correct for a pellet. */
    if(this.life < 0.4){
      this.mesh.scale.setScalar(Math.max(0.01, this.life / 0.4) * (this._baseScale || 1));
    }
  }
}
