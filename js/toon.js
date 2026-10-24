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

  function mat(opts){
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

  return { getGradientMap, dispose, mat };
})();
