/* items.js — Health boxes and health pickups */

const HEALTH_BOX_SIZES = [
  { hp:75,  tier:1, scale:0.6, label:'Small'  },
  { hp:150, tier:2, scale:0.8, label:'Medium' },
  { hp:250, tier:3, scale:1.0, label:'Large'  },
];

const HEALTH_PICKUP_HEAL = [0, 100, 0.25, -1];

let _pickupIdSeq = 0;
let _boxIdSeq = 0;

/* ---------- Health Pickup ---------- */
class HealthPickup {
  constructor(x, z, tier, scene){
    this.id = 'pickup_' + (++_pickupIdSeq);
    this.x = x; this.z = z; this.tier = tier;
    this.alive = true;
    this._phase = 'idle';
    this._flyT = 0;
    this._trailParticles = [];
    this._spawnTime = Date.now(); // delay collection briefly so user sees it

    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    const colors = ['#3ad17a', '#ffb12b', '#ff3b3b'];
    const col = colors[Math.min(tier-1, colors.length-1)];
    const glow = ['rgba(58,209,122,0.6)', 'rgba(255,177,43,0.6)', 'rgba(255,59,59,0.6)'][Math.min(tier-1,2)];
    g.shadowColor = glow; g.shadowBlur = 20;

    if(tier === 3){
      g.fillStyle = '#fff';
      g.shadowColor = 'rgba(255,215,0,0.8)'; g.shadowBlur = 30;
      g.font = 'bold 72px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('+', 64, 60);
      g.font = 'bold 28px Arial'; g.fillText('FULL', 64, 108);
    } else if(tier === 2){
      g.fillStyle = col; g.font = 'bold 56px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('+25%', 64, 64);
    } else {
      g.fillStyle = col; g.font = 'bold 56px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('+100', 64, 64);
    }

    const tex = new THREE.CanvasTexture(c); tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({map:tex, transparent:true, depthTest:false});
    this.sprite = new THREE.Sprite(mat);
    this.sprite.position.set(x, 1.0, z);
    this.sprite.scale.set(2.5, 2.5, 1);
    if(scene) scene.add(this.sprite);
    this.scene = scene;

    this._trailTex = this._makeTrailTex();
  }

  _makeTrailTex(){
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(58,255,122,1)');
    grd.addColorStop(0.3, 'rgba(58,209,122,0.8)');
    grd.addColorStop(1, 'rgba(58,209,122,0)');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    return tex;
  }

  attach(scene){ this.scene = scene; scene.add(this.sprite); }
  detach(){
    if(this.scene){
      this.scene.remove(this.sprite);
      this._cleanupTrail();
    }
  }

  _cleanupTrail(){
    for(const p of this._trailParticles){
      if(p.parent) p.parent.remove(p);
      if(p.material) p.material.dispose();
    }
    this._trailParticles = [];
  }

  canPickup(tank){
    if(this._phase !== 'idle' || !tank.alive || tank.dying) return false;
    if(Date.now() - this._spawnTime < 400) return false; // 0.4s delay so user sees pickup
    const dx = tank.x - this.x, dz = tank.z - this.z;
    const rad = Math.max(tank.def.body.w, tank.def.body.l)/2 + 1.2;
    return dx*dx + dz*dz < rad*rad;
  }

  collect(tank, game){
    if(this._phase !== 'idle') return;
    this._phase = 'flying';
    this._flyT = 0;
    this._targetTank = tank;
    this._game = game;
    this._startX = this.x; this._startZ = this.z; this._startY = 1.0;
    this._targetX = tank.x; this._targetZ = tank.z;
    this._trailTimer = 0;
    this._spawnedTrailPositions = [];
  }

  update(dt, game){
    if(this._phase !== 'flying') return;
    this._flyT += dt;

    // Phase 1: rise up quickly (first 0.35s)
    const riseTime = 0.35;
    let progress;
    if(this._flyT < riseTime){
      const t = this._flyT / riseTime;
      this.sprite.position.y = 1.0 + t * 3.0; // rises from 1 to 4
      this.sprite.scale.setScalar(2.5 + t * 1.5);
      progress = 0;
    } else {
      // Phase 2: zoom toward tank with acceleration, track current position
      this._targetX += (this._targetTank.x - this._targetX) * 0.15;
      this._targetZ += (this._targetTank.z - this._targetZ) * 0.15;
      const flyTime = this._flyT - riseTime;
      const dx = this._targetX - this._startX, dz = this._targetZ - this._startZ;
      const dist = Math.hypot(this._targetX - this.x, this._targetZ - this.z);
      if(dist < 0.5){
        this._finish();
        return;
      }
      // Accelerating movement: speed increases over time
      const ease = Math.min(1, flyTime * 1.8); // reaches target in ~0.55s
      const eased = ease * ease; // ease-in squared for acceleration feel
      this.x = this._startX + dx * eased;
      this.z = this._startZ + dz * eased;
      this.sprite.position.set(this.x, 4.0 - eased * 2.0 + 0.5, this.z);
      this.sprite.scale.setScalar(4.0 * (1 - eased * 0.7));
      progress = eased;

      if(eased >= 1){
        this._finish();
        return;
      }
    }

    // Spawn trail particles
    this._trailTimer += dt;
    if(this._trailTimer >= 0.025){
      this._trailTimer = 0;
      this._spawnTrailParticle();
    }
  }

  _spawnTrailParticle(){
    if(!this.scene) return;
    const mat = new THREE.SpriteMaterial({
      map: this._trailTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    });
    const spr = new THREE.Sprite(mat);
    spr.position.copy(this.sprite.position);
    spr.position.y += 0.3;
    const sz = 0.8 + Math.random() * 0.6;
    spr.scale.set(sz, sz, 1);
    spr.userData = { life: 0.6, maxLife: 0.6, vx: (Math.random()-0.5)*0.5, vz: (Math.random()-0.5)*0.5 };
    this.scene.add(spr);
    this._trailParticles.push(spr);
  }

  _updateTrailParticles(dt){
    for(let i = this._trailParticles.length - 1; i >= 0; i--){
      const p = this._trailParticles[i];
      p.userData.life -= dt;
      if(p.userData.life <= 0){
        if(p.parent) p.parent.remove(p);
        p.material.dispose();
        this._trailParticles.splice(i, 1);
        continue;
      }
      const t = p.userData.life / p.userData.maxLife;
      p.material.opacity = t;
      p.scale.multiplyScalar(0.97);
      p.position.x += (p.userData.vx || 0) * dt;
      p.position.z += (p.userData.vz || 0) * dt;
    }
  }

  _finish(){
    if(!this.alive) return;
    const tank = this._targetTank;
    if(tank){
      let amount;
      if(this.tier === 3) amount = tank.maxHp;
      else if(this.tier === 2) amount = Math.ceil(tank.maxHp * 0.25);
      else amount = 100;
      const oldHp = tank.hp;
      tank.heal(amount);
      const healed = tank.hp - oldHp;
      if(healed > 0 && this.scene){
        const c = document.createElement('canvas');
        c.width = 128; c.height = 64;
        const g = c.getContext('2d');
        g.fillStyle = '#3ad17a'; g.font = 'bold 32px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 6;
        g.fillText('+'+Math.ceil(healed)+' HP', 64, 32);
        const tex = new THREE.CanvasTexture(c);
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({map:tex, transparent:true, depthTest:false}));
        spr.position.set(tank.x, 3.5, tank.z);
        spr.scale.set(3, 1.5, 1);
        if(this.scene) this.scene.add(spr);
        setTimeout(() => { if(spr.parent) spr.parent.remove(spr); spr.material.dispose(); }, 1200);
      }
    }
    this.alive = false;
    this._cleanupTrail();
    if(this.scene) this.scene.remove(this.sprite);
  }
}

/* ---------- Health Box (destructible box that drops health pickups) ---------- */
class HealthBox {
  constructor(x, z, sizeIndex, scene){
    this.id = 'hbox_' + (++_boxIdSeq);
    this.x = x;
    this.z = z;
    this.sizeIndex = sizeIndex;
    const def = HEALTH_BOX_SIZES[sizeIndex] || HEALTH_BOX_SIZES[0];
    this.maxHp = def.hp;
    this.hp = this.maxHp;
    this.tier = def.tier;
    this.scale = def.scale;
    this.alive = true;
    this._angle = Math.random() * Math.PI * 2;

    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0,0,128,128);
    grd.addColorStop(0, '#2d8a4a');
    grd.addColorStop(0.5, '#3ad17a');
    grd.addColorStop(1, '#2d8a4a');
    g.fillStyle = grd;
    g.fillRect(0,0,128,128);
    g.strokeStyle = '#1a5a2a';
    g.lineWidth = 6;
    g.strokeRect(4,4,120,120);

    g.fillStyle = '#ffffff';
    g.shadowColor = 'rgba(255,255,255,0.5)';
    g.shadowBlur = 10;
    g.font = 'bold 80px Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('+', 64, 64);

    // Tier badge
    const tierColors = ['#3ad17a','#ffb12b','#ff3b3b'];
    g.shadowBlur = 0;
    g.fillStyle = '#000';
    g.font = 'bold 22px Arial';
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.fillText('Lv' + this.tier, 120, 124);
    g.fillStyle = tierColors[Math.min(this.tier-1,2)];
    g.fillText('Lv' + this.tier, 118, 122);

    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    const mat = Toon.mat({map:tex});
    const boxSize = 1.2 * this.scale;
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(boxSize, boxSize, boxSize), mat);
    this.mesh.position.set(x, boxSize/2 + 0.2, z);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    // Outline
    const outlineMat = new THREE.MeshBasicMaterial({color:0x000000, side:THREE.BackSide});
    const outline = new THREE.Mesh(new THREE.BoxGeometry(boxSize*1.06, boxSize*1.06, boxSize*1.06), outlineMat);
    outline.position.copy(this.mesh.position);
    outline.renderOrder = -1;
    this.outline = outline;

    if(scene){
      scene.add(this.mesh);
      scene.add(outline);
    }
    this.scene = scene;
  }

  attach(scene){
    this.scene = scene;
    scene.add(this.mesh);
    scene.add(this.outline);
  }
  detach(){
    if(this.scene){
      this.scene.remove(this.mesh);
      this.scene.remove(this.outline);
    }
  }

  update(dt){
    if(!this.alive) return;
    this._angle += dt * 1.5;
    this.mesh.rotation.y = this._angle;
    this.outline.rotation.y = this._angle;
    this.mesh.position.y = (1.2 * this.scale)/2 + 0.2 + Math.sin(this._angle * 2) * 0.08;
    this.outline.position.copy(this.mesh.position);
  }

  takeDamage(amount, game){
    if(!this.alive) return;
    this.hp -= amount;
    if(this.hp <= 0){
      this.alive = false;
      if(game && this.scene){
        game.spawnHealthPickup(this.x, this.z, this.tier);
      }
      // Explosion
      if(this.scene){
        const p = this.mesh.position.clone();
        const geo = new THREE.SphereGeometry(0.05, 4, 4);
        for(let i=0; i<12; i++){
          const mat = new THREE.MeshBasicMaterial({
            color: [0x3ad17a, 0x2d8a4a, 0x1a5a2a][Math.floor(Math.random()*3)],
          });
          const sp = new THREE.Mesh(geo, mat);
          sp.position.copy(p);
          sp.userData.vx = (Math.random()-0.5)*4;
          sp.userData.vz = (Math.random()-0.5)*4;
          sp.userData.vy = 1+Math.random()*3;
          sp.scale.setScalar(0.3+Math.random()*0.5);
          this.scene.add(sp);
          if(game) game._boxDebris = game._boxDebris || [];
          game._boxDebris.push(sp);
        }
        setTimeout(() => {
          if(this.scene) this.scene.remove(this.mesh);
          if(this.scene) this.scene.remove(this.outline);
        }, 100);
      }
    } else {
      // Flash white on hit
      this.mesh.material.emissive = new THREE.Color(0x44ff88);
      this.mesh.material.emissiveIntensity = 0.6;
      setTimeout(() => {
        if(this.mesh && this.mesh.material){
          this.mesh.material.emissive = new THREE.Color(0);
          this.mesh.material.emissiveIntensity = 0;
        }
      }, 100);
    }
  }
}
