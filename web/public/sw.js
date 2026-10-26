// FarmSlicer's service worker (registered by web/src/serviceWorker.ts).
//
// It is here so FarmSlicer can be installed as an app and, later, receive
// push notifications. It deliberately caches nothing and has no fetch
// handler: every page and bundle comes from the network, as without it.
// web/src/appUpdate.ts rolls out new builds by reloading the page when it
// is safe to, and that only works if index.html (which names the build's
// hashed bundles) is fetched fresh each time. Don't add a fetch handler
// or a cache without reworking that.
//
// Plain JavaScript, served as-is from the site root (web/public is copied,
// not bundled), so its scope is the whole app. The server sends it with
// `Cache-Control: no-cache`, so a new version is picked up on the next
// update check.

// A new version takes over at once instead of waiting for every tab to
// close: it keeps no state that an old page could depend on.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// --- Push notifications -------------------------------------------------------
// The `push` and `notificationclick` handlers go here.
