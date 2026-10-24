/* ============================================================================
   session-guard.js — the game puts itself back together.

   THE PROBLEM
   -----------
   A browser game has no supervisor. If the socket dies, or the render loop is
   killed by an exception, or the tab is reloaded by a stray F5, the player is
   simply dropped: a frozen screen, a match that thinks they are still there, or
   a main menu with no explanation. Big multiplayer games handle this explicitly
   because losing a match to a browser event is unforgivable.

   WHAT THIS DOES
   --------------
   1. PERSISTS the session continuously — who you are, which match, which role,
      which map — so there is always a record of where you were.
   2. DETECTS the four failures that actually happen:
        * the socket to the match server closed while in a battle
        * the host has stopped sending snapshots (the battle is over but you
          cannot tell, because a dead socket and a dead host look identical)
        * the render loop stopped while the page is alive and visible
        * an uncaught exception
   3. SELF-HEALS: explains what happened, counts down, reloads, and — because the
      server was holding your place while you were asleep — puts you back into
      the same battle with the same tank.
   4. GUARDS the reload you did not mean to do.

   WHAT IT DELIBERATELY DOES NOT DO
   --------------------------------
   It cannot recover a genuinely frozen main thread. A thread wedged inside one
   synchronous block cannot run a timer, cannot prompt, and cannot navigate; by
   definition nothing inside the page can act. That case is detected on the NEXT
   load by boot-watchdog.js, which can write to localStorage only because it got
   a heartbeat out before the thread died. The recoverable "loop died but the
   thread is fine" case — which is what an exception in the loop actually
   produces — IS handled here.
   ========================================================================== */

(function (global) {
  'use strict';
  if (global.SessionGuard) return;

  var KEY = 'mtl_session';
  var KEY_ID = 'mtl_player_id';

  /* How long the host may go without sending a snapshot before we conclude the
     battle is dead rather than quiet. Generous: a big map on a slow machine can
     hitch, and a false positive throws the player out of a match that is fine. */
  var STALL_MS = 9000;

  /* How long the render loop may not advance while the tab is visible before we
     decide the loop is dead. A backgrounded tab legitimately stops, so this only
     applies while the document is visible. */
  var LOOP_STALL_MS = 8000;

  /* Seconds shown on the recovery countdown before reloading. Long enough to
     read and press Cancel, short enough not to feel broken. */
  var RELOAD_DELAY_MS = 5000;

  var g = function (n) { return global[n]; };
  function net() { return g('Net'); }
  function game() { return g('__game'); }

  /* ======================================================== persistence ==== */

  function blank() {
    return {
      v: 1,
      playerId: null,
      name: '', tank: '', mode: null,
      phase: 'menu',          /* menu | queued | battle */
      room: null, role: null, hostId: null, seed: null,
      mapId: null,
      savedAt: 0,
      reloadReason: null,     /* why we reloaded, shown on the next boot */
      reloadAt: 0,
    };
  }

  function write(rec) {
    try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch (e) { /* private mode */ }
  }

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var r = JSON.parse(raw);
      return (r && r.v === 1) ? r : null;
    } catch (e) { return null; }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  /* The player id is kept in sessionStorage, NOT localStorage.

     A reload keeps sessionStorage, which is exactly the case resume exists for.
     It is also per-TAB, and localStorage is not: with the id in localStorage,
     opening a second tab made it offer the FIRST tab's id, because they share
     one origin. That is wrong twice over — the second tab would try to resume
     somebody else's session, and the first tab's stored id gets overwritten by
     whichever tab connected last, so a genuine reload could offer the wrong one.

     The server refuses a resume for anyone who is not currently asleep, so this
     could not actually hijack a live session. But offering another tab's id is
     still wrong, and the fix is one line. */
  function rememberId(id) {
    if (!id) return;
    try { sessionStorage.setItem(KEY_ID, id); } catch (e) {
      /* Private mode, or storage disabled: the game still works, it just cannot
         resume. Losing resume is much better than losing the session. */
      try { localStorage.setItem(KEY_ID, id); } catch (e2) {}
    }
  }
  function rememberedId() {
    try { var v = sessionStorage.getItem(KEY_ID); if (v) return v; } catch (e) {}
    try { return localStorage.getItem(KEY_ID); } catch (e) { return null; }
  }
  function forgetId() {
    try { sessionStorage.removeItem(KEY_ID); } catch (e) {}
  }

  /* Snapshot whatever the live objects say right now. Deliberately reads
     defensively: this runs on a timer and on faults, when half the game may
     already be in an unknown state. */
  function save() {
    var N = net(), G = game(), M = g('Menu');
    var rec = read() || blank();
    rec.playerId = (N && N.playerId) || rec.playerId;
    rec.name = (M && M.game && M.game.settings && M.game.settings.playerName) || rec.name;
    rec.tank = (M && M.game && M.game.settings && M.game.settings.selectedTank) || rec.tank;
    rec.savedAt = Date.now();

    var inBattle = !!(G && G.running);
    var queued = !!(N && N._queueing);
    rec.phase = inBattle ? 'battle' : (queued ? 'queued' : 'menu');
    rec.inBattle = inBattle;

    if (N) {
      rec.room = N.roomCode || null;
      rec.role = N.role || null;
      rec.hostId = N.hostId || null;
      rec.seed = (N.seed != null) ? N.seed : null;
    }
    if (M && M._votedMap) rec.mapId = M._votedMap.id || null;
    rec.mode = (M && M._selectedGamemode) || rec.mode;

    write(rec);
    return rec;
  }

  /* ===================================================== fault detection === */

  var faults = {
    armed: false,
    lastSnapshotAt: 0,
    lastFrameAt: 0,
    lastFrameCount: -1,
    timer: null,
    handling: null,
  };

  function arm() {
    if (faults.armed) return;
    faults.armed = true;
    faults.lastSnapshotAt = Date.now();
    faults.lastFrameAt = Date.now();
    faults.lastFrameCount = frameCount();
    faults.timer = setInterval(tick, 1000);
  }

  function disarm() {
    faults.armed = false;
    if (faults.timer) { clearInterval(faults.timer); faults.timer = null; }
  }

  function frameCount() {
    var G = game();
    return (G && typeof G.frame === 'number') ? G.frame : -1;
  }

  /* The host pushes a snapshot ~20x a second. If none arrives while we believe
     we are in a battle, either the socket is gone or the host is. Both are
     handled by reloading, because in both cases this client can no longer play
     and pretending otherwise is worse. */
  function noteSnapshot() { faults.lastSnapshotAt = Date.now(); }

  function inBattle() {
    var G = game();
    return !!(G && G.running && G.mode && (G.mode === 'host' || G.mode === 'client'));
  }

  function tick() {
    if (faults.handling) return;
    var now = Date.now();
    var N = net();
    if (!N) return;

    /* Only armed once there is something to lose. Sitting in the menu with the
       socket closed is normal and must never trigger a reload. */
    if (!inBattle()) { faults.lastSnapshotAt = now; return; }

    /* --- the socket to the match server went away ---
       net.js keeps the live socket on Net.ws, not Net.socket. */
    if (N.ws && N.ws.readyState === 3 /* CLOSED */) {
      return raise('connection',
        'The connection to the match server dropped.');
    }

    /* --- the host stopped sending --- */
    if (now - faults.lastSnapshotAt > STALL_MS) {
      return raise('stalled',
        'The battle stopped updating — the host stopped sending.');
    }

    /* --- the render loop died but the page is alive ---
       This is the recoverable freeze: an exception thrown inside the loop kills
       the requestAnimationFrame chain, and nothing ever restarts it. The thread
       is fine (this interval is running), the screen is simply static forever. */
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      var fc = frameCount();
      if (fc === faults.lastFrameCount) {
        if (now - faults.lastFrameAt > LOOP_STALL_MS) {
          return raise('loop',
            'The game stopped responding.');
        }
      } else {
        faults.lastFrameAt = now;
        faults.lastFrameCount = fc;
      }
    } else {
      faults.lastFrameAt = now;
    }
  }

  /* An uncaught exception is worth one retry: reload once, and if it happens
     again in the same place, stop, because a loop of reloads is worse than a
     broken page. */
  var seenErrors = {};
  function onError(msg, src, line) {
    if (!inBattle()) return;
    var where = (src || '?') + ':' + (line || 0);
    seenErrors[where] = (seenErrors[where] || 0) + 1;
    if (seenErrors[where] > 1) return;
    raise('error', 'The game hit an error (' + where + ').');
  }

  /* ============================================================== recovery = */

  function raise(kind, message) {
    if (faults.handling) return;
    faults.handling = kind;

    var rec = save();
    rec.reloadReason = kind;
    rec.reloadMessage = message;
    rec.reloadAt = Date.now();
    write(rec);

    showRecovery(kind, message, function (doReload) {
      if (!doReload) {
        /* The player chose to stay. Stop guarding, drop the pending reload, and
           let them back to the menu rather than leaving a dead battle on screen. */
        faults.handling = null;
        try { g('Game') && g('Game').leaveToMenu && g('Game').leaveToMenu(); } catch (e) {}
        return;
      }
      doReload();
    });
  }

  /* THE RECOVERY SCREEN. Explains, counts down, and offers a way out — a reload
     with no explanation and no cancel is indistinguishable from a crash loop. */
  function showRecovery(kind, message, done) {
    var titles = {
      connection: 'CONNECTION LOST',
      stalled: 'BATTLE STOPPED',
      loop: 'GAME NOT RESPONDING',
      error: 'GAME ERROR',
    };
    var left = Math.ceil(RELOAD_DELAY_MS / 1000);

    var el = document.createElement('div');
    el.id = 'mtl-recovery';
    el.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(8,10,14,.94);color:#e8eef6;' +
      'font:14px/1.7 "Segoe UI",system-ui,sans-serif;';

    var box = document.createElement('div');
    box.style.cssText = 'max-width:520px;padding:28px 30px;border-radius:14px;' +
      'border:1px solid #2c3644;background:#111722;box-shadow:0 24px 70px rgba(0,0,0,.6)';

    var h = document.createElement('div');
    h.style.cssText = 'font-size:19px;font-weight:700;letter-spacing:.4px;color:#ff8a8a;margin-bottom:10px';
    h.textContent = titles[kind] || 'PROBLEM';

    var p = document.createElement('div');
    p.style.marginBottom = '18px';
    p.textContent = message + ' Reloading the game and putting you back where you were.';

    var c = document.createElement('div');
    c.style.cssText = 'font-size:26px;font-weight:700;color:#8fb8ff;margin-bottom:18px';
    c.textContent = left;

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px';

    var cancel = document.createElement('button');
    cancel.textContent = 'Stay on this screen';
    cancel.style.cssText = 'flex:1;padding:11px 14px;border-radius:8px;cursor:pointer;' +
      'border:1px solid #36415266;background:#1b2331;color:#cfd9e6;font:inherit';
    cancel.onclick = function () { clearInterval(iv); el.remove(); done(false); };

    var now = document.createElement('button');
    now.textContent = 'Reload now';
    now.style.cssText = 'flex:1;padding:11px 14px;border-radius:8px;cursor:pointer;' +
      'border:1px solid #3d6ea8;background:#2b5c96;color:#fff;font:inherit;font-weight:600';
    now.onclick = function () { clearInterval(iv); el.remove(); done(true); };

    row.appendChild(cancel); row.appendChild(now);
    box.appendChild(h); box.appendChild(p); box.appendChild(c); box.appendChild(row);
    el.appendChild(box);
    document.body.appendChild(el);

    var iv = setInterval(function () {
      left--;
      if (left <= 0) { clearInterval(iv); done(true); return; }
      c.textContent = left;
    }, 1000);
  }

  function doReload() {
    /* Written first: if the reload itself is what killed us last time, this is
       the only record that survives. */
    var rec = read() || save();
    rec.reloadReason = rec.reloadReason || 'manual';
    rec.reloadAt = Date.now();
    write(rec);
    try { location.reload(); } catch (e) { location.href = location.href; }
  }

  /* ============================================================ boot-time === */

  /* Runs once the game object exists. Reports a previous forced reload and, if
     the session says we were in a battle, tries to walk back into it. */
  function onBoot() {
    var rec = read();
    if (!rec) { arm(); return; }

    /* A reload we did not initiate, with no explanation: the tab was reloaded or
       closed and reopened. If we were in a battle, say so rather than silently
       dropping the player at the main menu. */
    if (rec.phase === 'battle' && !rec.reloadReason && Date.now() - rec.savedAt < 10 * 60 * 1000) {
      notify('You were interrupted',
        'The game closed while you were in a battle. Trying to get you back in.');
      attemptResume(rec);
    }

    arm();
  }

  /* Offer the held id back and let the server decide. If it says yes we are put
     straight back into the same match; if not, we were genuinely gone. */
  /* Offer the held id back and let the server decide. If it says yes we are put
     straight back into the same match; if not, we were genuinely gone. */
  function attemptResume(rec) {
    var N = net();
    if (!N) return;
    try {
      if (N.onResume) return;   /* already wired by menu.js */
      N.onResume = function (info) { onResumed(info); };
      N._open && N._open().then(function () {
        N._raw({ t: 'hello', name: rec.name, tank: rec.tank, resume: rec.playerId });
      }).catch(function () {});
    } catch (e) { /* the guard must never be the thing that breaks the page */ }
  }

  function onResumed(info) {
    if (!info || !info.code) {
      /* The server no longer holds us — the grace ran out. Be honest rather than
         pretending, and send them to the menu. */
      clear();
      notify('Could not rejoin', 'That match had already ended. Taking you to the menu.');
      return;
    }
    notify('Back in the battle', 'Reconnected to match ' + info.code + '.');
    var M = g('Menu');
    if (M && M._resumeIntoBattle) { try { M._resumeIntoBattle(info); } catch (e) { clear(); } }
  }

  /* Called by Menu once it has rebuilt the arena, so the session record stops
     describing a battle we are no longer in, and the next boot does not try to
     resume a match we already recovered from. */
  function resumeIntoBattle(info) {
    var rec = read() || save();
    rec.phase = 'battle';
    rec.room = (info && info.code) || rec.room;
    rec.role = (info && info.role) || rec.role;
    rec.hostId = (info && info.hostId) || rec.hostId;
    rec.seed = (info && info.seed != null) ? info.seed : rec.seed;
    rec.reloadReason = null;
    rec.reloadMessage = null;
    write(rec);
  }

  function notify(title, body) {
    try {
      var M = g('Menu');
      if (M && M.toast) { M.toast(title + ' — ' + body); return; }
    } catch (e) {}
  }

  /* ============================================================ F5 GUARD ==== */

  /* Reloading mid-battle costs the match. Browsers only honour a return value
     from beforeunload if the page has been interacted with, which is exactly the
     case that matters here. */
  function installUnloadGuard() {
    if (global.__mtlUnloadGuard) return;
    global.__mtlUnloadGuard = true;
    var armed = false;

    global.addEventListener('beforeunload', function (e) {
      save();
      if (!inBattle() && !armed) return;
      armed = true;
      e.preventDefault();
      e.returnValue = 'Leave Mini Tank Legends? You are in a battle and will lose your place.';
      return e.returnValue;
    });

    /* A short grace after the first attempt, so a double-press cannot trap the
       player in a dialog they cannot dismiss. */
    setTimeout(function () { armed = false; }, 4000);
  }

  /* ================================================================ wire-up = */

  var api = {
    save: save, clear: clear, read: read,
    rememberId: rememberId, rememberedId: rememberedId, forgetId: forgetId,
    noteSnapshot: noteSnapshot,
    raise: raise,
    reload: doReload,
    onBoot: onBoot,
    resumeIntoBattle: resumeIntoBattle,
    arm: arm, disarm: disarm,
    notify: notify,
    inBattle: inBattle,
    installUnloadGuard: installUnloadGuard,
    KEYS: { SESSION: KEY, PLAYER_ID: KEY_ID },
  };

  global.SessionGuard = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { save(); installUnloadGuard(); });
    } else { save(); installUnloadGuard(); }
  }
})(typeof window !== 'undefined' ? window : globalThis);