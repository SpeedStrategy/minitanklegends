/* ============================================================
   input.js — keyboard + mouse + wheel + TOUCH (mobile dual joystick),
   with rebindable keybinds.
   ============================================================ */

/* Pointer lock is a mouse feature. Nine call sites ask for it; on a phone (no
   fine pointer) or in a frame/tab that is not focused, the browser rejects the
   returned promise and it surfaced as an uncaught WrongDocumentError. One
   wrapper here: skip it where there is no mouse, swallow a refusal elsewhere. */
(function(){
  const proto = window.Element && Element.prototype;
  if(!proto || !proto.requestPointerLock || proto.requestPointerLock._mtlSafe) return;
  const orig = proto.requestPointerLock;
  const safe = function(){
    if(window.matchMedia && !matchMedia('(any-pointer: fine)').matches) return undefined;
    try{
      const r = orig.apply(this, arguments);
      if(r && typeof r.catch === 'function') r.catch(()=>{});
      return r;
    }catch(e){ return undefined; }
  };
  safe._mtlSafe = true;
  proto.requestPointerLock = safe;
})();

class TouchJoystick {
  constructor(containerId, opts={}){
    this.container = document.getElementById(containerId);
    if(!this.container) return;
    this.opts = Object.assign({
      size: 130,
      deadZone: 0.08,

      // movement joystick:
      //   - getValue() -> {x,y,firing:false}
      // turret joystick:
      //   - getValue() -> {x,y,relAngle,armed,firePulse}
      turretFireMode: 'none',   // 'none' | 'armedPress'
      armedThreshold: 0.98,    // normalized distance for "drag to max"
      maxFireDistance: 1.0,    // clamp
    }, opts);

    this.active = false;
    this.touchId = -1;

    this.dx = 0; // -1..1
    this.dy = 0;

    // turret state
    this.relAngle = 0;     // radians, relative to joystick "up"
    this.armed = false;   // dragged to max ring
    this.firePulse = false; // one-frame pulse when user presses while armed

    // one-frame helper to detect "press again"
    this._pressedWhileArmed = false;

    this._build();
    this._bindEvents();
  }

  _build(){
    this.container.innerHTML = '';

    // Dynamic sizing: scale joystick to viewport, cap at desired size
    const shortSide = Math.min(window.innerWidth, window.innerHeight);
    const joySize = Math.min(this.opts.size, Math.max(64, shortSide * 0.3));
    this.container.style.width = joySize + 'px';
    this.container.style.height = joySize + 'px';

    // Outer ring
    this.outer = document.createElement('div');
    this.outer.className = 'joystick-outer';
    this.container.appendChild(this.outer);

    // Inner knob — size relative to container
    this.knob = document.createElement('div');
    this.knob.className = 'joystick-knob';
    const knobSize = Math.round(joySize * 0.38);
    this.knob.style.width = knobSize + 'px';
    this.knob.style.height = knobSize + 'px';
    this.outer.appendChild(this.knob);

    this._half = joySize / 2;
    this._maxDist = this._half - knobSize / 2 - 4;
  }

  _bindEvents(){
    const el = this.container;

    const getPos = (touches, id) => {
      for(let t of touches){
        if(t.identifier === id) return {x: t.clientX, y: t.clientY};
      }
      return null;
    };

    // document-level handler to prevent iOS WKWebView from
    // stealing the gesture in standalone/PWA mode
    const preventDocMove = (e) => { e.preventDefault(); };
    this._preventDocMove = preventDocMove;

    const onStart = (e) => {
      e.preventDefault();

      // One-frame pulse for turret:
      // When in armed state, touching again triggers firePulse.
      if(this.opts.turretFireMode === 'armedPress' && this.armed){
        this.firePulse = true;
      }

      for(let t of e.changedTouches){
        if(!this.active){
          this.active = true;
          this.touchId = t.identifier;
          this._centerX = t.clientX;
          this._centerY = t.clientY;
          this._updateKnob(0, 0);

          this.dx = 0;
          this.dy = 0;
          this.firePulse = false;

          // reset armed when touch begins; it will re-arm onMove
          this.armed = false;

          // Lock all touchmove to this document while joystick is
          // active — necessary for iOS standalone (home screen) mode
          document.addEventListener('touchmove', preventDocMove, {passive: false});
        }
      }
    };

    const onMove = (e) => {
      e.preventDefault();
      const pos = getPos(e.changedTouches, this.touchId);
      if(!pos) return;

      let dx = pos.x - this._centerX;
      let dy = pos.y - this._centerY;

      let dist = Math.hypot(dx, dy);

      // Clamp to max distance
      if(dist > this._maxDist){
        dx = dx / dist * this._maxDist;
        dy = dy / dist * this._maxDist;
        dist = this._maxDist;
      }

      this._updateKnob(dx, dy);

      // Normalize to -1..1
      let nx = dx / this._maxDist;
      let ny = dy / this._maxDist;

      // Dead zone
      if(Math.abs(nx) < this.opts.deadZone) nx = 0;
      if(Math.abs(ny) < this.opts.deadZone) ny = 0;

      this.dx = nx;
      this.dy = ny;

      // update turret relAngle + armed state
      if(this.opts.turretFireMode === 'armedPress'){
        // joystick "up" is negative dy (screen coords), so angle relative to up:
        // relAngle = atan2(x, -y)
        const ang = Math.atan2(this.dx, -this.dy);
        this.relAngle = ang;

        const mag = Math.min(1, Math.hypot(this.dx, this.dy));
        this.armed = mag >= this.opts.armedThreshold;
      }
    };

    const onEnd = (e) => {
      for(let t of e.changedTouches){
        if(t.identifier === this.touchId){
          this.active = false;
          this.touchId = -1;

          this.dx = 0;
          this.dy = 0;

          this.armed = false;
          this.firePulse = false;

          this._updateKnob(0, 0);

          document.removeEventListener('touchmove', preventDocMove, {passive: false});
        }
      }
    };

    el.addEventListener('touchstart', onStart, {passive: false});
    el.addEventListener('touchmove', onMove, {passive: false});
    el.addEventListener('touchend', onEnd, {passive: false});
    el.addEventListener('touchcancel', onEnd, {passive: false});
  }

  _updateKnob(dx, dy){
    if(this.knob){
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  }

  getValue(){
    return {x: this.dx, y: this.dy, firing: this.firing, relAngle: this.relAngle, armed: this.armed};
  }

  /* Force-clear any active touch and return the knob to center. Called when a
     battle ends mid-drag so a finger still in the air can't keep driving. */
  reset(){
    if(this._preventDocMove){
      try { document.removeEventListener('touchmove', this._preventDocMove, {passive: false}); } catch(e){}
      this._preventDocMove = null;
    }
    this.active = false;
    this.touchId = -1;
    this.dx = 0;
    this.dy = 0;
    this.armed = false;
    this.firePulse = false;
    this.firing = false;
    this._updateKnob(0, 0);
  }
}

class Input {
  constructor(settings){
    this.settings = settings;
    this.keys = {};
    this.mouse = { x:0, y:0, ndcX:0, ndcY:0, down:false };
    this.binds = settings.binds;
    this.wheel = 0;

    /* MODE 1 AIM PITCH: screen-vertical mouse delta, drained by game.js in
       dynamic mode for every NON-artillery tank (the mortar still owns
       mouse-Y for its range — see _aimRangeAccum). Reset with the range
       accumulator whenever pointer lock drops so a stale delta can't fire
       one enormous pitch jump a second later. */
    this._aimPitchAccum = 0;

    // Pointer lock state
    this._pointerLocked = false;
    this._pointerLockEl = null;

    /* ARTILLERY AIMS THROUGH THE TURRET, LIKE EVERY OTHER TANK.

       This file used to refuse pointer lock for the Mortar and threw the lock
       back out on the first mouse move, because game.js ray-cast the artillery
       solution off the raw cursor position -- and pointer lock freezes
       clientX/clientY, so that ray went dead the instant the cursor was hidden.
       The result was a tank that fought the mouse: "it stops working then your
       mouse cursor disappears".

       The mortar is now swung by the turret like any other gun, so it locks
       normally, the cursor is hidden while you aim, right mouse still freezes
       the turret, and the camera still follows the turret. Range is the ONE
       extra axis and it reads mouse-Y, which is free once mouse-X is turning
       the gun. See consumeAimRange() below. */
    /* THE GAME OBJECT HAS NO GLOBAL NAME. `Menu.game` is the only reference —
       there is no `window.game`, so every `typeof game !== 'undefined'` test in
       this file was always false and the countdown guards below never blocked
       anything. Resolve it once, correctly, for every site that needs it. */
    this._game = () => {
      try{
        if(typeof Menu !== 'undefined' && Menu && Menu.game) return Menu.game;
      }catch(e){}
      try{
        if(typeof game !== 'undefined' && game) return game;
      }catch(e){}
      return null;
    };

    /* THE ARTILLERY RANGE AXIS.

       Mortar shells are not infinite: the gun has a maximum reach and a dead
       zone it cannot lob into, so the shot needs a second number. Mouse-X is
       already turning the turret for every tank, so mouse-Y is the only axis
       left over, and it is read here exactly the way the turret's mouse-X is --
       accumulated as a raw delta and drained once per frame by game.js.

       Under pointer lock that has to be movementY, because clientX/clientY stop
       changing the moment the cursor is hidden. Before the lock engages the
       screen delta is used instead, so walking up to the tank and aiming gives
       the same feel either way.

       Only the DYNAMIC camera mode consumes it (game.js asks for it there).
       In the other modes the cursor is free and is already choosing where the
       shell lands, so a second axis reading the same motion would make range
       drift under the player instead of standing still. */
    this._aimRangeAccum = 0;

    // Touch state
    this.isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    this._touchInput = { throttle: 0, turn: 0, turretAngle: 0, fire: false };
    this._moveJoystick = null;
    this._turretJoystick = null;

    // Pinch-to-zoom state
    this._pinchTouchIds = [];
    this._pinchDist = 0;
    this._pinchAccum = 0;

    window.addEventListener('keydown', e=>{
      this.keys[e.code]=true;
      if(e.code==='Space') e.preventDefault();
      if(e.code==='ControlLeft' || e.code==='ControlRight'){
        document.body.classList.add('ctrl-held');
        if(this._pointerLocked) document.exitPointerLock();
      }
    });
    window.addEventListener('keyup',   e=>{
      this.keys[e.code]=false;
      if(e.code==='ControlLeft' || e.code==='ControlRight'){
        document.body.classList.remove('ctrl-held');
        if(!this._pointerLocked){
          const c = canvas();
          const isDynamic = this._isEffDynamic();
          // Don't lock during countdown or while tank selector is visible
          const tsp = document.getElementById('tank-switch-panel');
          const gm = this._game();
          const inCountdown = !!(gm && (gm._cinematicPhase || gm._matchStartDelay > 0));
          const selectorVisible = tsp && !tsp.classList.contains('hidden');
          if(isDynamic && c && document.body.classList.contains('crosshair-mode') && !inCountdown && !selectorVisible){
            c.requestPointerLock();
          }
        }
      }
    });

    const canvas = ()=> document.querySelector('#game-root canvas');
    document.addEventListener('mousemove', e=>{
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      const c = canvas();
      if(c){
        const r = c.getBoundingClientRect();
        this.mouse.ndcX =  ((e.clientX-r.left)/r.width )*2-1;
        this.mouse.ndcY = -((e.clientY-r.top )/r.height)*2+1;
      }
      /* A locked pointer freezes clientX/clientY, so ndcX/ndcY above stop
         changing. That is correct and expected now: the turret is aimed by
         mouse DELTA, not by the cursor's position, so ndcX/ndcY is only read
         by the pointer-aimed camera modes, which never lock. Nothing to undo. */
    });
    document.addEventListener('mousedown', e=>{ if(e.button===0) this.mouse.down=true; if(e.button===1) this.mouse.midDown=true; if(e.button===2) this.mouse.rightDown=true; });
    document.addEventListener('mouseup',   e=>{ if(e.button===0) this.mouse.down=false; if(e.button===1) this.mouse.midDown=false; if(e.button===2) this.mouse.rightDown=false; });
    document.addEventListener('contextmenu', e=>e.preventDefault());

    window.addEventListener('wheel', e=>{
      this.wheel += (e.deltaY < 0 ? 1 : -1);
    }, {passive:true});

    window.addEventListener('blur', ()=>{ this.keys={}; this.mouse.down=false; this.mouse.midDown=false; this.mouse.rightDown=false; this._camRotateTouch=0; });

    // Pointer lock: capture mouse for infinite 360° rotation in dynamic mode
    document.addEventListener('pointerlockchange', ()=>{
      this._pointerLocked = document.pointerLockElement != null;
      this._pointerLockEl = document.pointerLockElement;
      // Reset last mouse position to avoid a delta jump when toggling lock
      if(!this._pointerLocked){
        this._camSwipeMouseLastX = 0;
        this._camSwipeMouseLastY = 0;
      }
    });
    // Request pointer lock on canvas click (only during gameplay in dynamic mode)
    document.addEventListener('mousedown', (e)=>{
      if(e.button !== 0) return;
      const c = canvas();
      if(!c) return;
      if(e.target !== c) return;
      // Don't lock pointer while tank selector is visible
      const tsp = document.getElementById('tank-switch-panel');
      if(tsp && !tsp.classList.contains('hidden')) return;
      // Don't lock during cinematic or countdown
      const gm = this._game();
      if(gm && (gm._cinematicPhase || gm._matchStartDelay > 0)) return;
      const isDynamic = this._isEffDynamic();
      /* Every tank locks now, artillery included. The mortar is aimed through
         its turret by mouse DELTA, which pointer lock keeps delivering via
         movementX/movementY, and its range reads movementY -- so hiding the
         cursor costs the player nothing and buys an unmasked play area. */
      if(isDynamic && !this._pointerLocked){
        c.requestPointerLock();
      }
    });

    // Camera swipe (one-finger drag to rotate camera in swipe mode)
    this._camSwipeId = null;
    this._camSwipeLastX = 0;
    this._camSwipeLastY = 0;
    this._camSwipeAccum = 0;
    this._camSwipeAccumY = 0;
    const isControlSurface = (target) => {
      return !!(target && target.closest && target.closest('.joystick-container, .cam-rotate-btns, #cam-rotate-btns, .hud, #hud'));
    };
    document.addEventListener('touchstart', (e) => {
      if(this._camSwipeId === null){
        for(let t of e.changedTouches){
          if(!isControlSurface(e.target)){
            this._camSwipeId = t.identifier;
            this._camSwipeLastX = t.clientX;
            this._camSwipeLastY = t.clientY;
            this._camSwipeAccum = 0;
            this._camSwipeAccumY = 0;
            break;
          }
        }
      }
    }, {passive: true});
    document.addEventListener('touchmove', (e) => {
      if(this._camSwipeId === null) return;
      for(let t of e.changedTouches){
        if(t.identifier === this._camSwipeId){
          this._camSwipeAccum += t.clientX - this._camSwipeLastX;
          this._camSwipeAccumY += t.clientY - this._camSwipeLastY;
          this._camSwipeLastX = t.clientX;
          this._camSwipeLastY = t.clientY;
        }
      }
    }, {passive: true});
    document.addEventListener('touchend', (e) => {
      for(let t of e.changedTouches){
        if(t.identifier === this._camSwipeId){
          this._camSwipeId = null;
          this._camSwipeAccum = 0;
          this._camSwipeAccumY = 0;
        }
      }
    }, {passive: true});
    document.addEventListener('touchcancel', (e) => {
      for(let t of e.changedTouches){
        if(t.identifier === this._camSwipeId){
          this._camSwipeId = null;
          this._camSwipeAccum = 0;
          this._camSwipeAccumY = 0;
        }
      }
    }, {passive: true});
    // Tap on free space (super targeting on touch)
    document.addEventListener('touchstart', (e) => {
      if(isControlSurface(e.target)) return;
      if(e.touches.length > 1) return;
      this._recordTap(e);
    }, {passive: true});
    // Mouse drag (desktop testing / desktop swipe mode)
    this._camSwipeMouseDown = false;
    this._camSwipeMouseLastX = 0;
    this._camSwipeMouseLastY = 0;
    this._camMouseRotateAccum = 0; // For mouse-move rotation without LMB
    document.addEventListener('mousedown', (e) => {
      if(e.button !== 0) return;
      if(isControlSurface(e.target)) return;
      this._camSwipeMouseDown = true;
      this._camSwipeMouseLastX = e.clientX;
      this._camSwipeMouseLastY = e.clientY;
    });
    document.addEventListener('mousemove', (e) => {
      const isDynamic = this._isEffDynamic();
      // When pointer is locked, use movementX for unlimited 360° rotation
      /* Range axis: read BEFORE the locked early-return, so aiming with the
       cursor hidden works. Scroll-down (movementY > 0) walks the shot IN,
       scroll-up walks it OUT -- the sign is flipped in game.js so that pushing
       the mouse away from you pushes the target away from you. */
    if(isDynamic) this._aimRangeAccum += (this._pointerLocked ? e.movementY : 0);
      /* Pitch axis: the vertical half of the SAME locked mouse feed, for the
         mode-1 crosshair. Only for tanks that leave mouse-Y free — the mortar
         spends it on range. Gun-side clamping happens in game.js; this stays
         a raw delta so the artillery test stays in one place. */
      if(isDynamic && this._pointerLocked){
        const gm = this._game();
        const lt = gm && gm.localTank;
        if(lt && lt.alive && lt.def && lt.def.shellType !== 'mortar'){
          this._aimPitchAccum += e.movementY;
        }
      }
      if(this._pointerLocked){
        if(isDynamic){
          this._camMouseRotateAccum += e.movementX;
        }
        return;
      }
      // Always track last mouse position for delta calculation
      const isFirstMove = (this._camSwipeMouseLastX === 0 && this._camSwipeMouseLastY === 0);
      const dx = e.clientX - this._camSwipeMouseLastX;
      const dy = e.clientY - this._camSwipeMouseLastY;
      // Capture mouse delta for camera rotation
      // Dynamic mode: always capture (Tanki Online style - mouse rotates camera)
      // Other modes: only capture when cameraMouseRotate setting is on and LMB not held
      if((isDynamic || this.settings.cameraMouseRotate) && !this._camSwipeMouseDown){
        if(!isFirstMove){
          this._camMouseRotateAccum += dx;
        }
        /* Same delta, same dynamic-mode-only gate, for the artillery range. */
        if(isDynamic && !isFirstMove) this._aimRangeAccum += dy;
      }
      this._camSwipeMouseLastX = e.clientX;
      this._camSwipeMouseLastY = e.clientY;
      // Standard swipe (requires LMB) — skip in dynamic mode so firing doesn't rotate camera
      if(!this._camSwipeMouseDown) return;
      if(!isDynamic){
        this._camSwipeAccum += dx;
        this._camSwipeAccumY += dy;
      }
      this._camSwipeMouseLastX = e.clientX;
      this._camSwipeMouseLastY = e.clientY;
    });
    document.addEventListener('mouseup', (e) => {
      if(e.button === 0) this._camSwipeMouseDown = false;
    });
    this.resetCamSwipe = () => { this._camSwipeAccum = 0; this._camSwipeAccumY = 0; this._camMouseRotateAccum = 0; this._camSwipeMouseLastX = 0; this._camSwipeMouseLastY = 0; };

    // Prevent iOS in standalone mode (home screen) from intercepting
    // the first touch as a system gesture
    document.addEventListener('touchstart', (e) => {
      if(e.target.closest('.joystick-container, .cam-rotate-btns, #game-root')) e.preventDefault();
    }, {passive: false});

    // Pinch-to-zoom gesture
    const getTouchById = (touches, id) => {
      for(let t of touches){ if(t.identifier === id) return t; }
      return null;
    };
    document.addEventListener('touchstart', (e) => {
      if(e.touches.length === 2 && (this.settings.pinchZoom !== false)){
        const t0 = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
        const t1 = document.elementFromPoint(e.touches[1].clientX, e.touches[1].clientY);
        // Both fingers must be on free space — never on the joysticks
        if(!isControlSurface(t0) && !isControlSurface(t1)){
          this._pinchTouchIds = [e.touches[0].identifier, e.touches[1].identifier];
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          this._pinchDist = Math.hypot(dx, dy);
        }
      }
    }, {passive: true});
    document.addEventListener('touchmove', (e) => {
      if(this._pinchTouchIds.length === 2){
        const t1 = getTouchById(e.touches, this._pinchTouchIds[0]);
        const t2 = getTouchById(e.touches, this._pinchTouchIds[1]);
        if(t1 && t2){
          const dx = t1.clientX - t2.clientX;
          const dy = t1.clientY - t2.clientY;
          const dist = Math.hypot(dx, dy);
          this._pinchAccum += (dist - this._pinchDist) * 0.03;
          this._pinchDist = dist;
        }
      }
    }, {passive: true});
    document.addEventListener('touchend', (e) => {
      if(e.touches.length < 2){
        this._pinchTouchIds = [];
        this._pinchDist = 0;
      }
    }, {passive: true});

    // Initialize touch joysticks if on mobile
    if(this.isTouchDevice){
      // Create joystick containers if they don't exist
      let moveEl = document.getElementById('joystick-move');
      let turretEl = document.getElementById('joystick-turret');
      
      if(!moveEl){
        moveEl = document.createElement('div');
        moveEl.id = 'joystick-move';
        moveEl.className = 'joystick-container joystick-left';
        document.body.appendChild(moveEl);
      }
      if(!turretEl){
        turretEl = document.createElement('div');
        turretEl.id = 'joystick-turret';
        turretEl.className = 'joystick-container joystick-right';
        document.body.appendChild(turretEl);
      }

      this._moveJoystick = new TouchJoystick('joystick-move', {
        size: 133,
        fireOnMax: false,
      });

      this._turretJoystick = new TouchJoystick('joystick-turret', {
        size: 127,
        turretFireMode: 'armedPress',
        armedThreshold: 0.98,
      });
      
      // Camera rotation touch buttons (for phone)
      let camBtns = document.getElementById('cam-rotate-btns');
      if(!camBtns){
        camBtns = document.createElement('div');
        camBtns.id = 'cam-rotate-btns';
        camBtns.className = 'cam-rotate-btns joystick-hidden';
        camBtns.innerHTML = '<button class="cam-rot-btn" id="cam-rot-left" aria-label="Rotate camera left">◀</button><button class="cam-rot-btn" id="cam-rot-right" aria-label="Rotate camera right">▶</button>';
        document.body.appendChild(camBtns);
      }
      const leftBtn = document.getElementById('cam-rot-left');
      const rightBtn = document.getElementById('cam-rot-right');
      const setCamTouch = (dir) => {
        this._camRotateTouch = dir;
      };
      leftBtn.addEventListener('touchstart', (e) => { e.preventDefault(); setCamTouch(-1); }, {passive: false});
      leftBtn.addEventListener('touchend', (e) => { e.preventDefault(); if(this._camRotateTouch === -1) setCamTouch(0); }, {passive: false});
      leftBtn.addEventListener('touchcancel', (e) => { if(this._camRotateTouch === -1) setCamTouch(0); }, {passive: false});
      rightBtn.addEventListener('touchstart', (e) => { e.preventDefault(); setCamTouch(1); }, {passive: false});
      rightBtn.addEventListener('touchend', (e) => { e.preventDefault(); if(this._camRotateTouch === 1) setCamTouch(0); }, {passive: false});
      rightBtn.addEventListener('touchcancel', (e) => { if(this._camRotateTouch === 1) setCamTouch(0); }, {passive: false});
      // Also support mouse clicks for testing
      leftBtn.addEventListener('mousedown', () => setCamTouch(-1));
      leftBtn.addEventListener('mouseup', () => { if(this._camRotateTouch === -1) setCamTouch(0); });
      leftBtn.addEventListener('mouseleave', () => { if(this._camRotateTouch === -1) setCamTouch(0); });
      rightBtn.addEventListener('mousedown', () => setCamTouch(1));
      rightBtn.addEventListener('mouseup', () => { if(this._camRotateTouch === 1) setCamTouch(0); });
      rightBtn.addEventListener('mouseleave', () => { if(this._camRotateTouch === 1) setCamTouch(0); });

      // Hide joysticks initially (only show during gameplay)
      this.setJoysticksVisible(false);
    }
  }

  consumeCamRotate(){
    let val = 0;
    if(this.keys[this.binds.camLeft]) val -= 1;
    if(this.keys[this.binds.camRight]) val += 1;
    // < and > keys also rotate the camera (common expectation)
    if(this.keys['Comma']) val -= 1;
    if(this.keys['Period']) val += 1;
    const touch = this._camRotateTouch || 0;
    return val || touch;
  }

  consumeCamSwipe(){
    const a = this._camSwipeAccum || 0;
    this._camSwipeAccum = 0;
    return a;
  }

  /* Screen-vertical mouse delta since the last frame, for the artillery range
     axis. Drained by game.js in dynamic camera mode; every other tank simply
     never asks, and the accumulator is cleared here so a long gap cannot arrive
     as one enormous jump. */
  consumeAimRange(){
    const a = this._aimRangeAccum || 0;
    this._aimRangeAccum = 0;
    return a;
  }

  /* Screen-vertical mouse delta for the CROSSHAIR PITCH axis (mode 1). Only
     accumulates while the pointer is locked AND the local tank is not the
     mortar — the artillery owns mouse-Y for range, so the two axes never fight.
     game.js clamps the resulting pitch to AIM_PITCH_*_DEG. */
  consumeAimPitch(){
    const a = this._aimPitchAccum || 0;
    this._aimPitchAccum = 0;
    return a;
  }

  /* EFFECTIVE DYNAMIC MODE, not the stored preference. With the two-mode
     camera the wheel switches stages and can flip the game in and out of
     dynamic dipping — dragging, the pointer-lock re-request and the pitch
     axis must all follow the LIVE mode, not what the settings screen says. */
  _isEffDynamic(){
    const gm = this._game();
    if(gm && gm.cameraMode) return gm.cameraMode === 'dynamic';
    return !!(this.settings && this.settings.cameraMode === 'dynamic');
  }

  // Mouse movement rotation without holding LMB (when cameraMouseRotate setting is enabled)
  consumeCamMouseRotate(){
    const a = this._camMouseRotateAccum || 0;
    this._camMouseRotateAccum = 0;
    return a;
  }

  /* Vertical drag delta (screen px) — used by the spectator freecam pitch */
  consumeCamSwipePitch(){
    const a = this._camSwipeAccumY || 0;
    this._camSwipeAccumY = 0;
    return a;
  }

  setJoysticksVisible(visible){
    if(!visible) this.resetTouch();
    const moveEl = document.getElementById('joystick-move');
    const turretEl = document.getElementById('joystick-turret');
    if(moveEl) moveEl.classList.toggle('joystick-hidden', !visible);
    if(turretEl) turretEl.classList.toggle('joystick-hidden', !visible);
    // Camera rotate buttons follow the camera mode (mobile or desktop)
    const camBtns = document.getElementById('cam-rotate-btns');
    if(camBtns){
      const arrowsMode = (this.settings && this.settings.camMode || 'arrows') === 'arrows';
      camBtns.classList.toggle('joystick-hidden', !(visible && arrowsMode));
    }
  }

  /* Clear all touch-driven state (joysticks, cam buttons, pinch, keys) so
     nothing "sticks" after leaving a battle. Safe to call anytime. */
  resetTouch(){
    if(this._moveJoystick) this._moveJoystick.reset();
    if(this._turretJoystick) this._turretJoystick.reset();
    if(this._pointerLocked) document.exitPointerLock();
    this._camRotateTouch = 0;
    this._camSwipeAccum = 0;
    this._pinchTouchIds = [];
    this._pinchDist = 0;
    this._pinchAccum = 0;
    this._touchInput = { throttle: 0, turn: 0, turretAngle: 0, fire: false };
  }

  resetAll(){
    this.keys = {};
    this.mouse.down = false;
    this.wheel = 0;
    this.resetTouch();
  }

  consumeWheel(){
    const w = this.wheel; this.wheel = 0; return w;
  }

  static captureBind(){
    return new Promise(resolve=>{
      const kd = (e)=>{ cleanup(); resolve(e.code); };
      const md = (e)=>{ if(e.button===0){ cleanup(); resolve('LMB'); } else if(e.button===1){ cleanup(); resolve('MMB'); } else if(e.button===2){ e.preventDefault(); cleanup(); resolve('RMB'); } };
      const wh = (e)=>{ cleanup(); resolve(e.deltaY < 0 ? 'WheelUp' : 'WheelDown'); };
      function cleanup(){
        window.removeEventListener('keydown', kd);
        window.removeEventListener('mousedown', md);
        window.removeEventListener('wheel', wh);
      }
      window.addEventListener('keydown', kd);
      window.addEventListener('mousedown', md);
      window.addEventListener('wheel', wh, {passive:true});
    });
  }

  pressed(action){
    const k = this.binds[action];
    if(k==='LMB') return this.mouse.down;
    if(k==='RMB') return this.mouse.rightDown;
    if(k==='MMB') return this.mouse.midDown;
    if(k==='WheelUp' || k==='WheelDown') return false;
    return !!this.keys[k];
  }

  /* Edge-triggered press (true for one frame when the bind goes down) */
  consumePressed(action){
    const down = this.pressed(action);
    const was = this._edgePrev && this._edgePrev[action];
    if(!this._edgePrev) this._edgePrev = {};
    this._edgePrev[action] = down;
    return down && !was;
  }

  /* Record one-finger tap on free space (used for super targeting on touch) */
  _recordTap(e){
    const t = e.changedTouches && e.changedTouches[0];
    if(!t) return;
    const c = document.querySelector('#game-root canvas');
    let ndcX = 0, ndcY = 0;
    if(c){
      const r = c.getBoundingClientRect();
      ndcX = ((t.clientX - r.left) / r.width) * 2 - 1;
      ndcY = -((t.clientY - r.top) / r.height) * 2 + 1;
    }
    this._tap = { x: t.clientX, y: t.clientY, ndcX, ndcY, time: performance.now() };
  }
  consumeTap(){
    if(this._tap && (performance.now() - this._tap.time) < 600){
      const tap = this._tap;
      this._tap = null;
      return tap;
    }
    this._tap = null;
    return null;
  }

  consumeZoom(){
    let z = this.consumeWheel();
    if(this.keys[this.binds.zoomIn] ) z += 1;
    if(this.keys[this.binds.zoomOut]) z -= 1;
    if(this._pinchAccum){
      z += this._pinchAccum;
      this._pinchAccum = 0;
    }
    return z;
  }

  /* Get touch input for the current frame */
  getTouchInput(){
    if(!this._moveJoystick && !this._turretJoystick){
      return null;
    }

    const move = this._moveJoystick ? this._moveJoystick.getValue() : {x:0, y:0, firing:false};
    const turret = this._turretJoystick ? this._turretJoystick.getValue() : {x:0, y:0, firing:false};

    // Movement: joystick up (negative y) = forward (like W), joystick down (positive y) = backward (like S)
    // joystick left (negative x) = turn hull left (like A), joystick right (positive x) = turn hull right (like D)
    const throttle = -move.y;
    const turn = -move.x;

    // Turret:
    // - turret.relAngle follows drag direction relative to joystick up
    // - armed means joystick knob is near max ring
    // - fire while armed = tank shoots continuously when at max distance
    const turretRelAngle = turret.relAngle || 0;
    const armed = !!turret.armed;

    return {
      throttle,
      turn,
      turretRelAngle,
      armed,
      isTouch: this.isTouchDevice,
    };
  }
}