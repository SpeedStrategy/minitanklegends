/* ============================================================================
   bruno-explosion.js — Bruno Simon-style explosion (single sphere, optimized)
   
   A single sphere with a custom shader. Uses procedural noise for displacement
   and color mapping. Triplanar projection for seamless noise. Expands rapidly,
   then fades out over its short lifecycle.
   
   Optimized: 1 sphere, 1 material, 1 draw call. No particles, no sprites.
   ============================================================================ */

const BrunoExplosion = (() => {
  const LIFE = 0.8;  // seconds
  let _noiseTex = null;
  let _meshes = [];

  function noiseTexture() {
    if (_noiseTex) return _noiseTex;
    const S = 128;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    // Simple value noise
    const P = 16;
    const lat = new Float32Array(P * P);
    for (let i = 0; i < P * P; i++) lat[i] = Math.random();
    const at = (x, y) => lat[((y % P) + P) % P * P + (((x % P) + P) % P)];
    const smooth = (x, y, freq) => {
      const fx = x * freq, fy = y * freq;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const v00 = at(x0, y0), v10 = at(x0 + 1, y0);
      const v01 = at(x0, y0 + 1), v11 = at(x0 + 1, y0 + 1);
      const a = v00 + (v10 - v00) * tx;
      const b = v01 + (v11 - v01) * tx;
      return a + (b - a) * ty;
    };
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = (smooth(x / S, y / S, 4) + smooth(x / S, y / S, 8) * 0.5 + smooth(x / S, y / S, 16) * 0.25) / 1.75;
        const v = Math.floor(n * 255);
        const i = (y * S + x) * 4;
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    _noiseTex = new THREE.CanvasTexture(c);
    _noiseTex.wrapS = THREE.RepeatWrapping;
    _noiseTex.wrapT = THREE.RepeatWrapping;
    return _noiseTex;
  }

  const vertexShader = `
    uniform float uTime;
    uniform float uScale;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying float vNoise;

    // Simplex noise (simplified)
    vec3 mod289(vec3 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
    vec4 mod289(vec4 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
    vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
    float snoise(vec3 v){
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4(0.0, i1.y, i2.y, 1.0))
        + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }

    void main() {
      vNormal = normalize(normalMatrix * normal);
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      
      // Triplanar-ish noise: sample from 3 axes
      float n1 = snoise(position * 2.0 + uTime * 0.5);
      float n2 = snoise(position.yzx * 2.0 + uTime * 0.3);
      float n3 = snoise(position.zxy * 2.0 + uTime * 0.4);
      float noise = (n1 + n2 + n3) / 3.0;
      vNoise = noise;
      
      // Displace along normal
      vec3 displaced = position + normal * noise * 0.3 * uScale;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
    }
  `;

  const fragmentShader = `
    uniform float uTime;
    uniform float uOpacity;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying float vNoise;

    void main() {
      // Color gradient: white core -> orange -> red -> smoke
      float n = (vNoise + 1.0) * 0.5; // 0..1
      
      vec3 white = vec3(1.0, 1.0, 1.0);
      vec3 orange = vec3(1.0, 0.5, 0.1);
      vec3 red = vec3(0.8, 0.1, 0.0);
      vec3 smoke = vec3(0.3, 0.3, 0.3);
      
      vec3 color;
      if (n > 0.7) color = mix(orange, white, (n - 0.7) / 0.3);
      else if (n > 0.4) color = mix(red, orange, (n - 0.4) / 0.3);
      else if (n > 0.15) color = mix(smoke, red, (n - 0.15) / 0.25);
      else color = smoke;
      
      // Emission boost
      color *= 1.5;
      
      // Fresnel for edge glow
      vec3 viewDir = normalize(cameraPosition - vWorldPos);
      float fresnel = 1.0 - abs(dot(viewDir, vNormal));
      fresnel = pow(fresnel, 2.0);
      color += vec3(1.0, 0.6, 0.2) * fresnel * 0.5;
      
      gl_FragColor = vec4(color, uOpacity);
    }
  `;

  function spawn(scene, x, y, z, scale) {
    scale = scale || 5.0;
    const geo = new THREE.SphereGeometry(1, 16, 12); // low poly
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 1.0 },
        uOpacity: { value: 1.0 }
      },
      vertexShader: vertexShader,
      fragmentShader: fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(0.1);
    scene.add(mesh);
    _meshes.push({ mesh, mat, life: 0, maxLife: LIFE, scale: scale });
    return mesh;
  }

  function update(scene, dt) {
    for (let i = _meshes.length - 1; i >= 0; i--) {
      const e = _meshes[i];
      e.life += dt;
      const t = Math.min(e.life / e.maxLife, 1.0);
      
      // Scale up rapidly, then hold
      const s = e.scale * (0.1 + 0.9 * Math.min(t * 3, 1.0));
      e.mesh.scale.setScalar(s);
      
      // Opacity: fade out in last half
      e.mat.uniforms.uTime.value = e.life;
      e.mat.uniforms.uScale.value = 1.0 + t * 0.5;
      e.mat.uniforms.uOpacity.value = t < 0.5 ? 1.0 : (1.0 - (t - 0.5) * 2);
      
      if (e.life >= e.maxLife) {
        scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        e.mat.dispose();
        _meshes.splice(i, 1);
      }
    }
  }

  function clear() {
    // nothing to clear globally
  }

  return { spawn, update, clear };
})();

if (typeof window !== 'undefined') window.BrunoExplosion = BrunoExplosion;
path: 'C:\Users\Nojus\Downloads\TL\MiniTankLegendsCline\js\bruno-explosion.js'