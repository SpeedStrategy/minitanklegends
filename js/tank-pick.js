/* ============================================================
   tank-pick.js — the pre-battle screens.

   TankPick.open(game)   tank choosing: a big model you can drag to spin, a strip
                         of real model thumbnails you can drag to scroll, and
                         your team's current picks, live.
   TankPick.showVs(game) the animated VS card: enemy team, VS, your team.

   Everything shares ONE WebGL context (phones run out of them quickly): the
   visible preview canvas IS the renderer's canvas, and thumbnails are rendered
   on it one at a time, read back to images and cached.
   ============================================================ */
window.TankPick = (function(){
  'use strict';

  var R = null, _scene = null, _cam = null;
  var _thumbs = {};           /* id -> data URL */
  var _queue = Promise.resolve();
  var _game = null, _panel = null;
  var _shown = null, _model = null, _yaw = 0.6, _dragging = false, _lastSpin = 0;
  var _raf = 0, _rosterHash = '', _token = 0;

  function ensureRenderer(){
    if(R) return R;
    R = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    R.setPixelRatio(1);
    R.setClearColor(0x000000, 0);
    _scene = new THREE.Scene();
    _scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    var sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(4, 8, 6);
    _scene.add(sun);
    _cam = new THREE.PerspectiveCamera(32, 1.33, 0.1, 200);
    _cam.position.set(0, 4.6, 9.5);
    _cam.lookAt(0, 0, 0);
    return R;
  }

  /* The tank as a group: nose toward +Z, longest side 4.4 units, centred. */
  function buildModel(id){
    var def = TANKS[id];
    var fit = function(grp){
      var holder = new THREE.Group();
      var scale = (def.modelScale || 1) * 2;
      grp.scale.setScalar(scale);
      if(def.modelYaw != null) grp.rotation.y = def.modelYaw * Math.PI / 180;
      if(def.modelFlipY) grp.rotation.y += Math.PI;
      var box = new THREE.Box3().setFromObject(grp);
      var size = box.getSize(new THREE.Vector3());
      var foot = Math.max(size.x, size.z);
      if(foot > 0.001){ grp.scale.multiplyScalar(4.4 / foot); box = new THREE.Box3().setFromObject(grp); }
      var c = box.getCenter(new THREE.Vector3());
      grp.position.sub(c);
      holder.add(grp);
      return holder;
    };
    var fallback = function(){
      var g = new THREE.Group();
      var body = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 4.4), new THREE.MeshLambertMaterial({ color: def.color || 0x888888 }));
      var tur = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 2), new THREE.MeshLambertMaterial({ color: def.turretColor || 0xaaaaaa }));
      tur.position.y = 0.9;
      g.add(body); g.add(tur);
      return fit(g);
    };
    if(def.model && window.Models && Models.hasModel(def.model)){
      return Promise.resolve(Models.load(def.model)).then(function(g){ return g ? fit(g) : fallback(); }).catch(fallback);
    }
    return Promise.resolve(fallback());
  }

  function thumb(id){
    if(_thumbs[id]) return Promise.resolve(_thumbs[id]);
    var job = _queue.then(function(){
      if(_thumbs[id]) return _thumbs[id];
      return buildModel(id).then(function(m){
        ensureRenderer();
        var w = R.domElement.width, h = R.domElement.height;
        var hide = _model; if(hide) hide.visible = false;
        m.rotation.y = 0.6;
        _scene.add(m);
        R.setSize(220, 165, false);
        _cam.aspect = 220 / 165; _cam.updateProjectionMatrix();
        R.render(_scene, _cam);
        var url = R.domElement.toDataURL('image/png');
        _scene.remove(m);
        if(hide) hide.visible = true;
        if(w && h && _panel){ R.setSize(w, h, false); _cam.aspect = w / h; _cam.updateProjectionMatrix(); }
        _thumbs[id] = url;
        return url;
      });
    }).catch(function(){ return ''; });
    _queue = job;
    return job;
  }

  function pickableIds(){
    return TANK_ORDER.filter(function(id){ return id !== 'tankdisplay' && id !== 'dummy' && TANKS[id]; });
  }

  function esc(v){ return String(v == null ? '' : v).replace(/[&<>"]/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]; }); }

  /* ------------------------------------------------------------ the screen */
  function bars(def){
    var all = pickableIds().map(function(i){ return TANKS[i]; });
    var maxOf = function(k){ return Math.max.apply(null, all.map(function(d){ return d[k] || 0; })) || 1; };
    var dmg = function(d){ return Math.max(d.damage || 0, d.splashDamage || 0, d.mineDamage || 0); };
    var maxDmg = Math.max.apply(null, all.map(dmg)) || 1;
    var rows = [['HP', (def.hp || 0) / maxOf('hp')], ['SPEED', (def.speed || 0) / maxOf('speed')], ['DAMAGE', dmg(def) / maxDmg]];
    return rows.map(function(r){
      return '<div class="tkp-bar"><span>' + r[0] + '</span><i><b style="width:' + Math.round(Math.max(0.04, r[1]) * 100) + '%"></b></i></div>';
    }).join('');
  }

  function setPreview(id){
    if(_shown === id) return;
    _shown = id;
    var my = ++_token;
    var def = TANKS[id];
    var name = _panel && _panel.querySelector('.tkp-name');
    if(name) name.textContent = def.name;
    var info = _panel && _panel.querySelector('.tkp-bars');
    if(info) info.innerHTML = bars(def);
    var desc = _panel && _panel.querySelector('.tkp-desc');
    if(desc) desc.textContent = def.desc || '';
    var sup = _panel && _panel.querySelector('.tkp-super');
    var si = typeof SUPER_INFO !== 'undefined' && SUPER_INFO[def.superType];
    if(sup) sup.innerHTML = si ? '<b>' + si.icon + ' ' + esc(si.name) + '</b>' + esc(si.desc) : '';
    _queue = _queue.then(function(){
      return buildModel(id).then(function(m){
        if(my !== _token || !_scene) return;
        if(_model) _scene.remove(_model);
        _model = m;
        _scene.add(m);
      });
    }).catch(function(){});
  }

  function renderRoster(){
    if(!_panel || !_game) return;
    var me = _game.localTank;
    var mates = (_game.tanks || []).filter(function(t){ return t && !t.isDummy && !t.isPanzer && me && t.team === me.team; });
    mates.sort(function(a, b){ return (a === me ? -1 : 0) - (b === me ? -1 : 0); });
    var hash = mates.map(function(t){ return t.name + ':' + t.def.id; }).join('|');
    if(hash === _rosterHash) return;
    _rosterHash = hash;
    var box = _panel.querySelector('.tkp-team-list');
    if(!box) return;
    box.innerHTML = mates.map(function(t){
      return '<div class="tkp-mate' + (t === me ? ' me' : '') + '" data-tank="' + t.def.id + '">' +
        '<img alt="">' +
        '<div><b>' + esc(t === me ? 'YOU' : t.name) + '</b><span>' + esc(t.def.name) + '</span></div></div>';
    }).join('');
    box.querySelectorAll('.tkp-mate').forEach(function(el){
      var img = el.querySelector('img'), id = el.dataset.tank;
      thumb(id).then(function(u){ if(u) img.src = u; });
    });
  }

  function renderStrip(){
    var strip = _panel.querySelector('.tkp-strip');
    var cur = _game.localTank ? _game.localTank.def.id : null;
    var favs = _game._tankFavorites || [];
    var ids = pickableIds().sort(function(a, b){ return (favs.indexOf(a) >= 0 ? 0 : 1) - (favs.indexOf(b) >= 0 ? 0 : 1); });
    var keep = strip.scrollLeft;
    strip.innerHTML = ids.map(function(id){
      return '<div class="tkp-card' + (id === cur ? ' on' : '') + '" data-id="' + id + '">' +
        '<span class="tkp-star' + (favs.indexOf(id) >= 0 ? ' on' : '') + '" data-star="' + id + '">★</span>' +
        '<img alt="" draggable="false"><em>' + esc(TANKS[id].name) + '</em></div>';
    }).join('');
    strip.scrollLeft = keep;
    strip.querySelectorAll('.tkp-card').forEach(function(card){
      var img = card.querySelector('img');
      thumb(card.dataset.id).then(function(u){ if(u) img.src = u; });
    });
  }

  /* Drag anywhere on the strip to scroll it. A press that did not travel is a
     click, and only that picks a tank. */
  function wireStrip(strip){
    var down = false, startX = 0, startScroll = 0, moved = 0;
    strip.addEventListener('pointerdown', function(e){
      down = true; moved = 0; startX = e.clientX; startScroll = strip.scrollLeft;
      strip.classList.add('dragging');
    });
    window.addEventListener('pointermove', function(e){
      if(!down) return;
      var dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      strip.scrollLeft = startScroll - dx;
    });
    window.addEventListener('pointerup', function(e){
      if(!down) return;
      down = false;
      strip.classList.remove('dragging');
      if(moved > 8 || !_game) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if(!el) return;
      var star = el.closest('[data-star]');
      if(star){ _game._toggleTankFavorite(star.dataset.star); return; }
      var card = el.closest('.tkp-card');
      if(card){ _game._switchLocalTank(card.dataset.id); setPreview(card.dataset.id); }
    });
  }

  function wirePreview(wrap){
    var last = null;
    wrap.addEventListener('pointerdown', function(e){ _dragging = true; last = e.clientX; try { wrap.setPointerCapture(e.pointerId); } catch(err){} });
    wrap.addEventListener('pointermove', function(e){
      if(!_dragging) return;
      _yaw += (e.clientX - last) * 0.012;
      last = e.clientX;
      _lastSpin = performance.now();
    });
    var up = function(){ _dragging = false; };
    wrap.addEventListener('pointerup', up);
    wrap.addEventListener('pointercancel', up);
  }

  function sizePreview(){
    var wrap = _panel && _panel.querySelector('.tkp-stage');
    if(!wrap || !R) return;
    var w = Math.max(10, wrap.clientWidth), h = Math.max(10, wrap.clientHeight);
    if(R.domElement.width !== w || R.domElement.height !== h){
      R.setSize(w, h, false);
      _cam.aspect = w / h; _cam.updateProjectionMatrix();
    }
  }

  function loop(){
    if(!_panel || _panel.classList.contains('hidden')){ _raf = 0; document.body.classList.remove('tkp-open'); return; }
    _raf = requestAnimationFrame(loop);
    if(!_model || !R) return;
    sizePreview();
    /* Spins by itself until you touch it, and again a few seconds later. */
    if(!_dragging && performance.now() - _lastSpin > 2500) _yaw += 0.008;
    _model.rotation.y = _yaw;
    R.render(_scene, _cam);
  }

  function open(game){
    _game = game;
    _panel = document.getElementById('tank-switch-panel');
    if(!_panel) return;
    if(!_panel.querySelector('.tkp-stage')){
      _panel.innerHTML =
        '<div class="tkp-team"><div class="tkp-head">YOUR TEAM</div><div class="tkp-team-list"></div></div>' +
        '<div class="tkp-main">' +
          '<div class="tkp-stage" title="Drag to spin"></div>' +
          '<div class="tkp-info"><div class="tkp-name"></div><div class="tkp-desc"></div><div class="tkp-bars"></div><div class="tkp-super"></div></div>' +
        '</div>' +
        '<div class="tkp-strip"></div>';
      ensureRenderer();
      var stage = _panel.querySelector('.tkp-stage');
      stage.appendChild(R.domElement);
      wirePreview(stage);
      wireStrip(_panel.querySelector('.tkp-strip'));
    } else {
      ensureRenderer();
    }
    _panel.classList.remove('hidden');
    document.body.classList.add('tkp-open');
    _rosterHash = '';
    renderStrip();
    renderRoster();
    setPreview(game.localTank ? game.localTank.def.id : pickableIds()[0]);
    if(!_raf) _raf = requestAnimationFrame(loop);
  }

  /* -------------------------------------------------------------- VS card */
  function powerOf(t, game){
    if(t === game.localTank && window.Progression){
      try { return Progression.xpProgress(t.def.id).level; } catch(e){}
    }
    var h = 0, s = String(t.name || '');
    for(var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
    return (t.def.tier || 1) * 2 + (h % 6);
  }

  function vsCard(t, game, i, side){
    var me = t === game.localTank;
    return '<div class="vs-card ' + side + (me ? ' me' : '') + '" style="--i:' + i + '" data-tank="' + t.def.id + '">' +
      (me ? '<div class="vs-you">YOU</div>' : '') +
      '<img alt="">' +
      '<div class="vs-tank">' + esc(t.def.name) + '</div>' +
      '<div class="vs-player">' + esc(me ? (t.name || 'You') : t.name) + '</div>' +
      '<div class="vs-power">POWER <b>' + powerOf(t, game) + '</b></div>' +
    '</div>';
  }

  function showVs(game){
    hideVs();
    var me = game.localTank;
    if(!me) return;
    var list = (game.tanks || []).filter(function(t){ return t && !t.isDummy && !t.isPanzer; });
    var mine = list.filter(function(t){ return t.team === me.team; });
    var foes = list.filter(function(t){ return t.team !== me.team; });
    mine.sort(function(a, b){ return (a === me ? -1 : 0) - (b === me ? -1 : 0); });
    var el = document.createElement('div');
    el.id = 'vs-intro';
    el.innerHTML =
      '<div class="vs-row foes">' + foes.map(function(t, i){ return vsCard(t, game, i, 'foe'); }).join('') + '</div>' +
      '<div class="vs-mid"><span>VS</span></div>' +
      '<div class="vs-row mine">' + mine.map(function(t, i){ return vsCard(t, game, i, 'mate'); }).join('') + '</div>';
    document.body.appendChild(el);
    el.querySelectorAll('.vs-card').forEach(function(c){
      var img = c.querySelector('img');
      thumb(c.dataset.tank).then(function(u){ if(u) img.src = u; });
    });
  }

  function hideVs(){
    var el = document.getElementById('vs-intro');
    if(el && el.parentNode) el.parentNode.removeChild(el);
  }

  return { open: open, refreshTeam: renderRoster, showVs: showVs, hideVs: hideVs, thumb: thumb };
})();
