/* ============================================================================
   net-cursors.js — shows the OTHER players' mouse cursors as live markers.

   WHY
   ---
   During the map vote everyone is looking at a flat DOM overlay, not the 3D
   world, and each player is in their own browser window. So a player who is
   hovering "Kaukaz" gives the other player no signal at all: the vote screen
   looks identical whether one person is reading it or three are fighting over
   it. A shared cursor makes the vote feel like a room with people in it.

   It is deliberately simple and deliberately non-blocking:

     * positions arrive over the same WebSocket as everything else, throttled by
       Net.sendCursor to about 20 a second;
     * this file only draws. It never intercepts the pointer, never calls
       preventDefault, and never listens on the overlay in a way that could
       swallow a click -- a marker that ate the vote it was meant to illustrate
       would be worse than no marker at all;
     * `pointer-events:none` on every element, so the real cursor is the only
       thing you can interact with.

   Coordinates are normalised (0..1 of the viewport) rather than sent as raw
   pixels, so the marker lands in the right place on a phone in portrait and a
   desktop at 2560x1440 alike.
   ========================================================================== */

(function () {
  'use strict';

  const COLORS = ['#ff6a00', '#00e676', '#4488ff', '#ff44aa', '#ffd23f', '#b06aff'];
  const LABEL_H = 22;

  let _layer = null;      /* the fixed container */
  const _marks = new Map();  /* peerId -> element */

  function _ensureLayer() {
    if (_layer && document.body.contains(_layer)) return _layer;
    _layer = document.createElement('div');
    _layer.id = 'net-cursors';
    _layer.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:30000',
      'pointer-events:none', 'overflow:hidden'
    ].join(';');
    document.body.appendChild(_layer);
    return _layer;
  }

  function _colorFor(peerId) {
    let h = 0;
    for (let i = 0; i < peerId.length; i++) h = (h * 31 + peerId.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  function _makeMark(peerId, name) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute', 'left:0', 'top:0',
      'pointer-events:none',
      'will-change:transform,opacity',
      'transition:opacity .25s ease'
    ].join(';');

    const arrow = document.createElement('div');
    arrow.style.cssText = [
      'width:0', 'height:0',
      'border-left:7px solid transparent',
      'border-right:7px solid transparent',
      'border-top:12px solid ' + _colorFor(peerId),
      'filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))',
      'transform:rotate(-20deg)',
      'transform-origin:50% 90%'
    ].join(';');

    const tag = document.createElement('div');
    tag.textContent = name || 'Player';
    tag.style.cssText = [
      'margin:2px 0 0 10px', 'display:inline-block',
      'background:' + _colorFor(peerId),
      'color:#0b0e14', 'font:600 11px/1.5 Inter,Segoe UI,Arial,sans-serif',
      'padding:1px 7px', 'border-radius:9px',
      'white-space:nowrap',
      'box-shadow:0 2px 6px rgba(0,0,0,.45)'
    ].join(';');

    el.appendChild(arrow);
    el.appendChild(tag);
    return el;
  }

  /* Named after the roster entry when we have one, so the cursor is a person and
     not an anonymous blob. */
  function _nameFor(peerId) {
    try {
      const game = window.game || window._game;
      const roster = (game && game._armedRoster) || [];
      for (let i = 0; i < roster.length; i++) {
        if (roster[i] && roster[i].peerId === peerId && roster[i].name) return roster[i].name;
      }
    } catch (e) { /* roster not ready; fall through */ }
    return 'Player';
  }

  function render(cursors) {
    if (!cursors) return;
    const layer = _ensureLayer();
    const me = (typeof Net !== 'undefined' && Net.myPeerId) || null;
    const now = Date.now();

    Object.keys(cursors).forEach(peerId => {
      if (peerId === me) return;                 /* never draw your own */
      const c = cursors[peerId];
      if (!c) return;

      let el = _marks.get(peerId);
      if (!el) {
        el = _makeMark(peerId, _nameFor(peerId));
        layer.appendChild(el);
        _marks.set(peerId, el);
      }

      /* A cursor that stopped moving is stale -- the player closed the tab or
         the tab froze -- so fade it out rather than leaving a ghost pinned to
         the last known spot. */
      const age = now - (c.at || now);
      const visible = age < 4000;
      el.style.opacity = visible ? '1' : '0';

      const x = (c.x || 0) * window.innerWidth;
      const y = (c.y || 0) * window.innerHeight;
      el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y - LABEL_H) + 'px)';
    });

    /* Drop markers for players who are no longer in the match at all. */
    _marks.forEach((el, peerId) => {
      if (!(peerId in cursors)) {
        el.remove();
        _marks.delete(peerId);
      }
    });
  }

  function clear() {
    _marks.forEach(el => el.remove());
    _marks.clear();
    if (_layer) { _layer.remove(); _layer = null; }
  }

  /* ---- mouse tracking -------------------------------------------------
     Registered when a match forms, torn down when it ends. Reports normalised
     viewport coordinates. Touch is included so the marker works on a phone,
     where there is no hover and a vote tap is the only interaction. */
  function attach() {
    _detach();
    const onMove = (e) => {
      try {
        if (typeof Net === 'undefined' || !Net.sendCursor) return;
        Net.sendCursor(
          e.clientX / Math.max(1, window.innerWidth),
          e.clientY / Math.max(1, window.innerHeight)
        );
      } catch (err) { /* never let a cursor report break the vote */ }
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    _teardown = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onMove);
    };
    if (typeof Net !== 'undefined' && Net.onCursors) Net.onCursors(render);
  }

  let _teardown = null;
  function _detach() {
    if (_teardown) { _teardown(); _teardown = null; }
  }

  function detach() {
    _detach();
    if (typeof Net !== 'undefined' && Net.onCursors) Net.onCursors(null);
    clear();
  }

  window.NetCursors = { attach, detach, render, clear };
})();
