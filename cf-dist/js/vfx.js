// VFX texture registry (procedural canvas textures - no external files needed)
const VFX = {
  _texCache: {},
  _size(name){
    if(name === 'starsoft' || name === 'blobfire' || name === 'cloud' || name === 'steam') return 128;
    if(name === 'ember') return 48;
    return 64;
  },
  _makeCanvas(name){
    const S = this._size(name);
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    const cx = S / 2;
    if(name === 'starsoft'){
      /* Soft 8-ray starburst: not a plain circle. Radial halo + tapering rays
         that fade to transparent, with a white-hot core. Reads as a "pop". */
      const halo = ctx.createRadialGradient(cx,cx,0,cx,cx,cx*0.98);
      halo.addColorStop(0, 'rgba(255,255,240,0.95)');
      halo.addColorStop(0.3, 'rgba(255,250,215,0.38)');
      halo.addColorStop(0.65, 'rgba(255,245,200,0.12)');
      halo.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = halo; ctx.fillRect(0,0,S,S);
      ctx.save(); ctx.translate(cx,cx);
      for(let i = 0; i < 8; i++){
        ctx.save();
        ctx.rotate(i * Math.PI / 4 + 0.22);
        const ray = ctx.createLinearGradient(S*0.07, 0, S*0.5, 0);
        ray.addColorStop(0, 'rgba(255,255,255,0.95)');
        ray.addColorStop(0.55, 'rgba(255,238,180,0.45)');
        ray.addColorStop(1, 'rgba(255,200,120,0)');
        ctx.beginPath();
        ctx.moveTo(S*0.07, -S*0.055);
        ctx.lineTo(S*0.5, 0);
        ctx.lineTo(S*0.07, S*0.055);
        ctx.closePath();
        ctx.fillStyle = ray; ctx.fill();
        ctx.restore();
      }
      const core = ctx.createRadialGradient(0,0,0,0,0,S*0.09);
      core.addColorStop(0, 'rgba(255,255,255,1)');
      core.addColorStop(0.6, 'rgba(255,240,200,0.85)');
      core.addColorStop(1, 'rgba(255,230,170,0)');
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(0,0,S*0.09,0,Math.PI*2); ctx.fill();
      ctx.restore();
    } else if(name === 'blobfire'){
      /* Organic fireball: several overlapping warm blobs with a bright core,
         irregular silhouette — not a uniform circle. */
      const blobs = [[cx*0.5,cx*0.58,cx*0.42],[cx*0.72,cx*0.72,cx*0.32],[cx*0.34,cx*0.74,cx*0.3],[cx*0.66,cx*0.38,cx*0.3],[cx*0.26,cx*0.5,cx*0.26],[cx*0.5,cx*1.02,cx*0.38]];
      for(const b of blobs){
        const g = ctx.createRadialGradient(b[0],b[1],0,b[0],b[1],b[2]);
        g.addColorStop(0, 'rgba(255,240,150,0.9)');
        g.addColorStop(0.4, 'rgba(255,170,45,0.7)');
        g.addColorStop(0.75, 'rgba(220,70,10,0.32)');
        g.addColorStop(1, 'rgba(160,30,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(b[0],b[1],b[2],0,Math.PI*2); ctx.fill();
      }
      const hot = ctx.createRadialGradient(cx*0.52,cx*0.66,0,cx*0.52,cx*0.66,cx*0.22);
      hot.addColorStop(0, 'rgba(255,255,215,0.98)');
      hot.addColorStop(0.5, 'rgba(255,225,90,0.75)');
      hot.addColorStop(1, 'rgba(255,180,40,0)');
      ctx.fillStyle = hot;
      ctx.beginPath(); ctx.arc(cx*0.52,cx*0.66,cx*0.22,0,Math.PI*2); ctx.fill();
    } else if(name === 'cloud'){
      /* Fluffy smoke cloud: many soft overlapping lobes with a gentle darker
         rim so it reads as a cloud, not a fuzzy circle. */
      const lobes = [[cx*0.5,cx*0.55,cx*0.4],[cx*0.66,cx*0.66,cx*0.32],[cx*0.32,cx*0.64,cx*0.3],[cx*0.7,cx*0.4,cx*0.26],[cx*0.26,cx*0.42,cx*0.22],[cx*0.52,cx*0.3,cx*0.24],[cx*0.4,cx*0.88,cx*0.26],[cx*0.68,cx*0.86,cx*0.22]];
      for(let i = 0; i < lobes.length; i++){
        const b = lobes[i];
        const g = ctx.createRadialGradient(b[0],b[1],0,b[0],b[1],b[2]);
        g.addColorStop(0, 'rgba(225,226,232,0.5)');
        g.addColorStop(0.55, 'rgba(168,170,180,0.36)');
        g.addColorStop(0.85, 'rgba(120,124,136,0.2)');
        g.addColorStop(1, 'rgba(100,104,116,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(b[0],b[1],b[2],0,Math.PI*2); ctx.fill();
      }
    } else if(name === 'steam'){
      /* Rising steam wisp: a soft vertical teardrop of light vapor. */
      const g = ctx.createRadialGradient(cx*0.5,cx*0.42,0,cx*0.5,cx*0.42,cx*0.5);
      g.addColorStop(0, 'rgba(232,234,240,0.55)');
      g.addColorStop(0.5, 'rgba(190,196,208,0.32)');
      g.addColorStop(0.85, 'rgba(150,156,170,0.12)');
      g.addColorStop(1, 'rgba(140,146,158,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(cx*0.5,cx*0.42,cx*0.3,cx*0.5,0,0,Math.PI*2); ctx.fill();
      const top = ctx.createRadialGradient(cx*0.5,cx*0.2,0,cx*0.5,cx*0.2,cx*0.24);
      top.addColorStop(0, 'rgba(240,242,248,0.4)');
      top.addColorStop(1, 'rgba(240,242,248,0)');
      ctx.fillStyle = top;
      ctx.beginPath(); ctx.arc(cx*0.5,cx*0.2,cx*0.24,0,Math.PI*2); ctx.fill();
    } else if(name === 'dust'){
      /* Warm tan dust kick: loose soft lobes, lighter core. */
      const lobes = [[cx*0.5,cx*0.55,cx*0.42],[cx*0.68,cx*0.68,cx*0.3],[cx*0.3,cx*0.66,cx*0.28],[cx*0.6,cx*0.34,cx*0.24],[cx*0.34,cx*0.4,cx*0.2]];
      for(const b of lobes){
        const g = ctx.createRadialGradient(b[0],b[1],0,b[0],b[1],b[2]);
        g.addColorStop(0, 'rgba(206,178,132,0.5)');
        g.addColorStop(0.6, 'rgba(166,138,98,0.3)');
        g.addColorStop(1, 'rgba(140,116,82,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(b[0],b[1],b[2],0,Math.PI*2); ctx.fill();
      }
    } else if(name === 'ember'){
      /* Tiny ember dot: small bright warm point thrown up by fire. */
      const g = ctx.createRadialGradient(cx,cx,0,cx,cx,cx);
      g.addColorStop(0, 'rgba(255,255,235,1)');
      g.addColorStop(0.4, 'rgba(255,220,120,0.85)');
      g.addColorStop(0.8, 'rgba(255,140,30,0.2)');
      g.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,S,S);
    } else if(name === 'flare'){
      const g = ctx.createRadialGradient(32,32,0,32,32,32);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.15, 'rgba(255,240,180,1)');
      g.addColorStop(0.4, 'rgba(255,200,80,0.8)');
      g.addColorStop(0.7, 'rgba(255,100,20,0.3)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
    } else if(name === 'smoke'){
      const g = ctx.createRadialGradient(32,32,0,32,32,30);
      g.addColorStop(0, 'rgba(180,180,180,0.5)');
      g.addColorStop(0.4, 'rgba(140,140,140,0.3)');
      g.addColorStop(0.8, 'rgba(80,80,80,0.1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
    } else if(name === 'oil'){
      const g = ctx.createRadialGradient(32,32,0,32,32,30);
      g.addColorStop(0, 'rgba(14,15,18,0.95)');
      g.addColorStop(0.45, 'rgba(20,22,28,0.9)');
      g.addColorStop(0.75, 'rgba(30,36,44,0.55)');
      g.addColorStop(1, 'rgba(40,50,60,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
      const h = ctx.createRadialGradient(26,24,0,26,24,10);
      h.addColorStop(0, 'rgba(120,130,150,0.35)');
      h.addColorStop(1, 'rgba(120,130,150,0)');
      ctx.fillStyle = h; ctx.fillRect(0,0,64,64);
      ctx.strokeStyle = 'rgba(70,85,105,0.35)';
      ctx.lineWidth = 1.5;
      for(const r of [14, 22]){
        ctx.beginPath(); ctx.arc(32,32,r,0,Math.PI*2); ctx.stroke();
      }
    } else if(name === 'fire'){
      const g = ctx.createRadialGradient(32,32,0,32,32,31);
      g.addColorStop(0, 'rgba(255,255,210,0.95)');
      g.addColorStop(0.25, 'rgba(255,200,60,0.9)');
      g.addColorStop(0.55, 'rgba(255,110,15,0.75)');
      g.addColorStop(0.8, 'rgba(200,40,5,0.35)');
      g.addColorStop(1, 'rgba(120,10,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
      const g2 = ctx.createRadialGradient(40,20,0,40,20,18);
      g2.addColorStop(0, 'rgba(255,250,200,0.7)');
      g2.addColorStop(0.5, 'rgba(255,170,40,0.35)');
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2; ctx.fillRect(0,0,64,64);
    } else if(name === 'puff'){
      /* Fluffy smoke cloud: several soft overlapping lobes (organic, not a circle) */
      const lobes = [[20,20,15],[40,17,13],[32,32,17],[48,30,12],[22,40,12],[40,45,13]];
      for(const bl of lobes){
        const g = ctx.createRadialGradient(bl[0],bl[1],0,bl[0],bl[1],bl[2]);
        g.addColorStop(0, 'rgba(205,205,205,0.55)');
        g.addColorStop(0.65, 'rgba(150,150,150,0.32)');
        g.addColorStop(1, 'rgba(110,115,120,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(bl[0],bl[1],bl[2],0,Math.PI*2); ctx.fill();
      }
    } else if(name === 'ring'){
      /* Shockwave ring: crisp stroke with a soft outer glow */
      const g = ctx.createRadialGradient(32,32,12,32,32,26);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.72, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(32,32,18,0,Math.PI*2); ctx.stroke();
    } else if(name === 'spark'){
      /* 4-point star spark: two thin crossing diamonds, bright core */
      ctx.fillStyle = 'rgba(255,255,240,0.35)';
      ctx.beginPath(); ctx.arc(32,32,20,0,Math.PI*2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.98)';
      ctx.beginPath();
      ctx.moveTo(32,3); ctx.lineTo(36,32); ctx.lineTo(32,61); ctx.lineTo(28,32);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(3,32); ctx.lineTo(32,36); ctx.lineTo(61,32); ctx.lineTo(32,28);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,244,200,1)';
      ctx.beginPath(); ctx.arc(32,32,4.5,0,Math.PI*2); ctx.fill();
    } else if(name === 'shard'){
      /* Chunky triangular debris with a bright top edge */
      const g = ctx.createLinearGradient(16,8,52,44);
      g.addColorStop(0, 'rgba(255,235,170,0.95)');
      g.addColorStop(0.45, 'rgba(210,170,90,0.85)');
      g.addColorStop(1, 'rgba(120,90,45,0.65)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(10,48);
      ctx.lineTo(46,10);
      ctx.lineTo(54,46);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,245,210,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(46,10); ctx.lineTo(54,46);
      ctx.stroke();
    } else if(name === 'hex'){
      /* Hexagonal shard plate with bevel */
      const r = 20;
      ctx.beginPath();
      for(let i=0;i<6;i++){
        const a = Math.PI/6 + i*Math.PI/3;
        const x = 32 + r*Math.cos(a), y = 32 + r*Math.sin(a);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.closePath();
      const g = ctx.createRadialGradient(32,32,0,32,32,r);
      g.addColorStop(0, 'rgba(230,225,215,0.95)');
      g.addColorStop(0.7, 'rgba(160,160,165,0.88)');
      g.addColorStop(1, 'rgba(90,95,105,0.7)');
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    } else if(name === 'streak'){
      /* Horizontal motion streak with a bright dash core */
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(1,32);
      ctx.quadraticCurveTo(26,27, 63,32);
      ctx.quadraticCurveTo(26,37, 1,32);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,240,190,0.9)';
      ctx.beginPath();
      ctx.moveTo(20,32);
      ctx.lineTo(63,32);
      ctx.lineTo(26,35);
      ctx.closePath(); ctx.fill();
    } else if(name === 'cross'){
      /* Spiky 4-ray cross starburst */
      const g = ctx.createRadialGradient(32,32,0,32,32,28);
      g.addColorStop(0, 'rgba(255,255,240,0.5)');
      g.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
      ctx.fillStyle = 'rgba(255,255,255,0.98)';
      ctx.beginPath();
      for(let i=0;i<4;i++){
        const ang = i*Math.PI/2;
        ctx.moveTo(32 + 30*Math.cos(ang), 32 + 30*Math.sin(ang));
        ctx.lineTo(32 + 7*Math.cos(ang + 0.28), 32 + 7*Math.sin(ang + 0.28));
        ctx.lineTo(32 + 7*Math.cos(ang - 0.28), 32 + 7*Math.sin(ang - 0.28));
        ctx.closePath();
      }
      ctx.fill();
    } else if(name === 'flame'){
      /* Flickering flame teardrop core */
      const g = ctx.createRadialGradient(32,42,0,32,42,24);
      g.addColorStop(0, 'rgba(255,255,210,0.95)');
      g.addColorStop(0.4, 'rgba(255,190,60,0.85)');
      g.addColorStop(0.8, 'rgba(255,90,10,0.5)');
      g.addColorStop(1, 'rgba(200,40,0,0)');
      ctx.fillStyle = g; ctx.fillRect(8,18,48,44);
      ctx.fillStyle = 'rgba(255,245,190,0.6)';
      ctx.beginPath();
      ctx.moveTo(32,8);
      ctx.quadraticCurveTo(40,24, 38,40);
      ctx.quadraticCurveTo(34,52, 32,58);
      ctx.quadraticCurveTo(28,52, 26,40);
      ctx.quadraticCurveTo(24,24, 32,8);
      ctx.fill();
    } else {
      const g = ctx.createRadialGradient(28,38,0,28,38,30);
      g.addColorStop(0, 'rgba(255,255,230,1)');
      g.addColorStop(0.15, 'rgba(255,220,120,0.95)');
      g.addColorStop(0.35, 'rgba(255,140,30,0.85)');
      g.addColorStop(0.6, 'rgba(220,60,5,0.5)');
      g.addColorStop(0.85, 'rgba(120,20,0,0.15)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
      const g2 = ctx.createRadialGradient(40,22,0,40,22,16);
      g2.addColorStop(0, 'rgba(255,240,180,0.6)');
      g2.addColorStop(0.5, 'rgba(255,160,40,0.3)');
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2; ctx.fillRect(0,0,64,64);
    }
    return c;
  },
  getTex(name){
    if(this._texCache[name]) return this._texCache[name];
    const t = new THREE.CanvasTexture(this._makeCanvas(name));
    this._texCache[name] = t;
    return t;
  }
};