/* ============================================================================
   Tank Legends Desktop — main process.

   WHAT THIS APP IS
   ----------------
   A dedicated Chromium window pointed at the live game:
   https://tanklg.pages.dev/

   That single decision does three things the owner asked for:

   1. THE APP IS ALWAYS UP TO DATE. The game is never bundled here, so every
      launch (and every F5) loads whatever is currently deployed on
      tanklg.pages.dev. Pushing a game update on the site updates every desktop
      player automatically, with no installer download at all.

   2. THE SHELL ITSELF ALSO AUTO-UPDATES, and its update feed lives on the same
      domain the owner asked for: https://tanklg.pages.dev/updates/latest.yml
      (electron-updater, generic provider). The feed only names the installer,
      which is ~90 MB — bigger than the 25 MiB Cloudflare per-file cap — so the
      *binaries* sit on GitHub Releases and the feed's file URLs point there.
      scripts/make-update-feed.mjs generates the feed. If the installer ever
      shrinks under the cap, that script's --base flag can point everything
      back at the site and the feed becomes fully self-hosted.

   3. WHY THIS HELPS MULTIPLAYER. The renderer runs with backgroundThrottling
      disabled and the process is kept awake with a powerSaveBlocker, so a host
      who alt-tabs (or whose window is minimised) keeps ticking at full rate
      instead of being throttled the way a background browser tab is. The game
      also gets a private GPU/compositor process with no other tabs, no
      extensions, and no memory-saver discarding the page.

   DEV OVERRIDES
   -------------
      electron . --game-url=http://localhost:5173/    (or TL_GAME_URL env)
      TL_NO_UPDATE=1        skip update checks
      --smoke-test          hidden window, exit 0 once the site loads
   ========================================================================== */

'use strict';

const { app, BrowserWindow, Menu, session, shell, powerSaveBlocker, ipcMain, dialog } = require('electron');
const path = require('path');

const GAME_URL_DEFAULT = 'https://tanklg.pages.dev/';
const FEED_URL = process.env.TL_FEED_URL || 'https://tanklg.pages.dev/updates/';
const APP_ID = 'dev.tanklegends.app';

const ARGV = process.argv.slice(1);
const IS_SMOKE = ARGV.includes('--smoke-test');
const IS_PACKAGED = app.isPackaged;

/* --- game url resolution: --game-url flag wins, then env, then live site --- */
function resolveGameUrl() {
  const flagIdx = ARGV.findIndex((a) => a === '--game-url');
  if (flagIdx !== -1 && ARGV[flagIdx + 1]) return ARGV[flagIdx + 1];
  for (let i = 0; i < ARGV.length; i++) {
    if (ARGV[i].startsWith('--game-url=')) return ARGV[i].slice('--game-url='.length);
  }
  if (process.env.TL_GAME_URL) return process.env.TL_GAME_URL;
  return GAME_URL_DEFAULT;
}

const GAME_URL = resolveGameUrl();

/* ============================================================================
   ELECTRON ADVANTAGES — the switches a plain browser tab can never set.
   -------------------------------------------------------------------------- */
const IS_SAFE_GPU = process.env.TL_SAFE_GPU === '1' || ARGV.includes('--safe-gpu'); /* legacy no-op: safe IS the default now */
const IS_UNCAP    = process.env.TL_UNCAP === '1'   || ARGV.includes('--uncapped');   /* legacy no-op: uncapped IS the default now */
const IS_GPU_BOOST = process.env.TL_GPU_BOOST === '1' || ARGV.includes('--gpu-boost');
const IS_VSYNC    = process.env.TL_VSYNC === '1'    || ARGV.includes('--vsync');

/* Menu music / engine SFX start immediately — no "click anywhere to enable
   audio" dance. A browser forces that gesture on the user; we don't have to. */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* THE GPU-BOOST TRIO IS NOW OPT-IN (TL_GPU_BOOST=1 / --gpu-boost).
   Shipping these as defaults backfired on hybrid-GPU laptops (Intel iGPU
   drives the display, AMD dGPU renders): WebGL2 failed and fell back to
   WebGL1, the compositor missed every other vsync and rAF ran at ~30 Hz
   while the GPU idled at 2% — real frames finished in 15.9 ms. Chromium's
   conservative defaults pick the stable path; users who want the extra
   margin (or whose GPU is actually blocklisted) can flip it back on.
   TL_SAFE_GPU=1 / --safe-gpu remain accepted but change nothing. */
if (IS_GPU_BOOST && !IS_SAFE_GPU) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}

/* UNCAP BY DEFAULT (TL_VSYNC=1 / --vsync restores the capped path).
   Without a frame-rate limiter rAF runs as fast as the GPU can draw and the
   swap chain still ties presentation to the monitor, so input latency drops
   and 60/120/144 Hz panels each get their native cadence. The old default
   (Chromium's limiter on) contributed the "33 fps at 2% GPU load" pacing.
   TL_UNCAP=1 / --uncapped remain accepted but change nothing. */
if (!IS_VSYNC && !IS_SAFE_GPU) {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

/* Single window handle + state used across handlers. */
let win = null;
let updateReady = null;   /* set when autoUpdater reports update-downloaded */
let urlWithParams = null; /* the exact URL we loaded */
let onOfflinePage = false; /* reload semantics change while the fallback is up */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !IS_SMOKE) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    /* Windows/Linux: a second launch may carry a tanklegends:// invite link. */
    const code = ((argv || []).map(roomFromDeepLink).find(Boolean)) || null;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (code) joinRoomNow(code);
  });
}

/* macOS hands protocol links through this event instead of argv. */
app.on('open-url', (e, url) => {
  e.preventDefault();
  const code = roomFromDeepLink(url);
  if (code) joinRoomNow(code);
});

/* --- process-wide tweaks --------------------------------------------------- */

app.setAppUserModelId(APP_ID);

/* Keep the machine from suspending while the game runs. This is what makes a
   desktop host noticeably steadier than a browser host: the OS will not park
   the CPU mid-match, and Chromium never throttles this renderer's timers. */
let psBlockerId = null;

/* --- permissions: the game needs mic (voice chat) and pointer lock --------- */
function installPermissionHandlers() {
  const ALLOW = new Set(['media', 'pointerLock', 'fullscreen', 'display-capture', 'clipboard-sanitized-write']);

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(ALLOW.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => ALLOW.has(permission));
}

/* --- window ---------------------------------------------------------------- */

function pageUrlForLoad() {
  /* Tag the request so the site can tell desktop traffic apart if it wants to.
     `?game=` style params the site already understands are left untouched. */
  try {
    const u = new URL(GAME_URL);
    if (!u.searchParams.has('from')) {
      u.searchParams.set('from', 'desktop');
      u.searchParams.set('av', app.getVersion());
    }
    if (deepRoom && !u.searchParams.has('room')) {
      u.searchParams.set('room', deepRoom);
      roomApplied = deepRoom;
    }
    return u.toString();
  } catch (e) {
    return GAME_URL;
  }
}

/* ============================================================================
   DEEP LINKS — tanklegends://join/CODE opens the app straight into a room.
   The game already auto-joins `?room=CODE` from its URL (menu.js), so the
   desktop app maps any tanklegends:// link onto that. An invite link posted
   in Discord therefore LAUNCHES THE DESKTOP APP instead of a browser tab —
   something a website can never offer.
   Accepted shapes:  tanklegends://join/CODE  tanklegends://room/CODE
                     tanklegends://?room=CODE  tanklegends://room?code=CODE
   -------------------------------------------------------------------------- */
const PROTO = 'tanklegends';
let deepRoom = null;    /* room parsed before the window existed */
let roomApplied = null; /* room already merged into the current URL */

function roomFromDeepLink(u) {
  try {
    if (!u || !u.toLowerCase().startsWith(PROTO + '://')) return null;
    let body = u.slice((PROTO + '://').length);
    let code = '';
    const qi = body.indexOf('?');
    if (qi !== -1) {
      const q = new URLSearchParams(body.slice(qi + 1));
      code = q.get('room') || q.get('code') || q.get('join') || '';
      body = body.slice(0, qi);
    }
    if (!code) {
      const m = body.replace(/^\/*/, '').match(/^(?:join|room)[/=]([A-Za-z0-9-]{4,10})$/);
      if (m) code = m[1];
    }
    code = String(code || '').toUpperCase();
    return /^[A-Z0-9-]{4,10}$/.test(code) ? code : null;
  } catch (e) { return null; }
}

function joinRoomNow(code) {
  if (!code) return;
  if (win && !win.isDestroyed()) {
    try {
      const u = new URL(pageUrlForLoad());
      u.searchParams.set('room', code);
      roomApplied = code;
      urlWithParams = u.toString();
      onOfflinePage = false;
      win.loadURL(urlWithParams);
    } catch (e) { /* fall through to the show/focus below */ }
  } else {
    deepRoom = code; /* window not up yet: pageUrlForLoad will pick it up */
  }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

if (IS_PACKAGED) {
  try { app.setAsDefaultProtocolClient(PROTO); } catch (e) { /* registry/plist may be read-only */ }
}

/* Cold start on Windows/Linux: the OS hands the link over as an argv entry. */
for (const a of process.argv) {
  const c = roomFromDeepLink(a);
  if (c) { deepRoom = c; break; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#0d0d0f',
    show: false,
    autoHideMenuBar: true,
    title: 'Tank Legends',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      /* THE host-stability switch: no rAF/timer throttling when the window is
         hidden or minimised. A browser tab gets its timers slowed to ~1/s in
         the background — fatal for a match host. This app never does that. */
      backgroundThrottling: false,
    },
  });

  /* Keep the version in the title even though the page sets its own. */
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    const v = 'Tank Legends v' + app.getVersion();
    win.setTitle(title && title !== 'Tank Legends' ? title + ' — ' + v : v);
  });

  win.once('ready-to-show', () => {
    if (!IS_SMOKE) win.show();
  });

  /* Offline / server hiccup: show a small local page with a Retry link
     instead of Chromium's cryptic error. */
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED, e.g. another load started */) return;
    if (IS_SMOKE) {
      console.log('[smoke] FAILED', code, desc, url);
      app.exit(1);
      return;
    }
    if (onOfflinePage) return; /* the fallback page itself failed: don't loop */
    onOfflinePage = true;
    win.loadFile(path.join(__dirname, 'offline.html'), { search: 'code=' + encodeURIComponent(String(code)) });
  });

  win.webContents.on('did-finish-load', () => {
    if (IS_SMOKE) {
      /* Only the real game URL counts as success — a finished load of the
         offline fallback means the site was NOT reachable. */
      const url = win.webContents.getURL();
      const ok = /^https?:/i.test(url) && url.indexOf('offline.html') === -1;
      console.log(ok ? '[smoke] OK ' + url : '[smoke] FAILED — landed on fallback: ' + url);
      app.exit(ok ? 0 : 1);
      return;
    }
    onOfflinePage = false;
  });

  /* Renderer crash recovery: a browser tab just dies with "Aw, Snap" and the
     player has to open a new one; the desktop app can simply reload. The
     game keeps progress in localStorage and reconnects to its matchmaker, so
     a reload is the correct recovery for every crash reason except
     clean-exit. Repeated crashes (>3/min) are NOT auto-reloaded — that is a
     real defect and the player gets told how to work around it. */
  let crashTimes = [];
  win.webContents.on('render-process-gone', (e, details) => {
    if (!details || details.reason === 'clean-exit') return;
    console.log('[render] gone:', details.reason, details.exitCode);
    if (IS_SMOKE) { app.exit(1); return; }
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 60000);
    crashTimes.push(now);
    if (crashTimes.length > 3) {
      dialog.showMessageBox(win, {
        type: 'error',
        title: 'Tank Legends',
        message: 'The game window keeps crashing.',
        detail: 'Please restart the app. If it happens again, try launching with software-safe GPU settings: set the environment variable TL_SAFE_GPU=1 before starting Tank Legends.',
        buttons: ['OK'],
        noLink: true,
      }).catch(() => {});
      return;
    }
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        onOfflinePage = false;
        win.loadURL(urlWithParams || GAME_URL);
      }
    }, 1500);
  });

  /* In-page links that try to open a new browser window: keep the player in
     the app when the target is the game itself or one of its own backend
     workers (invite links like https://tanklg.pages.dev/?... should
     re-navigate here, not spawn Edge), and hand genuinely external links to
     the system browser. */
  const IN_APP_ORIGINS = new Set([
    new URL(GAME_URL).origin,
    'https://tanklg.nojus-t.workers.dev',        /* matchmaker          */
    'https://clan-registry-api.nojus-t.workers.dev', /* clan API        */
  ]);
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (IN_APP_ORIGINS.has(new URL(url).origin)) {
        win.loadURL(url);
        return { action: 'deny' };
      }
      if (/^https?:/i.test(url)) {
        shell.openExternal(url);                 /* only real web links */
        return { action: 'deny' };
      }
    } catch (e) { /* malformed url: just deny */ }
    return { action: 'deny' };
  });

  /* Keyboard conveniences (there is no menu bar to provide them). */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    } else if (input.key === 'F5' || (input.control && !input.shift && !input.alt && input.key.toLowerCase() === 'r')) {
      /* While the offline page is up, "reload" means "retry the game". */
      if (onOfflinePage) { win.loadURL(urlWithParams); } else { win.webContents.reload(); }
      e.preventDefault();
    } else if (input.control && input.shift && !input.alt && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  urlWithParams = pageUrlForLoad();
  win.loadURL(urlWithParams);
}

/* --- updates --------------------------------------------------------------- */

function setupUpdates() {
  if (!IS_PACKAGED || IS_SMOKE) return;               /* dev runs: never     */
  if (process.env.TL_NO_UPDATE === '1') return;       /* opt-out escape hatch */

  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;                    /* download silently   */
  autoUpdater.autoInstallOnAppQuit = true;            /* apply on next quit  */
  autoUpdater.allowPrerelease = false;
  autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL });

  const send = (state, extra) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('tl:update-status', Object.assign({ state }, extra || {}));
    }
  };

  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (i) => send('available', { version: i && i.version }));
  autoUpdater.on('update-not-available', () => send('none'));
  autoUpdater.on('download-progress', (p) => send('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => {
    updateReady = i;
    send('downloaded', { version: i && i.version });
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Tank Legends — update ready',
      message: 'Version ' + (i && i.version ? i.version : 'new') + ' has been downloaded.',
      detail: 'Restart now to apply it, or keep playing — it installs automatically when you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    }).catch(() => {});
  });
  autoUpdater.on('error', (err) => {
    /* Offline, 404 before the first feed deploy, unsigned-install quirks —
       none of these should bother the player. Log and move on. */
    console.log('[update] skipped:', err && err.message ? err.message : err);
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(check, 30 * 1000);        /* shortly after launch   */
  setInterval(check, 4 * 60 * 60 * 1000); /* then every 4 hours */
}

/* --- ipc the page can use --------------------------------------------------- */

ipcMain.handle('tl:get-info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform,
  feed: FEED_URL,
}));

ipcMain.on('tl:install-update', () => {
  if (updateReady) {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall(false, true);
  }
});

/* --- lifecycle -------------------------------------------------------------- */

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  installPermissionHandlers();
  psBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  createWindow();

  if (IS_SMOKE) {
    /* The live site may be slow; give up loudly rather than hang forever. */
    setTimeout(() => {
      console.log('[smoke] TIMEOUT — site did not finish loading in 25s');
      app.exit(1);
    }, 25 * 1000);
  }

  setupUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  /* Desktop app convention: quit when the window is closed, on every OS. */
  app.quit();
});

app.on('before-quit', () => {
  if (psBlockerId !== null) {
    powerSaveBlocker.stop(psBlockerId);
    psBlockerId = null;
  }
});
