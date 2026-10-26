// Push notifications on this device (src/notifications.rs sends them,
// web/public/sw.js shows them). Turning them on asks the browser's
// permission, subscribes the service worker with the server's key and
// hands the subscription to the server; signing out forgets this device.

import { serviceWorkerReady } from "./serviceWorker";

/** `GET /api/me/notifications`. */
export interface NotificationSettings {
  /** The server's public key (base64url), for `applicationServerKey`. */
  key: string;
  events: { event: string; label: string }[];
  relations: { relation: string; label: string }[];
  /** Per event, the relations that notify. */
  prefs: Record<string, string[]>;
  subscriptions: Device[];
}

export interface Device {
  id: string;
  endpoint: string;
  label: string;
  created_at: string;
  last_success_at: string | null;
  last_error: string | null;
}

/**
 * What this device can do: `ok`; `install` (iPhone/iPad Safari: only an app
 * on the home screen gets pushes); `insecure` (not https); `unsupported`.
 */
export type Support = "ok" | "install" | "insecure" | "unsupported";

function standalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function iOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function support(): Support {
  if (!window.isSecureContext) return "insecure";
  if (iOS() && !standalone()) return "install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ok";
}

/** The browser's permission: granted, denied, or default (not asked yet). */
export function permission(): NotificationPermission {
  return "Notification" in window ? Notification.permission : "denied";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

/** This device's subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (support() !== "ok") return null;
  const registration = await serviceWorkerReady();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

const DEVICE_KEY = "farmslicer.pushDevice";

/**
 * Turn notifications on for this device (from a click: iOS only asks then).
 * Returns the server's id for it.
 */
export async function turnOn(serverKey: string): Promise<string> {
  if (support() !== "ok") throw new Error("This browser can't receive notifications here.");
  const granted = await Notification.requestPermission();
  if (granted !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings.");
  const registration = await serviceWorkerReady();
  if (!registration) throw new Error("The service worker didn't start; reload the page and try again.");
  const key = keyBytes(serverKey);
  let subscription = await registration.pushManager.getSubscription();
  // Subscribed with another server key (the server's key changed): start over.
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const res = await fetch("/api/me/notifications/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (!res.ok || !body?.id) throw new Error(body?.error ?? `HTTP ${res.status}`);
  localStorage.setItem(DEVICE_KEY, body.id);
  return body.id;
}

/** Turn them off for this device: unsubscribe here, and tell the server. */
export async function turnOff(): Promise<void> {
  const id = localStorage.getItem(DEVICE_KEY);
  localStorage.removeItem(DEVICE_KEY);
  if (id) await fetch(`/api/me/notifications/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  const subscription = await currentSubscription().catch(() => null);
  await subscription?.unsubscribe().catch(() => false);
}

/**
 * Before signing out: this device stops getting the account's
 * notifications (the next person to sign in here turns them on for theirs).
 */
export async function forgetDevice(): Promise<void> {
  if (!localStorage.getItem(DEVICE_KEY)) return;
  await turnOff();
}
