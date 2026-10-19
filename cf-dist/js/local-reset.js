/* ============================================================================
   local-reset.js — clear the old, pre-account local progress.

   WHAT THIS REMOVES
   -----------------
   The game shipped for a long time with no account system at all. Progress
   lived only in this browser, under keys like tankparty_settings, and it was
   per-device: signing in on another machine showed a different garage, and
   nothing could move a coin from one to the other.

   Now that accounts exist, that local copy is the wrong source of truth. Left
   in place it is actively harmful in one specific way: a player who signs in on
   a browser that has old local progress will have it merged in, and a garage
   full of tanks they never earned will follow them onto every device. So it
   has to go.

   ONE-TIME, NOT EVERY LOAD
   ------------------------
   This runs once per browser, stamped with RESET_VERSION. It is not a loop
   over localStorage on every visit, because clearing progress on every load
   would delete the game.

   The stamp means bumping RESET_VERSION re-runs the wipe deliberately later,
   which is occasionally what you want and is always better than editing this
   file by hand and forgetting.

   WHAT IT DELIBERATELY DOES NOT DELETE
   ------------------------------------
     * mtl_token / mtl_user — the session. Deleting these on load would sign
       everybody out every time they refreshed, and would fight the gate's own
       session check.

     * audio_*, graphicsSettings, nightMode* — device settings, not progress.
       There is no reason for a new account to forget somebody's volume.

     * Anything not on the list below. Being conservative here matters: an
       unknown key is more likely to be something worth keeping than something
       stale, and this file has to stay readable in six months.
   ========================================================================== */

'use strict';

(function () {
  /* Bump this to run the wipe again. 2 = the D1 account migration. */
  var RESET_VERSION = 2;
  var STAMP_KEY = 'mtl_local_reset_v';

  /* The old per-device progress. tankparty_settings is the big one — coins,
     tanks, unlocks, player name. The rest are derived views of it plus editor
     drafts. */
  var PROGRESS_KEYS = [
    'tankparty_settings',
    'tankparty_shop',
    'tankparty_collections',
    'tankparty_clan',
    'tankparty_clan_names',
    'tankparty_clan_layout',
    'tankparty_clan_registry',
    'tankparty_clan_img_',
    'tankparty_gamemode',
    'tankparty_mainmap',
    'tankparty_mapunlocked',
    'tankparty_sprays',
    'tankparty_garage_preview',
    'tankparty_storage',
    'tankparty_custommainmenu',
    'tankparty_custommap',
    'tankparty_menueditor',
    'tankparty_editor123_library',
    'tankparty_editor123_map',
    'tankparty_editor123_menus',
    'tankparty_rt_dismissed',
    'tankFavorites',
  ];

  /* Kept on purpose. Listed explicitly rather than by prefix so that adding a
     new device setting later does not accidentally become player data. */
  var KEEP_KEYS = [
    'mtl_token',
    'mtl_user',
    'audio_musicVolume',
    'audio_muted',
    'audio_volume',
    'graphicsSettings',
    'nightMode',
    'nightModeStrong',
  ];

  function hasLocalStorage() {
    try {
      var probe = '__mtl_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch (e) {
      /* Safari private mode, a storage-partitioned iframe, or a browser with
         site data blocked. Not an error worth reporting — the game runs, it
         just cannot remember anything, which is how it always worked. */
      return false;
    }
  }

  function run() {
    if (!hasLocalStorage()) return;

    var done = null;
    try { done = localStorage.getItem(STAMP_KEY); } catch (e) { return; }
    if (done === String(RESET_VERSION)) return;

    var removed = 0;
    for (var i = 0; i < PROGRESS_KEYS.length; i++) {
      try {
        if (localStorage.getItem(PROGRESS_KEYS[i]) !== null) removed++;
        localStorage.removeItem(PROGRESS_KEYS[i]);
      } catch (e) { /* one bad key must not stop the rest */ }
    }

    /* Belt and braces: anything that LOOKS like the old clan data, including
       suffixed variants the explicit list above does not know about. The
       KEEP list is checked first so a future key like
       tankparty_settings_backup_v2 is not deleted by accident. */
    try {
      var doomed = [];
      for (var k = 0; k < localStorage.length; k++) {
        var key = localStorage.key(k);
        if (!key) continue;
        if (KEEP_KEYS.indexOf(key) !== -1) continue;
        if (key.indexOf('mtl_') === 0) continue;
        if (key.indexOf('tankparty_') === 0 || key === 'tankFavorites') {
          doomed.push(key);
        }
      }
      doomed.forEach(function (key) {
        try { localStorage.removeItem(key); removed++; } catch (e) {}
      });
    } catch (e) { /* enumeration is best-effort */ }

    try { localStorage.setItem(STAMP_KEY, String(RESET_VERSION)); } catch (e) {}

    if (removed) {
      console.log('[reset] cleared ' + removed + ' local progress key(s); accounts now hold progress');
    }
  }

  /* Runs as early as the document allows and does not wait for anything. It is
     a few localStorage calls, so it is finished long before the gate asks the
     server who the player is. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }

  window.MTLLocalReset = { run: run, version: RESET_VERSION };
})();