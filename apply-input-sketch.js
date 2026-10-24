const fs = require('fs');
const C = process.argv[2] || 'node';

const path = 'js/game.js';
const base = fs.readFileSync(path, 'utf8');

let code = base;

// ------------------------------------------------------------------
// 1. input.js: wire the TouchJoystick turret axis so a tap actually moves the turret
// ------------------------------------------------------------------
let mod;

// 1a. preventDefault every pointermove so touch panners never hijack the page scroll
mod = code;
code = mod.replace(
  /\n(\s*)this\._state\.move\.addEventListener\('pointermove',\s*moveHandler\s*\)/,
  '\n$1this._state.move.addEventListener(\'pointermove\', moveHandler) $2$1this._state.move.addEventListener(\'pointermove\', (e)=>e.preventDefault()) // Buffy: prevent page scroll while dragging the joystick',
  '1'
);
if (code === mod) { console.warn('input.js touch-joystick: pointermove preventDefault anchor NOT found (1a)'); }
else { console.log('input.js: patched pointermove preventDefault'); }

// 1b. onPointerDown: read x/y from the actual event, not a stale member (fixes no-move bug)
mod = code;
const downOld = '      this._state.down = true;\n      this._state.setFromSource(source, this._state.lastCx, this._state.lastCy);';
const downNew = '      this._state.down = true;\n      const _px = +(source && source.x); const _py = +(source && source.y);\n      const cx = (_px >= 0 && _px <= 1) ? _px : (this._state.lastCx ?? 0);\n      const cy = (_py >= 0 && _py <= 1) ? _py : (this._state.lastCy ?? 0);\n      this._state.setFromSource(source, cx, cy);';
code = mod.split(downOld).join(downNew);
if (code === mod) { console.warn('input.js touch-joystick: setFromSource anchor NOT found (1b)'); }
else { console.log('input.js: patched onPointerDown to read event coords (1b)'); }

// 1c. TouchJoystick.read delta reads TOUCH state if active, else pointer state
if (!code.includes('MULTIPOINTER_X = MultiPointer.getX(input);')) {
  code = code.replace(
    /\/\* MULTI-TOUCH: only one joystick left+right, duplicates forwarded to secondary tank in the match.\*\/[\s\S]*?return exits;\n\s*\}/,
    `/* MULTI-TOUCH: only one joystick left+right, duplicates forwarded to secondary tank in the match. */
  TOUCH_A = MultiPointer.getX(input);   // replay all touches as one axis when needed
  POINTER_X = PointerVector.get(input); // fallback if joystick is in pointer mode

  const getPrimary = () => (MultiPointer.hasActiveTouches(input) ? TOUCH_A : POINTER_X);

  const TouchJoystick = (function (){
    const MOUSELESS_SLOP = -0.06,
          DEADSNCR_HALF  = 0.07,
          DEADSNCR_SQ    = DEADSNCR_HALF * DEADSNCR_HALF,
          F_SMOOTH_BUILD = 0.28,
          DRAW_RADIUS    = 42;

    return function TouchJoystick(rootEl, side, opts){
      opts = opts || {};
      const S = {
        rootEl,
        side,
        cx: opts.cx ?? 0.5,
        cy: opts.cy ?? 0.5,
        jx: 0, jy: 0,             // displayed knob position within the pad (for drawing)
        drag: 0,                  // how far the knob is pulled from center (0..1)
        active: false,
        axis: opts.axis || 'horizontal',  // 'horizontal' | 'vertical' | 'free'
        autoFireCap: opts.autoFireCap >= 0 ? (opts.autoFireCap || 1) : 1,
        autoFire: opts.autoFire > 0,
        _pendingShove: 0,
        _rebuild: false,
        grab: null,
        moved: false,
      };

      function mapAxisToDxDy(dx, dy, axis){
        // For horizontal mode: left/right -> dx, ignore dy.  Vertical mode: opposite.
        if(axis === 'horizontal')  return [dx, 0];
        if(axis === 'vertical')    return [0, dy];
        return [dx, dy];
      }

      function clamp(v){ return Math.min(1, Math.max(-1, v)); }

      function updateKnob(){
        const r = Math.hypot(S.jx, S.jy);
        if(r >= 1){
          S.jx /= r; S.jy /= r;
        }
        S.drag = r;
      }

      function setFromTouch(touch, activeEl){
        const rect = activeEl.getBoundingClientRect();
        const rawX = (touch.clientX - rect.left) / rect.width;
        const rawY = (touch.clientY - rect.top) / rect.height;
        S.cx = clamp(rawX);
        S.cy = clamp(rawY);
      }

      function build(){
        const el = S.rootEl;
        const cx = el.clientWidth * S.cx;
        const cy = el.clientHeight * S.cy;
        el.style.transform = 'translate(' + (cx - el.clientWidth/2) + 'px,' + (cy - el.clientHeight/2) + 'px)';
        el.style.display = '';
        updateKnob();
      }

      function draw(){
        if(!S.active) { S.rootEl.style.display = 'none'; return; }
        const el = S.rootEl;
        const r = DRAW_RADIUS * S.drag;
        el.style.borderRadius = '50%';
        el.style.width  = (r * 2) + 'px';
        el.style.height = (r * 2) + 'px';
        el.style.background = 'rgba(220,220,220,0.45)';
        el.style.border = '1px solid rgba(255,255,255,0.8)';
        el.style.boxShadow = '0 0 8px rgba(0,0,0,0.4)';
        el.style.transform= 'translate(' + (el.clientWidth/2 * (S.jx||0)) + 'px,' +
                             (el.clientHeight/2 * (S.jy||0)) + 'px)';
      }

      function startPointer(e){
        if(S.active) return;
        S.active = true;
        S._rebuild = false;
        const t = e.changedTouches ? e.changedTouches[0] : e;
        setFromTouch(t, e.currentTarget || S.rootEl);
        S.grab = t.identifier;
        elSetStyle(S.rootEl, 'display', '');
        updateKnob();
        draw();
        S.moved = false;
      }

      function movePointer(e){
        if(!S.active) return;
        const t = e.changedTouches ? Array.prototype.find.call(e.changedTouches, (x) => x.identifier === S.grab) : e;
        if(!t) return;
        setFromTouch(t, e.currentTarget || S.rootEl);
        S.moved = true;
        draw();
      }

      function endPointer(e){
        if(!S.active) return;
        const removed = e.changedTouches || [e];
        if(Array.isArray(removed)){
          for(let i=0;i<removed.length;i++){
            if(removed[i].identifier === S.grab){
              S.active = false;
              S.grab = null;
              elSetStyle(S.rootEl, 'display', 'none');
              S.jx = 0; S.jy = 0; S.drag = 0;
              S.moved = false;
              break;
            }
          }
        } else {
          S.active = false;
          S.grab = null;
          elSetStyle(S.rootEl, 'display', 'none');
          S.jx = 0; S.jy = 0; S.drag = 0;
          S.moved = false;
        }
      }

      function elSetStyle(el, prop, val){
        el.style[prop] = val;
      }

      // public
      S.isActive = function(){ return S.active; };
      S.getAxisValue = function(){
        // returns -1..1, signed magnitude of the knob along the chosen axis
        const v = S.axis === 'vertical' ? S.jy : S.jx;
        return clamp(v);
      };
      S.getDrag = function(){ return S.drag; };
      S.getDeltaForSend = function(){
        // convenience: value to send as joystick axis each frame (clamped drift)
        return getPrimary() * S.drag;
      };
      S.draw = draw;
      S.build = build;
      S.start = startPointer;
      S.move = movePointer;
      S.end = endPointer;
      S.destroy = function(){ S.active = false; elSetStyle(S.rootEl, 'display', 'none'); };

      return S;
    };
  })();

  /*

    Integration sketch (in consumer):

      const touchJoy = TouchJoystick(joystickEl, 'left', {axis:'horizontal'});
      joyStickRoot.addEventListener('pointerdown', touchJoy.start.bind(touchJoy));
      joyStickRoot.addEventListener('pointermove', touchJoy.move.bind(touchJoy));
      joyStickRoot.addEventListener('pointerup',   touchJoy.end.bind(touchJoy));
      joyStickRoot.addEventListener('pointercancel',touchJoy.end.bind(touchJoy));

      // In your update loop:
      const joystickValue = touchJoy.getAxisValue(); // -1..1
      // Use this value as input to tank movement, turret angle, etc.

  */

  try { PointerVector._name; } catch(e){ window.PointerVector = PointerVector; }
  window.MultiPointer = MultiPointer;
  window.MultiPointer.getX = MultiPointer.getX;
  window.MultiPointer.hasActiveTouches = MultiPointer.hasActiveTouches;
  MULTIPOINTER_X = MultiPointer.getX(input);
  POINTER_X = PointerVector.get(input);
  const getPrimary = () => (MultiPointer.hasActiveTouches(input) ? MULTIPOINTER_X : POINTER_X);
  var TouchJoystick = TouchJoystick;` + `\n` +
    `  const TOUCHSHOT_LISTENER = (function (){
    const sig = '__touchshot-v1__';
    const map = new Map();
    function _addPhone(armed, dt){ // dt ignored for now
      // stub — signal sent to opponent in match
    }
    function _ack(armed){
      // stub
    }
    return {
      listen(el){
        el.addEventListener('pointerdown', (e)=>{
          if(e.target && (e.target.dataset.touchshot === sig)){
            // treat as axes event — whatever the matched peer expects
            _addPhone(e.detail && e.detail.armed, 0);
          }
        });
      },
      signal(armed){ window.dispatchEvent(new CustomEvent(sig, {detail:{armed}})); }
    };
  })();

  try { TouchJoystick._name; } catch(e){ window.TouchJoystick = TouchJoystick; }
  window.TOUCSHOT_LISTENER = TOUCHSHOT_LISTENER;
  window.TouchJoystick = TouchJoystick;

  const _MOUSELESS_SLOP = -0.06,
        _DEADSNCR_HALF  = 0.07,
        _DEADSNCR_SQ    = _DEADSNCR_HALF * _DEADSNCR_HALF,
        _F_SMOOTH_BUILD = 0.28,
        _DRAW_RADIUS    = 42;

  /* ============================================================ INPUT CONSUMERS
   *
   *   This file is a compatibility layer.  Everything below exists so
   *   existing app code keeps working after this refactor; do not use
   *   these in new code.
   *
   *   The canonical input path is now:
   *
   *       import { getMultiPointerX, getPointerX } from './input.js';
   *
   *       const primaryX = getMultiPointerX(input);               // -1..1, (float)
   *       const primaryTouchY = MultiPointer.getY(input);         // 0..1   (touch fallback)
   *
   *   Legacy aliases preserved for existing app code:
   *
   *       input.consumeThirdAxis()  ->  MultiPointer.getX(input)  (same)
   *       input.consumeSecondAxis() ->  PointerVector.get(input)  (same)
   *       input.consumeTurretAxis() ->  (MultiPointer hasTouches ? MultiPointer.getX(input) : PointerVector.get(input))
   *                                                    (new: touch-aware turret)
   *
   *   `input` here is whatever the app passes into these helpers; the
   *   file exports no default `input`.  The app owns the input object
   *   singleton.
   *
   * ============================================================ INPUT CONSUMERS */

  function consumeTurretAxisLegacy(){
    return getPrimary() * (input.smooth || 0);
  }

  function consumeThirdAxisLegacy(){
    return getPrimary();
  }

  function consumeSecondAxisLegacy(){
    return PointerVector.get(input);
  }

  function consumeJoystickAxisLegacy(){
    // backwards-compatible: returns the current touch joystick grip value (-1..1)
    return TouchJoystick ? TouchJoystick.getAxisValue() : 0;
  }

  fileExports.consumeTurretAxis   = consumeTurretAxisLegacy;
  fileExports.consumeThirdAxis    = consumeThirdAxisLegacy;
  fileExports.consumeSecondAxis   = consumeSecondAxisLegacy;
  fileExports.consumeJoystickAxis = consumeJoystickAxisLegacy;

  /* ============================================================ INPUT CONSUMERS END */

  return {
    getTouchJoystick               : () => TouchJoystick,
    isTouchJoystickActive          : () => !!TouchJoystick && TouchJoystick.isActive?.(),
    getMultiPointerX               : () => MultiPointer.getX(input),
    getTouchAxis                   : () => MultiPointer.getX(input),
    getPointerAxis                 : () => PointerVector.get(input),
    primaryAxis                    : () => getPrimary(),
    addPhone                       : _addPhone,
    ackPhone                       : _ack,
    TOUCSHOT_LISTENER             : TOUCHSHOT_LISTENER,
    recordEventsForDebug          : fileExports.recordEventsForDebug || (() => {}),
  };
}`,
    '0'
  );
  if (code === mod) { console.warn('input.js touch-joystick: MultiPointer block NOT found'); }
  else { console.log('input.js: patched TouchJoystick read to consume MultiPointer when active'); }
}

if (!code.includes('TOUCSHOT_LISTENER')) {
  // 1d. deploy TOUCSHOT_LISTENER around where pointers are consumed
  if (!code.includes('TOUCSHOT_LISTENER.listen(document.addEventListener)')) {
    code = code.replace(
      /\/\* MULTI-TOUCH: only one joystick left\+right, duplicates forwarded to secondary tank in the match\.\*\/[\s\S]*?return exits;\n\s*\}/,
      `/* MULTI-TOUCH: only one joystick left+right, duplicates forwarded to secondary tank in the match. */
  TOUCSHOT_LISTENER.listen(document.addEventListener);
  return exits;
}`);
    if (code === mod) { console.warn('input.js: TOUCSHOT_LISTENER anchor NOT found'); }
    else { console.log('input.js: deployed TOUCSHOT_LISTENER listener'); }
  }
}

fs.writeFileSync(path, code, 'utf8');
console.log('input.js written:', path);
console.log('apply-input-sketch JS updated');
