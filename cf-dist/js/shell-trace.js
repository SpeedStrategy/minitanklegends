/* ============================================================
   shell-trace.js — DISABLED (ribbon mesh never renders)
   Wavy trace is now handled inline in game.js using
   the proven BulletTrailManager multi-segment technique.
   ============================================================ */

class ShellTraceManager {
  constructor(scene, opts){
    this.scene = scene;
    this._active = [];
    this._pool = [];
  }
  beginTrace(){ return null; }
  addPoint(){}
  endTrace(){}
  update(){}
  dispose(){}
}
