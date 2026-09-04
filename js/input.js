/* ============================================================
   input.js — keyboard + mouse + wheel + TOUCH (mobile dual joystick),
   with rebindable keybinds.
   ============================================================ */

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
    });
    window.addEventListener('keyup',   e=>{ this.keys[e.code]=false; });

    const canvas = ()=> document.querySelector('#game-root canvas');
    document.addEventListener('mousemove', e=>{
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      const c = canvas();
      if(c){
        const r = c.getBoundingClientRect();
        this.mouse.ndcX =  ((e.clientX-r.left)/r.width )*2-1;
        this.mouse.ndcY = -((e.clientY-r.top )/r.height)*2+1;
      }
    });
    document.addEventListener('mousedown', e=>{ if(e.button===0) this.mouse.down=true; });
    document.addEventListener('mouseup',   e=>{ if(e.button===0) this.mouse.down=false; });

    window.addEventListener('wheel', e=>{
      this.wheel += (e.deltaY < 0 ? 1 : -1);
    }, {passive:true});

    window.addEventListener('blur', ()=>{ this.keys={}; this.mouse.down=false; this._camRotateTouch=0; });

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
      // Track mouse movement for camera rotation without LMB (when enabled in settings)
      if(this.settings && this.settings.cameraMouseRotate && !this._camSwipeMouseDown){
        if(this._camSwipeMouseLastX !== 0 || this._camSwipeMouseLastY !== 0){
          this._camMouseRotateAccum += e.clientX - this._camSwipeMouseLastX;
        }
        this._camSwipeMouseLastX = e.clientX;
        this._camSwipeMouseLastY = e.clientY;
      }
      // Standard swipe (requires LMB)
      if(!this._camSwipeMouseDown) return;
      this._camSwipeAccum += e.clientX - this._camSwipeMouseLastX;
      this._camSwipeAccumY += e.clientY - this._camSwipeMouseLastY;
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
    const touch = this._camRotateTouch || 0;
    return val || touch;
  }

  consumeCamSwipe(){
    const a = this._camSwipeAccum || 0;
    this._camSwipeAccum = 0;
    return a;
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
      const md = (e)=>{ if(e.button!==0) return; cleanup(); resolve('LMB'); };
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