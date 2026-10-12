// Main-thread client for the in-browser slicing engine.
//
//   const engine = await BrowserEngine.create();     // picks mt or st
//   const out = await engine.slice(file, configJson, (pct, msg) => ...);
//   engine.dispose();
//
// Engine files are served from /wasm/ (built by wasm/build.sh, copied into
// web/public/wasm/). The multithreaded variant needs cross-origin isolation
// (the server sends COOP/COEP) and SharedArrayBuffer; otherwise the
// single-threaded variant is used.

import type {
  EngineManifest,
  EngineVariant,
  SliceOutput,
  WorkerRequest,
  WorkerResponse,
} from "./types";

export type ProgressFn = (percent: number, message: string) => void;

export interface EngineInfo {
  manifest: EngineManifest;
  variant: EngineVariant;
  /** Hardware threads the engine will use (1 for the single-threaded build). */
  threads: number;
}

const BASE_URL = "/wasm/";

let manifestPromise: Promise<EngineManifest | null> | null = null;

/** The engine manifest, or null when no engine has been built/deployed. */
export function loadManifest(): Promise<EngineManifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetch(`${BASE_URL}manifest.json`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<EngineManifest>) : null))
      .catch(() => null);
  }
  return manifestPromise;
}

export function browserSupportsEngine(): boolean {
  return typeof WebAssembly === "object" && typeof Worker === "function";
}

export function canRunThreaded(): boolean {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    typeof crossOriginIsolated !== "undefined" &&
    crossOriginIsolated
  );
}

/** Which variant would be used, given the manifest and this browser. */
export function pickVariant(manifest: EngineManifest): EngineVariant | null {
  if (manifest.variants.mt && canRunThreaded()) return "mt";
  if (manifest.variants.st) return "st";
  if (manifest.variants.mt) return "mt"; // will fail to init without isolation; caller reports it
  return null;
}

export class BrowserEngine {
  private worker: Worker;
  private nextId = 1;
  private pending: {
    id: number;
    onProgress?: ProgressFn;
    resolve: (out: SliceOutput) => void;
    reject: (err: Error) => void;
  } | null = null;

  readonly info: EngineInfo;

  private constructor(worker: Worker, info: EngineInfo) {
    this.worker = worker;
    this.info = info;
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handle(ev.data);
    worker.onerror = (ev) => {
      this.pending?.reject(new Error(`engine worker error: ${ev.message}`));
      this.pending = null;
    };
  }

  /** Load the engine in a worker. Rejects if no engine is deployed or the browser can't run it. */
  static async create(): Promise<BrowserEngine> {
    if (!browserSupportsEngine()) throw new Error("this browser cannot run the slicing engine");
    const manifest = await loadManifest();
    if (!manifest) throw new Error("no browser engine is deployed on this server");
    const variant = pickVariant(manifest);
    if (!variant) throw new Error("engine manifest lists no usable variant");
    if (variant === "mt" && !canRunThreaded())
      throw new Error("multithreaded engine needs cross-origin isolation (SharedArrayBuffer)");

    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const ready = new Promise<{ threadCount: number }>((resolve, reject) => {
      const onMsg = (ev: MessageEvent<WorkerResponse>) => {
        if (ev.data.type === "ready") {
          worker.removeEventListener("message", onMsg);
          resolve({ threadCount: ev.data.threadCount });
        } else if (ev.data.type === "init-error") {
          worker.removeEventListener("message", onMsg);
          reject(new Error(ev.data.error));
        }
      };
      worker.addEventListener("message", onMsg);
      worker.addEventListener("error", (ev) => reject(new Error(ev.message)), { once: true });
    });
    const req: WorkerRequest = { type: "init", variant, baseUrl: BASE_URL };
    worker.postMessage(req);
    const { threadCount } = await ready;
    return new BrowserEngine(worker, { manifest, variant, threads: threadCount });
  }

  private handle(msg: WorkerResponse) {
    const p = this.pending;
    if (!p) return;
    switch (msg.type) {
      case "progress":
        if (msg.id === p.id) p.onProgress?.(msg.percent, msg.message);
        break;
      case "done":
        if (msg.id === p.id) {
          this.pending = null;
          p.resolve({ gcode: new Uint8Array(msg.gcode), report: msg.report, elapsedMs: msg.elapsedMs });
        }
        break;
      case "error":
        if (msg.id === p.id) {
          this.pending = null;
          const err = new Error(msg.error) as Error & { report?: WorkerResponse & { type: "error" } };
          err.report = msg;
          p.reject(err);
        }
        break;
      default:
        break;
    }
  }

  /** Slice one model file with a merged OrcaSlicer config (JSON object). One slice at a time. */
  async slice(file: File, configJson: string, onProgress?: ProgressFn): Promise<SliceOutput> {
    if (this.pending) throw new Error("engine is busy");
    const model = await file.arrayBuffer();
    const id = this.nextId++;
    return new Promise<SliceOutput>((resolve, reject) => {
      this.pending = { id, onProgress, resolve, reject };
      const req: WorkerRequest = { type: "slice", id, modelName: file.name, model, config: configJson };
      this.worker.postMessage(req, [model]);
    });
  }

  /** Ask the running slice to stop; the pending promise rejects with "cancelled". */
  cancel() {
    const req: WorkerRequest = { type: "cancel" };
    this.worker.postMessage(req);
  }

  /** Terminate the worker (and, for the threaded engine, its pthread pool). */
  dispose() {
    this.worker.terminate();
    this.pending?.reject(new Error("engine disposed"));
    this.pending = null;
  }
}
