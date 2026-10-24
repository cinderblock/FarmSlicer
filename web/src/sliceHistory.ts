// The Slice page's memory of its last slices (plans/slice-history-and-diff.md):
// what identifies a slice, which remembered slices to let go, and what two
// slices differ by. Pure functions (web/test/slice-history.test.ts); the
// IndexedDB store is sliceCache.ts.

import type { PlateLayout } from "./engine/types";
import settingsSchema from "./data/settings-schema.json";

/**
 * Everything a job is made from that can change its slice: what the Slice
 * page sends to `POST /api/jobs`, with models by digest, plus the resolved
 * part-filament profile (an edited custom profile) and the dual-nozzle plan
 * (what the printers have loaded decides it).
 */
export interface SliceInputs {
  machine: string;
  process: string;
  filaments: string[];
  bed_type: string;
  color: string;
  overrides: Record<string, string>;
  printer_id: string;
  routing: string;
  group_id: string;
  plates: PlateLayout[];
  models: { name: string; sha256: string }[];
  /** Digest of the resolved profile the page showed. */
  profile: string;
  nozzle_plan: unknown;
}

export interface SliceStats {
  printTimeSec: number | null;
  filamentG: number | null;
  plates: number;
}

/** One remembered slice. */
export interface SliceEntry {
  /** `sliceKey` of its inputs. */
  key: string;
  jobId: string;
  /** The project its job counts for ("" none). */
  project: string;
  source: "server" | "browser";
  createdAt: number;
  usedAt: number;
  inputs: SliceInputs;
  /** Filled in once the job is done. */
  stats: SliceStats | null;
  /** G-code kept for it in this browser (bytes, every plate). */
  gcodeBytes: number;
}

export interface CacheLimits {
  /** Slices remembered. */
  count: number;
  /** G-code kept, bytes. */
  bytes: number;
}

export const DEFAULT_LIMITS: CacheLimits = { count: 10, bytes: 1024 ** 3 };

/** JSON with object keys sorted, so equal values give equal text. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sliceKey(inputs: SliceInputs): Promise<string> {
  return sha256Text(stableStringify(inputs));
}

/**
 * Which entries to let go so the rest fit the limits: the least recently
 * used first. `keep` (the slice on screen, the one compared with) stays
 * whatever it costs.
 */
export function evictions(entries: SliceEntry[], limits: CacheLimits, keep: string[] = []): string[] {
  const order = [...entries].sort((a, b) => {
    const ka = keep.includes(a.key) ? 1 : 0;
    const kb = keep.includes(b.key) ? 1 : 0;
    return kb - ka || b.usedAt - a.usedAt;
  });
  const out: string[] = [];
  let count = 0;
  let bytes = 0;
  for (const e of order) {
    const kept = keep.includes(e.key) || (count + 1 <= limits.count && bytes + e.gcodeBytes <= limits.bytes);
    if (kept) {
      count++;
      bytes += e.gcodeBytes;
    } else out.push(e.key);
  }
  return out;
}

// ---- what two slices differ by ------------------------------------------------------

interface SettingDef {
  key: string;
  label: string;
  unit?: string;
  category?: string;
}
const SCHEMA = new Map((settingsSchema as SettingDef[]).map((s) => [s.key, s]));

/** Keys outside the schema that name what a slice was made from. */
const PROFILE_LABELS: Record<string, string> = {
  printer_settings_id: "Printer profile",
  print_settings_id: "Process profile",
  filament_settings_id: "Filament profiles",
};

/** A setting's name for people: the settings schema's label, else the key. */
export function settingLabel(key: string): string {
  return SCHEMA.get(key)?.label ?? PROFILE_LABELS[key] ?? key;
}

/** Is the key one of the Quick Settings (the schema)? */
export function knownSetting(key: string): boolean {
  return SCHEMA.has(key);
}

export interface Change {
  /** Config key, or a name for an input that isn't one ("models", ...). */
  key: string;
  label: string;
  /** Before (the first slice) and after; null = not set. */
  a: string | null;
  b: string | null;
}

/** A profile name without the "@printer" suffix. */
const profileName = (s: string) => s.replace(/@.*$/, "").trim();

/**
 * What the inputs of slice B change from slice A, for the history's labels:
 * the profiles, the plate, the settings set by hand, the models and parts.
 */
export function inputsDiff(a: SliceInputs, b: SliceInputs): Change[] {
  const out: Change[] = [];
  const add = (key: string, label: string, va: string, vb: string) => {
    if (va !== vb) out.push({ key, label, a: va || null, b: vb || null });
  };
  add("machine", "Printer profile", profileName(a.machine), profileName(b.machine));
  add("process", "Print quality", profileName(a.process), profileName(b.process));
  add("filaments", "Filaments", a.filaments.map(profileName).join(", "), b.filaments.map(profileName).join(", "));
  add("bed_type", "Build plate", a.bed_type, b.bed_type);
  add("color", "Colour", a.color, b.color);
  for (const key of [...new Set([...Object.keys(a.overrides), ...Object.keys(b.overrides)])].sort()) {
    const va = a.overrides[key] ?? "";
    const vb = b.overrides[key] ?? "";
    if (va !== vb) out.push({ key, label: settingLabel(key), a: va === "" ? null : va, b: vb === "" ? null : vb });
  }
  const models = (i: SliceInputs) => i.models.map((m) => m.name).join(", ");
  if (stableStringify(a.models) !== stableStringify(b.models)) out.push({ key: "models", label: "Models", a: models(a), b: models(b) });
  else if (stableStringify(a.plates) !== stableStringify(b.plates)) {
    const parts = (i: SliceInputs) => `${i.plates.reduce((n, p) => n + p.objects.length, 0)} parts on ${i.plates.length} plate${i.plates.length === 1 ? "" : "s"}`;
    out.push({ key: "plates", label: "Parts on the plate", a: parts(a), b: parts(b) });
  }
  add("printer_id", "Printer", a.printer_id, b.printer_id);
  add("group_id", "Group", a.group_id, b.group_id);
  add("routing", "Routing", a.routing, b.routing);
  if (out.length === 0 && (a.profile !== b.profile || stableStringify(a.nozzle_plan) !== stableStringify(b.nozzle_plan)))
    out.push({ key: "profile", label: "Profile contents", a: "before", b: "edited" });
  return out;
}

/** A config value as text: lists joined. */
export function configText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Every key of two merged configs whose value differs: the Quick Settings
 * (schema) first, in schema order, then the rest by key.
 */
export function configDiff(a: Record<string, unknown>, b: Record<string, unknown>): Change[] {
  const order = [...SCHEMA.keys()];
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i < 0 ? order.length : i;
  };
  const out: Change[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = configText(a[key]);
    const vb = configText(b[key]);
    if (va !== vb) out.push({ key, label: settingLabel(key), a: va, b: vb });
  }
  return out.sort((x, y) => rank(x.key) - rank(y.key) || x.key.localeCompare(y.key));
}

/** How a slice is named in the history: when, and what it changes from `base`. */
export function changeSummary(changes: Change[], max = 2): string {
  if (changes.length === 0) return "same settings";
  const shown = changes.slice(0, max).map((c) => `${c.label} ${c.b ?? "default"}`);
  return changes.length > max ? `${shown.join(", ")} +${changes.length - max}` : shown.join(", ");
}

// ---- matching heights -------------------------------------------------------------------

/** Tolerance for "the same height", mm. */
const Z_EPS = 1e-3;

/** The top layer at or below height `z` (layer tops in `zs`, ascending); 0 below the first. */
export function layerAtZ(zs: ArrayLike<number>, count: number, z: number): number {
  let lo = 0;
  let hi = count; // first layer above z
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (zs[mid] <= z + Z_EPS) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/** The first layer whose top is at or above height `z`; `count` when none is. */
export function firstLayerFrom(zs: ArrayLike<number>, count: number, z: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (zs[mid] < z - Z_EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Every layer height of either slice, ascending, the same heights once. */
export function heightStops(a: ArrayLike<number>, aCount: number, b: ArrayLike<number>, bCount: number): number[] {
  const all: number[] = [];
  for (let i = 0; i < aCount; i++) all.push(a[i]);
  for (let i = 0; i < bCount; i++) all.push(b[i]);
  all.sort((x, y) => x - y);
  const out: number[] = [];
  for (const z of all) if (out.length === 0 || z - out[out.length - 1] > Z_EPS) out.push(z);
  return out;
}

/** The change from `a` to `b` in percent of `a` ("+12%", "-3.5%"). */
export function percentChange(a: number, b: number): string {
  if (a === 0) return b === 0 ? "0%" : "new";
  const p = ((b - a) / a) * 100;
  const r = Math.abs(p) < 10 ? p.toFixed(1) : p.toFixed(0);
  return `${p > 0 ? "+" : ""}${r}%`;
}
