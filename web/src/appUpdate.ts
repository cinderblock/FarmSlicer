// New builds, picked up without losing anyone's work.
//
// The server's /version.json names the build it serves. When it differs from
// this page's, an update is pending; the page reloads only when that loses
// nothing (`decide`):
//   - never while something holds it (`holdUpdate`: a browser slice running)
//     or a dialog is open (one marked `data-update-safe` doesn't count);
//   - when someone goes to another page (the one left goes away anyway);
//   - when the tab is hidden or nobody has touched it for IDLE_RELOAD_MS,
//     unless a form on the page has unsaved edits (an input or change event
//     outside a `[data-autosave]` region since the last navigation).
// Otherwise UpdateBanner offers "Reload now". Before reloading, the savers
// registered with `beforeUpdate` run (the Slice page saves its plate).
// Installed once from main.tsx; does nothing under `vite dev`.

import { useEffect, useSyncExternalStore } from "react";
import { BUILD_VERSION } from "./build";

/** How often the server is asked which build it serves. */
export const VERSION_POLL_MS = 30_000;
/** No input for this long (tab visible) counts as nobody being there. */
export const IDLE_RELOAD_MS = 2 * 60_000;
/** How often a pending update looks again at whether it may reload. */
const TICK_MS = 15_000;
/** The longest the savers may take before the reload goes ahead. */
const SAVE_TIMEOUT_MS = 5_000;
/** sessionStorage: the last reload was ours and nobody was watching. */
const QUIET_RELOAD_KEY = "farmslicer.quietReload";
/** sessionStorage: the build the last update reload was for. */
const RELOADED_FOR_KEY = "farmslicer.reloadedFor";

export interface Situation {
  /** A newer build is being served. */
  pending: boolean;
  /** Things that must finish first (browser slices). */
  holds: number;
  /** A dialog is open. */
  dialogOpen: boolean;
  /** A form on this page has edits the page doesn't save by itself. */
  dirty: boolean;
  /** The tab is in the background. */
  hidden: boolean;
  /** Since the last pointer, key, wheel or touch input. */
  idleMs: number;
  /** The person just moved to another page in the app. */
  navigated: boolean;
}

export type Decision = "reload" | "wait";

/** May the page reload for the update now? */
export function decide(s: Situation): Decision {
  if (!s.pending || s.holds > 0 || s.dialogOpen) return "wait";
  if (s.navigated) return "reload";
  if (s.dirty) return "wait";
  if (s.hidden || s.idleMs >= IDLE_RELOAD_MS) return "reload";
  return "wait";
}

let quietLoad: boolean | undefined;

/** Was this page loaded by an update reload nobody watched (hidden or idle)? */
export function reloadedQuietly(): boolean {
  if (quietLoad === undefined) {
    // Read once: a refresh by hand later is a load somebody watched.
    quietLoad = sessionStorage.getItem(QUIET_RELOAD_KEY) === "1";
    sessionStorage.removeItem(QUIET_RELOAD_KEY);
  }
  return quietLoad;
}

// --- State the banner shows -------------------------------------------------

export interface UpdateState {
  /** The build the server serves now, when it isn't this page's. */
  pending: string | null;
  /** Why it waits: what holds it. */
  holds: string[];
  /** Unsaved edits on this page. */
  dirty: boolean;
  /** Saving and reloading. */
  reloading: boolean;
}

let state: UpdateState = { pending: null, holds: [], dirty: false, reloading: false };
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, () => state);
}

// --- Holds and savers -------------------------------------------------------

const holds = new Map<number, string>();
let nextHold = 0;

/** Keep the page from reloading until the returned function is called. */
export function holdUpdate(reason: string): () => void {
  const id = nextHold++;
  holds.set(id, reason);
  set({ holds: [...holds.values()] });
  return () => {
    if (!holds.delete(id)) return;
    set({ holds: [...holds.values()] });
    // Whoever was watching a slice finish is still there: the idle clock
    // starts again rather than reloading under them.
    lastInput = Date.now();
    consider(false);
  };
}

/** Hold the update while `active`. */
export function useUpdateHold(active: boolean, reason: string) {
  useEffect(() => (active ? holdUpdate(reason) : undefined), [active, reason]);
}

const savers = new Set<() => Promise<void> | void>();

/** Run `save` before an update reload; returns the unregister function. */
export function beforeUpdate(save: () => Promise<void> | void): () => void {
  savers.add(save);
  return () => savers.delete(save);
}

/** Save what registered savers keep, then load the new build. */
export async function reloadNow(quiet = false) {
  if (state.reloading) return;
  set({ reloading: true });
  const saving = Promise.allSettled([...savers].map(async (save) => save()));
  await Promise.race([saving, new Promise((r) => setTimeout(r, SAVE_TIMEOUT_MS))]);
  if (quiet) sessionStorage.setItem(QUIET_RELOAD_KEY, "1");
  if (state.pending) sessionStorage.setItem(RELOADED_FOR_KEY, state.pending);
  window.location.reload();
}

// --- Watching ---------------------------------------------------------------

let lastInput = Date.now();
let installed = false;

function dialogOpen(): boolean {
  return document.querySelector(".modal-backdrop:not([data-update-safe])") !== null;
}

function situation(navigated: boolean): Situation {
  return {
    pending: state.pending !== null,
    holds: holds.size,
    dialogOpen: dialogOpen(),
    dirty: state.dirty,
    hidden: document.visibilityState === "hidden",
    idleMs: Date.now() - lastInput,
    navigated,
  };
}

function consider(navigated: boolean) {
  if (state.reloading) return;
  // Reloaded for this build once already and still not running it (a cache
  // or proxy serving the old page): reloading again would only loop, so the
  // banner is all that's left.
  if (state.pending && sessionStorage.getItem(RELOADED_FOR_KEY) === state.pending) return;
  const now = situation(navigated);
  if (decide(now) === "reload") void reloadNow(!navigated);
}

let lastLocation: string | undefined;

/**
 * Called by the layout with every page (path) it renders. Kept here, not in
 * the component: a layout that mounts again (the sign-in check refreshing)
 * must not take the next navigation for the first render.
 */
export function notifyLocation(path: string) {
  const first = lastLocation === undefined;
  if (path === lastLocation) return;
  lastLocation = path;
  if (first) return;
  if (state.dirty) set({ dirty: false });
  consider(true);
}

async function checkVersion() {
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return;
    const data: { version?: string } = await res.json();
    if (data.version && data.version !== BUILD_VERSION && data.version !== state.pending) {
      set({ pending: data.version });
      consider(false);
    }
  } catch {
    // The server is restarting or unreachable: ask again next time.
  }
}

function isField(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
  );
}

/** Start watching for new builds. Once, before React renders. */
export function installUpdateWatch() {
  if (installed || import.meta.env.DEV) return;
  installed = true;

  const touched = () => {
    lastInput = Date.now();
  };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"])
    window.addEventListener(type, touched, { capture: true, passive: true });

  const edited = (e: Event) => {
    if (!isField(e.target) || e.target.closest("[data-autosave]")) return;
    if (!state.dirty) set({ dirty: true });
  };
  document.addEventListener("input", edited, true);
  document.addEventListener("change", edited, true);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkVersion();
    else consider(false);
  });

  setInterval(() => void checkVersion(), VERSION_POLL_MS);
  setInterval(() => {
    if (state.pending) consider(false);
  }, TICK_MS);
}
