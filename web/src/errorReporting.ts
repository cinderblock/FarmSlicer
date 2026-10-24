// Automatic error reports, and the recent-console ring buffer that manual
// feedback attaches as diagnostics. Installed once, before React renders
// (main.tsx). Server side: src/feedback_api.rs (`POST /api/feedback/errors`).
//
// What is caught:
// - `window` errors (uncaught exceptions) and the app's own script/stylesheet
//   load failures (`resource`; images aren't reported: offline printers'
//   pictures fail all the time; nor are other origins' scripts, see
//   `resourceFailed`);
// - unhandled promise rejections (`promise`);
// - `console.error` (`console`). The wrapper calls the original console
//   method first, every time, with the original arguments: nothing printed
//   to the console is ever filtered or suppressed. `console.warn` is wrapped
//   the same way but only goes to the ring buffer;
// - React render errors (`react`, from components/ErrorBoundary.tsx, with
//   the component stack);
// - `/api` requests answering 5xx or failing on the network (`api`).
//   4xx answers are the app's normal flow (signed out, forbidden, not
//   found, conflict, quota) and aren't reported.
//
// Reports are deduplicated here (same source, message and first stack line
// = one report with a count), batched, and sent at most every few seconds;
// a report seen again within a minute of being sent waits and goes out with
// its count. While nobody is signed in (or before that is known) they wait in
// localStorage and go out after sign-in: there is no anonymous endpoint.
// The reporter never reports itself: it sends with the unwrapped `fetch`,
// `/api/feedback` requests are never reported, and errors raised while it
// is capturing are ignored.

import { BUILD_VERSION } from "./build";

/** The web app's build (its commit): what reports carry as their version. */
export { BUILD_VERSION };

export type Source = "window" | "promise" | "console" | "react" | "api" | "resource";

/** One line of the ring buffer. */
export interface ConsoleEntry {
  /** ISO time. */
  t: string;
  level: "error" | "warn" | "uncaught" | "rejection" | "resource" | "api" | "react";
  text: string;
}

interface Report {
  source: Source;
  message: string;
  stack?: string;
  url: string;
  version: string;
  count: number;
  context?: Record<string, unknown>;
  /** Client-side dedupe key (not sent). */
  key: string;
  /** When it was first caught (ms; not sent). */
  at: number;
}

const RING_SIZE = 50;
const RING_TEXT = 500;
/** The server's `MAX_BATCH`. */
const BATCH_MAX = 20;
const FLUSH_DELAY_MS = 2_000;
/** A report sent recently waits this long before its repeats go out. */
const REPEAT_HOLD_MS = 60_000;
/** Distinct reports one page load sends at most (a loop of unique messages). */
const MAX_KEYS = 200;
const MESSAGE_MAX = 1_000;
const STACK_MAX = 8_000;
/** `fetch(..., {keepalive})` bodies are limited to 64 KiB in total. */
const KEEPALIVE_BYTES = 60_000;
const OUTBOX_KEY = "farmslicer.pendingErrors";
const OUTBOX_MAX = 50;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 3600_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const BREADCRUMBS = 10;

const ring: ConsoleEntry[] = [];
/** Unsent reports, oldest first, and the same by key. */
let queue: Report[] = [];
const byKey = new Map<string, Report>();
/** Error objects already reported, so the same error caught twice (React
 *  logs what a boundary caught; a rethrow reaches `window`) is one report. */
const byError = new WeakMap<object, Report>();
const lastSent = new Map<string, number>();
const keysSeen = new Set<string>();

let installed = false;
/** null = not known yet (the auth status request is in flight). */
let signedIn: boolean | null = null;
let capturing = false;
let unloading = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
/** When `flushTimer` fires (ms). */
let flushAt = 0;
let outboxTimer: ReturnType<typeof setTimeout> | undefined;
let backoffMs = 0;
let backoffUntil = 0;
let sending = false;
let rawFetch: typeof fetch = (...args) => fetch(...args);

// ---- describing values -----------------------------------------------------------------

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isErrorLike(v: unknown): v is Error {
  return v instanceof Error || (typeof v === "object" && v !== null && "message" in v && "stack" in v);
}

/** A short, safe rendering of any value (bounded depth and length; never
 *  throws, never walks a whole three.js scene). */
function preview(v: unknown, depth = 0): string {
  try {
    if (v === null) return "null";
    switch (typeof v) {
      case "string":
        return depth > 0 ? JSON.stringify(cut(v, 200)) : cut(v, RING_TEXT);
      case "number":
      case "boolean":
      case "bigint":
      case "undefined":
      case "symbol":
        return String(v);
      case "function":
        return `[function ${v.name || "anonymous"}]`;
    }
    if (isErrorLike(v)) return `${v.name ?? "Error"}: ${v.message}`;
    if (typeof Element !== "undefined" && v instanceof Element) return `<${v.tagName.toLowerCase()}>`;
    if (typeof Event !== "undefined" && v instanceof Event) return `[${v.type} event]`;
    if (Array.isArray(v)) {
      if (depth >= 2) return `[Array(${v.length})]`;
      const items = v.slice(0, 10).map((x) => preview(x, depth + 1));
      return `[${items.join(", ")}${v.length > 10 ? ", …" : ""}]`;
    }
    const name = (v as object).constructor?.name;
    const prefix = name && name !== "Object" ? `${name} ` : "";
    if (depth >= 2) return `${prefix}{…}`;
    const keys = Object.keys(v as object);
    const items = keys.slice(0, 10).map((k) => `${k}: ${preview((v as Record<string, unknown>)[k], depth + 1)}`);
    return `${prefix}{${items.join(", ")}${keys.length > 10 ? ", …" : ""}}`;
  } catch {
    return "[unprintable]";
  }
}

/** Console arguments as one line, with printf-style substitutions applied
 *  (React and others log `"%s failed", name`). */
function formatArgs(args: unknown[]): string {
  const rest = [...args];
  let head = "";
  if (typeof rest[0] === "string" && /%[sdifoOc]/.test(rest[0])) {
    const format = rest.shift() as string;
    head = format.replace(/%([sdifoOc%])/g, (match, spec: string) => {
      if (spec === "%") return "%";
      if (rest.length === 0) return match;
      const arg = rest.shift();
      if (spec === "c") return "";
      if (spec === "d" || spec === "i") return String(Math.trunc(Number(arg)));
      if (spec === "f") return String(Number(arg));
      return preview(arg, spec === "s" ? 0 : 1);
    });
  }
  const parts = rest.map((a) => preview(a));
  return cut([head, ...parts].filter((p) => p !== "").join(" "), MESSAGE_MAX);
}

function firstFrame(stack: string | undefined): string {
  if (!stack) return "";
  return stack.split("\n").find((l) => /^\s*at\s|@/.test(l))?.trim() ?? "";
}

/** The stack of the code that called `fn` (the wrapper itself left out). */
function callerStack(fn: (...args: never[]) => unknown): string | undefined {
  const holder: { stack?: string } = {};
  const captureStackTrace = (Error as unknown as { captureStackTrace?: (o: object, f: unknown) => void })
    .captureStackTrace;
  if (captureStackTrace) {
    captureStackTrace(holder, fn);
    return holder.stack?.replace(/^Error\n/, "");
  }
  // Without captureStackTrace: drop the header line and this frame.
  const lines = (new Error().stack ?? "").split("\n");
  if (lines[0] && !/^\s*at\s|@/.test(lines[0])) lines.shift();
  return lines.slice(2).join("\n") || undefined;
}

// ---- the ring buffer ----------------------------------------------------------------------

function remember(level: ConsoleEntry["level"], text: string) {
  ring.push({ t: new Date().toISOString(), level, text: cut(text, RING_TEXT) });
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

/** The last console messages and caught errors, oldest first. */
export function recentConsole(): ConsoleEntry[] {
  return ring.map((e) => ({ ...e }));
}

/** What manual feedback attaches when the reporter allows diagnostics. */
export function diagnostics(): Record<string, unknown> {
  return {
    url: location.href,
    version: BUILD_VERSION,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    device_pixel_ratio: window.devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    language: navigator.language,
    online: navigator.onLine,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    time: new Date().toISOString(),
    console: recentConsole(),
  };
}

// ---- capturing ------------------------------------------------------------------------------

/** How much more specific one source is than another, for an error object
 *  caught twice. */
const SPECIFICITY: Record<Source, number> = { console: 0, promise: 1, window: 1, resource: 1, api: 1, react: 2 };

function capture(
  source: Source,
  message: string,
  stack: string | undefined,
  extra: { error?: unknown; context?: Record<string, unknown> } = {},
) {
  if (capturing) return;
  capturing = true;
  try {
    const err = typeof extra.error === "object" && extra.error !== null ? extra.error : undefined;
    const known = err ? byError.get(err) : undefined;
    if (known) {
      // Already queued under a less specific source: say where it really
      // came from (and keep what the new source knows).
      if (SPECIFICITY[source] > SPECIFICITY[known.source] && queue.includes(known)) {
        byKey.delete(known.key);
        known.source = source;
        known.key = `${source}|${known.message}|${firstFrame(known.stack)}`;
        known.context = { ...known.context, ...extra.context };
        const twin = byKey.get(known.key);
        if (twin && twin !== known) {
          twin.count += known.count;
          queue = queue.filter((r) => r !== known);
          byError.set(err!, twin);
        } else {
          byKey.set(known.key, known);
        }
      }
      return;
    }
    const msg = cut(message.trim() || "(no message)", MESSAGE_MAX);
    const key = `${source}|${msg}|${firstFrame(stack)}`;
    const queued = byKey.get(key);
    if (queued) {
      queued.count += 1;
      if (err) byError.set(err, queued);
      scheduleFlush();
      return;
    }
    if (!keysSeen.has(key)) {
      if (keysSeen.size >= MAX_KEYS) return;
      keysSeen.add(key);
    }
    const report: Report = {
      source,
      message: msg,
      stack: stack ? cut(stack, STACK_MAX) : undefined,
      url: location.pathname + location.search,
      version: BUILD_VERSION,
      count: 1,
      context: {
        ...extra.context,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        breadcrumbs: ring.slice(-BREADCRUMBS),
      },
      key,
      at: Date.now(),
    };
    queue.push(report);
    byKey.set(key, report);
    if (err) byError.set(err, report);
    scheduleFlush();
  } catch {
    // The reporter must never be the problem.
  } finally {
    capturing = false;
  }
}

/** Report an error caught by the app itself (an error boundary). */
export function reportError(error: unknown, source: Source, context?: Record<string, unknown>) {
  const message = isErrorLike(error) ? `${error.name ?? "Error"}: ${error.message}` : preview(error);
  remember(source === "react" ? "react" : "uncaught", message);
  capture(source, message, isErrorLike(error) ? error.stack : undefined, { error, context });
}

function onWindowError(ev: Event) {
  if (ev instanceof ErrorEvent) {
    const err: unknown = ev.error;
    const message = isErrorLike(err) ? `${err.name ?? "Error"}: ${err.message}` : ev.message || "Script error.";
    const where = ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : "";
    remember("uncaught", message);
    capture("window", message, isErrorLike(err) ? err.stack : where ? `    at ${where}` : undefined, { error: err });
    return;
  }
  // Resource load failures don't bubble: this listener is on the capture phase.
  const target = ev.target;
  if (target instanceof HTMLScriptElement && target.src) {
    resourceFailed("script", target.src);
  } else if (target instanceof HTMLLinkElement && target.rel === "stylesheet" && target.href) {
    resourceFailed("stylesheet", target.href);
  }
}

// The app loads only its own scripts and stylesheets. A cross-origin one was
// put on the page by something else (a CDN's analytics beacon, an extension)
// and is usually stopped by our Cross-Origin-Embedder-Policy: kept in the
// ring buffer for manual feedback, not reported.
function resourceFailed(kind: "script" | "stylesheet", src: string) {
  remember("resource", `${kind} failed to load: ${src}`);
  const url = new URL(src, location.href);
  if (url.origin !== location.origin) return;
  capture("resource", `${kind} failed to load: ${url.pathname}`, undefined);
}

function onRejection(ev: PromiseRejectionEvent) {
  const reason: unknown = ev.reason;
  const message = isErrorLike(reason) ? `${reason.name ?? "Error"}: ${reason.message}` : `unhandled rejection: ${preview(reason)}`;
  remember("rejection", message);
  capture("promise", message, isErrorLike(reason) ? reason.stack : undefined, { error: reason });
}

function wrapConsole(level: "error" | "warn") {
  const original = console[level];
  const wrapper = function (this: Console, ...args: unknown[]) {
    // The original first, always, with exactly what it was given.
    original.apply(this, args);
    if (capturing) return;
    try {
      const text = formatArgs(args);
      remember(level, text);
      if (level !== "error") return;
      const err = args.find(isErrorLike);
      capture("console", text, err ? err.stack : callerStack(wrapper), { error: err });
    } catch {
      // Never let reporting break logging.
    }
  };
  console[level] = wrapper;
}

function requestInfo(input: RequestInfo | URL, init?: RequestInit): { method: string; url: URL } | null {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    return { method, url };
  } catch {
    return null;
  }
}

function reportable(url: URL): boolean {
  return url.origin === location.origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/feedback");
}

function wrapFetch() {
  const original = window.fetch.bind(window);
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const info = requestInfo(input, init);
    let res: Response;
    try {
      res = await original(input, init);
    } catch (e) {
      const aborted = (e instanceof DOMException && e.name === "AbortError") || init?.signal?.aborted;
      if (info && reportable(info.url) && !aborted && !unloading && navigator.onLine !== false) {
        const text = `${info.method} ${info.url.pathname} failed: ${isErrorLike(e) ? e.message : String(e)}`;
        remember("api", text);
        capture("api", text, undefined);
      }
      throw e;
    }
    if (res.status >= 500 && info && reportable(info.url)) {
      const head = `${info.method} ${info.url.pathname} → ${res.status}`;
      // The server's {error} explains most 5xx; read a copy, never the caller's body.
      res
        .clone()
        .text()
        .catch(() => "")
        .then((body) => {
          let detail = body;
          try {
            const parsed: unknown = JSON.parse(body);
            if (parsed && typeof parsed === "object" && "error" in parsed) detail = String(parsed.error);
          } catch {
            // Not JSON: the text itself (a proxy's error page, trimmed).
          }
          const text = detail.trim() ? `${head}: ${cut(detail.trim(), 300)}` : head;
          remember("api", text);
          capture("api", text, undefined);
        });
    }
    return res;
  };
  return original;
}

// ---- sending ----------------------------------------------------------------------------------

function wire(r: Report) {
  return { source: r.source, message: r.message, stack: r.stack, url: r.url, version: r.version, count: r.count, context: r.context };
}

function scheduleFlush(delay = FLUSH_DELAY_MS) {
  if (signedIn !== true) {
    scheduleOutbox();
    return;
  }
  const at = Date.now() + Math.max(delay, backoffUntil - Date.now(), 0);
  // Debounce: a timer that fires sooner stands; a later one (a held
  // repeat) gives way to a new report.
  if (flushTimer !== undefined && flushAt <= at) return;
  clearTimeout(flushTimer);
  flushAt = at;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flush(false);
  }, at - Date.now());
}

/** Reports due now: everything when the page is going away, otherwise all
 *  but repeats of something sent within `REPEAT_HOLD_MS`. */
function due(all: boolean): { batch: Report[]; nextDue: number | null } {
  const now = Date.now();
  const batch: Report[] = [];
  let nextDue: number | null = null;
  let bytes = 0;
  for (const r of queue) {
    if (batch.length >= BATCH_MAX) break;
    const held = (lastSent.get(r.key) ?? -Infinity) + REPEAT_HOLD_MS;
    if (!all && held > now) {
      nextDue = nextDue === null ? held : Math.min(nextDue, held);
      continue;
    }
    const size = JSON.stringify(wire(r)).length;
    if (all && bytes + size > KEEPALIVE_BYTES) break;
    bytes += size;
    batch.push(r);
  }
  return { batch, nextDue };
}

function forget(sent: Report[]) {
  const now = Date.now();
  queue = queue.filter((r) => !sent.includes(r));
  for (const r of sent) {
    if (byKey.get(r.key) === r) byKey.delete(r.key);
    lastSent.set(r.key, now);
  }
}

async function flush(pageHide: boolean) {
  if (signedIn !== true || sending) return;
  if (!pageHide && Date.now() < backoffUntil) {
    scheduleFlush();
    return;
  }
  const { batch, nextDue } = due(pageHide);
  if (batch.length === 0) {
    if (nextDue !== null) scheduleFlush(nextDue - Date.now());
    return;
  }
  // Sent or not, these leave the queue now; failures put them back.
  forget(batch);
  sending = true;
  // 0: the request itself failed (network, server down).
  const status = await rawFetch("/api/feedback/errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reports: batch.map(wire) }),
    keepalive: pageHide,
    credentials: "same-origin",
  }).then(
    (res) => res.status,
    () => 0,
  );
  sending = false;
  if (status >= 200 && status < 300) {
    backoffMs = 0;
    backoffUntil = 0;
  } else if (status === 401 || status === 403) {
    // Signed out (or not allowed from here): keep them for later.
    signedIn = false;
    requeue(batch);
    saveOutbox();
    return;
  } else if (status === 400 || status === 413) {
    // The server won't take these as they are; resending would loop.
  } else {
    // Rate-limited, server down, network gone: back off and retry.
    requeue(batch);
    backoffMs = status === 429 ? 60_000 : Math.min(Math.max(backoffMs * 2, BACKOFF_MIN_MS), BACKOFF_MAX_MS);
    backoffUntil = Date.now() + backoffMs;
  }
  if (queue.length > 0 && !pageHide) scheduleFlush();
}

function requeue(reports: Report[]) {
  for (const r of reports) {
    lastSent.delete(r.key);
    const twin = byKey.get(r.key);
    if (twin) {
      twin.count += r.count;
    } else {
      queue.push(r);
      byKey.set(r.key, r);
    }
  }
  if (queue.length > OUTBOX_MAX) {
    for (const dropped of queue.splice(0, queue.length - OUTBOX_MAX)) byKey.delete(dropped.key);
  }
}

// ---- the outbox (localStorage, while signed out) -------------------------------------------------

function readOutbox(): Report[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - OUTBOX_MAX_AGE_MS;
    return parsed.filter(
      (r): r is Report =>
        r && typeof r === "object" && typeof r.key === "string" && typeof r.message === "string" && r.at > cutoff,
    );
  } catch {
    return [];
  }
}

function writeOutbox(reports: Report[]) {
  try {
    if (reports.length === 0) localStorage.removeItem(OUTBOX_KEY);
    else localStorage.setItem(OUTBOX_KEY, JSON.stringify(reports.slice(-OUTBOX_MAX)));
  } catch {
    // Storage full or disabled: these reports are lost, nothing else breaks.
  }
}

function scheduleOutbox() {
  if (outboxTimer !== undefined) return;
  outboxTimer = setTimeout(() => {
    outboxTimer = undefined;
    if (signedIn !== true) saveOutbox();
  }, 1_000);
}

/** Move the queue into localStorage, merged with what other tabs left. */
function saveOutbox() {
  if (queue.length === 0) return;
  const stored = readOutbox();
  for (const r of queue) {
    const twin = stored.find((s) => s.key === r.key);
    if (twin) twin.count += r.count;
    else stored.push(r);
  }
  writeOutbox(stored);
  queue = [];
  byKey.clear();
}

/** Take what waited in localStorage (this tab sends it now). */
function claimOutbox() {
  const stored = readOutbox();
  if (stored.length === 0) return;
  writeOutbox([]);
  requeue(stored);
}

// ---- lifecycle ----------------------------------------------------------------------------------

/** Tell the reporter whether someone is signed in (auth status). Signing in
 *  sends what waited. */
export function setSignedIn(value: boolean) {
  if (signedIn === value) return;
  signedIn = value;
  if (value) {
    claimOutbox();
    if (queue.length > 0) scheduleFlush(0);
  } else {
    saveOutbox();
  }
}

function onPageHide() {
  unloading = true;
  if (signedIn === true && Date.now() >= backoffUntil) void flush(true);
  // Whatever is left (or everything, signed out) waits for the next visit.
  if (queue.length > 0) saveOutbox();
}

/** Install once, before the app renders. */
export function installErrorReporting() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  wrapConsole("error");
  wrapConsole("warn");
  rawFetch = wrapFetch();
  window.addEventListener("error", onWindowError, true);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", () => {
    unloading = false;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && signedIn === true) void flush(true);
  });
}
