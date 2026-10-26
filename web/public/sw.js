// FarmSlicer's service worker (registered by web/src/serviceWorker.ts).
//
// It is here so FarmSlicer can be installed as an app and receive push
// notifications (src/notifications.rs sends them). It deliberately caches nothing and has no fetch
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
// A push carries `{title, body, url, tag}` (src/notifications.rs `Message`).
// Same tag = the newer notification replaces the older (one per print).

self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || "FarmSlicer", {
      body: msg.body || "",
      tag: msg.tag,
      renotify: Boolean(msg.tag),
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      data: { url: msg.url || "/" },
    }),
  );
});

// A tap opens the page it's about: in a FarmSlicer window already open if
// there is one (the app routes there itself, web/src/serviceWorker.ts, so
// nothing reloads under a slice in progress), else a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window" });
      const open = windows.find((w) => w.focused) || windows[0];
      if (open) {
        await open.focus();
        open.postMessage({ type: "farmslicer.open", path: url.pathname + url.search + url.hash });
        return;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});

// The browser replaced the subscription (keys rotated, or it expired): tell
// the server about the new one so pushes keep arriving.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const options = event.oldSubscription?.options;
      const subscription =
        event.newSubscription ||
        (options ? await self.registration.pushManager.subscribe(options).catch(() => null) : null);
      if (!subscription) return;
      await fetch("/api/me/notifications/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
        credentials: "same-origin",
      }).catch(() => {});
    })(),
  );
});
