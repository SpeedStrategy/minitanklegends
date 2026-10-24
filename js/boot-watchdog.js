/* ============================================================================
   FREEZE DETECTOR

   The problem
   -----------
   The game intermittently locks up when opening menus. "Locks up" means the
   MAIN THREAD stops. The page still paints, but the browser will not show even
   a right-click context menu, because that context menu is served by the main
   thread too. So the thread is stuck inside one synchronous block of code.

   Why the usual advice does not work here
   --------------------------------------
   The normal way to debug this is "add a console.log". That is impossible in
   this case: a wedged main thread cannot log, cannot show a dialog, cannot
   answer a question. It cannot report anything, precisely because it is the
   thing that is stuck.

   The trick used here
   -------------------
   A heartbeat written to localStorage. Once a second the page records "I am
   still alive, and right now I am doing X". If the page is frozen, the heartbeat
   stops. On the NEXT load we look at how old the last heartbeat is:

     * recent heartbeat, and it says "clean exit"  -> the tab was closed normally
     * heartbeat is minutes old and says no exit   -> the tab was FROZEN, and it
                                                     names the last thing it was
                                                     doing when it died

   Every tab writes its OWN slot rather than one shared one -- see KEY_PREFIX
   below. A shared slot means a live tab overwrites the record of a dead one
   within a second, so the mid-battle freeze that prompted this was never
   reported at all: the next load read a fresh heartbeat written by a different
   tab and correctly concluded nothing had happened.

   A clean exit is stamped on pagehide/unload. A freeze never gets to stamp one,
   which is what distinguishes "froze" from "I closed the tab yesterday".

   Why not a Web Worker
   --------------------
   A worker can survive a wedged main thread, so it is the textbook answer, but a
   worker created from a Blob URL has an opaque origin and cannot reach
   localStorage -- so it has nowhere to record what it saw. This was built that
   way first and silently never reported anything. The heartbeat needs no
   cross-thread channel at all, so it does not have that problem.

   Cost: two localStorage writes per second, a few bytes each. Nothing per frame.
   ============================================================================ */
(function () {
  'use strict';
  if (window.__mtlFreezeGuard) return;
  window.__mtlFreezeGuard = true;

  /* ==========================================================================
     ONE HEARTBEAT PER TAB, NOT ONE PER BROWSER.

     This used to be a single shared key, and that quietly made the whole
     mechanism useless the moment more than one tab was open: every tab wrote
     the same slot once a second, so a tab that had wedged in the middle of a
     battle was overwritten within a second by whichever other tab was still
     alive. The next load then read a perfectly fresh heartbeat from a DIFFERENT
     tab, concluded nothing was wrong, and said nothing -- which is exactly how
     a reported mid-battle freeze produced no report at all.

     Each tab now owns `mtl_beat_<id>`. The id lives in sessionStorage, so it
     survives a reload of the same tab (the normal way out of a freeze) but is
     not shared with other tabs. Live tabs can no longer erase each other's
     evidence, and reportPrevious() reads every slot rather than only its own,
     so an incident in one tab is still found from another. */
  var KEY_PREFIX = 'mtl_beat_';
  var KEY_LEGACY = 'mtl_beat';            /* the old shared slot, still read once */
  var TAB_ID = (function () {
    try {
      var own = sessionStorage.getItem('mtl_tab');
      if (own) return own;
      own = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('mtl_tab', own);
      return own;
    } catch (e) {
      /* sessionStorage blocked (some privacy modes): a per-load id still stops
         tabs from clobbering each other; only reload continuity is lost. */
      return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  })();
  var KEY_BEAT = KEY_PREFIX + TAB_ID;
  var BEAT_MS = 1000;
  /* A heartbeat older than this, with no clean exit recorded, means the tab was
     frozen rather than closed. Generous, because a laptop lid closed or a heavy
     battle can legitimately stall the tab for a few seconds. */
  var FROZEN_AFTER_SECONDS = 12;

  /* ==========================================================================
     AND A CEILING, WHICH MATTERS MORE THAN THE FLOOR.

     A hung main thread is stuck INSIDE ONE FUNCTION. Nothing else runs, so the
     heartbeat stops within about a second, and the tab is still there, still
     painted, waiting for you to reload it. That is measured in SECONDS. Minutes
     at the outside.

     A heartbeat that is HOURS old was never a hang at all. The page was simply
     not running: the machine slept, the browser was killed or crashed, the
     battery died, or the tab was discarded. None of those execute JavaScript,
     and none of them fire pagehide, which is the only thing that stamps a clean
     exit. Every one of them therefore looks exactly like a freeze in this
     scheme, because "the last thing it wrote" and "the last thing it would have
     written" are the same field.

     The report that prompted this was "THE GAME FROZE ... Last heartbeat was
     47666 seconds ago" — thirteen hours. Nothing is frozen for thirteen hours.
     That was a laptop closed overnight, and the panel blamed
     `menu:main:preview` purely because that is where the game happened to be
     when the lid came down. It sent the reader hunting a bug in the main menu
     that does not exist.

     Past this ceiling we say what actually happened rather than inventing a
     culprit. */
  var IMPLAUSIBLE_AFTER_SECONDS = 600;   /* ten minutes */

  var label = 'boot';
  var wentHidden = false;      /* this tab was backgrounded before it stopped */

  /* Record what we are about to do. Called before every menu open and every
     battle start so that a freeze is always attributable to a named place. */
  function mark(text) {
    if (text) label = String(text);
  }
  window.__mtlMark = mark;

  function beat() {
    /* A BACKGROUNDED TAB IS NOT A LIVE TAB.

       Chrome throttles timers in a hidden tab — to once a second at first, then
       to once a minute, and to once a minute indefinitely once the tab has been
       hidden a while. Firefox does the same. So a heartbeat that has quietly
       slowed down tells us nothing about whether the main thread is wedged, and
       keeping it running only produces noise: the one thing this whole mechanism
       cannot do is measure liveness in a tab it is not allowed to observe.

       So it records "went to the background" once, stops claiming to be alive,
       and the next load is told the plain truth. */
    if (document.hidden) {
      if (!wentHidden) {
        wentHidden = true;
        try { localStorage.setItem(KEY_BEAT, Date.now() + '|went-hidden'); } catch (e) {}
      }
      return;
    }
    wentHidden = false;
    try {
      localStorage.setItem(KEY_BEAT, Date.now() + '|' + label);
    } catch (e) { /* private mode / quota: detection simply stays off */ }
  }

  /* A normal close gets a clean-exit stamp, so only an actual freeze is
     reported. Crucially it is only written when the heartbeat is FRESH.

     Writing it unconditionally destroys the evidence: after a freeze the tab is
     closed or reloaded, pagehide fires, and the stale "I was doing X" heartbeat
     gets overwritten with "clean exit" -- so the next load reports nothing and
     the freeze looks like it never happened. A stale heartbeat is the proof, so
     it is left alone. */
  function stampCleanExit() {
    try {
      var raw = localStorage.getItem(KEY_BEAT);
      if (raw) {
        var bar = raw.indexOf('|');
        var when = parseInt(raw.slice(0, bar), 10);
        var ageSec = (Date.now() - when) / 1000;
        /* Already stale -> do not erase the evidence, whatever the reason was. */
        if (!when || !isFinite(when) || ageSec >= FROZEN_AFTER_SECONDS) return;
      }
      localStorage.setItem(KEY_BEAT, Date.now() + '|clean-exit');
    } catch (e) {}
  }

  /* ---- Explain a previous freeze, if there was one ----

     Every slot is read, not just this tab's: a frozen tab is usually closed
     before anything reads it, and the tab that does the reading is whatever
     the player opens next. At most ONE panel is shown per load, chosen by:

       1. plausible over implausible  (a real freeze beats "the laptop slept")
       2. this tab's own slot         (the incident you are most likely after)
       3. newest first                (the freshest incident is the live one)

     Everything else is either left for a later load (a plausible incident that
     lost the tie-break) or cleaned up outright (an hours-old slot that has
     nothing left to teach and would otherwise sit in localStorage forever). */
  function reportPrevious() {
    var entries = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || (k.indexOf(KEY_PREFIX) !== 0 && k !== KEY_LEGACY)) continue;
        var raw = localStorage.getItem(k);
        if (!raw) continue;
        var bar = raw.indexOf('|');
        if (bar < 0) continue;
        var when = parseInt(raw.slice(0, bar), 10);
        if (!when || !isFinite(when)) continue;
        entries.push({
          key: k, own: (k === KEY_BEAT), when: when,
          what: raw.slice(bar + 1), ageSec: Math.round((Date.now() - when) / 1000)
        });
      }
    } catch (e) { return; }
    if (!entries.length) return;

    /* Nothing is wrong: sweep the slots of tabs that have since gone away, so
       the list does not fill up with keys nobody will ever read again. A live
       tab's slot is never touched -- it is being rewritten every second and is
       not stale, and a tab that merely went to the background is left alone
       because it may come back and beat again. */
    var reportable = entries.filter(function (e) {
      if (e.what === 'clean-exit') return false;          // closed properly
      if (e.what === 'went-hidden') return false;         // backgrounded
      return e.ageSec >= FROZEN_AFTER_SECONDS;
    });

    if (!reportable.length) {
      try {
        entries.forEach(function (e) {
          if (e.own || e.what === 'went-hidden') return;
          if (e.what === 'clean-exit' || e.ageSec >= IMPLAUSIBLE_AFTER_SECONDS) {
            localStorage.removeItem(e.key);
          }
        });
      } catch (e) {}
      return;
    }

    reportable.sort(function (a, b) {
      var ap = a.ageSec < IMPLAUSIBLE_AFTER_SECONDS;
      var bp = b.ageSec < IMPLAUSIBLE_AFTER_SECONDS;
      if (ap !== bp) return ap ? -1 : 1;
      if (a.own !== b.own) return a.own ? -1 : 1;
      return b.when - a.when;
    });

    var pick = reportable[0];
    show(pick.what, pick.ageSec, pick.key);

    /* One panel per load. A plausible incident that did not win the tie-break
       is left in place for a later load; an implausible one is noise and goes. */
    try {
      reportable.slice(1).forEach(function (e) {
        if (e.own || e.ageSec < IMPLAUSIBLE_AFTER_SECONDS) return;
        localStorage.removeItem(e.key);
      });
    } catch (e) {}
  }

  function show(what, ageSec, key) {
    var plausible = ageSec < IMPLAUSIBLE_AFTER_SECONDS;
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:300000;' +
      'background:' + (plausible ? '#2a1216' : '#12222a') + ';' +
      'border:2px solid ' + (plausible ? '#ff6b6b' : '#5fa8c8') + ';border-radius:10px;color:' +
      (plausible ? '#ffd7d7' : '#d7ecf5') + ';' +
      'font:13px/1.6 Consolas,Monaco,monospace;padding:12px 14px;max-height:40vh;overflow:auto;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.6)';

    var hours = (ageSec / 3600);
    var ago = hours >= 1 ? (Math.round(hours * 10) / 10) + ' hours'
           : (Math.round(ageSec / 60)) + ' minutes';

    if (plausible) {
      el.textContent =
        'PREVIOUS SESSION: THE GAME FROZE\n\n' +
        'It stopped responding while doing:\n\n    ' + what + '\n\n' +
        'Last heartbeat was ' + ago + ' ago.\n\n' +
        'That label is the exact place to look. Screenshot this panel and send it.';
    } else {
      /* Not a freeze, and saying "froze" here is what sent the previous report
         hunting a bug that does not exist. */
      el.textContent =
        'PREVIOUS SESSION ENDED UNEXPECTEDLY\n\n' +
        'The game was last running:\n\n    ' + what + '\n\n' +
        'That was ' + ago + ' ago, which is far too long for a freeze — a stuck\n' +
        'main thread gives up within seconds, and this one is still recoverable\n' +
        'by reloading. What actually happened is that the page stopped running\n' +
        'entirely: the computer slept, the browser was closed or killed, or the\n' +
        'tab was discarded to save memory.\n\n' +
        'Nothing here is broken and no screenshot is needed. This note will not\n' +
        'appear again unless it happens again while the game is in front of you.';
    }
    var add = function () { try { document.body.appendChild(el); } catch (e) {} };
    if (document.body) add();
    else document.addEventListener('DOMContentLoaded', add);

    /* Only the invented one gets consumed.

       A real freeze leaves its evidence in place on purpose, so that reloading
       the tab keeps showing it until the report is read. But an hours-old
       heartbeat has nothing left to teach: this note was the whole finding, and
       leaving the record stale would put the same blue panel back up on every
       single load for as long as nobody clears it by hand.

       Stamping a clean exit here costs nothing, because the condition that
       produced it — the page not running for hours — re-arms itself the next
       time it actually happens: while the game runs, beat() is writing again, so
       a fresh abrupt end is caught exactly as before. It just stops nagging
       about the one that was already explained, which is what the panel
       promises. */
    if (!plausible) {
      /* This tab's own slot keeps a tombstone, so the next load of the SAME
         tab still knows it was explained. Someone else's slot is just removed:
         there is no reload coming that would look at it, and a foreign key
         that lingers would be re-read on every load of every other tab. */
      try {
        if (!key || key === KEY_BEAT) localStorage.setItem(KEY_BEAT, Date.now() + '|clean-exit');
        else localStorage.removeItem(key);
      } catch (e) {}
    }
  }

  function boot() {
    reportPrevious();
    beat();
    setInterval(beat, BEAT_MS);
  }

  /* A normal close gets a clean-exit stamp, so only an actual freeze is reported. */
  window.addEventListener('pagehide', stampCleanExit);
  window.addEventListener('beforeunload', stampCleanExit);

  /* Page Lifecycle. `freeze` is what the OS calls when it suspends a tab, and
     `document.wasDiscarded` is set when the tab was thrown away to save memory.
     Both are the honest explanation for a heartbeat that is hours old, and both
     are stamped so the next load does not have to guess. */
  try {
    document.addEventListener('freeze', function () {
      wentHidden = true;
      try { localStorage.setItem(KEY_BEAT, Date.now() + '|went-hidden'); } catch (e) {}
    });
  } catch (e) {}
  if (document.wasDiscarded) {
    try { localStorage.setItem(KEY_BEAT, Date.now() + '|went-hidden'); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();