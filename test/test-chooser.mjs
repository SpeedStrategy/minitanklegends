/* Tests for the three-way chooser in login-gate.js.
   Run: node test-chooser.mjs

   The gate uses BARE globals (document, localStorage, location, history,
   fetch) and reads window.Auth, so the vm context has to supply the former as
   real globals and the latter on the window object. Each scenario builds a
   fresh DOM, fresh storage and a fresh vm so nothing leaks between them. */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = new URL('./login-gate.js', import.meta.url);

class El {
  constructor() {
    this.listeners = {}; this.classes = new Set(); this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.attrs = {}; this.children = [];
    this.textContent = ''; this.innerHTML = ''; this.value = '';
    this.disabled = false; this.hidden = false; this._c = '';
  }
  get className() { return this._c; }
  set className(v) { this._c = v || ''; this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this;
    return {
      add: (...c) => c.forEach((x) => s.classes.add(x)),
      remove: (...c) => c.forEach((x) => s.classes.delete(x)),
      toggle: (c, on) => { const h = s.classes.has(c); const w = on === undefined ? !h : !!on; w ? s.classes.add(c) : s.classes.delete(c); return w; },
      contains: (c) => s.classes.has(c),
    };
  }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  fire(t, e = {}) { (this.listeners[t] || []).forEach((f) => f(e)); }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() {} get offsetWidth() { return 1; }
  /* The burst is thrown from the OK button's position. */
  getBoundingClientRect() { return { left: 100, top: 200, width: 300, height: 60 }; }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  get parentNode() { return null; }
}

const IDS = [
  'login-gate', 'gate-checking', 'choose-note', 'choose-note-body',
  'choose-ok', 'choose-guest', 'choose-login', 'choose-signup',
  'gate-login-btn', 'gate-reg-btn', 'gate-reset-btn', 'gate-forgot', 'gate-reset-back',
  'gate-login-back', 'gate-reg-back', 'gate-verified-btn',
  'gate-login-user', 'gate-login-pass', 'gate-reg-user', 'gate-reg-email',
  'gate-reg-pass', 'gate-reg-pass2', 'gate-reset-email', 'gate-reset-pass',
  'gate-reset-pass2', 'gate-reset-email-field', 'gate-reset-pass-field',
  'gate-reset-pass2-field', 'gate-reset-note', 'gate-reset-sub', 'gate-verified-text',
  'gate-msg-login', 'gate-msg-register', 'gate-msg-reset',
  'pw-meter', 'pw-verdict', 'lg-cursor', 'lg-burst',
  'login-gate-panel-choose', 'login-gate-panel-login', 'login-gate-panel-register',
  'login-gate-panel-reset', 'login-gate-panel-verified',
];

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' -> ' + x : ''}`); }
};
const settle = () => new Promise((r) => setTimeout(r, 40));
/* Registration and login both defer their unlock by ~500ms so the player can
   read the confirmation. A test that waits 40ms is checking the screen before
   the transition it is waiting for has happened. */
const settleAfterAuth = () => new Promise((r) => setTimeout(r, 700));

/* The gate waits for the game to finish loading before it appears, by watching
   for the removal of `booting` from <html>. Every scenario therefore starts
   with boot already finished — that is the normal case, and testing it is the
   point. The waiting behaviour itself is checked separately at the end. */
function finishBoot(marks) { marks.delete('booting'); }
const on = (els, id, cls) => els[id].classes.has(cls);

function scenario(auth, seed, opts) {
  const options = opts || {};
  const els = {};
  for (const id of IDS) els[id] = new El();
  els['choose-ok'].disabled = true;

  const store = new Map(Object.entries(seed || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i],
  };

  const marks = new Set(['booting', 'auth-locked']);
  const docListeners = {};
  const document = {
    readyState: 'complete',
    documentElement: {
      className: 'booting auth-locked',
      classList: {
        add: (c) => marks.add(c),
        remove: (c) => marks.delete(c),
        contains: (c) => marks.has(c),
      },
      /* Stands in for the MutationObserver the gate uses to notice that boot
         finished. Without it the observer never fires in a stub DOM and every
         scenario would sit waiting for a 45-second fallback. */
      onClassChange: null,
    },
    head: { appendChild() {} },
    body: { appendChild() {} },
    getElementById: (id) => (id in els ? els[id] : null),
    createElement: () => new El(),
    /* Captured for real rather than dropped. The gate's crosshair is driven by
       a document-level mousemove listener, so a stub that throws listeners away
       cannot test the one behaviour that matters most about it. */
    addEventListener(t, f) { (docListeners[t] ||= []).push(f); },
    querySelectorAll: () => [],
  };

  const posted = [];
  const win = { Auth: auth, setTimeout, clearTimeout, console };
  win.window = win;
  const ctx = vm.createContext({
    ...win,
    document, localStorage,
    location: { search: '', pathname: '/', hash: '' },
    history: { replaceState() {} },
    fetch: async (url, opts) => {
      posted.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true, token: 'TOK', user: { username: 'x' } }) };
    },
    console, URLSearchParams,
  });

  vm.runInContext(readFileSync(SRC, 'utf8'), ctx);
  const fireClassChange = function () {
    if (document.documentElement.onClassChange) document.documentElement.onClassChange();
  };
  if (options.finishBootNow !== false) {
    finishBoot(marks);
    fireClassChange();
  }
  return { Gate: ctx.window.LoginGate, els, store, posted, marks, fireClassChange,
           locked: () => marks.has('auth-locked'),
           /* Lets a scenario drive the listeners the gate put on `document`. */
           fireDoc: (t, e = {}) => (docListeners[t] || []).forEach((f) => f(e)) };
}

/* Mirrors the real Auth surface. _setSession and _updateUI are included because
   the gate calls them, and their ABSENCE is itself worth testing separately —
   see the "stale cached auth.js" block at the end. */
const signedOut = () => ({
  init: () => Promise.resolve(false),
  loggedIn: () => false,
  bind() {},
  _setSession(t, u) { this.t = t; this.u = u; },
  _updateUI() {},
});

/* ===================================================================== */
console.log('\n-- guest --');
{
  const s = scenario(signedOut());
  await settle();

  ok('shows the chooser', on(s.els, 'login-gate-panel-choose', 'active'));
  ok('OK starts disabled', s.els['choose-ok'].disabled === true);
  ok('nothing selected yet', !on(s.els, 'choose-guest', 'selected'));
  ok('note asks for a pick', /pick one/i.test(s.els['choose-note-body'].textContent));

  s.els['choose-guest'].fire('click');
  ok('guest becomes selected', on(s.els, 'choose-guest', 'selected'));
  ok('login not selected', !on(s.els, 'choose-login', 'selected'));
  ok('signup not selected', !on(s.els, 'choose-signup', 'selected'));
  ok('OK becomes enabled', s.els['choose-ok'].disabled === false);
  ok('guest text says progress is NOT saved', /not be saved/i.test(s.els['choose-note-body'].innerHTML));
  ok('guest text says battles still work', /battle/i.test(s.els['choose-note-body'].innerHTML));
  ok('guest text says clans still work', /clans/i.test(s.els['choose-note-body'].innerHTML));
  ok('guest text says changeable later', /at any time/i.test(s.els['choose-note-body'].innerHTML));
  ok('note takes the picked colour', on(s.els, 'choose-note', 'is-picked'));

  s.els['choose-ok'].fire('click');
  /* Guest confirm waits for the burst to finish before unlocking. */
  await settleAfterAuth();
  ok('guest unlocks the game', !s.locked());
  ok('guest flag recorded', s.store.get('mtl_guest') === '1');
  ok('choice recorded for next visit', s.store.get('mtl_choice_made') === 'guest');
  ok('no account was created', !s.posted.some((p) => p.url.includes('register')));
  ok('no login was attempted', !s.posted.some((p) => p.url.includes('login')));
}

/* ===================================================================== */
console.log('\n-- login and signup routing --');
{
  const s = scenario(signedOut());
  await settle();

  s.els['choose-login'].fire('click');
  ok('login text promises your progress returns', /exactly as you left them/i.test(s.els['choose-note-body'].innerHTML));
  ok('login text offers a reset link', /reset/i.test(s.els['choose-note-body'].innerHTML));
  s.els['choose-ok'].fire('click');
  ok('OK opens the login form', on(s.els, 'login-gate-panel-login', 'active'));
  ok('login does not unlock', s.locked());

  s.els['gate-login-back'].fire('click');
  ok('back returns to the chooser', on(s.els, 'login-gate-panel-choose', 'active'));
  ok('back does not unlock', s.locked());

  s.els['choose-signup'].fire('click');
  ok('signup text mentions every device', /device/i.test(s.els['choose-note-body'].innerHTML));
  ok('signup text says it is reversible', /reversible|change your mind/i.test(s.els['choose-note-body'].innerHTML));
  s.els['choose-ok'].fire('click');
  ok('OK opens the signup form', on(s.els, 'login-gate-panel-register', 'active'));
  ok('signup does not unlock', s.locked());
}

/* ===================================================================== */
console.log('\n-- guest upgrades to an account --');
{
  const s = scenario(signedOut(), {
    mtl_guest: '1',
    tankparty_settings: JSON.stringify({ coins: 900, unlockedTanks: ['panzer'] }),
  });
  await settle();

  s.els['choose-signup'].fire('click');
  s.els['choose-ok'].fire('click');
  s.els['gate-reg-user'].value = 'Player';
  s.els['gate-reg-email'].value = 'p@example.com';
  s.els['gate-reg-pass'].value = 'longenough1';
  s.els['gate-reg-pass2'].value = 'longenough1';
  s.els['gate-reg-btn'].fire('click');
  await settleAfterAuth();

  const reg = s.posted.find((p) => p.url.includes('/api/auth/register'));
  const prof = s.posted.find((p) => p.url.includes('/api/auth/profile'));
  ok('registration was sent', !!reg);
  ok('it carries the new credentials',
     !!reg && reg.body.username === 'Player' && reg.body.password === 'longenough1');
  ok('guest coins move to the new account', !!prof && prof.body.profile.coins === 900,
     JSON.stringify(prof && prof.body.profile));
  ok('guest unlocked tanks move too',
     !!prof && prof.body.profile.unlockedTanks.indexOf('panzer') !== -1);
  /* Map.get() answers undefined for a missing key where localStorage answers
   null, so this asserts on presence rather than on a specific empty value. */
  ok('guest flag cleared once there is an account', s.store.has('mtl_guest') === false);
  ok('choice recorded as signup', s.store.get('mtl_choice_made') === 'signup');
  ok('unlocks after registering', !s.locked());
}

/* ===================================================================== */
console.log('\n-- already decided --');
{
  const s = scenario(signedOut(), { mtl_choice_made: 'guest' });
  await settle();
  ok('a returning guest is not asked again', !s.locked());
}
{
  const s = scenario(signedOut(), { mtl_choice_made: 'signup' });
  await settle();
  ok('a returning player is not asked again', !s.locked());
}

/* ===================================================================== */
console.log('\n-- an existing session still wins --');
{
  let bound = 0;
  const s = scenario({ init: () => Promise.resolve(true), loggedIn: () => true, bind() { bound++; } });
  await settle();
  ok('signed-in player skips the chooser', !s.locked());
  /* Binding deliberately moved OUT of the gate and into auth.js's own boot. If
     it stayed here, a missing or failed gate script would leave the main menu's
     "Log In" dead with no way to sign in at all — a failure nobody notices until
     somebody tries it. Asserting it is NOT called here is the regression guard
     for that. */
  ok('the gate does not bind the account dialog itself', bound === 0, `bound ${bound}x`);
}

/* ===================================================================== */
console.log('\n-- a stale cached auth.js cannot strand a player --');
{
  /* An Auth from before the rewrite: no _setSession, no _updateUI. This is
     what a player who already had the page open when the gate shipped is
     running. Registration must still complete and unlock. */
  const stale = {
    init: () => Promise.resolve(false),
    loggedIn: () => false,
    bind() {},
  };
  const s = scenario(stale);
  await settle();

  s.els['choose-signup'].fire('click');
  s.els['choose-ok'].fire('click');
  s.els['gate-reg-user'].value = 'Player';
  s.els['gate-reg-email'].value = 'p@example.com';
  s.els['gate-reg-pass'].value = 'longenough1';
  s.els['gate-reg-pass2'].value = 'longenough1';
  s.els['gate-reg-btn'].fire('click');
  await settleAfterAuth();

  ok('registration still completes', s.posted.some((p) => p.url.includes('/api/auth/register')));
  ok('session is written without Auth._setSession', s.store.get('mtl_token') === 'TOK');
  ok('the gate still unlocks', !s.locked());
}

/* ===================================================================== */
console.log('\n-- password strength --');
{
  const s = scenario(signedOut());
  await settle();

  const meter = s.els['pw-meter'];
  const input = s.els['gate-reg-pass'];
  const verdict = () => s.els['pw-verdict'].textContent;

  ok('meter is hidden before typing', !on(s.els, 'pw-meter', 'on'));

  input.value = 'abc';
  input.fire('input');
  ok('meter appears once something is typed', on(s.els, 'pw-meter', 'on'));
  ok('three characters is weak', meter.getAttribute('data-level') === '1', 'level=' + meter.getAttribute('data-level'));
  ok('weak verdict reads as weak', /weak/i.test(verdict()));

  input.value = 'password1';
  input.fire('input');
  ok('a classic dictionary word is not rewarded', meter.getAttribute('data-level') <= '2',
     'level=' + meter.getAttribute('data-level'));

  input.value = 'aaaaaaaaaaaaaaaaaaaa';
  input.fire('input');
  ok('one long repeated run is penalised', meter.getAttribute('data-level') <= '2',
     'level=' + meter.getAttribute('data-level'));

  input.value = 'Tr0ub4dor&3xyz';
  input.fire('input');
  ok('a strong password scores 4', meter.getAttribute('data-level') === '4',
     'level=' + meter.getAttribute('data-level'));
  ok('strong verdict says so', /strong/i.test(verdict()));

  input.value = '';
  input.fire('input');
  ok('clearing the field hides the meter again', !on(s.els, 'pw-meter', 'on'));
}

/* ===================================================================== */
console.log('\n-- the gate waits for boot --');
{
  /* Build a scenario where boot has NOT finished. scenario() normally finishes
     it immediately, so this one runs the script while `booting` is still set
     and only then reports it. */
  const s = scenario(signedOut(), {}, { finishBootNow: false });
  await settle();
  ok('lg-ready is not set while booting', !s.marks.has('lg-ready'));
  ok('no panel is chosen while booting',
     !on(s.els, 'login-gate-panel-choose', 'active'));

  /* Now let boot finish, the way game.js does. */
  s.marks.delete('booting');
  if (s.fireClassChange) s.fireClassChange();
  await settle();
  ok('lg-ready is set once boot finishes', s.marks.has('lg-ready'));
  ok('the chooser appears after boot', on(s.els, 'login-gate-panel-choose', 'active'));
}

/* ===================================================================== */
console.log('\n-- the confirm burst --');
{
  const s = scenario(signedOut());
  await settle();
  s.els['choose-login'].fire('click');
  const before = s.els['lg-burst'].children.length;
  s.els['choose-ok'].fire('click');
  const after = s.els['lg-burst'].children.length;
  ok('confirm throws shards', after > before, `${before} -> ${after}`);
  ok('shards are bounded, not a flood', after - before <= 40, `${after - before} shards`);
}

/* ===================================================================== */
console.log('\n-- one logo, and it is the real one --');
{
  /* Read the shipped index.html and assert the gate uses the same asset the
     browser tab already shows. This is the check that stops a second, subtly
     different tank image creeping back in — which is exactly what happened
     once, and it cost a deploy to notice. */
  const { readFileSync: read } = await import('node:fs');
  const html = read(new URL('../index.html', import.meta.url), 'utf8');

  const favicon = (html.match(/<link rel="icon"[^>]*href="([^"]+)"/) || [])[1];
  const gateLogo = (html.match(/class="lg-logo"[\s\S]{0,220}?src="([^"]+)"/) || [])[1];

  ok('index.html declares a favicon', !!favicon, favicon || 'none found');
  ok('the gate has a logo', !!gateLogo, gateLogo || 'none found');
  ok('the gate logo IS the favicon', gateLogo === favicon, `${gateLogo} vs ${favicon}`);

  const gateBlock = html.slice(html.indexOf('id="login-gate"'),
                              html.indexOf('id="login-gate"') + 9000);
  ok('exactly ONE <img> in the gate block',
     (gateBlock.match(/<img/g) || []).length === 1,
     (gateBlock.match(/<img/g) || []).length + ' img tags');
  ok('no leftover branding/ logo path', !/assets\/branding/.test(html));
  ok('the drawn CSS tank is gone', !/login-gate-tank/.test(gateBlock));
}

/* ===================================================================== */
console.log('\n-- the crosshair cursor --');
{
  const { readFileSync: read } = await import('node:fs');
  const html = read(new URL('../index.html', import.meta.url), 'utf8');
  const css = read(new URL('../css/login-gate.css', import.meta.url), 'utf8');

  ok('the cursor has four bars', (html.match(/lg-stick lg-stick-/g) || []).length === 4,
     (html.match(/lg-stick /g) || []).length + ' found');
  ok('bars are on all four sides',
     /lg-stick-t/.test(html) && /lg-stick-r/.test(html) &&
     /lg-stick-b/.test(html) && /lg-stick-l/.test(html));
  ok('the old ring is gone from the markup', !/lg-cursor-ring/.test(html));
  ok('the old dot is gone from the markup', !/lg-cursor-dot/.test(html));
  ok('the old ring is gone from the stylesheet', !/\.lg-cursor-ring\s*\{/.test(css));
  ok('the old dot is gone from the stylesheet', !/\.lg-cursor-dot\s*\{/.test(css));
  /* The gap is the whole point of four bars instead of two crossed ones. */
  ok('bars are shorter than the box, leaving a centre gap',
     /\.lg-stick-t[^}]*height:\s*13px/.test(css) && /\.lg-cursor\s*\{[^}]*height:\s*38px/.test(css));
  ok('the bars are bold, not hairline', /\.lg-stick-t[^}]*width:\s*4px/.test(css));
  ok('hot state turns them gold', /\.lg-cursor\.hot \.lg-stick\s*\{[^}]*#ffb12b/.test(css));
}

/* ===================================================================== */
console.log('\n-- one account screen, not two --');
{
  /* The bug this pins: the main menu's "Log In" opened a SECOND, plainer
     account dialog, so a player who chose Guest at the gate and then wanted an
     account got an interface that looked nothing like the one they had just
     used. Two screens for one job is how something reads as unfinished. */
  const { readFileSync: read } = await import('node:fs');
  const auth = read(new URL('../js/auth.js', import.meta.url), 'utf8');
  const gate = read(new URL('../js/login-gate.js', import.meta.url), 'utf8');

  ok('auth.js can reach the gate', /_gate\s*\(\)/.test(auth));
  ok('auth.open prefers the gate', /const gate = this\._gate\(\);[\s\S]{0,80}gate\.reopen/.test(auth));
  ok('the legacy dialog is kept as a fallback', /_openLegacy/.test(auth));
  ok('the menu button routes through open()', /this\.open\('choose'\)/.test(auth));
  /* The reason the menu button used to open a LOGIN FORM: somebody with no
     account has no business being shown one, and there was no Sign Up option
     anywhere on that screen. It lands on the chooser instead. */
  ok('open() defaults to the chooser, not the login form',
     /open\(panel\)[\s\S]{0,200}gate\.reopen\(panel \|\| 'choose'\)/.test(auth));
  ok('the login screen offers Sign Up',
     /id="gate-go-signup"/.test(read(new URL('../index.html', import.meta.url), 'utf8')));
  ok('the login screen offers guest play',
     /id="gate-go-guest"/.test(read(new URL('../index.html', import.meta.url), 'utf8')));
  ok('gate-go-signup is wired',
     /gate-go-signup[\s\S]{0,300}showPanel\('register'\)/.test(gate));

  ok('the gate can be reopened', /Gate\.reopen = function/.test(gate));
  ok('reopen re-applies the lock', /Gate\.reopen[\s\S]{0,700}classList\.add\('auth-locked'\)/.test(gate));
  ok('reopen unhides the gate', /Gate\.reopen[\s\S]{0,700}el\.hidden = false/.test(gate));
  ok('the gate reports availability', /Gate\.available = function/.test(gate));

  /* Binding must not depend on the gate, or a missing/failed gate script leaves
     the menu button dead with no way to sign in at all. */
  ok('auth.js always binds the menu button itself', /Auth\.bind\(\);[\s\S]{0,200}__gatePresent/.test(auth));
  ok('auth.js does NOT bind from Gate.unlock any more', !/_authBound/.test(gate));

  /* Signing in from the menu must clear the guest flag, or the browser keeps
     describing a signed-in player as a guest. */
  ok('login clears the guest flag', /async login[\s\S]{0,400}_clearGuestFlag\(\)/.test(auth));
  ok('register clears the guest flag', /async register[\s\S]{0,500}_clearGuestFlag\(\)/.test(auth));
  ok('register carries guest progress', /async register[\s\S]{0,900}_carryGuestProgress/.test(auth));
}

/* ===================================================================== */
console.log('\n-- cache-busters match the files on disk --');
{
  /* THE BUG THAT CAUSED THIS WHOLE ROUND OF REPORTED BUGS.

     js/auth.js was changed several times without its ?v= being bumped. The
     browser kept the old copy, so the page ran code that no longer matched the
     file on disk: `Auth._gate` was undefined, the menu's "Log In" silently did
     nothing, and the symptom ("I don't have a login") looked like broken
     application code rather than a cache.

     The rule this enforces: every script and stylesheet that this system
     changed must carry a ?v= stamp NEWER than the file's last modification.
     Bumping it is the whole job — it costs one character and it is the only
     thing standing between a deploy and a stale page. */

  const { readFileSync: read, statSync } = await import('node:fs');
  const html = read(new URL('../index.html', import.meta.url), 'utf8');

  const files = [
    { url: /js\/auth\.js\?v=(\S+?)'/,           path: '../js/auth.js' },
    { url: /js\/login-gate\.js\?v=(\S+?)'/,    path: '../js/login-gate.js' },
    { url: /js\/local-reset\.js\?v=(\S+?)'/,   path: '../js/local-reset.js' },
    { url: /css\/login-gate\.css\?v=([^"]+)"/, path: '../css/login-gate.css' },
  ];

  for (const f of files) {
    const m = html.match(f.url);
    const filePath = new URL(f.path, import.meta.url);
    const modified = statSync(filePath).mtime;
    const day = modified.toISOString().slice(0, 10).replace(/-/g, '');
    ok(`${f.path} has a ?v= stamp`, !!m, 'missing from index.html');
    if (!m) continue;
    /* The stamp is a YYYYMMDD token; compare it to the file's own mtime date. */
    const stamp = m[1];
    const isDate = /^\d{8}/.test(stamp);
    ok(`${f.path} stamp is a date`, isDate, stamp);
    ok(`${f.path} stamp is not older than the file`,
       isDate && stamp.slice(0, 8) >= day,
       `stamp=${stamp} file modified ${day}`);
  }

  /* THE HARDER HALF, AND THE ONE THAT ACTUALLY BIT.

     Comparing ?v= against a file's mtime only catches a stamp from a PREVIOUS
     DAY. Within one day it passes happily while the file underneath has changed
     again — which is exactly what happened: login-gate.js was edited and
     deployed, GATE_BUILD was bumped, and ?v= was not, so the browser served the
     previous build and the fix never appeared.

     So the stamp and the constant inside the file are required to be the SAME
     token. Editing one without the other now fails the suite. */
  const gateSrc = read(new URL('../js/login-gate.js', import.meta.url), 'utf8');
  const build = (gateSrc.match(/GATE_BUILD\s*=\s*'([0-9a-z]+)'/) || [])[1];
  ok('GATE_BUILD is declared', !!build);
  const gateVer = (html.match(/js\/login-gate\.js\?v=([^']+)'/) || [])[1];
  ok('login-gate.js ?v= matches GATE_BUILD', gateVer === build, `?v=${gateVer} build=${build}`);
  const cssVer = (html.match(/css\/login-gate\.css\?v=([^"]+)"/) || [])[1];
  ok('login-gate.css ?v= matches GATE_BUILD', cssVer === build, `?v=${cssVer} build=${build}`);
}

/* ===================================================================== */
console.log('\n-- no duplicate members silently winning --');
{
  /* A second definition of the same key in an object literal is not an error in
     JavaScript. The LAST one wins, silently. auth.js had two `open()` methods:
     the gate-aware one first, and the legacy-overlay one after it. The second
     won, so every fix applied to the first was dead code, and the main menu's
     "Log In" kept opening the old dialog no matter what the gate did.

     This asserts the ones that actually matter are defined exactly once. */
  const { readFileSync: read } = await import('node:fs');
  const auth = read(new URL('../js/auth.js', import.meta.url), 'utf8');

  const count = (re) => (auth.match(re) || []).length;
  /* `async login(...)` as well as `open(...)`, hence the optional keyword. */
  for (const name of ['open', 'close', 'toggle', 'bind', 'login', 'register', 'logout', 'init']) {
    const n = count(new RegExp('^  (?:async )?' + name + '\\s*\\(', 'gm'));
    ok(`auth.${name}() is defined exactly once`, n === 1, n + ' definitions');
  }
  /* _openLegacy must exist, since open() falls back to it. */
  ok('_openLegacy is defined exactly once', count(/^  _openLegacy\s*\(/gm) === 1);
  /* _gate likewise. */
  ok('_gate is defined exactly once', count(/^  _gate\s*\(/gm) === 1);
  /* open() itself must be the gate-aware one. */
  ok('the surviving open() prefers the gate',
     /open\(panel\)[\s\S]{0,200}gate\.reopen/.test(auth));
  ok('the surviving open() falls back to the legacy dialog',
     /open\(panel\)[\s\S]{0,260}_openLegacy/.test(auth));
}

/* ===================================================================== */
console.log('\n-- the cursor never leaves you without a pointer --');
{
  /* The bug this pins: `lg-cursor-active` sets `cursor: none` on <html> and
     everything inside it. It used to be added the moment the gate initialised,
     while the custom crosshair was still invisible, and unlock() never removed
     it — so there were two stretches with NO POINTER AT ALL: from load until
     the first mousemove, and the entire game after the gate closed. */
  const { readFileSync: read } = await import('node:fs');
  const gate = read(new URL('../js/login-gate.js', import.meta.url), 'utf8');

  ok('the class is NOT added during init',
     !/function initCursor\(\)[\s\S]{0,400}?classList\.add\('lg-cursor-active'\)/.test(gate));
  ok('it is added on the first mousemove instead',
     /mousemove[\s\S]{0,900}?classList\.add\('lg-cursor-active'\)/.test(gate));
  ok('the crosshair starts invisible', /\.lg-cursor\s*\{[^}]*opacity:\s*0/.test(read(new URL('../css/login-gate.css', import.meta.url), 'utf8')));
  ok('the build stamp exists in the markup',
     /id="login-gate-build"/.test(read(new URL('../index.html', import.meta.url), 'utf8')));
  ok('the build stamp is set from a constant',
     /\$\('login-gate-build'\)[\s\S]{0,80}GATE_BUILD/.test(gate));
}

/* ===================================================================== */
console.log('\n-- log in, and keep your cursor --');
{
  /* This block used to be two greps over the source, which is the only kind of
     test that CANNOT catch this bug. The failure was never "unlock() forgot to
     remove a class" — unlock() did remove it. It was that the document-level
     mousemove listener was still attached, so the very first movement in the
     game put the class straight back and `cursor: none` returned with the
     crosshair it was supposed to be paired with sitting inside a hidden gate.

     No regex over the source can see that, because each individual line is
     correct. Only running it can. So this drives the real thing: a boot, a gate,
     a move, an unlock, and then another move — the last one being the whole
     point. */
  const s = scenario(signedOut());
  await settle();

  ok('the gate is on screen to begin with', s.locked());
  ok('and the native pointer is still there before any movement', !s.marks.has('lg-cursor-active'));

  s.fireDoc('mousemove', { clientX: 10, clientY: 20 });
  ok('moving over the gate takes the crosshair over', s.marks.has('lg-cursor-active'));
  ok('and shows it', s.els['lg-cursor'].classes.has('on'));

  s.Gate.unlock();
  ok('unlocking hands the native pointer back', !s.marks.has('lg-cursor-active'));
  ok('unlocking hides the crosshair', !s.els['lg-cursor'].classes.has('on'));

  /* THE REGRESSION. One movement in the game used to undo everything above. */
  s.fireDoc('mousemove', { clientX: 640, clientY: 480 });
  ok('moving the mouse in the game does NOT take the pointer away again',
     !s.marks.has('lg-cursor-active'));
  ok('and does not switch on a crosshair inside a hidden gate',
     !s.els['lg-cursor'].classes.has('on'));

  /* ...and several more, because a player does not stop at one. */
  for (let i = 0; i < 20; i++) s.fireDoc('mousemove', { clientX: i * 7, clientY: i * 5 });
  ok('nor does any later movement', !s.marks.has('lg-cursor-active'));

  /* The gate is not a one-way door, so the crosshair has to come back with it. */
  s.Gate.reopen('login');
  ok('reopening the gate re-applies the lock', s.locked());
  s.fireDoc('mousemove', { clientX: 700, clientY: 300 });
  ok('and the crosshair takes over again inside it', s.marks.has('lg-cursor-active'));

  s.Gate.unlock();
  ok('closing it a second time hands the pointer back again', !s.marks.has('lg-cursor-active'));
}

/* ===================================================================== */
console.log('\n-- the chooser is never a one-way door --');
{
  const { readFileSync: read } = await import('node:fs');
  const gate = read(new URL('../js/login-gate.js', import.meta.url), 'utf8');
  const auth = read(new URL('../js/auth.js', import.meta.url), 'utf8');

  ok('?login=1 forces the chooser back',
     /forcedByUrl\(\)/.test(gate) && /hasDecided\(\) && !forcedByUrl\(\)/.test(gate));
  ok('?login=1 forgets the stored answer', /if \(forcedByUrl\(\)\) clearChoice\(\)/.test(gate));
  ok('the menu button advertises both options',
     /'Sign In \/ Sign Up'/.test(auth));
  ok('the signed-out label is not just "Log In"',
     !/logged \? 'Log Out' : 'Log In'/.test(auth));
}

/* ===================================================================== */
console.log('\n-- one name, never two --');
{
  const { readFileSync: read } = await import('node:fs');
  const auth = read(new URL('../js/auth.js', import.meta.url), 'utf8');
  const menu = read(new URL('../js/menu.js', import.meta.url), 'utf8');
  const game = read(new URL('../js/game.js', import.meta.url), 'utf8');
  const html = read(new URL('../index.html', import.meta.url), 'utf8');

  /* A signed-in player was shown "Player8459" as the profile heading and
     "Account: Vostok" underneath it — two names, and the generated one is the
     one they did not choose. Both halves of that are now asserted. */
  ok('the profile card prefers the account username over the generated name',
     /nameEl\.textContent = username \|\| s\.playerName/.test(menu));
  ok('the card asks Auth for the username, not localStorage',
     /auth\.loggedIn\(\)/.test(menu) && /auth\.user\?\.username|auth\.user \? \(auth\.user\.username/.test(menu));
  ok('the card subline is a status, not a second name',
     /const status = signedIn \? '' : 'Guest'/.test(menu));
  ok('the card subline carries no username',
     !/accEl\.textContent = [^\n]*username/.test(menu));
  /* There were TWO writers for that element and only fixing one left the bug
     live — the second ran afterwards and restored the duplicate name. Assert
     the rule holds for every writer, not just the first. */
  ok('no writer of the card subline mentions the username',
     ![...menu.matchAll(/accEl\.textContent = ([^\n;]*)/g)]
       .some(m => /username|Account:/.test(m[1])));
  ok('there is no second account-name writer left',
     !/'Account: ' \+ Auth\.user\.username/.test(menu) &&
     !/'Account: ' \+ this\.user\.username/.test(menu));
  /* The top bar was "Signed in", then emptied entirely at the player's request:
     the card already shows the name and the button already says Log Out. */
  ok('the top bar prints no name of its own',
     !/acc\.textContent = logged \? 'Account: /.test(auth) &&
     !/acc\.textContent = logged \? 'Signed in'/.test(auth));
  ok('the top bar never prints the username',
     !/acc\.textContent = logged \? 'Account: '/.test(auth));

  /* Root cause: the server profile has no playerName, so the old code left the
     generated name in place. Falling back to the username is the fix. */
  /* Superseded by the GENERATED_NAME rule below, which also covers the blank
     case: an empty name is refused by the same test that refuses "Player8459". */
  ok('a blank server name falls back to the username',
     /const realName = username \|\| \(storedIsReal \? storedName : ''\)/.test(auth));
}

console.log('\n-- the cursor is taken on purpose, and says so --');
{
  const { readFileSync: read } = await import('node:fs');
  const game = read(new URL('../js/game.js', import.meta.url), 'utf8');
  const html = read(new URL('../index.html', import.meta.url), 'utf8');
  const css = read(new URL('../css/style.css', import.meta.url), 'utf8');

  ok('the hint element exists', /id="crosshair-hint"/.test(html));
  ok('dynamic aiming triggers the hint', /if\(isDynamic\) this\._hintCrosshair\(\)/.test(game));
  ok('the hint names the key that restores the cursor',
     /Hold Ctrl to show your cursor/.test(game));
  ok('the hint fires once per browser, not every match',
     /mtl_crosshair_hint_v1/.test(game));
  ok('the hint is styled to the house rules',
     /#crosshair-hint\{[^}]*font-family:'Lilita One'/.test(css) &&
     /#crosshair-hint\{[^}]*border:3px solid #000/.test(css));
  ok('the native pointer is still restored when the gate closes',
     /remove\('lg-cursor-active'\)/.test(
       read(new URL('../js/login-gate.js', import.meta.url), 'utf8')));
}

/* ===================================================================== */
console.log('\n-- the pointer survives leaving a match --');
{
  const { readFileSync: read } = await import('node:fs');
  const game = read(new URL('../js/game.js', import.meta.url), 'utf8');
  const css = read(new URL('../css/style.css', import.meta.url), 'utf8');

  /* The reported symptom: the cursor vanished in the menus and no crosshair was
     drawn to replace it. crosshair-mode keyed off the camera setting alone, and
     dynamic is the default, so a fullscreen canvas with cursor:none sat behind
     every menu for the whole session. */
  ok('the cursor rule refuses to fire while a menu is open',
     /\.crosshair-mode:not\(:has\(\.menu:not\(\.hidden\)\)\)/.test(css));
  ok('the old unconditional cursor rule is gone',
     !/^\.crosshair-mode #game-root canvas\{ cursor: none/m.test(css));

  ok('crosshair-mode also requires that no menu is visible in JS',
     /isDynamic = this\.cameraMode === 'dynamic' && !inMenu/.test(game));
  ok('the JS checks real menus, not a hardcoded list',
     /querySelectorAll\('\.menu'\)/.test(game));
  ok('menus are watched so no open/close path can leak the class',
     /_watchMenus\(\)/.test(game) && /new MutationObserver/.test(game));
  ok('the watcher observes class changes across the tree',
     /subtree: true, attributes: true, attributeFilter: \['class'\]/.test(game));
  ok('the watcher is installed from the camera-mode path',
     /this\.camAngle = Math\.PI[\s\S]{0,200}_watchMenus\(\)/.test(game));
}

console.log('\n-- a generated name is never mistaken for a chosen one --');
{
  const { readFileSync: read } = await import('node:fs');
  const auth = read(new URL('../js/auth.js', import.meta.url), 'utf8');
  const menu = read(new URL('../js/menu.js', import.meta.url), 'utf8');

  /* The real cause of "Player8459". A guest session uploads the invented name to
     the server, /api/auth/me returns it as a truthy playerName, and the earlier
     "fall back to the username" rule never fired because the value was not
     empty. It was a real row in the database. */
  ok('generated names are recognised by shape', /const GENERATED_NAME = \/\^Player\\d\{4\}\$\//.test(auth));
  ok('a generated name is refused even when the server sends it',
     /!GENERATED_NAME\.test\(storedName\)/.test(auth));
  ok('the username is used instead', /this\.user && this\.user\.username/.test(auth));
  ok('the stored record is repaired, not just the local copy',
     /fresh\.playerName = realName/.test(auth));
  ok('the repair cannot loop', /this\._repairingName/.test(auth));

  /* A stored name that is not generated is still only a FALLBACK. Local settings
     are shared across accounts in one browser, so a stored name can belong to a
     different player - which was observed live. With no rename feature for it
     to legitimately beat, the account's own username wins outright. */
  ok('the username outranks any stored name',
     /const realName = username \|\| \(storedIsReal \? storedName : ''\)/.test(auth));
  ok('a non-generated stored name is still usable as a fallback',
     /storedIsReal/.test(auth));

  /* Both name renderers must agree, or the card and the strip disagree. */
  const nameWriters = [...menu.matchAll(/nameEl\.textContent = ([^\n;]*)/g)].map(m => m[1]);
  ok('every writer of the display name consults Auth',
     nameWriters.length > 0 && nameWriters.every(w => /username|s\.playerName/.test(w)),
     `${nameWriters.length} writers`);
  ok('no writer falls back to a literal Player',
     !nameWriters.some(w => /^\s*s\.playerName \|\| 'Player'\s*$/.test(w)));

  /* The bar the player asked to have emptied. */
  ok('the top bar prints nothing at all',
     /acc\.textContent = ''/.test(auth));
  ok('the top bar is permanently hidden',
     /acc\.classList\.add\('hidden'\)/.test(auth));
  ok('"Signed in" is gone', !/textContent = logged \? 'Signed in'/.test(auth));

  /* The card was painted only as a side effect of bumpStat(), so opening the
     profile showed the literal "Player" from the markup — and a stale name
     painted once survived every later visit. */
  ok('the profile card renders when it is OPENED',
     /id === 'menu-profile'[\s\S]{0,160}_renderProfileCard\(\)/.test(menu));
  ok('and not only as a side effect of a stat bump',
     (menu.match(/_renderProfileCard\(\)/g) || []).length >= 2);
}

  console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);