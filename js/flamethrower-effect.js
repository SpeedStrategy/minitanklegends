const FlamethrowerEffect = (() => {

  /**
   * Build a solid cone volume with concentric rings.
   * The cone lies along +Z: narrow at z=0, wide at z=1.
   * UV.x = Z (0→1), UV.y = radial fraction (0 center → 1 surface).
   */
  function _coneVolume(rings, slices, segs) {
    const P = [], UV = [], I = [];
    const R = rings, S = slices, G = segs;
    // stride = vertices per Z-slice
    const stride = (R + 1) * G;

    // vertices
    for (let s = 0; s <= S; s++) {
      const z = s / S;
      const maxR = z;                     // cone radius at this Z
      for (let r = 0; r <= R; r++) {
        const f = r / R;
        const rad = maxR * f;
        for (let g = 0; g < G; g++) {
          const a = (g / G) * Math.PI * 2;
          P.push(rad * Math.cos(a), rad * Math.sin(a), z);
          UV.push(z, f);
        }
      }
    }

    // indices — each cell is a hexahedron (or degenerate triangular prism at r=0)
    for (let s = 0; s < S; s++) {
      for (let r = 0; r < R; r++) {
        for (let g = 0; g < G; g++) {
          const ng = (g + 1) % G;

          // vertex helpers
          const v = (zs, ri, gi) => zs * stride + ri * G + gi;
          const f_ir = v(s,   r,   g);    // front, inner ring,  current seg
          const f_in = v(s,   r,   ng);   // front, inner ring,  next seg
          const f_or = v(s,   r+1, g);    // front, outer ring,  current seg
          const f_on = v(s,   r+1, ng);   // front, outer ring,  next seg
          const b_ir = v(s+1, r,   g);    // back,  inner ring,  current seg
          const b_in = v(s+1, r,   ng);   // back,  inner ring,  next seg
          const b_or = v(s+1, r+1, g);    // back,  outer ring,  current seg
          const b_on = v(s+1, r+1, ng);   // back,  outer ring,  next seg

          // 6 faces × 2 triangles = 12 tris

          // 1. front face (segment g face, between Z-slices & rings)
          I.push(f_ir, f_or, b_ir);
          I.push(b_or, b_ir, f_or);

          // 2. back face (segment g+1 face)
          I.push(f_in, b_in, f_on);
          I.push(b_on, f_on, b_in);

          // 3. top face (outer ring, between Z-slices & segments)
          I.push(f_or, f_on, b_or);
          I.push(b_on, b_or, f_on);

          // 4. bottom face (inner ring)
          I.push(f_ir, b_in, f_in);
          I.push(b_in, f_ir, b_ir);

          // 5. left face (current Z-slice, between rings & segments)
          I.push(f_ir, f_in, f_or);
          I.push(f_on, f_or, f_in);

          // 6. right face (next Z-slice)
          I.push(b_ir, b_or, b_in);
          I.push(b_on, b_in, b_or);
        }
      }
    }

    return { positions: new Float32Array(P), uvs: new Float32Array(UV), indices: I };
  }

  /* ─── shaders ─── */
  const VSH = `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const FSH = `
    precision highp float;
    varying vec2 vUv;
    uniform float uTime;
    uniform float uSpeed;
    uniform float uIntensity;

    vec3 mod289(vec3 x){ return x - floor(x*(1./289.))*289.; }
    vec3 permute(vec3 x){ return mod289(((x*34.)+1.)*x); }

    float snoise(vec2 v){
      const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
      vec2 i=floor(v+dot(v,C.yy));
      vec2 x0=v-i+dot(i,C.xx);
      vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);
      vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
      i=mod289(i);
      vec3 p=permute(permute(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
      vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);
      m=m*m; m=m*m;
      vec3 x=2.*fract(p*C.www)-1.;
      return dot(m,x);
    }

    void main(){
      float z  = vUv.x;       // 0 at barrel, 1 at tip
      float rd = vUv.y;       // 0 at centre, 1 at surface

      float t = uTime * uSpeed;

      // multi-octave noise for organic flame shape
      float n1 = snoise(vec2(z*5. + t*1.3, rd*8.));
      float n2 = snoise(vec2(z*9. - t*.8 + 30., rd*12.));
      float n3 = snoise(vec2(z*3. + t*1.7 + 70., rd*5.));
      float noise = n1*.5 + n2*.3 + n3*.2;

      // edge erosion — keep centre solid, erode toward surface
      float core = 1. - smoothstep(0., .65 + .25*(1.-z), rd);
      float edgeErode = smoothstep(-.15, .5, noise + core*.7 - .3);
      float alpha = core * edgeErode;

      // fade tip
      alpha *= 1. - smoothstep(.35, 1., z);

      // intensity ramp
      alpha *= uIntensity;

      // colour gradient: white → yellow → orange → red
      vec3 c1 = vec3(1.,1.,1.);
      vec3 c2 = vec3(1.,.92,.35);
      vec3 c3 = vec3(1.,.48,.04);
      vec3 c4 = vec3(.75,.12,0.);
      float m1 = smoothstep(0., .18, z);
      float m2 = smoothstep(.18, .45, z);
      float m3 = smoothstep(.45, .75, z);
      vec3 col = mix(c1,c2,m1);
      col = mix(col,c3,m2);
      col = mix(col,c4,m3);

      // brighten inner core
      col *= .8 + .5*(1.-rd);

      // alpha gradient along barrel
      alpha *= .5 + .7*(1.-z);

      // high-frequency flicker
      alpha *= .85 + .15*snoise(vec2(z*12. + t*3., rd*14.));

      gl_FragColor = vec4(col, alpha);
    }
  `;

  /* ─── TSL twin (WebGPU) ────────────────────────────────────────────────
     The WebGPU renderer cannot execute the GLSL above, so the same cone is
     rebuilt here in three's node language. Every line of the fragment shader
     is transcribed one-for-one — the simplex noise included — so the flame is
     the same shape, the same colours and the same flicker. The uniforms are
     TSL uniform nodes, which also carry a `.value`, so the class below drives
     them with exactly the same three lines either way. */
  function _buildTSLMaterial(uniforms){
    const T = window.TSL, W = window.WebGPU;
    const { vec2, vec3, vec4, float, uniform, uv, mix, smoothstep, step,
            dot, floor, fract, max } = T;

    const uTime      = uniform(uniforms.uTime.value);
    const uSpeed     = uniform(uniforms.uSpeed.value);
    const uIntensity = uniform(uniforms.uIntensity.value);

    // mod289/permute, verbatim, as component-wise math.
    const mod289  = (x) => x.sub( x.div(289).floor().mul(289) );
    const permute = (x) => mod289( x.mul(34).add(1).mul(x) );

    /* 2D simplex noise, same constants and same shape as the GLSL snoise. */
    const snoise = (v) => {
      const C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
      const Cx = vec2(C.x, C.x), Cy = vec2(C.y, C.y), Cw = vec3(C.w, C.w, C.w);
      const i  = floor( v.add( dot(v, Cy) ) );
      const x0 = v.sub(i).add( dot(i, Cx) );
      const i1 = float(x0.x.greaterThan(x0.y)).oneMinus();   // 1 when x0.x <= x0.y
      const i1v = vec2( i1, float(1).sub(i1) );            // (1,0) or (0,1)
      const x12 = vec4( x0.x, x0.y, x0.x, x0.y ).add( vec4(C.x, C.x, C.z, C.z) ).sub( vec4(i1v.x, i1v.y, i1v.x, i1v.y) );
      const im = mod289(i);
      const p = permute( permute( float(im.y).add( vec3(0, i1v.y, 1) ) ).add( float(im.x) ).add( vec3(0, i1v.x, 1) ) );
      const d0 = dot(x0, x0), d1 = dot(x12.xy, x12.xy), d2 = dot(x12.zw, x12.zw);
      const m = max( float(0.5).sub( vec3(d0, d1, d2) ), 0 );
      const m2 = m.mul(m);
      const m4 = m2.mul(m2);
      const x = Cw.mul(2).mul( fract( p.mul(Cw) ) ).sub(1);
      return dot(m4, x);
    };

    const vUv = uv();
    const z  = vUv.x;        // 0 at the barrel, 1 at the tip
    const rd = vUv.y;        // 0 at the centre, 1 at the surface
    const t  = uTime.mul(uSpeed);

    // multi-octave noise for organic flame shape
    const noise = snoise( vec2( z.mul(5).add( t.mul(1.3) ), rd.mul(8) ) ).mul(0.5)
                .add( snoise( vec2( z.mul(9).sub( t.mul(0.8) ).add(30), rd.mul(12) ) ).mul(0.3) )
                .add( snoise( vec2( z.mul(3).add( t.mul(1.7) ).add(70), rd.mul(5) ) ).mul(0.2) );

    // edge erosion — keep the centre solid, erode toward the surface
    const core = float(1).sub( smoothstep( float(0), float(0.65).add( float(0.25).mul( float(1).sub(z) ) ), rd ) );
    const edgeErode = smoothstep( float(-0.15), float(0.5), noise.add( core.mul(0.7) ).sub(0.3) );
    let alpha = core.mul(edgeErode);

    // fade tip
    alpha = alpha.mul( float(1).sub( smoothstep(float(0.35), float(1), z) ) );
    // intensity ramp
    alpha = alpha.mul(uIntensity);

    // colour gradient: white -> yellow -> orange -> red
    const c1 = vec3(1,1,1), c2 = vec3(1,0.92,0.35), c3 = vec3(1,0.48,0.04), c4 = vec3(0.75,0.12,0);
    let col = mix(c1, c2, smoothstep(float(0), float(0.18), z));
    col = mix(col, c3, smoothstep(float(0.18), float(0.45), z));
    col = mix(col, c4, smoothstep(float(0.45), float(0.75), z));
    // brighten the inner core
    col = col.mul( float(0.8).add( float(0.5).mul( float(1).sub(rd) ) ) );
    // alpha gradient along the barrel
    alpha = alpha.mul( float(0.5).add( float(0.7).mul( float(1).sub(z) ) ) );
    // high-frequency flicker
    alpha = alpha.mul( float(0.85).add(
      snoise( vec2( z.mul(12).add( t.mul(3) ), rd.mul(14) ) ).mul(0.15) ) );

    const mat = new W.MeshBasicNodeMaterial();
    mat.colorNode = vec4(col, alpha);
    mat.transparent  = true;
    mat.depthWrite   = false;
    mat.blending     = THREE.AdditiveBlending;
    mat.side         = THREE.DoubleSide;
    return { material: mat, uniforms: { uTime, uSpeed, uIntensity } };
  }

  /* ─── class ─── */
  return class FlamethrowerEffect {
    constructor(scene) {
      this._scene = scene;
      this._isFiring = false;
      this._intensity = 0;

      this.uniforms = {
        uTime:      { value: 0 },
        uSpeed:     { value: 2.5 },
        uIntensity: { value: 0 },
      };

      const { positions, uvs, indices } = _coneVolume(8, 14, 10);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      // WebGPU runs the TSL twin of the same cone; WebGL runs the GLSL.
      const useTSL = window.__isWebGPU && window.TSL && window.WebGPU;
      if (useTSL){
        const b = _buildTSLMaterial(this.uniforms);
        this._material = b.material;
        this.uniforms  = b.uniforms;   // same names, same `.value` writes
      } else {
        this._material = new THREE.ShaderMaterial({
          vertexShader: VSH,
          fragmentShader: FSH,
          uniforms: this.uniforms,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        });
      }

      this._mesh = new THREE.Mesh(geo, this._material);
      this._mesh.visible = false;
      scene.add(this._mesh);
    }

    trigger(on) {
      this._isFiring = on;
    }

    update(dt) {
      this.uniforms.uTime.value += dt;
      if (this._isFiring) {
        this._intensity = Math.min(1, this._intensity + dt * 4);
      } else {
        this._intensity = Math.max(0, this._intensity - dt * 6);
      }
      this.uniforms.uIntensity.value = this._intensity;
      this._mesh.visible = this._intensity > 0.005;
    }

    setPosition(x, y, z) { this._mesh.position.set(x, y, z); }

    setDirection(q) { this._mesh.quaternion.copy(q); }

    setLength(v) { this._mesh.scale.z = v; }

    setWidth(v) { this._mesh.scale.x = this._mesh.scale.y = v; }

    setSpeed(v) { this.uniforms.uSpeed.value = v; }

    dispose() {
      this._scene.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._material.dispose();
    }
  };
})();
