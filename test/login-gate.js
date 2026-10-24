/* ============================================================================
   login-gate.js â€” the wall in front of the game.

   WHAT THIS IS
   ------------
   Nothing is playable until the player has an account the server recognises.
   Not by pressing Escape, not by reloading, not by closing the tab and coming
   back, not by waiting. The only thing that lowers the gate is a valid session.

   HOW THE LOCK IS ACTUALLY ENFORCED
   ---------------------------------
   A class on <html>, added by an inline script in index.html before the
   stylesheet loads, hiding the menu, the canvas, the UI layer and the loading
   screen together. This file's only job is to remove that class when, and only
   when, the server says who the player is.

   The obvious weakness is that it is all client-side: anyone with a developer
   console can delete the class. That is not an oversight to be patched here â€”
   it is a property of shipping a game in a browser, and the fix for it is not
   code but the reason this gate exists, which is that an account is how
   progress is identified. A player who bypasses the gate gets a local profile
   that does not follow them to another device and does not appear in their
   clan. We would rather have the sign-up than not have them.

   WHY THE GAME LOADS BEHIND THE GATE
   -----------------------------------
   It could be made to wait. The gate is up before anything else is requested,
   so blocking boot would be easy â€” but 187 MB of models is a long time to stare
   at a login form with nothing happening. The game loads normally underneath,
   so by the time someone has typed a username and a password the menu is
   genuinely ready. The gate covers it rather than delaying it.

   ORDERING, WHICH IS THE WHOLE PROBLEM
   ------------------------------------
   Three things have to happen, in this order, and none of them may wait on
   another:

     1. THE LOADING SCREEN. The game's own, with the game's own progress bar,
        showing while 187 MB of assets arrive.
     2. THE GATE. Only once boot has actually finished.
     3. THE MENU. Only once the player has chosen.

   The gate used to cover the loading screen, which meant a login form sat on
   screen while the game was still loading behind it and the two looked like a
   mistake. It now waits. `lg-ready` is added to <html> when game.js clears its
   own `booting` class, which is the only moment that actually means "the game
   is loaded" â€” nothing here can fake it, and nothing here has to guess at it.
   ========================================================================== */

'use strict';

(function () {
  const Gate = {};

  /* Bumped when the screen changes shape, so a cached stylesheet or script
     cannot leave the new markup unstyled or unwired. */
  const VERSION = 1;

  /* Set on the very first line, before anything else can fail, because
     auth.js uses it to decide whether it owns the session check or should
     stand aside. It has to be true before this file does any work â€” if a
     syntax error below killed the script, the flag would never be set and
     auth.js would correctly take over on its watchdog instead. */
  window.__gatePresent = true;

  /* BUILD STAMP, shown at the bottom of the gate.

     Twice now a bug report turned out to be a browser running an older build,
     and both times the only way to find that out was to ask which code was
     live â€” after guessing wrong several times first. This puts the answer on
     screen.

     BUMP IT on every deploy that changes the gate. It is deliberately a
     hand-edited constant rather than something derived from a timestamp: it has
     to mean "the build I intended" and not "whenever this file happened to be
     written". */
  const GATE_BUILD = '20261014j';

  let el = null;
  let checking = false;
  /* Set when the player is mid-request. The buttons disable so a double click
     cannot fire two registrations, which is exactly the race the server's
     unique index then has to clean up. */
  let busy = false;
  /* True once boot has finished and the gate is allowed to be seen. */
  let ready = false;

  function $(id) { return document.getElementById(id); }

  function panelEl(name) { return $('login-gate-panel-' + name); }

  /* ---------------------------------------------------------------- panels */

  Gate.showPanel = function (name) {
    ['choose', 'login', 'register', 'reset', 'verified'].forEach(function (p) {
      const el2 = panelEl(p);
      if (el2) el2.classList.toggle('active', p === name);
    });
  };

  function setChecking(on) {
    checking = on;
    const box = $('gate-checking');
    if (box) box.classList.toggle('active', !!on);
    /* Every panel off while checking, so the gate cannot show the chooser for
       the fraction of a second before a valid session is found. */
    ['choose', 'login', 'register', 'reset', 'verified'].forEach(function (p) {
      const el2 = panelEl(p);
      if (el2 && on) el2.classList.remove('active');
    });
  }

     /* ---------------------------------------------------------------- the chooser

     THREE OPTIONS, AND THE TEXT UNDER EACH.

     Kept as one table rather than three sets of markup so the three
     explanations cannot drift apart from the three cards â€” the guest text
     saying "nothing is saved" next to a button styled as saving is exactly the
     kind of contradiction that makes players stop trusting a game's UI.

     The guest copy is the careful one. It is honest that progress does not
     save, and equally careful NOT to make guest play sound like a trial or a
     punishment: a guest can join clans, play battles, chat and use the shop
     for this session. The only thing missing is persistence. */

  const CHOICES = {
    guest: {
      body: 'Play right away. Battles, clans, the shop, chat â€” everything works. ' +
            'Your progress will <strong>not be saved</strong>; it stays on this ' +
            'device and is gone when you close the tab.',
      note: 'You can make an account at any time, and your guest progress moves across with it.',
    },
    login: {
      body: 'Enter the username or email and password for your account. Your coins, ' +
            'tanks, unlocks and clans will be exactly as you left them, on every ' +
            'device you sign in on.',
      note: 'Forgotten your password? There is a reset link on the next screen.',
    },
    signup: {
      body: 'A username, an email and a password. Your progress is saved to your ' +
            'account from then on, so it follows you to any device and survives ' +
            'clearing your browser.',
      note: 'You can change your mind and play as a guest instead â€” this is not a one-way door.',
    },
  };

  let choice = null;

  /* The note under the cards. It picks up gold once something is chosen, so the
     card and the sentence read as one decision rather than two pieces of UI. */
  function renderChoice() {
    const note = $('choose-note');
    const body = $('choose-note-body');
    const ok = $('choose-ok');
    if (!note || !body) return;

    if (!choice) {
      note.className = 'choose-note';
      body.textContent = 'Pick one to continue. You can change your mind later.';
      if (ok) ok.disabled = true;
      return;
    }

    const c = CHOICES[choice];
    note.className = 'choose-note is-picked';
    /* innerHTML because the copy carries one <strong> for the warning and the
       reassurance is a separately styled block. */
    body.innerHTML = c.body + '<span class="choose-note-change">' + c.note + '</span>';
    if (ok) ok.disabled = false;
  }

  Gate.selectChoice = function (which) {
    if (!CHOICES[which]) return;
    choice = which;
    ['guest', 'login', 'signup'].forEach(function (k) {
      const card = $('choose-' + k);
      if (card) card.classList.toggle('selected', k === which);
    });
    renderChoice();
  };

  function confirmChoice() {
    if (!choice || busy) return;

    /* The burst comes from the button, not the centre of the screen, so it
       reads as the click having an effect rather than as confetti. */
    const ok = $('choose-ok');
    if (ok) {
      const r = ok.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2);
    }

    if (choice === 'guest') { setTimeout(function () { enterAsGuest(); }, 260); return; }
    if (choice === 'login') {
      Gate.showPanel('login');
      focusFirst('gate-login-user');
      return;
    }
    if (choice === 'signup') {
      Gate.showPanel('register');
      focusFirst('gate-reg-user');
    }
  }

  function focusFirst(id) {
    setTimeout(function () { const n = $(id); if (n && n.focus) n.focus(); }, 80);
  }

  /* ------------------------------------------------------------------ guest

     What a guest is: a player with no account, whose progress lives in this
     browser and nowhere else.

     What a guest is NOT: a second-class player. Nothing below disables clans,
     chat, the shop or matchmaking. The whole difference is that saveSettings()
     finds no session token and so never uploads anything â€” which is already
     true of the existing code (config.js calls Auth.onSettingsSaved, and that
     returns immediately when there is no token). So a guest needs no separate
     code path through the game at all, which is why this is a short function
     rather than a mode flag threaded through everything.

     The one flag worth recording is 'chosen', so the chooser is not shown again
     on the next visit. That is a UI preference, not progress. */

  function enterAsGuest() {
    try {
      localStorage.setItem('mtl_guest', '1');
      /* A deliberate, once-only decision that they are a guest. Kept separate
         from mtl_local_reset_v so wiping old progress does not also force the
         chooser back on screen. */
      localStorage.setItem('mtl_choice_made', 'guest');
    } catch (e) { /* private mode: the chooser simply returns next visit */ }

    /* GUEST MEANS GUEST, INCLUDING THE NAME.

       This function used to write two localStorage keys and unlock. The chooser
       is only reachable without a live session, so in the normal case there is
       nothing to clear and this is a no-op.

       The case that is not normal is the one that produced the bug: the player
       pressed Log Out, and that left their account's name sitting in
       tankparty_settings (see Auth.leaveAccount, which now clears it) — and any
       path that gets here with a session still stored would do the same. Calling
       Auth.leaveAccount() here makes "play as a guest" mean it unconditionally,
       rather than depending on the player having found the Log Out button first.

       Idempotent and side-effect free when there is no account: leaveAccount
       only replaces a name that is generated or that matches the account it is
       leaving. */
    try {
      if (window.Auth && typeof window.Auth.leaveAccount === 'function') window.Auth.leaveAccount();
    } catch (e) { /* signing out of the session is the part that matters */ }

    Gate.unlock();
  }

  /* Has this player already decided how they want to play? */
  function hasDecided() {
    try { return !!localStorage.getItem('mtl_choice_made'); } catch (e) { return false; }
  }

  /* ------------------------------------------------------ the escape hatch

     THE CHOOSER IS A ONE-TIME SCREEN, AND THAT WAS A MISTAKE.

     It appears once, the player picks, and then it is skipped on every
     subsequent visit. That is fine as long as the way BACK is obvious, and it
     was not: the only route was a small "Log In" label in the corner of the
     main menu. A player who chose Guest could therefore end up staring at a
     game with no visible account system at all, and no way to tell whether they
     had been logged out, had never been asked, or had simply lost the screen.

     So there are now two ways back, and neither requires finding a corner
     label:

       * ?login=1  on any URL forces the chooser to appear, whatever is stored
       * the main menu's account button, which now says Sign In / Sign Up while
         signed out instead of just "Log In"

     The parameter is also the thing to reach for when debugging somebody else's
     browser, which is exactly the situation it caused twice. */
  function forcedByUrl() {
    try {
      const p = new URLSearchParams(location.search);
      return p.get('login') === '1' || p.get('login') === 'true';
    } catch (e) { return false; }
  }

  function clearChoice() {
    try {
      localStorage.removeItem('mtl_choice_made');
      localStorage.removeItem('mtl_guest');
    } catch (e) { /* private mode */ }
  }

  /* ============================================================================
   WAITING FOR BOOT

   The gate must not appear until the loading screen has done its job. game.js
   removes the `booting` class from <html> at the one moment that means "the
   game is loaded and the menu is real" (clearBooting(), near the end of its
   bootstrap). That is the signal we want, so we watch for exactly that.

   A MutationObserver rather than a poll: it costs nothing while idle, fires the
   instant the class changes, and cannot drift into a loop by measuring time.

   A timeout sits underneath it purely as a backstop. If the game's own bootstrap
   dies before clearing the flag â€” a failed asset, a thrown script â€” the gate
   still has to appear, because a player who cannot log in is worse than one who
   did not have to. The timeout is generous on purpose: it is a failure path,
   not the normal one.
   ============================================================================ */
const BOOT_FALLBACK_MS = 45000;

function waitForBoot(onReady) {
  const html = document.documentElement;

  /* Boot is already over by the time we looked — a cached build that finished
     before this script parsed, or a page that was never booting. `lg-ready` is
     what makes the gate visible at all, so leaving it unset here was a way to
     stay locked forever with no gate on screen and no way to log in. Same two
     lines as the normal path, in the only order that is correct. */
  if (!html.classList.contains('booting')) {
    ready = true;
    html.classList.add('lg-ready');
    setGateOpen(true);
    onReady();
    return;
  }

  let done = false;
  const finish = function (why) {
    if (done) return;
    done = true;
    if (mo) mo.disconnect();
    clearTimeout(timer);
    ready = true;
    html.classList.add('lg-ready');
    /* The gate is visible from this line on, so this — and not Gate.start() — is
       where the custom cursor is allowed to take over. One call higher up would
       have put a crosshair over the game's own loading screen for the whole of
       boot, with no native pointer behind it. */
    setGateOpen(true);
    if (why === 'timeout') {
      console.warn('[gate] boot never reported ready â€” showing the gate anyway');
    }
    onReady();
  };

  /* The test hook. Assigned first and independently of the observer, because a
   context with no MutationObserver at all (a stub DOM, an old browser, some
   embedded webviews) would otherwise throw before the try block was even
   reached. */
  html.onClassChange = function () {
    if (!html.classList.contains('booting')) finish('boot');
  };

  let mo = null;
  try {
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(html.onClassChange);
      mo.observe(html, { attributes: true, attributeFilter: ['class'] });
    }
  } catch (e) {
    /* observe() refused. The hook and the timeout still cover us. */
    mo = null;
  }

  const timer = setTimeout(function () { finish('timeout'); }, BOOT_FALLBACK_MS);
}

/* ============================================================================
   CUSTOM CURSOR

   Four white bars in a crosshair with the centre cut out â€” the shape of a
   sight, which is what the rest of this game is about. It trails the pointer
   slightly; the lag is what gives it mass and stops it reading as a div glued
   to a mouse.

   Hidden entirely on touch, where a crosshair cannot be pointed. See the
   pointer:coarse rule in the stylesheet.
   ============================================================================ */
const cursor = { el: null, x: 0, y: 0, active: false };

/* IS THE GATE ON SCREEN RIGHT NOW?

   This is the whole fix for "I log in and my cursor disappears", and it exists
   because the custom cursor and the gate are two different lifetimes.

   `cursor.active` only ever meant "the custom cursor has taken over from the
   native one". unlock() cleared it, because that is what you do when you want
   the pointer handed back. But the mousemove listener is on `document`, so it
   kept running for the rest of the session — and the very first movement
   anywhere in the game fell into the `if (!cursor.active)` branch, which does
   two things: it puts the `on` class back on the crosshair and it re-adds
   `lg-cursor-active` to <html>. That class is `cursor:none !important` on the
   whole document.

   The crosshair element lives inside #login-gate, which unlock() has just
   hidden. So what the player got was the native cursor switched off and
   nothing switched on in its place: no pointer at all, over the menu, the
   garage, the shop, everything, for as long as they played.

   So the takeover is now conditional on the gate actually being visible. While
   it is closed, mousemove does nothing but move two numbers nobody reads. */
let gateOpen = false;

/* Where the cursor is allowed to exist. True from the moment the gate becomes
   visible to the moment it closes, and false at both ends of that — including
   during boot, when the gate is in the document but still hidden behind the
   loading screen and a crosshair over the loading bar would be its own bug. */
function setGateOpen(open) {
  const on = !!open;
  if (on === gateOpen) return;
  gateOpen = on;
  const html = document.documentElement;
  if (!on) {
    html.classList.remove('lg-cursor-active');
    if (cursor.el) {
      cursor.el.classList.remove('on');
      /* Also clear the pressed/hot decoration. It is the crosshair's own state
         and it has no business surviving a close; leaving `hot` set means the
         next time the gate opens the sticks are gold before the pointer has
         moved onto anything. */
      cursor.el.classList.remove('hot');
      cursor.el.classList.remove('down');
    }
    cursor.active = false;
  }
}

function initCursor() {
  cursor.el = $('lg-cursor');
  if (!cursor.el) return;
  if (window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches) return;

  /* THE NATIVE CURSOR STAYS UNTIL THE CUSTOM ONE IS PROVEN TO WORK.

     `lg-cursor-active` is what sets `cursor: none` on <html> and everything
     inside it. It is not added on load, while the custom cursor element is
     still opacity:0 and only becomes visible on the first mousemove.

     Two ways to end up with NO POINTER AT ALL exist, and this function only
     ever guarded against one of them:

       * from page load until the mouse moved, and
       * for good — after unlock() cleared `cursor.active`, any movement in the
         game re-armed the takeover while the crosshair it belongs to was hidden.

     The gateOpen check above closes the second one. This is the first.

     A missing cursor is far worse than an ugly one, so the native pointer is
     the default and the custom one only takes over once a mousemove has proved
     it can actually render — while the gate is there to render it into. */
  document.addEventListener('mousemove', function (e) {
    if (!gateOpen) return;
    if (!cursor.active) {
      /* First move: place it directly rather than sliding in from the corner,
         and only NOW take the native cursor away. */
      cursor.x = e.clientX;
      cursor.y = e.clientY;
      cursor.el.style.transform = 'translate3d(' + cursor.x + 'px,' + cursor.y + 'px,0)';
      cursor.active = true;
      cursor.el.classList.add('on');
      document.documentElement.classList.add('lg-cursor-active');
    }
    cursor.x = e.clientX;
    cursor.y = e.clientY;
    cursor.el.style.transform = 'translate3d(' + cursor.x + 'px,' + cursor.y + 'px,0)';
  }, { passive: true });

  /* "hot" over anything clickable, so the bars push outward and turn gold
     where there is something to click. event.target is walked up because the
     thing under the pointer is usually a <span> or an <svg> inside the button,
     neither of which is itself a button. */
  document.addEventListener('mouseover', function (e) {
    if (!gateOpen) return;
    let n = e.target;
    while (n && n !== document.body) {
      const tag = n.tagName;
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') {
        cursor.el.classList.add('hot');
        return;
      }
      n = n.parentNode;
    }
    cursor.el.classList.remove('hot');
  }, { passive: true });

  document.addEventListener('mousedown', function () { if (gateOpen) cursor.el.classList.add('down'); }, { passive: true });
  document.addEventListener('mouseup', function () { if (gateOpen) cursor.el.classList.remove('down'); }, { passive: true });

  /* The pointer can leave the window without a mouseout firing.

     This only parks the crosshair; it deliberately does not give the native
     cursor back. Handing it back on a mouseleave and taking it away again on the
     next mousemove is a flicker every time the pointer touches the edge of the
     screen, and the crosshair is still perfectly able to follow the pointer
     back in. */
  document.addEventListener('mouseleave', function () {
    if (!gateOpen) return;
    cursor.el.classList.remove('on');
    cursor.active = false;
  });
}

/* ============================================================================
   THE BURST

   Shards thrown from the OK button when a choice is confirmed. Cheap: they are
   plain divs, animated by the compositor, and every one removes itself when its
   animation ends â€” nothing is left in the DOM and nothing has to be cleaned up
   on the next visit.
   ============================================================================ */
function burst(x, y, colors) {
  const box = $('lg-burst');
  if (!box) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const palette = colors || ['#ffb12b', '#ff6b00', '#ffd08a', '#ffffff', '#5fd68f'];
  for (let i = 0; i < 26; i++) {
    const s = document.createElement('i');
    s.className = 'lg-shard';
    /* A ring rather than a square of random directions, so it reads as a
       shockwave instead of an explosion. */
    const angle = (i / 26) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 90 + Math.random() * 190;
    s.style.left = x + 'px';
    s.style.top = y + 'px';
    s.style.background = palette[i % palette.length];
    s.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
    s.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
    if (Math.random() > 0.5) s.style.borderRadius = '50%';
    box.appendChild(s);
    s.addEventListener('animationend', function () { if (s.parentNode) s.parentNode.removeChild(s); });
  }
}

/* ============================================================================
   PASSWORD STRENGTH

   Four buckets and one sentence each. Not a checklist.

   What it measures, in order of how much it actually matters:
     * length      â€” the single biggest factor, and the one people forget
     * variety     â€” more than one character class, not all of them
     * repetition  â€” "aaaaaa", "123456" and friends are the first things tried
     * sequences   â€” "abcdef", "qwerty"

   Deliberately NOT a score out of 100 with a fake percentage. A number invites
   people to argue with the number instead of choosing a better password, and a
   meter that says 87/100 for "password1" would be actively lying.
   ============================================================================ */
const STRENGTH = [
  { verdict: 'Use 8 or more characters', hint: '' },
  { verdict: 'Weak â€” too short or too simple', hint: '' },
  { verdict: 'Fair â€” could be stronger', hint: '' },
  { verdict: 'Good password', hint: '' },
  { verdict: 'Strong password', hint: '' },
];

function scorePassword(pw) {
  if (!pw) return 0;

  /* Anything that cannot be a password at all â€” the server rejects it below
     eight characters, so scoring it as anything but "weak" would be telling
     the player a lie about something that will not be accepted. */
  if (pw.length < 8) return 1;

  let score = 2;

  /* Length, with diminishing returns after 12 so a long passphrase is not
     punished for being long. */
  if (pw.length >= 8) score += 0;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;

  const classes =
    (/[a-z]/.test(pw) ? 1 : 0) +
    (/[A-Z]/.test(pw) ? 1 : 0) +
    (/[0-9]/.test(pw) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(pw) ? 1 : 0);
  if (classes >= 3) score += 1;
  if (classes >= 4) score += 1;

  /* Runs of the same character, and keyboard walks.

     A long run is penalised harder than a short one on purpose. "aaa" inside an
     otherwise decent password is a typo; a password that is twenty a's has one
     bit of entropy no matter what its length, and length points are supposed
     to mean added difficulty. Without the split, "aaaaaaaaaaaaaaaaaaaa" scored
     better than "Tr0ub4dor&3", which is exactly backwards. */
  if (/(.)\1{4,}/.test(pw)) score -= 2;
  else if (/(.)\1{2,}/.test(pw)) score -= 1;

  if (/(?:abcd|bcde|cdef|defg|1234|2345|3456|4567|5678|6789|qwer|wert|asdf|zxcv)/i.test(pw)) score -= 1;

  /* A password that is only digits is a phone number, not a secret. */
  if (/^\d+$/.test(pw)) score -= 2;

  return Math.max(1, Math.min(4, score));
}

function updateStrength() {
  const meter = $('pw-meter');
  const input = $('gate-reg-pass');
  if (!meter || !input) return;

  const pw = input.value || '';
  if (!pw) {
    meter.classList.remove('on');
    meter.setAttribute('data-level', '0');
    return;
  }

  const level = scorePassword(pw);
  meter.classList.add('on');
  meter.setAttribute('data-level', String(level));

  const verdict = $('pw-verdict');
  if (verdict) verdict.textContent = STRENGTH[level].verdict;
}

  function message(panel, text, kind) {
    const el2 = $('gate-msg-' + panel);
    if (!el2) return;
    el2.textContent = text || '';
    el2.className = 'login-gate-msg' + (text ? '' : ' hidden') + (kind ? ' ' + kind : '');
    if (kind === 'bad') {
      /* Restart the shake. Removing the class for a frame and putting it back
         is what makes a CSS animation replay; re-adding it alone does nothing
         because the animation never stopped running. */
      el2.style.animation = 'none';
      void el2.offsetWidth;
      el2.style.animation = '';
    }
  }

  function setBusy(btn, on) {
    busy = !!on;
    const el2 = btn || $('gate-login-btn');
    if (el2) el2.classList.toggle('busy', !!on);
    ['gate-login-btn', 'gate-reg-btn', 'gate-reset-btn'].forEach(function (id) {
      const b = $(id);
      if (b) b.disabled = !!on;
    });
  }

  /* ----------------------------------------------------------------- unlock */

  /* THE ONLY WAY OUT. Nothing else in the codebase removes auth-locked. */
  Gate.unlock = function () {
    try { document.documentElement.classList.remove('auth-locked'); } catch (e) {}
    if (el) el.hidden = true;

    /* HAND THE POINTER BACK. The custom crosshair belongs to the gate; leaving
       `cursor: none` on <html> after the gate closes means no pointer anywhere
       in the game â€” menus, shop, garage, everything. This is the difference
       between a cosmetic feature and a broken product.

       Removing the class here is necessary and not sufficient, which is exactly
       how the cursor stayed missing for so long. The document-level mousemove
       listener is still attached, so removing the class only holds until the
       player moves the mouse again â€” at which point the takeover ran a second
       time against a crosshair that was inside a hidden gate, and `cursor:none`
       came back with nothing in its place.

       setGateOpen(false) is the part that holds: it marks the crosshair as
       having nowhere to be drawn, so the listener declines to take the native
       pointer away again for the rest of the session. */
    try { setGateOpen(false); } catch (e) {
      /* setGateOpen can only fail if the document is gone, but unlock() is also
         the failure path when #login-gate is missing, so it must not be the
         thing that throws. */
      try { document.documentElement.classList.remove('lg-cursor-active'); } catch (e2) {}
      if (cursor.el) cursor.el.classList.remove('on');
      cursor.active = false;
    }

    /* The critical <style> is deliberately LEFT IN PLACE now. Removing it was
       tidy, and then had to be undone on every reopen. Every rule in it is
       scoped to `.auth-locked`, so with that class gone the style is inert
       either way â€” keeping it makes reopening the gate a two-line operation
       instead of re-synthesising a stylesheet at runtime.

       The boot sequence removes `booting` once the menu is genuinely up. That
       is game.js's job, not this file's, because only game.js knows when the
       menu is genuinely ready. */
  };

  /* ---------------------------------------------------------------- reopen

     WHY THIS EXISTS
     ---------------
     There used to be TWO account screens: this one, and an older, plainer dialog
     built into the main menu behind the small "Log In" label in the corner. Two
     screens for one job means the player can land on either, they look nothing
     alike, and the older one reads as broken next to the newer one.

     The menu button now opens THIS screen. One account system, one look, and no
     way to reach the deprecated dialog while the gate exists. */
  Gate.reopen = function (panel) {
    if (!el) return false;
    const html = document.documentElement;
    html.classList.add('auth-locked');
    /* lg-ready is never cleared on unlock precisely so this is instant â€” the
       gate is already allowed to display, boot finished long ago. */
    html.classList.add('lg-ready');
    el.hidden = false;
    /* Back inside the gate, so the crosshair is allowed to take the pointer over
       again. unlock() turned this off; reopening has to turn it back on or the
       account screen gets the native pointer while everything else does not. */
    try { setGateOpen(true); } catch (e) { /* cosmetic only */ }

    message('login', '');
    message('register', '');
    message('reset', '');
    Gate.showPanel(panel || 'login');

    /* Land on the form, not the chooser: the player asked to log in. */
    const first = {
      login: 'gate-login-user',
      register: 'gate-reg-user',
      reset: 'gate-reset-email',
    };
    const id = first[panel || 'login'];
    if (id) {
      const n = $(id);
      if (n && n.focus) setTimeout(function () { n.focus(); }, 90);
    }
    return true;
  };

  /* True when the gate can be shown. auth.js uses this to choose between the
     gate and the old dialog. */
  Gate.available = function () { return !!el; };

  /* ------------------------------------------------------------- api calls */

  /* Same origin as everything else. auth.js normally handles the network; the
     gate talks to Auth when it is available and falls back to fetch only when
     it is not, so the gate works even if script order changes. */
  function api(path, body, method) {
    if (window.Auth && typeof window.Auth._api === 'function') {
      return window.Auth._api(path, {
        method: method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    }
    return fetch(path, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          const e = new Error(data.error || 'Something went wrong (' + res.status + ')');
          e.status = res.status;
          throw e;
        }
        return data;
      });
    });
  }

  /* ------------------------------------------------------------------ login */

  function submitLogin() {
    if (busy) return;
    const user = (($('gate-login-user') || {}).value || '').trim();
    const pass = (($('gate-login-pass') || {}).value) || '';
    message('login', '');
    if (!user || !pass) { message('login', 'Enter your username or email, and your password', 'bad'); return; }

    setBusy($('gate-login-btn'), true);
    api('/api/auth/login', { login: user, password: pass })
      .then(function (data) {
        /* Guarded for the same reason as registration: a cached older auth.js
           must not be able to strand a player who has just proved who they
           are. */
        try {
          if (window.Auth && typeof window.Auth._setSession === 'function') {
            window.Auth._setSession(data.token, data.user);
            /* The name lives in tankparty_settings, not in the session, and this
               used to leave it alone — so the menu showed the right account name
               (it prefers Auth.user.username) while the game itself kept sending
               the guest's old Player#### to the score board, the clan roster and
               the other players in the match. One player, two names, half a
               screen at a time. Applying the profile here is what makes the
               settings agree with the account before the first match starts
               rather than one page load later. */
            if (typeof window.Auth._applyRemoteProfile === 'function') {
              window.Auth._applyRemoteProfile(data.user && data.user.profile);
            }
            if (typeof window.Auth._clearGuestFlag === 'function') window.Auth._clearGuestFlag();
            if (typeof window.Auth._updateUI === 'function') window.Auth._updateUI();
          }
        } catch (e) { /* falls through to the direct write below */ }
        try {
          localStorage.setItem('mtl_token', data.token);
          localStorage.setItem('mtl_user', JSON.stringify(data.user));
        } catch (e) { /* private mode */ }
        message('login', 'Welcome back. Loading your tanksâ€¦', 'good');
        /* A beat to read the confirmation before the screen changes. Without
           it the button flips to a tick and is instantly covered. */
        setTimeout(function () { Gate.unlock(); }, 420);
      })
      .catch(function (e) {
        setBusy($('gate-login-btn'), false);
        message('login', e.message, 'bad');
        const p = $('gate-login-pass');
        if (p) { p.value = ''; p.focus(); }
      });
  }

  /* --------------------------------------------------------------- register */

  function submitRegister() {
    if (busy) return;
    const user = (($('gate-reg-user') || {}).value || '').trim();
    const email = (($('gate-reg-email') || {}).value || '').trim();
    const pass = (($('gate-reg-pass') || {}).value) || '';
    const pass2 = (($('gate-reg-pass2') || {}).value) || '';
    message('register', '');
    if (!user || !email || !pass || !pass2) { message('register', 'Please fill in every field', 'bad'); return; }
    if (pass !== pass2) { message('register', 'The two passwords do not match', 'bad'); return; }
    if (pass.length < 8) { message('register', 'Password must be at least 8 characters', 'bad'); return; }

    /* A guest who has played for a while is signing up from inside their own
       session, so this browser already holds progress worth keeping. Capture
       it BEFORE registering, because registering is the moment the game starts
       treating local progress as authoritative-for-upload and merging it in.
       After that, a re-read would race the first upload. */
    var carried = null;
    try { carried = localStorage.getItem('tankparty_settings'); } catch (e) {}

    setBusy($('gate-reg-btn'), true);
    api('/api/auth/register', { username: user, email: email, password: pass })
      .then(function (data) {
        /* Every step here is guarded. A player holding a CACHED older auth.js
           from before the rewrite does not have _setSession, and one missing
           method here used to throw inside .then() â€” which skipped the guest
           progress upload, left the guest flag set, and left the gate locked
           with the account already created and no way in. A half-finished
           registration is the worst possible outcome, so each piece is allowed
           to fail on its own rather than taking the rest down with it. */
        try {
          if (window.Auth && typeof window.Auth._setSession === 'function') {
            window.Auth._setSession(data.token, data.user);
            /* A brand new account has no profile to pull yet, so this is usually
               a no-op — but the call belongs here for the same reason as on the
               login path: the settings and the session must not be able to
               disagree about who this is. */
            if (typeof window.Auth._applyRemoteProfile === 'function') {
              window.Auth._applyRemoteProfile(data.user && data.user.profile);
            }
            if (typeof window.Auth._clearGuestFlag === 'function') window.Auth._clearGuestFlag();
            if (typeof window.Auth._updateUI === 'function') window.Auth._updateUI();
          } else {
            localStorage.setItem('mtl_token', data.token);
            localStorage.setItem('mtl_user', JSON.stringify(data.user));
          }
        } catch (e) { /* the token is also written below regardless */ }

        try {
          localStorage.setItem('mtl_token', data.token);
          localStorage.setItem('mtl_user', JSON.stringify(data.user));
        } catch (e) { /* private mode: the session simply will not persist */ }

        /* The guest flag goes as soon as there is a real session. Leaving it
           behind would mean a later visit saw "guest" and skipped the session
           check entirely. */
        try {
          localStorage.removeItem('mtl_guest');
          localStorage.setItem('mtl_choice_made', 'signup');
        } catch (e) {}

        /* Hand the guest's garage to the account so nothing is lost at the
           moment somebody decides to keep what they built. Best effort: if this
           upload fails the account still exists and can be recovered. */
        if (carried) {
          try {
            var parsed = JSON.parse(carried);
            api('/api/auth/profile', { token: data.token, profile: parsed }, 'PUT')
              .catch(function () { /* retried on the next save */ });
          } catch (e) { /* malformed local state is not worth blocking on */ }
        }

        message('register', 'Account created. Loading your garageâ€¦', 'good');
        setTimeout(function () { Gate.unlock(); }, 520);
      })
      .catch(function (e) {
        setBusy($('gate-reg-btn'), false);
        message('register', e.message, 'bad');
      });
  }

  /* ------------------------------------------------------------------ reset */

  /* One panel and two steps, because they are one flow and splitting them into
     two screens makes the player press Back for no reason.

     Step 1 asks for the address and sends the mail. Step 2 appears once the
     link is followed. The token lives in memory only â€” never in the URL after
     the first read, and never in localStorage. */
  function resetStepTwo(token) {
    Gate._resetToken = token;
    const e1 = $('gate-reset-email-field'), p1 = $('gate-reset-pass-field'), p2 = $('gate-reset-pass2-field');
    if (e1) e1.classList.add('hidden');
    if (p1) p1.classList.remove('hidden');
    if (p2) p2.classList.remove('hidden');
    const title = $('gate-reset-note');
    if (title) title.textContent = 'Choose a New Password';
    const sub = $('gate-reset-sub');
    if (sub) sub.textContent = 'This link works once and expires in one hour.';
    const btn = $('gate-reset-btn');
    if (btn) btn.textContent = 'Set New Password';
    message('reset', '');
    /* The panel switch belongs HERE and not only at the call sites. It was
       missing from this function and the URL path â€” arriving from a reset link
       swapped the fields but left the LOGIN panel on screen, so somebody who
       clicked the emailed link was told to log in with a password they had just
       forgotten. Two call sites to remember is one too many. */
    Gate.showPanel('reset');
    const p = $('gate-reset-pass');
    if (p) p.focus();
  }

  function submitReset() {
    if (busy) return;
    message('reset', '');

    if (Gate._resetToken) {
      const pass = (($('gate-reset-pass') || {}).value) || '';
      const pass2 = (($('gate-reset-pass2') || {}).value) || '';
      if (pass.length < 8) { message('reset', 'Password must be at least 8 characters', 'bad'); return; }
      if (pass !== pass2) { message('reset', 'The two passwords do not match', 'bad'); return; }
      setBusy($('gate-reset-btn'), true);
      api('/api/auth/reset', { token: Gate._resetToken, password: pass })
        .then(function () {
          /* Every session was revoked server-side, including this one. Dropping
             the token here means the next load does not spend a request finding
             that out. */
          Gate._resetToken = null;
          try { localStorage.removeItem('mtl_token'); localStorage.removeItem('mtl_user'); } catch (e) {}
          message('reset', 'Password changed. Log in with your new password.', 'good');
          setBusy($('gate-reset-btn'), false);
          setTimeout(function () {
            Gate.showPanel('login');
            const u = $('gate-login-user');
            if (u) u.focus();
          }, 1100);
        })
        .catch(function (e) {
          setBusy($('gate-reset-btn'), false);
          message('reset', e.message, 'bad');
        });
      return;
    }

    const email = (($('gate-reset-email') || {}).value || '').trim();
    if (!email) { message('reset', 'Enter the email on your account', 'bad'); return; }
    setBusy($('gate-reset-btn'), true);
    api('/api/auth/forgot', { email: email })
      .then(function () {
        setBusy($('gate-reset-btn'), false);
        /* The same sentence whether or not that address exists. The server is
           built so this cannot be used to find registered addresses, and the
           wording must not reintroduce the leak. */
        message('reset', 'If that address has an account, a reset link is on its way. Check your spam folder too.', 'good');
        const b = $('gate-reset-btn');
        if (b) b.textContent = 'Send again';
      })
      .catch(function (e) {
        setBusy($('gate-reset-btn'), false);
        message('reset', e.message, 'bad');
      });
  }

  /* ------------------------------------------------------------------ wiring */

  function bind() {
    /* --- the chooser --- */
    ['guest', 'login', 'signup'].forEach(function (k) {
      const card = $('choose-' + k);
      if (card) card.addEventListener('click', function () { Gate.selectChoice(k); });
    });
    const okBtn = $('choose-ok');
    if (okBtn) okBtn.addEventListener('click', confirmChoice);

    /* --- password strength, live as you type --- */
    const pw = $('gate-reg-pass');
    if (pw) pw.addEventListener('input', updateStrength);

    /* Back from the login and register panels returns to the chooser rather
       than unlocking, because until something is submitted there is no session
       and letting go would be the gate's one job. */
    const loginBack = $('gate-login-back');
    if (loginBack) {
      loginBack.addEventListener('click', function () {
        message('login', '');
        Gate.showPanel('choose');
      });
    }
    const regBack = $('gate-reg-back');
    if (regBack) {
      regBack.addEventListener('click', function () {
        message('register', '');
        Gate.showPanel('choose');
      });
    }

    const lb = $('gate-login-btn');
    if (lb) lb.addEventListener('click', submitLogin);
    const rb = $('gate-reg-btn');
    if (rb) rb.addEventListener('click', submitRegister);
    const sb = $('gate-reset-btn');
    if (sb) sb.addEventListener('click', submitReset);

    /* Route out of the login form to the other two things somebody on this screen
       might actually want. Without these the login form is a dead end for
       anybody who does not already have an account. */
    const goSignup = $('gate-go-signup');
    if (goSignup) {
      goSignup.addEventListener('click', function () {
        message('login', '');
        Gate.showPanel('register');
        focusFirst('gate-reg-user');
      });
    }
    const goGuest = $('gate-go-guest');
    if (goGuest) {
      goGuest.addEventListener('click', function () {
        message('login', '');
        Gate.showPanel('choose');
        Gate.selectChoice('guest');
      });
    }

    const fb = $('gate-forgot');
    if (fb) {
      fb.addEventListener('click', function () {
        Gate._resetToken = null;
        const e1 = $('gate-reset-email-field'), p1 = $('gate-reset-pass-field'), p2 = $('gate-reset-pass2-field');
        if (e1) e1.classList.remove('hidden');
        if (p1) p1.classList.add('hidden');
        if (p2) p2.classList.add('hidden');
        const title = $('gate-reset-note');
        if (title) title.textContent = 'Password Reset';
        const sub = $('gate-reset-sub');
        if (sub) sub.textContent = 'We will email you a link to set a new one.';
        const btn = $('gate-reset-btn');
        if (btn) btn.textContent = 'Send Reset Link';
        message('reset', '');
        Gate.showPanel('reset');
        const e = $('gate-reset-email');
        if (e) e.focus();
      });
    }

    const back = $('gate-reset-back');
    if (back) {
      back.addEventListener('click', function () {
        Gate._resetToken = null;
        message('reset', '');
        Gate.showPanel('login');
      });
    }

    const vb = $('gate-verified-btn');
    if (vb) {
      vb.addEventListener('click', function () { Gate.showPanel('login'); });
    }

    /* Enter submits from every field. A password manager pressing Enter on the
       last field of a form does something surprising if it is not wired. */
    const enter = function (fn) {
      return function (e) { if (e.key === 'Enter') { e.preventDefault(); fn(); } };
    };
    const bindEnter = function (id, fn) {
      const n = $(id);
      if (n) n.addEventListener('keydown', enter(fn));
    };
    bindEnter('gate-login-user', submitLogin);
    bindEnter('gate-login-pass', submitLogin);
    bindEnter('gate-reg-user', submitRegister);
    bindEnter('gate-reg-email', submitRegister);
    bindEnter('gate-reg-pass', submitRegister);
    bindEnter('gate-reg-pass2', submitRegister);
    bindEnter('gate-reset-email', submitReset);
    bindEnter('gate-reset-pass', submitReset);
    bindEnter('gate-reset-pass2', submitReset);

    /* Escape must NOT close the gate. There is no close button and Escape
       deliberately does nothing â€” the screen has exactly one exit and it is
       through the server. This is here as a comment more than as code: if you
       add an Escape handler to this dialog later, this is the line to not add. */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !document.documentElement.classList.contains('auth-locked')) return;
    });
  }

  /* ------------------------------------------------------------ URL handoff */

  /* The reset and verification links both land here with a token in the query
     string. It is read once and then scrubbed out of the address bar, because
     a token left in a URL ends up in the browser history, in a screenshot, and
     in anything the player copies out of the address bar. A reset token is a
     password-replacement credential. */
  function handleUrlTokens() {
    let params;
    try { params = new URLSearchParams(location.search); } catch (e) { return false; }

    const reset = params.get('reset');
    if (reset) {
      scrubUrl();
      resetStepTwo(reset);
      return true;
    }

    const verify = params.get('verify');
    if (verify) {
      scrubUrl();
      setChecking(true);
      api('/api/auth/verify-email', { token: verify })
        .then(function () {
          setChecking(false);
          const t = $('gate-verified-text');
          if (t) t.textContent = 'Email confirmed. You can now recover this account if you forget your password.';
          Gate.showPanel('verified');
        })
        .catch(function () {
          setChecking(false);
          const t = $('gate-verified-text');
          if (t) t.textContent = 'This confirmation link is invalid or has expired.';
          Gate.showPanel('verified');
        });
      return true;
    }

    const verified = params.get('verified');
    if (verified !== null) {
      scrubUrl();
      const t = $('gate-verified-text');
      if (t) {
        t.textContent = verified === '1'
          ? 'Email confirmed. You can now recover this account if you forget your password.'
          : 'That confirmation link was invalid or has expired.';
      }
      Gate.showPanel('verified');
      return true;
    }
    return false;
  }

  function scrubUrl() {
    try {
      history.replaceState({}, document.title, location.pathname + location.hash);
    } catch (e) { /* the token is already read; this is tidiness only */ }
  }

  /* ------------------------------------------------------------------ start */

  Gate.start = function () {
    el = $('login-gate');
    if (!el) {
      /* No gate in the document. That should never happen, but releasing the
         lock is the right failure: a player who cannot log in is worse than a
         player who did not have to. */
      console.warn('[gate] #login-gate missing â€” releasing the lock');
      Gate.unlock();
      return;
    }

    /* Stamp the build into the footer so "which version am I running?" is
       answered by looking rather than by asking. */
    const stamp = $('login-gate-build');
    if (stamp) stamp.textContent = 'build ' + GATE_BUILD;

    bind();
    initCursor();

    /* Show the spinner, but only over the gate â€” the gate itself stays hidden
       until boot finishes, so during loading the player sees the game's own
       loading screen and nothing else. */
    setChecking(true);

    /* Do not touch the DOM visibly until boot reports ready. */
    waitForBoot(function () {
      decide();
    });
  };

  /* Everything that decides which panel the player sees. Split out of start()
     so it runs after boot rather than during it â€” the session check is a
     network round trip and must not be sitting on the critical path of a
     loading screen it cannot be seen behind. */
  function decide() {
    const auth = window.Auth;
    const decided = auth && typeof auth.init === 'function'
      ? auth.init()
      : Promise.resolve(false);

    decided
      .then(function (ok) {
        if (ok && auth && auth.loggedIn()) { Gate.unlock(); return; }

        /* No session. A reset or verification link in the URL takes precedence
           over everything â€” somebody who clicked an emailed link has already
           told us what they want and should not be asked again. */
        setChecking(false);
        if (handleUrlTokens()) return;

        /* Already answered this on an earlier visit. A returning player should
           land in the game, not be asked to identify themselves again for
           having signed in once.

           UNLESS ?login=1 is on the URL, which overrides the stored answer
           entirely â€” that is the escape hatch, and it also forgets the answer
           so the next plain visit behaves normally. */
        if (hasDecided() && !forcedByUrl()) { Gate.unlock(); return; }
        if (forcedByUrl()) clearChoice();

        choice = null;
        renderChoice();
        Gate.showPanel('choose');
      })
      .catch(function () {
        /* init() is written not to throw, but if it does, the player gets the
           chooser rather than an endless spinner. */
        setChecking(false);
        choice = null;
        renderChoice();
        Gate.showPanel('choose');
      });
  }

  window.LoginGate = Gate;

  /* Runs on DOMContentLoaded like the other scripts, and deliberately does not
     wait for the game. The gate is up long before this fires (the lock is
     inline), so what this does is fill in the form once the DOM exists. */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { Gate.start(); });
  else Gate.start();
})();