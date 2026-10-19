/* ============================================================
   tank-editor.js — Tank Editor (Editor123 suite)

   Edit a tank's collision hitbox (front/sides/height), turret
   rotation pivot and shell/muzzle spawn point with a LIVE three.js
   TransformControls gizmo. Values are saved per tank id to
   localStorage (tankparty_tankeditor) and pushed to the shared API
   so every game client applies the same settings; tank.js reads them
   at spawn time via window.TANK_EDITOR_OVERRIDES.

   UX: drag the gizmo arrows to edit (never moves the camera). The
   top-right orientation widget + the bottom axis bar snap the camera
   to Side X / Top Y / Front Z / Perspective views. Ctrl+Z / Ctrl+Y
   undo/redo, Ctrl+S saves for all clients.
   ============================================================ */

window.TankEditor = (function(){

  var LS_KEY = 'tankparty_tankeditor';

  function loadOverrides(){
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null') || {}; } catch(e){ return {}; }
  }
  function saveOverrides(){
    try { localStorage.setItem(LS_KEY, JSON.stringify(window.TANK_EDITOR_OVERRIDES)); } catch(e){}
  }
  window.TANK_EDITOR_OVERRIDES = loadOverrides();

  var state = {
    selected: 'coolbuddy',
    /* Opens on Facing rather than Hitbox. Orientation is the thing that cannot
       be worked out by eye afterwards and the thing that goes wrong most often,
       so it is the one worth putting in front of the user; everything else on
       this screen is reachable in one click. */
    mode: 'facing',
    scene: null, renderer: null, camera: null, controls: null, gizmo: null, gizmoHelper: null,
    tank: null, bodyBox: null, boxWire: null, pivotMarker: null, turretMarker: null, shellMarker: null, casingMarker: null, tankCenterMarker: null, modelMarker: null,
    /* forwardArrow: the big gold arrow that shows which way the tank will
       actually DRIVE once the orientation is applied. It is the whole point of
       the Facing mode — see _rebuildForwardArrow. */
    forwardArrow: null, arrowGroup: null,
    /* faceMarks: the red patch painted on the face the user last clicked, per
       slot. Kept separately per slot so a FRONT picked from the nose and an UP
       picked from the deck are both still shown after the second click, rather
       than one overwriting the other. Each entry is { p: Vector3, q: Quaternion }
       in the ORIENTATION GROUP's local space — the frame the GLB was authored
       in — so the patch rides with the model when the correction rotates it and
       stays on the same physical face. See _rebuildFaceMarks. */
    faceMarks: { front: null, up: null },
    markGroup: null, _markSig: null,
    /* pickArm: 'front' | 'up' — which slot the next click on the model fills.
       FRONT is the default: a click on the model reliably says which END you
       pointed at, which is the thing nobody can guess. See pickFromPointer. */
    pickArm: 'front',
    /* stats: the measured report — see measureStats. */
    stats: null,
    /* imported: a GLB loaded from disk, kept as its own pseudo-tank so a model
       that is not in config.js yet can be set up and copied out. */
    imported: null,
    values: {
      body:{w:3,h:1,l:4.4}, pivot:{x:0,y:0,z:0}, turret:{x:0,y:0,z:0},
      shell:{x:0,y:0,z:0}, casing:{x:0,y:0,z:0},
      model:{x:0,y:0,z:0,yaw:0,anim:true,outline:true,front:'',up:''},
      /* tracks carries the RUNNING GEAR, not a transform. It is held here rather
         than read straight from the override because the panel edits it like
         everything else and the export has to include it — see buildSetupJSON,
         which would otherwise drop the lot on the floor. */
      tracks:{},
    },
    raf: 0, running: false, resizeHandler: null, keyHandler: null,
    axesCanvas: null,
    spinTurret: false,
    history: [], historyIdx: -1,
    /* dirty: per-tank snapshot of what THIS session changed, so the shared
       sync can bring in other tanks without reverting them. See setOv. */
    dirty: {},
    /* tracksTouched: per tank, which running-gear keys the player actually
       moved.

       The Tracks panel shows RESOLVED numbers — a tank with no tracks block
       still displays the tread width its body implies, rather than a blank —
       which is the right thing to show and the wrong thing to export. Writing
       all ten resolved values out would pin every derived dimension to today's
       body size, so changing the hull afterwards would no longer grow the
       treads. Only what was deliberately touched is allowed out. */
    tracksTouched: {},
    /* loadedModelScale: the modelScale the current preview tank was actually
       BUILT at. The orientation group's scale is relative to it, and every
       resize — typed, scrubbed, gizmo or Match-hitbox — is computed as a ratio
       against it. See applyLiveModelScale. */
    loadedModelScale: 1,
    onDispose: null,
  };
  var dragged = false;

  function round(v){ return Math.round(v * 1000) / 1000; }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  function $id(id){ return document.getElementById(id); }

  function toast(msg){
    var el = $id('te-toast');
    if(el){
      el.textContent = msg;
      el.classList.add('te-show');
      clearTimeout(el._t);
      el._t = setTimeout(function(){ el.classList.remove('te-show'); }, 3200);
      return;
    }
    if(window.Menu && typeof Menu.toast === 'function'){ Menu.toast(msg); return; }
    if(window.Editor123 && typeof Editor123.toast === 'function'){ Editor123.toast(msg); return; }
    console.log('[TankEditor]', msg);
  }

  /* ------------------------------------------------------------
     Shared overrides (all game clients)
     The save button pushes the override map to the clan API worker;
     every client fetches it at boot and when the editor opens, so a
     tank's hitbox/pivot/spawn behave identically for everyone.
     ------------------------------------------------------------ */
  function apiBase(){
    return (typeof CONFIG !== 'undefined' && CONFIG.CLAN_API_URL) ? CONFIG.CLAN_API_URL : '';
  }

  function syncRemoteOverrides(){
    var base = apiBase();
    if(!base) return Promise.resolve();
    return fetch(base + '/tankoverrides')
      .then(function(r){ return r.ok ? r.json() : null; })
      .catch(function(){ return null; })
      .then(function(data){
        if(!data || !data.overrides) return;
        /* MERGED, NOT REPLACED.

           The server is the source of truth for other players' tanks, and this
           is how they arrive — but assigning its response over the map threw
           away everything edited locally in the meantime, including changes
           made seconds earlier in this same session. So the remote copy is
           taken as the base and the local edits are laid back on top, which
           gives both: shared settings still arrive, local work still survives.

           Tanks the server has never heard of are kept too. */
        var merged = Object.assign({}, data.overrides || {});
        var local = window.TANK_EDITOR_OVERRIDES || {};
        Object.keys(local).forEach(function(id){
          /* A tank edited here wins over the server's copy of the same tank. */
          merged[id] = Object.assign({}, merged[id] || {}, state.dirty[id] || local[id]);
        });
        window.TANK_EDITOR_OVERRIDES = merged;
        saveOverrides();
      });
  }

  function pushRemoteOverrides(){
    var base = apiBase();
    if(!base) return Promise.resolve(false);
    return fetch(base + '/tankoverrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: window.TANK_EDITOR_OVERRIDES || {}, savedAt: Date.now() })
    }).then(function(r){ return r.ok; }).catch(function(){ return false; });
  }

  // Callable from the game boot so in-match tanks get shared values
  function syncGlobal(){
    return syncRemoteOverrides();
  }

  /* ------------------------------------------------------------
     Override store
     ------------------------------------------------------------ */
  function ovFor(id){
    return (window.TANK_EDITOR_OVERRIDES && window.TANK_EDITOR_OVERRIDES[id]) || null;
  }
  function setOv(id, patch){
    if(!window.TANK_EDITOR_OVERRIDES) window.TANK_EDITOR_OVERRIDES = {};
    var cur = window.TANK_EDITOR_OVERRIDES[id] || {};
    window.TANK_EDITOR_OVERRIDES[id] = Object.assign(cur, patch);
    saveOverrides();
    /* Remember exactly what was set here, and when.

       This exists because of a bug that made the editor look broken: scale a
       model, watch it change, and a second later it snaps back to the old size.
       Nothing local had done that. syncRemoteOverrides fetches the shared
       settings from the API and ASSIGNED the result over the whole map, so a
       remote response that arrived after the edit — which it always did,
       because the fetch to an unreachable worker takes seconds to fail —
       silently discarded it. On a fast connection it was a race you might win;
       offline it was a race you always lost, and rescale "did not work" with
       no error anywhere.

       Recording local edits means the remote sync can still bring in other
       players' tanks without being able to undo this session's work. */
    state.dirty[id] = JSON.parse(JSON.stringify(window.TANK_EDITOR_OVERRIDES[id]));
  }
  function clearOv(id){
    if(window.TANK_EDITOR_OVERRIDES) delete window.TANK_EDITOR_OVERRIDES[id];
    saveOverrides();
  }

  /* Paste a tank code that was copied from the Save button.
     The Save button copies btoa(JSON.stringify({ tank: id, data: patch })),
     where patch is the same shape setOv() writes (body, pivot, turret, shell,
     casing, model, tracks). Decode it, apply it to the selected tank's override
     slot, and rebuild so the preview matches — the same path the game uses
     (TANK_EDITOR_OVERRIDES -> _applyEditorOverrides).

     Also accepts the raw setup JSON (the thing the 'Copy setup (JSON)' button
     emits) as a fallback, applying the part-position keys it contains as
     overrides so the config.js paste path can round-trip too. */
  function pasteTankCode(){
    var id = state.selected;
    var raw = '';
    if(navigator.clipboard && navigator.clipboard.readText){
      raw = navigator.clipboard.readText().catch(function(){ return ''; }) || '';
    }
    if(!raw){
      toast('Nothing in the clipboard to paste.');
      return;
    }
    var patched = false;
    try {
      var bin = atob(raw);
      var blob = JSON.parse(bin);
      if(blob && blob.tank && blob.data && typeof blob.data === 'object'){
        setOv(blob.tank, blob.data);
        if(blob.tank !== id) pickTank(blob.tank);
        else {
          if(state.tank && state.tank._applyEditorOverrides) state.tank._applyEditorOverrides();
          if(state.tank) applyValuesToScene();
          rebuildTracksPreview();
        }
        pushHistory();
        toast('Tank code applied to "' + (blob.tank || id) + '".');
        patched = true;
      }
    } catch(e){ /* not a btoa blob — fall through to the JSON fallback */ }
    if(!patched){
      try {
        var json = JSON.parse(raw);
        if(json && typeof json === 'object' && (json.pivot || json.turret || json.firePoint || json.casingPoint || json.body || json.model)){
          var tgt = json.id || id;
          var ov = {};
          if(json.pivot)        ov.pivot  = json.pivot;
          if(json.turret)       ov.turret = json.turret;
          if(json.firePoint)    ov.shell  = json.firePoint;
          if(json.casingPoint)  ov.casing = json.casingPoint;
          if(json.body)         ov.body   = json.body;
          if(json.model)        ov.model  = json.model;
          setOv(tgt, ov);
          if(tgt !== id) pickTank(tgt);
          else {
            if(state.tank && state.tank._applyEditorOverrides) state.tank._applyEditorOverrides();
            if(state.tank) applyValuesToScene();
            rebuildTracksPreview();
          }
          pushHistory();
          toast('Setup JSON applied to "' + tgt + '".');
          patched = true;
        }
      } catch(e){ /* not a setup JSON either */ }
    }
    if(!patched){
      toast('Could not read that as a tank code or setup JSON.');
    }
  }

  /* ------------------------------------------------------------
     Main entry (called from Editor123 launcher)
     ------------------------------------------------------------ */
  function render(){
    Editor123._mode = 'tank';
    var c = document.getElementById('editor123-content');
    if(!c) return;

    /* ============================================================
     THE SHELL

     A professional tool has a fixed frame and one moving part. The frame
     is the header (what tank, what file, the two destructive-adjacent
     actions), the rail (what part of the tank), the inspector (the values
     for that part), the status bar (is this thing finished), and the
     viewport in the middle. Nothing scrolls that does not have to, and the
     status never scrolls away, because "is it set up" is the one question
     that has to be answerable without moving the mouse.

     The rail groups the nine modes under the four things they actually
     act on. They were a flat list of nine before, which is a list of
     buttons rather than a structure: nothing said that the hitbox and the
     turret mount are both about the hull, or that the two shell points
     belong together, so every one of them had to be read individually.
     ============================================================ */
    c.innerHTML =
      '<div class="te-root">' +

      '<header class="te-head">' +
        '<div class="te-brand">TANK<span>EDITOR</span></div>' +
        '<div class="te-head-field">' +
          /* A REAL DROPDOWN, WITH THE IMPORT PATH STILL REACHABLE.

             This was an `<input list=...>` — a free-text box with a suggestion
             list behind it. It behaves like a text field: you can type anything
             into it, nothing in it looks like a menu, and there is no list to
             open and read. Combined with the Import button sitting right next to
             it, the whole editor read as "the only way to get a model in here is
             to import one", when in fact twelve tanks are already wired up and
             sitting there selectable.

             `tankOptions()` — which builds proper option markup, name AND id —
             has been in this file the whole time and has never been called by
             anything. It is what is wired up here now.

             An IMPORTED model is not in TANK_ORDER, so it cannot appear in a
             list built from it. That is what the text box beside the dropdown is
             for: the id of anything imported or hand-written, kept as an escape
             hatch so importing still works and the editor is never stuck
             showing one tank. */
          '<select id="te-tank-select" class="te-input te-select">' + tankOptions() + '</select>' +
          '<input id="te-tank" class="te-input" spellcheck="false" autocomplete="off" ' +
                 'placeholder="or type an id…">' +
        '</div>' +
        /* IMPORT A GLB. The models in the roster are already wired up; this is
           for the one that is not in config.js yet — which is every model whose
           facing nobody could work out. It is loaded straight into the models
           cache under a synthetic name so the ordinary preview, markers and
           hitbox all work on it unchanged, and the copied-out report names the
           file so it can be added to config.js properly. */
        '<label class="te-btn te-btn-ghost" for="te-import">Import GLB</label>' +
        '<input id="te-import" type="file" accept=".glb,.gltf" class="te-hidden">' +
        '<div id="te-import-name" class="te-note te-inline"></div>' +
        '<div class="te-grow"></div>' +
        '<div class="te-btn te-icon" id="te-undo" title="Undo (Ctrl+Z)">&#8630;</div>' +
        '<div class="te-btn te-icon" id="te-redo" title="Redo (Ctrl+Y)">&#8631;</div>' +
        '<div class="te-btn" id="te-help" title="Keyboard shortcuts (?)">?</div>' +
        '<div class="te-btn te-btn-primary" id="te-save">Save &amp; apply</div>' +
        '<div class="te-btn te-btn-ghost" id="te-back">Exit</div>' +
      '</header>' +

      '<div class="te-body">' +

      '<nav class="te-rail">' + modeRail() + '</nav>' +

      '<div class="te-stage">' +
        '<div id="te-toast" class="te-toast"></div>' +
        '<div id="te-view" class="te-view"><canvas id="te-axes"></canvas></div>' +
        '<div class="te-axisbar">' +
          '<span class="te-axis" data-axis="x">Side X</span>' +
          '<span class="te-axis" data-axis="y">Top Y</span>' +
          '<span class="te-axis" data-axis="z">Front Z</span>' +
          '<span class="te-axis" data-axis="p">Persp</span>' +
          '<span class="te-axis te-axis-fit" id="te-fit" title="Frame the tank">Fit</span>' +
        '</div>' +
      '</div>' +

      '<aside class="te-insp">' +
        '<div id="te-insp-title" class="te-insp-title"></div>' +
        '<div id="te-fields" class="te-insp-body"></div>' +
        '<div id="te-note" class="te-note"></div>' +
        '<div class="te-insp-actions" id="te-mode-actions"></div>' +
      '</aside>' +

      '</div>' +

      /* THE STATUS BAR. Deliberately outside the inspector and outside
         anything renderFields() rewrites: this line used to live inside the
         panel, where every edit replaced it, and the one moment it mattered
         most — the moment a pick landed — was the moment it was thrown away.
         It is the answer to "did that work", so it has to survive the work. */
      '<footer class="te-foot">' +
        '<div id="te-setup-state" class="te-setupstate te-warn"></div>' +
        '<div class="te-grow"></div>' +
        '<div id="te-foot-info" class="te-foot-info"></div>' +
        '<div class="te-btn" id="te-copy-def">Copy setup (JSON)</div>' +
        '<div class="te-btn" id="te-copy-report">Copy report</div>' +
        '<div class="te-btn" id="te-paste-code">Paste tank code</div>' +
      '</footer>' +

      '</div>';

    injectCss();

    /* Both controls write the same place. The dropdown picks a roster tank and
       syncs the text box to it; the text box accepts anything — an imported id,
       a hand-written one — and syncs the dropdown to it when that id happens to
       be in the roster. Neither is ever the only way in. */
    var selEl = $id('te-tank-select');
    var txtEl = $id('te-tank');
    function setTankField(id){
      if(txtEl) txtEl.value = id;
      if(selEl){
        var match = false;
        for(var i = 0; i < selEl.options.length; i++){
          if(selEl.options[i].value === id){ selEl.selectedIndex = i; match = true; break; }
        }
        /* An imported id is not an option. Selecting nothing is honest — the
           dropdown then shows the placeholder rather than silently displaying a
           different tank than the one being edited. */
        if(!match) selEl.selectedIndex = -1;
      }
    }
    if(txtEl){
      txtEl.value = state.selected;
      txtEl.onchange = function(){ pickTank(this.value); };
    }
    if(selEl){
      selEl.onchange = function(){ if(this.value) pickTank(this.value); };
      setTankField(state.selected);
    }
    window.__teSetTankField = setTankField;

    document.querySelectorAll('.te-mode').forEach(function(m){
      m.onclick = function(){
        setMode(this.dataset.mode);
      };
    });

    $id('te-save').onclick = doSave;
    var resetBtn = $id('te-reset');
    if(resetBtn) resetBtn.onclick = doReset;
    $id('te-back').onclick = doClose;
    $id('te-fit').onclick = function(){ fitView(); };
    var helpBtn = $id('te-help');
    if(helpBtn) helpBtn.onclick = showHelp;
    var undoBtn = $id('te-undo'), redoBtn = $id('te-redo');
    if(undoBtn) undoBtn.onclick = function(){ undo(); };
    if(redoBtn) redoBtn.onclick = function(){ redo(); };

    /* ---- import a GLB from disk ---- */
    var imp = $id('te-import');
    if(imp){
      imp.onchange = function(){
        var f = imp.files && imp.files[0];
        if(f) importGlb(f);
        /* Cleared so re-picking the SAME file fires onchange again — without
           this, choosing a file twice in a row silently does nothing the
           second time, which reads as "the import is broken". */
        imp.value = '';
      };
    }

    /* ---- copy out ---- */
    var cDef = $id('te-copy-def'), cRep = $id('te-copy-report');
    if(cDef) cDef.onclick = function(){ copyText(buildSetupJSON(), 'Setup JSON copied'); };
    if(cRep) cRep.onclick = function(){ copyText(buildReport(), 'Report copied'); };

    /* ---- import a pasted tank code ---- */
    var pasteBtn = $id('te-paste-code');
    if(pasteBtn) pasteBtn.onclick = function(){ pasteTankCode(); };

    /* Keep the facing readout live: it is read off the model, so anything that
       moves the tank has to refresh it. The gizmo drag is the one that changes
       the pose without going through applyValuesToScene. */
    if(state.gizmo){
      state.gizmo.addEventListener('objectChange', function(){
        var r = $id('te-fwd-readout');
        if(r && state.mode === 'facing'){
          var cf = currentForward();
          if(cf){
            r.textContent = 'forward ' + fmtAxis(cf.f) + ' · up ' + fmtAxis(cf.u);
            r.className = 'te-angle' + (orientIsSolved(cf) ? ' te-ok' : ' te-warn');
          }
        }
      });
    }

    var animBtn = $id('te-anim'), outBtn = $id('te-outline');
    if(animBtn) animBtn.onclick = function(){ toggleModelFlag('anim'); };
    if(outBtn) outBtn.onclick = function(){ toggleModelFlag('outline'); };
    syncModelUI();
    state.spinTurret = false;

    document.querySelectorAll('.te-axis[data-axis]').forEach(function(a){
      a.onclick = function(){ setAxisView(this.dataset.axis); };
    });

    state.running = true;
    state.keyHandler = function(e){
      if(e.code === 'Escape'){ doClose(); return; }
      var mod = e.ctrlKey || e.metaKey;
      if(mod && e.code === 'KeyZ'){
        if(e.shiftKey) redo(); else undo();
        e.preventDefault();
      } else if(mod && e.code === 'KeyY'){
        redo();
        e.preventDefault();
      } else if(mod && e.code === 'KeyS'){
        e.preventDefault();
        doSave();
        return;
      }
      /* Shortcuts are refused while a text field has focus, or they fire while
         somebody is typing a tank id into the picker — which is the one place
         a single letter key is most likely to be in use. */
      var t = e.target;
      if(t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;

      if(e.code === 'KeyF'){ fitView(); return; }
      if(e.code === 'KeyG'){ snapToGround(); return; }
      if(e.code === 'Slash' && e.shiftKey){ showHelp(); return; }
      /* 1..9 walk the rail in reading order, so every mode is one key away
         without the eye having to find it. */
      if(/^Digit[1-9]$/.test(e.code)){
        var n = parseInt(e.code.slice(5), 10) - 1;
        var flat = [];
        MODE_GROUPS.forEach(function(g){ g.modes.forEach(function(m){ flat.push(m.id); }); });
        if(flat[n]) setMode(flat[n]);
      }
    };
    document.addEventListener('keydown', state.keyHandler);

    buildStage();

    /* SHOW THE TANK FIRST, SYNC SECOND.

       This used to wait on syncRemoteOverrides() — a fetch to a remote worker —
       before building anything. That put the entire editor behind a network
       round-trip: with the worker slow, unreachable or the player offline, the
       viewport stayed empty and every marker and measurement was unavailable,
       with nothing on screen to say why. The editor is a local tool; it has to
       open locally.

       So the tank is built from whatever is already in localStorage, and the
       shared overrides are folded in when they arrive — but ONLY if they
       actually differ from what is already loaded.

       That condition is not tidiness. Building the tank is asynchronous (the
       model is fetched first), so calling pickTank twice races itself: the
       second call's clearTank() runs before the first call's build() has
       resolved, so the first tank lands in the scene AFTER the clear and is
       never removed. That is a second tank standing next to the one being
       edited, and it was visible on screen. Comparing the payloads is what
       makes the second call a no-op in the common case, and _buildGen in
       pickTank closes the race for the cases where it is not. */
    pushHistory();
    var localJson = JSON.stringify(window.TANK_EDITOR_OVERRIDES || {});
    pickTank(state.selected);

    syncRemoteOverrides().then(function(){
      if(!state.running) return;
      if(JSON.stringify(window.TANK_EDITOR_OVERRIDES || {}) === localJson){
        return;                                   /* nothing new arrived */
      }
      pushHistory();
      pickTank(state.selected);
    }).catch(function(){ /* offline: the local values already on screen stand */ });
  }

  /* The roster, as datalist entries. An input+datalist rather than a select
     because a select cannot be typed into: with sixteen tanks on a roster that
     is still growing, finding the one you want should not require scrolling a
     popup and reading it. Typing filters, and the id stays the value so it can
     be pasted in directly. */
  function tankListOptions(){
    var ids = (typeof TANK_ORDER !== 'undefined' && TANK_ORDER.length) ? TANK_ORDER : ['coolbuddy'];
    return ids.map(function(id){
      var d = (typeof TANKS !== 'undefined' && TANKS[id]) ? TANKS[id] : null;
      var nm = d ? (d.name || id) : id;
      return '<option value="' + id + '">' + nm + '</option>';
    }).join('');
  }

  /* THE TRACKS A TANK WILL ACTUALLY SHOW.

     This asks Tank.resolveTracks for the answer whenever Tank is loaded, which
     it is: `class Tank` is a lexical global, not a window property, but a bare
     `Tank` inside another classic script resolves to it fine. Only if the game
     scripts failed to load does the local fallback below take over.

     The first version of this hand-rolled the merge and got it subtly wrong —
     it applied the defaults but not the null-resolution, so every derived
     slider came up on its minimum instead of on the tank's real tread width.
     Delegating means the panel cannot drift from what the tank will draw. */
  function resolveTracksFor(id){
    var def = (typeof TANKS !== 'undefined' && TANKS[id]) ? TANKS[id] : null;
    var ov  = (window.TANK_EDITOR_OVERRIDES || {})[id] || {};
    if(typeof Tank !== 'undefined' && Tank.resolveTracks) return Tank.resolveTracks(def, ov);

    /* Editor-only fallback: no Tank class, so nothing can be drawn either and
       this only has to keep the panel from throwing. */
    var out = {
      on:true, type:'wheels', width:0.48, height:0.5, length:4.66, offset:1.74,
      wheels:5, wheelR:0.36, hubR:0.144, sprocketR:0.403, idlerR:0.338,
      color:0x282830, rim:0x3c3c46, treadScale:1, spin:true
    };
    var src = (ov && ov.tracks) || (def && def.tracks) || {};
    for(var k in out) if(src[k] !== undefined) out[k] = src[k];
    return out;
  }

  function hex(c){
    var n = (typeof c === 'number') ? c : parseInt(String(c).replace('#',''), 16);
    if(!isFinite(n)) n = 0x282830;
    return '#' + ('000000' + (n >>> 0).toString(16)).slice(-6);
  }

  function tankOptions(){
    var ids = (typeof TANK_ORDER !== 'undefined' && TANK_ORDER.length) ? TANK_ORDER : ['coolbuddy'];
    return ids.map(function(id){
      var d = (typeof TANKS !== 'undefined' && TANKS[id]) ? TANKS[id] : null;
      var nm = d ? (d.name || id) : id;
      return '<option value="' + id + '">' + nm + ' (' + id + ')</option>';
    }).join('');
  }

  /* THE RAIL. Nine modes under four headings, because they were not nine
     unrelated things: orientation is a question about the model, the hitbox is
     a question about its shape, the pivot and the turret mount are both about
     where the turret turns, and the two shell points are both about where
     things leave the tank. Grouping them says that; the flat list did not. */
  var MODE_GROUPS = [
    { title: 'ORIENT', modes: [
      { id: 'facing',  label: 'Facing',    hint: 'Which way does it drive?' },
      { id: 'front',   label: 'Front edge',hint: 'Aim the model' },
    ]},
    { title: 'SHAPE', modes: [
      { id: 'hitbox',  label: 'Hitbox',    hint: 'Collision box' },
      { id: 'tracks',  label: 'Tracks',    hint: 'Treads and wheels' },
    ]},
    { title: 'TURRET', modes: [
      { id: 'pivot',   label: 'Pivot',     hint: 'Turns here' },
      { id: 'turret',  label: 'Mount',     hint: 'Turret centre' },
    ]},
    { title: 'SHELLS', modes: [
      { id: 'shell',   label: 'Fire point',hint: 'Bullet leaves' },
      { id: 'casing',  label: 'Casing',    hint: 'Empty leaves' },
    ]},
    { title: 'PLACE', modes: [
      { id: 'model',   label: 'Move',     hint: 'Position the model' },
      { id: 'rotate',  label: 'Rotate',   hint: 'Turn the model' },
      { id: 'scale',   label: 'Scale',    hint: 'Resize the model' },
    ]},
    { title: 'INFO', modes: [
      { id: 'stats',   label: 'Statistics',hint: 'Measured' },
    ]},
  ];

  function modeRail(){
    return MODE_GROUPS.map(function(g){
      return '<div class="te-rail-group">' +
        '<div class="te-rail-title">' + g.title + '</div>' +
        g.modes.map(function(m){
          return '<div class="te-mode' + (state.mode === m.id ? ' te-on' : '') +
                 '" data-mode="' + m.id + '" title="' + m.hint + '">' +
                 '<span class="te-mode-label">' + m.label + '</span>' +
                 '<span class="te-mode-hint">' + m.hint + '</span></div>';
        }).join('') +
      '</div>';
    }).join('') +
    /* DISPLAY lives in the rail rather than above the values because it is a
       property of the VIEW, not of the tank: it changes what you can see and
       never changes what gets copied out. Burying it in the value panel made
       it read as a setting, which is how it came to be switched off by people
       assuming it was one. */
    '<div class="te-rail-group te-rail-foot">' +
      '<div class="te-rail-title">DISPLAY</div>' +
      '<div class="te-toggle' + (state.values.model.anim ? ' te-on' : '') + '" id="te-anim">Animation</div>' +
      '<div class="te-toggle' + (state.values.model.outline ? ' te-on' : '') + '" id="te-outline">Outline</div>' +
      '<div class="te-toggle" id="te-reset">Reset this tank</div>' +
    '</div>';
  }

  /* PER-MODE ACTIONS, under the values. Each mode gets the buttons that only
     make sense for it, so the inspector is never carrying controls for eight
     other things. The turret test is the clearest case: a spin control shown
     while the hitbox is being edited is a control for a question that is not
     being asked. */
  function modeActions(mode){
    if(mode === 'hitbox'){
      return '<div class="te-act-row">' +
               '<div class="te-btn" id="te-fitbox">Fit to model</div>' +
             '</div>' +
             '<div class="te-note">Fit sizes the box to the model\u2019s real bounds. Drag it afterwards for a looser or tighter hit — a hitbox larger than the tank lets bullets pass through the parts that stick out.</div>';
    }
    /* THE TRACKS PANEL.

       Not a number of points. Every value here is a real dimension of the
       running gear, the whole set is written into the tank's `tracks` block and
       survives the export, and the preview rebuilds the geometry on every
       change — so what is on screen is what the tank will have in a match.

       The sizes that are left blank are not missing data: `null` means "work it
       out from this tank's own body", which is why a tank with an empty Tracks
       block still gets treads that fit it rather than a pair of the default
       skis every tank in the game used to share. */
    if(mode === 'tracks'){
      var T = resolveTracksFor(state.selected);
      /* Say what the tank's OWN model already carries, because that is the
         thing that decides whether any of these sliders do anything. A model
         with its treads baked in ignores the whole panel until `replace` is
         switched on, and a panel of controls that appear to do nothing is
         indistinguishable from a panel that is broken. */
      var gearCount = 0;
      var hasModel = false;
      try {
        var pt = state.tank;
        if(pt && pt.def && pt.def.model){
          hasModel = true;
          if(typeof Tank !== 'undefined' && Tank.findModelGear) gearCount = Tank.findModelGear(pt.root).length;
        }
      } catch(e){ /* the preview may not have a root yet; say nothing */ }
      var gearNote = hasModel
        ? (gearCount > 0
            ? 'This model carries <b>' + gearCount + '</b> running-gear node' + (gearCount === 1 ? '' : 's') +
              ' of its own, matched by name (<b>track</b>, <b>tread</b>, <b>wheel</b>, <b>sprocket</b>, <b>idler</b>…). ' +
              '<b>Replace model</b> hides those and uses the kit below instead.'
            : '<b>This model names none of its running gear.</b> Its treads are baked in under Blender\u2019s default names (' +
              '<i>Cube</i>, <i>Cylinder.010</i>…), which cannot be told apart from the hull. ' +
              '<b>Replace model</b> will therefore <i>add</i> the kit on top of the wheels you can already see rather than swap them — ' +
              'name the wheel / track / sprocket nodes in Blender (Item field in the Object Properties panel) and they become findable.')
        : 'No model on this tank — the kit below is what it will be built from.';
      var num = function(id, label, key, lo, hi, step, hint){
        var v = (typeof T[key] === 'number') ? T[key] : 0;
        return '<label class="te-field"><span>' + label + '</span>' +
          '<input data-trk="' + key + '" id="te-tr-' + id + '" type="range" min="' + lo + '" max="' + hi + '" step="' + step + '" value="' + v + '" style="accent-color:#ffb12b">' +
          '<b class="te-val" id="te-tr-' + id + '-v">' + (Math.round(v * 1000) / 1000) + '</b></label>' +
          (hint ? '<div class="te-note te-note-tight">' + hint + '</div>' : '');
      };
      return '<label class="te-field"><span>Style</span>' +
          '<select id="te-tr-type" class="te-input te-select">' +
            ['solid','wheels','sprocket','spoked','halftrack','none'].map(function(k){
              return '<option value="' + k + '"' + (T.type === k ? ' selected' : '') + '>' + k + '</option>';
            }).join('') +
          '</select></label>' +
        num('width',    'Tread width',  'width',      0.05, 1.60, 0.01) +
        num('height',   'Tread height', 'height',     0.05, 1.40, 0.01) +
        num('length',   'Tread length', 'length',     0.50, 16.0, 0.05) +
        num('offset',   'Side offset',  'offset',     0.00,  4.0, 0.01, 'How far out from the hull centre each tread sits.') +
        num('wheels',   'Road wheels',  'wheels',     0,    16,   1) +
        num('wheelR',   'Wheel radius', 'wheelR',     0.02,  1.20, 0.01) +
        num('sprocketR','Sprocket',     'sprocketR',  0.02,  1.40, 0.01) +
        num('idlerR',   'Idler',        'idlerR',     0.02,  1.40, 0.01) +
        num('hubR',     'Hub size',     'hubR',       0.02,  0.90, 0.01) +
        num('treadScale','Lug pitch',   'treadScale', 0.00,  3.00, 0.05, '0 is a smooth band. Higher puts more cleats on it.') +
        '<label class="te-field"><span>Tread colour</span>' +
          '<input id="te-tr-color" type="color" value="' + hex(T.color) + '" style="width:100%;height:30px;background:transparent;border:1px solid #2a2f36;border-radius:6px;cursor:pointer"></label>' +
        '<label class="te-field"><span>Wheel colour</span>' +
          '<input id="te-tr-rim" type="color" value="' + hex(T.rim) + '" style="width:100%;height:30px;background:transparent;border:1px solid #2a2f36;border-radius:6px;cursor:pointer"></label>' +
        '<div class="te-act-row"><div class="te-toggle' + (T.spin ? ' te-on' : '') + '" id="te-tr-spin">Spin wheels</div>' +
          '<div class="te-toggle' + (T.replace ? ' te-on' : '') + '" id="te-tr-replace">Replace model</div>' +
          '<div class="te-btn" id="te-tr-clear">Clear</div></div>' +
        '<div class="te-note">' + gearNote + '</div>' +
        '<div class="te-note">These replace the pair of identical boxes every tank used to get. Leave a field alone and the tank works it out from its own body — clear a tank back to defaults with <b>Clear</b>.</div>';
    }
    if(mode === 'model'){
      return '<div class="te-act-row">' +
               '<div class="te-btn" id="te-ground">Drop to ground</div>' +
             '</div>' +
             '<div class="te-note">Drop moves the model down until its lowest point sits at y=0. Use it when <b>sitsOnGround</b> in Statistics is false — a tank hovering half a unit up shoots over low walls.</div>';
    }
    if(mode === 'scale'){
      return '<div class="te-act-row">' +
               '<div class="te-btn" id="te-matchbox">Match hitbox</div>' +
               '<div class="te-btn" id="te-refitbox">Re-fit hitbox</div>' +
             '</div>' +
             '<div class="te-note"><b>Match hitbox</b> rescales the model until it fills the collision box you set. <b>Re-fit hitbox</b> does the opposite — grows the box to the new model. Do one or the other, not both.</div>';
    }
    if(mode === 'pivot' || mode === 'turret'){
      return '<div class="te-act-row">' +
               '<div class="te-toggle' + (state.spinTurret ? ' te-on' : '') + '" id="te-spin">Spin turret</div>' +
               '<span id="te-angle-readout" class="te-angle">0°</span>' +
             '</div>' +
             '<label class="te-field"><span>Turret angle</span>' +
               '<input id="te-angle" type="range" min="0" max="360" value="0" step="1" style="accent-color:#ffb12b"></label>' +
             '<div class="te-note">Spinning is how a bad pivot shows up: watch the mark and the fire point orbit. Anything that swings rather than turning in place is mounted off-axis.</div>';
    }
    return '';
  }

  /* ------------------------------------------------------------
     3D stage
     ------------------------------------------------------------ */
  function buildStage(){
    var view = $id('te-view');
    if(!view) return;
    view.innerHTML = '';

    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x11151a);

    var W = view.clientWidth || 640, H = view.clientHeight || 480;
    state.camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 500);
    state.camera.position.set(8, 6, 12);
    state.camera.lookAt(0, 1, 0);

    state.renderer = new THREE.WebGLRenderer({antialias: true});
    state.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    state.renderer.setSize(W, H);
    state.renderer.shadowMap.enabled = true;
    view.appendChild(state.renderer.domElement);
    bindFacePicking(state.renderer.domElement);

    var hemi = new THREE.HemisphereLight(0xdfeaff, 0x22262c, 0.7);
    state.scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(10, 18, 8);
    sun.castShadow = true;
    state.scene.add(sun);
    state.scene.add(new THREE.AmbientLight(0x999999, 0.4));

    // Ground grid so axis movement is readable
    var grid = new THREE.GridHelper(20, 20, 0x2a3038, 0x1f242b);
    grid.position.y = -0.01;
    state.scene.add(grid);

    state.controls = new THREE.OrbitControls(state.camera, state.renderer.domElement);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.12;
    state.controls.target.set(0, 1, 0);
    state.controls.update();

    state.gizmo = new THREE.TransformControls(state.camera, state.renderer.domElement);
    state.gizmo.setSize(0.85);
    state.gizmo.setSpace('local');
    /* THE GIZMO IS NOT AN OBJECT3D ANY MORE.

       It was one up to three r168. From r169 TransformControls is a Controls
       subclass — an event manager — and the arrows live in a separate Object3D
       you have to add to the scene yourself via getHelper(). The old code did
       `scene.add(state.gizmo)` and called `state.gizmo.updateMatrixWorld()`,
       and both silently stopped working: the arrows were never drawn, and the
       render loop threw "updateMatrixWorld is not a function" on the very first
       frame, which took the whole editor down before a single tank could be
       loaded. So the helper is kept alongside the controls and everything that
       used to touch the controls as if it were a node now touches it. */
    state.gizmoHelper = state.gizmo.getHelper();
    state.scene.add(state.gizmoHelper);
    // r128 does NOT emit 'dragging-changed', so gate OrbitControls via
    // mouseDown/mouseUp. IMPORTANT: never move the camera here — grabbing a
    // gizmo arrow to drag must not rotate the view (that lives in the
    // top-right orientation widget only).
    state.gizmo.addEventListener('mouseDown', function(){
      if(state.controls) state.controls.enabled = false;
    });
    state.gizmo.addEventListener('mouseUp', function(){
      if(state.controls) state.controls.enabled = true;
      /* A gizmo drag has to be committed on release, not per frame: scale ends
         in a modelScale that has to be written to the override and rebuilt, and
         a rotation ends in three numbers that would otherwise push a history
         entry for every pixel of the drag. */
      if(state.mode === 'scale') _commitScaleGizmo();
      else if(state.mode === 'rotate') _commitRotateGizmo();
      if(dragged) pushHistory();
      dragged = false;
    });
    state.gizmo.addEventListener('objectChange', function(){
      if(state.mode === 'rotate') _readGizmoRotation();
      else if(state.mode === 'scale') _onScaleGizmo();
      else syncFromGizmo();
      dragged = true;
    });

    state.resizeHandler = function(){ fitViewport(); };
    window.addEventListener('resize', state.resizeHandler);

    // ---- Top-right orientation widget (a "different thing from the moving
    //      arrows": a read-only axis indicator + camera-snap control) ----
    state.axesCanvas = $id('te-axes');
    if(state.axesCanvas){
      state.axesCanvas.width = 112;
      state.axesCanvas.height = 112;
      state.axesCanvas.onclick = function(ev){
        var r = state.axesCanvas.getBoundingClientRect();
        var x = ev.clientX - r.left, y = ev.clientY - r.top;
        var ax = axesWidgetPick(x, y);
        if(ax) setAxisView(ax);
      };
    }

    function loop(){
      if(!state.running) return;
      state.raf = requestAnimationFrame(loop);
      if(state.controls && state.controls.enabled) state.controls.update();
      if(state.gizmoHelper) state.gizmoHelper.updateMatrixWorld();
      if(state.tank && state.tank._animMixer) state.tank._animMixer.update(1 / 60);
      if(state.tank && state.tank._syncTransform && state.spinTurret){
        state.tank.turretAngle = ((state.tank.turretAngle || 0) + 2.2 * (1 / 60)) % (Math.PI * 2);
        state.tank._syncTransform();
        applyValuesToScene();
        syncSpinUI();
      }
      if(state.renderer && state.scene) state.renderer.render(state.scene, state.camera);
      if(state.axesCanvas) drawAxesWidget();

      /* The status bar fills itself in once the model is actually in the tree.
         measureStats() returns null until then, and the tank is built
         asynchronously — the GLB is fetched first — so the first measurement
         always comes back empty and the numbers would sit blank until the user
         happened to switch modes or make an edit.

         Only while stats are MISSING, never on every frame: a real measurement
         walks every mesh and its eight corners, which is far too much to run
         sixty times a second for a row of text that changes when the model
         does. */
      if(!state.stats) refreshFootInfo();
    }
    loop();
  }

  /* Sync the turret-angle readout + slider with the preview tank */
  function syncSpinUI(){
    var deg = 0;
    if(state.tank && state.tank.turretAngle != null){
      deg = Math.round(state.tank.turretAngle * 180 / Math.PI) % 360;
      if(deg < 0) deg += 360;
    }
    var readEl = $id('te-angle-readout');
    if(readEl) readEl.textContent = deg + '\u00B0';
    if(state.spinTurret){
      var sl = $id('te-angle');
      if(sl) sl.value = String(deg);
    }
  }

  function fitViewport(){
    var view = $id('te-view');
    if(!view || !state.renderer || !state.camera) return;
    var W = view.clientWidth, H = view.clientHeight;
    if(!W || !H) return;
    state.renderer.setSize(W, H);
    state.camera.aspect = W / H;
    state.camera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------
     Top-right orientation widget
     ------------------------------------------------------------ */
  var widgetTips = { X:{x:0,y:0}, Y:{x:0,y:0}, Z:{x:0,y:0}, C:{x:56,y:56} };
  var widgetDirs = { X:null, Y:null, Z:null };

  function widgetProject(v){
    v.project(state.camera);
    var w = state.axesCanvas.width, h = state.axesCanvas.height;
    return { x: (v.x + 1) * 0.5 * w, y: (1 - v.y) * 0.5 * h, z: v.z };
  }
  function widgetDir(v){
    // screen-space unit direction of a world axis (fixed length)
    var a = widgetProject(new THREE.Vector3());
    var b = widgetProject(v.clone().add(new THREE.Vector3(1, 1, 1)));
    // project toward delta of axis vector: use dv = v (axis) projected difference
    var ep = widgetProject(v);
    var dx = ep.x - a.x, dy = ep.y - a.y;
    var len = Math.max(0.0001, Math.sqrt(dx*dx + dy*dy));
    return { x: dx / len, y: dy / len };
  }

  function drawAxesWidget(){
    var ctx = state.axesCanvas.getContext('2d');
    var W = state.axesCanvas.width, H = state.axesCanvas.height;
    ctx.clearRect(0, 0, W, H);
    var c = { x: W / 2, y: H / 2 };
    var L = 34;
    var cr = 8.5;
    var axes = [
      { v: new THREE.Vector3(1, 0, 0), col: '#ff5b5b', key: 'X' },
      { v: new THREE.Vector3(0, 1, 0), col: '#7bd36e', key: 'Y' },
      { v: new THREE.Vector3(0, 0, 1), col: '#5b9dff', key: 'Z' }
    ];
    // backdrop
    ctx.fillStyle = 'rgba(14,17,22,0.55)';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, L + 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    axes.forEach(function(a){
      var d = widgetDir(a.v);
      var tip = { x: c.x + d.x * L, y: c.y + d.y * L };
      widgetDirs[a.key] = d;
      widgetTips[a.key] = tip;
      // shaft
      ctx.strokeStyle = a.col;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      // arrow head
      var ang = Math.atan2(d.y, d.x);
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - 9 * Math.cos(ang - 0.5), tip.y - 9 * Math.sin(ang - 0.5));
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - 9 * Math.cos(ang + 0.5), tip.y - 9 * Math.sin(ang + 0.5));
      ctx.stroke();
      // label
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.key, tip.x + d.x * 10, tip.y + d.y * 10);
    });
    // center perspective button
    widgetTips.C = { x: c.x, y: c.y };
    ctx.fillStyle = 'rgba(255,177,44,0.16)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, cr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffb12b';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.fillText('P', c.x, c.y + 0.5);
    ctx.globalAlpha = 1;
  }

  function axesWidgetPick(x, y){
    var best = null, bestD = 999;
    ['X', 'Y', 'Z'].forEach(function(k){
      var t = widgetTips[k];
      var d = Math.hypot(t.x - x, t.y - y);
      if(d < bestD){ bestD = d; best = k.toLowerCase(); }
    });
    if(bestD <= 20) return best;
    var t = widgetTips.C;
    if(Math.hypot(t.x - x, t.y - y) <= 12) return 'p';
    return null;
  }

  /* ------------------------------------------------------------
     Tank loading + markers
     ------------------------------------------------------------ */
  function pickTank(id){
    /* Keep the header controls showing what is actually loaded, whichever one
       was used to get here. Without this, picking a tank from the dropdown
       leaves the text box still holding the previous id, and the header claims
       to be editing a tank that is no longer on screen. */
    if(typeof window.__teSetTankField === 'function'){
      try { window.__teSetTankField(id); } catch(e){}
    }
    state.selected = id;
    state.history = [];
    state.historyIdx = -1;
    state.spinTurret = false;
    var spinBtn = $id('te-spin');
    if(spinBtn) spinBtn.classList.remove('te-on');
    var angleIn0 = $id('te-angle');
    if(angleIn0) angleIn0.value = '0';
    var readEl0 = $id('te-angle-readout');
    if(readEl0) readEl0.textContent = '0\u00B0';
    var ov = ovFor(id);
    /* AN IMPORTED MODEL HAS NO DEF, so one is built for it here.

       Without this the id falls through to TANKS.coolbuddy, which means the
       preview shows Cool Buddy while the user is looking at a model they just
       imported and clicking axis buttons for it — the whole editor would be
       lying about what it is editing. The synthetic def points `model` at the
       cache key the import registered, and carries only what the Tank
       constructor and the preview actually read; the gameplay numbers are
       left at zero because they are not what is being set up here. */
    var def;
    if(typeof TANKS !== 'undefined' && TANKS[id]){
      def = TANKS[id];
    } else if(state.imported && state.imported.key === id){
      def = {
        id: id, name: state.imported.file || id,
        model: id, modelScale: 1,
        color: 0x8a8f98, turretColor: 0xb9bfc9,
        body: { w:3, h:1, l:4.4 }, turret: { w:1.8, h:0.8, l:2.4 },
        barrelLen: 1.6, barrelR: 0.16,
        hp:200, speed:1, turn:1, turretTurn:1, damage:1, reload:1,
        shellSpeed:1, shellRange:1, accel:1, shellType:'shell',
        mass:30, viewRange:100,
      };
      state.imported.def = def;
    } else {
      def = TANKS.coolbuddy;
    }
    if(ov && ov.body) state.values.body = Object.assign({}, def.body, ov.body);
    else state.values.body = Object.assign({}, def.body);
    if(ov && ov.pivot) state.values.pivot = Object.assign({}, ov.pivot);
    if(ov && ov.turret) state.values.turret = Object.assign({}, ov.turret);
    if(ov && ov.shell) state.values.shell = Object.assign({}, ov.shell);
    if(ov && ov.casing) state.values.casing = Object.assign({}, ov.casing);
    /* The running gear, resolved — so the panel opens showing what this tank
       will actually draw, not the raw override and not the defaults. Resolving
       here is what makes a tank with no `tracks` key show derived-from-body
       numbers rather than blanks, which is the whole reason those fields exist. */
    state.values.tracks = resolveTracksFor(state.selected);
    /* Fresh tank, fresh touch-list. Carrying the previous tank's would export
       keys for a tank nobody touched. Pre-seeded with whatever an existing
       override already holds, so opening the panel on an already-customised
       tank and pressing Save keeps those keys instead of dropping them. */
    state.tracksTouched[state.selected] = {};
    if(ov && ov.tracks){
      for(var tkk in ov.tracks) state.tracksTouched[state.selected][tkk] = true;
    }
    var mdl = { x:0, y:0, z:0, yaw:0, front:'', up:'', scale:1, rx:0, ry:0, rz:0 };
    if(ov && ov.model) mdl = Object.assign(mdl, ov.model);
    var defAnim = !(def && def.playAnims === false);
    var defOutline = !(def && def.outline === false);
    mdl.anim = (ov && ov.model && typeof ov.model.anim === 'boolean') ? ov.model.anim : defAnim;
    mdl.outline = (ov && ov.model && typeof ov.model.outline === 'boolean') ? ov.model.outline : defOutline;
    /* The declared orientation, from the override if it has one and from the
       def otherwise — so a tank already carrying modelFront/modelUp in
       config.js opens in the editor already set up, rather than looking
       unconfigured and inviting the user to "fix" it wrongly. */
    mdl.front = (ov && ov.model && ov.model.front != null) ? ov.model.front
             : (def && def.modelFront) ? def.modelFront : '';
    mdl.up = (ov && ov.model && ov.model.up != null) ? ov.model.up
           : (def && def.modelUp) ? def.modelUp : '';
    mdl.yaw = (ov && ov.model && typeof ov.model.yaw === 'number') ? ov.model.yaw
            : (def && def.modelYaw != null) ? def.modelYaw : 0;
    /* modelScale is how the game sizes a model: (def.modelScale || 1) * 2, in
       tank.js. It was the one setting in config.js the editor could not reach
       at all — you could move, rotate and reorient a model but never resize it,
       which is the first thing wrong with most imported tanks. */
    var defScale = (def && typeof def.modelScale === 'number' && def.modelScale > 0) ? def.modelScale : 1;
    mdl.scale = (ov && ov.model && typeof ov.model.scale === 'number' && ov.model.scale > 0)
              ? ov.model.scale : defScale;
    /* Free rotation, in degrees, on top of the solved orientation. Composed by
       tank.js as euler * correction, so it is independent of front/up: those
       say which way the tank drives, this says how it sits. */
    var defRot = (def && def.modelRotate) || {};
    var ovRot = (ov && ov.model && ov.model.rotate) || null;
    mdl.rx = ovRot && typeof ovRot.x === 'number' ? ovRot.x : (typeof defRot.x === 'number' ? defRot.x : 0);
    mdl.ry = ovRot && typeof ovRot.y === 'number' ? ovRot.y : (typeof defRot.y === 'number' ? defRot.y : 0);
    mdl.rz = ovRot && typeof ovRot.z === 'number' ? ovRot.z : (typeof defRot.z === 'number' ? defRot.z : 0);
    state.values.model = mdl;

    clearTank();
    renderFields();

    /* A generation stamp, so a build that resolves after the editor has already
       moved on can recognise itself as stale and dispose of itself.

       clearTank() can only remove the tank it knows about. Building one is
       asynchronous — the model is probed and fetched first — so two pickTank
       calls in quick succession produce two builds, and the SECOND clearTank
       runs before the FIRST build has resolved. The first tank then arrives in
       the scene with nothing left to remove it, and you get two tanks standing
       side by side, only one of which is the one being edited. Checking the
       stamp on the way in is what makes that impossible. */
    var myGen = (state._buildGen = (state._buildGen || 0) + 1);

    function build(){
      /* Already superseded while the model was loading: build nothing. */
      if(state._buildGen !== myGen || !state.running) return;
      var t = null;
      try{
        /* A COPY of the def, carrying the edited scale. Two reasons, and the
           second is the important one:

             1. so the preview is the size being edited;
             2. `def` is TANKS[id] — the live config object the game itself
                reads. Writing modelScale straight onto it would resize the tank
                in every match on the page, not just in the editor. Tank only
                ever reads from its def, never writes, so a shallow copy is
                enough and the nested objects it shares are not mutated. */
        var previewDef = Object.assign({}, def);
        previewDef.modelScale = (state.values.model.scale > 0) ? state.values.model.scale : 1;
        /* What the tank was ACTUALLY BUILT at. The orientation group's scale is
           relative to this, and without it there is no way to turn "the size the
           user wants" into "the scale to put on the group" — which is how the
           resize gizmo ended up reporting a size that did not match the number
           it stored. */
        state.loadedModelScale = previewDef.modelScale;
        t = new Tank(previewDef, { physicsWorld: null });
        t.root.position.set(0, 0, 0);
        if(t._overlayGroup) t._overlayGroup.visible = false;
        if(state._buildGen !== myGen){
          /* Superseded in the window between the check above and here. */
          return;
        }
        state.tank = t;
        state.scene.add(t.root);
        // Re-apply saved overrides so the preview matches runtime
        if(t._applyEditorOverrides) t._applyEditorOverrides();
      }catch(e){ console.error('tank build:', e); return; }
      whenModelReady(t, function(){
        /* Same check again: the model may have taken seconds to arrive. */
        if(state._buildGen !== myGen || state.tank !== t) return;
        buildMarkers();
      });
    }

    /* Probe the model file the def points at (striker ships TL_ark.glb),
       not the tank id — the editor preview must show the real model.

       NOT for an imported model: the file came from disk and is already in the
       cache, and probe() REPLACES Models._available wholesale with the result
       of a URL existence check. That would drop the imported key and the very
       next Models.load() would conclude the model does not exist. */
    if(state.imported && state.imported.key === (def.model || id)){
      build();
    } else if(window.Models && Models.probe){
      Models.probe([def.model || id]).then(build).catch(build);
    } else {
      build();
    }
  }

  function whenModelReady(t, cb){
    if(!t){ cb(); return; }
    if(t._modelReady){ t._modelReady.then(cb).catch(cb); return; }
    // Cube path — ready immediately
    cb();
  }

  /* ============================================================
     ORIENTATION — WHICH WAY IS THE TANK'S FRONT?

     This is the feature the editor did not have and the reason the
     setup could not be done at all before. Everything else here is a
     position you can see and drag; this is the one thing that was
     unknowable, because "which way does this GLB face" cannot be read
     off the file — it is not in the glTF, it is not derivable from the
     bounding box, and a model authored barrel-along-+X is
     indistinguishable from one authored barrel-along-+Z until you look
     at it. So it has to be DECLARED, by someone looking at it.

     `front` is which authored axis points out of the tank's nose, `up`
     which points out of its roof. Given those two, the rotation into the
     game's frame is solved rather than guessed — see Tank.solveModelQuat,
     which is the same function the game itself calls, so what the arrow
     shows here is exactly what the tank will do in a match.
     ============================================================ */
  var AXIS_KEYS = ['+X','-X','+Y','-Y','+Z','-Z'];

  function axisVector(key){
    var A = (window.Tank && Tank.AXES) ? Tank.AXES() : null;
    if(A && A[key]) return A[key].clone();
    return new THREE.Vector3(
      key === '+X' ? 1 : key === '-X' ? -1 : 0,
      key === '+Y' ? 1 : key === '-Y' ? -1 : 0,
      key === '+Z' ? 1 : key === '-Z' ? -1 : 0
    );
  }

  /* The solved rotation, or null when the pair is unusable. Delegates to the
     game rather than reimplementing it, so the editor cannot drift out of step
     with the tank it is setting up. */
  function solveOrient(front, up){
    if(!front || !up) return null;
    if(window.Tank && Tank.solveModelQuat) return Tank.solveModelQuat(front, up);
    /* Editor running without the game class (should not happen, but the editor
       must still show something rather than throwing). */
    var f = axisVector(front), u = axisVector(up);
    if(f.dot(u) !== 0) return null;
    var srcR = new THREE.Vector3().crossVectors(u, f);
    var mG = new THREE.Matrix4().makeBasis(axisVector('+X'), axisVector('+Y'), axisVector('+Z'));
    var mS = new THREE.Matrix4().makeBasis(srcR, u, f);
    return new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().multiplyMatrices(mG, mS.transpose()));
  }

  /* THE BIG ARROW. Drawn from the tank's own forward, not from the camera, so
     it answers the only question that matters: when this tank drives away from
     you, does it go this way?

     It is built as a group whose +Z is the direction of travel and which is
     then oriented by the solved quaternion, so it is showing the SOLVED result
     rather than a separate guess at it. A thin shaft plus a solid head, sized
     well clear of the hull, and left out of the shadow pass — it is an
     annotation, not scenery. */
  /* ============================================================
     THE RED PATCH. Proof that the click landed where it was aimed.

     The complaint this answers is a fair one: before, a click set an axis,
     the model rotated, and the panel showed a letter — so the only evidence
     the pick had been understood was a change somewhere else on screen. You
     could not see WHICH face had been taken as the front, and on a model
     that was already sideways you could not tell a good answer from a bad
     one without reading the numbers. So the face the cursor actually landed
     on gets painted, and it stays painted.

     WHY A SEPARATE MESH AND NOT A HIGHLIGHTED TRIANGLE.

     Painting the real triangle means splitting the GLB geometry, keeping a
     per-face material, and undoing it later — on a 852-triangle model that
     is a rebuild per click for one highlight, and it would fight the model
     cache that every other part of the editor shares. A disc laid on the
     face, offset a couple of centimetres along its own normal, reads the
     same at any zoom and costs one geometry.

     WHY IT IS PARENTED TO THE ORIENTATION GROUP.

     The pick is defined in authored space, and the correction is what moves
     authored space onto the tank. Parenting there means the patch is carried
     by the same rotation that carries the face it was clicked on, so it
     stays glued to that face instead of drifting off it the moment the
     orientation is corrected. Parented to the root or the scene it would
     slide across the hull on every axis change, which is exactly the
     ambiguity being removed.

     Red for the FRONT because that is the one people are unsure about and
     the one being asked for; a cooler colour for the UP so the two cannot
     be mistaken for each other when they end up on adjacent faces.
     ============================================================ */
  function _makeFacePatch(color){
    var g = new THREE.Group();
    /* Local +Z is the face normal, so the whole patch is built facing +Z and
       the caller only has to rotate it once. */
    var disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.62, 22),
      new THREE.MeshBasicMaterial({ color: color, depthTest: false, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.86, 28),
      new THREE.MeshBasicMaterial({ color: color, depthTest: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
    );
    /* A spike out of the face. The disc alone disappears when the camera swings
       edge-on to the face it is marking, which is exactly when the answer is
       least obvious, so the patch needs something with a silhouette of its own. */
    var spike = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 0.72, 12),
      new THREE.MeshBasicMaterial({ color: color, depthTest: false, transparent: true, opacity: 0.92 })
    );
    spike.rotation.x = Math.PI / 2;
    spike.position.z = 0.62;
    g.add(disc); g.add(ring); g.add(spike);
    g.traverse(function(o){
      if(o.isMesh){
        o.renderOrder = 1001;      /* over the gold arrow's 999 */
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    return g;
  }

  /* When the axis is changed by BUTTON rather than by clicking, the recorded
     face no longer describes the setting — the patch would sit on a face that
     is no longer the front and quietly lie about it. So the patch is re-aimed
     at the model's extreme along the newly chosen axis, which is the same
     place a user clicking that end would have landed. A cleared axis has no
     end to point at, so the patch goes away with it. */
  function _anchorMarkToAxis(slot, key){
    var orient = state.tank && state.tank._bodyOrient;
    if(!key){ state.faceMarks[slot] = null; return; }
    if(!orient) return;
    var v = axisVector(key);
    /* The axis is an authored direction; the extreme has to be found in world
       space, where the model's bounds are, so it is rotated by whatever the
       correction is currently doing. */
    var wq = new THREE.Quaternion();
    orient.getWorldQuaternion(wq);
    var worldAxis = v.clone().applyQuaternion(wq).normalize();
    var box = new THREE.Box3();
    try { box.copy(Tank.boxOf(orient, true)); } catch(e){}
    if(box.isEmpty()) return;
    var c = box.getCenter(new THREE.Vector3());
    var h = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    var corner = c.clone().add(new THREE.Vector3(
      worldAxis.x > 0 ? h.x : -h.x,
      worldAxis.y > 0 ? h.y : -h.y,
      worldAxis.z > 0 ? h.z : -h.z
    ));
    var inv = new THREE.Matrix4().copy(orient.matrixWorld).invert();
    state.faceMarks[slot] = {
      p: corner.applyMatrix4(inv).addScaledVector(v, 0.04),
      q: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), v)
    };
  }

  function _clearFaceMarks(){
    if(state.markGroup){
      try{ state.markGroup.parent && state.markGroup.parent.remove(state.markGroup); }catch(e){}
      state.markGroup.traverse(function(o){
        if(o.isMesh){
          if(o.geometry) o.geometry.dispose();
          if(o.material) o.material.dispose();
        }
      });
    }
    state.markGroup = null;
  }

  function _rebuildFaceMarks(){
    if(!state.scene || !state.tank || !state.tank._bodyOrient) return;

    var f = state.faceMarks.front, u = state.faceMarks.up;
    /* Rebuilt only when a mark actually changes, for the same reason the arrow
       is: applyValuesToScene runs on every gizmo drag frame, and two dispose-
       and-rebuild cycles per frame would leak geometry into a long session. */
    var sig = [f ? f.p.toArray().join(',') + '/' + f.q.toArray().join(',') : '-',
               u ? u.p.toArray().join(',') + '/' + u.q.toArray().join(',') : '-'].join('|');
    if(sig === state._markSig && state.markGroup) return;
    state._markSig = sig;

    _clearFaceMarks();
    if(!f && !u) return;

    var g = new THREE.Group();
    var parent = state.tank._bodyOrient;
    if(f){ var pf = _makeFacePatch(0xff3b30); pf.position.copy(f.p); pf.quaternion.copy(f.q); g.add(pf); }
    if(u){ var pu = _makeFacePatch(0x35c8ff); pu.position.copy(u.p); pu.quaternion.copy(u.q); g.add(pu); }
    parent.add(g);
    state.markGroup = g;
  }

  function _rebuildForwardArrow(){
    if(!state.scene) return;

    /* NOT REBUILT UNLESS THE ORIENTATION ACTUALLY CHANGED.

       applyValuesToScene runs on every gizmo drag event and, while the turret
       spin test is on, on every frame. Rebuilding here would allocate three
       geometries and a material sixty times a second for an arrow that has not
       moved, and the discarded ones are never disposed — a slow leak that only
       shows up after the editor has been left open. The signature is the whole
       input to the transform, so anything that would change the result changes
       it too. */
    var v0 = state.values.model;
    var sig = [v0.front || '', v0.up || '', v0.yaw || 0, v0.x || 0, v0.y || 0, v0.z || 0].join('|');
    if(sig === state._arrowSig && state.arrowGroup) return;
    state._arrowSig = sig;

    if(state.arrowGroup){
      try{ state.scene.remove(state.arrowGroup); }catch(e){}
      /* The rebuild guard above means this runs rarely, but "rarely" is not
         "never" — every axis click replaces the group, so the old geometry has
         to be freed here or a session of fiddling with the facing accumulates
         them. */
      state.arrowGroup.traverse(function(o){
        if(o.isMesh){
          if(o.geometry) o.geometry.dispose();
          if(o.material) o.material.dispose();
        }
      });
      state.arrowGroup = null;
    }
    state.forwardArrow = null;

    var v = state.values.model;
    var q = solveOrient(v.front, v.up);

    var g = new THREE.Group();
    var mat = new THREE.MeshBasicMaterial({ color: 0xffd24a, depthTest: false, transparent: true, opacity: 0.95 });
    var shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.4, 8), mat);
    shaft.rotation.x = Math.PI / 2;      /* cylinder is +Y; lay it along +Z */
    shaft.position.z = 1.9;
    var head = new THREE.Mesh(new THREE.ConeGeometry(0.36, 1.0, 12), mat);
    head.rotation.x = Math.PI / 2;
    head.position.z = 4.0;
    g.add(shaft); g.add(head);
    /* A flat chevron on the ground under the arrow, so the direction still
       reads when the camera is level with the tank and the arrow is edge-on. */
    var chev = new THREE.Mesh(
      new THREE.RingGeometry(1.15, 1.5, 3, 1, 0, Math.PI * 2),
      new THREE.MeshBasicMaterial({ color: 0xffd24a, depthTest: false, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
    );
    chev.rotation.x = -Math.PI / 2;
    chev.position.y = 0.06;
    chev.position.z = 2.2;
    g.add(chev);

    g.traverse(function(o){ if(o.isMesh){ o.renderOrder = 999; o.castShadow = false; o.receiveShadow = false; } });

    if(q){
      /* The arrow group is parented under the tank's ROOT (not bodyGroup),
         because the correction is applied to bodyGroup — so the arrow has to
         carry the same correction itself to point where the model will. */
      g.quaternion.copy(q);
      /* Follow the model's offset so the arrow starts at the nose of the hull
         rather than at the world origin, which is where it is anchored. */
      g.position.set(v.x || 0, (v.y || 0), (v.z || 0));
    } else {
      /* No pair declared: fall back to the yaw, so the arrow still means
         something on a model that has not been set up yet. */
      g.rotation.y = (v.yaw || 0) * Math.PI / 180;
      g.position.set(v.x || 0, (v.y || 0), (v.z || 0));
    }
    g.renderOrder = 999;
    state.scene.add(g);
    state.arrowGroup = g;
    state.forwardArrow = g;
  }

  /* WHERE DOES THE MODEL'S FRONT ACTUALLY END UP?

     Read off the live tank rather than recomputed, so the readout cannot
     disagree with the model on screen.

     The vector measured is the model's DECLARED FRONT AXIS carried through
     bodyGroup's world rotation — not bodyGroup's own +Z. Those are different
     things and only one of them answers the question: bodyGroup's local +Z is
     the hull frame's forward, which the correction deliberately rotates away,
     so testing it would report a correct model as broken. The reference it has
     to match is the direction the tank DRIVES, which is the root's +Z once the
     heading turn is taken off — at heading 0 that is world +Z.

     With no front declared there is no front axis to carry, so the yaw-only
     fallback reports bodyGroup's own +Z and is checked the same way. */
  function currentForward(){
    var t = state.tank;
    if(!t || !t._bodyOrient) return null;
    /* THE ORIENTATION GROUP'S OWN QUATERNION, not the hull's world one.

       The model hangs under bodyGroup (heading, tilt, lean) -> _bodyOrient (the
       correction) -> content. Both the model's front and the tank's drive
       direction are carried by bodyGroup, so bodyGroup cancels out of the
       comparison and what has to be checked is the correction alone:
       orientation * frontAxis == +Z. Reading the hull's world rotation instead
       would make the result depend on how far the tank happens to be turned,
       so a correct setting would read wrong the moment the preview steered. */
    var q = t._bodyOrient.quaternion;
    var v = state.values.model;

    var fSrc, uSrc;
    if(v.front && v.up){
      fSrc = axisVector(v.front);
      uSrc = axisVector(v.up);
    } else {
      /* No declared pair: the model's own +Z is the best guess available. */
      fSrc = new THREE.Vector3(0, 0, 1);
      uSrc = new THREE.Vector3(0, 1, 0);
    }
    return {
      f: fSrc.clone().applyQuaternion(q),
      u: uSrc.clone().applyQuaternion(q),
      declared: !!(v.front && v.up)
    };
  }

  /* Is the model pointing the way the tank drives? +Z forward, +Y up, in the
     frame the heading turn has been taken out of. */
  function orientIsSolved(cf){
    if(!cf) return false;
    return Math.abs(cf.f.x) < 0.02 && Math.abs(cf.f.y) < 0.02 && Math.abs(cf.f.z - 1) < 0.02
        && Math.abs(cf.u.x) < 0.02 && Math.abs(cf.u.y - 1) < 0.02 && Math.abs(cf.u.z) < 0.02;
  }

  /* ============================================================
     STATISTICS — everything measured off the model, so nothing about
     a tank's setup has to be typed in blind.
     ============================================================ */
  function measureStats(){
    var t = state.tank;
    if(!t || !t.root) return null;
    t.root.updateMatrixWorld(true);
    var out = {
      meshes: 0, tris: 0, nodes: 0, mats: 0, anims: 0,
      nodeNames: [],
      box: null, size: null, center: null,
      minY: 0, grounded: true,
      hasHull: false, hasTurret: false, hasPivot: !!t._modelTurretPivot,
      barrelEnd: null,
    };
    var seenMat = {};
    var box = new THREE.Box3().makeEmpty();
    t.root.traverse(function(o){
      /* EVERY named node is listed, not just named meshes, because the node
         names are the thing a rig has to be written against: `rig:{hull:…,
         turret:…}` in config.js refers to them by name, and the convention the
         loader looks for is exactly these (hull, turret, gun, shell, firing,
         muzzle, hitbox). A model whose turret node is called "Cube007" cannot
         be set up by anyone who cannot see that it is called "Cube007". */
      if(o.name && o.name !== 'bodyParts' && o.name !== 'turretParts'){
        out.nodes++;
        if(out.nodeNames.length < 80) out.nodeNames.push(o.name);
      }
      if(o.isMesh && o.geometry){
        var g = o.geometry;
        if(!g.boundingBox) g.computeBoundingBox();
        var bb = g.boundingBox;
        if(bb){
          o.updateWorldMatrix(true, false);
          var m = o.matrixWorld;
          var v = new THREE.Vector3();
          for(var i = 0; i < 8; i++){
            v.set((i & 1) ? bb.max.x : bb.min.x,
                  (i & 2) ? bb.max.y : bb.min.y,
                  (i & 4) ? bb.max.z : bb.min.z);
            v.applyMatrix4(m);
            box.expandByPoint(v);
          }
        }
        var pos = g.attributes && g.attributes.position;
        if(pos) out.tris += Math.floor(pos.count / 3);
        out.meshes++;
        var mt = o.material;
        (Array.isArray(mt) ? mt : [mt]).forEach(function(mm){ if(mm && !seenMat[mm.uuid]){ seenMat[mm.uuid] = 1; out.mats++; } });
        var n = String(o.name || '').toLowerCase().replace(/[\s_]/g,'');
        if(n === 'hull') out.hasHull = true;
        if(n === 'turret') out.hasTurret = true;
      }
    });
    if(box.isEmpty()) return out;
    out.box = box;
    out.size = box.getSize(new THREE.Vector3());
    out.center = box.getCenter(new THREE.Vector3());
    out.minY = box.min.y;
    /* "Grounded" means the hull actually reaches the floor plane: a model
       hovering a metre up is the single most common thing to get wrong on
       import, and it is invisible from a low camera. */
    out.grounded = box.min.y < 0.35;

    /* The clip count is not on the tank — the clips live on the cached model and
       the tank only borrows them. */
    try {
      var cache = (window.Models && Models._cache && t.def && Models._cache[t.def.model]);
      if(cache && cache.anims) out.anims = cache.anims.length;
    } catch(e){}

    if(t.barrelEnd && t.barrelEnd.parent){
      out.barrelEnd = new THREE.Vector3();
      t.barrelEnd.getWorldPosition(out.barrelEnd);
    }
    return out;
  }

  function statsHtml(){
    var s = state.stats;
    if(!s){ return '<div class="te-note">Load a model to see its measurements.</div>'; }
    if(!s.box){ return '<div class="te-note">Model has no geometry to measure.</div>'; }
    var rows = [
      ['Meshes', s.meshes],
      ['Triangles', s.tris],
      ['Nodes', s.nodes],
      ['Materials', s.mats],
      ['Anim clips', s.anims],
    ];
    var html = '';
    for(var i = 0; i < rows.length; i++){
      html += '<div class="te-stat"><span>' + rows[i][0] + '</span><b>' + rows[i][1] + '</b></div>';
    }
    html += '<div class="te-mode-title">SIZE (world units)</div>';
    html += '<div class="te-stat"><span>Width X</span><b>' + (s.size.x).toFixed(2) + '</b></div>';
    html += '<div class="te-stat"><span>Height Y</span><b>' + (s.size.y).toFixed(2) + '</b></div>';
    html += '<div class="te-stat"><span>Length Z</span><b>' + (s.size.z).toFixed(2) + '</b></div>';
    html += '<div class="te-stat"><span>Lowest point</span><b>' + s.minY.toFixed(2) + '</b></div>';
    html += '<div class="te-stat' + (s.grounded ? '' : ' te-stat-warn') + '"><span>On the ground</span><b>' +
            (s.grounded ? 'yes' : 'NO — floats') + '</b></div>';
    html += '<div class="te-mode-title">RIG</div>';
    html += '<div class="te-stat"><span>hull node</span><b>' + (s.hasHull ? 'yes' : 'no') + '</b></div>';
    html += '<div class="te-stat"><span>turret node</span><b>' + (s.hasTurret ? 'yes' : 'no') + '</b></div>';
    html += '<div class="te-stat"><span>turret pivot</span><b>' + (s.hasPivot ? 'yes' : 'no') + '</b></div>';
    if(s.barrelEnd){
      html += '<div class="te-stat"><span>Muzzle at</span><b>' +
              s.barrelEnd.toArray().map(function(n){ return n.toFixed(1); }).join(', ') + '</b></div>';
    }
    /* The node names, because a rig is written by name and there is no other
       way to find out what this particular GLB happens to call its parts. */
    if(s.nodeNames && s.nodeNames.length){
      html += '<div class="te-mode-title">NODE NAMES</div>';
      html += '<div class="te-note" style="margin-bottom:5px">hull / turret / gun / shell / firing / muzzle / hitbox are the names the loader looks for.</div>';
      html += '<div class="te-nodelist">' +
              s.nodeNames.map(function(n){ return '<span>' + n + '</span>'; }).join('') +
              '</div>';
    }
    return html;
  }

  function clearTank(){
    /* Invalidate any build still in flight, so a tank whose model arrives after
       this point knows it is stale and does not add itself to the scene. */
    state._buildGen = (state._buildGen || 0) + 1;
    if(state.gizmo) state.gizmo.detach();
    if(state.tank){
      try{ if(state.scene) state.scene.remove(state.tank.root); }catch(e){}
      state.tank = null;
    }
    if(state.bodyBox){ try{ state.scene.remove(state.bodyBox); }catch(e){} state.bodyBox = null; }
    if(state.boxWire){ try{ state.scene.remove(state.boxWire); }catch(e){} state.boxWire = null; }
    if(state.pivotMarker){ try{ state.scene.remove(state.pivotMarker); }catch(e){} state.pivotMarker = null; }
    if(state.turretMarker){ try{ state.scene.remove(state.turretMarker); }catch(e){} state.turretMarker = null; }
    if(state.shellMarker){ try{ state.scene.remove(state.shellMarker); }catch(e){} state.shellMarker = null; }
    if(state.casingMarker){ try{ state.scene.remove(state.casingMarker); }catch(e){} state.casingMarker = null; }
    if(state.tankCenterMarker){ try{ state.scene.remove(state.tankCenterMarker); }catch(e){} state.tankCenterMarker = null; }
    if(state.modelMarker){ try{ state.scene.remove(state.modelMarker); }catch(e){} state.modelMarker = null; }
    if(state.arrowGroup){
      try{ state.scene.remove(state.arrowGroup); }catch(e){}
      /* Dispose what was built rather than just dropping the reference: the
         arrow's geometry is its own, not shared from the model cache. */
      state.arrowGroup.traverse(function(o){
        if(o.isMesh){
          if(o.geometry) o.geometry.dispose();
          if(o.material) o.material.dispose();
        }
      });
      state.arrowGroup = null;
    }
    state.forwardArrow = null;
    state._arrowSig = null;
    /* The face patches belong to the model that is being torn down, so they go
       with it — otherwise a new tank would inherit the previous tank's red
       patch and, worse, its authored-space position, which means nothing here. */
    state.faceMarks = { front: null, up: null };
    state.markGroup = null;
    state._markSig = null;
    state.stats = null;
  }

  function makeMarker(color, size){
    var m = new THREE.Mesh(
      new THREE.OctahedronGeometry(size || 0.22, 0),
      new THREE.MeshBasicMaterial({color: color})
    );
    m.castShadow = false;
    return m;
  }

  function makeModelMarker(){
    var g = new THREE.Group();
    g.add(makeMarker(0x9b8cff, 0.16));
    // forward cone pointing +Z (game forward) so the facing is readable
    var cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.5, 8),
      new THREE.MeshBasicMaterial({color: 0xffd24a})
    );
    cone.rotation.x = Math.PI / 2;
    cone.position.z = 0.55;
    g.add(cone);
    g.userData.parent = null;
    return g;
  }

  function syncModelUI(){
    var a = state.values.model;
    var ab = $id('te-anim'), ob = $id('te-outline');
    if(ab){ ab.textContent = 'Animation'; ab.classList.toggle('te-on', !!a.anim); }
    if(ob){ ob.textContent = 'Outline'; ob.classList.toggle('te-on', !!a.outline); }
  }

  function toggleModelFlag(key){
    state.values.model[key] = !state.values.model[key];
    var patch = { model: Object.assign({}, state.values.model) };
    setOv(state.selected, patch);
    pushHistory();
    // Rebuild so animation playback / outlines actually take effect
    pickTank(state.selected);
  }

  function buildMarkers(){
    if(!state.tank) return;
    if(state.scene) state.scene.updateMatrixWorld(true);
    var t = state.tank;
    var def = t.def;

    // ---- Hitbox box (matches def.body dims; scaled by the gizmo) ----
    var b = state.values.body;
    state.bodyBox = new THREE.Mesh(
      new THREE.BoxGeometry(b.w, b.h, b.l),
      new THREE.MeshBasicMaterial({color: 0x22ff88, transparent: true, opacity: 0.22, depthWrite: false})
    );
    state.bodyBox.position.y = b.h / 2 + 0.45;
    state.boxWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(b.w, b.h, b.l)),
      new THREE.LineBasicMaterial({color: 0x22ff88})
    );
    state.boxWire.position.copy(state.bodyBox.position);
    state.scene.add(state.bodyBox);
    state.scene.add(state.boxWire);

    // ---- Pivot marker (local offset from the turret parts origin) ----
    // If the model has a dedicated pivot node, read it (it already carries
    // any saved override via _applyEditorOverrides); otherwise the turret
    // rotates about the hull center.
    var pivotLocal = { x: 0, y: 0, z: 0 };
    if(t._modelTurretPivot){
      pivotLocal = { x: t._modelTurretPivot.position.x, y: t._modelTurretPivot.position.y, z: t._modelTurretPivot.position.z };
    }
    var pivotParent = t._modelTurretPivot ? t._modelTurretPivot.parent : t.turretGroup;
    state.pivotMarker = makeMarker(0x33ccff);
    state.pivotMarker.userData.parent = pivotParent;
    state.pivotMarker.position.copy(pivotParent.localToWorld(new THREE.Vector3(pivotLocal.x, pivotLocal.y, pivotLocal.z)));
    state.scene.add(state.pivotMarker);
    state.values.pivot = { x: round(pivotLocal.x), y: round(pivotLocal.y), z: round(pivotLocal.z) };

    // ---- Turret mount marker (where the turret sits on the hull at 0°) ----
    // Only named models carry a real home point; cube tanks have no separate
    // turret part to move, so no marker.
    var turretParent = t._modelTurretPivot ? t._modelTurretPivot.parent : null;
    var home = t._turretHome;
    if(turretParent && home){
      state.turretMarker = makeMarker(0xffd24a, 0.2);
      state.turretMarker.userData.parent = turretParent;
      state.turretMarker.position.copy(turretParent.localToWorld(new THREE.Vector3(home.x, home.y, home.z)));
      state.scene.add(state.turretMarker);
      state.values.turret = { x: round(home.x), y: round(home.y), z: round(home.z) };
    }

    // ---- Shell spawn marker (local offset inside the barrel/turret) ----
    var shellLocal = { x: 0, y: 0, z: 0 };
    var shellParent = t.turretGroup;
    if(t.barrelEnd && t.barrelEnd.parent){
      shellLocal = { x: t.barrelEnd.position.x, y: t.barrelEnd.position.y, z: t.barrelEnd.position.z };
      shellParent = t.barrelEnd.parent;
    }
    state.shellMarker = makeMarker(0xff5566, 0.18);
    state.shellMarker.userData.parent = shellParent;
    state.shellMarker.position.copy(shellParent.localToWorld(new THREE.Vector3(shellLocal.x, shellLocal.y, shellLocal.z)));
    state.scene.add(state.shellMarker);
    state.values.shell = { x: round(shellLocal.x), y: round(shellLocal.y), z: round(shellLocal.z) };

    // ---- Shell (casing) eject point — where the ejected cartridge with a
    //      rigidbody flies out of. Lives in turretGroup space via the cached
    //      bind-pose offset so the "gun firing" clip can't skew it. ----
    var casingOffset = t._casingOffset;
    if(casingOffset){
      state.casingMarker = makeMarker(0xff88cc, 0.15);
      state.casingMarker.userData.parent = t.turretGroup;
      state.casingMarker.position.copy(t.turretGroup.localToWorld(casingOffset.clone()));
      state.scene.add(state.casingMarker);
      state.values.casing = { x: round(casingOffset.x), y: round(casingOffset.y), z: round(casingOffset.z) };
    } else {
      state.values.casing = { x: 0, y: 0, z: 0 };
    }

    // ---- Tank center indicator — where the whole tank rotates/steers from
    //      (the hull pivot at the model origin). Informational, not editable.
    state.tankCenterMarker = makeMarker(0x666666, 0.1);
    state.scene.add(state.tankCenterMarker);
    var tankC = new THREE.Vector3();
    state.tank.root.getWorldPosition(tankC);
    state.tankCenterMarker.position.copy(tankC);

    // ---- Whole-model marker: drag to move the model (translate) or set its
    //      facing (rotate Y). Values live in the tank-root frame, which equals
    //      world space while the preview sits at the origin.
    state.modelMarker = makeModelMarker();
    state.scene.add(state.modelMarker);
    var mo = t._modelOff || new THREE.Vector3();
    state.values.model.x = round(mo.x);
    state.values.model.y = round(mo.y);
    state.values.model.z = round(mo.z);
    state.values.model.yaw = Math.round((t._modelYaw || 0) * 180 / Math.PI);
    syncModelUI();

    // The values above already include any saved override (they are read from
    // the live nodes) — just pin the gizmo target to them and show the axes.
    applyValuesToScene();
    /* Measured once the model is actually in the tree, not before: the box,
       the triangle count and the muzzle position are all read off live geometry
       and are meaningless against an unloaded model. */
    state.stats = measureStats();
    state.statsDirty = !state.stats;
    /* Painted straight into the status bar here, because renderFields() is only
       called for the stats mode just below — so on every other mode the bar
       stayed empty until the user happened to make an edit.

       And retried, because this runs BEFORE the model is in the tree: the GLB is
       fetched asynchronously, so the first measurement always comes back null.
       Twelve tries over three seconds covers a slow load without leaving a
       timer running for the rest of the session, and it stops the moment the
       measurement succeeds. */
    refreshFootInfo();
    (function retry(remaining){
      if(remaining <= 0 || state.stats) return;
      setTimeout(function(){
        state.stats = measureStats();
        if(state.stats){ state.statsDirty = false; refreshFootInfo(); }
        retry(remaining - 1);
      }, 250);
    })(12);
    if(state.mode === 'stats') renderFields();
    setMode(state.mode);
    pushHistory();
    showNote();
    syncSpinUI();
  }

  /* ------------------------------------------------------------
     Value <-> scene sync
     ------------------------------------------------------------ */
  /* THE TREADS ON THE PREVIEW TANK.

     A slider for a wheel count changes how many objects exist, so this cannot be
     a transform tweak — the geometry has to be thrown away and rebuilt. It is
     a separate function rather than a branch inside applyValuesToScene because
     everything in that function MOVES things and this REPLACES things, and the
     two have very different failure modes.

     The rebuild is deferred to the next frame. Dragging a slider fires this on
     every input event, and rebuilding a dozen cylinders plus their outlines
     inside a pointermove handler is enough to drop frames and make the slider
     feel like it is dragging the tank through treacle. */
  var _tracksPending = false;
  function rebuildTracksPreview(){
    if(_tracksPending) return;
    _tracksPending = true;
    var go = function(){
      _tracksPending = false;
      try {
        var t = state.tank;
        if(!t) return;
        if(t.tracks) t.tracks = Tank.resolveTracks(t.def, ovFor(state.selected) || {});
        /* Ask the TANK to re-decide, not the editor. The tank knows whether it
           loaded a model and whether that model carries its own wheels, and
           `_applyTrackGearPolicy` is the single place that answers. Rebuilding
           here by hand left the model's baked-in wheels visible underneath the
           new ones whenever `replace` was switched on — two sets of wheels on
           one tank, and the editor looked broken rather than wrong. */
        if(t._applyTrackGearPolicy) t._applyTrackGearPolicy();
        else if(t._trackGroup && t.bodyGroup){
          if(t._trackGroup.parent) t._trackGroup.parent.remove(t._trackGroup);
          if(t._clearGroup) t._clearGroup(t._trackGroup);
          t._trackGroup = null;
          t._buildTracks(t.bodyGroup, 2.0);
        }
        /* The editor draws its own key light, so the rebuilt treads need to be
           told about it or they arrive unlit and read as black holes. */
        if(t._trackWheels && t._trackWheels.length) t._shadowDirty = true;
      } catch(e){ console.warn('[tank-editor] tracks rebuild:', e); }
    };
    if(typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    else setTimeout(go, 0);
  }

  function applyValuesToScene(){
    if(!state.tank) return;
    var v = state.values;

    if(state.bodyBox && state.boxWire){
      var b = v.body;
      state.bodyBox.scale.set(
        clamp(b.w / state.bodyBox.geometry.parameters.width, 0.05, 20),
        clamp(b.h / state.bodyBox.geometry.parameters.height, 0.05, 20),
        clamp(b.l / state.bodyBox.geometry.parameters.depth, 0.05, 20)
      );
      // keep the box bottom pinned on the ground plane
      var hs = (b.h / 2) * state.bodyBox.scale.y;
      state.bodyBox.position.y = hs + 0.45;
      state.boxWire.scale.copy(state.bodyBox.scale);
      state.boxWire.position.copy(state.bodyBox.position);
    }

    if(state.pivotMarker && state.pivotMarker.userData.parent && state.pivotMarker.userData.parent.isObject3D){
      var pLocal = new THREE.Vector3(v.pivot.x, v.pivot.y, v.pivot.z);
      state.pivotMarker.position.copy(state.pivotMarker.userData.parent.localToWorld(pLocal));
    }

    if(state.turretMarker && state.turretMarker.userData.parent && state.turretMarker.userData.parent.isObject3D){
      var uLocal = new THREE.Vector3(v.turret.x, v.turret.y, v.turret.z);
      state.turretMarker.position.copy(state.turretMarker.userData.parent.localToWorld(uLocal));
    }

    // Live-apply pivot + turret placement to the preview tank so the model
    // follows the marker drags (pivot moves rotation only; turret marker
    // moves the mount point only) and the firing marker rides along.
    if(state.tank && state.tank._modelTurretPivot && state.tank._turretHome && state.tank._turretG){
      state.tank._modelTurretPivot.position.set(v.pivot.x, v.pivot.y, v.pivot.z);
      state.tank._turretHome.set(v.turret.x, v.turret.y, v.turret.z);
      if(state.tank._applyTurretPlacement) state.tank._applyTurretPlacement();
    }

    if(state.shellMarker && state.shellMarker.userData.parent && state.shellMarker.userData.parent.isObject3D){
      var sLocal = new THREE.Vector3(v.shell.x, v.shell.y, v.shell.z);
      state.shellMarker.position.copy(state.shellMarker.userData.parent.localToWorld(sLocal));
    }

    if(state.casingMarker && state.casingMarker.userData.parent && state.casingMarker.userData.parent.isObject3D){
      var cLocal = new THREE.Vector3(v.casing.x, v.casing.y, v.casing.z);
      state.casingMarker.position.copy(state.casingMarker.userData.parent.localToWorld(cLocal));
      if(state.tank && state.tank._casingOffset) state.tank._casingOffset.set(v.casing.x, v.casing.y, v.casing.z);
    }

    if(state.modelMarker){
      var mv = v.model;
      state.modelMarker.position.set(mv.x || 0, mv.y || 0, mv.z || 0);
      state.modelMarker.rotation.set(0, (mv.yaw || 0) * Math.PI / 180, 0);
      if(state.tank && state.tank._syncTransform){
        /* THE ORIENTATION, NOT JUST THE YAW.

           A declared front/up pair is handed to the tank as the solved
           quaternion and the yaw is forced to zero, because applying both
           would spin the model twice. This is the same branch tank.js takes,
           reached through the same function, so the preview and the match
           cannot disagree about what the arrows mean. */
        var q = solveOrient(mv.front, mv.up);
        if(q){
          state.tank._modelQuat = q;
          state.tank._modelYaw = 0;
        } else {
          state.tank._modelQuat = null;
          state.tank._modelYaw = (mv.yaw || 0) * Math.PI / 180;
        }
        /* Push it onto the orientation groups. The tank keeps the correction on
           its own nodes rather than folding it into the heading euler, precisely
           so the drift and momentum lean cannot damp it away. */
        if(state.tank._applyModelQuat) state.tank._applyModelQuat();
        if(!state.tank._modelOff) state.tank._modelOff = new THREE.Vector3();
        state.tank._modelOff.set(mv.x || 0, mv.y || 0, mv.z || 0);
        state.tank._syncTransform();
      }
    }
    /* The arrow and the readout follow every edit, whatever moved them. It is
       rebuilt rather than rotated in place because the axis buttons change the
       solution wholesale, not incrementally. */
    _rebuildForwardArrow();
    /* Everything measured off the model — size, ground contact, triangle count
       — is now out of date. Marked dirty rather than measured here; see
       refreshFootInfo. */
    state.statsDirty = true;
    /* The tank's heading and lean are applied by _syncTransform on the same
       call, so a patch parented to the orientation group has already moved with
       them — this only re-runs when the marks themselves are absent, which is
       the case right after a model finishes loading. */
    if(state.faceMarks.front || state.faceMarks.up) _rebuildFaceMarks();
    refreshFacingReadout();
  }

  /* The solved readout is written into an element that renderFields() REBUILDS.
     Every edit runs applyValuesToScene() and then renderFields(), in that order,
     so a readout written by the first was thrown away by the second and the
     panel sat showing its initial em-dash no matter what the model was doing —
     which reads as "the editor cannot solve this", when in fact it could. It is
     its own function so both ends of that sequence can call it. */
  function refreshFacingReadout(){
    var fr = $id('te-fwd-readout');
    var banner = $id('te-setup-state');
    var v = state.values.model;
    var ok = orientIsSolved(currentForward());
    /* orientIsSolved is NOT the completeness test. It asks whether the resulting
       pose is a clean axis-aligned one, and the plain-yaw fallback answers yes
       to that with nothing declared at all — which is why an empty tank has
       been reporting SOLVED all along. Completeness is a separate question:
       both axes declared, and two different ones. */
    var complete = !!(v.front && v.up && v.front !== v.up && ok);

    if(banner){
      /* ONE LINE THAT ANSWERS "IS THIS TANK SET UP YET". The numbers below
         answer "is it right", which is a different question and a much slower
         one to check by eye. Missing front, missing up, the same axis twice,
         or a pair that does not solve are four different mistakes that all
         look identical on a model that merely looks odd, so they are named
         rather than lumped together as "not solved". */
      var why;
      if(!v.front && !v.up)        why = 'Nothing picked yet — click the tank’s front.';
      else if(!v.front)            why = 'FRONT is missing — click the end it drives out of.';
      else if(!v.up)               why = 'UP is missing — press “set UP” and click the roof.';
      else if(v.front === v.up)    why = 'FRONT and UP are the same axis (' + v.front + ') — pick another face.';
      else if(!ok)                 why = 'That pair does not solve — try a different UP.';
      else                         why = 'SETUP COMPLETE — the red patch marks the front face.';
      banner.textContent = why;
      banner.className = 'te-setupstate ' + (complete ? 'te-ok' : 'te-warn');
    }

    if(!fr) return;
    var cf = currentForward();
    if(cf){
      fr.textContent = 'forward ' + fmtAxis(cf.f) + ' · up ' + fmtAxis(cf.u);
      fr.className = 'te-angle' + (orientIsSolved(cf) ? ' te-ok' : ' te-warn');
    } else {
      fr.textContent = '—';
      fr.className = 'te-angle';
    }
  }

  /* A vector as three signed numbers, for the readout. */
  function fmtAxis(v){
    return '(' + v.x.toFixed(2) + ', ' + v.y.toFixed(2) + ', ' + v.z.toFixed(2) + ')';
  }

  function syncFromGizmo(){
    if(!state.tank) return;
    var g = state.gizmo.object;

    if(g === state.bodyBox){
      var gp = state.bodyBox.geometry.parameters;
      state.values.body.w = round(gp.width * state.bodyBox.scale.x);
      state.values.body.h = round(gp.height * state.bodyBox.scale.y);
      state.values.body.l = round(gp.depth * state.bodyBox.scale.z);
      // re-clamp & re-pin
      state.bodyBox.scale.set(
        clamp(state.values.body.w / gp.width, 0.05, 20),
        clamp(state.values.body.h / gp.height, 0.05, 20),
        clamp(state.values.body.l / gp.depth, 0.05, 20)
      );
      var hs = (state.values.body.h / 2) * state.bodyBox.scale.y;
      state.bodyBox.position.y = hs + 0.45;
      state.boxWire.scale.copy(state.bodyBox.scale);
      state.boxWire.position.copy(state.bodyBox.position);
      state.values.body.w = round(gp.width * state.bodyBox.scale.x);
      state.values.body.h = round(gp.height * state.bodyBox.scale.y);
      state.values.body.l = round(gp.depth * state.bodyBox.scale.z);
    }

    if(g === state.pivotMarker && state.pivotMarker.userData.parent){
      var pLocal = state.pivotMarker.userData.parent.worldToLocal(state.pivotMarker.position.clone());
      state.values.pivot = { x: round(pLocal.x), y: round(pLocal.y), z: round(pLocal.z) };
    }

    if(g === state.turretMarker && state.turretMarker.userData.parent){
      var uLocal = state.turretMarker.userData.parent.worldToLocal(state.turretMarker.position.clone());
      state.values.turret = { x: round(uLocal.x), y: round(uLocal.y), z: round(uLocal.z) };
    }

    if(g === state.shellMarker && state.shellMarker.userData.parent){
      var sLocal = state.shellMarker.userData.parent.worldToLocal(state.shellMarker.position.clone());
      state.values.shell = { x: round(sLocal.x), y: round(sLocal.y), z: round(sLocal.z) };
    }

    if(g === state.casingMarker && state.casingMarker.userData.parent){
      var cLocal = state.casingMarker.userData.parent.worldToLocal(state.casingMarker.position.clone());
      state.values.casing = { x: round(cLocal.x), y: round(cLocal.y), z: round(cLocal.z) };
    }

    if(g === state.modelMarker){
      state.values.model.x = round(g.position.x);
      state.values.model.y = round(g.position.y);
      state.values.model.z = round(g.position.z);
      var ry = Math.round(g.rotation.y * 180 / Math.PI);
      while(ry > 180) ry -= 360;
      while(ry <= -180) ry += 360;
      state.values.model.yaw = ry;
      // move the preview tank in real time so the drag is visible
      applyValuesToScene();
    }

    renderFields();
  }

  /* ------------------------------------------------------------
     Undo / redo (Ctrl+Z / Ctrl+Y) + the top-right orientation
     widget. History snapshots the whole values object each time a
     drag or field edit ends.
     ------------------------------------------------------------ */
  function deepClone(v){ return JSON.parse(JSON.stringify(v)); }

  function pushHistory(){
    var snap = deepClone(state.values);
    var h = state.history;
    // drop any redo tail
    if(state.historyIdx < h.length - 1) h = h.slice(0, state.historyIdx + 1);
    // don't stack identical consecutive snapshots
    if(h.length && JSON.stringify(h[h.length - 1]) === JSON.stringify(snap)) return;
    h.push(snap);
    if(h.length > 80) h.shift();
    state.historyIdx = h.length - 1;
    state.history = h;
  }

  function restoreSnapshot(snap){
    state.values = deepClone(snap);
    if(state.gizmo) state.gizmo.detach();
    rebuildBodyBox();
    applyValuesToScene();
    setMode(state.mode);
    renderFields();
  }

  function undo(){
    if(state.historyIdx <= 0) return;
    state.historyIdx--;
    restoreSnapshot(state.history[state.historyIdx]);
  }

  function redo(){
    if(state.historyIdx >= state.history.length - 1) return;
    state.historyIdx++;
    restoreSnapshot(state.history[state.historyIdx]);
  }

  function rebuildBodyBox(){
    if(!state.bodyBox || !state.boxWire) return;
    var b = state.values.body;
    var gp = state.bodyBox.geometry.parameters;
    var same = gp && Math.abs(gp.width - b.w) < 0.001 &&
                     Math.abs(gp.height - b.h) < 0.001 &&
                     Math.abs(gp.depth - b.l) < 0.001;
    if(same) return;
    state.bodyBox.geometry.dispose();
    state.bodyBox.geometry = new THREE.BoxGeometry(b.w, b.h, b.l);
    state.boxWire.geometry.dispose();
    state.boxWire.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(b.w, b.h, b.l));
  }

  /* PER-AXIS VISIBILITY IS GONE FROM THE GIZMO.

       The old editor hid the arrows it did not need (`showX/showY/showZ = false`
       when rotating about Y only). Those properties do not exist on the r169+
       TransformControls at all — not on the controls and not on the helper — so
       there is nothing to set and the call is kept as an explicit no-op rather
       than deleted, to record that the capability is genuinely absent and not
       merely forgotten. The Facing mode does not rely on it: the axis choice
       there is made by clicking labelled buttons, not by dragging a handle. */
  function setGizmoAxes(x, y, z){
    /* intentionally empty — see the note above */
  }

  function setMode(mode){
    state.mode = mode;
    document.querySelectorAll('.te-mode').forEach(function(m){
      m.classList.toggle('te-on', m.dataset.mode === mode);
    });
    if(state.gizmo){
      if(mode === 'rotate'){
        /* THE ORIENTATION GROUP IS THE ROTATE TARGET, and the numbers are read
           back out of it rather than the other way round.

           The group already carries the front/up correction, so driving it
           directly is what makes the rotation WYSIWYG. The read-back then
           recovers ONLY the extra rotation: the group's quaternion is
           euler * correction, so dividing out the correction leaves exactly
           the part the user turned, which is what goes into the fields.

           That division is the whole trick. Reading the group's euler straight
           out would save the facing correction as a rotation as well, and the
           two would then be applied twice — the classic "I turned it 90° and
           it went 180°" bug. */
        if(state.tank && state.tank._bodyOrient){
          state.gizmo.attach(state.tank._bodyOrient);
          state.gizmo.setMode('rotate');
          setGizmoAxes(true, true, true);
        } else {
          try{ state.gizmo.detach(); }catch(e){}
        }
      } else if(mode === 'scale'){
        /* Scale drives the orientation group's SCALE during the drag so the
           model grows in front of you, and the value is read off on release
           and handed to modelScale — which is the only place the game can act
           on it, because tank.js bakes it at load. See _onScaleGizmo. */
        if(state.tank && state.tank._bodyOrient){
          state.gizmo.attach(state.tank._bodyOrient);
          state.gizmo.setMode('scale');
          state.tank._bodyOrient.scale.setScalar(1);
          state.gizmo.setSpace('local');
        } else {
          try{ state.gizmo.detach(); }catch(e){}
        }
      } else if(mode === 'facing' || mode === 'stats'){
        /* Neither has a gizmo target: the facing mode is answered by clicking
           the axis buttons (the arrow in the scene is a readout, not a handle —
           dragging it would move the tank, not reorient it), and the stats mode
           is read-only. Detaching is deliberate, so a stale handle from the
           previous mode cannot still be dragged by accident. */
        try{ state.gizmo.detach(); }catch(e){}
      } else if(mode === 'hitbox' && state.bodyBox){
        state.gizmo.attach(state.bodyBox);
        state.gizmo.setMode('scale');
        setGizmoAxes(true, true, true);
      } else if(mode === 'pivot' && state.pivotMarker){
        state.gizmo.attach(state.pivotMarker);
        state.gizmo.setMode('translate');
        setGizmoAxes(true, true, true);
      } else if(mode === 'turret' && state.turretMarker){
        state.gizmo.attach(state.turretMarker);
        state.gizmo.setMode('translate');
        setGizmoAxes(true, true, true);
      } else if(mode === 'shell' && state.shellMarker){
        state.gizmo.attach(state.shellMarker);
        state.gizmo.setMode('translate');
        setGizmoAxes(true, true, true);
      } else if(mode === 'casing' && state.casingMarker){
        state.gizmo.attach(state.casingMarker);
        state.gizmo.setMode('translate');
        setGizmoAxes(true, true, true);
      } else if(mode === 'model' && state.modelMarker){
        state.gizmo.attach(state.modelMarker);
        state.gizmo.setMode('translate');
        setGizmoAxes(true, true, true);
      } else if(mode === 'front' && state.modelMarker){
        state.gizmo.attach(state.modelMarker);
        state.gizmo.setMode('rotate');
        setGizmoAxes(false, true, false);
      } else {
        try{ state.gizmo.detach(); }catch(e){}
      }
    }
    renderFields();
    showNote();
  }

  function showNote(){
    var el = $id('te-note');
    if(!el) return;
    var msg = '';
    if(state.mode === 'hitbox'){
      msg = 'Scale the green box to set the collision hitbox. Green = front length (Z), width (X) is the sides, height (Y). The gray diamond is the tank\u2019s rotation/steering center (hull center).';
    } else if(state.mode === 'pivot'){
      if(!state.tank || !state.tank._modelTurretPivot){
        msg = 'This model has no dedicated turret pivot — it rotates about the hull center. Pick a model with a named "turret" group (Cool Buddy etc.) to move its rotation point.';
      } else {
        msg = 'BLUE = the point the turret ROTATES around. Drag it and the rotation axis moves but the turret mesh stays put. Default is the turret\u2019s own center.';
      }
    } else if(state.mode === 'turret'){
      if(!state.tank || !state.tank._turretHome){
        msg = 'This model has no separate turret part to move (it\u2019s the simple cube build). Use the Pivot/rotation point mode instead.';
      } else {
        msg = 'GOLD = where the turret SITS on the hull (its center at 0\u00B0). Drag it to move the turret; the blue rotation point is independent.';
      }
    } else if(state.mode === 'shell'){
      msg = 'RED = the FIRE point: where the bullet/projectile actually spawns (at the muzzle). Drag it onto the barrel tip. The pink marker is the shell/casing eject point (a separate marker below).';
    } else if(state.mode === 'casing'){
      if(!state.casingMarker){
        msg = 'This model has no casing port, so the casing ejects from the fire point.';
      } else {
        msg = 'PINK = the shell/casing point: where the ejected cartridge (a tiny rigidbody) flies out when firing. Drag it anywhere next to the red fire point.';
      }
    } else if(state.mode === 'model'){
      msg = 'PURPLE = the whole model. Drag the arrows to nudge the body/turret (offset), or type offsets below. Use "Face / set front" to spin the model\u2019s facing, then hit Save \u2014 every client gets the same look.';
    } else if(state.mode === 'front'){
      msg = 'Drag the gold ring to aim the model\u2019s front (the barrel should point toward +Z, your movement forward). Purple is the model center. Save to apply to all clients.';
    } else if(state.mode === 'facing'){
      msg = 'THE BIG ARROW shows the way the tank will actually DRIVE. Look at the model, decide which way its nose points, click that axis under FRONT, then which way its roof points under UP. The readout under "Solved" must read forward (0,0,1) and up (0,1,0) — that is the whole test, and it is the only way to know for certain, because a GLB does not record which end is the front.';
    } else if(state.mode === 'stats'){
      msg = 'Everything here is measured off the model that is loaded, not typed in. Check "On the ground" first: a model that floats is the most common import mistake and is invisible from a low camera.';
    }
    el.textContent = msg;
  }

  /* ------------------------------------------------------------
     Numeric fields
     ------------------------------------------------------------ */
  function renderFields(){
    var el = $id('te-fields');
    if(!el) return;
    var v = state.values;
    var html = '';

    if(state.mode === 'facing'){
      /* THE PANEL THAT MATTERS, and the only thing on it that has to be
         understood: point at the tank. Click the end you are calling the
         front and the editor reads which authored axis it is, so nobody has
         to open the GLB and find out for themselves.

         A click sets the FRONT, because that is what a point on the model
         tells you reliably. The UP is one button away, and then the click
         reads the roof instead. The two are separated deliberately: any
         single rule that tried to tell them apart from one click failed on
         real tanks, and the measurements are written up at pickFromPointer. */
      html += '<div class="te-pick">'
            + '<div class="te-pick-title">CLICK THE TANK\u2019S FRONT</div>'
            + '<div class="te-pick-hint">Click the end the tank drives out of.</div>'
            + '<div class="te-pick-row">'
            +   pickArmBtn('front', 'set FRONT') + pickArmBtn('up', 'set UP instead')
            + '</div>'
            + '<div class="te-pick-hint" style="margin:7px 0 0">'
            +   'For the roof, press <b>set UP</b> then click it.'
            + '</div></div>';
      html += '<div class="te-sub">FRONT is</div>';
      html += axisButtons('te-front-axes', 'front', v.model.front);
      html += '<div class="te-sub" style="margin-top:8px">UP is</div>';
      html += axisButtons('te-up-axes', 'up', v.model.up);
      html += '<div class="te-sub" style="margin-top:10px">Solved</div>';
      html += '<div class="te-stat"><span>forward / up</span><b id="te-fwd-readout" class="te-angle">—</b></div>';
      html += '<div id="te-orient-note" class="te-note"></div>';
      html += '<div class="te-sub" style="margin-top:10px">Fine tune (yaw nudge)</div>';
      html += field('model.yaw', 'Extra yaw (deg)', v.model.yaw, -360, 360);
      return bindFields(html);
    }

    if(state.mode === 'stats'){
      html += statsHtml();
      html += '<div class="te-note" style="margin-top:10px">Measured off the loaded model, not typed in. Copy the report to send it with a setup.</div>';
      el.innerHTML = html;
      return;
    }

    if(state.mode === 'hitbox'){
      html += field('body.w', 'Width X (sides)', v.body.w, 0.1, 20);
      html += field('body.l', 'Length Z (front/back)', v.body.l, 0.1, 20);
      html += field('body.h', 'Height Y', v.body.h, 0.1, 20);
    } else if(state.mode === 'pivot'){
      html += field('pivot.x', 'Pivot X', v.pivot.x, -10, 10);
      html += field('pivot.y', 'Pivot Y', v.pivot.y, -10, 10);
      html += field('pivot.z', 'Pivot Z', v.pivot.z, -10, 10);
    } else if(state.mode === 'turret'){
      html += field('turret.x', 'Turret X', v.turret.x, -10, 10);
      html += field('turret.y', 'Turret Y', v.turret.y, -10, 10);
      html += field('turret.z', 'Turret Z (forward)', v.turret.z, -10, 10);
    } else if(state.mode === 'shell'){
      html += field('shell.x', 'Fire X', v.shell.x, -10, 10);
      html += field('shell.y', 'Fire Y', v.shell.y, -10, 10);
      html += field('shell.z', 'Fire Z (forward)', v.shell.z, -10, 10);
    } else if(state.mode === 'casing'){
      html += field('casing.x', 'Casing X', v.casing.x, -10, 10);
      html += field('casing.y', 'Casing Y', v.casing.y, -10, 10);
      html += field('casing.z', 'Casing Z (forward)', v.casing.z, -10, 10);
    } else if(state.mode === 'scale'){
      /* THE RESIZE TOOL.

         One number, because the game takes one: tank.js applies
         (def.modelScale || 1) * 2 uniformly, so a non-uniform control here
         would promise something the game cannot deliver.

         Shown with the resulting size beside it, because the multiplier itself
         means nothing — "12.75" is not a length, and the number people actually
         need is "how long is this tank now". */
      var cur = (v.model.scale > 0) ? v.model.scale : 1;
      /* The readout has its own id and is updated in place by
         refreshScaleReadout, rather than being written here as part of the
         markup. Rebuilding this panel on every pointermove of a scrub would
         destroy the input being dragged out from under the cursor. */
      html += '<div class="te-scale-now" id="te-scale-readout">' +
                '<div><span>modelScale</span><b>' + cur + '</b></div>' +
                '<div><span>effective</span><b>' + round(cur * 2) + '×</b></div>' +
                '<div><span>length</span><b>—</b></div>' +
              '</div>';
      html += field('model.scale', 'Scale (drag to scrub)', cur, 0.01, 500);
      html += '<div class="te-note">1.0 renders at 2× the model’s own units. Drag the label sideways to scrub; hold Shift for fine steps.</div>';
    } else if(state.mode === 'rotate'){
      /* THE ROTATION TOOL. Full three-axis rotation, which modelYaw never was.

         The gizmo is live — the rings in the viewport drive these three numbers
         — so this is not a calculator for a rotation done somewhere else, it is
         the rotation tool with the numbers shown next to it. */
      html += '<div class="te-sub">Rotate (deg)</div>';
      html += field('model.rx', 'X — pitch', v.model.rx, -180, 180);
      html += field('model.ry', 'Y — yaw', v.model.ry, -180, 180);
      html += field('model.rz', 'Z — roll', v.model.rz, -180, 180);
      html += '<div class="te-act-row" style="margin-top:10px">' +
                '<div class="te-btn" id="te-zero-rot">Zero rotation</div>' +
              '</div>';
      html += '<div class="te-note">Free rotation, applied <b>on top of</b> the facing you set — so a model that drives the right way but sits 4° crooked can be squared up without breaking its facing. Drag the rings in the viewport, or scrub these.</div>';
    } else if(state.mode === 'model' || state.mode === 'front'){
      html += field('model.yaw', 'Facing Y (deg)', v.model.yaw, -360, 360);
      html += field('model.x', 'Model offset X', v.model.x, -10, 10);
      html += field('model.y', 'Model offset Y (height)', v.model.y, -10, 10);
      html += field('model.z', 'Model offset Z', v.model.z, -10, 10);
    }
    el.innerHTML = html;
    bindFields(html);
  }

  /* Render a block of fields and attach its handlers. Split out so the Facing
     panel — which returns early from renderFields — renders and binds exactly
     the same way as every other panel instead of needing its own copy. */
  function bindFields(html){
    var el = $id('te-fields');
    if(!el) return;
    el.innerHTML = html;
    /* The tracks sliders are NOT bound here, and the reason is worth stating
       because it cost an hour to find: this function only ever sees #te-fields.
       The per-mode action bar is a SEPARATE element (#te-mode-actions) written
       by modeActions() a few lines further down, so a control declared there
       does not exist yet at this point and querySelectorAll finds nothing.

       They are bound in bindModeActions instead, next to the fitbox and ground
       buttons that live in the same bar. */
    el.querySelectorAll('input[data-key]').forEach(function(inp){
      inp.oninput = function(){
        var key = inp.dataset.key; // e.g. 'body.w'
        var parts = key.split('.');
        var val = parseFloat(inp.value);
        if(isNaN(val)) return;
        if(state.values[parts[0]]) state.values[parts[0]][parts[1]] = val;
        applyValuesToScene();
        if(state.gizmoHelper) state.gizmoHelper.updateMatrixWorld(true);

        /* SCALE, APPLIED LIVE ON THE ORIENTATION GROUP.

           This used to be "the one field that cannot be applied live" and it
           rebuilt the tank on a 320ms debounce to compensate. That was a wrong
           conclusion drawn from a true premise — modelScale IS baked in at load
           — and it made every scale edit take seconds and lose keyboard focus
           mid-word. See applyLiveModelScale for why the rebuild was never
           needed. */
        if(key === 'model.scale'){
          if(!(val > 0)) return;
          applyLiveModelScale(val);
          return;
        }
        /* Rotation is applied live, exactly like every other transform — the
           orient group exists to be transformed, and the value is stored for
           the game on the way out. */
        if(key === 'model.rx' || key === 'model.ry' || key === 'model.rz'){
          _applyModelEuler();
          return;
        }
      };
      /* onchange rather than oninput for the push: typing a scale is one edit
         however many keystrokes it took, and the debounced rebuild above has
         already queued the work. */
      inp.onchange = function(){
        /* Rotation and scale both need to reach the override map, or they exist
           only until the tank is selected again. */
        var k = inp.dataset.key;
        if(k === 'model.scale' || k === 'model.rx' || k === 'model.ry' || k === 'model.rz'){
          setOv(state.selected, { model: Object.assign({}, state.values.model) });
        }
        pushHistory();
        renderFields();
      };
    });
    /* Axis buttons are regenerated on every renderFields, so they are rebound
       here rather than once at startup. */
    el.querySelectorAll('.te-axisbtn').forEach(function(btn){
      btn.onclick = function(){
        var key = btn.dataset.slot;      // 'front' or 'up'
        var val = btn.dataset.axis;      // '+X' … '-Z'
        if(state.values.model[key] === val){
          /* Clicking the chosen one clears it, so a tank can go back to the
             plain-yaw behaviour without a separate "none" button. */
          state.values.model[key] = '';
        } else {
          state.values.model[key] = val;
        }
        /* Keep the patch telling the truth about the new axis. */
        _anchorMarkToAxis(key, state.values.model[key]);
        _rebuildFaceMarks();
        applyValuesToScene();
        pushHistory();
        renderFields();
      };
    });
    el.querySelectorAll('.te-pickbtn').forEach(function(btn){
      btn.onclick = function(){
        state.pickArm = btn.dataset.arm;
        renderFields();
      };
    });
    /* The per-mode action bar lives OUTSIDE #te-fields, so it has to be
       written and bound separately — and rebound on every mode change, since
       renderFields is what switches modes' contents over. */
    bindScrubbers(el);
    var titleEl = $id('te-insp-title');
    if(titleEl){
      var grp = null;
      MODE_GROUPS.forEach(function(g){
        g.modes.forEach(function(m){ if(m.id === state.mode) grp = g; });
      });
      var label = 'PROPERTIES';
      MODE_GROUPS.forEach(function(g){
        g.modes.forEach(function(m){ if(m.id === state.mode) label = m.label; });
      });
      titleEl.textContent = label + (grp ? '  ·  ' + grp.title : '');
    }
    var actEl = $id('te-mode-actions');
    if(actEl){
      actEl.innerHTML = modeActions(state.mode);
      bindModeActions();
    }
    /* Rendered last, because renderFields() rebuilds the elements both of these
       write into. */
    refreshFacingReadout();
    updateOrientNote();
    refreshFootInfo();
    /* After refreshFootInfo, which may be what first produced the stats this
       reads — entering the Scale panel used to show "—" for length until
       something else happened to trigger a repaint. */
    refreshScaleReadout();
  }

  /* THE TRACKS PANEL BINDINGS.

     The controls are declared by modeActions('tracks') into #te-mode-actions,
     and this is where they are wired. They are not `data-key` fields like
     everything else on the inspector, deliberately: a change to any of them
     rebuilds geometry instead of moving a marker, and the generic data-key path
     knows nothing about wheels.

     Two different events, two different jobs. `input` updates the number under
     the thumb and pushes the value straight into the override so the preview
     follows the drag. `change` commits to history — one drag of a slider is one
     undo step, not one per pixel of travel, which is what binding both to
     `input` would have given. */

  /* Read-modify-write one key of the tank's tracks block. Every control goes
     through this, so there is exactly one place that knows the shape. */
  function writeTrack(key, val){
    var ov = ovFor(state.selected) || {};
    var t = Object.assign({}, ov.tracks || {});
    t[key] = val;
    setOv(state.selected, { tracks: t });
    (state.tracksTouched[state.selected] || (state.tracksTouched[state.selected] = {}))[key] = true;
    applyValuesToScene();
    rebuildTracksPreview();
  }

  function bindTracksPanel(){
    var sliders = document.querySelectorAll('#te-mode-actions input[data-trk]');
    if(!sliders.length) return;                 /* not the tracks mode */
    Array.prototype.forEach.call(sliders, function(inp){
      var key = inp.dataset.trk;
      var out = $id('te-tr-' + key + '-v');
      inp.oninput = function(){
        var val = parseFloat(inp.value);
        if(isNaN(val)) return;
        if(out) out.textContent = (Math.round(val * 1000) / 1000);
        writeTrack(key, val);
      };
      inp.onchange = function(){ pushHistory(); renderFields(); };
    });

    var ty = $id('te-tr-type');
    if(ty) ty.onchange = function(){
      writeTrack('type', this.value);
      pushHistory();
      renderFields();          /* re-render: the style changes what is shown */
    };

    ['color', 'rim'].forEach(function(which){
      var c = $id('te-tr-' + which);
      if(!c) return;
      c.onchange = function(){
        writeTrack(which, parseInt(String(c.value).replace('#', ''), 16));
      };
    });

    var sp = $id('te-tr-spin');
    if(sp) sp.onclick = function(){
      var ov = ovFor(state.selected) || {};
      var t = Object.assign({}, ov.tracks || {});
      var next = !t.spin;
      writeTrack('spin', next);
      this.classList.toggle('te-on', next);
    };

    /* `replace` is the one control here whose effect is not visible in the
       sliders, so it re-renders the panel afterwards to refresh the gear
       note that describes what it did. */
    var rp = $id('te-tr-replace');
    if(rp) rp.onclick = function(){
      var ov = ovFor(state.selected) || {};
      var t = Object.assign({}, ov.tracks || {});
      var next = !t.replace;
      writeTrack('replace', next);
      this.classList.toggle('te-on', next);
      pushHistory();
      renderFields();
      toast(next ? 'Model treads will be hidden and this kit used instead'
                 : 'Back to the model\u2019s own treads');
    };

    var cl = $id('te-tr-clear');
    if(cl) cl.onclick = function(){
      var ov = ovFor(state.selected) || {};
      var before = Object.keys(ov.tracks || {}).length;
      setOv(state.selected, { tracks: {} });
      state.tracksTouched[state.selected] = {};
      applyValuesToScene();
      rebuildTracksPreview();
      pushHistory();
      renderFields();
      toast(before ? 'Tracks cleared — back to this tank\u2019s own defaults'
                   : 'This tank already uses its defaults');
    };
  }

  /* Rebound every mode change, because the buttons are recreated with the
     markup they belong to. */
  function bindModeActions(){
    var fit = $id('te-fitbox');
    if(fit) fit.onclick = autoFitHitbox;
    var gr = $id('te-ground');
    if(gr) gr.onclick = snapToGround;
    var mb = $id('te-matchbox');
    if(mb) mb.onclick = matchHitbox;
    var zr = $id('te-zero-rot');
    if(zr) zr.onclick = function(){
      state.values.model.rx = 0;
      state.values.model.ry = 0;
      state.values.model.rz = 0;
      _applyModelEuler();
      pushHistory();
      renderFields();
      toast('Rotation zeroed. Facing is untouched.');
    };
    var rb = $id('te-refitbox');
    if(rb) rb.onclick = function(){
      autoFitHitbox();
      toast('Hitbox re-fitted to the new model size.');
    };

    bindTracksPanel();

    var spinBtn = $id('te-spin');
    if(spinBtn){
      spinBtn.onclick = function(){
        state.spinTurret = !state.spinTurret;
        spinBtn.classList.toggle('te-on', state.spinTurret);
        if(!state.spinTurret && state.tank){
          state.tank.turretAngle = 0;
          state.tank._syncTransform();
          applyValuesToScene();
        }
        syncSpinUI();
        toast(state.spinTurret ? 'Turret spinning — watch the pivot & firing point' : 'Turret spin off');
      };
    }
    var angleIn = $id('te-angle');
    if(angleIn){
      angleIn.oninput = function(){
        var deg = parseInt(angleIn.value, 10);
        if(isNaN(deg)) return;
        if(state.tank && state.tank._syncTransform){
          state.tank.turretAngle = deg * Math.PI / 180;
          state.tank._syncTransform();
          applyValuesToScene();
        }
        syncSpinUI();
      };
    }
  }

  /* The right-hand end of the status bar: the numbers that are true right now,
     as opposed to the numbers in the inspector that are being edited. */
  function refreshFootInfo(){
    var el = $id('te-foot-info');
    if(!el) return;
    var s = state.stats;
    /* Re-measured only when something has actually moved. Measuring walks every
       mesh and its eight bounding-box corners, which is far too much to do
       inside applyValuesToScene — that runs on every gizmo drag frame — and far
       too little to not do, because the alternative was a status bar that kept
       reporting the model as floating after the button that fixes floating had
       been pressed and had visibly worked. */
    if(state.statsDirty || !state.stats){
      state.stats = measureStats();
      state.statsDirty = false;
      s = state.stats;
    }
    if(!s){ el.textContent = ''; return; }
    /* `tris` and `size`, not the widthX/heightY/lengthZ names — those belong to
       the object built for copying out, and reaching for them here is what put
       "undefined tris" in the status bar. */
    var sz = s.size ? (Math.round(s.size.x * 100) / 100) + ' × ' +
                      (Math.round(s.size.y * 100) / 100) + ' × ' +
                      (Math.round(s.size.z * 100) / 100) : '';
    el.textContent = s.tris + ' tris · ' + s.meshes + ' meshes' +
      (sz ? ' · ' + sz : '') +
      (s.grounded ? '' : '  ·  ⚠ floating');
  }

/* ============================================================
     POINT AT THE TANK. That is the whole interface.

     Six buttons labelled '+X' and '-X' ask the user to know the answer
     in a coordinate system, which is exactly the thing they do not
     know. "Which way does this model face" is a visual question and
     the model is sitting right there on screen, so the control is a
     click ON THE MODEL: click the end you are calling the front, and
     the editor works out which authored axis that is.

     MEASURED, ON REAL TANKS, TO DECIDE WHICH SIGNAL TO TRUST.
     Both obvious candidates were tried against the roster and both
     fail, but in opposite directions, and knowing which is which is
     what makes the interaction predictable.

     THE FACE NORMAL answers "which part is this" but not "which end".
     Reading a normal off the surface and snapping it to an axis gives
     nonsense on a tank: the Mortar is mostly tube and sloped plate, and
     with no correction applied at all a ray fired straight at the +X
     end came back as -Z while one at the +Z end came back as +X. The
     normals were being read off curved triangles and snapped to axes
     that had nothing to do with them.

     It is worse than that as a roof test. The default camera looks
     down at the tank, so most of what you see IS the deck: sweeping
     nine points across CoolBuddy's hull returned an authored normal of
     exactly (0, 1, 0) at eight of them. Any "is this face pointing up"
     rule therefore fires on the entire visible tank, including the very
     ends the user is trying to point at.

     THE HIT POINT answers "which end is this" and does it well. The
     direction from the model's centre out to where the cursor landed is
     exactly the direction being claimed, and it is stable on curved
     geometry, because a point on a tube is still a point on the
     correct side of the tank. Measured on CoolBuddy, clicking each of
     the four faces in turn returned the matching axis every time:
     +Z face to +Z, -Z to -Z, +X to +X, -X to -X.

     It cannot tell a roof from a side, though, and no version of the
     geometry can. A tank is wider than it is tall, so its roof sits
     barely above its own centre: the same sweep put the height
     component of the direction at 0.16 at best, against 0.83 across the
     length. Asking "is this point high?" fails on flat vehicles by
     construction, and a turret that towers over a low hull makes it
     worse.

     SO: a click means FRONT, because that is the answer the point
     gives reliably and the one people cannot work out unaided. UP is
     one button away, and when UP is armed the click reads the face
     normal instead, because for "which way is the roof" the normal is
     the signal that survives rotation and a deck is exactly the flat
     plate where it is trustworthy. That also gets upside-down models
     right for free: the deck of a model authored roof-down has an
     authored normal of (0, -1, 0), so it is picked as '-Y' and the
     solver flips it the right way round.
     ============================================================ */
  /* ============================================================
     GIZMO -> VALUES

     A gizmo is only useful if what you drag ends up somewhere. These two
     handlers are the whole of that: they read the live transform off the
     object the gizmo is on and write it into the values the game will read
     back. Nothing else needs to know a gizmo was involved.
     ============================================================ */
  function _readGizmoRotation(){
    var t = state.tank;
    if(!t || !t._bodyOrient) return;
    var full = t._bodyOrient.quaternion.clone();
    /* Undo the facing correction, leaving only the rotation the user made. */
    var correction = solveOrient(state.values.model.front, state.values.model.up) || new THREE.Quaternion();
    var e = new THREE.Quaternion().copy(correction).invert().multiply(full);
    var eu = new THREE.Euler().setFromQuaternion(e, 'YXZ');
    state.values.model.rx = round(THREE.MathUtils.radToDeg(eu.x));
    state.values.model.ry = round(THREE.MathUtils.radToDeg(eu.y));
    state.values.model.rz = round(THREE.MathUtils.radToDeg(eu.z));
    _applyModelEuler();
  }

  function _applyModelEuler(){
    var t = state.tank;
    if(!t) return;
    t._modelEuler.x = state.values.model.rx || 0;
    t._modelEuler.y = state.values.model.ry || 0;
    t._modelEuler.z = state.values.model.rz || 0;
    /* Recomposes the group to exactly where the gizmo left it — the read-back
       is lossless, so this is a no-op visually and stops the next frame from
       snapping back. */
    t._applyModelQuat();
    t._turretOrient && t._turretOrient.quaternion.copy(t._bodyOrient.quaternion);
    t._syncTransform();
    /* A rolled model is a different size in the world — 25° of roll turns a long
       hull into a much taller bounding box — so everything measured off it is
       now out of date. */
    state.statsDirty = true;
    refreshFootInfo();
    refreshScaleReadout();
  }

  function _onScaleGizmo(){
    var t = state.tank;
    if(!t || !t._bodyOrient) return;
    var s = t._bodyOrient.scale.x;
    if(!(s > 0)) return;
    /* The gizmo's value is a MULTIPLE of the size already on screen, because
       that is what dragging a scale handle does. modelScale is an absolute
       number stored in config.js, and the tank was built at loadedModelScale,
       so the two are related by that ratio and not equal.

       Reading the gizmo straight into modelScale — which is what this used to
       do — meant that dragging the handle to 2 on a tank already at 0.62 stored
       modelScale 2, which on reload became 4/1.24 = 3.2x the size the user was
       looking at when they let go. The model jumped every time the gizmo was
       used and the number never matched the picture. */
    var base = state.loadedModelScale || 1;
    state.values.model.scale = round(s * base);
  }

  /* ============================================================
     SET THE SIZE WITHOUT REBUILDING THE TANK

     This is the whole reason the scale tool was unusable, so it is worth being
     exact about why.

     modelScale is read once, inside Tank._loadModel, and multiplied into the
     model group as the model is attached. That made it look like the only way
     to preview a new size was to rebuild the tank — so that is what the editor
     did, on a 320ms debounce, and on every gizmo release.

     The consequence was that no scale edit was ever instant. Typing 1.62 took
     seconds to appear, because a rebuild refetches the GLB, re-rigs it and
     rebuilds every marker and measurement; the panel was re-rendered underneath
     the cursor and lost focus; dragging the scrub showed nothing for a second
     and a half and then snapped; and Match hitbox needed two full rebuilds on a
     timer, so if a model took longer than 1.4s to load it measured the OLD
     model and converged on the wrong answer.

     None of that was necessary. The orientation group sits directly under the
     model and nothing else, so scaling IT previews any size exactly, instantly,
     with no refetch. The stored modelScale is only read when the tank is next
     built, and building it at modelScale N produces precisely the size already
     on screen — so the value can be committed without a rebuild at all.

     This is the difference between a resize tool that fights you and one that
     does not, and it is the same reason rotation was wired live from the start.
     ============================================================ */
  function applyLiveModelScale(newScale){
    var t = state.tank;
    if(!(newScale > 0)) return;
    state.values.model.scale = round(newScale);
    if(t && t._bodyOrient){
      var base = state.loadedModelScale || 1;
      t._bodyOrient.scale.setScalar(state.values.model.scale / base);
      t._turretOrient && t._turretOrient.scale.setScalar(state.values.model.scale / base);
    }
    state.statsDirty = true;
    refreshFootInfo();
    refreshScaleReadout();
  }

  /* The three numbers at the top of the Scale panel. Split out because they now
     change on every pointermove of a scrub or a gizmo drag, and rebuilding the
     whole panel to update them would tear down the very input being dragged. */
  function refreshScaleReadout(){
    var el = $id('te-scale-readout');
    if(!el) return;
    var cur = (state.values.model.scale > 0) ? state.values.model.scale : 1;
    /* Length is read straight off the measurement, because that measurement is
       taken from the LIVE scene and so already includes whatever scale is
       currently on the orientation group. Multiplying it by the ratio again —
       which this did — counts the scale twice and reported 104 for a tank that
       was actually 32 long. */
    var base = state.stats && state.stats.size ? state.stats.size.z : null;
    el.innerHTML =
        '<div><span>modelScale</span><b>' + cur + '</b></div>' +
        '<div><span>effective</span><b>' + round(cur * 2) + '&times;</b></div>' +
        '<div><span>length</span><b>' + (base != null ? round(base) : '—') + '</b></div>';
  }

  function _commitScaleGizmo(){
    var s = round(state.values.model.scale);
    if(!(s > 0)) s = 1;
    /* Committed, not rebuilt. See applyLiveModelScale. */
    setOv(state.selected, { model: Object.assign({}, state.values.model) });
    pushHistory();
    renderFields();
    toast('Model scaled to ' + s + '× (' + round(s * 2) + ' effective)');
  }

  function _commitRotateGizmo(){
    pushHistory();
    renderFields();
  }

  function pickFromPointer(ev){
    if(state.mode !== 'facing') return;
    if(!state.tank || !state.tank._bodyOrient) return;
    if(!state.renderer || !state.camera) return;

    var rect = state.renderer.domElement.getBoundingClientRect();
    if(!(rect.width > 0 && rect.height > 0)) return;
    var nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    var ny = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    if(!isFinite(nx) || !isFinite(ny)) return;

    /* Only the tank and its hitbox proxy are pickable. The gold arrow is
       deliberately excluded: it is a readout of the answer, so clicking it
       would let you answer the question with the answer. */
    var targets = [];
    if(state.tank.root) targets.push(state.tank.root);
    if(state.bodyBox) targets.push(state.bodyBox);
    if(state.boxWire) targets.push(state.boxWire);
    if(!targets.length) return;

    var ray = state._pickRay || (state._pickRay = new THREE.Raycaster());
    ray.setFromCamera({ x: nx, y: ny }, state.camera);

    var hits;
    try { hits = ray.intersectObjects(targets, true); }
    catch(e){ return; }
    if(!hits || !hits.length){
      toast('Nothing under the cursor there - click the tank itself.');
      return;
    }

    var hit = hits[0];

    /* Into the model's authored frame. The orientation group's local space is
       that frame by construction -- carrying the correction is the one thing it
       exists to do -- so its inverse world matrix takes a world direction back
       to what the artist authored. */
    var inv = new THREE.Matrix4().copy(state.tank._bodyOrient.matrixWorld).invert();

    /* The face normal, in the authored frame, when the hit has one. */
    var nAuth = null;
    if(hit.face && hit.object && hit.object.geometry){
      try {
        var n = hit.face.normal.clone();
        n.applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
        nAuth = n.transformDirection(inv).normalize();
      } catch(e){ nAuth = null; }
    }

    /* The direction from the middle of the tank to the point that was clicked.
       The middle has to come from the MODEL, and Tank.boxOf(root, true) is
       what takes it: a plain setFromObject over the root counts the HP bar and
       the name tag, which _addOverlays parks several units above the turret,
       so "the centre of the tank" came out at y=1.6 for a hull whose middle is
       near y=0, and every click was measured from the wrong place. boxOf skips
       invisible subtrees, which is exactly the overlay group the editor hides. */
    var dir = null;
    var box = new THREE.Box3();
    try {
      if(typeof Tank !== 'undefined' && Tank.boxOf) box.copy(Tank.boxOf(state.tank.root, true));
      else box.setFromObject(state.tank.root);
    } catch(e){}
    if(!box.isEmpty()){
      var centre = box.getCenter(new THREE.Vector3());
      dir = hit.point.clone().sub(centre);
      if(dir.lengthSq() < 1e-6) dir = null;   /* dead centre: no answer to give */
      else dir.normalize();
    }

    var key = null;
    var slot = state.pickArm === 'up' ? 'up' : 'front';

    /* UP is armed: the normal is the signal, because a deck is a flat plate
       and a deck is what the user is pointing at. A face that is neither up nor
       down facing falls back to the direction, so an odd model still answers. */
    if(slot === 'up' && nAuth && Math.abs(nAuth.y) > 0.35){
      key = nAuth.y > 0 ? '+Y' : '-Y';
    }
    if(key === null){
      if(!dir){
        toast('That is the middle of the tank - click an end or an edge.');
        return;
      }
      var d = dir.clone().transformDirection(inv).normalize();
      var ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
      key = (ax >= ay && ax >= az) ? (d.x > 0 ? '+X' : '-X')
          : (ay >= az)              ? (d.y > 0 ? '+Y' : '-Y')
          :                            (d.z > 0 ? '+Z' : '-Z');
    }

    /* Refuse a front and an up on the same axis. That is not a position, and
       accepting it leaves the solver with nothing usable while the panel claims
       both are set. */
    var other = slot === 'front' ? 'up' : 'front';
    if(state.values.model[other] === key){
      toast(key + ' is already the ' + other.toUpperCase() +
            '. Click another part of the tank, or use the axis buttons.');
      return;
    }

    state.values.model[slot] = key;

    /* Remember WHERE it was pointed at, in authored space, so the red patch can
       be laid on that exact face. The position is pushed a little way out along
       the face normal to sit proud of the surface rather than z-fighting with
       it, and the rotation turns the patch's own +Z onto that normal. */
    if(nAuth){
      state.faceMarks[slot] = {
        p: hit.point.clone().applyMatrix4(inv).addScaledVector(nAuth, 0.04),
        q: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), nAuth)
      };
      _rebuildFaceMarks();
    }

    applyValuesToScene();
    pushHistory();
    renderFields();
    toast('Picked ' + key + ' as the tank\u2019s ' + slot.toUpperCase() +
          (slot === 'up' ? ' (clicked the roof)' : ' (clicked that end)'));
  }

  /* A click is a press and a release with almost no movement between them.
     Without that test every orbit drag would also fire a pick, and dragging
     the gizmo would reorient the tank. */
  function bindFacePicking(canvas){
    if(!canvas || canvas.__tePickBound) return;
    canvas.__tePickBound = true;
    var downX = 0, downY = 0, downT = 0;
    canvas.addEventListener('pointerdown', function(e){
      downX = e.clientX; downY = e.clientY; downT = performance.now();
    });
    canvas.addEventListener('pointerup', function(e){
      if(state.mode !== 'facing') return;
      /* A gizmo handle was under the pointer: that was a drag, not a pick. */
      if(state.gizmo && state.gizmo.axis) return;
      var moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if(moved > 5) return;
      if(performance.now() - downT > 600) return;
      if(e.button !== 0) return;
      pickFromPointer(e);
    });
  }

  /* SIX AXES, ONE ROW. Each is a plain click target labelled with the axis it
     stands for — the model in the viewport is the thing being read, so the
     labels describe the MODEL's axes and the arrows describe the RESULT. */
  /* Which slot the next click fills. FRONT is the default because that is the
     one a click can be trusted to answer; UP is armed explicitly, and when it
     is the click reads the roof instead. See pickFromPointer for why the two
     cannot safely share one rule. */
  function pickArmBtn(mode, label){
    return '<div class="te-pickbtn' + (state.pickArm === mode ? ' te-on' : '') +
           '" data-arm="' + mode + '">' + label + '</div>';
  }

  function axisButtons(containerId, slot, current){
    var html = '<div class="te-axisrow" id="' + containerId + '">';
    for(var i = 0; i < AXIS_KEYS.length; i++){
      var k = AXIS_KEYS[i];
      html += '<div class="te-axisbtn' + (current === k ? ' te-on' : '') + '" data-slot="' +
              slot + '" data-axis="' + k + '">' + k + '</div>';
    }
    html += '</div>';
    return html;
  }

  /* The line under the pickers. Says what the current pair means in plain terms,
     so a wrong click is diagnosed rather than merely visible. */
  function updateOrientNote(){
    var el = $id('te-orient-note');
    if(!el) return;
    var v = state.values.model;
    if(!v.front || !v.up){
      el.textContent = 'Pick FRONT and UP. Until both are set the model falls back to a plain yaw, ' +
                       'which can only spin it — that is why some tanks end up driving on their side.';
      return;
    }
    if(v.front[1] === v.up[1]){
      el.textContent = 'FRONT and UP cannot be the same axis — that is not a position. Pick a different one.';
      return;
    }
    var cf = currentForward();
    if(!cf){ el.textContent = ''; return; }
    el.textContent = orientIsSolved(cf)
      ? 'Solved. The tank drives the way the gold arrow points.'
      : 'Not aligned yet — the barrel should end up on +Z and the roof on +Y. Try the other UP.';
  }

  function field(key, label, val, min, max){
    return '<label class="te-field"><span>' + label + '</span><input type="number" step="0.05" min="' + min + '" max="' + max + '" data-key="' + key + '" value="' + round(val) + '"></label>';
  }

  /* ============================================================
     DRAG-TO-SCRUB NUMBERS

     Every professional 3D tool lets you drag a value's NAME sideways to
     change the value. It is not a gimmick: nudging something by a tenth of a
     unit is the single most common edit in this editor — a pivot a few
     centimetres off makes the turret wobble, a fire point a few centimetres
     off makes shots spawn inside the barrel — and typing "0.15" into a box
     each time is both slower and less precise than dragging.

     Shift is slow (tenth of the step), plain is normal, and the box is
     highlighted while dragging so it is obvious which value is moving. The
     value is committed through the same path as typing, so undo, the gizmo
     and the status bar all behave identically whichever way it was changed.
     ============================================================ */
  function bindScrubbers(el){
    el.querySelectorAll('.te-field > span').forEach(function(lbl){
      var input = lbl.parentNode.querySelector('input');
      if(!input || lbl.__scrub) return;
      lbl.__scrub = true;

      var startX = 0, startVal = 0, dragging = false, pid = null;

      lbl.addEventListener('pointerdown', function(ev){
        if(ev.button !== 0) return;
        if(document.activeElement === input) return;   /* already typing there */
        dragging = true;
        startX = ev.clientX;
        startVal = parseFloat(input.value) || 0;
        pid = ev.pointerId;
        lbl.setPointerCapture && lbl.setPointerCapture(pid);
        lbl.classList.add('te-dirty');
        input.classList.add('te-dirty');
        ev.preventDefault();
      });

      lbl.addEventListener('pointermove', function(ev){
        if(!dragging) return;
        var step = parseFloat(input.getAttribute('step')) || 0.05;
        if(ev.shiftKey) step = step / 10;
        var dx = ev.clientX - startX;
        var next = startVal + Math.round(dx / 3) * step;
        var lo = parseFloat(input.getAttribute('min'));
        var hi = parseFloat(input.getAttribute('max'));
        if(!isNaN(lo)) next = Math.max(lo, next);
        if(!isNaN(hi)) next = Math.min(hi, next);
        input.value = round(next);
        /* Committed live rather than on release: the point of the gesture is
           watching the thing move, and a value that only lands when you let go
           gives nothing to watch.

           Through the SAME path as typing, not around it. It used to write the
           value and call applyValuesToScene directly, which is right for every
           field except scale and rotation — and silently did nothing at all
           for those, because both are baked at load time rather than being a
           transform on the live object. Dragging the scale label looked like it
           was working and changed nothing on screen. */
        input.dispatchEvent(new Event('input'));
      });

      function end(){
        if(!dragging) return;
        dragging = false;
        lbl.classList.remove('te-dirty');
        input.classList.remove('te-dirty');
        /* One history entry per drag, not one per pixel — otherwise undo walks
           backwards through a scrub instead of off it. */
        pushHistory();
        renderFields();
      }
      lbl.addEventListener('pointerup', end);
      lbl.addEventListener('pointercancel', end);
    });
  }

  /* ------------------------------------------------------------
   Frame the tank
   ------------------------------------------------------------ */
  /* Zoom so the whole tank fits, from whatever angle it is currently at.

     Every camera preset in the editor sets an absolute distance, which is fine
     for the tank you are working on and useless for the next one: the Mortar
     is half the length of a light car, so the presets that frame one leave the
     other filling a corner or running off the edge. Deriving the distance from
     the model's own size is what makes them interchangeable. */
  function fitView(){
    if(!state.camera || !state.tank || !state.tank.root) return;
    var box = new THREE.Box3();
    try { box.copy(Tank.boxOf(state.tank.root, true)); } catch(e){ return; }
    if(box.isEmpty()) return;
    var c = box.getCenter(new THREE.Vector3());
    c.y = Math.max(c.y, 0.6);
    var radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 1);
    var fov = (state.camera.fov || 45) * Math.PI / 180;
    var dist = (radius / Math.sin(fov * 0.5)) * 1.18;   /* 1.18 = a little air */
    var dir = state.camera.position.clone().sub(
      state.controls ? state.controls.target : c
    );
    if(dir.lengthSq() < 1e-6) dir.set(8, 6, 12);
    dir.normalize().multiplyScalar(dist);
    state.camera.position.copy(c).add(dir);
    if(state.controls){ state.controls.target.copy(c); state.controls.update(); }
    state.camera.lookAt(c);
  }

  /* ------------------------------------------------------------
   Auto-fit the hitbox to the model
   ------------------------------------------------------------ */
  /* The hitbox is the one number that cannot be checked by looking. The model
     shows you where it is; the hitbox is invisible in play and its error is
     silent — a box too small lets bullets through the tank, a box too large
     makes shots hit air in front of it. Measuring it off the model is exact,
     and the only judgement left is whether to shrink it, which is a decision
     rather than a measurement.

     Measured on the Mortar, the values already in config.js gave a box 8.105
     long against a model 10.04 long: the rear overhang, and most of the
     barrel, were outside the thing that was supposed to be solid. */
  function autoFitHitbox(){
    if(!state.tank || !state.tank.root) return;
    var box = new THREE.Box3();
    try { box.copy(Tank.boxOf(state.tank.root, true)); } catch(e){ return; }
    if(box.isEmpty()) return;
    var s = box.getSize(new THREE.Vector3());
    var before = [state.values.body.w, state.values.body.h, state.values.body.l];
    state.values.body.w = round(s.x);
    state.values.body.h = round(s.y);
    state.values.body.l = round(s.z);
    applyValuesToScene();
    pushHistory();
    renderFields();
    toast('Hitbox fitted to the model — ' + state.values.body.w + ' × ' +
          state.values.body.h + ' × ' + state.values.body.l +
          ' (was ' + before.join(' × ') + ')');
  }

  /* ------------------------------------------------------------
   Drop the model onto the ground
   ------------------------------------------------------------ */
  /* Statistics reports sitsOnGround, and it has been reporting false on
     models whose offset nobody wanted to work out by eye. A tank floating
     half a unit up is not a cosmetic problem: the hitbox moves with it, so it
     stops catching shots at the height players aim at, and it rolls over
     bumps the track animation says it is crossing. */
  function snapToGround(){
    if(!state.tank || !state.tank.root) return;
    var box = new THREE.Box3();
    try { box.copy(Tank.boxOf(state.tank.root, true)); } catch(e){ return; }
    if(box.isEmpty()) return;
    var drop = box.min.y;
    if(Math.abs(drop) < 1e-4){
      toast('Already on the ground.');
      return;
    }
    state.values.model.y = round((state.values.model.y || 0) - drop);
    applyValuesToScene();
    pushHistory();
    renderFields();
    toast('Dropped ' + round(-drop) + ' units onto the ground.');
  }

  /* ------------------------------------------------------------
   Match the model to the hitbox
   ------------------------------------------------------------ */
  /* The other direction from autoFitHitbox, and the one usually wanted: the
     hitbox is the thing the designer cares about — it is what the game
     collides on — and a model that overflows it shoots with barrels that pass
     through walls while its hull takes hits it visually did not.

     Scaling is solved against the LENGTH alone rather than all three axes.
     Matching every axis would stretch a model into its box, turning a tank
     with a tall turret into a flat one, because a box is rarely the right
     proportions for the model sitting in it. Length is the axis both must agree
     on for collisions to look right, and the other two are then the designer's
     judgement. */
  function matchHitbox(){
    if(!state.tank || !state.tank.root) return;
    var box = new THREE.Box3();
    try { box.copy(Tank.boxOf(state.tank.root, true)); } catch(e){ return; }
    if(box.isEmpty()) return;
    var len = box.getSize(new THREE.Vector3()).z;
    if(len < 1e-3){
      toast('That model has no length to scale against.');
      return;
    }
    var target = state.values.body.l;
    if(!(target > 0)){
      toast('Set a hitbox length first.');
      return;
    }

    /* CONVERGES INSTANTLY, IN ONE FUNCTION CALL, WITH NO TIMERS AND NO REBUILDS.

       This used to scale once, then rebuild the tank and re-measure twice more
       on 1.4s timers, because the size could only be observed after a reload.
       That made a button that should take a millisecond take several seconds,
       and if a model loaded slower than the timer it measured the tank from
       BEFORE the last change and converged on the wrong answer — which is
       worse than not correcting at all, because the number it reported was
       confident and wrong.

       Now the measurement is taken off the live scene, so each pass is exact
       and costs nothing, and it can simply keep going until the error stops
       falling rather than guessing how many passes is enough. The cap is a
       guard against a model whose bounds never settle. */
    var passes = 0;
    var settled = false;
    while(passes < 8){
      passes++;
      var b2 = new THREE.Box3();
      try { b2.copy(Tank.boxOf(state.tank.root, true)); } catch(e){ break; }
      if(b2.isEmpty()) break;
      var l2 = b2.getSize(new THREE.Vector3()).z;
      if(l2 < 1e-3) break;
      if(Math.abs(l2 - target) / target < 0.001){ settled = true; break; }
      applyLiveModelScale(state.values.model.scale * (target / l2));
    }
    /* Committed once, at the end. The intermediate values were never stored and
       never needed to be — the override is only ever written on a real edit. */
    setOv(state.selected, { model: Object.assign({}, state.values.model) });
    pushHistory();
    renderFields();
    var bF = new THREE.Box3();
    try { bF.copy(Tank.boxOf(state.tank.root, true)); } catch(e){}
    var finalLen = bF.isEmpty() ? target : bF.getSize(new THREE.Vector3()).z;
    toast(settled
      ? 'Model matched to the hitbox — ' + round(finalLen) + ' long.'
      : 'Best fit after ' + passes + ' passes — ' + round(finalLen) + ' long against a ' + target + ' hitbox.');
  }

  /* ------------------------------------------------------------
   Shortcut help
   ------------------------------------------------------------ */
  function showHelp(){
    var el = $id('te-helpcard');
    if(el){ el.style.display = 'flex'; return; }
    var rows = [
      ['Click tank', 'set FRONT to the end you point at'],
      ['Shift-less drag', 'gizmo moves the thing it is attached to'],
      ['1 – 9', 'jump between rail modes'],
      ['F', 'fit view'],
      ['G', 'drop model to ground'],
      ['Ctrl+Z / Ctrl+Y', 'undo / redo'],
      ['Ctrl+S', 'save &amp; apply'],
      ['Esc', 'close editor'],
    ];
    var card = document.createElement('div');
    card.id = 'te-helpcard';
    card.className = 'te-helpcard';
    card.innerHTML = '<div class="te-helpcard-in">' +
      '<div class="te-helpcard-title">Keyboard</div>' +
      rows.map(function(r){ return '<div class="te-helpcard-row"><b>' + r[0] + '</b><span>' + r[1] + '</span></div>'; }).join('') +
      '<div class="te-helpcard-close">click anywhere to close</div>' +
      '</div>';
    card.onclick = function(){ card.remove(); };
    var host = document.querySelector('.te-root');
    if(host) host.appendChild(card);
  }

  /* ------------------------------------------------------------
     Camera axis views
     ------------------------------------------------------------ */
  function focusTarget(){
    if(state.tank){
      var v = new THREE.Vector3();
      state.tank.root.getWorldPosition(v);
      v.y = 1.2;
      return v;
    }
    return new THREE.Vector3(0, 1.2, 0);
  }

  function setAxisView(axis){
    if(!state.camera) return;
    var target = focusTarget();
    var dist = state.camera.position.distanceTo(target);
    if(!dist || dist < 1) dist = 12;
    var pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    if(axis === 'x'){ pos.set(dist, 0, 0); }
    else if(axis === 'y'){ pos.set(0, dist, 0.0001); up.set(0, 0, -1); }
    else if(axis === 'z'){ pos.set(0, 0, dist); }
    else { pos.set(8, 6, 12); } // persp
    state.camera.position.copy(target).add(pos);
    state.camera.up.copy(up);
    state.camera.lookAt(target);
    if(state.controls){ state.controls.target.copy(target); state.controls.update(); }
  }

  /* ------------------------------------------------------------
     Save / reset / close
     ------------------------------------------------------------ */
  /* ============================================================
     IMPORT A GLB FROM DISK

     A model that is not in config.js yet cannot be previewed through
     the roster, and that is exactly the case this exists for. The file
     is parsed and pushed into the models cache under a synthetic name,
     so everything downstream — the Tank preview, the hull/turret rig
     detection, the hitbox, the markers — treats it like any other
     model and none of it needs to know the file came from a folder
     rather than the network.
     ============================================================ */
  function importGlb(file){
    var nameEl = $id('te-import-name');
    var reader = new FileReader();
    reader.onerror = function(){
      if(nameEl) nameEl.textContent = 'Could not read that file.';
      toast('Could not read ' + file.name);
    };
    reader.onload = function(){
      var buf = reader.result;
      var loader = (window.Models && Models.loader) ? Models.loader() : null;
      if(!loader){
        if(nameEl) nameEl.textContent = 'GLTF loader unavailable.';
        toast('No GLTF loader — cannot import');
        return;
      }
      /* The cache key is the filename without its extension, which is how the
         roster refers to models too (config.js says model:'TL_ark_fi'). */
      var key = String(file.name || 'imported').replace(/\.(glb|gltf)$/i, '');
      var parseBuf = buf;
      /* A .gltf is JSON that may reference external .bin/textures. Those cannot
         be resolved from a FileReader result, so it is parsed as-is and will
         fail cleanly if it actually needs sidecars — worth saying rather than
         showing an empty stage. */
      if(/\.gltf$/i.test(file.name)){
        try { parseBuf = new TextEncoder().encode(buf); }
        catch(e){ parseBuf = buf; }
      }
      loader.parse(parseBuf, '', function(gltf){
        if(!gltf || !gltf.scene){
          if(nameEl) nameEl.textContent = 'That file did not parse as a model.';
          toast('GLB parse failed');
          return;
        }
        if(Models._stripSkins) Models._stripSkins(gltf.scene);
        Models._cache[key] = {
          gltf: gltf.scene,
          anims: gltf.animations || [],
          tried: true,
        };
        if(Models._available) Models._available[key] = true;
        state.imported = { key: key, file: file.name };
        if(nameEl) nameEl.textContent = 'Loaded ' + file.name;
        /* Add it to the picker as a real entry so it is selected the same way
           as any other tank, and the copied-out settings are named after it.

           The target is the SELECT now, not the datalist that used to be here —
           a `<datalist>` is not a menu, so appending to it did nothing a user
           could actually see or click. */
        var sel = $id('te-tank-select');
        if(sel){
          var opt = document.createElement('option');
          opt.value = key;
          opt.textContent = file.name + ' (imported)';
          sel.appendChild(opt);
        }
        toast('Imported ' + file.name);
        pickTank(key);
      }, function(err){
        if(nameEl) nameEl.textContent = 'That file did not parse as a model.';
        toast('GLB parse failed: ' + ((err && err.message) || 'unknown'));
      });
    };
    reader.readAsArrayBuffer(file);
  }

  /* Clipboard with a textarea fallback, because navigator.clipboard is refused
     on plain http:// pages, which is exactly where this editor tends to run. */
  function copyText(text, okMsg){
    var done = function(){ toast(okMsg); };
    /* navigator.clipboard is refused on plain http://, which is exactly where
       this editor runs, so the textarea fallback below is the normal path and
       not the exception — worth knowing before "copy did nothing" is blamed on
       the button. */
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done).catch(function(){ fallback(); });
    } else {
      fallback();
    }
    function fallback(){
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch(e){
        if(note) note.textContent = 'Copy blocked by the browser — select and copy manually.';
        toast('Copy blocked');
      }
    }
  }

  /* THE THING TO PASTE INTO config.js.

     Shaped as the fields a def actually takes, not as the editor's internal
     layout: modelFront/modelUp go at the top level because that is where
     tank.js reads them, and the hitbox/pivot/fire points go under the names the
     def uses. Values are the ones currently on screen, rounded the way a hand-
     written def would be. */
  function buildSetupJSON(){
    var v = state.values;
    var def = (typeof TANKS !== 'undefined' && TANKS[state.selected]) ? TANKS[state.selected] : null;
    var out = {
      _comment: 'Tank Editor setup — paste these fields into the TANKS entry in js/config.js',
      id: state.selected,
      name: (def && def.name) || state.selected,
      model: (def && def.model) || state.selected,
    };
    if(state.imported) out._importedFile = state.imported.file;
    /* Only emit the orientation when one is actually set, so an untouched tank
       does not grow a pointless pair. */
    if(v.model.front && v.model.up){
      out.modelFront = v.model.front;
      out.modelUp = v.model.up;
    } else {
      out.modelYaw = v.model.yaw || 0;
    }
    if((v.model.x || v.model.y || v.model.z)){
      out._modelOffset = { x: v.model.x || 0, y: v.model.y || 0, z: v.model.z || 0 };
    }
    /* Only when it differs from the game's default of 1, so a def that was
       merely measured does not gain a line it does not need. This is the
       number that makes an imported model the right size in the world. */
    if(v.model.scale && Math.abs(v.model.scale - 1) > 1e-6){
      out.modelScale = round(v.model.scale);
    }
    /* Only when it is actually turned. Zero rotation is what a tank without
       modelRotate means, and writing three zeroes into every def makes the one
       tank that genuinely needs them impossible to spot. */
    if(v.model.rx || v.model.ry || v.model.rz){
      out.modelRotate = { x: round(v.model.rx || 0), y: round(v.model.ry || 0), z: round(v.model.rz || 0) };
    }
    out.body = { w: v.body.w, h: v.body.h, l: v.body.l };
    out.pivot = { x: v.pivot.x, y: v.pivot.y, z: v.pivot.z };
    /* The turret block carries BOTH the turret's box size (w/h/l) and its
       measured mount point (x/y/z), exactly the shape config.js already uses
       (see the striker / mortar entries there). Emitting only x/y/z would
       clobber w/h/l and break the turret mesh, so merge the live mount point
       on top of whatever size the def already has. */
    out.turret = Object.assign({}, (def && def.turret) || {}, { x: v.turret.x, y: v.turret.y, z: v.turret.z });
    /* The fire point is where the shell leaves the barrel (barrelEnd in the
       preview, barrelEnd in the game). config.js already names this firePoint;
       the editor internally calls it shell, but the exported name is firePoint
       so the game actually reads it. */
    out.firePoint = { x: v.shell.x, y: v.shell.y, z: v.shell.z };
    /* The casing (spent-shell eject) point. config.js already names this
       casingPoint; the editor internally calls it casing, but the exported
       name is casingPoint so the game actually reads it. */
    out.casingPoint = { x: v.casing.x, y: v.casing.y, z: v.casing.z };
    /* _modelOffset is the name the editor PRINTS for your reference only —
       the game does not read that key (see config.js's own comment on it). The
       value that actually moves the model is the model:{x,y,z} pair, which is
       already emitted above, so do not write _modelOffset into config.js. */
    var s = state.stats;
    if(s && s.size){
      out._measured = {
        widthX: +s.size.x.toFixed(2), heightY: +s.size.y.toFixed(2), lengthZ: +s.size.z.toFixed(2),
        triangles: s.tris, meshes: s.meshes, nodes: s.nodes,
        sitsOnGround: s.grounded,
        hasHullNode: s.hasHull, hasTurretNode: s.hasTurret, hasTurretPivot: s.hasPivot,
      };
    }
    return JSON.stringify(out, null, 2);
  }

  /* THE PLAIN-ENGLISH VERSION: what was measured, and what it means. */
  function buildReport(){
    var s = state.stats;
    var v = state.values;
    var lines = [];
    lines.push('Tank: ' + state.selected + (state.imported ? '  (from ' + state.imported.file + ')' : ''));
    lines.push('');
    lines.push('ORIENTATION');
    if(v.model.front && v.model.up){
      lines.push('  modelFront: ' + v.model.front + '   modelUp: ' + v.model.up);
      lines.push('  -> the model is rotated so its ' + v.model.front + ' faces the way the tank drives.');
    } else {
      lines.push('  no front/up set — falls back to modelYaw ' + (v.model.yaw || 0));
    }
    var cf = currentForward();
    if(cf){
      lines.push('  solved forward: ' + fmtAxis(cf.f) + '   up: ' + fmtAxis(cf.u));
      lines.push('  correct: ' + (orientIsSolved(cf) ? 'YES' : 'NO — still wrong'));
    }
    lines.push('');
    lines.push('HITBOX  w ' + v.body.w + '  h ' + v.body.h + '  l ' + v.body.l);
    lines.push('PIVOT   ' + fmtAxis(new THREE.Vector3(v.pivot.x, v.pivot.y, v.pivot.z)));
    lines.push('FIRE    ' + fmtAxis(new THREE.Vector3(v.shell.x, v.shell.y, v.shell.z)));
    lines.push('CASING  ' + fmtAxis(new THREE.Vector3(v.casing.x, v.casing.y, v.casing.z)));
    if(s && s.size){
      lines.push('');
      lines.push('MEASURED');
      lines.push('  size (world units)  X ' + s.size.x.toFixed(2) + '  Y ' + s.size.y.toFixed(2) + '  Z ' + s.size.z.toFixed(2));
      lines.push('  triangles ' + s.tris + '   meshes ' + s.meshes + '   nodes ' + s.nodes + '   materials ' + s.mats);
      lines.push('  sits on ground: ' + (s.grounded ? 'yes' : 'NO — the hull floats'));
      lines.push('  rig: hull node ' + (s.hasHull?'yes':'no') + ', turret node ' + (s.hasTurret?'yes':'no') + ', turret pivot ' + (s.hasPivot?'yes':'no'));
    }
    return lines.join('\n');
  }

  function doSave(){
    var id = state.selected;
    var v = state.values;
    /* model carries front/up as well as the yaw, so the whole orientation
       round-trips through the override store. */
    var patch = { body: Object.assign({}, v.body), pivot: Object.assign({}, v.pivot), turret: Object.assign({}, v.turret), shell: Object.assign({}, v.shell), casing: Object.assign({}, v.casing), model: Object.assign({}, v.model) };
    /* The running gear goes out with everything else.

       This is the line that decides whether the tracks panel is real or
       decorative. Everything else on this screen reaches the game through
       `patch`, so a block that is not on it is a block the player can spend an
       afternoon filling in and then lose on export — which is what would have
       happened to the whole Tracks mode without this.

       ONLY THE TOUCHED KEYS, for the reason in state.tracksTouched: the panel
       displays resolved numbers so you can see what the tank will draw, and
       exporting those verbatim would pin every derived dimension to today's
       body size. A tank nobody ever opened the panel for exports no `tracks` at
       all. */
    var trk = (v.tracks || {});
    var touched = state.tracksTouched[id] || {};
    var trkOut = {};
    var trkKeys = 0;
    for(var tk in trk){
      if(!touched[tk]) continue;
      if(trk[tk] !== undefined && trk[tk] !== null){ trkOut[tk] = trk[tk]; trkKeys++; }
    }
    if(trkKeys) patch.tracks = trkOut;
    setOv(id, patch);
    if(state.tank && state.tank._applyEditorOverrides) state.tank._applyEditorOverrides();
    if(state.tank) applyValuesToScene();
    rebuildTracksPreview();
    pushHistory();
    // Send the whole override map so every game client gets identical tanks
    pushRemoteOverrides().then(function(ok){
      toast('Saved "' + id + '"' + (ok ? ' — applied to all clients' : ' (cloud sync failed, saved locally)'));
    });
    // Copy shareable code to clipboard
    try {
      var code = btoa(JSON.stringify({ tank: id, data: patch }));
      navigator.clipboard.writeText(code).then(function(){
        toast('Code copied to clipboard — send it to share your edits!');
      }).catch(function(){
        // Fallback: select from a temp textarea
        var ta = document.createElement('textarea');
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast('Code copied to clipboard!');
      });
    } catch(e){}
  }

  function doReset(){
    clearOv(state.selected);
    var def = (typeof TANKS !== 'undefined' && TANKS[state.selected]) ? TANKS[state.selected] : TANKS.coolbuddy;
    state.values.body = Object.assign({}, def.body);
    state.values.pivot = { x:0, y:0, z:0 };
    state.values.turret = { x:0, y:0, z:0 };
    state.values.shell = { x:0, y:0, z:0 };
    state.values.casing = { x:0, y:0, z:0 };
    var defAnim = !(def && def.playAnims === false);
    var defOutline = !(def && def.outline === false);
    var defYaw = (def && def.modelYaw != null) ? def.modelYaw : 0;
    /* Reset to the def's own orientation, not to "no orientation": a tank that
       ships with modelFront/modelUp in config.js should come back to that, not
       to a yaw that describes a different rotation entirely. */
    state.values.model = {
      x:0, y:0, z:0, yaw:defYaw, anim:defAnim, outline:defOutline,
      front: (def && def.modelFront) ? def.modelFront : '',
      up: (def && def.modelUp) ? def.modelUp : '',
    };
    pickTank(state.selected);
    toast('"' + state.selected + '" reset to defaults');
  }

  function dispose(){
    if(state.keyHandler){ document.removeEventListener('keydown', state.keyHandler); state.keyHandler = null; }
    if(state.resizeHandler){ window.removeEventListener('resize', state.resizeHandler); state.resizeHandler = null; }
    if(state.gizmo){
      try{ state.gizmo.detach(); state.gizmo.dispose(); }catch(e){}
      state.gizmo = null;
    }
    if(state.gizmoHelper){
      try{ if(state.scene) state.scene.remove(state.gizmoHelper); }catch(e){}
      state.gizmoHelper = null;
    }
    if(state.controls){ try{ state.controls.dispose(); }catch(e){} state.controls = null; }
    clearTank();
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
    if(document.getElementById('te-css')) return;
    var st = document.createElement('style');
    st.id = 'te-css';
    st.textContent = [
/* ------------------------------------------------------------
   THE FRAME
   A tool is a fixed chrome around one flexible pane. Everything here is
   sized in one direction only — the rail and inspector are fixed widths and
   never grow, the viewport takes what is left — so nothing reflows when a
   number gets a digit longer, and no panel can push the viewport off screen.
   ------------------------------------------------------------ */
'.te-root{display:flex;flex-direction:column;height:100%;width:100%;background:#14171c;color:#d8dce2;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}' +
'.te-body{display:flex;flex:1;min-height:0}' +
'.te-grow{flex:1}' +
'.te-hidden{display:none}' +

'.te-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1e24;border-bottom:1px solid #262b33;flex:0 0 auto}' +
'.te-brand{font-weight:800;font-size:13px;letter-spacing:1.2px;color:#fff;white-space:nowrap}' +
'.te-brand span{color:#ffb12b}' +
'.te-head-field{width:230px}' +
'.te-inline{display:inline-block;margin:0;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7f8896}' +

/* ------------------------------------------------------------
   THE RAIL — what part of the tank
   Two lines per mode: the name, and under it what it is for. The second line
   is the point. A rail of bare labels is a menu; a rail of labels plus purpose
   is documentation that happens to be clickable, and it means nobody has to
   hover to find out whether "Pivot" means the thing that turns or the thing
   the turret is bolted to.
   ------------------------------------------------------------ */
'.te-rail{width:186px;min-width:186px;background:#171b21;border-right:1px solid #262b33;overflow-y:auto;padding:10px 8px 16px;display:flex;flex-direction:column;gap:2px}' +
'.te-rail-group{margin-bottom:10px}' +
'.te-rail-title{font-size:9.5px;letter-spacing:1.4px;color:#5f6875;font-weight:700;padding:4px 8px 5px}' +
'.te-mode{display:block;padding:6px 9px;border-radius:7px;cursor:pointer;border:1px solid transparent;margin-bottom:2px}' +
'.te-mode:hover{background:#1f242c;border-color:#2f3641}' +
'.te-mode.te-on{background:#2a2114;border-color:#ffb12b}' +
'.te-mode-label{display:block;font-size:12.5px;font-weight:600;color:#c3cad3}' +
'.te-mode-hint{display:block;font-size:10px;color:#6c7583;margin-top:1px}' +
'.te-mode.te-on .te-mode-label{color:#ffcf7a}' +
'.te-mode.te-on .te-mode-hint{color:#9a8256}' +
'.te-rail-foot{margin-top:auto;border-top:1px solid #262b33;padding-top:8px}' +

/* ------------------------------------------------------------
   THE VIEWPORT
   ------------------------------------------------------------ */
'.te-stage{flex:1;display:flex;flex-direction:column;position:relative;min-width:0;background:#0f1216}' +
'.te-view{flex:1;position:relative;overflow:hidden;min-height:0}' +
'.te-axisbar{display:flex;gap:5px;padding:7px 10px;background:#14171c;border-top:1px solid #232830;flex:0 0 auto;align-items:center}' +
'.te-axis{padding:5px 12px;background:#1d2229;border:1px solid #2a2f36;border-radius:6px;cursor:pointer;font-size:11.5px;color:#aab2bd;user-select:none}' +
'.te-axis:hover{border-color:#ffb12b;color:#fff}' +
'.te-axis-fit{margin-left:auto;border-color:#39414c;color:#8f98a5}' +
'.te-axis-fit:hover{color:#fff;border-color:#ffb12b}' +

/* ------------------------------------------------------------
   THE INSPECTOR — the values for the chosen part
   ------------------------------------------------------------ */
'.te-insp{width:312px;min-width:312px;background:#171b21;border-left:1px solid #262b33;display:flex;flex-direction:column;overflow-y:auto}' +
'.te-insp-title{position:sticky;top:0;z-index:2;background:#171b21;border-bottom:1px solid #262b33;padding:10px 14px;font-size:11px;font-weight:700;letter-spacing:1.3px;color:#ffb12b}' +
'.te-insp-body{padding:12px 14px 4px;flex:0 0 auto}' +
'.te-note{padding:0 14px 10px;font-size:11px;color:#8892a0;line-height:1.55}' +
'.te-note b{color:#cfd6de}' +
'.te-insp-actions{padding:10px 14px 18px;margin-top:auto;border-top:1px solid #232830;background:#15181d}' +
'.te-act-row{display:flex;gap:6px;align-items:center;margin-bottom:8px}' +
'.te-act-row .te-btn{flex:1}' +

/* ------------------------------------------------------------
   THE STATUS BAR — never scrolls, never rebuilt
   ------------------------------------------------------------ */
'.te-foot{display:flex;align-items:center;gap:10px;padding:7px 12px;background:#1a1e24;border-top:1px solid #262b33;flex:0 0 auto}' +
'.te-foot-info{font-size:11px;color:#78828f;font-family:ui-monospace,Consolas,monospace}' +
'.te-foot .te-btn{flex:0 0 auto;padding:6px 11px}' +
'.te-setupstate{font-size:11.5px;font-weight:700;padding:6px 11px;border-radius:7px;line-height:1.4}' +
'.te-setupstate.te-ok{background:#16301f;border:1px solid #2f6b3f;color:#7ee08f}' +
'.te-setupstate.te-warn{background:#312619;border:1px solid #6b5326;color:#ffc46b}' +

/* ------------------------------------------------------------
   CONTROLS
   One control style everywhere. They were three before — te-btn, te-mode,
   te-pickbtn, te-toggle all drew their own box — which is why the sidebar
   looked like a stack of unrelated widgets rather than one form.
   ------------------------------------------------------------ */
'.te-btn{padding:7px 12px;background:#222830;border-radius:7px;cursor:pointer;font-size:12px;color:#b8c0ca;text-align:center;border:1px solid #2b313a;user-select:none;white-space:nowrap}' +
'.te-btn:hover{border-color:#ffb12b;color:#fff}' +
'.te-btn-primary{background:#b8811f;border-color:#b8811f;color:#111;font-weight:700}' +
'.te-btn-primary:hover{background:#d19526;color:#000}' +
'.te-btn-ghost{background:transparent}' +
'.te-btn-icon{padding:7px 10px;font-size:14px;line-height:1}' +
'.te-btn.te-on{background:#b8811f;border-color:#b8811f;color:#111;font-weight:700}' +
'.te-toggle{flex:1;text-align:center;padding:6px 8px;background:#1d2229;border:1px solid #2a2f36;border-radius:7px;cursor:pointer;font-size:11.5px;color:#98a1ad;user-select:none}' +
'.te-toggle:hover{border-color:#ffb12b;color:#fff}' +
'.te-toggle.te-on{background:#b8811f;border-color:#b8811f;color:#111;font-weight:700}' +
'.te-input{width:100%;background:#1d2229;border:1px solid #2a2f36;color:#eee;border-radius:7px;padding:6px 9px;font-size:12.5px;box-sizing:border-box}' +
'.te-input:focus{outline:none;border-color:#ffb12b}' +
    /* THE TANK PICKER. A native select, dressed to match the field it sits
       beside — an unstyled dropdown next to a styled text box looks like two
       different controls that happen to be adjacent.

       `appearance:none` plus a drawn chevron is what allows the arrow to be
       coloured at all: the native one is drawn by the OS and ignores every
       colour set on the element. It is a background image rather than a
       character so it cannot be knocked out of line by the line-height. */
    '.te-select{appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:26px;' +
      'background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 10 6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' fill=\'none\' stroke=\'%23ffb12b\' stroke-width=\'1.6\' stroke-linecap=\'round\'/%3E%3C/svg%3E");' +
      'background-repeat:no-repeat;background-position:right 9px center;background-size:9px 6px;}' +
    '.te-select option{background:#1d2229;color:#eee}' +
    '.te-head-field{display:flex;gap:6px;align-items:center;min-width:0}' +
    '.te-head-field .te-input{width:auto;min-width:140px}' +
    '.te-head-field .te-select{flex:1 1 auto;max-width:250px}' +
      /* The scale readout. The multiplier on its own is not a size, so the
         number people actually need — how big the tank now is — sits beside it
         rather than having to be worked out from the model. */
      '.te-scale-now{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px}' +
      '.te-scale-now div{background:#1c2128;border:1px solid #2c333d;border-radius:7px;padding:6px 4px;text-align:center}' +
      '.te-scale-now span{display:block;font-size:9.5px;letter-spacing:.8px;color:#5f6875;font-weight:700}' +
      '.te-scale-now b{display:block;font-size:14px;color:#ffb12b;font-family:ui-monospace,Consolas,monospace;margin-top:2px}' +

/* ------------------------------------------------------------
   FIELDS
   Label above, box below, but the label is a DRAG HANDLE. Every 3D tool
   worth using lets you scrub a number by dragging its name, because typing
   three digits into a box to move something by a third of a unit is the
   slowest way to do it, and it is the action performed most often.
   ------------------------------------------------------------ */
'.te-field{display:flex;flex-direction:column;gap:3px;margin-bottom:6px}' +
'.te-field span{font-size:10.5px;color:#8a94a1;letter-spacing:.2px;cursor:ew-resize;user-select:none;display:flex;justify-content:space-between}' +
'.te-field span.te-dirty{color:#ffb12b}' +
'.te-field input{background:#1d2229;border:1px solid #2a2f36;color:#fff;border-radius:6px;padding:5px 8px;font-size:12.5px;width:100%;box-sizing:border-box;font-family:ui-monospace,Consolas,monospace}' +
'.te-field input:focus{outline:none;border-color:#ffb12b}' +
'.te-field input.te-dirty{border-color:#b8811f}' +
'.te-sub{font-size:10px;letter-spacing:1.2px;color:#5f6875;font-weight:700;margin:14px 0 6px;text-transform:uppercase}' +
'.te-sub:first-child{margin-top:0}' +

/* ------------------------------------------------------------
   FACING — the panel that matters
   ------------------------------------------------------------ */
'.te-pick{background:#1c2128;border:1px solid #2c333d;border-radius:9px;padding:10px 11px;margin-bottom:12px}' +
'.te-pick-title{color:#ffb12b;font-weight:800;font-size:12px;letter-spacing:.4px;margin-bottom:5px}' +
'.te-pick-hint{font-size:11px;color:#9aa4b1;line-height:1.55;margin-bottom:8px}' +
'.te-pick-hint b{color:#fff}' +
'.te-pick-row{display:flex;gap:5px}' +
'.te-pickbtn{flex:1;text-align:center;padding:7px 4px;background:#1d2229;border:1px solid #2a2f36;border-radius:7px;cursor:pointer;font-size:11px;color:#b3bcc7}' +
'.te-pickbtn:hover{border-color:#ffb12b;color:#fff}' +
'.te-pickbtn.te-on{background:#b8811f;color:#111;font-weight:700;border-color:#b8811f}' +

/* The six axis buttons stay as the precise fallback. Wide, and the chosen one
   unmistakable — it is the answer to the question. */
'.te-axisrow{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}' +
'.te-axisbtn{padding:7px 0;text-align:center;background:#1d2229;border:1px solid #2a2f36;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;color:#aab3bf}' +
'.te-axisbtn:hover{border-color:#ffb12b;color:#fff}' +
'.te-axisbtn.te-on{background:#b8811f;border-color:#b8811f;color:#111}' +

/* ------------------------------------------------------------
   READOUTS
   ------------------------------------------------------------ */
'.te-stat{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:4px 0;border-bottom:1px solid #20252c;font-size:11px;color:#8a94a1}' +
'.te-stat b{color:#e6e6e6;font-family:ui-monospace,Consolas,monospace;font-size:12px;font-weight:600}' +
'.te-stat-warn b{color:#ff6b5b}' +
'.te-nodelist{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;max-height:150px;overflow-y:auto}' +
'.te-nodelist span{background:#1d2229;border:1px solid #2a2f36;border-radius:5px;padding:2px 6px;font-size:10px;font-family:ui-monospace,Consolas,monospace;color:#9fb3c8}' +
'.te-angle{color:#ffb12b;font-weight:700;font-size:12px;min-width:36px;text-align:right}' +
'.te-ok{color:#5fe08a !important}' +
'.te-warn{color:#ff6b5b !important}' +

/* ------------------------------------------------------------
   OVERLAYS
   ------------------------------------------------------------ */
'.te-toast{position:absolute;bottom:58px;left:50%;transform:translateX(-50%);z-index:8;background:#ffb12b;color:#111;font-weight:700;font-size:12.5px;padding:9px 18px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .16s;white-space:nowrap;max-width:80%;overflow:hidden;text-overflow:ellipsis}' +
'.te-toast.te-show{opacity:1}' +
'.te-helpcard{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(8,10,13,.72);backdrop-filter:blur(2px)}' +
'.te-helpcard-in{background:#1c2128;border:1px solid #333b46;border-radius:12px;padding:20px 24px;min-width:320px;box-shadow:0 20px 60px rgba(0,0,0,.6)}' +
'.te-helpcard-title{font-size:12px;font-weight:800;letter-spacing:1.4px;color:#ffb12b;margin-bottom:12px}' +
'.te-helpcard-row{display:flex;justify-content:space-between;gap:24px;padding:5px 0;border-bottom:1px solid #232830;font-size:12px}' +
'.te-helpcard-row b{color:#fff;font-family:ui-monospace,Consolas,monospace;font-weight:600;white-space:nowrap}' +
'.te-helpcard-row span{color:#98a1ad;text-align:right}' +
'.te-helpcard-close{font-size:10.5px;color:#5f6875;text-align:center;margin-top:14px}'
    ].join('');
    document.head.appendChild(st);
  }

  return {
    render: render,
    dispose: dispose,
    getOverrides: function(){ return window.TANK_EDITOR_OVERRIDES; },
    syncGlobal: syncGlobal,
  };
})();
