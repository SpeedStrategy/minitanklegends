/* ============================================================================
   Stage 2 of the three.js upgrade — the first TSL (Three Shading Language)
   port.

   WHY THIS FILE EXISTS
   The game renders with THREE.WebGLRenderer, which only understands GLSL
   `ShaderMaterial`. The WebGPU renderer does not: its material registry
   auto-converts exactly 13 classic material types (MeshBasic/Phong/Standard/
   Physical/Toon/Lambert/Normal/Matcap, Line, LineDashed, Points, Sprite,
   Shadow) and `ShaderMaterial` is deliberately not one of them, and
   `onBeforeCompile` does not exist over there either. So the renderer can only
   be swapped AFTER every custom shader has a TSL twin. This is twin #1 — the
   lake in js/water-shader.js, which is the only custom shader the live game
   actually renders with (of the 19 entries in js/shaders.js only `water` and
   `grass3d` are referenced at all, and both only by the map editor).

   NOT CALLED BY THE GAME YET
   Nothing can execute TSL while the renderer is still WebGLRenderer. The
   page tsl-compare.html renders this next to the original GLSL and measures
   the difference, so the port can be proven before the renderer ever changes.

   CLASSIC SCRIPT, NO `import`
   Like every other file in js/, this is injected as a classic script, so the
   TSL/WebGPU modules arrive through `await window.loadTSL()` (see index.html)
   instead of a static import.
   ============================================================================ */

class WaterTSL {

  static ready(){
    return !!(window.TSL && window.WebGPU && window.THREE);
  }

  /* Value noise, transcribed from the GLSL hash()/noise() pair in
     water-shader.js. Written with method chains (`.mul`, `.add`, `.sub`)
     because plain `*` on a TSL node is not overloaded. The classic
     `f*f*(3.0-2.0*f)` easing is expanded to `3f^2 - 2f^3` so that every
     operator stays scalar-times-vector and no vec2 splat is needed. */
  static _noise(T){
    const { fract, sin, floor, dot, mix, vec2 } = T;
    const hash = (p) => fract( sin( dot( p, vec2(127.1, 311.7) ) ).mul(43758.5453) );
    return function(p){
      const i = floor(p);
      const f = fract(p);
      const ff = f.mul(f).mul(3.0).sub( f.mul(f).mul(f).mul(2.0) );
      const a = hash(i);
      const b = hash(i.add(vec2(1.0, 0.0)));
      const c = hash(i.add(vec2(0.0, 1.0)));
      const d = hash(i.add(vec2(1.0, 1.0)));
      return mix( mix(a, b, ff.x), mix(c, d, ff.x), ff.y );
    };
  }

  /* Build the TSL twin of WaterShader.createMaterial().
     Returns { material, uniforms } where every uniform is a live TSL node, so
     `bundle.uniforms.uTime.value = t` drives it exactly like the GLSL uniform
     object did. */
  static build(){
    if(!WaterTSL.ready()){
      throw new Error('WaterTSL.build(): await window.loadTSL() first');
    }

    const T = window.TSL;
    const THREE = window.THREE;
    const { uniform, vec2, vec3, vec4, float, mix, smoothstep, step, sin, cos,
            floor, fract, dot, length, atan, max, distance,
            positionGeometry, modelWorldMatrix } = T;
    const noise = WaterTSL._noise(T);

    // ---- uniforms: same names, same defaults as WaterShader ----
    const uTime         = uniform(0.0);
    const uDeepColor    = uniform(new THREE.Color(0.318, 0.529, 1.0));
    const uSurfaceColor = uniform(new THREE.Color(0.0, 0.45, 0.85));
    const uAquaColor    = uniform(new THREE.Color(0.318, 0.667, 1.0));
    const uFoamColor    = uniform(new THREE.Color(1.0, 1.0, 1.0));
    const uTankPosition = uniform(new THREE.Vector3(0, 0, 0));

    /* ---- vertex ----
       The GLSL takes `modelMatrix * pos` BEFORE applying the wave and passes
       that along as vWorldPos, then nudges pos.y afterwards. Deriving the
       world position from positionGeometry (the untouched attribute) and
       displacing positionGeometry as well reproduces that exactly — and it
       keeps the graph acyclic, because three writes
       `positionLocal.assign(positionNode)` when positionNode is set, so
       reading positionLocal/positionWorld from inside positionNode would be a
       self-reference. */
    const rawWorld = modelWorldMatrix.mul( vec4(positionGeometry, 1.0) ).xyz;
    const vWorldPos = rawWorld.toVarying('vWorldPosTSL');

    const wave = sin( rawWorld.x.mul(0.2).add( uTime.mul(1.5) ) )
                   .mul( cos( rawWorld.z.mul(0.2).add( uTime.mul(1.2) ) ) )
                   .mul(0.04);
    const positionNode = positionGeometry.add( vec3(0.0, max(0.0, wave), 0.0) );

    // ---- fragment ----
    const p = vWorldPos.xz;                 // vWorldPos.xz is all the GLSL reads
    const t = uTime;

    /* underwater depth currents (slow) */
    const depthUV = p.mul(0.08).add( vec2( t.mul(0.05), t.mul(0.03) ) );
    let baseWater = mix( uSurfaceColor, uDeepColor,
                         smoothstep(-0.2, 0.5, noise(depthUV)) );

    /* shore edge with heavy noise distortion */
    const uvNode = (typeof T.uv === 'function') ? T.uv(0) : T.uv;
    const centerOffset = uvNode.sub( vec2(0.5) );
    let distFromCenter = length(centerOffset).mul(2.0);
    const angle = atan( centerOffset.y, centerOffset.x );   // 2-arg atan == atan2
    distFromCenter = distFromCenter
      .add( sin( angle.mul(5.0).add(t.mul(0.3)) ).mul(0.04) )
      .add( sin( angle.mul(8.0).add(t.mul(0.2)).add(1.2) ).mul(0.025) )
      .add( sin( angle.mul(3.0).add(t.mul(0.15)).add(3.1) ).mul(0.03) );

    const shoreUV  = p.mul(0.2).add( vec2( sin(t.mul(1.5)).mul(0.4),
                                           sin(t.mul(0.4)).mul(0.6) ) );
    const shoreUV2 = p.mul(0.4).add( vec2( sin(t.mul(0.7)).mul(0.6),
                                           sin(t.mul(0.25)).mul(0.8) ) );
    const shoreEdge = distFromCenter
                        .add( noise(shoreUV).mul(0.25) )
                        .add( noise(shoreUV2).mul(0.12) );

    /* aqua rim near shore */
    baseWater = mix( baseWater, uAquaColor, smoothstep(0.6, 0.85, shoreEdge) );

    /* sharp shoreline foam — ragged inner edge toward lake.
       The GLSL adds a scalar to a vec2 here (implicit broadcast), which is
       spelled out as vec2() so TSL does not have to infer the promotion. */
    const foamJitter = noise( p.mul(0.8).add( vec2( sin(t.mul(0.3)).mul(0.4) ) ) ).mul(0.10);
    const foamBreath = sin(t.mul(0.3)).mul(0.04);
    const shorelineFoam = step( float(0.93).add(foamJitter).add(foamBreath), shoreEdge );

    /* floating surface foam patches */
    const surfaceUV = p.mul(0.35).add( vec2( sin(t.mul(0.25)).mul(0.6),
                                             sin(t.mul(0.18)).mul(0.4) ) );
    const surfaceFoam = step( 0.75, noise(surfaceUV) );

    /* tank contact ring */
    const distToTank = distance( p, uTankPosition.xz );
    const tankRing = step(distToTank, 2.5).mul( step(1.0, distToTank) )
                          .mul( step(0.4, noise( p.mul(0.3).add( vec2(t.mul(0.05)) ) )) );

    /* final assembly */
    const finalColor = mix( baseWater, uFoamColor,
                            max( surfaceFoam.mul(0.7), shorelineFoam.add(tankRing) ) );

    const material = new window.WebGPU.MeshBasicNodeMaterial();
    material.positionNode = positionNode;
    // Alpha goes in the vec4, not an `alphaNode`: NodeMaterial has no alphaNode
    // property at all (three only adds one to its toon-outline helper), so
    // assigning it is silently ignored and the water renders opaque instead of
    // at 0.93. Measured that exact failure before catching it here.
    material.colorNode    = vec4(finalColor, 0.93);   // gl_FragColor = vec4(color, 0.93)
    material.transparent  = true;
    material.depthWrite   = false;
    material.side         = THREE.DoubleSide;

    return {
      material: material,
      uniforms: {
        uTime: uTime,
        uDeepColor: uDeepColor,
        uSurfaceColor: uSurfaceColor,
        uAquaColor: uAquaColor,
        uFoamColor: uFoamColor,
        uTankPosition: uTankPosition
      }
    };
  }
}

window.WaterTSL = WaterTSL;
