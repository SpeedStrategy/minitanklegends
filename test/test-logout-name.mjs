/* Runtime test for the one thing that must be true when a session ends.

   THE BUG
   -------
   `playerName` lives in tankparty_settings, not in the session. auth.js wrote
   the account's username into it on the way in — correctly, that is how the
   profile card shows the right name — and then only ever cleared the session on
   the way out. So pressing Log Out, or being logged out on another device, left
   the account's name sitting in the one field every screen reads as "the
   player":

     profile card, top strip, clan roster, chat, score board, and every name
     sent to the other players in a match.

   Pick Guest afterwards and you are still called by your account. It reads as
   the gate failing to log you out, because the session really was gone — only
   the name was not.

   Run: node test-logout-name.mjs                                                  */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = new URL('../js/auth.js', import.meta.url);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
};

/* --------------------------------------------------------------- one browser */

function browser(seed) {
  const store = new Map(Object.entries(seed || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i],
  };

  /* The parts of the game auth.js reaches for. loadSettings/saveSettings are
     stand-ins with the SAME contract as the real ones in config.js — in
     particular saveSettings hands the object to Auth.onSettingsSaved, because
     that is what decides whether an upload gets scheduled, and the ordering of
     that call is one of the things under test. */
  const settings = {};
  const settingsJSON = localStorage.getItem('tankparty_settings');
  if (settingsJSON) Object.assign(settings, JSON.parse(settingsJSON));

  let generated = 0;
  let refreshed = 0;

  const document = {
    readyState: 'complete',
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    documentElement: { classList: { add() {}, remove() {}, contains: () => false } },
  };

  const win = {
    __gatePresent: true,        /* auth.js stands aside and lets the gate check */
    document, localStorage, setTimeout, clearTimeout, console,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    loadSettings: () => Object.assign({}, settings),
    saveSettings: (s) => {
      /* Serialised first, exactly as the real one does. Without the copy this
         wipes itself: the caller routinely passes the live object, so deleting
         every key before re-assigning from it empties the very thing it was
         handed. */
      const copy = JSON.parse(JSON.stringify(s));
      for (const k of Object.keys(settings)) delete settings[k];
      Object.assign(settings, copy);
      localStorage.setItem('tankparty_settings', JSON.stringify(copy));
      if (win.Auth && win.Auth.onSettingsSaved) win.Auth.onSettingsSaved(copy);
    },
    generatePlayerName: () => { generated++; return 'Player' + (1000 + generated); },
    Menu: { settings, refreshProfile: () => { refreshed++; } },
  };
  win.window = win;

  const ctx = vm.createContext(win);
  vm.runInContext(readFileSync(SRC, 'utf8'), ctx);

  return {
    Auth: ctx.window.Auth, store, settings, win,
    saved: () => JSON.parse(localStorage.getItem('tankparty_settings') || '{}'),
    refreshed: () => refreshed,
    generated: () => generated,
  };
}

const signedIn = (b, username) => {
  b.Auth._setSession('TOKEN123', { username, profile: null });
  b.settings.playerName = username;
  b.win.saveSettings(b.settings);
  b.Auth._saveTimer = null;
};

/* ===================================================================== */
console.log('\n-- logging out --');
{
  const b = browser();
  signedIn(b, 'Vostok');

  ok('the account name is what the menu is showing', b.settings.playerName === 'Vostok');

  b.Auth.leaveAccount();

  ok('the session is gone', b.Auth.loggedIn() === false);
  ok('the token is gone', b.store.get('mtl_token') === undefined);
  ok('the cached user is gone', b.store.get('mtl_user') === undefined);

  ok('the ACCOUNT NAME is gone too', b.settings.playerName !== 'Vostok', b.settings.playerName);
  ok('a fresh guest name replaced it', /^Player\d{4}$/.test(b.settings.playerName || ''), b.settings.playerName);
  ok('and it was written to storage, not just to memory',
     (b.saved().playerName || '') === b.settings.playerName);

  ok('the running game sees the new name as well', b.settings.playerName === (b.saved().playerName || ''));
  ok('the menu was told to repaint', b.refreshed() === 1);
}

console.log('\n-- logging out does not rename a guest --');
{
  /* The first version of this replaced anything matching /^Player\d{4}$/, on the
     reasoning that a generated name is a placeholder. True of where it came
     from, irrelevant to whether it is now the player's: clan membership, the
     score board and the platoon roster are all keyed on this string, so quietly
     renaming somebody between matches is worse than the bug being fixed. */
  const b = browser();
  b.Auth._setSession('TOKEN123', { username: 'Vostok', profile: null });
  b.settings.playerName = 'Player4821';
  b.win.saveSettings(b.settings);

  b.Auth.leaveAccount();

  ok('a guest name that is not the account name is left alone',
     b.settings.playerName === 'Player4821', b.settings.playerName);
  ok('and no new name was invented', b.generated() === 0);
}

console.log('\n-- leaving an account that was never signed in --');
{
  /* Picking Guest at the gate with no session goes through the same door. It has
     to be a complete no-op, or joining as a guest would rename you. */
  const b = browser();
  b.settings.playerName = 'Player4821';
  b.win.saveSettings(b.settings);

  b.Auth.leaveAccount();

  ok('the guest keeps their name', b.settings.playerName === 'Player4821', b.settings.playerName);
  ok('nothing is stored that was not already stored',
     (b.saved().playerName || '') === 'Player4821');
}

console.log('\n-- the account record on the server is not damaged on the way out --');
{
  /* leaveAccount() clears the session FIRST and saves second, on purpose. The
     other order lets saveSettings() schedule a profile upload — and there is no
     token by then only because of that ordering, so getting it wrong empties the
     account's stored playerName on every logout. */
  const b = browser();
  signedIn(b, 'Vostok');

  b.Auth.leaveAccount();

  ok('no profile upload was scheduled on the way out', b.Auth._saveTimer === null);
  ok('so nothing was pushed over an account that no longer has a session',
     !b.store.has('mtl_token'));
}

console.log('\n-- signing in gives the account the name it owns --');
{
  /* The other half of the report: the name was correct on the profile card while
     signed in and wrong afterwards. Both come from the same field, so both are
     pinned here. */
  const b = browser();
  signedIn(b, 'Vostok');

  b.Auth._applyRemoteProfile({ playerName: 'Vostok' });

  ok('the live settings object gets the account name', b.settings.playerName === 'Vostok');
  ok('and so does storage', b.saved().playerName === 'Vostok');

  b.Auth.leaveAccount();
  ok('and gives it back on the way out', b.settings.playerName !== 'Vostok');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);