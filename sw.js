/* Tank Legends service worker.
 *
 * Purpose: make the game INSTALLABLE on Android (Chrome's "Install app" /
 * "Add to Home screen" requires a page with a manifest + a service worker
 * that has a fetch handler).
 *
 * Deliberately does NOT cache anything: the game ships fresh builds on every
 * deploy and its files already carry ?v= stamps + no-cache headers. A cache
 * here would only ever serve stale bytes, so every request passes straight
 * through to the network (a no-op respondWith is skipped entirely, which is
 * the same as no interception but still satisfies the installability check).
 */
const SW_VERSION = 'tank-legends-sw-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  /* network passthrough - see comment above */
});
