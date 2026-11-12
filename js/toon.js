/*  Toon-shading helpers for Mini Tank Legends
    Provides a shared gradient map and a convenience factory for
    MeshToonMaterial so every file gets the same look.
    Falls back to MeshStandardMaterial if toon is unavailable.        */

const Toon = (() => {
  let _gradientMap = null;
  let _useToon = false;

  try {
    _useToon = !!THREE.MeshToonMaterial;
  } catch(e) { _useToon = false; }

  function getGradientMap(){
    if(_gradientMap) return _gradientMap;
    if(!_useToon) return null;
    try {
      /*  3-step cel-shade: shadow / mid-tone / lit.
          RGBA texture with NearestFilter = hard edges between bands. */
      const colors = new Uint8Array([
        80, 80, 80, 255,
        170,170,170,255,
        255,255,255,255
      ]);
      const tex = new THREE.DataTexture(colors, 3, 1, THREE.RGBAFormat);
      tex.colorSpace = THREE.NoColorSpace;
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      _gradientMap = tex;
      console.log('[Toon] gradient map OK, format=RGBA');
      return _gradientMap;
    } catch(e) {
      console.warn('[Toon] gradient map failed:', e);
      _useToon = false;
      return null;
    }
  }

  function dispose(){
    if(_gradientMap){ _gradientMap.dispose(); _gradientMap = null; }
  }

  /* FLAT CEL NORMALS -- the missing half of the toon look.

     MeshToonMaterial quantises the light PER FRAGMENT using the interpolated
     normal. On a model with smooth vertex normals that interpolation is
     continuous, so the quantised bands crawl across a large soft face as long
     wavy stripes -- which reads as "ordinary gradient shading with noise",
     not cel shading. Proper cel look (Mario/Zelda-style) wants EVERY facet to
     pick ONE step: the whole triangle is uniformly in light or in shadow,
     with clean straight band edges that follow the geometry. That is exactly
     what per-face normals give, because N*L is constant inside a triangle.

     flatten(root) walks meshes and swaps in a flat-normals copy of each
     geometry: un-indexed (so vertices are not shared between triangles) with
     computeVertexNormals() rebuilt from scratch. The cache (by ORIGINAL
     geometry) guarantees two meshes that share GLB bytes share the SAME flat
     copy too, so every identity-based batcher in this game (world foliage
     batching, tank part batching -- both hash/compare geometry identity)
     still groups identical parts into one draw call.

     Skinned meshes and meshes flagged userData.toonSmooth are skipped. */
  const _flatCache = new WeakMap();

  function flatGeometry(g){
    if(_flatCache.has(g)) return _flatCache.get(g);
    let out = g;
    try {
      /* toNonIndexed() detaches every vertex from its neighbours; on the
         de-indexed copy computeVertexNormals() can only average WITHIN a
         face, which is precisely the flat shading we want. */
      const ng = g.index ? g.toNonIndexed() : g;
      if(ng !== g){
        ng.userData = ng.userData || {};
        ng.userData.toonFlat = true;
        out = ng;
      } else if(!g.userData.toonFlat){
        /* already non-indexed: per-face normals in place, flagged once */
        g.computeVertexNormals();
        g.userData = g.userData || {};
        g.userData.toonFlat = true;
      }
    } catch(e) { out = g; }
    _flatCache.set(g, out);
    return out;
  }

  function flatten(root){
    if(!root) return 0;
    const meshes = [];
    root.traverse(function (o) {
      if(o.isMesh && o.geometry && !o.isSkinnedMesh && o.visible !== false) meshes.push(o);
    });
    let swapped = 0;
    meshes.forEach(function (o) {
      if(o.userData && o.userData.toonSmooth) return;
      const fg = flatGeometry(o.geometry);
      if(fg && fg !== o.geometry){ o.geometry = fg; swapped++; }
    });
    return swapped;
  }

  function mat(opts){
    /* Toon shading has no flat mode; passing it only logs a warning per material. */
    if(opts && 'flatShading' in opts){ opts = Object.assign({}, opts); delete opts.flatShading; }
    opts = opts || {};
    if(opts.flatShading){
      // three's MeshToonMaterial has no flatShading property at all (r155+
      // dropped it from the toon material), so passing it only earns one
      // console warning per tank, wall and bush. The tanks have been
      // smooth-shaded all along — dropping the key changes nothing visually.
      const o2 = Object.assign({}, opts);
      delete o2.flatShading;
      opts = o2;
    }
    if(_useToon){
      try {
        const gm = getGradientMap();
        const m = new THREE.MeshToonMaterial(Object.assign({
          gradientMap: gm
        }, opts));
        return m;
      } catch(e) {
        console.warn('[Toon] MeshToonMaterial failed, falling back:', e);
        _useToon = false;
      }
    }
    return new THREE.MeshStandardMaterial(opts);
  }

  return { getGradientMap, dispose, mat, flatten, flatGeometry };
})();
