// Installing FarmSlicer as an app (the sidebar's "Install app").
//
// Chrome, Edge and Android fire `beforeinstallprompt` when the page can be
// installed (manifest.webmanifest + a service worker); keeping the event
// lets a button open the browser's install dialog later. iOS never fires
// it: there the only way is Share, then Add to Home Screen, so the sidebar
// says that instead. Nothing shows once FarmSlicer runs as an installed app.
// `installAppPrompt` is called once from main.tsx, before React renders,
// so an early event isn't missed.

import { useSyncExternalStore } from "react";

/** Chromium's install prompt event (not in the DOM typings). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallState {
  /** The browser's install dialog can be opened (`install`). */
  canPrompt: boolean;
  /** iOS/iPadOS, not installed: installing is Share → Add to Home Screen. */
  iosHint: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { canPrompt: false, iosHint: false };
const listeners = new Set<() => void>();

function set(next: InstallState) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Running as an installed app (home screen, app window). */
function standalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone, iPad (which says it is a Mac, but has touch) or iPod. */
function ios(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

/** Open the browser's install dialog. */
export async function install(): Promise<void> {
  const event = deferred;
  if (!event) return;
  // The event can only be used once, whatever the answer.
  deferred = null;
  set({ ...state, canPrompt: false });
  await event.prompt();
  await event.userChoice;
}

/** Start listening for the install prompt. Once, before React renders. */
export function installAppPrompt() {
  if (standalone()) return;
  if (ios()) set({ ...state, iosHint: true });
  window.addEventListener("beforeinstallprompt", (e) => {
    // Keep the browser's own mini-infobar from showing: the sidebar offers it.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    set({ ...state, canPrompt: true });
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    set({ canPrompt: false, iosHint: false });
  });
}
