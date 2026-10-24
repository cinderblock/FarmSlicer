// The last slices, kept in this browser (plans/slice-history-and-diff.md):
// IndexedDB `farmslicer-slices`, its own DB so localModels.ts's `farmslicer`
// never has to change version for it.
//
//   slices  SliceEntry by key (the digest of what the slice was made from)
//   gcode   one plate's G-code as a Blob, by "<job id>:<plate>"
//
// The limits (how many slices, how much G-code) live in localStorage; past
// them the least recently used slices go, G-code and all. Storage that
// fails (private windows, quota) makes this a cache that forgets: callers
// never see an error.

import { DEFAULT_LIMITS, evictions, type CacheLimits, type SliceEntry } from "./sliceHistory";

const DB_NAME = "farmslicer-slices";
const SLICES = "slices";
const GCODE = "gcode";
const LIMITS_KEY = "farmslicer.sliceLimits";

interface StoredGcode {
  id: string;
  jobId: string;
  plate: number;
  data: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SLICES)) db.createObjectStore(SLICES, { keyPath: "key" });
        if (!db.objectStoreNames.contains(GCODE)) db.createObjectStore(GCODE, { keyPath: "id" });
      };
      req.onsuccess = () => {
        // Another tab upgrading later: let it.
        req.result.onversionchange = () => {
          req.result.close();
          dbPromise = null;
        };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

/** Run `work` in one transaction over `stores`; resolves when it commits. */
async function tx<T>(stores: string[], mode: IDBTransactionMode, work: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = work(t);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---- change notices -----------------------------------------------------------------

const listeners = new Set<() => void>();
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(DB_NAME) : null;
channel?.addEventListener("message", () => listeners.forEach((f) => f()));

function changed() {
  listeners.forEach((f) => f());
  channel?.postMessage("changed");
}

/** Called whenever the remembered slices change (in this tab or another). */
export function onSlicesChanged(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

// ---- limits ---------------------------------------------------------------------------

export function getLimits(): CacheLimits {
  try {
    const saved = JSON.parse(localStorage.getItem(LIMITS_KEY) ?? "null") as Partial<CacheLimits> | null;
    return {
      count: saved?.count && saved.count > 0 ? saved.count : DEFAULT_LIMITS.count,
      bytes: saved?.bytes && saved.bytes > 0 ? saved.bytes : DEFAULT_LIMITS.bytes,
    };
  } catch {
    return DEFAULT_LIMITS;
  }
}

export async function setLimits(limits: CacheLimits, keep: string[] = []): Promise<void> {
  localStorage.setItem(LIMITS_KEY, JSON.stringify(limits));
  await prune(keep);
  changed();
}

// ---- slices -----------------------------------------------------------------------------

/** Every remembered slice, the most recently used first. */
export async function listSlices(): Promise<SliceEntry[]> {
  try {
    const all = (await tx<SliceEntry[]>([SLICES], "readonly", (t) => t.objectStore(SLICES).getAll())) ?? [];
    return all.sort((a, b) => b.usedAt - a.usedAt);
  } catch {
    return [];
  }
}

export async function findSlice(key: string): Promise<SliceEntry | null> {
  try {
    return (await tx<SliceEntry | undefined>([SLICES], "readonly", (t) => t.objectStore(SLICES).get(key))) ?? null;
  } catch {
    return null;
  }
}

/** Remember a slice (replacing one with the same key), then keep to the limits. */
export async function putSlice(entry: SliceEntry, keep: string[] = []): Promise<void> {
  try {
    const old = await findSlice(entry.key);
    if (old && old.jobId !== entry.jobId) await dropGcode(old.jobId);
    await tx([SLICES], "readwrite", (t) => void t.objectStore(SLICES).put(entry));
    await prune([entry.key, ...keep]);
  } catch {
    // forgetting is fine
  }
  changed();
}

/** Change a remembered slice (stats once done, last use). */
export async function updateSlice(key: string, patch: Partial<Omit<SliceEntry, "key">>): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([SLICES], "readwrite");
      const store = t.objectStore(SLICES);
      const get = store.get(key);
      get.onsuccess = () => {
        if (get.result) store.put({ ...get.result, ...patch, key });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    return;
  }
  changed();
}

/** Forget a slice and its G-code. */
export async function deleteSlice(key: string): Promise<void> {
  try {
    const old = await findSlice(key);
    await tx([SLICES], "readwrite", (t) => void t.objectStore(SLICES).delete(key));
    if (old) await dropGcode(old.jobId);
  } catch {
    // nothing to forget
  }
  changed();
}

/** Forget every remembered slice. */
export async function clearSlices(): Promise<void> {
  try {
    await tx([SLICES, GCODE], "readwrite", (t) => {
      t.objectStore(SLICES).clear();
      t.objectStore(GCODE).clear();
    });
  } catch {
    // nothing to forget
  }
  changed();
}

async function prune(keep: string[]): Promise<void> {
  const all = await listSlices();
  for (const key of evictions(all, getLimits(), keep)) {
    const e = all.find((x) => x.key === key)!;
    await tx([SLICES], "readwrite", (t) => void t.objectStore(SLICES).delete(key));
    await dropGcode(e.jobId);
  }
}

// ---- G-code -----------------------------------------------------------------------------

const gcodeId = (jobId: string, plate: number) => `${jobId}:${plate}`;

/** One plate's G-code, when this browser has it. */
export async function getGcode(jobId: string, plate: number): Promise<Blob | null> {
  try {
    const row = await tx<StoredGcode | undefined>([GCODE], "readonly", (t) => t.objectStore(GCODE).get(gcodeId(jobId, plate)));
    return row?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep one plate's G-code for a remembered slice (nothing happens for a job
 * no slice remembers: its bytes would never be found or let go).
 */
export async function putGcode(jobId: string, plate: number, data: Blob): Promise<void> {
  try {
    const entry = (await listSlices()).find((e) => e.jobId === jobId);
    if (!entry) return;
    await tx([GCODE], "readwrite", (t) => void t.objectStore(GCODE).put({ id: gcodeId(jobId, plate), jobId, plate, data } satisfies StoredGcode));
    const bytes = await gcodeBytes(jobId);
    await tx([SLICES], "readwrite", (t) => void t.objectStore(SLICES).put({ ...entry, gcodeBytes: bytes }));
    await prune([entry.key]);
  } catch {
    return;
  }
  changed();
}

/** The rows of a job's plates: ids "<job>:<n>" sort between these bounds. */
const jobRange = (jobId: string) => IDBKeyRange.bound(`${jobId}:`, `${jobId}:￿`);

async function gcodeBytes(jobId: string): Promise<number> {
  const rows = (await tx<StoredGcode[]>([GCODE], "readonly", (t) => t.objectStore(GCODE).getAll(jobRange(jobId)))) ?? [];
  return rows.reduce((n, r) => n + r.data.size, 0);
}

async function dropGcode(jobId: string): Promise<void> {
  await tx([GCODE], "readwrite", (t) => void t.objectStore(GCODE).delete(jobRange(jobId)));
}
