// The service worker (web/public/sw.js): what makes FarmSlicer installable
// as an app, and what push notifications arrive through. It caches nothing
// and doesn't intercept requests (see sw.js for why).
//
// Registered once from main.tsx, where the browser has service workers at
// all and the page is a secure context (https, or localhost): elsewhere
// every function here resolves to null.

let registering: Promise<ServiceWorkerRegistration | null> | undefined;

/** Register /sw.js for the whole app. Once; later calls return the same promise. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (registering) return registering;
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    registering = Promise.resolve(null);
    return registering;
  }
  registering = navigator.serviceWorker
    // updateViaCache "none": update checks never take sw.js from the HTTP cache.
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .catch((err: unknown) => {
      console.warn("Service worker registration failed: the app can't be installed or get notifications", err);
      return null;
    });
  return registering;
}

/**
 * The registration once its worker is active (what `pushManager.subscribe`
 * needs), or null where there is no service worker (unsupported, not a
 * secure context, registration failed).
 */
export async function serviceWorkerReady(): Promise<ServiceWorkerRegistration | null> {
  const registration = await registerServiceWorker();
  if (!registration) return null;
  return navigator.serviceWorker.ready;
}

/**
 * Ask the browser to look for a new sw.js now. appUpdate.ts calls it when a
 * new build is served, so a tab that stays open (and so doesn't reload for
 * a while) still gets the new worker. A new worker takes over by itself
 * (sw.js: skipWaiting + clients.claim).
 */
export async function updateServiceWorker(): Promise<void> {
  const registration = await registering;
  if (!registration) return;
  try {
    await registration.update();
  } catch {
    // Offline or the server is restarting: the next navigation checks again.
  }
}

/**
 * Call `open(path)` when the service worker asks this window to show a
 * page (a tapped notification, sw.js): the app routes there itself rather
 * than the page reloading. Returns the unsubscribe.
 */
export function onOpenRequest(open: (path: string) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const listener = (e: MessageEvent) => {
    const data = e.data as { type?: string; path?: unknown } | null;
    if (data?.type === "farmslicer.open" && typeof data.path === "string" && data.path.startsWith("/")) open(data.path);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
