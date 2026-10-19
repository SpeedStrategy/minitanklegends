/* ============================================================
   map-importer.js — Import GLB maps, detect spawns, adjust
   lighting, toggle wireframe, generate publish code.
   ============================================================ */

window.MapImporter = (function(){

  var state = {
    running: false,
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    raf: null,
    model: null,
    grid: null,
    spawns: [],
    bushes: [],
    lights: {},
    wireframeOn: false,
    gridOn: true,
    rawBuffer: null,
    fileName: '',
    triangleCount: 0,
    vertexCount: 0,
    currentLighting: 'day'
  };

  var TIME_PRESETS = {
    day: {
      bg: 0x7ab8e0,
      hemiSky: 0x87ceeb, hemiGnd: 0x5a3a2a, hemiI: 0.9,
      sun: 0xffdd99, sunI: 1.4, sunPos: {x:25, y:35, z:20},
      amb: 0x666688, ambI: 0.35
    },
    morning: {
      bg: 0x8ea4bd,
      hemiSky: 0xb8c8e0, hemiGnd: 0x6a5a44, hemiI: 0.9,
      sun: 0xffd9a0, sunI: 1.7, sunPos: {x:-24, y:16, z:-10},
      amb: 0x404448, ambI: 0.9
    },
    evening: {
      bg: 0x241a20,
      hemiSky: 0xd8a8b8, hemiGnd: 0x241a10, hemiI: 0.6,
      sun: 0xff7a45, sunI: 2.1, sunPos: {x:-20, y:10, z:-6},
      amb: 0x3a2a24, ambI: 0.9
    },
    night: {
      bg: 0x0a0d16,
      hemiSky: 0x3a4a6a, hemiGnd: 0x12161f, hemiI: 0.4,
      sun: 0x6f8fd6, sunI: 0.9, sunPos: {x:-8, y:38, z:10},
      amb: 0x141a28, ambI: 1.0
    }
  };

  function $id(id){ return document.getElementById(id); }

  function toast(msg){
    if(window.Editor123 && Editor123.toast) Editor123.toast(msg);
    else if(window.Menu && Menu.toast) Menu.toast(msg);
  }

  /* --- Lighting --- */
  function applyLighting(mode){
    var p = TIME_PRESETS[mode] || TIME_PRESETS.day;
    state.currentLighting = mode;
    if(!state.scene) return;
    state.scene.background = new THREE.Color(p.bg);
    if(state.lights.hemi){
      state.lights.hemi.color.setHex(p.hemiSky);
      state.lights.hemi.groundColor.setHex(p.hemiGnd);
      state.lights.hemi.intensity = p.hemiI;
    }
    if(state.lights.sun){
      state.lights.sun.color.setHex(p.sun);
      state.lights.sun.intensity = p.sunI;
      state.lights.sun.position.set(p.sunPos.x, p.sunPos.y, p.sunPos.z);
    }
    if(state.lights.amb){
      state.lights.amb.color.setHex(p.amb);
      state.lights.amb.intensity = p.ambI;
    }
    document.querySelectorAll('.mi-time-btn').forEach(function(btn){
      btn.style.borderColor = btn.dataset.time === mode ? '#ff8800' : '#2a3050';
      btn.style.color = btn.dataset.time === mode ? '#ff8800' : '#8890a8';
    });
  }

  /* --- Wireframe --- */
  function toggleWireframe(){
    state.wireframeOn = !state.wireframeOn;
    if(state.model){
      state.model.traverse(function(o){
        if(o.isMesh && o.material){
          if(Array.isArray(o.material)) o.material.forEach(function(m){ m.wireframe = state.wireframeOn; });
          else o.material.wireframe = state.wireframeOn;
        }
      });
    }
    var btn = $id('mi-wireframe-btn');
    if(btn) btn.style.color = state.wireframeOn ? '#ff8800' : '#8890a8';
    toast('Wireframe: ' + (state.wireframeOn ? 'ON' : 'OFF'));
  }

  /* --- Grid --- */
  function toggleGrid(){
    state.gridOn = !state.gridOn;
    if(state.grid) state.grid.visible = state.gridOn;
    var btn = $id('mi-grid-btn');
    if(btn) btn.style.color = state.gridOn ? '#ff8800' : '#8890a8';
  }

  /* --- Spawn detection --- */
  function detectSpawns(scene){
    var spawns = [];
    scene.traverse(function(obj){
      if(!obj.name) return;
      var lower = obj.name.toLowerCase();
      if(lower.includes('blue') || lower.includes('red')){
        var team = lower.includes('blue') ? 'blue' : 'red';
        var worldPos = new THREE.Vector3();
        obj.getWorldPosition(worldPos);
        spawns.push({ name: obj.name, team: team, pos: worldPos });
      }
    });
    return spawns;
  }

  /* --- Bush detection --- */
  function detectBushes(scene){
    var bushes = [];
    scene.traverse(function(obj){
      if(!obj.name) return;
      var lower = obj.name.toLowerCase();
      if(lower.includes('bush')){
        bushes.push({ name: obj.name, obj: obj });
      }
    });
    return bushes;
  }

  function storeBushRefs(bushes){
    state.bushes = bushes;
    state.bushes.forEach(function(b){ b.flipped = false; });
    var flipBtn = $id('mi-flip-btn');
    if(flipBtn) flipBtn.style.display = bushes.length > 0 ? '' : 'none';
  }

  function updateBushList(){
    var el = $id('mi-bush-list');
    if(!el) return;
    if(!state.bushes || state.bushes.length === 0){
      el.innerHTML = '<div style="color:#556;font-style:italic;margin-top:4px">No bushes detected</div>';
      return;
    }
    var html = '<div style="color:#33cc55;margin-top:4px">Bushes: ' + state.bushes.length + ' (billboard)</div>';
    state.bushes.forEach(function(b){ html += '<div style="color:#55aa66;font-size:11px;margin-left:8px">\u2022 ' + b.name + '</div>'; });
    el.innerHTML = html;
  }

  function renderSpawnMarkers(spawns){
    state.spawns.forEach(function(s){
      if(s.mesh){ state.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); }
      if(s.ring){ state.scene.remove(s.ring); s.ring.geometry.dispose(); s.ring.material.dispose(); }
    });
    state.spawns = [];

    spawns.forEach(function(s){
      var color = s.team === 'blue' ? 0x2299ff : 0xff3333;
      var geo = new THREE.CylinderGeometry(0.3, 0.3, 2, 16);
      geo.translate(0, 1, 0);
      var mat = new THREE.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: 0.5, transparent: true, opacity: 0.8 });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(s.pos);
      state.scene.add(mesh);
      var ringGeo = new THREE.RingGeometry(0.5, 0.7, 32);
      ringGeo.rotateX(-Math.PI/2);
      var ringMat = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
      var ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(s.pos.x, s.pos.y + 0.05, s.pos.z);
      state.scene.add(ring);
      state.spawns.push({ name: s.name, team: s.team, pos: s.pos, mesh: mesh, ring: ring });
    });
  }

  function updateSpawnList(){
    var el = $id('mi-spawn-list');
    if(!el) return;
    var blue = state.spawns.filter(function(s){ return s.team === 'blue'; });
    var red = state.spawns.filter(function(s){ return s.team === 'red'; });
    var html = '';
    html += '<div style="color:#2299ff;margin-top:8px">Blue: ' + blue.length + '</div>';
    blue.forEach(function(s){ html += '<div style="color:#5599cc;font-size:11px;margin-left:8px">\u2022 ' + s.name + '</div>'; });
    html += '<div style="color:#ff3333;margin-top:8px">Red: ' + red.length + '</div>';
    red.forEach(function(s){ html += '<div style="color:#cc5555;font-size:11px;margin-left:8px">\u2022 ' + s.name + '</div>'; });
    if(state.spawns.length === 0) html = '<div style="color:#556;font-style:italic;margin-top:8px">No spawns detected</div>';
    el.innerHTML = html;
  }

  /* --- Triangle count --- */
  function countTriangles(scene){
    var tris = 0, verts = 0;
    scene.traverse(function(o){
      if(!o.isMesh) return;
      var g = o.geometry;
      if(!g) return;
      if(g.index) tris += g.index.count / 3;
      else if(g.attributes.position) tris += g.attributes.position.count / 3;
      if(g.attributes.position) verts += g.attributes.position.count;
    });
    state.triangleCount = Math.round(tris);
    state.vertexCount = verts;
    var el = $id('mi-tri-count');
    if(el) el.textContent = tris.toLocaleString();
    var el2 = $id('mi-vert-count');
    if(el2) el2.textContent = verts.toLocaleString();
  }

  /* --- Camera fit --- */
  function fitCamera(model){
    if(!model || !state.camera || !state.controls) return;
    var box = new THREE.Box3().setFromObject(model);
    var size = box.getSize(new THREE.Vector3());
    var center = box.getCenter(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z);
    var dist = maxDim * 1.2;
    state.camera.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.6);
    state.controls.target.copy(center);
    state.controls.update();
  }

  /* --- Load GLB from ArrayBuffer --- */
  function loadGLB(buffer, fileName){
    state.rawBuffer = buffer;
    state.fileName = fileName;

    var loader = new THREE.GLTFLoader();
    loader.parse(buffer, '', function(gltf){
      if(state.model){
        state.scene.remove(state.model);
        state.model.traverse(function(o){
          if(o.geometry) o.geometry.dispose();
          if(o.material){
            if(Array.isArray(o.material)) o.material.forEach(function(m){ m.dispose(); });
            else o.material.dispose();
          }
        });
      }

      var grp = gltf.scene;
      grp.traverse(function(o){
        if(o.isMesh){
          o.castShadow = true;
          o.receiveShadow = true;
          var m = o.material.clone();
          if(!m.isMeshToonMaterial){
            var opts = { color: m.color };
            if(m.map) opts.map = m.map;
            if(m.transparent) opts.transparent = true;
            if(m.opacity !== undefined) opts.opacity = m.opacity;
            if(m.side) opts.side = m.side;
            if(m.alphaTest) opts.alphaTest = m.alphaTest;
            m = Toon.mat(opts);
          }
          o.material = m;
        }
      });

      state.scene.add(grp);
      state.model = grp;

      fitCamera(grp);
      countTriangles(grp);

      var spawns = detectSpawns(gltf.scene);
      renderSpawnMarkers(spawns);
      updateSpawnList();

      var bushes = detectBushes(gltf.scene);
      storeBushRefs(bushes);
      updateBushList();

      var nameEl = $id('mi-map-name');
      if(nameEl) nameEl.textContent = fileName;

      toast('Map loaded: ' + fileName + ' (' + state.triangleCount.toLocaleString() + ' triangles)');
    }, undefined, function(err){
      toast('Failed to load GLB: ' + (err.message || err));
    });
  }

  /* --- Render --- */
  function render(){
    Editor123._mode = 'mapimporter';
    var c = document.getElementById('editor123-content');

    var timeButtons = '';
    ['day','morning','evening','night'].forEach(function(t){
      var icons = { day:'\u2600\uFE0F', morning:'\uD83C\uDF05', evening:'\uD83C\uDF06', night:'\uD83C\uDF19' };
      timeButtons += '<div class="mi-time-btn" data-time="' + t + '" style="padding:6px 10px;background:rgba(255,255,255,0.04);border:1px solid #2a3050;border-radius:6px;cursor:pointer;color:#8890a8;font-size:12px;text-align:center;transition:.15s">' + icons[t] + ' ' + t.charAt(0).toUpperCase() + t.slice(1) + '</div>';
    });

    c.innerHTML =
      '<div style="width:260px;min-width:260px;background:#1a1e24;display:flex;flex-direction:column;border-right:1px solid #252a32;overflow-y:auto;padding:16px">' +

        '<div id="mi-back" style="color:#ff8800;font-size:11px;font-weight:600;letter-spacing:0.5px;cursor:pointer;margin-bottom:16px;text-shadow:0 0 8px rgba(255,136,0,0.3)">\u2190 BACK</div>' +
        '<h3 style="color:#ffb12b;margin:0 0 16px;font-size:16px;letter-spacing:1px">MAP IMPORTER</h3>' +

        '<div id="mi-import-btn" style="padding:12px;background:linear-gradient(135deg,#2a3050,#1e2440);border:1px dashed #ff8800;border-radius:10px;cursor:pointer;text-align:center;color:#ff8800;font-size:13px;font-weight:600;transition:.15s;margin-bottom:16px">\uD83D\uDCC2 Import GLB</div>' +
        '<input type="file" id="mi-file-input" accept=".glb,.gltf" style="display:none">' +

        '<div style="border-top:1px solid #252a32;padding-top:14px;margin-bottom:14px">' +
          '<div style="color:#6a7088;font-size:10px;font-weight:700;letter-spacing:1.5px;margin-bottom:10px">MAP INFO</div>' +
          '<div style="color:#c0c8d8;font-size:12px">Name: <span id="mi-map-name" style="color:#ff8800">\u2014</span></div>' +
          '<div style="color:#c0c8d8;font-size:12px;margin-top:4px">Triangles: <span id="mi-tri-count" style="color:#ff8800">0</span></div>' +
          '<div style="color:#c0c8d8;font-size:12px;margin-top:4px">Vertices: <span id="mi-vert-count" style="color:#ff8800">0</span></div>' +
        '</div>' +

        '<div style="border-top:1px solid #252a32;padding-top:14px;margin-bottom:14px">' +
          '<div style="color:#6a7088;font-size:10px;font-weight:700;letter-spacing:1.5px;margin-bottom:6px">SPAWN POINTS</div>' +
          '<div id="mi-spawn-list" style="font-size:12px;color:#556;font-style:italic">Import a map to detect spawns</div>' +
        '</div>' +

        '<div style="border-top:1px solid #252a32;padding-top:14px;margin-bottom:14px">' +
          '<div style="color:#6a7088;font-size:10px;font-weight:700;letter-spacing:1.5px;margin-bottom:6px">BUSHES</div>' +
          '<div id="mi-bush-list" style="font-size:12px;color:#556;font-style:italic">Import a map to detect bushes</div>' +
          '<div id="mi-flip-btn" style="display:none;margin-top:8px;padding:8px;background:rgba(255,255,255,0.04);border:1px solid #2a3050;border-radius:6px;cursor:pointer;color:#8890a8;font-size:11px;text-align:center;transition:.15s">\u21C4 Flip Bushes</div>' +
        '</div>' +

        '<div style="border-top:1px solid #252a32;padding-top:14px;margin-bottom:14px">' +
          '<div style="color:#6a7088;font-size:10px;font-weight:700;letter-spacing:1.5px;margin-bottom:10px">LIGHTING</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">' + timeButtons + '</div>' +
        '</div>' +

        '<div style="border-top:1px solid #252a32;padding-top:14px;margin-bottom:14px">' +
          '<div style="color:#6a7088;font-size:10px;font-weight:700;letter-spacing:1.5px;margin-bottom:10px">VIEW</div>' +
          '<div style="display:flex;gap:8px">' +
            '<div id="mi-wireframe-btn" style="flex:1;padding:8px;background:rgba(255,255,255,0.04);border:1px solid #2a3050;border-radius:6px;cursor:pointer;color:#8890a8;font-size:11px;text-align:center;transition:.15s">\uD83D\uDD32 Wireframe</div>' +
            '<div id="mi-grid-btn" style="flex:1;padding:8px;background:rgba(255,255,255,0.04);border:1px solid #2a3050;border-radius:6px;cursor:pointer;color:#ff8800;font-size:11px;text-align:center;transition:.15s">\u25A6 Grid</div>' +
          '</div>' +
        '</div>' +

        '<div style="border-top:1px solid #252a32;padding-top:14px;margin-bottom:14px">' +
          '<div id="mi-publish-btn" style="padding:12px;background:linear-gradient(135deg,#2a5a2a,#1e4a1e);border:1px solid #3a7a3a;border-radius:10px;cursor:pointer;text-align:center;color:#88ff88;font-size:13px;font-weight:700;transition:.15s">\uD83D\uDE80 PUBLISH</div>' +
        '</div>' +

      '</div>' +

      '<div style="flex:1;display:flex;flex-direction:column">' +
        '<div id="mi-view" style="flex:1;position:relative;overflow:hidden;background:#111;min-height:300px"></div>' +
      '</div>';

    /* Wire events */
    document.getElementById('mi-back').onclick = function(){
      dispose();
      Editor123._renderLauncher();
    };

    var fileInput = $id('mi-file-input');
    $id('mi-import-btn').onclick = function(){ fileInput.click(); };
    fileInput.onchange = function(e){
      var file = e.target.files[0];
      if(!file) return;
      var reader = new FileReader();
      reader.onload = function(ev){
        loadGLB(ev.target.result, file.name);
      };
      reader.readAsArrayBuffer(file);
    };

    document.querySelectorAll('.mi-time-btn').forEach(function(btn){
      btn.onmouseover = function(){ this.style.borderColor = '#ff8800'; };
      btn.onmouseout = function(){
        if(this.dataset.time !== state.currentLighting) this.style.borderColor = '#2a3050';
      };
      btn.onclick = function(){ applyLighting(this.dataset.time); };
    });

    $id('mi-wireframe-btn').onclick = toggleWireframe;
    $id('mi-grid-btn').onclick = toggleGrid;
    $id('mi-publish-btn').onclick = publishCode;

    var flipBtn = $id('mi-flip-btn');
    if(flipBtn) flipBtn.onclick = function(){
      if(!state.bushes) return;
      state.bushes.forEach(function(b){ b.flipped = !b.flipped; });
      this.style.color = state.bushes[0] && state.bushes[0].flipped ? '#ff8800' : '#8890a8';
    };

    initViewport();
  }

  function initViewport(){
    var host = $id('mi-view');
    if(!host) return;

    var W = host.clientWidth || 800;
    var H = host.clientHeight || 500;

    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x7ab8e0);

    state.camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 500);
    state.camera.position.set(25, 20, 25);

    state.renderer = new THREE.WebGLRenderer({ antialias: true });
    state.renderer.setSize(W, H);
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(state.renderer.domElement);

    state.controls = new THREE.OrbitControls(state.camera, state.renderer.domElement);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.12;
    state.controls.maxPolarAngle = Math.PI / 2.1;
    state.controls.minDistance = 2;
    state.controls.maxDistance = 200;

    state.lights.hemi = new THREE.HemisphereLight(0x87ceeb, 0x5a3a2a, 0.9);
    state.scene.add(state.lights.hemi);

    state.lights.sun = new THREE.DirectionalLight(0xffdd99, 1.4);
    state.lights.sun.position.set(25, 35, 20);
    state.lights.sun.castShadow = true;
    state.lights.sun.shadow.mapSize.set(1024, 1024);
    state.scene.add(state.lights.sun);

    state.lights.amb = new THREE.AmbientLight(0x666688, 0.35);
    state.scene.add(state.lights.amb);

    state.grid = new THREE.GridHelper(80, 40, 0x88bb88, 0x558855);
    state.grid.position.y = 0.01;
    state.scene.add(state.grid);

    var ro = function(){
      var w2 = host.clientWidth || W;
      var h2 = host.clientHeight || H;
      state.camera.aspect = w2 / h2;
      state.camera.updateProjectionMatrix();
      state.renderer.setSize(w2, h2);
    };
    window.addEventListener('resize', ro);
    state._resizeHandler = ro;

    state.running = true;
    (function loop(){
      if(!state.running) return;
      state.raf = requestAnimationFrame(loop);
      state.controls.update();
      // Billboard bushes toward camera (stand vertical, rotate like turret)
      if(state.bushes && state.camera){
        var camPos = state.camera.position;
        for(var i = 0; i < state.bushes.length; i++){
          var b = state.bushes[i];
          if(!b.obj) continue;
          var wp = new THREE.Vector3();
          b.obj.getWorldPosition(wp);
          var dx = camPos.x - wp.x;
          var dy = camPos.y - wp.y;
          var dz = camPos.z - wp.z;
          var hAngle = Math.atan2(dx, dz);
          var flip = b.flipped ? Math.PI : 0;
          var tiltUp = 0;
          if(dy > 0){
            var hDist = Math.sqrt(dx*dx + dz*dz);
            var vAngle = Math.atan2(dy, hDist);
            tiltUp = Math.min(vAngle, 10 * Math.PI / 180);
          }
          b.obj.rotation.order = 'YXZ';
          b.obj.rotation.set(0, 0, 0);
          b.obj.rotation.y = hAngle + flip;
          b.obj.rotation.x = -Math.PI / 2 + tiltUp;
        }
      }
      state.renderer.render(state.scene, state.camera);
    })();
  }

  /* --- Publish --- */
  function publishCode(){
    if(!state.fileName){
      toast('Import a map first!');
      return;
    }
    var spawns = state.spawns.map(function(s){
      return { name: s.name, x: Math.round(s.pos.x * 100) / 100, y: Math.round(s.pos.y * 100) / 100, z: Math.round(s.pos.z * 100) / 100, team: s.team };
    });
    var config = {
      name: state.fileName.replace(/\.(glb|gltf)$/i, ''),
      file: state.fileName,
      lighting: state.currentLighting,
      spawns: spawns,
      triangles: state.triangleCount,
      vertices: state.vertexCount
    };
    var code = btoa(JSON.stringify(config));
    navigator.clipboard.writeText(code).then(function(){
      toast('Map code copied to clipboard \u2014 send it to apply!');
    }).catch(function(){
      var ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Map code copied to clipboard!');
    });
  }

  /* --- Cleanup --- */
  function dispose(){
    state.running = false;
    if(state.raf) cancelAnimationFrame(state.raf);
    if(state._resizeHandler) window.removeEventListener('resize', state._resizeHandler);
    if(state.renderer){
      state.renderer.dispose();
      var host = $id('mi-view');
      if(host && state.renderer.domElement && state.renderer.domElement.parentNode === host){
        host.removeChild(state.renderer.domElement);
      }
    }
    if(state.controls) state.controls.dispose();
    state.spawns.forEach(function(s){
      if(s.mesh){
        if(s.mesh.geometry) s.mesh.geometry.dispose();
        if(s.mesh.material) s.mesh.material.dispose();
      }
      if(s.ring){
        if(s.ring.geometry) s.ring.geometry.dispose();
        if(s.ring.material) s.ring.material.dispose();
      }
    });
    state.scene = null;
    state.camera = null;
    state.renderer = null;
    state.controls = null;
    state.model = null;
    state.spawns = [];
    state.lights = {};
    state.rawBuffer = null;
    state.fileName = '';
    state.triangleCount = 0;
    state.vertexCount = 0;
    state.wireframeOn = false;
    state.gridOn = true;
  }

  return { render: render, dispose: dispose };
})();
