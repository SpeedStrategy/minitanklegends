/* ============================================================================
   Tank Legends Desktop — preload.

   Exposes a tiny, safe bridge to the game/hub pages. Nothing Node-flavoured
   leaks: contextIsolation stays on, nodeIntegration stays off, and the page
   only ever sees this one object.

   The hub uses `window.TankLegendsDesktop` to notice it is being viewed inside
   the app (and hides its own download button — you are already running it).
   The game can call getInfo() to show the app version in a corner badge if it
   ever wants to, and onUpdateStatus() to toast "update ready".
   ========================================================================== */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('TankLegendsDesktop', {
  isDesktop: true,
  getInfo: () => ipcRenderer.invoke('tl:get-info'),
  /* cb({ state: 'checking'|'available'|'none'|'downloading'|'downloaded',
          version?, percent? }) */
  onUpdateStatus: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, status) => { try { cb(status); } catch (err) { /* page code must never break the app */ } };
    ipcRenderer.on('tl:update-status', handler);
    return () => ipcRenderer.removeListener('tl:update-status', handler);
  },
  restartToUpdate: () => ipcRenderer.send('tl:install-update'),
});
