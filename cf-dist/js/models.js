/* ============================================================
   models.js — GLTF / GLB / Collada loader + cache. Tries to load
   the real tank model from mini_tank_legends_models/<name>.glb,
   .gltf, or .dae; if missing it falls back to the cube body+turret.
   Uses Three.js GLTFLoader or ColladaLoader.
   ============================================================ */

const Models = window.Models = {
  _cache: {},        // key -> {gltf:Scene|null, tried:bool}
  _loader: null,
  _colladaLoader: null,
  _available: null,  // null = not yet probed

  loader(){
    if(!this._loader){
      let GLTF = null;
      if(window.THREE && window.THREE.GLTFLoader) GLTF = window.THREE.GLTFLoader;
      else if(window.GLTFLoader) GLTF = window.GLTFLoader;
      if(GLTF){
        this._loader = new GLTF();
        /* DRACO. A GLB exported with Draco compression has no plain vertex data,
           and GLTFLoader THROWS ("No DRACOLoader instance provided") rather than
           falling back -- so an uncompressed model loads fine and a compressed
           one silently kills the whole file. That is exactly what happened to
           the bullet: it 200'd, the loader threw inside the callback, and the
           game quietly carried on with the placeholder capsule instead.

           Attached here, on the shared loader, so every model in the game gets
           it and not just this one. The decoder files are copied to
           assets/draco/ by hand because node_modules is not deployed -- they are
           three.js's own, unmodified.

           DRACOLoader is not exposed on THREE by the bootstrap, so it is pulled
           from the addons path the import map already points at. If it cannot
           be fetched the loader is still returned, just without Draco: a
           compressed model then fails as before, an uncompressed one is
           unaffected. */
        try {
          const DRACO = (window.THREE && window.THREE.DRACOLoader)
            ? window.THREE.DRACOLoader
            : (typeof DRACOLoader !== 'undefined' ? DRACOLoader : null);
          if(DRACO){
            const draco = new DRACO();
            draco.setDecoderPath('assets/draco/');
            this._loader.setDRACOLoader(draco);
            this._dracoLoader = draco;
          }
        } catch(e){ console.warn('[Models] DRACO unavailable:', e); }
      } else {
        this._loader = null; // addon not present; cube fallback always
      }
    }
    return this._loader;
  },

  colladaLoader(){
    if(!this._colladaLoader){
      if(window.THREE && window.THREE.ColladaLoader){
        this._colladaLoader = new THREE.ColladaLoader();
      } else if(window.ColladaLoader){
        this._colladaLoader = new ColladaLoader();
      } else {
        this._colladaLoader = null;
      }
    }
    return this._colladaLoader;
  },

  /* Probe which model files exist. We can't list a dir from the
     browser, so we HEAD each candidate URL once and cache the result. */
  _url(name, ext){
    return CONFIG.MODEL_DIR + name + ext + '?v=' + CONFIG.MODEL_VER;
  },

  async probe(names){
    const out = {};
    await Promise.all(names.map(async n=>{
      // Check .glb first, then .gltf, then .dae
      out[n] = await this._exists(this._url(n, '.glb'));
      if(!out[n]) out[n] = await this._exists(this._url(n, '.gltf'));
      if(!out[n]) out[n] = await this._exists(this._url(n, '.dae'));
    }));
    this._available = out;
    return out;
  },

  /* Probing on this host has a trap: a MISSING file does not answer 404.
     Pages serving answers 200 with Content-Type text/html and the SPA page
     with index.html. That once made every probe think every model existed,
     GLTFLoader ran over a HTML document, and the .dae fall-back fed the HTML
     straight at ColladaLoader — three "XML Parsing Error: not well-formed"
     warnings per absent model.

     So EVERY network response here is now duck-tested before it is believed:
     a real model is never text/html, and a real .glb always begins with the
     "glTF" magic bytes. Anything else counts as missing. */
  _probeOk(url){
    /* A HEAD request is free — the whole point of the probe is to decide
       WITHOUT downloading 17 multi-megabyte models. The content type on a
       HEAD is all that is needed for the one real case: Pages answers a
       missing file with Content-Type text/html, and every real model file
       with something audio/gltf/octet-stream shaped. A server that omits the
       header entirely is the only case that still needs the body read; that
       fallback lives in _probeByBytes and rarely runs. */
    return fetch(url, { method: 'HEAD' }).then(res => {
      if(!res.ok || res.status >= 400) return false;
      const ct = (res.headers.get('content-type') || '').trim().toLowerCase();
      if(!ct) return this._probeByBytes(url);
      if(ct.indexOf('text/html') === 0) return false;
      return true;
    }).catch(() => false);
  },

  /* Only for HEAD responses with no Content-Type at all: pull the body and
     check SOMETHING is there that is not a page. */
  _probeByBytes(url){
    return fetch(url, { method: 'GET' }).then(res => {
      if(!res.ok || res.status >= 400) return false;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if(ct.indexOf('text/html') === 0) return false;
      return res.arrayBuffer().then(b => b.byteLength > 0);
    }).catch(() => false);
  },

  _exists(url){
    return this._probeOk(url);
  },

  hasModel(name){
    if(this._available && this._available[name]) return true;
    // Also check embedded data (for file:// protocol)
    return typeof window.__GLB_DATA__ !== 'undefined' && !!window.__GLB_DATA__[name];
  },

  /* Load a model async; returns a Promise<THREE.Group|null> */
  load(name){
    if(this._cache[name]) return Promise.resolve(this._cache[name].gltf && this._clone(name));
    this._cache[name] = {gltf:null, tried:false};
    if(!this.hasModel(name)){
      this._cache[name].tried = true;
      return Promise.resolve(null);
    }
    const loader = this.loader();
    if(!loader) return this._loadCollada(name);
    // Try .glb → .gltf → .dae
    return this._tryLoad(name, '.glb')
      .catch(()=> this._tryLoad(name, '.gltf'))
      .catch(()=> this._loadCollada(name))
      .catch(()=>{ this._cache[name].tried = true; return null; });
  },

  /* Warm _cache for a list of names, keeping no clones.

     Every tank in a match goes through load(), so a model that is not cached
     yet costs a fetch, a parse and its first shader compile at whatever moment
     it is first needed -- and for a tank that moment is inside a running
     match. Done ahead of time it costs nothing but background time while the
     menu is up. One missing file must never reject the batch, so every entry
     resolves (to null) on its own. */
  preload(names){
    const list = Array.isArray(names) ? names.filter(Boolean) : [];
    if(!list.length) return Promise.resolve([]);
    return Promise.all(list.map(n =>
      Promise.resolve()
        .then(()=> this.load(n))
        .catch(()=> null)
    ));
  },

  _tryLoad(name, ext){
    return new Promise((resolve, reject)=>{
      // Use embedded data URL when available (works from file://)
      if(typeof window.__GLB_DATA__ !== 'undefined' && window.__GLB_DATA__[name] && ext === '.glb'){
        const url = 'data:application/octet-stream;base64,' + window.__GLB_DATA__[name];
        this.loader().load(url, (gltf)=>{
          this._stripSkins(gltf.scene);
          this._cache[name].gltf = gltf.scene;
          this._cache[name].anims = gltf.animations || [];
          this._cache[name].tried = true;
          resolve(this._clone(name));
        }, undefined, reject);
        return;
      }
      /* Bytes are fetched and VERIFIED first (see _fetchBytes), then parsed.
         parse() wants text for a .gltf and the raw buffer for a .glb — the
         first byte tells them apart, which _fetchBytes has already sorted. */
      this._fetchBytes(this._url(name, ext))
        .then(data => new Promise((onDone, onFail) => {
          const first = new Uint8Array(data, 0, 1)[0];
          const input = (first === 0x7B || first === 0x5B)   // '{' or '['  → JSON .gltf
            ? new TextDecoder().decode(data)
            : data;                                          // .glb binary stays bytes
          this.loader().parse(input, '', onDone, onFail);
        }))
        .then(gltf => {
          if(!gltf || !gltf.scene) throw new Error('model contains no scene');
          this._stripSkins(gltf.scene);
          this._cache[name].gltf = gltf.scene;
          this._cache[name].anims = gltf.animations || [];
          this._cache[name].tried = true;
          resolve(this._clone(name));
        })
        .catch(reject);
    });
  },

  /* Fetch a model URL as raw bytes and verify it is a real model before any
     parser touches it. A Pages 404 comes back as HTTP 200 whose body is the
     index page marked text/html; handing that to GLTFLoader once produced the
     "XML Parsing Error: not well-formed" rain and a silent null. Rejections
     here are normal and cheap — the caller is already cascading fallbacks. */
  _fetchBytes(url){
    return fetch(url, { method: 'GET' }).then(res => {
      if(!res.ok || res.status >= 400) throw new Error('HTTP ' + res.status);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if(ct.indexOf('text/html') === 0) throw new Error('not a model — the server sent HTML');
      return res.arrayBuffer().then(buf => {
        /* Magic-byte test on top of the header. Serve configs drift; a
           text/plain or application/octet-stream body with the wrong first
           bytes is not a model either way. */
        const head = new Uint8Array(buf, 0, Math.min(64, buf.byteLength));
        const isGlB = head.length >= 4 && head[0] === 0x67 && head[1] === 0x6C && head[2] === 0x54 && head[3] === 0x46;
        const textStart = head[0] === 0x7B || head[0] === 0x5B;   // '{' or '[' — a .gltf

        /* A .dae IS XML, and so is every HTML page ever written. The old test
           was `head[0] === 0x3C` — a single '<' — which every HTML document
           starts with, so the one check meant to reject a wrong file waved the
           SPA fallback page straight through to ColladaLoader.

           That is the "XML Parsing Error: not well-formed ... ColladaLoader:
           Failed to parse collada file" rain, three or four copies of it, once
           per model that has no .dae. A genuine collada file begins with an XML
           declaration or a <COLLADA> element; an HTML document begins with
           <!DOCTYPE, <html or a comment, and never with <COLLADA. Checking for
           the element that is actually being looked for costs one substring
           test and rejects every page Cloudflare can serve instead. */
        const looksLikeHtml = /<!doctype|<html|<head|<body|<script/i.test(
          new TextDecoder().decode(head)
        );
        const xmlStart = head[0] === 0x3C && !looksLikeHtml;
        if(isGlB || textStart || xmlStart) return buf;
        throw new Error('not a recognisable model file');
      });
    });
  },

  _loadCollada(name){
    return new Promise(resolve=>{
      /* The bytes were verified by _fetchBytes — a 200-with-HTML body can no
         longer reach the XML parser, which is what used to print
         "THREE.ColladaLoader: Failed to parse collada file" on every missing
         model. A silent asset that never held anything is worth less noise
         than the validation that swallowed it. */
      this._fetchBytes(this._url(name, '.dae')).then(data => {
        const loader = this.colladaLoader();
        if(!loader){ this._cache[name].tried = true; resolve(null); return; }
        loader.parse(data, '', (result)=>{
          const scene = result.scene;
          if(!scene){ this._cache[name].tried = true; resolve(null); return; }
          // Scale the model appropriately for our game
          scene.scale.setScalar(0.5);
          scene.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.receiveShadow=true; } });
          this._cache[name].gltf = scene;
          this._cache[name].tried = true;
          resolve(this._clone(name));
        }, ()=>{ this._cache[name].tried = true; resolve(null); });
      }).catch(()=>{ this._cache[name].tried = true; resolve(null); });
    });
  },

  /* ------------------------------------------------------------------
     TEXTURE BUDGET

     A tank is roughly 60 pixels tall in a normal battle camera, but its hull
     texture arrived as 1024x1024 — 4 MB of VRAM per texture, plus mip chains,
     to paint an area about the size of a thumbnail. Every tank in the match
     carried its own copy.

     This is the single largest waste found in the renderer. It is fixed here,
     at the one place every model passes through, rather than by editing assets:
     the source GLBs stay untouched and the same fix covers map props and
     scenery that arrive later.

     The cap is deliberately generous (512) rather than aggressive. A tank gets
     much larger in the garage preview and when the camera pulls in, and 512 is
     still far beyond what is resolvable at those sizes. */
  _texBudget: 512,

  /* Every geometry handed out by a loaded model, by uuid.

     Tank.dispose() frees the GPU objects a tank owns, but a tank's HULL GEOMETRY
     is not its own -- it comes from _cache and is shared by every tank of that
     class. Disposing it frees the GPU buffers underneath all of them, and
     three.js then has to upload the whole model again on the next match. Doing
     that once per tank, per battle, is exactly how a session turns into a
     download. So ownership is recorded here and checked there. */
  _cacheGeometries: new Set(),

  _tagCacheGeometry(root){
    if(!root) return;
    root.traverse(o => { if(o.geometry) this._cacheGeometries.add(o.geometry.uuid); });
  },

  isCachedGeometry(geo){
    return !!(geo && this._cacheGeometries.has(geo.uuid));
  },

  /* Resample one texture down to _texBudget, preserving colour space. Returns
     the original when it is already small enough or cannot be resampled. */
  /* `shared` records WHO owns the replacement.

     A map GLB is parsed fresh every battle, so its budgeted textures belong to
     that map alone and must be freed with it. A tank model is budgeted once and
     then handed out by _clone(), so its replacement is bound to a dozen live
     tanks and must NOT be freed by any one of them. The two cases look
     identical from the texture, which is why this flag exists. */
  _shrinkTexture(tex, shared){
    if(!tex || !tex.image) return tex;
    const iw = tex.image.width || 0, ih = tex.image.height || 0;
    if(!iw || !ih) return tex;
    if(Math.max(iw, ih) <= this._texBudget) return tex;

    /* Already shrunk once -- do not shrink again on every re-load, or a
       repeated load would keep resampling an already-reduced canvas. */
    if(tex.userData && tex.userData.texBudgetApplied) return tex;

    const tw = Math.max(1, Math.round(iw * this._texBudget / Math.max(iw, ih)));
    const th = Math.max(1, Math.round(ih * this._texBudget / Math.max(iw, ih)));

    let out = null;
    try {
      const c = document.createElement('canvas');
      c.width = tw; c.height = th;
      const ctx = c.getContext('2d');
      /* The source is usually an ImageBitmap (GLTFLoader decodes to one), which
         drawImage handles; an HTMLImageElement or canvas works identically. */
      ctx.drawImage(tex.image, 0, 0, tw, th);
      const shrunk = new THREE.CanvasTexture(c);
      shrunk.colorSpace = tex.colorSpace || THREE.SRGBColorSpace;
      shrunk.wrapS = tex.wrapS;
      shrunk.wrapT = tex.wrapT;
      shrunk.magFilter = tex.magFilter;
      /* FLIP-Y MUST BE CARRIED ACROSS.

         Every property below is copied from the source, and this one used to be
         the omission that mattered: GLTFLoader hands out flipY=false (glTF's UV
         origin is top-left), while THREE.CanvasTexture is constructed on the
         THREE default of true. The replacement therefore sampled the image
         upside down — the Mortar's turret wore its authored pattern inverted
         while the same GLB rendered correctly wherever it was not budgeted.
         offset/repeat/rotation/center are copied for the same reason: a property
         silently left at its default is a property changed. */
      shrunk.flipY = tex.flipY;
      shrunk.offset.copy(tex.offset);
      shrunk.repeat.copy(tex.repeat);
      shrunk.rotation = tex.rotation;
      shrunk.center.copy(tex.center);
      /* Anisotropy is the main reason mip chains cost real bandwidth; keeping
         the original filter preserves the look, mipmaps are what save memory
         at distance and prevent shimmer. */
      shrunk.minFilter = tex.minFilter;
      shrunk.generateMipmaps = tex.generateMipmaps !== false;
      shrunk.anisotropy = tex.anisotropy || 1;
      shrunk.userData = { texBudgetApplied: true, sharedBudget: !!shared, origW: iw, origH: ih };
      out = shrunk;
    } catch(e){
      return tex;   /* leave the original if resampling is not possible */
    }

    /* The replacement is what every material should point at from now on, and
       the big original can go: nothing will read it again. */
    try { if(tex.image && tex.image.close) tex.image.close(); } catch(e){}
    try { tex.dispose(); } catch(e){}
    return out;
  },

  /* Walk a loaded model's materials and swap any oversized texture for the
     downscaled one. Called once per model, right after it loads.

     Pass shared=true when the result will be handed out by _clone() to many
     live instances; the replacements then outlive any single caller and must be
     left alone at teardown. Leave it off for a map, which is parsed per battle
     and owns its textures outright. */
  applyTextureBudget(root, shared){
    if(!root) return 0;
    let changed = 0;
    const swap = (mat) => {
      if(!mat) return;
      for(const k of ['map','normalMap','emissiveMap','roughnessMap','metalnessMap','aoMap','alphaMap']){
        const t = mat[k];
        if(!t) continue;
        const s = this._shrinkTexture(t, shared);
        if(s && s !== t){ mat[k] = s; mat.needsUpdate = true; changed++; }
      }
    };
    root.traverse(o => {
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for(const m of mats) swap(m);
    });
    return changed;
  },

  _clone(name){
    const src = this._cache[name].gltf;
    if(!src) return null;
    /* Budget the ORIGINAL once. Every clone shares the original's materials and
       textures, so doing it here means ten tanks cost one shrunk texture rather
       than ten copies of a 4 MB one. That sharing is exactly why these
       replacements are marked shared: they outlive any single tank. */
    if(this._cache[name] && !this._cache[name].budgeted){
      this.applyTextureBudget(src, true);
      this._tagCacheGeometry(src);
      this._cache[name].budgeted = true;
    }
    /* Bake the ORIGINAL once, for the same reason and with a sharper edge.

       A node's local matrix is T*R*S, so a node with a NON-UNIFORM scale that
       has something rotating underneath it produces a shear rather than a
       rotation — the object changes apparent size as it turns. That is the
       Blender "rotate and it goes bulbous" bug, and the fix is the same one:
       take the scale out of the transform and put it in the vertices, leaving
       the node at scale 1 so a rotation is a pure rotation.

       It MUST happen here, on the original, before any clone is handed out.
       Doing it per-tank on the clone did not work: the clone SHARES its geometry
       buffers with this scene, so a bake that mutated shared geometry quietly
       rewrote the master copy, and every tank built afterwards — and every
       re-selection of the same tank, which is what the tank-select panel does —
       inherited the damage and baked it again. Measured on the Mortar across
       three selections: turret height 3.08 -> 2.15 -> 2.12, and a fresh load
       returning geometry already flattened to 0.439.

       Guarded here, it is exactly-once per model by construction, and every
       clone is a faithful copy of an already-correct original. */
    if(this._cache[name] && !this._cache[name].scalesBaked){
      this.bakeNodeScales(src);
      this._cache[name].scalesBaked = true;
    }
    const out = src.clone(true);
    // Keep the GLB animation clips attached so tanks can play them
    if(this._cache[name].anims) out.userData.anims = this._cache[name].anims;
    return out;
  },

  /* Push every node's non-uniform scale down into its own geometry, then set the
     node to scale 1. Called ONCE per cached model — see _clone for why it cannot
     be done per tank.

     For a mesh M under a scaled node N, with L = M's transform in N's local
     space: before the change a vertex v maps to S*L*v, and after we want the
     same place with no S on N, so L*v' = S*L*v, giving v' = L^-1 * S * L * v.
     That conjugate preserves the mesh's position in the subtree, so pivots and
     hinges stay exactly where the author put them — a baked model is the same
     model in the same place, it has simply stopped carrying a scale that a
     rotation could shear.

     Buffers here are the MASTER buffers and are about to be shared by every
     clone, so this must not run twice; the caller guarantees that. Sprites are
     skipped: three.js rewrites a Sprite's scale from its own width/height every
     frame, so baking a sprite's scale into its quad would shrink the sprite
     permanently while the matrix kept claiming it was full size. */
  /* Swap the winding of every triangle in a geometry, in place. For an indexed
     geometry that is a three-index reversal per triangle; for a non-indexed one,
     the two trailing vertices of each triple swap places across every attribute
     (position, normal, uv — all of them must agree or the shading is wrong).

     Used by bakeNodeScales to undo the inside-out result of baking a mirrored
     (negative-determinant) scale. */
  reverseWinding(geometry){
    const index = geometry.getIndex();
    if(index){
      const a = index.array;
      for(let i = 0; i < a.length - 2; i += 3){ const t = a[i+1]; a[i+1] = a[i+2]; a[i+2] = t; }
      index.needsUpdate = true;
      return;
    }
    const pos = geometry.attributes.position;
    if(!pos) return;
    const count = pos.count;
    const swap = (attr) => {
      if(!attr) return;
      const arr = attr.array, is = attr.itemSize;
      for(let i = 0; i < count - 2; i += 3){
        for(let k = 0; k < is; k++){
          const b = i*is + k, c = (i+2)*is + k, t = arr[b];
          arr[b] = arr[c]; arr[c] = t;
        }
      }
      attr.needsUpdate = true;
    };
    swap(geometry.attributes.position);
    swap(geometry.attributes.normal);
    swap(geometry.attributes.uv);
  },

  bakeNodeScales(root){
    if(!root) return 0;
    root.updateMatrixWorld(true);
    const S = new THREE.Matrix4(), L = new THREE.Matrix4(), T = new THREE.Matrix4();
    const invN = new THREE.Matrix4();
    const nodes = [];
    root.traverse(o => nodes.push(o));

    /* ONE BUFFER PER NODE, BEFORE ANY BAKING HAPPENS.

       A glTF mesh can be referenced by many nodes at once, and GLTFLoader hands
       every one of them the IDENTICAL BufferGeometry object. Baking is a
       destructive edit of a position buffer, so a shared buffer gets edited
       once per node that reaches it. Grom's twelve road wheels are all mesh 0:
       each rescales the buffer the others are using, and by the twelfth the
       geometry is 0.55^12 of its real size. The tank rendered as a bare hull
       with no wheels, and nothing threw — the sizes were just quietly, invisibly
       wrong.

       Nor can it be fixed by baking each buffer once and skipping the rest,
       because those nodes do not all carry the same scale. The Helix has ONE
       mesh shared by TEN nodes across FOUR different scales; Predator has eight
       nodes on one mesh at three. Bake once, reset the other nine to scale 1,
       and nine parts are redrawn at the first node's proportions — measured at
       22.7 units against a true 13.9.

       Which leaves cloning, and the ORDER is the whole thing. Cloning lazily,
       inside the bake loop, is the same bug wearing a hat: by the time the second
       node notices the buffer is taken, the first has already written into it,
       so the clone inherits the damage and bakes it again. So the split happens
       in a pre-pass over the PRISTINE tree, before a single vertex is touched.
       After that every node owns its buffer outright and the bake loop can be
       as simple as it looks. */
    const owner = new Set();
    for(const n of nodes){
      n.traverse(o => {
        if(!o.isMesh || !o.geometry) return;
        if(owner.has(o.geometry)) o.geometry = o.geometry.clone();
        else owner.add(o.geometry);
      });
    }

    /* EACH MESH IS BAKED BY EXACTLY ONE NODE — ITS NEAREST SCALED ANCESTOR.

       This is the second half of the fix, and without it the clone above buys
       nothing. The obvious loop walks each scaled node's whole subtree, so a
       mesh under TWO scaled nodes is baked twice: once by the outer node's
       subtree walk and again when the loop reaches the inner node itself. Two
       bakes is a scale applied twice — the Helix came out 44% taller than the
       file says, the Ghost 9%, Grom 10% narrower.

       The rule that fixes it is simply "innermost scaled ancestor wins", which is
       also the only correct one: the inner node's conjugate is the one that must
       be removed for the mesh's own local transform to become a pure rotation,
       and once that node's scale is 1 the outer scale still reaches the vertices
       through the hierarchy exactly as before. `nodes` is in traversal order,
       parents before children, so walking it BACKWARDS makes the deepest node the
       first to claim a mesh and the claim then sticks.

       A mesh with no scaled ancestor at all is claimed by nobody and is never
       touched — correct, since there is no scale to bake away. */
    const scaled = nodes.filter(n => {
      const s = n.scale;
      return !n.isSprite && !(Math.abs(s.x - s.y) < 1e-6 && Math.abs(s.y - s.z) < 1e-6);
    });
    const claim = new Map();      // node -> meshes it is responsible for
    for(let i = scaled.length - 1; i >= 0; i--){
      const n = scaled[i];
      n.traverse(o => {
        if(!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
        if(claim.has(o)) return;
        if(!claim.has(n)) claim.set(n, []);
        claim.get(n).push(o);
      });
    }

    let baked = 0, mirrored = 0;
    for(const [n, meshes] of claim){
      const s = n.scale;
      n.updateMatrixWorld(true);

      /* A NEGATIVE determinant is a mirror, not a squash — it is how exporters
         store a flipped copy. Grom's launcher `Cylinder` is scaled
         [-0.505, -0.654, -0.193]. Baking that verbatim moves the vertices
         correctly and inverts the triangle winding, so the barrel draws from the
         inside out.

         The equivalent transform with orientation preserved is the magnitudes
         plus a winding reversal, so that is what is baked: same place, same size,
         still facing out. */
      const flip = (s.x * s.y * s.z) < 0;
      S.makeScale(flip ? Math.abs(s.x) : s.x, flip ? Math.abs(s.y) : s.y, flip ? Math.abs(s.z) : s.z);

      invN.copy(n.matrixWorld).invert();
      for(const o of meshes){
        /* The pre-pass above already guaranteed this buffer belongs to this node alone. */
        L.multiplyMatrices(invN, o.matrixWorld);
        T.copy(L).invert().multiply(S).multiply(L);
        o.geometry.applyMatrix4(T);
        /* `this.`, not a bare name. reverseWinding is a SIBLING method in this object
           literal, and a sibling method is not in lexical scope — the bare call
           is a ReferenceError, not a lookup. That error fired inside traverse
           during the very first model load, so every tank in the game was
           throwing before it drew anything. The arrow callback keeps `this`
           bound to the Models object, which is what makes the qualified call
           resolve. */
        if(flip){ this.reverseWinding(o.geometry); mirrored++; }
        o.geometry.computeBoundingBox();
        o.geometry.computeBoundingSphere();
        baked++;
      }
      /* Reset the scale ONLY for nodes that actually baked something, and only
         once they have. A node that owns no mesh here had all of its geometry
         claimed by a scaled node deeper in its subtree; its scale is still doing
         real work on that subtree and was never written into any vertex, so
         zeroing it silently collapses everything below it. Resetting a scale
         that was not baked is not a no-op — it is a rescale, in the wrong
         direction, of geometry nobody measured.

         Bake and reset are one operation. Doing half of it is how this function
         managed to be wrong in three separate ways. */
      if(!meshes.length) continue;
      n.scale.set(1, 1, 1);
      n.updateMatrixWorld(true);
    }
    /* Nodes deeper in `scaled` may hold an ancestor whose scale was baked away by
       a descendant's reset; one more pass over the whole tree is not needed,
       because each node resets its OWN scale exactly once, above. */
    return baked;
  },

  /* Turn SkinnedMesh into plain Mesh at the same authored node.
     The game never plays GLB animations, and a cloned scene shares
     its skeleton with the original (undrawn) scene, so the bone
     matrices stay uninitialized and the model renders crushed into
     tiny fragments. At bind pose the two are visually identical. */
  _stripSkins(scene){
    const plain = [];
    scene.traverse(o => { if(o.isSkinnedMesh) plain.push(o); });
    plain.forEach(o => {
      const m = new THREE.Mesh(o.geometry, o.material);
      m.position.copy(o.position);
      m.quaternion.copy(o.quaternion);
      m.scale.copy(o.scale);
      m.name = o.name;
      m.castShadow = o.castShadow;
      m.receiveShadow = o.receiveShadow;
      // Migrate the skinned node's children onto the plain mesh so the
      // authored hierarchy survives (e.g. blockbench "gun"/"shell" empties
      // and pivot groups that sit under the skinned mesh). Replacing with a
      // sibling would orphan and drop them.
      while(o.children.length){
        m.add(o.children[0]);
      }
      const par = o.parent;
      if(par){
        const idx = par.children.indexOf(o);
        par.children.splice(idx, 1, m);
        m.parent = par;
      }
    });
  },
};

/* Pre-loader for nature-pack OBJ models (trees, rocks, bushes) */
const NatureAssets = {
  trees: [], rocks: [], bushes: [], loaded: false, _loading: false,

  loadAll(){
    if(this._loading || this.loaded) return;
    this._loading = true;
    if(!window.THREE || !THREE.OBJLoader) return;
    const loader = new THREE.OBJLoader();
    const base = 'nature/';
    const files = {
      trees:   ['BirchTree_1','BirchTree_2','BirchTree_3','CommonTree_1','CommonTree_2'],
      rocks:   ['Rock_1','Rock_2','Rock_3','Rock_Moss_1','Rock_Moss_2'],
      bushes:  ['Bush_1','Bush_2','BushBerries_1'],
    };
    const colors = {
      trees:   [0x5a8a30, 0x4a7a28, 0x6a9a40],
      rocks:   [0x8a8a7a, 0x7a7a6a, 0x9a9a8a, 0x6a7a5a, 0x7a8a6a],
      bushes:  [0x4a7a28, 0x5a8a30, 0x3a6a1a],
    };
    /* Dynamic Cartoon Material Router — reads node names and assigns
       solid flat-shaded materials. Fixes white/hollow shell issue by
       forcing procedural colors + recomputing normals + double-sided shading. */
    const addColors = (group, colList, kind) => {
      const leafColor  = 0x557a46;  // Stylized forest green
      const trunkColor = 0x7c5c43;  // Rich bark wood brown

      /* THESE OBJs ARE ONE MESH EACH, NOT A TRUNK MESH AND A LEAF MESH.

         So there is nothing to route: a whole CommonTree is a single
         `CommonTree_2_Cube.036` node, and the name test below matches none of
         "leave"/"foliage"/"branch", so every one of them took the ELSE branch
         and had the BARK colour applied to the entire canopy. A brown toon
         material under this scene's lighting (hemisphere 1.88 + sun 3.77 + two
         fills + ambient, about 7.85 total) saturates all three channels and
         renders near-white. That is the "scattered white trees" — the trees were
         never green to begin with.

         Fixed by colouring per VERTEX on height instead of per MESH on name:
         above the lower 45% of the model is canopy, below it is trunk. One
         mesh, one draw call, and the tree looks like a tree. The colour values
         are also pitched well down, because anything brighter than about 0.35
         clips to white under that much light. */
      const canopyDark = new THREE.Color(0x2f4a24);
      const canopyLit  = new THREE.Color(0x3d6130);
      const bark       = new THREE.Color(0x4a3324);

      group.traverse(c => {
        if(!c.isMesh) return;

        // 1. Recalculate shading normals (fixes broken lighting vectors)
        c.geometry.computeVertexNormals();

        // 2. Dynamic material router based on Quaternius node naming
        const name = c.name.toLowerCase();
        const named = name.includes("leave") || name.includes("foliage") || name.includes("branch");

        if(kind === 'tree' && !named && c.geometry.attributes.position){
          c.geometry.computeBoundingBox();
          const bb = c.geometry.boundingBox;
          const lo = bb.min.y, hi = bb.max.y, span = Math.max(1e-4, hi - lo);
          const pos = c.geometry.attributes.position;
          const col = new Float32Array(pos.count * 3);
          const tmp = new THREE.Color();
          for(let i = 0; i < pos.count; i++){
            const t = (pos.getY(i) - lo) / span;
            if(t < 0.45)      tmp.copy(bark);
            else if(t < 0.72) tmp.copy(canopyLit);
            else              tmp.copy(canopyDark);
            col[i*3] = tmp.r; col[i*3+1] = tmp.g; col[i*3+2] = tmp.b;
          }
          c.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
          c.material = Toon.mat({
            color: 0xffffff, vertexColors: true, flatShading: true, side: THREE.DoubleSide
          });
        } else if(named){
          c.material = Toon.mat({
            color: leafColor,
            flatShading: true,
            side: THREE.DoubleSide
          });
        } else {
          c.material = Toon.mat({
            color: trunkColor,
            flatShading: true,
            side: THREE.DoubleSide
          });
        }

        // 3. Refresh bounds for BoxHelper / collision outlines
        c.geometry.computeBoundingBox();
        c.geometry.computeBoundingSphere();

        // 4. Shadow map
        c.castShadow    = true;
        c.receiveShadow = true;
      });
    };
    const loadOne = (name, colorList, kind) => new Promise(resolve => {
      // Try embedded OBJ data first (works from file://)
      if(typeof window.__OBJ_DATA__ !== 'undefined' && window.__OBJ_DATA__[name]){
        try{
          const text = atob(window.__OBJ_DATA__[name]).replace(/^(mtllib |usemtl ).*/gm, '');
          const grp = loader.parse(text);
          addColors(grp, colorList, kind);
          resolve(grp);
          return;
        }catch(e){ /* fall through to XHR */ }
      }
      loader.load(base + name + '.obj', group => {
        addColors(group, colorList, kind);
        resolve(group);
      }, undefined, () => resolve(null));
    });
    return Promise.all([
      Promise.all(files.trees.map(f => loadOne(f, colors.trees, 'tree'))),
      Promise.all(files.rocks.map(f => loadOne(f, colors.rocks, 'rock'))),
      Promise.all(files.bushes.map(f => loadOne(f, colors.bushes, 'bush'))),
    ]).then(([trees, rocks, bushes]) => {
      this.trees = trees.filter(Boolean);
      this.rocks = rocks.filter(Boolean);
      this.bushes = bushes.filter(Boolean);
      this.loaded = true;
      /* Anyone waiting on placement needs telling, or the trees arrive after
         the match has already built its cover list. */
      if(this._onLoaded) { try { this._onLoaded(); } catch(e){} }
    });
  },

  /* Registered so callers can wait for scenery: NatureAssets._promise = ... */
  then(onFulfilled, onRejected){
    if(!this._promise) this._promise = this.loadAll();
    return this._promise.then(onFulfilled, onRejected);
  },
};

/* WHY THIS IS PUT ON `window` EXPLICITLY.

   Everything else in this file that other code reaches for does it through a
   `const` at the top level of a classic script, which lands in the shared
   global LEXICAL scope — reachable as a bare `NatureAssets`, invisible as
   `window.NatureAssets`. And game.js guards the scenery load with

       if (window.NatureAssets && ...) NatureAssets.loadAll()

   which is therefore ALWAYS false: the scenery load was never started at all,
   `loaded` stayed false, and `world.trees` stayed empty for the entire life of
   the game. The trees in nature/ have been sitting on disk, loadable, fetched
   by hand in the console — and never placed once.

   That is the whole of "I touched a tree and did not go invisible": there were
   no trees to touch, so there was no cover to hide in. Assigning it here makes
   the existing guards do what they plainly meant to, with no other edit. */
if(typeof window !== 'undefined') window.NatureAssets = NatureAssets;