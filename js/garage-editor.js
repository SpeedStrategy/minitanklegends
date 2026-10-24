/* ============================================================
   garage-editor.js — Garage / Hangar Editor (Editor123 suite)

   Design the WoT-style garage that appears behind the main menu:
    • MODEL  — import your hangar .glb, then move / rotate / scale
              the whole model with the TransformControls gizmo, and
              place the tank anchor (where the player's tank stands).
    • LIGHTS — add point / spot / sun lights, each with an optional
              yellow translucent light-cone figure, and "detect from
              model" which turns the exported Empty markers (lamp
              housings) into real lights.
    • TIME   — morning / day / evening / night presets that retune
              sun colour+intensity, ambient, hemisphere and fog.
    • VFX    — fog (colour + density) and a few ambient extras.
    • IMAGES — import any PNG/JPG, then move / scale / rotate it and
              set light-pass, glow, darken and receive-shadow options.
    • SHADERS— per-object style (standard / toon / flat / wireframe)
              plus a global outline with adjustable thickness.

   Everything is saved to localStorage (tankparty_garage) and applied
   automatically the next time Garage.start() runs behind the menu.
   ============================================================ */

window.GarageEditor = (function(){

  var LS_KEY = 'tankparty_garage';
  var LS_GLB = 'tankparty_garage_glb';   // embedded custom hangar model (base64)

  var CONFIG_DEFAULTS = {
    version: 3,
    model: { pos:{x:0,y:0,z:0}, rotY:0, scale:1, flip:false },
    anchor: { x:null, z:null, yaw:null, floorY:null },
    lights: [],
    fog: { enabled:false, color:'#1a1d24', near:40, far:240 },
    time: 'day',
    shader: 'default',
    images: [],
    outline: { enabled:true, thickness:1.04, color:'#000000' },
    extra: { dust:false, godray:false }
  };

  function loadConfig(){
    try { var c = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); return c || JSON.parse(JSON.stringify(CONFIG_DEFAULTS)); } catch(e){ return JSON.parse(JSON.stringify(CONFIG_DEFAULTS)); }
  }
  function saveConfig(){
    try { localStorage.setItem(LS_KEY, JSON.stringify(window.GARAGE_CONFIG)); } catch(e){}
  }
  window.GARAGE_CONFIG = loadConfig();

  var TIME_PRESETS = {
    morning: {
      bg: 0x8ea4bd, hemiSky: 0xb8c8e0, hemiGnd: 0x6a5a44, hemiI: 0.9,
      sun: 0xffd9a0, sunI: 1.7, sunPos: {x:-24, y:16, z:-10},
      amb: 0x404448, ambI: 0.9, fog: '#a9b7c9'
    },
    day: {
      bg: 0x1a2030, hemiSky: 0x9fb4d8, hemiGnd: 0x2a2620, hemiI: 0.55,
      sun: 0xfff2d6, sunI: 1.5, sunPos: {x:16, y:40, z:22},
      amb: 0x30343c, ambI: 0.8, fog: '#1a1d24'
    },
    evening: {
      bg: 0x241a20, hemiSky: 0xd8a8b8, hemiGnd: 0x241a10, hemiI: 0.6,
      sun: 0xff7a45, sunI: 2.1, sunPos: {x:-20, y:10, z:-6},
      amb: 0x3a2a24, ambI: 0.9, fog: '#2a1a22'
    },
    night: {
      bg: 0x0a0d16, hemiSky: 0x3a4a6a, hemiGnd: 0x12161f, hemiI: 0.4,
      sun: 0x6f8fd6, sunI: 0.9, sunPos: {x:-8, y:38, z:10},
      amb: 0x141a28, ambI: 1.0, fog: '#0a0d16'
    }
  };

  var state = {
    mode: 'model',
    scene: null, renderer: null, camera: null, controls: null, gizmo: null,
    root: null,            // imported hangar Group (or empty group)
    gltfScene: null,       // raw loaded scene before grouping
    tankDummy: null,       // box tank at the anchor
    selected: null,        // currently gizmo-attached object
    lightObjs: [],         // {key, obj, cone, def}
    imageObjs: [],         // {key, obj, def}
    timeObjs: {},          // live hemi/amb/sun refs
    raf: 0, running: false, resizeHandler: null, keyHandler: null,
    dragged: false, history: [], historyIdx: -1,
  };

  function $id(id){ return document.getElementById(id); }
  function round(v){ return Math.round(v * 1000) / 1000; }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  function toast(msg){
    var el = $id('ge-toast');
    if(el){
      el.textContent = msg;
      el.classList.add('te-show');
      clearTimeout(el._t);
      el._t = setTimeout(function(){ el.classList.remove('te-show'); }, 3200);
      return;
    }
    if(window.Menu && typeof Menu.toast === 'function'){ Menu.toast(msg); return; }
    if(window.Editor123 && typeof Editor123.toast === 'function'){ Editor123.toast(msg); return; }
    console.log('[GarageEditor]', msg);
  }

  function hexNum(c){ return parseInt(String(c).replace('#', ''), 16) || 0xffffff; }
  function hexStr(n){ return '#' + ('000000' + (n & 0xffffff).toString(16)).slice(-6); }

  function updateConfig(){
    // read live transforms into the saved config
    var cfg = window.GARAGE_CONFIG;
    if(state.root){
      cfg.model.pos = { x: round(state.root.position.x), y: round(state.root.position.y), z: round(state.root.position.z) };
      cfg.model.rotY = round(state.root.rotation.y);
      cfg.model.scale = round(state.root.scale.x);
    }
    if(state.tankDummy){
      cfg.anchor.x = round(state.tankDummy.position.x);
      cfg.anchor.z = round(state.tankDummy.position.z);
      cfg.anchor.yaw = round(state.tankDummy.rotation.y);
    }
    cfg.lights = state.lightObjs.map(function(l){
      return {
        type: l.def.type, x: round(l.obj.position.x), y: round(l.obj.position.y), z: round(l.obj.position.z),
        color: hexStr(l.obj.color ? l.obj.color.getHex() : 0xffcc44),
        intensity: round(l.obj.intensity), distance: l.obj.distance != null ? round(l.obj.distance) : 60,
        decay: l.obj.decay != null ? l.obj.decay : 2, cone: !!l.def.cone, coneH: l.def.coneH || 6, coneR: l.def.coneR || 1.2,
        targetX: l.obj.target ? round(l.obj.target.position.x) : null,
        targetY: l.obj.target ? round(l.obj.target.position.y) : null,
        targetZ: l.obj.target ? round(l.obj.target.position.z) : null
      };
    });
    cfg.images = state.imageObjs.map(function(im){
      var m = im.obj;
      return {
        name: im.def.name, src: im.def.src,
        x: round(m.position.x), y: round(m.position.y), z: round(m.position.z),
        sx: round(m.scale.x), sy: round(m.scale.y),
        ry: round(m.rotation.y),
        lightPass: !!im.def.lightPass, glow: !!im.def.glow,
        dark: round(im.def.dark), receiveShadow: !!im.def.receiveShadow
      };
    });
    saveConfig();
  }

  /* ------------------------------------------------------------
     GLB import
     ------------------------------------------------------------ */
  function loadModelFromDataUrl(dataUrl, cb){
    var bytes = atob(dataUrl.split(',')[1] || '');
    var ab = new ArrayBuffer(bytes.length);
    var u8 = new Uint8Array(ab);
    for(var i = 0; i < bytes.length; i++) u8[i] = bytes.charCodeAt(i);
    new THREE.GLTFLoader().parse(ab, '', function(gltf){
      cb(null, gltf.scene);
    }, function(err){ cb(err, null); });
  }

  function clearCustomModel(){
    try{ localStorage.removeItem(LS_GLB); }catch(e){}
    window.GARAGE_CONFIG.model = { pos:{x:0,y:0,z:0}, rotY:0, scale:1, flip:false };
    saveConfig();
  }

  /* ------------------------------------------------------------
     Scene / stage
     ------------------------------------------------------------ */
  function buildStage(){
    var view = $id('ge-view');
    if(!view) return;
    view.innerHTML = '';

    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x11151a);

    var W = view.clientWidth || 640, H = view.clientHeight || 480;
    state.camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 600);
    state.camera.position.set(30, 22, 40);
    state.camera.lookAt(0, 4, 0);

    state.renderer = new THREE.WebGLRenderer({antialias: true});
    state.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    state.renderer.setSize(W, H);
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    view.appendChild(state.renderer.domElement);

    var grid = new THREE.GridHelper(90, 30, 0x2a3038, 0x1f242b);
    grid.position.y = -0.01;
    state.scene.add(grid);

    state.controls = new THREE.OrbitControls(state.camera, state.renderer.domElement);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.12;
    state.controls.maxPolarAngle = Math.PI * 0.52;
    state.controls.target.set(0, 4, 0);
    state.controls.update();

    state.gizmo = new THREE.TransformControls(state.camera, state.renderer.domElement);
    state.gizmo.setSize(1.1);
    state.gizmo.space = 'local';
    state.scene.add(state.gizmo);
    state.gizmo.addEventListener('mouseDown', function(){ if(state.controls) state.controls.enabled = false; });
    state.gizmo.addEventListener('mouseUp', function(){
      if(state.controls) state.controls.enabled = true;
      if(state.dragged){ pushHistory(); applyOutline(); syncFields(); }
      state.dragged = false;
    });
    state.gizmo.addEventListener('objectChange', function(){
      state.dragged = true;
      syncFields();
    });

    state.resizeHandler = function(){ fitViewport(); };
    window.addEventListener('resize', state.resizeHandler);

    function loop(){
      if(!state.running) return;
      state.raf = requestAnimationFrame(loop);
      if(state.controls && state.controls.enabled) state.controls.update();
      if(state.gizmo) state.gizmo.updateMatrixWorld();
      if(state.renderer && state.scene) state.renderer.render(state.scene, state.camera);
    }
    loop();
  }

  function fitViewport(){
    var view = $id('ge-view');
    if(!view || !state.renderer || !state.camera) return;
    var W = view.clientWidth, H = view.clientHeight;
    if(!W || !H) return;
    state.renderer.setSize(W, H);
    state.camera.aspect = W / H;
    state.camera.updateProjectionMatrix();
  }

  function setGizmo(obj){
    state.selected = obj || null;
    if(state.gizmo){
      try{ state.gizmo.detach(); }catch(e){}
      if(obj) state.gizmo.attach(obj);
    }
    syncFields();
  }

  /* ------------------------------------------------------------
     Tank dummy (anchor visual)
     ------------------------------------------------------------ */
  function buildTankDummy(){
    if(state.tankDummy && state.tankDummy.parent === state.scene) return state.tankDummy;
    var def = (typeof TANKS !== 'undefined' && TANKS.coolbuddy) ? TANKS.coolbuddy : null;
    var g = new THREE.Group();
    var body = new THREE.Mesh(
      new THREE.BoxGeometry(def ? def.body.w : 3, def ? def.body.h : 1, def ? def.body.l : 4.4),
      Toon.mat({color: 0x7a8a3a})
    );
    body.position.y = 0.5;
    body.castShadow = true;
    g.add(body);
    var tur = new THREE.Mesh(
      new THREE.BoxGeometry(def ? def.turret.w : 2, def ? def.turret.h : 0.8, def ? def.turret.l : 2.6),
      Toon.mat({color: 0x8a9a4a})
    );
    tur.position.y = 1.3;
    g.add(tur);
    var barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 2.6, 8),
      Toon.mat({color: 0x4a4a4a})
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 1.3, 2.4);
    g.add(barrel);
    // anchor disc
    var disc = new THREE.Mesh(
      new THREE.CylinderGeometry(3.2, 3.2, 0.06, 48),
      new THREE.MeshBasicMaterial({color: 0xffb12b, transparent: true, opacity: 0.25})
    );
    disc.position.y = 0.03;
    g.add(disc);
    g.traverse(function(o){ if(o.isMesh){ o.castShadow = true; } });
    state.tankDummy = g;
    state.scene.add(g);
    return g;
  }

  /* ------------------------------------------------------------
     Light cones — the "yellow translucent figures"
     ------------------------------------------------------------ */
  function makeCone(lightObj, h, r, color){
    var cone = new THREE.Mesh(
      new THREE.ConeGeometry(r, h, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: color || 0xffcc44,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    cone.position.y = h / 2;
    cone.userData.isLightCone = true;
    lightObj.add(cone);
    return cone;
  }

  function addLight(opt){
    opt = opt || {};
    var cfg = window.GARAGE_CONFIG;
    var key = 'L' + Date.now().toString(36);
    var obj;
    var def = {
      type: opt.type || 'point',
      x: opt.x != null ? opt.x : 0,
      y: opt.y != null ? opt.y : 6,
      z: opt.z != null ? opt.z : 0,
      color: opt.color || 0xffcc44,
      intensity: opt.intensity != null ? opt.intensity : (opt.type === 'sun' ? 1.5 : 1.6),
      distance: opt.distance != null ? opt.distance : 60,
      decay: opt.decay != null ? opt.decay : 2,
      cone: opt.cone != null ? opt.cone : true,
      coneH: opt.coneH || 6, coneR: opt.coneR || 1.2
    };
    if(def.type === 'sun'){
      obj = new THREE.DirectionalLight(def.color, def.intensity);
      obj.position.set(def.x, def.y, def.z);
      obj.castShadow = true;
      obj.shadow.mapSize.width = 1024;
      obj.shadow.mapSize.height = 1024;
      obj.shadow.camera.near = 1;
      obj.shadow.camera.far = 300;
    } else if(def.type === 'spot'){
      obj = new THREE.SpotLight(def.color, def.intensity, def.distance, Math.PI / 5, 0.5, def.decay);
      obj.position.set(def.x, def.y, def.z);
      obj.castShadow = true;
      var tg = new THREE.Object3D();
      tg.position.set(def.x, 0, def.z);
      obj.target = tg;
      state.scene.add(tg);
    } else {
      obj = new THREE.PointLight(def.color, def.intensity, def.distance, def.decay);
      obj.position.set(def.x, def.y, def.z);
    }
    state.scene.add(obj);
    var entry = { key: key, obj: obj, cone: null, def: def };
    if(def.cone && def.type !== 'sun'){
      var c = makeCone(obj, def.coneH, def.coneR, def.color);
      obj.add(c);
      entry.cone = c;
    }
    state.lightObjs.push(entry);
    renderLightList();
    setGizmo(obj);
    syncFields();
    updateConfig();
    return entry;
  }

  function removeLight(key){
    for(var i = 0; i < state.lightObjs.length; i++){
      if(state.lightObjs[i].key === key){
        var e = state.lightObjs[i];
        if(e.obj.target && e.obj.target.parent) state.scene.remove(e.obj.target);
        state.scene.remove(e.obj);
        state.lightObjs.splice(i, 1);
        break;
      }
    }
    if(state.selected && !state.selected.parent) setGizmo(null);
    renderLightList();
    updateConfig();
  }

  function detectLightsFromModel(){
    // Blender lights don't export to glTF, but the .glb ships "Empty"
    // markers where the lamp housings / sun live. Turn ceiling empties
    // into real point lights (with cones) and add a sun.
    if(!state.root) return;
    state.root.updateMatrixWorld(true);
    var added = 0;
    state.root.traverse(function(o){
      if(!o.isMesh && o.name && /^Empty/.test(o.name) && o.parent){
        var p = o.getWorldPosition(new THREE.Vector3());
        if(p.y > 5.2 && p.y < 8.5){
          addLight({ type:'point', x:p.x, y:p.y + 0.2, z:p.z, color:0xffe6b8, intensity:1.6, distance:60, cone:true, coneH:4, coneR:1.1 });
          added++;
        }
      }
    });
    addLight({ type:'sun', x:16, y:40, z:22, color:0xfff2d6, intensity:1.5 });
    toast('Detected ' + added + ' lamp markers + 1 sun from the model');
  }

  /* ------------------------------------------------------------
     Images
     ------------------------------------------------------------ */
  function addImage(file, cb){
    var reader = new FileReader();
    reader.onload = function(){
      var src = reader.result;
      var loader = new THREE.TextureLoader();
      loader.load(src, function(tex){
        tex.colorSpace = THREE.SRGBColorSpace;
        var mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: true });
        var plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        plane.position.set(0, 3, 0);
        plane.rotation.y = Math.PI;
        plane.castShadow = false;
        plane.receiveShadow = false;
        state.scene.add(plane);
        var entry = {
          key: 'I' + Date.now().toString(36),
          obj: plane,
          def: { name: file.name || ('image' + (state.imageObjs.length + 1)), src: src, lightPass: false, glow: false, dark: 1, receiveShadow: false }
        };
        // default size from texture aspect
        var ar = tex.image.height ? tex.image.width / tex.image.height : 1;
        plane.scale.set(4, 4 / ar, 1);
        state.imageObjs.push(entry);
        renderImageList();
        setGizmo(plane);
        syncFields();
        updateConfig();
        if(cb) cb(entry);
      }, undefined, function(){ if(cb) cb(null); });
    };
    reader.readAsDataURL(file);
  }

  function removeImage(key){
    for(var i = 0; i < state.imageObjs.length; i++){
      if(state.imageObjs[i].key === key){
        state.scene.remove(state.imageObjs[i].obj);
        state.imageObjs.splice(i, 1);
        break;
      }
    }
    if(state.selected && !state.selected.parent) setGizmo(null);
    renderImageList();
    updateConfig();
  }

  function applyImageSettings(entry){
    var m = entry.obj;
    var d = entry.def;
    var mat = m.material;
    if(d.glow){
      mat.blending = THREE.AdditiveBlending;
      mat.transparent = true;
      mat.depthWrite = false;
    } else {
      mat.blending = THREE.NormalBlending;
      mat.transparent = d.lightPass || d.dark < 1;
      mat.depthWrite = !d.lightPass;
      mat.opacity = d.lightPass ? 0.5 : 1;
    }
    var k = clamp(d.dark, 0.05, 1);
    mat.color = mat.color || new THREE.Color(1, 1, 1);
    mat.color.setRGB(k, k, k);
    m.receiveShadow = !!d.receiveShadow;
    if(d.receiveShadow){
      // need a lit material to actually receive shadows
      if(!(m.material instanceof THREE.MeshStandardMaterial || m.material instanceof THREE.MeshToonMaterial)){
        var old = m.material;
        m.material = Toon.mat({ map: old.map, transparent: old.transparent, opacity: old.opacity, color: new THREE.Color(k, k, k) });
        m.material.needsUpdate = true;
      }
    }
  }

  /* ------------------------------------------------------------
     Time of day
     ------------------------------------------------------------ */
  function ensureTimeObjs(){
    if(state.timeObjs.hemi) return;
    var hemi = new THREE.HemisphereLight(0x9fb4d8, 0x2a2620, 0.55);
    var amb = new THREE.AmbientLight(0x30343c, 0.8);
    var sun = new THREE.DirectionalLight(0xfff2d6, 1.5);
    sun.position.set(16, 40, 22);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 1024;
    sun.shadow.mapSize.height = 1024;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 400;
    state.scene.add(hemi);
    state.scene.add(amb);
    state.scene.add(sun);
    state.timeObjs = { hemi: hemi, amb: amb, sun: sun };
  }

  function applyTime(mode){
    ensureTimeObjs();
    var p = TIME_PRESETS[mode] || TIME_PRESETS.day;
    state.scene.background = new THREE.Color(p.bg);
    state.timeObjs.hemi.color.setHex(p.hemiSky);
    state.timeObjs.hemi.groundColor.setHex(p.hemiGnd);
    state.timeObjs.hemi.intensity = p.hemiI;
    state.timeObjs.amb.color.setHex(p.amb);
    state.timeObjs.amb.intensity = p.ambI;
    state.timeObjs.sun.color.setHex(p.sun);
    state.timeObjs.sun.intensity = p.sunI;
    state.timeObjs.sun.position.set(p.sunPos.x, p.sunPos.y, p.sunPos.z);
    // fog follows the preset colour
    var fg = window.GARAGE_CONFIG.fog;
    if(fg.enabled){
      state.scene.fog = new THREE.Fog(new THREE.Color(fg.color), fg.near, fg.far);
    } else {
      state.scene.fog = null;
    }
    // retune light cones for atmosphere
    var coneTint = mode === 'morning' ? 0xffd9a0 : mode === 'evening' ? 0xff9a55 : mode === 'night' ? 0x8aa0cc : 0xffcc44;
    state.lightObjs.forEach(function(l){
      if(l.cone){
        l.cone.material.color.setHex(coneTint);
        l.cone.material.opacity = mode === 'night' ? 0.3 : 0.22;
      }
      if(l.def.type === 'point') l.obj.intensity = mode === 'night' ? l.def.intensity * 1.4 : l.def.intensity;
    });
  }

  /* ------------------------------------------------------------
     Fog (VFX)
     ------------------------------------------------------------ */
  function applyFog(){
    var fg = window.GARAGE_CONFIG.fog;
    if(fg.enabled){
      state.scene.fog = new THREE.Fog(new THREE.Color(fg.color), fg.near, fg.far);
      // keep background roughly matching fog so it looks seamless
      if(state.mode === 'vfx') state.scene.background = new THREE.Color(fg.color);
    } else {
      state.scene.fog = null;
    }
  }

  /* ------------------------------------------------------------
     Outline shader (global, adjustable thickness)
     ------------------------------------------------------------ */
  var _outlineCache = []; // {mesh, shell, thickness, color, active}

  function applyOutline(){
    var oc = window.GARAGE_CONFIG.outline;
    var thickness = clamp(oc.thickness, 1.001, 1.4);
    var color = hexNum(oc.color);

    function process(node){
      node.traverse(function(o){
        if(!o.isMesh || o.userData.isLightCone || o.userData.geOutline || o.userData.geImage) return;
        if(!o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
        var found = null;
        for(var i = 0; i < _outlineCache.length; i++){ if(_outlineCache[i].mesh === o){ found = _outlineCache[i]; break; } }
        if(!found){
          // shell is a CHILD of the mesh with a fixed local inflate, so it
          // follows the mesh automatically (move/rotate/scale gizmo, parents…)
          var shell = new THREE.Mesh(
            o.geometry.clone(),
            new THREE.MeshBasicMaterial({ color: color, side: THREE.BackSide })
          );
          shell.userData.geOutline = true;
          shell.renderOrder = -1;
          shell.matrixAutoUpdate = true;
          o.add(shell);
          found = { mesh: o, shell: shell, active: false };
          _outlineCache.push(found);
        }
        var active = oc.enabled && o.visible;
        found.active = active;
        found.shell.visible = active;
        found.shell.material.color.setHex(color);
        if(active){
          if(o.geometry.boundingBox === null) o.geometry.computeBoundingBox();
          var bb = o.geometry.boundingBox;
          var cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
          // scale the clone about its bbox centre: p' = c + (p-c)*s
          found.shell.position.set(cx * (1 - thickness), cy * (1 - thickness), cz * (1 - thickness));
          found.shell.scale.set(thickness, thickness, thickness);
        }
      });
    }
    if(state.root) process(state.root);
    if(state.imageObjs.length){
      state.imageObjs.forEach(function(im){ if(im.obj) process(im.obj); });
    }
    // hide shells of removed meshes
    _outlineCache.forEach(function(e){
      if(!e.mesh.parent) e.shell.visible = false;
    });
  }

  function clearOutline(){
    _outlineCache.forEach(function(e){
      if(e.shell && e.shell.parent) e.shell.parent.remove(e.shell);
    });
    _outlineCache = [];
  }

  /* Replaces every visible mesh material on the hangar with a shader style.
     Original materials are kept on the meshes (userData.geOrig) so the
     Default option restores them. */
  function applyShaderStyle(){
    var style = window.GARAGE_CONFIG.shader || 'default';
    if(!state.root) return;
    state.root.traverse(function(o){
      if(!o.isMesh || o.userData.isLightCone || o.userData.geOutline) return;
      if(!o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      if(Array.isArray(o.material)) return; // multi-material meshes keep original look
      if(style === 'default'){
        if(o.userData.geOrig){
          o.material = o.userData.geOrig;
          o.userData.geOrig = null;
        }
        o.material.wireframe = false;
        return;
      }
      if(!o.userData.geOrig) o.userData.geOrig = o.material;
      var src = o.userData.geOrig;
      var newMat;
      if(style === 'toon'){
        newMat = new THREE.MeshToonMaterial({
          color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
          map: src.map || null
        });
      } else if(style === 'flat'){
        newMat = new THREE.MeshLambertMaterial({
          color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
          map: src.map || null
        });
      } else if(style === 'glow'){
        newMat = new THREE.MeshBasicMaterial({
          color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
          map: src.map || null
        });
      } else if(style === 'wire'){
        newMat = src.clone();
        newMat.wireframe = true;
      }
      if(newMat){
        o.material = newMat;
        o.material.needsUpdate = true;
      }
    });
  }

  /* ------------------------------------------------------------
     Main render + UI
     ------------------------------------------------------------ */
  function render(){
    if(!window.Editor123 || !window.THREE){ return; }
    Editor123._mode = 'garage';
    var c = document.getElementById('editor123-content');
    if(!c) return;

    c.innerHTML =
      '<div class="te-side">' +
        '<div class="te-side-title">GARAGE EDITOR</div>' +

        '<div class="te-mode-title">EDIT</div>' +
        '<div id="ge-modes" class="te-modes">' +
          '<div class="te-mode' + (state.mode==='model' ? ' te-on' : '') + '" data-mode="model">Model (hangar)</div>' +
          '<div class="te-mode' + (state.mode==='lights' ? ' te-on' : '') + '" data-mode="lights">Lights + cones</div>' +
          '<div class="te-mode' + (state.mode==='time' ? ' te-on' : '') + '" data-mode="time">Time of day</div>' +
          '<div class="te-mode' + (state.mode==='vfx' ? ' te-on' : '') + '" data-mode="vfx">VFX (fog)</div>' +
          '<div class="te-mode' + (state.mode==='images' ? ' te-on' : '') + '" data-mode="images">Images</div>' +
          '<div class="te-mode' + (state.mode==='shaders' ? ' te-on' : '') + '" data-mode="shaders">Shaders / outline</div>' +
        '</div>' +

        '<div class="te-mode-title">MODEL</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<div id="ge-import" class="te-btn te-btn-primary" style="flex:1">⇑ Import .glb…</div>' +
          '<div id="ge-embed" class="te-btn" style="flex:1">💾 Embed</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">' +
          '<div id="ge-clear-model" class="te-btn te-btn-danger" style="flex:1">✕ Clear model</div>' +
          '<input type="file" id="ge-file" accept=".glb,.gltf" style="display:none">' +
        '</div>' +
        '<div class="te-note" id="ge-model-note" style="font-size:11px">No hangar model loaded — import your .glb, or press "Embed" to bake the built-in MTL_garage.glb so it works offline.</div>' +

        '<div class="te-mode-title">TANK ANCHOR</div>' +
        '<div class="te-note" style="font-size:11px">Select the green tank dummy with the gizmo (Move/Rotate) to set exactly where the player&#8217;s tank stands in the hangar.</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' +
          '<div id="ge-pick-anchor" class="te-btn">⛶ Pick anchor</div>' +
          '<div id="ge-free-anchor" class="te-btn">↔ Free</div>' +
        '</div>' +

        '<div class="te-mode-title">TEST</div>' +
        '<div id="ge-test" class="te-btn te-btn-primary">🏠 Test in menu</div>' +
        '<div class="te-note" style="font-size:11px">Saves the garage, then shows it behind the main menu so you can see the result. Toggle the garage with the "garage" code in the Codes menu.</div>' +

        '<div class="te-mode-title">VALUES</div>' +
        '<div id="ge-fields"></div>' +

        '<div id="ge-note" class="te-note"></div>' +

        '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<div id="ge-save" class="te-btn te-btn-primary">Save</div>' +
          '<div id="ge-reset" class="te-btn">Reset garage</div>' +
          '<div id="ge-back" class="te-btn">← Launcher</div>' +
        '</div>' +
      '</div>' +

      '<div class="te-stage">' +
        '<div class="te-stage-hint">Drag the gizmo to edit — orbit with the mouse, wheel to zoom. Right panel = current mode settings.</div>' +
        '<div id="ge-toast" class="te-toast"></div>' +
        '<div id="ge-view" class="te-view"></div>' +
        '<div id="ge-mode-content" class="te-mode-content"></div>' +
      '</div>';

    injectCss();

    $id('ge-modes').querySelectorAll('.te-mode').forEach(function(m){
      m.onclick = function(){ setMode(this.dataset.mode); };
    });

    var imp = $id('ge-import'), file = $id('ge-file');
    if(imp) imp.onclick = function(){ if(file) file.click(); };
    if(file) file.onchange = function(e){
      var f = e.target.files && e.target.files[0];
      if(!f) return;
      var reader = new FileReader();
      reader.onload = function(){
        loadModelFromDataUrl(reader.result, function(err, scene){
          if(err || !scene){ toast('Failed to parse GLB'); return; }
          setModel(scene, true);
          toast('Hangar imported — drag the gizmo to place it');
        });
      };
      reader.readAsDataURL(f);
      file.value = '';
    };

    var em = $id('ge-embed');
    if(em) em.onclick = function(){
      // load the built-in garage and embed it
      var url = 'assets/garage/MTL_garage.glb';
      new THREE.GLTFLoader().load(url, function(gltf){
        setModel(gltf.scene, true);
        doEmbed(gltf.scene);
      }, undefined, function(){
        toast('Built-in garage failed to load — import your own .glb instead');
      });
    };

    function doEmbed(scene){
      if(!window.GLTFExporter){
        var st = document.createElement('script');
        st.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/exporters/GLTFExporter.js';
        st.onload = function(){ doEmbed(scene); };
        st.onerror = function(){ toast('Exporter script failed to load — cannot embed'); };
        document.head.appendChild(st);
        return;
      }
      try{
        new GLTFExporter().parse(scene, function(result){
          try{
            var blob = new Blob([result], {type: 'application/octet-stream'});
            var fr = new FileReader();
            fr.onload = function(){
              try{
                localStorage.setItem(LS_GLB, fr.result);
                toast('Hangar embedded — works offline + in the menu');
              }catch(e){
                toast('Model too big for offline embed (browser storage ~5MB). The transform is saved — the menu uses assets/garage/MTL_garage.glb, so drop your file there to ship it');
              }
            };
            fr.readAsDataURL(blob);
          }catch(e){ toast('Embed failed'); }
        }, function(err){ toast('Export failed — ' + (err && err.message ? err.message : 'unknown error')); }, {binary: true});
      }catch(e){ toast('Embed failed — ' + e.message); }
    }

    var clr = $id('ge-clear-model');
    if(clr) clr.onclick = function(){
      if(!state.root){ toast('No model loaded'); return; }
      clearCustomModel();
      clearModel();
      toast('Model cleared — uses nothing');
    };

    var pa = $id('ge-pick-anchor');
    if(pa) pa.onclick = function(){
      buildTankDummy();
      setGizmo(state.tankDummy);
      toast('Moving the tank anchor — place it where the tank should stand');
    };
    var fa = $id('ge-free-anchor');
    if(fa) fa.onclick = function(){
      if(state.tankDummy) setGizmo(null);
    };

    var test = $id('ge-test');
    if(test) test.onclick = function(){
      doSave();
      doClose();
      setTimeout(function(){
        try{
          localStorage.setItem('tankparty_garage_preview', '1');
          if(window.Menu && Menu._startMainPreview) Menu._startMainPreview();
        }catch(e){ toast('Could not open menu preview'); }
      }, 60);
    };

    $id('ge-save').onclick = doSave;
    $id('ge-reset').onclick = doReset;
    $id('ge-back').onclick = doClose;

    state.running = true;
    state.keyHandler = function(e){
      if(e.code === 'Escape'){ doClose(); return; }
      var mod = e.ctrlKey || e.metaKey;
      if(mod && e.code === 'KeyS'){ e.preventDefault(); doSave(); }
      else if(mod && e.code === 'KeyZ'){
        if(e.shiftKey) redo(); else undo();
        e.preventDefault();
      } else if(mod && e.code === 'KeyY'){ redo(); e.preventDefault(); }
    };
    document.addEventListener('keydown', state.keyHandler);

    buildStage();
    pushHistory();
    loadIntoScene();
  }

  function setMode(mode){
    state.mode = mode;
    document.querySelectorAll('#ge-modes .te-mode').forEach(function(m){
      m.classList.toggle('te-on', m.dataset.mode === mode);
    });
    renderModeContent();
    setGizmo(null);
  }

  function loadIntoScene(){
    // reload everything from config into the live scene
    var cfg = window.GARAGE_CONFIG;
    var glbData = null;
    try{ glbData = localStorage.getItem(LS_GLB); }catch(e){}

    function afterModel(){
      // restore transforms
      if(state.root){
        state.root.position.set(cfg.model.pos.x, cfg.model.pos.y, cfg.model.pos.z);
        state.root.rotation.y = cfg.model.rotY;
        state.root.scale.set(cfg.model.scale, cfg.model.scale, cfg.model.scale);
      }
      // tank anchor
      buildTankDummy();
      if(cfg.anchor.x != null){
        state.tankDummy.position.set(cfg.anchor.x, 0.5, cfg.anchor.z);
        state.tankDummy.rotation.y = cfg.anchor.yaw || 0;
      } else if(state.root){
        // try to reuse the "tank" anchor from the model
        var a = state.root.getObjectByName('tank');
        if(a){
          a.updateWorldMatrix(true, false);
          var p = a.getWorldPosition(new THREE.Vector3());
          state.tankDummy.position.set(p.x, 0.5, p.z);
        }
      }
      // lights
      cfg.lights.forEach(function(l){
        addLight({
          type: l.type, x: l.x, y: l.y, z: l.z, color: hexNum(l.color),
          intensity: l.intensity, distance: l.distance, decay: l.decay,
          cone: l.cone, coneH: l.coneH, coneR: l.coneR
        });
      });
      // images
      cfg.images.forEach(function(im){
        var loader = new THREE.TextureLoader();
        loader.load(im.src, function(tex){
          var mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: true });
          var plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
          plane.position.set(im.x, im.y, im.z);
          plane.scale.set(im.sx, im.sy, 1);
          plane.rotation.y = im.ry || 0;
          state.scene.add(plane);
          var entry = { key: 'I' + im.name + Date.now().toString(36), obj: plane, def: im };
          state.imageObjs.push(entry);
          applyImageSettings(entry);
        });
      });
      ensureTimeObjs();
      applyTime(cfg.time);
      applyFog();
      applyShaderStyle();
      applyOutline();
      renderModelNote();
      renderModeContent();
      renderLightList();
      renderImageList();
      syncFields();
    }

    if(glbData){
      loadModelFromDataUrl(glbData, function(err, scene){
        if(!err && scene){ setModel(scene, false); afterModel(); return; }
        setModel(null, false);
        afterModel();
      });
    } else {
      // no embedded custom model — start from the built-in hangar so the user
      // sees the garage immediately; they can import their own over it
      setModel(null, false);
      new THREE.GLTFLoader().load('assets/garage/MTL_garage.glb', function(gltf){
        if(!state.running) return;
        setModel(gltf.scene, false);
        afterModel();
        renderModelNote();
      }, undefined, function(){
        if(!state.running) return;
        afterModel();
      });
    }
  }

  function setModel(scene, fresh){
    clearModel();
    var cfg = window.GARAGE_CONFIG;
    var root = new THREE.Group();
    root.name = 'garage-root';
    if(scene){
      root.add(scene);
      state.gltfScene = scene;
      // make the tank anchor marker visible-ish: hide export stand-ins
      scene.traverse(function(o){
        if(o.isMesh && o.parent && /^(RootNode|RootNode\.\d+)$/.test(o.parent.name)) o.visible = false;
      });
    }
    state.scene.add(root);
    state.root = root;
    // If a custom transform was saved, use it verbatim. Otherwise keep the
    // hangar's default 180° so the hall fronts the viewer (same as the menu).
    var custom = cfg.model.pos.x || cfg.model.pos.y || cfg.model.pos.z || cfg.model.rotY || cfg.model.scale !== 1;
    if(custom){
      root.rotation.y = cfg.model.rotY;
      root.position.set(cfg.model.pos.x, cfg.model.pos.y, cfg.model.pos.z);
      root.scale.set(cfg.model.scale, cfg.model.scale, cfg.model.scale);
    } else {
      root.rotation.y = Math.PI;
    }
    if(state.gizmo) setGizmo(root);
  }

  function clearModel(){
    if(state.root){
      state.scene.remove(state.root);
      disposeObj(state.root);
      state.root = null;
    }
    state.gltfScene = null;
    clearOutline();
  }

  function disposeObj(obj){
    obj.traverse(function(o){
      if(o.isMesh){
        if(o.geometry) o.geometry.dispose();
        if(o.material){
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach(function(m){ if(m.map) m.map.dispose(); m.dispose(); });
        }
      }
    });
  }

  /* ------------------------------------------------------------
     Mode panels (right side overlay)
     ------------------------------------------------------------ */
  function renderModeContent(){
    var el = $id('ge-mode-content');
    if(!el) return;
    if(state.mode === 'model'){
      el.innerHTML =
        '<div class="ge-mc-title">Model</div>' +
        '<div class="te-note" style="font-size:11px">Import your hangar .glb, then use the gizmo buttons below to move / rotate / scale the whole model.</div>' +
        '<div style="display:flex;gap:6px;margin-top:8px">' +
          '<span class="te-btn" data-ge-gizmo="translate">⟷ Move</span>' +
          '<span class="te-btn" data-ge-gizmo="rotate">↻ Rotate</span>' +
          '<span class="te-btn" data-ge-gizmo="scale">⇔ Scale</span>' +
          '<span class="te-btn" data-ge-gizmo="off">Off</span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:8px">' +
          '<span class="te-btn" data-ge-axis="x">Side X</span>' +
          '<span class="te-btn" data-ge-axis="y">Top Y</span>' +
          '<span class="te-btn" data-ge-axis="z">Front Z</span>' +
          '<span class="te-btn" data-ge-axis="p">Persp</span>' +
        '</div>';
      wireGizmoButtons(el);
      if(state.root) setGizmo(state.root);
    } else if(state.mode === 'lights'){
      el.innerHTML =
        '<div class="ge-mc-title">Lights + light cones</div>' +
        '<div class="te-note" style="font-size:11px">The yellow translucent figures are light cones. Add lights, pick the cone toggle, move them with the gizmo. "Detect from model" turns the hangar&#8217;s Empty lamp markers + a sun into real lights.</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
          '<span class="te-btn" data-ge-addlight="point">● Point</span>' +
          '<span class="te-btn" data-ge-addlight="spot">🔦 Spot</span>' +
          '<span class="te-btn" data-ge-addlight="sun">☀ Sun</span>' +
          '<span class="te-btn" data-ge-addlight="cone">▽ Cone only</span>' +
        '</div>' +
        '<span class="te-btn te-btn-primary" id="ge-detect" style="display:block;text-align:center;margin-top:8px">🔍 Detect lamps + sun from model</span>' +
        '<div id="ge-light-list" class="ge-list" style="margin-top:10px"></div>';
      wireLightMode();
      renderLightList();
    } else if(state.mode === 'time'){
      el.innerHTML =
        '<div class="ge-mc-title">Lights + light cones</div>' +
        '<div class="te-note" style="font-size:11px">The yellow translucent figures are light cones. Add lights, pick the cone toggle, move them with the gizmo. "Detect from model" turns the hangar&#8217;s Empty lamp markers + a sun into real lights.</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
          '<span class="te-btn" data-ge-addlight="point">● Point</span>' +
          '<span class="te-btn" data-ge-addlight="spot">🔦 Spot</span>' +
          '<span class="te-btn" data-ge-addlight="sun">☀ Sun</span>' +
          '<span class="te-btn" data-ge-addlight="cone">▽ Cone only</span>' +
        '</div>' +
        '<span class="te-btn te-btn-primary" id="ge-detect" style="display:block;text-align:center;margin-top:8px">🔍 Detect lamps + sun from model</span>' +
        '<div id="ge-light-list" class="ge-list" style="margin-top:10px"></div>';
      wireLightMode();
      renderLightList();
    } else if(state.mode === 'time'){
      var t = window.GARAGE_CONFIG.time;
      el.innerHTML =
        '<div class="ge-mc-title">Time of day</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
          '<span class="te-btn' + (t==='morning' ? ' te-on' : '') + '" data-ge-time="morning">🌅 Morning</span>' +
          '<span class="te-btn' + (t==='day' ? ' te-on' : '') + '" data-ge-time="day">☀ Day</span>' +
          '<span class="te-btn' + (t==='evening' ? ' te-on' : '') + '" data-ge-time="evening">🌇 Evening</span>' +
          '<span class="te-btn' + (t==='night' ? ' te-on' : '') + '" data-ge-time="night">🌙 Night</span>' +
        '</div>';
      el.querySelectorAll('[data-ge-time]').forEach(function(b){
        b.onclick = function(){
          window.GARAGE_CONFIG.time = this.dataset.geTime;
          saveConfig();
          applyTime(window.GARAGE_CONFIG.time);
          renderModeContent();
          updateConfig();
        };
      });
    } else if(state.mode === 'vfx'){
      var fg = window.GARAGE_CONFIG.fog;
      el.innerHTML =
        '<div class="ge-mc-title">VFX — fog</div>' +
        '<label class="te-field"><span>Fog on</span><select id="ge-fog-on" class="te-input"><option value="1"' + (fg.enabled ? ' selected' : '') + '>On</option><option value="0"' + (!fg.enabled ? ' selected' : '') + '>Off</option></select></label>' +
        '<label class="te-field"><span>Fog colour</span><input id="ge-fog-color" type="color" value="' + fg.color + '" class="te-input" style="height:34px;padding:2px"></label>' +
        '<label class="te-field"><span>Start distance</span><input id="ge-fog-near" type="number" step="1" value="' + fg.near + '" class="te-input"></label>' +
        '<label class="te-field"><span>End distance</span><input id="ge-fog-far" type="number" step="5" value="' + fg.far + '" class="te-input"></label>' +
        '<div class="te-note" style="font-size:11px">Fog adds atmosphere. Morning = soft haze, night = deep gloom.</div>';
      var on = $id('ge-fog-on'), col = $id('ge-fog-color'), nr = $id('ge-fog-near'), fr = $id('ge-fog-far');
      if(on) on.onchange = function(){
        window.GARAGE_CONFIG.fog.enabled = on.value === '1';
        saveConfig(); applyFog(); applyTime(window.GARAGE_CONFIG.time); updateConfig();
      };
      if(col) col.oninput = function(){
        window.GARAGE_CONFIG.fog.color = col.value;
        saveConfig(); applyFog(); applyTime(window.GARAGE_CONFIG.time); updateConfig();
      };
      if(nr) nr.oninput = function(){
        window.GARAGE_CONFIG.fog.near = parseFloat(nr.value) || 40;
        saveConfig(); applyFog(); updateConfig();
      };
      if(fr) fr.oninput = function(){
        window.GARAGE_CONFIG.fog.far = parseFloat(fr.value) || 240;
        saveConfig(); applyFog(); updateConfig();
      };
    } else if(state.mode === 'images'){
      el.innerHTML =
        '<div class="ge-mc-title">Images</div>' +
        '<div class="te-note" style="font-size:11px">Import a PNG/JPG, then move / scale / rotate it. Per image you can allow light to pass, make it glow, darken it, or let it receive shadows.</div>' +
        '<span class="te-btn te-btn-primary" id="ge-img-add" style="display:block;text-align:center;margin-top:8px">⇑ Import image…</span>' +
        '<input type="file" id="ge-img-file" accept="image/*" style="display:none">' +
        '<div id="ge-image-list" class="ge-list" style="margin-top:10px"></div>';
      var ia = $id('ge-img-add'), ifile = $id('ge-img-file');
      if(ia) ia.onclick = function(){ if(ifile) ifile.click(); };
      if(ifile) ifile.onchange = function(e){
        var f = e.target.files && e.target.files[0];
        if(!f) return;
        addImage(f, function(entry){
          if(!entry){ toast('Image failed to load'); return; }
          renderImageList();
          toast('Image added — drag it into place');
        });
        ifile.value = '';
      };
      renderImageList();
    } else if(state.mode === 'shaders'){
      var oc = window.GARAGE_CONFIG.outline;
      var shader = window.GARAGE_CONFIG.shader || 'default';
      el.innerHTML =
        '<div class="ge-mc-title">Shaders / outline</div>' +
        '<label class="te-field"><span>Shader style (whole hangar)</span><select id="ge-shader" class="te-input">' +
          '<option value="default"' + (shader==='default' ? ' selected' : '') + '>Default (as imported)</option>' +
          '<option value="toon"' + (shader==='toon' ? ' selected' : '') + '>Toon (cartoon shading)</option>' +
          '<option value="flat"' + (shader==='flat' ? ' selected' : '') + '>Flat (no specular)</option>' +
          '<option value="glow"' + (shader==='glow' ? ' selected' : '') + '>Glow (bright, unlit)</option>' +
          '<option value="wire"' + (shader==='wire' ? ' selected' : '') + '>Wireframe</option>' +
        '</select></label>' +
        '<label class="te-field"><span>Outline on</span><select id="ge-ol-on" class="te-input"><option value="1"' + (oc.enabled ? ' selected' : '') + '>On</option><option value="0"' + (!oc.enabled ? ' selected' : '') + '>Off</option></select></label>' +
        '<label class="te-field"><span>Outline thickness</span><input id="ge-ol-thick" type="range" min="1.001" max="1.35" step="0.005" value="' + oc.thickness + '" style="accent-color:#ffb12b"></label>' +
        '<label class="te-field"><span>Outline colour</span><input id="ge-ol-color" type="color" value="' + oc.color + '" class="te-input" style="height:34px;padding:2px"></label>' +
        '<div class="te-note" style="font-size:11px">Outline wraps every object (garage + images) with a dark rim. Toon = cel-shaded, Glow = unlit neon look, Wire = skeleton view.</div>';
      var sh = $id('ge-shader');
      if(sh) sh.onchange = function(){
        window.GARAGE_CONFIG.shader = sh.value;
        saveConfig(); applyShaderStyle(); updateConfig();
      };
      var oon = $id('ge-ol-on'), oth = $id('ge-ol-thick'), oco = $id('ge-ol-color');
      if(oon) oon.onchange = function(){
        window.GARAGE_CONFIG.outline.enabled = oon.value === '1';
        saveConfig(); applyOutline(); updateConfig();
      };
      if(oth) oth.oninput = function(){
        window.GARAGE_CONFIG.outline.thickness = parseFloat(oth.value) || 1.04;
        var lbl = oth.parentElement.querySelector('span');
        if(lbl) lbl.textContent = 'Outline thickness — ' + round(window.GARAGE_CONFIG.outline.thickness);
        saveConfig(); applyOutline(); updateConfig();
      };
      if(oco) oco.oninput = function(){
        window.GARAGE_CONFIG.outline.color = oco.value;
        saveConfig(); applyOutline(); updateConfig();
      };
    }
  }

  function wireLightMode(){
    var d = $id('ge-detect');
    if(d) d.onclick = detectLightsFromModel;
    var modeEl = $id('ge-mode-content');
    if(modeEl){
      modeEl.querySelectorAll('[data-ge-addlight]').forEach(function(b){
        b.onclick = function(){
          var k = this.dataset.geAddlight;
          if(k === 'cone'){
            addLight({ type:'point', cone:true, coneH:6, coneR:1.2, intensity:0, distance:0 });
            toast('Light cone added — it&#8217;s a pure yellow translucent figure');
          } else {
            addLight({ type:k, cone:true });
          }
          renderModeContent();
        };
      });
      wireGizmoButtons(modeEl);
    }
  }

  function wireGizmoButtons(scope){
    if(!scope) return;
    scope.querySelectorAll('[data-ge-gizmo]').forEach(function(b){
      b.onclick = function(){
        var g = this.dataset.geGizmo;
        if(state.gizmo) state.gizmo.setMode(g === 'off' ? 'translate' : g);
        if(g === 'off') setGizmo(null);
        else if(state.mode === 'model' && state.root) setGizmo(state.root);
      };
    });
    scope.querySelectorAll('[data-ge-axis]').forEach(function(b){
      b.onclick = function(){ setAxisView(this.dataset.geAxis); };
    });
  }

  function renderLightList(){
    var el = $id('ge-light-list');
    if(!el) return;
    if(!state.lightObjs.length){
      el.innerHTML = '<div style="color:#555;font-size:11px;padding:10px 0">No lights yet. Add one above, or detect the lamps from your model.</div>';
      return;
    }
    el.innerHTML = state.lightObjs.map(function(l){
      var t = l.def.type === 'sun' ? '☀ Sun' : l.def.type === 'spot' ? '🔦 Spot' : '● Point';
      return '<div class="ge-item" data-key="' + l.key + '">' +
        '<div class="ge-item-head"><span>' + t + '</span>' +
        '<span class="ge-item-actions">' +
          '<span class="ge-mini" data-ge-sel="' + l.key + '">⛶</span>' +
          '<span class="ge-mini" data-ge-del="' + l.key + '" style="color:#c66">✕</span>' +
        '</span></div>' +
        '<label class="te-field"><span>Cone figure</span><select data-ge-cone="' + l.key + '" class="te-input"><option value="1"' + (l.def.cone ? ' selected' : '') + '>On</option><option value="0"' + (!l.def.cone ? ' selected' : '') + '>Off</option></select></label>' +
        '<label class="te-field"><span>Colour</span><input type="color" value="' + hexStr(l.obj.color.getHex()) + '" data-ge-color="' + l.key + '" class="te-input" style="height:30px;padding:2px"></label>' +
        '<label class="te-field"><span>Intensity</span><input type="number" step="0.1" value="' + l.obj.intensity + '" data-ge-int="' + l.key + '" class="te-input"></label>' +
      '</div>';
    }).join('');
    el.querySelectorAll('[data-ge-sel]').forEach(function(b){
      b.onclick = function(){
        var e = findLight(this.dataset.geSel);
        if(e) setGizmo(e.obj);
      };
    });
    el.querySelectorAll('[data-ge-del]').forEach(function(b){
      b.onclick = function(){ removeLight(this.dataset.geDel); };
    });
    el.querySelectorAll('[data-ge-cone]').forEach(function(b){
      b.onchange = function(){
        var e = findLight(this.dataset.geCone);
        if(!e) return;
        e.def.cone = b.value === '1';
        if(e.def.cone && !e.cone){
          e.cone = makeCone(e.obj, e.def.coneH, e.def.coneR, e.obj.color.getHex());
        } else if(!e.def.cone && e.cone){
          e.obj.remove(e.cone);
          e.cone = null;
        }
        renderLightList(); updateConfig();
      };
    });
    el.querySelectorAll('[data-ge-color]').forEach(function(b){
      b.oninput = function(){
        var e = findLight(this.dataset.geColor);
        if(!e) return;
        e.obj.color.setHex(hexNum(b.value));
        if(e.cone) e.cone.material.color.setHex(hexNum(b.value));
        renderLightList(); updateConfig();
      };
    });
    el.querySelectorAll('[data-ge-int]').forEach(function(b){
      b.oninput = function(){
        var e = findLight(this.dataset.geInt);
        if(!e) return;
        e.obj.intensity = parseFloat(b.value) || 0;
        updateConfig();
      };
    });
  }

  function renderImageList(){
    var el = $id('ge-image-list');
    if(!el) return;
    if(!state.imageObjs.length){
      el.innerHTML = '<div style="color:#555;font-size:11px;padding:10px 0">No images yet. Import one above — posters, banners, screens.</div>';
      return;
    }
    el.innerHTML = state.imageObjs.map(function(im){
      return '<div class="ge-item" data-key="' + im.key + '">' +
        '<div class="ge-item-head"><span>🖼 ' + im.def.name + '</span>' +
        '<span class="ge-item-actions">' +
          '<span class="ge-mini" data-ge-imsel="' + im.key + '">⛶</span>' +
          '<span class="ge-mini" data-ge-imdel="' + im.key + '" style="color:#c66">✕</span>' +
        '</span></div>' +
        '<label class="te-field"><span>Light passes through</span><select data-ge-impass="' + im.key + '" class="te-input"><option value="1"' + (im.def.lightPass ? ' selected' : '') + '>Yes</option><option value="0"' + (!im.def.lightPass ? ' selected' : '') + '>No</option></select></label>' +
        '<label class="te-field"><span>Glow (additive)</span><select data-ge-imglow="' + im.key + '" class="te-input"><option value="1"' + (im.def.glow ? ' selected' : '') + '>Yes</option><option value="0"' + (!im.def.glow ? ' selected' : '') + '>No</option></select></label>' +
        '<label class="te-field"><span>Darken (' + round(im.def.dark) + ')</span><input type="range" min="0.05" max="1" step="0.01" value="' + im.def.dark + '" data-ge-imdark="' + im.key + '" style="accent-color:#ffb12b"></label>' +
        '<label class="te-field"><span>Receive shadows</span><select data-ge-imshadow="' + im.key + '" class="te-input"><option value="1"' + (im.def.receiveShadow ? ' selected' : '') + '>Yes</option><option value="0"' + (!im.def.receiveShadow ? ' selected' : '') + '>No</option></select></label>' +
      '</div>';
    }).join('');
    el.querySelectorAll('[data-ge-imsel]').forEach(function(b){
      b.onclick = function(){
        var e = findImage(this.dataset.geImsel);
        if(e) setGizmo(e.obj);
      };
    });
    el.querySelectorAll('[data-ge-imdel]').forEach(function(b){
      b.onclick = function(){ removeImage(this.dataset.geImdel); };
    });
    el.querySelectorAll('[data-ge-impass]').forEach(function(b){
      b.onchange = function(){
        var e = findImage(this.dataset.geImpass);
        if(!e) return;
        e.def.lightPass = b.value === '1';
        applyImageSettings(e); renderImageList(); updateConfig();
      };
    });
    el.querySelectorAll('[data-ge-imglow]').forEach(function(b){
      b.onchange = function(){
        var e = findImage(this.dataset.geImglow);
        if(!e) return;
        e.def.glow = b.value === '1';
        applyImageSettings(e); renderImageList(); updateConfig();
      };
    });
    el.querySelectorAll('[data-ge-imdark]').forEach(function(b){
      b.oninput = function(){
        var e = findImage(this.dataset.geImdark);
        if(!e) return;
        e.def.dark = parseFloat(b.value) || 1;
        applyImageSettings(e); renderImageList(); updateConfig();
      };
    });
    el.querySelectorAll('[data-ge-imshadow]').forEach(function(b){
      b.onchange = function(){
        var e = findImage(this.dataset.geImshadow);
        if(!e) return;
        e.def.receiveShadow = b.value === '1';
        applyImageSettings(e); renderImageList(); updateConfig();
      };
    });
  }

  function findLight(key){
    for(var i = 0; i < state.lightObjs.length; i++) if(state.lightObjs[i].key === key) return state.lightObjs[i];
    return null;
  }
  function findImage(key){
    for(var i = 0; i < state.imageObjs.length; i++) if(state.imageObjs[i].key === key) return state.imageObjs[i];
    return null;
  }

  function renderModelNote(){
    var el = $id('ge-model-note');
    if(!el) return;
    el.innerHTML = state.root ? 'Hangar model loaded ✓ — use the gizmo to move / rotate / scale it.' : 'No hangar model loaded — import your .glb, or press "Embed" to bake the built-in MTL_garage.glb so it works offline.';
  }

  function syncFields(){
    var el = $id('ge-fields');
    if(!el) return;
    var cfg = window.GARAGE_CONFIG;
    var html = '';
    if(state.mode === 'model'){
      html += field('m.pos.x', 'Model X', state.root ? state.root.position.x : cfg.model.pos.x, -200, 200);
      html += field('m.pos.z', 'Model Z', state.root ? state.root.position.z : cfg.model.pos.z, -200, 200);
      html += field('m.rotY', 'Model rotY (°)', state.root ? state.root.rotation.y * 180 / Math.PI : cfg.model.rotY * 180 / Math.PI, -360, 360);
      html += field('m.scale', 'Model scale', state.root ? state.root.scale.x : cfg.model.scale, 0.01, 50);
    } else if(state.mode === 'lights' && state.selected && state.selected.isLight){
      html += field('l.x', 'Light X', state.selected.position.x, -300, 300);
      html += field('l.y', 'Light Y', state.selected.position.y, -300, 300);
      html += field('l.z', 'Light Z', state.selected.position.z, -300, 300);
    } else if(state.mode === 'images' && state.selected){
      html += field('i.x', 'Image X', state.selected.position.x, -300, 300);
      html += field('i.y', 'Image Y', state.selected.position.y, -300, 300);
      html += field('i.z', 'Image Z', state.selected.position.z, -300, 300);
      html += field('i.ry', 'RotY (°)', state.selected.rotation.y * 180 / Math.PI, -360, 360);
      html += field('i.sx', 'Scale X', state.selected.scale.x, 0.05, 60);
      html += field('i.sy', 'Scale Y', state.selected.scale.y, 0.05, 60);
    } else if(state.mode === 'shaders'){
      html += field('o.thick', 'Outline thickness', cfg.outline.thickness, 1.001, 1.4);
    }
    el.innerHTML = html;
    el.querySelectorAll('input').forEach(function(inp){
      inp.oninput = function(){
        var k = inp.dataset.key;
        var v = parseFloat(inp.value);
        if(isNaN(v)) return;
        if(k === 'm.pos.x'){ if(state.root) state.root.position.x = v; }
        else if(k === 'm.pos.z'){ if(state.root) state.root.position.z = v; }
        else if(k === 'm.rotY'){ if(state.root) state.root.rotation.y = v * Math.PI / 180; }
        else if(k === 'm.scale'){ if(state.root) state.root.scale.set(v, v, v); }
        else if(k === 'o.thick'){ window.GARAGE_CONFIG.outline.thickness = v; applyOutline(); }
        else if(k.indexOf('l.') === 0){
          if(state.selected){
            if(k === 'l.x') state.selected.position.x = v;
            if(k === 'l.y') state.selected.position.y = v;
            if(k === 'l.z') state.selected.position.z = v;
          }
        }
        else if(k.indexOf('i.') === 0){
          if(state.selected){
            if(k === 'i.x') state.selected.position.x = v;
            if(k === 'i.y') state.selected.position.y = v;
            if(k === 'i.z') state.selected.position.z = v;
            if(k === 'i.ry') state.selected.rotation.y = v * Math.PI / 180;
            if(k === 'i.sx') state.selected.scale.x = v;
            if(k === 'i.sy') state.selected.scale.y = v;
          }
        }
        updateConfig();
      };
    });
  }

  function field(key, label, val, min, max){
    return '<label class="te-field"><span>' + label + '</span><input type="number" step="0.05" min="' + min + '" max="' + max + '" data-key="' + key + '" value="' + round(val) + '"></label>';
  }

  function setAxisView(axis){
    if(!state.camera) return;
    var target = new THREE.Vector3();
    if(state.root) state.root.getWorldPosition(target);
    if(state.tankDummy) target.copy(state.tankDummy.position);
    target.y = 4;
    var dist = state.camera.position.distanceTo(target);
    if(!dist || dist < 1) dist = 30;
    var pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    if(axis === 'x'){ pos.set(dist, 0, 0); }
    else if(axis === 'y'){ pos.set(0, dist, 0.0001); up.set(0, 0, -1); }
    else if(axis === 'z'){ pos.set(0, 0, dist); }
    else { pos.set(30, 22, 40); }
    state.camera.position.copy(target).add(pos);
    state.camera.up.copy(up);
    state.camera.lookAt(target);
    if(state.controls){ state.controls.target.copy(target); state.controls.update(); }
  }

  /* ------------------------------------------------------------
     Save / reset / close / history
     ------------------------------------------------------------ */
  function pushHistory(){
    try{
      var snap = JSON.stringify(window.GARAGE_CONFIG);
      state.history.splice(state.historyIdx + 1, 999, snap);
      state.historyIdx = state.history.length - 1;
    }catch(e){}
  }
  function restoreSnap(snap){
    try{
      window.GARAGE_CONFIG = JSON.parse(snap);
      saveConfig();
      reloadSceneFromConfig();
    }catch(e){}
  }
  function undo(){ if(state.historyIdx > 0){ state.historyIdx--; restoreSnap(state.history[state.historyIdx]); } }
  function redo(){ if(state.historyIdx < state.history.length - 1){ state.historyIdx++; restoreSnap(state.history[state.historyIdx]); } }

  function reloadSceneFromConfig(){
    clearLights();
    clearImages();
    clearModel();
    loadIntoScene();
  }

  function clearLights(){
    state.lightObjs.slice().forEach(function(l){
      if(l.obj.target && l.obj.target.parent) state.scene.remove(l.obj.target);
      state.scene.remove(l.obj);
    });
    state.lightObjs = [];
  }
  function clearImages(){
    state.imageObjs.slice().forEach(function(im){ state.scene.remove(im.obj); });
    state.imageObjs = [];
  }

  function doSave(){
    updateConfig();
    applyShaderStyle();
    applyOutline();
    toast('Garage saved — the menu will show it next time');
  }

  function doReset(){
    window.GARAGE_CONFIG = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
    saveConfig();
    try{ localStorage.removeItem(LS_GLB); }catch(e){}
    reloadSceneFromConfig();
    toast('Garage reset to default');
  }

  function dispose(){
    if(state.keyHandler){ document.removeEventListener('keydown', state.keyHandler); state.keyHandler = null; }
    if(state.resizeHandler){ window.removeEventListener('resize', state.resizeHandler); state.resizeHandler = null; }
    if(state.gizmo){ try{ state.gizmo.detach(); state.gizmo.dispose(); }catch(e){} state.gizmo = null; }
    if(state.controls){ try{ state.controls.dispose(); }catch(e){} state.controls = null; }
    clearModel(); clearLights(); clearImages();
    clearOutline();
    if(state.tankDummy){ state.scene.remove(state.tankDummy); state.tankDummy = null; }
    if(state.renderer){ try{ state.renderer.dispose(); }catch(e){} state.renderer = null; }
    state.scene = null; state.camera = null;
    state.running = false;
    if(state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  function doClose(){
    dispose();
    if(Editor123 && Editor123._renderLauncher) Editor123._renderLauncher();
  }

  /* ------------------------------------------------------------
     Styles
     ------------------------------------------------------------ */
  function injectCss(){
    if(document.getElementById('ge-css')) return;
    var st = document.createElement('style');
    st.id = 'ge-css';
    st.textContent =
      '.ge-mode-content{position:absolute;top:10px;right:12px;width:240px;background:rgba(18,21,26,.92);border:1px solid #2a2f36;border-radius:12px;padding:12px;z-index:6;max-height:70%;overflow-y:auto;backdrop-filter:blur(4px)}' +
      '.ge-mc-title{color:#ffb12b;font-weight:800;font-size:13px;letter-spacing:.4px;margin-bottom:4px}' +
      '.ge-list{display:flex;flex-direction:column;gap:8px}' +
      '.ge-item{background:#1e232a;border:1px solid #2a2f36;border-radius:9px;padding:8px;font-size:12px}' +
      '.ge-item-head{display:flex;justify-content:space-between;align-items:center;color:#ddd;font-weight:700;margin-bottom:6px}' +
      '.ge-item-actions{display:flex;gap:4px}' +
      '.ge-mini{padding:2px 7px;background:#2a2f36;border-radius:5px;cursor:pointer;color:#bbb;font-size:11px}' +
      '.ge-mini:hover{border-color:#ffb12b;color:#fff}' +
      '.ge-teal{color:#7bd36e}';
    document.head.appendChild(st);
  }

  return {
    render: render,
    dispose: dispose,
    applyTime: applyTime,
    applyOutline: applyOutline,
    getConfig: function(){ return window.GARAGE_CONFIG; },
    saveConfig: saveConfig,
  };
})();