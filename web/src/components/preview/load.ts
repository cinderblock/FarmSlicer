// Main-thread side of the G-code parser: one worker per file, progress
// callbacks, cancellation by AbortSignal (the worker is terminated), and a
// memory of the last files parsed (by a key the caller gives), so going back
// to one shows it at once.
//
//   const { result } = await loadGcode({ url: `/api/jobs/${id}/gcode` }, { onProgress });
//   const { result } = await loadGcode({ data: gcodeBytes }); // a slice in memory
//   const { result, bytes } = await loadGcode({ url }, { cacheKey: "job:1", keep: true });

import type { ParseRequest, ParseResponse, ParsedGcode } from "./types";

/** Where the G-code comes from: the server, or bytes/text the page already holds. */
export type GcodeSource = { url: string } | { data: Blob | ArrayBuffer | ArrayBufferView | string };

export interface LoadProgress {
  /** Bytes parsed. */
  done: number;
  /** Bytes in the file, when known. */
  total: number | null;
}

export interface Loaded {
  result: ParsedGcode;
  /** Download and parse, ms (0 from memory). */
  ms: number;
  /** A URL's bytes, when `keep` asked for them (not from memory). */
  bytes?: Blob;
}

export interface LoadOptions {
  onProgress?: (p: LoadProgress) => void;
  signal?: AbortSignal;
  /** Remember the parsed file under this key, and look for it there first. */
  cacheKey?: string;
  /** For a URL: hand back the bytes read, as a Blob. */
  keep?: boolean;
}

// ---- parsed files kept in memory --------------------------------------------------------

/**
 * Parsed files kept, by bytes of typed arrays: the two most recent always
 * (the two sides of a comparison), older ones while they fit.
 */
const MEMORY_BUDGET = 640 * 1024 ** 2;
const memory = new Map<string, { parsed: ParsedGcode; bytes: number }>();

function parsedBytes(p: ParsedGcode): number {
  let n = 0;
  for (const group of [p.layers, p.extrusions, p.travels, p.retractions])
    for (const v of Object.values(group)) if (ArrayBuffer.isView(v)) n += v.byteLength;
  return n;
}

function remember(key: string, parsed: ParsedGcode) {
  memory.delete(key);
  memory.set(key, { parsed, bytes: parsedBytes(parsed) });
  let total = 0;
  const newestFirst = [...memory].reverse();
  newestFirst.forEach(([k, v], i) => {
    total += v.bytes;
    if (i >= 2 && total > MEMORY_BUDGET) memory.delete(k);
  });
}

/** A parsed file still in memory (and now the most recent). */
export function parsedFromMemory(key: string): ParsedGcode | null {
  const hit = memory.get(key);
  if (!hit) return null;
  memory.delete(key);
  memory.set(key, hit);
  return hit.parsed;
}

// ---- parsing ------------------------------------------------------------------------------

function request(source: GcodeSource, keep: boolean): ParseRequest {
  if ("url" in source) return { type: "url", url: new URL(source.url, location.href).href, keep };
  const data = source.data;
  // A Blob crosses to the worker without copying the bytes, and streams there.
  if (data instanceof Blob) return { type: "blob", blob: data };
  if (typeof data === "string") return { type: "blob", blob: new Blob([data]) };
  if (data instanceof ArrayBuffer) return { type: "blob", blob: new Blob([data]) };
  const view = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  return { type: "blob", blob: new Blob([view]) };
}

export function loadGcode(source: GcodeSource, options: LoadOptions = {}): Promise<Loaded> {
  const { onProgress, signal, cacheKey, keep = false } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("cancelled", "AbortError"));
      return;
    }
    const known = cacheKey ? parsedFromMemory(cacheKey) : null;
    if (known) {
      resolve({ result: known, ms: 0 });
      return;
    }
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const stop = () => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(new DOMException("cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (ev: MessageEvent<ParseResponse>) => {
      const msg = ev.data;
      if (msg.type === "progress") onProgress?.({ done: msg.done, total: msg.total });
      else if (msg.type === "done") {
        stop();
        if (cacheKey) remember(cacheKey, msg.result);
        resolve({ result: msg.result, ms: msg.ms, bytes: msg.bytes });
      } else {
        stop();
        reject(new Error(msg.error));
      }
    };
    worker.onerror = (ev) => {
      stop();
      reject(new Error(ev.message || "the G-code reader failed"));
    };
    worker.postMessage(request(source, keep));
  });
}
