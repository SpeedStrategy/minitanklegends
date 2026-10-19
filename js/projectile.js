/* ============================================================
   projectile.js — Shells + Helix flamethrower particles
   - Shell: travels, blocked by walls; flies OVER lakes (per spec)
   - Flame: short-lived particles, DPS at close range
   ============================================================ */

let _nextProjId = 1;

class Shell {
  constructor(owner, pos, dir, def, physicsWorld, inheritVel){
    this.id = 'p' + (_nextProjId++);
    this.owner = owner;
    this.x = pos.x; this.y = pos.y; this.z = pos.z;
    this.dir = dir.clone().normalize();
    const iv = inheritVel || {x:0, z:0};
    this.speed = def.shellSpeed;
    this._baseSpeed = def.shellSpeed;
    /* THE VERTICAL HALF OF THE SHOT, CARRIED FOR REAL.

       dir.y used to be read at spawn and then ignored: the Rapier body was
       launched with linvel y=0 and the manual branch stepped only x/z, so a
       pitched shot flew flat no matter where the gun pointed. Now the launch
       carries the aimed pitch as real vertical velocity and receives a light
       gravity pull every frame (SHELL_GRAVITY), so a shot aimed up crests and
       comes down and a shot dug in dips — the arc the aim line draws is the
       arc the shell flies. Mortar solves its own much stronger arc in
       game._mortarAim and does not go through this gravity. */
    this.vy = this.dir.y * this.speed;
    this._gravity = (typeof CONFIG !== 'undefined' && CONFIG.SHELL_GRAVITY) || 9.8;
    this._manualFlight = true;
    /* Closed-form launch frame, snapshotted so the ballistics never drift
       when the aim ray mutates after spawn. _launchYaw is the horizontal
       heading in the same convention the rest of the game uses
       (Math.sin/cos of yaw = x/z direction), _launchPitch is the vertical
       angle above/below horizon, and _ox/_oy/_oz is the muzzle — all read
       once, here, from the aim ray the player actually fired along. */
    this._launchYaw = Math.atan2(this.dir.x, this.dir.z);
    this._launchPitch = Math.asin(Math.max(-1, Math.min(1, this.dir.y)));
    this._ox = pos.x; this._oy = pos.y; this._oz = pos.z;
    this._age = 0;
    this._inheritX = iv.x;
    this._inheritZ = iv.z;
    this.damage = Math.round((def.damage||34) * (owner && owner.powerMult ? owner.powerMult() : 1));
    this.life = def.shellRange / def.shellSpeed;
    this.dead = false;
    this.type = 'shell';
    this.radius = 0.4;
    this._physBody = null;
    this._physWorld = physicsWorld || null;
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
      var col = this._physWorld.createCollider(RAPIER.ColliderDesc.ball(this.radius), this._physBody);
      if(col && typeof col.setActiveEvents === 'function'){
        col.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      }
      col.userData = {type:'shell', shell:this};
      var vx = this.dir.x * this.speed + this._inheritX;
      var vz = this.dir.z * this.speed + this._inheritZ;
      this._physBody.setLinvel({x: vx, y: 0, z: vz}, true);
    } catch(e){ this._physBody = null; }
  }

  static _initShared(){
    if(!Shell._sharedGeo) Shell._sharedGeo = new THREE.SphereGeometry(0.32, 8, 8);
    if(!Shell._sharedMat) Shell._sharedMat = new THREE.MeshStandardMaterial({color:0xffd24a, emissive:0xff7a1a, emissiveIntensity:0.6, roughness:0.4});
  }
  _build(){
    Shell._initShared();
    this.mesh = new THREE.Mesh(Shell._sharedGeo, Shell._sharedMat);
    this.mesh.position.set(this.x, this.y, this.z);
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

    // Angle between shell travel direction and armor surface (0 = grazing, 90 = perpendicular)
    const dotNorm = Math.abs(this.dir.x * nx + this.dir.z * nz);
    const angleFromSurface = 90 - Math.acos(Math.min(1, dotNorm)) * 180 / Math.PI;

      if(angleFromSurface < armorVal){
        if(typeof Menu !== 'undefined' && Menu.toast) Menu.toast('Ricochet!');
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
        this.mesh.lookAt(this.x + this.dir.x, this.y, this.z + this.dir.z);
        game.spawnExplosion(this.x, 1.0, this.z, 0xffeeaa, 3, 'burn');

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

        // Restart trail at ricochet point so it shows the bend
        if(this._trail && game.trailManager){
          game.trailManager.endTrail(this._trail);
          this._trail = game.trailManager.spawn(new THREE.Vector3(this.x, this.y, this.z));
        }

        return true;
      }
    return false;
  }

  attach(scene){ scene.add(this.mesh); this.scene=scene; }
  detach(){
    this._removePhysBody();
    if(this.scene){ this.scene.remove(this.mesh); this.scene=null; }
    if(this.mesh && this.mesh.geometry !== Shell._sharedGeo){
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
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

    // Network-controlled: don't move, position set by host snapshots
    if(this._networked){ return; }

    /* THE MANUAL FLIGHT MODEL: gravity-integrated ballistic step.

       Shells fly flat here no longer. The launcher's y-velocity decays by
       SHELL_GRAVITY every second, and the horizontal legs step x/z as before,
       so the shot's path is a shallow arc the GAME can predict — the aim
       ribbon samples this same closed-form at the same muzzle, so what is
       drawn is what flies. When a Rapier body exists we drive IT (sync the
       body to the solved position) so collisions still fire, rather than
       letting the flat-linvel body walk the shot straight. */
    if(this._manualFlight){
      /* Closed-form at time since LAUNCH. _age is the accumulator; keeps the
         arc consistent even when a frame hitches, and is the same expression
         the aim line uses, so drawn and flown agree exactly. */
      this._age = (this._age || 0) + dt;
      const T = this._age;
      const horiz = this.speed * T * Math.cos(this._launchPitch || 0);
      const pitch = this._launchPitch || 0;
      const g = this._gravity;

      const nx = this._ox + Math.sin(this._launchYaw) * horiz;
      const nz = this._oz + Math.cos(this._launchYaw) * horiz;
      const ny = this._oy + this.speed * Math.sin(pitch) * T - 0.5 * g * T * T;

      /* WALL HIT — in 3D this time.

         The old check used only the x/z leg, so 'does a wall block it'
         answered the WRONG QUESTION: a shell aimed over a wall was declared
         blocked, and the aim line said the same. Walls have height; the shell
         flies over the SHORT ones and the ARC RESUMES on the far side. The
         wall's top edge (h, from its mesh, affects border and custom walls
         alike) decides which; the shell only dies when it is below that edge
         AT the wall's footprint.

         ALSO THE HIT INDICATOR. When the shot IS blocked the explosion is
         anchored right here — at the real impact point on the wall face (not
         1.0 units above the ground somewhere near it) — and a red flash at
         the corner of the aim point tells the player 'this shot stops HERE'. */
      this.x = nx; this.y = ny; this.z = nz;
      if(world.collidesWallsOnly(nx, nz, this.radius)){
        const wallH = this._wallHeightAt(world, nx, nz);
        if(ny <= wallH){
          this.dead = true;
          /* Slight pullback so the explosion reads ON the wall face, not
             inside the wall volume. */
          if(this._physBody){
            try { this._physBody.setTranslation({x:nx, y:ny, z:nz}, true); } catch(e){}
          }
          game.spawnExplosion(this.x, Math.max(0.3, this.y), this.z, 0xffaa33, 6, 'wall');
          game.spawnBurst && game.spawnBurst(this.x, Math.max(0.5, this.y), this.z,
            {count: 3, tex: 'dust', speed: 3.5, size: 0.9, life: 0.4, rise: 1.2, gravity: 5, blend: 'normal', fade: 0.7});
          return;
        }
        /* Above the wall: the shell crests it and carries on. No reaction. */
      }
      if(ny < -10){ this.dead = true; return; }

      /* Keep the physics body FOLLOWING the solved ballistics so Rapier
         collision events fire at the right place against real colliders.
         set_translation, not setLinvel — we own the trajectory. */
      if(this._physBody){
        try { this._physBody.setTranslation({x:nx, y:ny, z:nz}, false); } catch(e){}
      }
    } else {
      var t = this._physBody.translation();
      this.x = t.x; this.y = t.y; this.z = t.z;
      // Kill if below world
      if(this.y < -10){ this.dead = true; return; }
      // Defensive wall check (fallback if Rapier collision event missed)
      if(world.collidesWallsOnly(this.x, this.z, this.radius)){
        this.dead = true;
        game.spawnExplosion(this.x, 1.0, this.z, 0xffaa33, 6, 'wall');
        game.spawnBurst && game.spawnBurst(this.x, 1.0, this.z, {count: 3, tex: 'dust', speed: 3.5, size: 0.9, life: 0.4, rise: 1.2, gravity: 5, blend: 'normal', fade: 0.7});
        return;
      }
    }

    // world border
    if(Math.abs(this.x) > world.half || Math.abs(this.z) > world.half){ this.dead = true; return; }
    this.mesh.position.set(this.x, this.y, this.z);
    // orient trail
    this.mesh.lookAt(this.x + this.dir.x, this.y, this.z + this.dir.z);

    // Gladiator destructible blue boxes
    if(game && game._gladBoxHit && game.glad && game._gladBoxHit(this)){ this.dead = true; return; }

    // Tank hit fallback (skip if already handled by Rapier collision events)
    for(const t of game.tanks){
      if(!t.alive || this.dead || this._hitByPhysics) continue;
      if(t === this.owner && this.life > (this.owner.def.shellRange/this.speed) - 0.15) continue;
      if(this.owner.allyId && (t.id === this.owner.allyId || t.allyId === this.owner.id)) continue;
      const dx = t.x - this.x, dz = t.z - this.z;
      const rad = (Math.max(t.def.body.w, t.def.body.l)/2 + this.radius) * (t.hitScale || 1);
      if(dx*dx + dz*dz < rad*rad){
        const armor = t.def.armor;
        if(armor && this._tryRicochet(t, game)){ continue; }
        t.takeDamage(this.damage, this.owner, game);
        game.spawnExplosion(this.x, 1.2, this.z, 0xff6a2a, 3, 'boom');
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
}

/* Flamethrower cone (Helix) — damage-only cone. Video overlay handles visuals. */
class FlameCone {
  constructor(owner, pos, dir, def){
    this.id = 'p' + (_nextProjId++);
    this.owner = owner;
    this.x = pos.x; this.y = pos.y; this.z = pos.z;
    this.dir = dir.clone().normalize();
    this.range = 25;
    this.damage = Math.round((def.damage||34) * (owner && owner.powerMult ? owner.powerMult() : 1));
    this.life = 0.22;
    this.dead = false;
    this.type = 'flame';
    this.group = new THREE.Group();
    this.group.position.set(this.x, this.y, this.z);
  }

  attach(scene){ scene.add(this.group); this.scene=scene; }
  detach(){
    if(this.scene){ this.scene.remove(this.group); this.scene=null; }
  }

  _damageAtDist(dist){
    if(dist < 10) return this.damage;
    if(dist < this.range) return this.damage * 0.5;
    return 0;
  }

  update(dt, world, game){
    this.life -= dt;
    if(this.life <= 0){ this.dead = true; return; }

    // Network-controlled: don't move, position set by host snapshots
    if(this._networked){ return; }

    let coneBlocked = false;
    if(world){
      const steps = Math.ceil(this.range / 6);
      for(let s=1; s<=steps; s++){
        const frac = s / steps;
        const cx = this.x + this.dir.x * this.range * frac;
        const cz = this.z + this.dir.z * this.range * frac;
        const r = this.range * 0.12 * frac + 0.4;
        if(world.collidesWallsOnly(cx, cz, r)){ coneBlocked = true; break; }
      }
    }

    // Damage: sweep tanks inside the cone
    const tanHalf = 0.15;
    for(const t of game.tanks){
      if(!t.alive || t === this.owner) continue;
      if(this.owner.allyId && (t.id === this.owner.allyId || t.allyId === this.owner.id)) continue;
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

    // Damage: power boxes (Helix can burn through them too)
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

    // 2) Organic fire blobs (additive, drift out + lift, balloon)
    const fireN = Math.max(0, Math.round(st.fire * n));
    for(let i=0;i<fireN;i++){
      const a = Math.random()*Math.PI*2;
      const spd = 1.0 + Math.random()*1.4;
      const sc = (1.0 + Math.random()*0.7) * K;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({map:VFX.getTex('blobfire'), color:tint, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, depthWrite:false}));
      sp.position.set(Math.cos(a)*0.25, Math.random()*0.3, Math.sin(a)*0.25);
      sp.scale.set(sc,sc,1);
      sp.userData = {type:'fire', v:new THREE.Vector3(Math.cos(a)*spd, 1.6+Math.random(), Math.sin(a)*spd), base:sc};
      this.group.add(sp); this.parts.push(sp);
    }

    // 3) Star sparks racing outward (fast, gravity, spinning)
    for(let i=0;i<n;i++){
      const a = Math.random()*Math.PI*2;
      const spd = 3.5 + Math.random()*7;
      const base = (0.34 + Math.random()*0.3) * K;
      const u = {type:'spark', v:new THREE.Vector3(Math.cos(a)*spd, Math.random()*0.6, Math.sin(a)*spd), g:11+Math.random()*5, spin:8+Math.random()*14, base};
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
          p.position.addScaledVector(u.v, dt);
          u.v.y -= 3*dt;
          p.scale.setScalar(u.base*(1+k*1.4));
          p.material.opacity = Math.max(0, 0.9*(1-k*k));
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
      }
    });
    if(this.life<=0) this.dead=true;
  }
}

/* ============================================================
   ShellCasing � yellow metallic fired-case that pops out of the
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
    if(!ShellCasing._sharedMat) ShellCasing._sharedMat = new THREE.MeshStandardMaterial({color:0xe8b02a, metalness:0.85, roughness:0.35, emissive:0x6a4a00, emissiveIntensity:0.5});
  }
  _build(){
    ShellCasing._initShared();
    this.mesh = new THREE.Mesh(ShellCasing._sharedGeo, ShellCasing._sharedMat);
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.castShadow = true;
  }

  attach(scene){ scene.add(this.mesh); this.scene = scene; }
  detach(){
    this._removePhysBody();
    if(this.scene){ this.scene.remove(this.mesh); this.scene = null; }
    if(this.mesh && this.mesh.geometry !== ShellCasing._sharedGeo){
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
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
    if(this.life < 0.4) this.mesh.scale.setScalar(Math.max(0.01, this.life / 0.4));
  }
}
